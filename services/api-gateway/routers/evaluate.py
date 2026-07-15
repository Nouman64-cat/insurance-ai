"""
POST /evaluate — async underwriting endpoint (Kafka-backed).

Flow
----
1. Validate X-Tenant-Id header and confirm the tenant exists (fail-fast).
2. Build a ProposalSubmittedEvent with a fresh event_id + proposal_id.
3. Publish the event to insurance.proposal.submitted.v1.
4. Return 202 Accepted immediately — the Risk Engine processes asynchronously.

The Risk Engine consumes the event, runs the LangGraph workflow, and publishes
the result to insurance.risk.evaluated.v1. A downstream result consumer
(not this service) is responsible for persisting the RiskAssessment to the DB.

POST /evaluate/stream is kept intact for synchronous dev/testing workflows.
"""

import json
from typing import List, Optional
from uuid import UUID, uuid4

import httpx
from aiokafka import AIOKafkaProducer
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import _session_factory, get_session
from dependencies import get_kafka_producer, get_settings, get_tenant_id
from kafka_producer import PROPOSAL_TOPIC
from schemas import (
    EvaluateRequest,
    EvaluateResponse,
    ProposalAcceptedResponse,
)
from shared.events.kafka_events import (
    ApplicantPayload,
    PolicyPayload,
    ProposalPayload,
    ProposalSubmittedEvent,
)
from shared.models.core import (
    ActionTypeEnum,
    AIDecision,
    Applicant,
    Case,
    CaseHistory,
    CaseStatusEnum,
    Policy,
    PolicyStatusEnum,
    RiskAssessment,
    Tenant,
    User,
)

# AI decision band -> Policy/Case lifecycle status. "Approve with Loading" is
# a possible AIDecision value (human underwriters can apply it) even though
# the current risk-engine aggregation node never emits it itself.
_DECISION_POLICY_STATUS: dict[str, PolicyStatusEnum] = {
    "Auto Approve":         PolicyStatusEnum.APPROVED,
    "Approve with Loading": PolicyStatusEnum.APPROVED,
    "Human Review":         PolicyStatusEnum.UNDER_REVIEW,
    "Decline":              PolicyStatusEnum.DECLINED,
}
_DECISION_CASE_STATUS: dict[str, CaseStatusEnum] = {
    "Auto Approve":         CaseStatusEnum.APPROVED,
    "Approve with Loading": CaseStatusEnum.APPROVED,
    "Human Review":         CaseStatusEnum.UNDER_REVIEW,
    "Decline":              CaseStatusEnum.REJECTED,
}
from dependencies import Settings

router = APIRouter(tags=["Underwriting"])


# ─────────────────────────────────────────────────────────────────────────────
# POST /evaluate — async Kafka path
# ─────────────────────────────────────────────────────────────────────────────

@router.post(
    "/evaluate",
    response_model=ProposalAcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Submit a proposal for async AI underwriting",
    response_description=(
        "Proposal accepted and queued. Use the returned event_id to correlate "
        "the RiskEvaluated event on insurance.risk.evaluated.v1."
    ),
)
async def evaluate(
    request: EvaluateRequest,
    tenant_id: UUID = Depends(get_tenant_id),
    session: AsyncSession = Depends(get_session),
    producer: AIOKafkaProducer = Depends(get_kafka_producer),
) -> ProposalAcceptedResponse:
    """
    Publishes a ProposalSubmitted event to Kafka and returns 202 immediately.

    **Headers required:**
    - `X-Tenant-Id`: UUID of an existing tenant (create one via `POST /tenants`).
    """

    # ── 1. Confirm tenant exists (fail fast — no point queuing a bad request) ─
    tenant: Tenant | None = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"Tenant '{tenant_id}' not found. "
                "Create it first via POST /tenants."
            ),
        )

    # ── 2. Build the event ────────────────────────────────────────────────────
    proposal_id = uuid4()

    event = ProposalSubmittedEvent(
        tenant_id=tenant_id,
        payload=ProposalPayload(
            proposal_id=proposal_id,
            applicant=ApplicantPayload(
                cnic=request.applicant.cnic,
                dob=str(request.applicant.dob),
                gender=str(request.applicant.gender.value),
                occupation=request.applicant.occupation,
                declared_income=int(request.applicant.declared_income),
            ),
            policy=PolicyPayload(
                product_name=request.policy.product_name,
                insurance_type=request.policy.insurance_type.value,
                coverage_amount=int(request.policy.coverage_amount),
                term_years=request.policy.term_years,
                dependent_name=request.policy.dependent_name,
                dependent_dob=str(request.policy.dependent_dob) if request.policy.dependent_dob else None,
            ),
        ),
    )

    # ── 3. Publish to Kafka ───────────────────────────────────────────────────
    # Keying by tenant_id ensures all proposals for the same tenant land on the
    # same partition — preserving per-tenant ordering guarantees.
    try:
        await producer.send_and_wait(
            PROPOSAL_TOPIC,
            value=event.model_dump_json(),
            key=str(tenant_id),
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Failed to publish proposal event: {exc}",
        )

    # ── 4. Return 202 immediately ─────────────────────────────────────────────
    return ProposalAcceptedResponse(
        event_id=event.event_id,
        proposal_id=proposal_id,
    )


# ─────────────────────────────────────────────────────────────────────────────
# POST /evaluate/stream — synchronous SSE path (kept for dev / testing)
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/evaluate/stream", summary="Run AI underwriting evaluation with streaming progress")
async def evaluate_stream(
    request: EvaluateRequest,
    tenant_id: UUID = Depends(get_tenant_id),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    """
    Same as POST /evaluate but streams SSE progress events as each LangGraph node
    completes, then persists to DB and emits a final `saved` event.

    Event types:
    - `progress` — a workflow node finished: {node, data}
    - `invalid`  — input validation failed: {errors}
    - `saved`    — DB write done, full result: {assessment_id, ...}
    - `error`    — something went wrong: {message}
    """
    tenant: Tenant | None = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tenant '{tenant_id}' not found. Create it first via POST /tenants.",
        )

    stmt = select(Applicant).where(
        Applicant.tenant_id == tenant_id,
        Applicant.cnic == request.applicant.cnic,
    )
    existing_applicant = (await session.exec(stmt)).first()

    applicant_payload = request.applicant.model_dump(mode="json")
    if existing_applicant is not None:
        applicant_payload["is_smoker"] = existing_applicant.is_smoker
        applicant_payload["height_cm"] = existing_applicant.height_cm
        applicant_payload["weight_kg"] = existing_applicant.weight_kg
        if existing_applicant.details:
            applicant_payload["details"] = existing_applicant.details

    policy_payload = request.policy.model_dump(mode="json")

    async def generate():
        final_risk: dict | None = None

        # ── Stream from risk engine ───────────────────────────────────────────
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST",
                    f"{settings.risk_engine_url}/evaluate/stream",
                    json={"applicant": applicant_payload, "policy": policy_payload},
                    headers={"X-Tenant-Id": str(tenant_id)},
                ) as risk_resp:
                    if risk_resp.status_code != 200:
                        yield f"data: {json.dumps({'type': 'error', 'message': f'Risk engine error: {risk_resp.status_code}'})}\n\n"
                        return

                    buffer = ""
                    async for chunk in risk_resp.aiter_text():
                        buffer += chunk
                        parts = buffer.split("\n\n")
                        buffer = parts.pop()
                        for part in parts:
                            line = part.strip()
                            if not line.startswith("data: "):
                                continue
                            try:
                                evt = json.loads(line[6:])
                            except json.JSONDecodeError:
                                continue

                            if evt["type"] == "progress":
                                yield f"data: {json.dumps(evt)}\n\n"
                            elif evt["type"] == "done":
                                final_risk = evt["data"]
                            elif evt["type"] == "error":
                                yield f"data: {json.dumps({'type': 'error', 'message': evt.get('message', 'Unknown error')})}\n\n"
                                return

        except httpx.TimeoutException:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Risk engine timed out after 120 s'})}\n\n"
            return
        except httpx.ConnectError:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Risk engine is unreachable'})}\n\n"
            return

        if final_risk is None:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Risk engine did not return a final result'})}\n\n"
            return

        # ── Validation failure — no DB write ──────────────────────────────────
        if not final_risk.get("is_valid", False):
            yield f"data: {json.dumps({'type': 'invalid', 'errors': final_risk.get('validation_errors', [])})}\n\n"
            return

        # ── Persist to DB ─────────────────────────────────────────────────────
        try:
            async with _session_factory() as db:
                stmt = select(Applicant).where(
                    Applicant.tenant_id == tenant_id,
                    Applicant.cnic == request.applicant.cnic,
                )
                existing = (await db.exec(stmt)).first()
                if existing is not None:
                    applicant = existing
                else:
                    applicant = Applicant(
                        tenant_id=tenant_id,
                        cnic=request.applicant.cnic,
                        name=request.applicant.name,
                        dob=request.applicant.dob,
                        gender=request.applicant.gender,
                        occupation=request.applicant.occupation,
                        declared_income=request.applicant.declared_income,
                        # Live Evaluation is a quick what-if risk check, not formal
                        # onboarding — it doesn't collect these pricing-relevant
                        # fields, so they're recorded as unknown placeholders here.
                        is_smoker=False,
                        height_cm=170,
                        weight_kg=70,
                    )
                    db.add(applicant)
                    await db.flush()

                # A case-driven evaluation (Case Detail's "Run AI Underwriting")
                # re-evaluates the one Policy the case already opened underwriting
                # on — reuse it instead of minting a duplicate row each run. Only
                # a case-less call (Live Evaluation's what-if check) creates a
                # fresh throwaway Policy, per the existing convention below.
                case: Case | None = None
                if request.case_id is not None:
                    case = await db.get(Case, request.case_id)
                    if case is not None and case.tenant_id != tenant_id:
                        case = None

                policy: Policy | None = None
                if case is not None and case.policy_id is not None:
                    policy = await db.get(Policy, case.policy_id)

                if policy is None:
                    policy = Policy(
                        tenant_id=tenant_id,
                        applicant_id=applicant.id,
                        product_name=request.policy.product_name,
                        insurance_type=request.policy.insurance_type,
                        coverage_amount=request.policy.coverage_amount,
                        term_years=request.policy.term_years,
                        dependent_name=request.policy.dependent_name,
                        dependent_dob=request.policy.dependent_dob,
                    )
                    db.add(policy)
                    await db.flush()

                assessment = RiskAssessment(
                    tenant_id=tenant_id,
                    applicant_id=applicant.id,
                    policy_id=policy.id,
                    case_id=request.case_id,
                    medical_score=final_risk["medical_score"],
                    financial_score=final_risk["financial_score"],
                    fraud_probability=final_risk["fraud_probability"],
                    composite_risk_score=final_risk.get("composite_risk_score"),
                    ai_decision=AIDecision(final_risk["ai_decision"]),
                    suggested_loading=final_risk.get("suggested_loading"),
                    reasons=final_risk.get("reasons"),
                    ai_summary=request.ai_summary,
                )
                db.add(assessment)

                # Auto-transition the Policy (and, if this evaluation belongs to
                # a Case, the Case too) from the deterministic decision band —
                # Auto Approve/Decline never need an underwriter's eyes; Human
                # Review parks the case in the underwriter queue.
                new_policy_status = _DECISION_POLICY_STATUS.get(final_risk["ai_decision"])
                if new_policy_status is not None:
                    policy.status = new_policy_status
                    db.add(policy)

                if case is not None:
                    new_case_status = _DECISION_CASE_STATUS.get(final_risk["ai_decision"])
                    if new_case_status is not None and new_case_status != case.caseStatus:
                        system_user = (
                            await db.exec(select(User).where(User.tenant_id == tenant_id))
                        ).first()
                        if system_user is not None:
                            db.add(CaseHistory(
                                caseld=case.caseld,
                                actionType=ActionTypeEnum.DECISION,
                                fromStatus=case.caseStatus.value,
                                toStatus=new_case_status.value,
                                changedBy=system_user.id,
                                systemGeneratedFlag=True,
                            ))
                        case.caseStatus = new_case_status
                        db.add(case)

                await db.commit()
                await db.refresh(assessment)

            yield f"data: {json.dumps({'type': 'saved', 'data': {'assessment_id': str(assessment.id), 'applicant_id': str(applicant.id), 'policy_id': str(policy.id), 'tenant_id': str(tenant_id), 'case_id': str(case.caseld) if case else None, 'policy_status': policy.status.value, 'case_status': case.caseStatus.value if case else None, 'medical_score': assessment.medical_score, 'financial_score': assessment.financial_score, 'fraud_probability': assessment.fraud_probability, 'composite_risk_score': final_risk['composite_risk_score'], 'ai_decision': assessment.ai_decision.value, 'suggested_loading': assessment.suggested_loading, 'reasons': assessment.reasons or [], 'created_at': assessment.created_at.isoformat()}})}\n\n"

        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': f'Database error: {str(exc)}'})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# ─────────────────────────────────────────────────────────────────────────────
# GET /assessments — list stored evaluations for this tenant
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/assessments", summary="List stored risk assessments for this tenant")
async def list_assessments(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    case_id: Optional[UUID] = Query(None),
    tenant_id: UUID = Depends(get_tenant_id),
    session: AsyncSession = Depends(get_session),
) -> List[dict]:
    stmt = (
        select(RiskAssessment)
        .where(RiskAssessment.tenant_id == tenant_id)
    )
    if case_id:
        stmt = stmt.where(RiskAssessment.case_id == case_id)
    stmt = stmt.order_by(RiskAssessment.created_at.desc()).offset(skip).limit(limit)
    assessments = (await session.exec(stmt)).all()

    if not assessments:
        return []

    # Batch-load applicant + policy details in two queries so the frontend's
    # underwriting queue tables (medical/financial/occupational/proposals) get
    # occupation, product, and coverage without an N+1 or a per-row round trip.
    applicant_ids = list({a.applicant_id for a in assessments})
    app_stmt = select(Applicant).where(Applicant.id.in_(applicant_ids))
    applicants = {a.id: a for a in (await session.exec(app_stmt)).all()}

    policy_ids = list({a.policy_id for a in assessments if a.policy_id})
    policies: dict = {}
    if policy_ids:
        policy_stmt = select(Policy).where(Policy.id.in_(policy_ids))
        policies = {p.id: p for p in (await session.exec(policy_stmt)).all()}

    result = []
    for a in assessments:
        applicant = applicants.get(a.applicant_id)
        policy = policies.get(a.policy_id) if a.policy_id else None
        result.append({
            "id": str(a.id),
            "applicant_id": str(a.applicant_id),
            "applicant_name": applicant.name if applicant else "Unknown",
            "applicant_cnic": applicant.cnic if applicant else "—",
            "applicant_occupation": applicant.occupation if applicant else None,
            "case_id": str(a.case_id) if a.case_id else None,
            "product_name": policy.product_name if policy else None,
            "insurance_type": policy.insurance_type.value if policy else None,
            "coverage_amount": policy.coverage_amount if policy else None,
            "medical_score": a.medical_score,
            "financial_score": a.financial_score,
            "fraud_probability": a.fraud_probability,
            "composite_risk_score": a.composite_risk_score,
            "ai_decision": a.ai_decision.value,
            "suggested_loading": a.suggested_loading,
            "has_summary": a.ai_summary is not None,
            "created_at": a.created_at.isoformat(),
        })
    return result


# ─────────────────────────────────────────────────────────────────────────────
# GET /assessments/{assessment_id} — full detail including ai_summary
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/assessments/{assessment_id}", summary="Get a single risk assessment with full AI summary")
async def get_assessment(
    assessment_id: UUID,
    tenant_id: UUID = Depends(get_tenant_id),
    session: AsyncSession = Depends(get_session),
) -> dict:
    a = await session.get(RiskAssessment, assessment_id)
    if a is None or a.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Assessment not found")

    applicant = await session.get(Applicant, a.applicant_id)

    return {
        "id": str(a.id),
        "applicant_id": str(a.applicant_id),
        "applicant_name": applicant.name if applicant else "Unknown",
        "applicant_cnic": applicant.cnic if applicant else "—",
        "case_id": str(a.case_id) if a.case_id else None,
        "medical_score": a.medical_score,
        "financial_score": a.financial_score,
        "fraud_probability": a.fraud_probability,
        "composite_risk_score": a.composite_risk_score,
        "ai_decision": a.ai_decision.value,
        "suggested_loading": a.suggested_loading,
        "reasons": a.reasons or [],
        "ai_summary": a.ai_summary,
        "has_summary": a.ai_summary is not None,
        "created_at": a.created_at.isoformat(),
    }
