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
from uuid import UUID, uuid4

import httpx
from aiokafka import AIOKafkaProducer
from fastapi import APIRouter, Depends, HTTPException, status
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
    AIDecision,
    Applicant,
    Policy,
    RiskAssessment,
    Tenant,
)
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
                coverage_amount=int(request.policy.coverage_amount),
                term_years=request.policy.term_years,
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

    applicant_payload = request.applicant.model_dump(mode="json")
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
                    )
                    db.add(applicant)
                    await db.flush()

                policy = Policy(
                    tenant_id=tenant_id,
                    applicant_id=applicant.id,
                    product_name=request.policy.product_name,
                    coverage_amount=request.policy.coverage_amount,
                    term_years=request.policy.term_years,
                )
                db.add(policy)
                await db.flush()

                assessment = RiskAssessment(
                    tenant_id=tenant_id,
                    applicant_id=applicant.id,
                    medical_score=final_risk["medical_score"],
                    financial_score=final_risk["financial_score"],
                    fraud_probability=final_risk["fraud_probability"],
                    ai_decision=AIDecision(final_risk["ai_decision"]),
                    suggested_loading=final_risk.get("suggested_loading"),
                    reasons=final_risk.get("reasons"),
                )
                db.add(assessment)
                await db.commit()
                await db.refresh(assessment)

            yield f"data: {json.dumps({'type': 'saved', 'data': {'assessment_id': str(assessment.id), 'applicant_id': str(applicant.id), 'policy_id': str(policy.id), 'tenant_id': str(tenant_id), 'medical_score': assessment.medical_score, 'financial_score': assessment.financial_score, 'fraud_probability': assessment.fraud_probability, 'composite_risk_score': final_risk['composite_risk_score'], 'ai_decision': assessment.ai_decision.value, 'suggested_loading': assessment.suggested_loading, 'reasons': assessment.reasons or [], 'created_at': assessment.created_at.isoformat()}})}\n\n"

        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': f'Database error: {str(exc)}'})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
