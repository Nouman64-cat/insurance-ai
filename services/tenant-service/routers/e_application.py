"""
Pre-Underwriting — Customer E-Application.

The proposer's own medical/lifestyle disclosure, family history, existing-
insurance declaration, and signed declaration — filled by the customer
themselves via a tokenized public link (no login), before a Case enters
underwriting risk assessment. Distinct from routers/pre_issuance.py, which
covers the *Post*-Underwriting stage (after a decision, before bind).

Staff-facing endpoints (invite / status) are tenant-authenticated like every
other router here. The customer-facing endpoints under /public/e-application
are deliberately unauthenticated and scoped only by a single-use, hashed,
expiring token — the customer never has a login.
"""

import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from jose import JWTError
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import decode_access_token, oauth2_scheme
from shared.models.core import (
    Case,
    Customer,
    CustomerEApplication,
    EApplicationStatusEnum,
    Policy,
    Tenant,
)

router = APIRouter(tags=["Pre-Underwriting — E-Application"])

INVITE_VALID_DAYS = 14


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


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


async def _policy_for_case(session: AsyncSession, case: Case) -> Optional[Policy]:
    if case.policy_id is not None:
        policy = await session.get(Policy, case.policy_id)
        if policy is not None:
            return policy
    stmt = (
        select(Policy)
        .where(Policy.tenant_id == case.tenant_id, Policy.customer_id == case.customer_id)
        .order_by(Policy.created_at.desc())
    )
    return (await session.execute(stmt)).scalars().first()


# ── Staff-facing (tenant-authenticated) ─────────────────────────────────────

class InviteResponse(BaseModel):
    token: str
    link_path: str  # relative path, e.g. "/e-application/<token>" — frontend prefixes its own origin
    expires_at: datetime
    status: EApplicationStatusEnum


@router.post(
    "/tenants/{tenant_id}/cases/{case_id}/e-application/invite",
    response_model=InviteResponse,
)
async def invite_e_application(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    user_id = await _get_current_user_id(token)
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None or not tenant.is_active:
        raise HTTPException(status_code=404, detail="Tenant not found or inactive")

    case = await _get_case(session, tenant_id, case_id)

    stmt = select(CustomerEApplication).where(CustomerEApplication.case_id == case_id)
    e_app = (await session.execute(stmt)).scalars().first()

    raw_token = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    expires_at = now + timedelta(days=INVITE_VALID_DAYS)

    if e_app is None:
        e_app = CustomerEApplication(
            tenant_id=tenant_id,
            case_id=case_id,
            customer_id=case.customer_id,
        )

    e_app.invite_token_hash = _hash_token(raw_token)
    e_app.invite_expires_at = expires_at
    e_app.sent_at = now
    e_app.sent_by = user_id
    e_app.status = EApplicationStatusEnum.SENT
    e_app.updated_at = now

    session.add(e_app)
    await session.commit()

    return InviteResponse(
        token=raw_token,
        link_path=f"/e-application/{raw_token}",
        expires_at=expires_at,
        status=e_app.status,
    )


class EApplicationRead(BaseModel):
    status: EApplicationStatusEnum
    sent_at: Optional[datetime]
    started_at: Optional[datetime]
    submitted_at: Optional[datetime]
    medical_questionnaire: Optional[dict]
    family_history: Optional[dict]
    lifestyle_habits: Optional[dict]
    existing_insurance: Optional[dict]
    declaration: Optional[dict]


@router.get(
    "/tenants/{tenant_id}/cases/{case_id}/e-application",
    response_model=EApplicationRead,
)
async def get_e_application(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user_id(token)
    await _get_case(session, tenant_id, case_id)

    stmt = select(CustomerEApplication).where(CustomerEApplication.case_id == case_id)
    e_app = (await session.execute(stmt)).scalars().first()
    if e_app is None:
        return EApplicationRead(
            status=EApplicationStatusEnum.NOT_SENT,
            sent_at=None, started_at=None, submitted_at=None,
            medical_questionnaire=None, family_history=None,
            lifestyle_habits=None, existing_insurance=None, declaration=None,
        )
    return EApplicationRead(
        status=e_app.status,
        sent_at=e_app.sent_at,
        started_at=e_app.started_at,
        submitted_at=e_app.submitted_at,
        medical_questionnaire=e_app.medical_questionnaire,
        family_history=e_app.family_history,
        lifestyle_habits=e_app.lifestyle_habits,
        existing_insurance=e_app.existing_insurance,
        declaration=e_app.declaration,
    )


# ── Public, token-scoped (no tenant auth — the customer has no login) ───────

async def _resolve_by_token(session: AsyncSession, raw_token: str) -> CustomerEApplication:
    token_hash = _hash_token(raw_token)
    stmt = select(CustomerEApplication).where(CustomerEApplication.invite_token_hash == token_hash)
    e_app = (await session.execute(stmt)).scalars().first()
    if e_app is None:
        raise HTTPException(status_code=404, detail="Invalid or unknown link")
    if e_app.invite_expires_at and e_app.invite_expires_at < datetime.utcnow():
        if e_app.status != EApplicationStatusEnum.SUBMITTED:
            e_app.status = EApplicationStatusEnum.EXPIRED
            session.add(e_app)
            await session.commit()
        raise HTTPException(status_code=410, detail="This link has expired. Please ask your agent to resend it.")
    return e_app


class PublicEApplicationRead(BaseModel):
    status: EApplicationStatusEnum
    customer_name: str
    cnic: Optional[str]
    product_name: Optional[str]
    coverage_amount: Optional[float]
    term_years: Optional[int]
    medical_questionnaire: Optional[dict]
    family_history: Optional[dict]
    lifestyle_habits: Optional[dict]
    existing_insurance: Optional[dict]
    declaration: Optional[dict]


@router.get("/public/e-application/{raw_token}", response_model=PublicEApplicationRead)
async def public_get_e_application(
    raw_token: str,
    session: AsyncSession = Depends(get_session),
):
    e_app = await _resolve_by_token(session, raw_token)
    customer = await session.get(Customer, e_app.customer_id)
    if customer is None:
        raise HTTPException(status_code=404, detail="Applicant not found")
    case = await session.get(Case, e_app.case_id)
    policy = await _policy_for_case(session, case) if case else None

    return PublicEApplicationRead(
        status=e_app.status,
        customer_name=customer.name,
        cnic=customer.cnic,
        product_name=policy.product_name if policy else None,
        coverage_amount=policy.coverage_amount if policy else None,
        term_years=policy.term_years if policy else None,
        medical_questionnaire=e_app.medical_questionnaire,
        family_history=e_app.family_history,
        lifestyle_habits=e_app.lifestyle_habits,
        existing_insurance=e_app.existing_insurance,
        declaration=e_app.declaration,
    )


class PublicEApplicationSave(BaseModel):
    medical_questionnaire: Optional[dict] = None
    family_history: Optional[dict] = None
    lifestyle_habits: Optional[dict] = None
    existing_insurance: Optional[dict] = None
    declaration: Optional[dict] = None


@router.put("/public/e-application/{raw_token}")
async def public_save_e_application(
    raw_token: str,
    body: PublicEApplicationSave,
    session: AsyncSession = Depends(get_session),
):
    e_app = await _resolve_by_token(session, raw_token)
    if e_app.status == EApplicationStatusEnum.SUBMITTED:
        raise HTTPException(status_code=409, detail="This application has already been submitted.")

    if body.medical_questionnaire is not None:
        e_app.medical_questionnaire = body.medical_questionnaire
    if body.family_history is not None:
        e_app.family_history = body.family_history
    if body.lifestyle_habits is not None:
        e_app.lifestyle_habits = body.lifestyle_habits
    if body.existing_insurance is not None:
        e_app.existing_insurance = body.existing_insurance
    if body.declaration is not None:
        e_app.declaration = body.declaration

    if e_app.status == EApplicationStatusEnum.SENT:
        e_app.status = EApplicationStatusEnum.IN_PROGRESS
        e_app.started_at = datetime.utcnow()
    e_app.updated_at = datetime.utcnow()

    session.add(e_app)
    await session.commit()
    return {"status": e_app.status}


REQUIRED_DECLARATION_KEYS = [
    "confirms_accurate",
    "authorizes_records_access",
    "not_signed_blank",
    "understood_terms",
]


@router.post("/public/e-application/{raw_token}/submit")
async def public_submit_e_application(
    raw_token: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    e_app = await _resolve_by_token(session, raw_token)
    if e_app.status == EApplicationStatusEnum.SUBMITTED:
        raise HTTPException(status_code=409, detail="This application has already been submitted.")

    declaration = e_app.declaration or {}
    missing = [k for k in REQUIRED_DECLARATION_KEYS if not declaration.get(k)]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Please confirm all declaration checkboxes before submitting: {', '.join(missing)}",
        )
    if not (declaration.get("signature_name") or "").strip():
        raise HTTPException(status_code=422, detail="A typed signature name is required to submit.")

    now = datetime.utcnow()
    e_app.status = EApplicationStatusEnum.SUBMITTED
    e_app.submitted_at = now
    e_app.submitted_ip = request.client.host if request.client else None
    e_app.updated_at = now

    session.add(e_app)
    await session.commit()
    return {"status": e_app.status, "submitted_at": now}
