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
import logging
from typing import List, Literal, Optional
from uuid import UUID, uuid4

import httpx
from aiokafka import AIOKafkaProducer
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func
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
    CustomerPayload,
    PolicyPayload,
    ProposalPayload,
    ProposalSubmittedEvent,
)
from shared.models.core import (
    AIDecision,
    Customer,
    Case,
    Policy,
    RiskAssessment,
    Tenant,
)

from dependencies import Settings
# The RiskAssessment write + policy/case advancement, shared with the Kafka
# result worker so the sync and async evaluation paths cannot drift.
from risk_persistence import persist_assessment

log = logging.getLogger(__name__)

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

    # ── 2. Persist the rows the result will attach to ─────────────────────────
    # The risk engine answers on a different topic, minutes later and in another
    # process, so the result worker needs stable identity to write against. Both
    # rows are find-or-created up front and their ids travel with the event.
    # Without this the async path had no route back to the proposal at all and
    # every RiskEvaluated event was discarded.
    customer = (await session.exec(
        select(Customer).where(
            Customer.tenant_id == tenant_id,
            Customer.cnic == request.customer.cnic,
        )
    )).first()
    if customer is None:
        customer = Customer(
            tenant_id=tenant_id,
            cnic=request.customer.cnic,
            name=request.customer.name,
            dob=request.customer.dob,
            gender=request.customer.gender,
            occupation=request.customer.occupation,
            declared_income=request.customer.declared_income,
            # Async submission carries no biometrics; recorded as unknown
            # placeholders, exactly as the streaming path does.
            is_smoker=False,
            height_cm=170,
            weight_kg=70,
        )
        session.add(customer)
        await session.flush()

    case: Case | None = None
    if request.case_id is not None:
        case = await session.get(Case, request.case_id)
        if case is not None and case.tenant_id != tenant_id:
            case = None

    policy: Policy | None = None
    if case is not None and case.policy_id is not None:
        policy = await session.get(Policy, case.policy_id)

    if policy is None:
        policy = Policy(
            tenant_id=tenant_id,
            customer_id=customer.id,
            product_name=request.policy.product_name,
            insurance_type=request.policy.insurance_type,
            coverage_amount=request.policy.coverage_amount,
            term_years=request.policy.term_years,
            dependent_name=request.policy.dependent_name,
            dependent_dob=request.policy.dependent_dob,
        )
        session.add(policy)
        await session.flush()

    await session.commit()

    # ── 3. Build the event ────────────────────────────────────────────────────
    proposal_id = uuid4()

    event = ProposalSubmittedEvent(
        tenant_id=tenant_id,
        payload=ProposalPayload(
            proposal_id=proposal_id,
            customer_id=customer.id,
            policy_id=policy.id,
            case_id=case.caseld if case else None,
            customer=CustomerPayload(
                cnic=request.customer.cnic,
                dob=str(request.customer.dob),
                gender=str(request.customer.gender.value),
                occupation=request.customer.occupation,
                declared_income=int(request.customer.declared_income),
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

    # ── 4. Publish to Kafka ───────────────────────────────────────────────────
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

    # ── 5. Return 202 immediately ─────────────────────────────────────────────
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

    stmt = select(Customer).where(
        Customer.tenant_id == tenant_id,
        Customer.cnic == request.customer.cnic,
    )
    existing_customer = (await session.exec(stmt)).first()

    customer_payload = request.customer.model_dump(mode="json")
    if existing_customer is not None:
        customer_payload["is_smoker"] = existing_customer.is_smoker
        customer_payload["height_cm"] = existing_customer.height_cm
        customer_payload["weight_kg"] = existing_customer.weight_kg
        if existing_customer.details:
            customer_payload["details"] = existing_customer.details

    policy_payload = request.policy.model_dump(mode="json")

    async def generate():
        final_risk: dict | None = None

        # ── Stream from risk engine ───────────────────────────────────────────
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST",
                    f"{settings.risk_engine_url}/evaluate/stream",
                    json={"customer": customer_payload, "policy": policy_payload},
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
                stmt = select(Customer).where(
                    Customer.tenant_id == tenant_id,
                    Customer.cnic == request.customer.cnic,
                )
                existing = (await db.exec(stmt)).first()
                if existing is not None:
                    customer = existing
                else:
                    customer = Customer(
                        tenant_id=tenant_id,
                        cnic=request.customer.cnic,
                        name=request.customer.name,
                        dob=request.customer.dob,
                        gender=request.customer.gender,
                        occupation=request.customer.occupation,
                        declared_income=request.customer.declared_income,
                        # Live Evaluation is a quick what-if risk check, not formal
                        # onboarding — it doesn't collect these pricing-relevant
                        # fields, so they're recorded as unknown placeholders here.
                        is_smoker=False,
                        height_cm=170,
                        weight_kg=70,
                    )
                    db.add(customer)
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
                        customer_id=customer.id,
                        product_name=request.policy.product_name,
                        insurance_type=request.policy.insurance_type,
                        coverage_amount=request.policy.coverage_amount,
                        term_years=request.policy.term_years,
                        dependent_name=request.policy.dependent_name,
                        dependent_dob=request.policy.dependent_dob,
                    )
                    db.add(policy)
                    await db.flush()

                # Writes the RiskAssessment and parks the Policy (and the Case,
                # when this evaluation belongs to one) at Under Review — every
                # decision band lands there so the underwriter always makes the
                # final Approve/Decline call. Shared with the Kafka result worker
                # so both evaluation paths record a result identically.
                #
                # NOTE: the customer is NOT promoted to POLICYHOLDER here. That
                # only happens once cover actually binds — see tenant-service
                # routers/policies.py::_bind_cover (reached from payment
                # confirmation), and the identical note in routers/cases.py.
                assessment = await persist_assessment(
                    db, tenant_id,
                    customer=customer,
                    policy=policy,
                    case=case,
                    final_risk=final_risk,
                    ai_summary=request.ai_summary,
                )

                await db.commit()
                await db.refresh(assessment)

            yield f"data: {json.dumps({'type': 'saved', 'data': {'assessment_id': str(assessment.id), 'customer_id': str(customer.id), 'policy_id': str(policy.id), 'tenant_id': str(tenant_id), 'case_id': str(case.caseld) if case else None, 'policy_status': policy.status.value, 'case_status': case.caseStatus.value if case else None, 'medical_score': assessment.medical_score, 'financial_score': assessment.financial_score, 'fraud_probability': assessment.fraud_probability, 'composite_risk_score': final_risk['composite_risk_score'], 'ai_decision': assessment.ai_decision.value, 'suggested_loading': assessment.suggested_loading, 'reasons': assessment.reasons or [], 'created_at': assessment.created_at.isoformat()}})}\n\n"

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

def _customer_segment(customer: Optional[Customer]) -> str:
    if customer and customer.organization_id:
        return "organization"
    if customer and customer.family_group_id:
        return "family"
    return "individual"


def _apply_segment_filter(stmt, segment: Optional[str]):
    """Join onto Customer and scope to the requested segment. Applied at the
    SQL level (not post-fetch) because this endpoint paginates with
    skip/limit — filtering after the fact would silently under-fill pages."""
    if not segment:
        return stmt
    stmt = stmt.join(Customer, Customer.id == RiskAssessment.customer_id)
    if segment == "individual":
        return stmt.where(Customer.organization_id.is_(None), Customer.family_group_id.is_(None))
    if segment == "family":
        return stmt.where(Customer.family_group_id.is_not(None))
    return stmt.where(Customer.organization_id.is_not(None))  # "organization"


@router.get("/assessments", summary="List stored risk assessments for this tenant")
async def list_assessments(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    case_id: Optional[UUID] = Query(None),
    assigned_user: Optional[UUID] = Query(None, description="Filter to assessments whose case is assigned to this agent"),
    segment: Optional[Literal["individual", "family", "organization"]] = Query(
        None, description="Filter by customer segment: individual | family | organization"
    ),
    tenant_id: UUID = Depends(get_tenant_id),
    session: AsyncSession = Depends(get_session),
) -> List[dict]:
    stmt = (
        select(RiskAssessment)
        .where(RiskAssessment.tenant_id == tenant_id)
    )
    if case_id:
        stmt = stmt.where(RiskAssessment.case_id == case_id)
    if assigned_user:
        stmt = stmt.join(Case, Case.caseld == RiskAssessment.case_id).where(Case.assignedAgentId == assigned_user)
    stmt = _apply_segment_filter(stmt, segment)
    stmt = stmt.order_by(RiskAssessment.created_at.desc()).offset(skip).limit(limit)
    assessments = (await session.exec(stmt)).all()

    if not assessments:
        return []

    # Batch-load customer + policy details in two queries so the frontend's
    # underwriting queue tables (medical/financial/occupational/proposals) get
    # occupation, product, and coverage without an N+1 or a per-row round trip.
    customer_ids = list({a.customer_id for a in assessments})
    app_stmt = select(Customer).where(Customer.id.in_(customer_ids))
    customers = {a.id: a for a in (await session.exec(app_stmt)).all()}

    policy_ids = list({a.policy_id for a in assessments if a.policy_id})
    policies: dict = {}
    if policy_ids:
        policy_stmt = select(Policy).where(Policy.id.in_(policy_ids))
        policies = {p.id: p for p in (await session.exec(policy_stmt)).all()}

    result = []
    for a in assessments:
        customer = customers.get(a.customer_id)
        policy = policies.get(a.policy_id) if a.policy_id else None
        result.append({
            "id": str(a.id),
            "customer_id": str(a.customer_id),
            "customer_name": customer.name if customer else "Unknown",
            "customer_cnic": customer.cnic if customer else "—",
            "customer_occupation": customer.occupation if customer else None,
            "customer_segment": _customer_segment(customer),
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
# GET /assessments/stats — aggregate counts for the Assessment History dashboard
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/assessments/stats", summary="Decision + segment counts for the Assessment History dashboard")
async def get_assessment_stats(
    segment: Optional[Literal["individual", "family", "organization"]] = Query(
        None, description="Scope the decision breakdown to a customer segment"
    ),
    tenant_id: UUID = Depends(get_tenant_id),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Counts computed with SQL COUNT()/GROUP BY — never by paging through
    every RiskAssessment row — so the stat tiles and the dropdown's per-segment
    badges stay correct no matter how many assessments the tenant has."""
    decision_stmt = (
        select(RiskAssessment.ai_decision, func.count())
        .where(RiskAssessment.tenant_id == tenant_id)
    )
    decision_stmt = _apply_segment_filter(decision_stmt, segment)
    decision_stmt = decision_stmt.group_by(RiskAssessment.ai_decision)
    decision_rows = (await session.execute(decision_stmt)).all()

    by_decision = {d.value: 0 for d in AIDecision}
    for decision, count in decision_rows:
        by_decision[decision.value if hasattr(decision, "value") else decision] = count
    total = sum(by_decision.values())

    segment_counts: dict = {}
    for seg in ("individual", "family", "organization"):
        seg_stmt = (
            select(func.count())
            .select_from(RiskAssessment)
            .where(RiskAssessment.tenant_id == tenant_id)
        )
        seg_stmt = _apply_segment_filter(seg_stmt, seg)
        segment_counts[seg] = (await session.execute(seg_stmt)).scalar_one()

    return {
        "total": total,
        "by_decision": by_decision,
        "segment_counts": segment_counts,
    }


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

    customer = await session.get(Customer, a.customer_id)

    return {
        "id": str(a.id),
        "customer_id": str(a.customer_id),
        "customer_name": customer.name if customer else "Unknown",
        "customer_cnic": customer.cnic if customer else "—",
        "customer_segment": _customer_segment(customer),
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
