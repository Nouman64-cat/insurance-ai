"""
POST /evaluate — core underwriting endpoint.

Flow:
  1. Validate X-Tenant-Id header (via dependency) and confirm the tenant exists.
  2. Forward applicant + policy data to the Risk Engine service via httpx.
  3. Upsert the Applicant row (same CNIC may re-apply under the same tenant).
  4. Insert Policy and RiskAssessment rows inside a single transaction.
  5. Return a fully hydrated EvaluateResponse with the AI decision and
     explainability reasons.
"""

import json
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import _session_factory, get_session
from dependencies import Settings, get_settings, get_tenant_id
from schemas import EvaluateRequest, EvaluateResponse
from shared.models.core import (
    AIDecision,
    Applicant,
    Policy,
    RiskAssessment,
    Tenant,
)

router = APIRouter(tags=["Underwriting"])


@router.post(
    "/evaluate",
    response_model=EvaluateResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Run AI underwriting evaluation",
    response_description="Full risk assessment persisted to the database.",
)
async def evaluate(
    request: EvaluateRequest,
    tenant_id: UUID = Depends(get_tenant_id),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> EvaluateResponse:
    """
    Accepts applicant and policy data, runs the LangGraph risk-engine workflow,
    persists all records to PostgreSQL, and returns the complete assessment.

    **Headers required:**
    - `X-Tenant-Id`: UUID of an existing tenant (create one via `POST /tenants`).
    """

    # ── 1. Confirm tenant exists ──────────────────────────────────────────────
    tenant: Tenant | None = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"Tenant '{tenant_id}' not found. "
                "Create it first via POST /tenants."
            ),
        )

    # ── 2. Call the Risk Engine ───────────────────────────────────────────────
    # The risk-engine lives at its own Docker-Compose hostname and is called
    # over HTTP so this gateway stays decoupled from LangGraph internals.
    applicant_payload = request.applicant.model_dump(mode="json")
    policy_payload = request.policy.model_dump(mode="json")

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            risk_resp = await client.post(
                f"{settings.risk_engine_url}/evaluate",
                json={"applicant": applicant_payload, "policy": policy_payload},
            )
    except httpx.ConnectError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Risk Engine is unreachable. "
                "Ensure the 'risk-engine' container is running and healthy."
            ),
        )
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Risk Engine did not respond within 120 s. Try again shortly.",
        )

    # Propagate validation errors from the risk-engine as-is.
    if risk_resp.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=risk_resp.json().get("detail", "Risk Engine rejected the input."),
        )

    if risk_resp.is_error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Risk Engine returned an unexpected error: {risk_resp.status_code}.",
        )

    risk: dict = risk_resp.json()

    # ── 3. Upsert Applicant ───────────────────────────────────────────────────
    # The (tenant_id, cnic) unique constraint means the same person may
    # re-apply with a new policy. Reuse the existing Applicant row rather
    # than inserting a duplicate.
    stmt = select(Applicant).where(
        Applicant.tenant_id == tenant_id,
        Applicant.cnic == request.applicant.cnic,
    )
    existing = (await session.exec(stmt)).first()

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
        session.add(applicant)
        await session.flush()   # populate applicant.id before using it as FK

    # ── 4. Create Policy ──────────────────────────────────────────────────────
    # Each call always creates a new policy row — the same applicant can apply
    # for multiple products or re-apply with different coverage amounts.
    policy = Policy(
        tenant_id=tenant_id,
        applicant_id=applicant.id,
        product_name=request.policy.product_name,
        coverage_amount=request.policy.coverage_amount,
        term_years=request.policy.term_years,
    )
    session.add(policy)
    await session.flush()

    # ── 5. Persist RiskAssessment ─────────────────────────────────────────────
    assessment = RiskAssessment(
        tenant_id=tenant_id,
        applicant_id=applicant.id,
        medical_score=risk["medical_score"],
        financial_score=risk["financial_score"],
        fraud_probability=risk["fraud_probability"],
        ai_decision=AIDecision(risk["ai_decision"]),
        suggested_loading=risk.get("suggested_loading"),
        reasons=risk.get("reasons"),
    )
    session.add(assessment)
    await session.commit()
    await session.refresh(assessment)

    # ── 6. Return response ────────────────────────────────────────────────────
    return EvaluateResponse(
        assessment_id=assessment.id,
        applicant_id=applicant.id,
        policy_id=policy.id,
        tenant_id=tenant_id,
        medical_score=assessment.medical_score,
        financial_score=assessment.financial_score,
        fraud_probability=assessment.fraud_probability,
        # composite_risk_score comes from the engine result, not the DB row.
        composite_risk_score=risk["composite_risk_score"],
        ai_decision=assessment.ai_decision.value,
        suggested_loading=assessment.suggested_loading,
        reasons=assessment.reasons or [],
        created_at=assessment.created_at,
    )


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
