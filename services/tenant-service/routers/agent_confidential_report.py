"""
Pre-Underwriting — Agent's Confidential Report (ACR).

Non-medical risk control filled by the selling agent: moral hazard,
financial standing, and general lifestyle observations that structured
data fields alone miss. Reviewed read-only by underwriters alongside the
AI risk score and the customer's E-Application.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from jose import JWTError
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import decode_access_token, oauth2_scheme
from shared.models.core import (
    ACRRecommendationEnum,
    ACRStatusEnum,
    AgentConfidentialReport,
    Case,
    Tenant,
)

router = APIRouter(tags=["Pre-Underwriting — Agent's Confidential Report"])


async def _get_current_user_id(token: str) -> UUID:
    try:
        payload = decode_access_token(token)
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
        return UUID(user_id)
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


async def _get_case(session: AsyncSession, tenant_id: UUID, case_id: UUID) -> Case:
    case = await session.get(Case, case_id)
    if case is None or case.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


class ACRUpsert(BaseModel):
    known_proposer_since: Optional[str] = None
    relationship_to_proposer: Optional[str] = None
    purpose_of_insurance: Optional[str] = None
    financial_interest_explained: Optional[bool] = None
    adverse_info_known: Optional[bool] = None
    adverse_info_details: Optional[str] = None

    occupation_verified: Optional[bool] = None
    income_source_verified: Optional[bool] = None
    estimated_income_opinion: Optional[float] = None
    income_consistency_note: Optional[str] = None

    health_appearance_note: Optional[str] = None
    habits_observed: Optional[dict] = None
    hazardous_activity_known: Optional[bool] = None

    terms_explained_to_proposer: Optional[bool] = None
    identity_verified_kyc: Optional[bool] = None
    signature_obtained_in_presence: Optional[bool] = None

    recommendation: Optional[ACRRecommendationEnum] = None
    remarks: Optional[str] = None


class ACRRead(ACRUpsert):
    status: ACRStatusEnum
    agent_id: Optional[UUID]
    submitted_at: Optional[datetime]


def _to_read(acr: AgentConfidentialReport) -> ACRRead:
    return ACRRead(
        status=acr.status,
        agent_id=acr.agent_id,
        submitted_at=acr.submitted_at,
        known_proposer_since=acr.known_proposer_since,
        relationship_to_proposer=acr.relationship_to_proposer,
        purpose_of_insurance=acr.purpose_of_insurance,
        financial_interest_explained=acr.financial_interest_explained,
        adverse_info_known=acr.adverse_info_known,
        adverse_info_details=acr.adverse_info_details,
        occupation_verified=acr.occupation_verified,
        income_source_verified=acr.income_source_verified,
        estimated_income_opinion=acr.estimated_income_opinion,
        income_consistency_note=acr.income_consistency_note,
        health_appearance_note=acr.health_appearance_note,
        habits_observed=acr.habits_observed,
        hazardous_activity_known=acr.hazardous_activity_known,
        terms_explained_to_proposer=acr.terms_explained_to_proposer,
        identity_verified_kyc=acr.identity_verified_kyc,
        signature_obtained_in_presence=acr.signature_obtained_in_presence,
        recommendation=acr.recommendation,
        remarks=acr.remarks,
    )


@router.get("/tenants/{tenant_id}/cases/{case_id}/acr", response_model=ACRRead)
async def get_acr(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user_id(token)
    await _get_case(session, tenant_id, case_id)

    stmt = select(AgentConfidentialReport).where(AgentConfidentialReport.case_id == case_id)
    acr = (await session.execute(stmt)).scalars().first()
    if acr is None:
        return ACRRead(status=ACRStatusEnum.NOT_STARTED, agent_id=None, submitted_at=None)
    return _to_read(acr)


@router.put("/tenants/{tenant_id}/cases/{case_id}/acr", response_model=ACRRead)
async def upsert_acr(
    tenant_id: UUID,
    case_id: UUID,
    body: ACRUpsert,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    user_id = await _get_current_user_id(token)
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None or not tenant.is_active:
        raise HTTPException(status_code=404, detail="Tenant not found or inactive")
    await _get_case(session, tenant_id, case_id)

    stmt = select(AgentConfidentialReport).where(AgentConfidentialReport.case_id == case_id)
    acr = (await session.execute(stmt)).scalars().first()

    if acr is not None and acr.status == ACRStatusEnum.SUBMITTED:
        raise HTTPException(status_code=409, detail="This ACR has already been submitted and is locked.")

    if acr is None:
        acr = AgentConfidentialReport(tenant_id=tenant_id, case_id=case_id, agent_id=user_id)

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(acr, field, value)

    acr.status = ACRStatusEnum.DRAFT
    acr.updated_at = datetime.utcnow()

    session.add(acr)
    await session.commit()
    await session.refresh(acr)
    return _to_read(acr)


@router.post("/tenants/{tenant_id}/cases/{case_id}/acr/submit", response_model=ACRRead)
async def submit_acr(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user_id(token)
    await _get_case(session, tenant_id, case_id)

    stmt = select(AgentConfidentialReport).where(AgentConfidentialReport.case_id == case_id)
    acr = (await session.execute(stmt)).scalars().first()
    if acr is None:
        raise HTTPException(status_code=404, detail="No ACR draft found for this case yet.")
    if acr.status == ACRStatusEnum.SUBMITTED:
        raise HTTPException(status_code=409, detail="This ACR has already been submitted.")
    if not acr.recommendation:
        raise HTTPException(status_code=422, detail="A recommendation is required before submitting.")
    missing = [
        label for flag, label in (
            (acr.terms_explained_to_proposer, "confirm you explained the policy terms to the proposer"),
            (acr.identity_verified_kyc, "confirm you verified the proposer's identity (KYC)"),
            (acr.signature_obtained_in_presence, "confirm the proposer's signature was obtained in your presence"),
        ) if not flag
    ]
    if missing:
        raise HTTPException(status_code=422, detail=f"Please {'; '.join(missing)} before submitting.")

    now = datetime.utcnow()
    acr.status = ACRStatusEnum.SUBMITTED
    acr.submitted_at = now
    acr.updated_at = now

    session.add(acr)
    await session.commit()
    await session.refresh(acr)
    return _to_read(acr)
