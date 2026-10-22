"""
Pre-Underwriting — Customer E-Application.

The proposer's own disclosures, filled by the customer themselves via a
tokenized public link (no login), before a Case enters underwriting risk
assessment. Distinct from routers/pre_issuance.py, which covers the
*Post*-Underwriting stage (after a decision, before bind).

The e-application is two questionnaires, each with its own link, progress and
signature (CustomerEApplicationPart):

  medical    — medical questionnaire, family history, lifestyle & habits
  financial  — employment & income, commitments & assets, premium funding,
               existing insurance

The medical underwriter sends the medical one and the financial underwriter the
financial one; pre-underwriting can send both at once. The answers live on the
one CustomerEApplication row, whose overall status reads Submitted once both
parts are — so every reader of the e-application keeps working unchanged. An
e-application sent before the split has no parts and its old link still opens
the combined form.

Staff-facing endpoints (invite / status) are tenant-authenticated like every
other router here. The customer-facing endpoints under /public/e-application
are deliberately unauthenticated and scoped only by a hashed, expiring token —
the customer never has a login.
"""

import hashlib
import logging
import secrets
from datetime import datetime, timedelta
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from jose import JWTError
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import decode_access_token, oauth2_scheme
from services.idempotency import reviewed_operation, secret_link_operation
from shared.models.core import (
    Case,
    Customer,
    CustomerEApplication,
    CustomerEApplicationPart,
    EApplicationStatusEnum,
    Policy,
    Tenant,
)
from services.case_events import publish_case_event

log = logging.getLogger(__name__)

router = APIRouter(tags=["Pre-Underwriting — E-Application"])

INVITE_VALID_DAYS = 14

Part = Literal["medical", "financial"]
PARTS: tuple[str, ...] = ("medical", "financial")
# The answer sections each questionnaire owns; a part's link can only write its own.
PART_SECTIONS: dict[str, tuple[str, ...]] = {
    "medical": ("medical_questionnaire", "family_history", "lifestyle_habits"),
    "financial": ("financial_profile", "existing_insurance"),
}
ALL_SECTIONS = PART_SECTIONS["medical"] + PART_SECTIONS["financial"]

S = EApplicationStatusEnum


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


async def _e_app_for_case(session: AsyncSession, case_id: UUID) -> Optional[CustomerEApplication]:
    return (await session.execute(
        select(CustomerEApplication).where(CustomerEApplication.case_id == case_id)
    )).scalars().first()


async def _parts_for_case(session: AsyncSession, case_id: UUID) -> dict[str, CustomerEApplicationPart]:
    rows = (await session.execute(
        select(CustomerEApplicationPart).where(CustomerEApplicationPart.case_id == case_id)
    )).scalars().all()
    return {row.part: row for row in rows}


def _sync_overall(e_app: CustomerEApplication, parts: dict[str, CustomerEApplicationPart]) -> None:
    """The combined status every existing reader uses, derived from the two parts.
    Verification is a staff decision on the whole and is left alone."""
    if not parts or e_app.status == S.VERIFIED:
        return
    states = [parts[name].status if name in parts else S.NOT_SENT for name in PARTS]
    submitted = [p for p in parts.values() if p.status == S.SUBMITTED]
    if all(s == S.SUBMITTED for s in states):
        e_app.status = S.SUBMITTED
        latest = max(submitted, key=lambda p: p.submitted_at or datetime.min)
        e_app.submitted_at = latest.submitted_at
        e_app.submitted_ip = latest.submitted_ip
        # Readers show who signed; both parts carry the same declaration shape.
        e_app.declaration = latest.declaration
    elif any(s in (S.IN_PROGRESS, S.SUBMITTED) for s in states):
        e_app.status = S.IN_PROGRESS
        e_app.submitted_at = None
    elif S.SENT in states:
        e_app.status = S.SENT
    elif S.EXPIRED in states:
        e_app.status = S.EXPIRED
    else:
        e_app.status = S.NOT_SENT
    sent = [p.sent_at for p in parts.values() if p.sent_at]
    started = [p.started_at for p in parts.values() if p.started_at]
    e_app.sent_at = min(sent) if sent else e_app.sent_at
    e_app.started_at = min(started) if started else e_app.started_at
    e_app.updated_at = datetime.utcnow()


# ── Staff-facing (tenant-authenticated) ─────────────────────────────────────

class InviteResponse(BaseModel):
    token: str
    link_path: str  # relative path, e.g. "/e-application/<token>" — frontend prefixes its own origin
    expires_at: datetime
    status: EApplicationStatusEnum
    part: Optional[str] = None
    # The link is also emailed to the customer: who it went to, and
    # "sent" | "failed" | "no_email" (no address on record).
    emailed_to: Optional[str] = None
    email_status: str = "no_email"


class InviteBothResponse(InviteResponse):
    # One entry per questionnaire actually sent (a submitted one is not resent).
    parts: list[InviteResponse] = []


async def _invite_part(session: AsyncSession, case: Case, part: str, user_id: UUID) -> InviteResponse:
    """Issue (or reissue) one questionnaire's link and email it. A new link
    replaces the old; answers already saved are kept."""
    e_app = await _e_app_for_case(session, case.caseld)
    if e_app is None:
        e_app = CustomerEApplication(tenant_id=case.tenant_id, case_id=case.caseld, customer_id=case.customer_id)
        session.add(e_app)
    parts = await _parts_for_case(session, case.caseld)
    row = parts.get(part)
    if row is None:
        row = CustomerEApplicationPart(tenant_id=case.tenant_id, case_id=case.caseld, part=part)
        parts[part] = row
    if row.status in (S.SUBMITTED, S.VERIFIED) or e_app.status == S.VERIFIED:
        raise HTTPException(status_code=409, detail=f"The customer has already submitted the {part} e-application; a new link would discard it.")

    raw_token = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    row.invite_token_hash = _hash_token(raw_token)
    row.invite_expires_at = now + timedelta(days=INVITE_VALID_DAYS)
    row.sent_at = now
    row.sent_by = user_id
    if row.status != S.IN_PROGRESS:
        row.status = S.SENT
    row.updated_at = now
    session.add(row)
    _sync_overall(e_app, parts)
    session.add(e_app)
    await session.commit()

    from services.customer_links import email_customer_link
    link_path = f"/e-application/{raw_token}"
    delivery = await email_customer_link(
        session, kind=f"e_application_{part}", tenant_id=case.tenant_id, case=case,
        link_path=link_path, expires_at=row.invite_expires_at,
    )
    return InviteResponse(token=raw_token, link_path=link_path, expires_at=row.invite_expires_at,
                          status=row.status, part=part, **delivery)


async def _active_tenant(session: AsyncSession, tenant_id: UUID) -> None:
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None or not tenant.is_active:
        raise HTTPException(status_code=404, detail="Tenant not found or inactive")


@router.post(
    "/tenants/{tenant_id}/cases/{case_id}/e-application/invite",
    response_model=InviteBothResponse,
)
@secret_link_operation("tenant.eapp.invite_both", ("token", "link_path", "expires_at", "status", "part", "emailed_to", "email_status", "parts"), secrets=("token", "link_path"), masked=("emailed_to",), resource_type="e_application")
async def invite_e_application(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """Send both questionnaires (any not yet submitted). The top-level fields
    describe the first one sent, for callers that show a single link."""
    user_id = await _get_current_user_id(token)
    await _active_tenant(session, tenant_id)
    case = await _get_case(session, tenant_id, case_id)
    parts = await _parts_for_case(session, case_id)
    sent = [await _invite_part(session, case, part, user_id) for part in PARTS
            if not (part in parts and parts[part].status in (S.SUBMITTED, S.VERIFIED))]
    if not sent:
        raise HTTPException(status_code=409, detail="The customer has already submitted both e-application questionnaires.")
    return InviteBothResponse(**sent[0].model_dump(), parts=sent)


@router.post(
    "/tenants/{tenant_id}/cases/{case_id}/e-application/{part}/invite",
    response_model=InviteResponse,
)
@secret_link_operation("tenant.eapp.invite_part", ("token", "link_path", "expires_at", "status", "part", "emailed_to", "email_status"), secrets=("token", "link_path"), masked=("emailed_to",), resource_type="e_application")
async def invite_e_application_part(
    tenant_id: UUID,
    case_id: UUID,
    part: Part,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """Send one questionnaire: the medical or the financial e-application."""
    user_id = await _get_current_user_id(token)
    await _active_tenant(session, tenant_id)
    case = await _get_case(session, tenant_id, case_id)
    return await _invite_part(session, case, part, user_id)


class EApplicationPartRead(BaseModel):
    status: EApplicationStatusEnum
    sent_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
    submitted_at: Optional[datetime] = None
    signature_name: Optional[str] = None


class EApplicationRead(BaseModel):
    status: EApplicationStatusEnum
    sent_at: Optional[datetime]
    started_at: Optional[datetime]
    submitted_at: Optional[datetime]
    verified_at: Optional[datetime] = None
    medical_questionnaire: Optional[dict]
    family_history: Optional[dict]
    lifestyle_habits: Optional[dict]
    existing_insurance: Optional[dict]
    declaration: Optional[dict]
    financial_profile: Optional[dict] = None
    # Each questionnaire's own progress. Empty for an e-application sent as one combined form.
    parts: dict[str, EApplicationPartRead] = {}


def _part_read(row: CustomerEApplicationPart) -> EApplicationPartRead:
    return EApplicationPartRead(status=row.status, sent_at=row.sent_at, started_at=row.started_at,
                                submitted_at=row.submitted_at, signature_name=(row.declaration or {}).get("signature_name"))


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

    e_app = await _e_app_for_case(session, case_id)
    if e_app is None:
        return EApplicationRead(
            status=S.NOT_SENT,
            sent_at=None, started_at=None, submitted_at=None, verified_at=None,
            medical_questionnaire=None, family_history=None,
            lifestyle_habits=None, existing_insurance=None, declaration=None,
        )
    parts = await _parts_for_case(session, case_id)
    return EApplicationRead(
        status=e_app.status,
        sent_at=e_app.sent_at,
        started_at=e_app.started_at,
        submitted_at=e_app.submitted_at,
        verified_at=e_app.verified_at,
        medical_questionnaire=e_app.medical_questionnaire,
        family_history=e_app.family_history,
        lifestyle_habits=e_app.lifestyle_habits,
        existing_insurance=e_app.existing_insurance,
        declaration=e_app.declaration,
        financial_profile=e_app.financial_profile,
        parts={name: _part_read(row) for name, row in parts.items()},
    )


class CustomQuestionsPayload(BaseModel):
    custom_questions: list[dict]


@router.put("/tenants/{tenant_id}/cases/{case_id}/e-application/custom-questions")
async def update_custom_questions(
    tenant_id: UUID,
    case_id: UUID,
    body: CustomQuestionsPayload,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user_id(token)
    case = await _get_case(session, tenant_id, case_id)
    e_app = await _e_app_for_case(session, case_id)
    if e_app is None:
        e_app = CustomerEApplication(
            tenant_id=tenant_id,
            case_id=case_id,
            customer_id=case.customer_id,
        )

    medical = dict(e_app.medical_questionnaire or {})
    medical["custom_questions"] = body.custom_questions
    e_app.medical_questionnaire = medical
    e_app.updated_at = datetime.utcnow()
    session.add(e_app)
    await session.commit()
    return {"status": e_app.status, "custom_questions": body.custom_questions}


class VerifyPayload(BaseModel):
    action: str  # "approve" | "reject"
    notes: Optional[str] = None


@router.post("/tenants/{tenant_id}/cases/{case_id}/e-application/verify")
@reviewed_operation("tenant.eapp.verify", ("status", "verified_at"), resource_type="e_application", atomic=False)
async def verify_e_application(
    tenant_id: UUID,
    case_id: UUID,
    body: VerifyPayload,
    request: Request,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    user_id = await _get_current_user_id(token)
    await _get_case(session, tenant_id, case_id)
    e_app = await _e_app_for_case(session, case_id)
    if e_app is None:
        raise HTTPException(status_code=404, detail="E-Application not found")

    now = datetime.utcnow()
    if body.action == "approve":
        e_app.status = S.VERIFIED
        e_app.verified_at = now
        e_app.verified_by = user_id
    elif body.action == "reject":
        e_app.status = S.IN_PROGRESS
        # Reopen the questionnaires so the customer's links let them correct their answers.
        for row in (await _parts_for_case(session, case_id)).values():
            if row.status == S.SUBMITTED:
                row.status = S.IN_PROGRESS
                row.submitted_at = None
                row.updated_at = now
                session.add(row)
    else:
        raise HTTPException(status_code=400, detail="Invalid action, must be 'approve' or 'reject'")

    e_app.updated_at = now
    session.add(e_app)
    await session.commit()

    if body.action == "approve":
        # Gate 1 passed, so Gate 2 (the ACR) is next: tell the case's agent now, on the
        # app and the web, rather than only when the copilot happens to drive the case.
        # Best-effort — the verification itself has already been saved.
        try:
            from routers.agent_confidential_report import auto_request_acr
            await auto_request_acr(request, session, tenant_id, case_id, user_id)
        except Exception:  # noqa: BLE001
            log.exception("Auto ACR request after e-application verification failed for case %s", case_id)
        await session.refresh(e_app)

    return {"status": e_app.status, "verified_at": e_app.verified_at}


# ── Public, token-scoped (no tenant auth — the customer has no login) ───────

async def _resolve_by_token(
    session: AsyncSession, raw_token: str,
) -> tuple[CustomerEApplication, Optional[CustomerEApplicationPart]]:
    """The e-application and, for a questionnaire link, which part it opens.
    A link from before the split resolves with no part: the combined form."""
    token_hash = _hash_token(raw_token)
    now = datetime.utcnow()
    row = (await session.execute(
        select(CustomerEApplicationPart).where(CustomerEApplicationPart.invite_token_hash == token_hash)
    )).scalars().first()
    if row is not None:
        e_app = await _e_app_for_case(session, row.case_id)
        if e_app is None:
            raise HTTPException(status_code=404, detail="Invalid or unknown link")
        if row.invite_expires_at and row.invite_expires_at < now:
            if row.status not in (S.SUBMITTED, S.VERIFIED):
                row.status = S.EXPIRED
                session.add(row)
                _sync_overall(e_app, await _parts_for_case(session, row.case_id))
                session.add(e_app)
                await session.commit()
            raise HTTPException(status_code=410, detail="This link has expired. Please ask your agent to resend it.")
        return e_app, row

    e_app = (await session.execute(
        select(CustomerEApplication).where(CustomerEApplication.invite_token_hash == token_hash)
    )).scalars().first()
    if e_app is None:
        raise HTTPException(status_code=404, detail="Invalid or unknown link")
    if e_app.invite_expires_at and e_app.invite_expires_at < now:
        if e_app.status != S.SUBMITTED:
            e_app.status = S.EXPIRED
            session.add(e_app)
            await session.commit()
        raise HTTPException(status_code=410, detail="This link has expired. Please ask your agent to resend it.")
    return e_app, None


def _link_status(e_app: CustomerEApplication, row: Optional[CustomerEApplicationPart]) -> EApplicationStatusEnum:
    if row is None:
        return e_app.status
    return S.SUBMITTED if e_app.status == S.VERIFIED else row.status


class PublicEApplicationRead(BaseModel):
    status: EApplicationStatusEnum
    # "medical" | "financial" — which questionnaire this link opens; None is the combined form.
    part: Optional[str] = None
    customer_name: str
    cnic: Optional[str]
    product_name: Optional[str]
    coverage_amount: Optional[float]
    term_years: Optional[int]
    occupation: Optional[str] = None
    medical_questionnaire: Optional[dict]
    family_history: Optional[dict]
    lifestyle_habits: Optional[dict]
    existing_insurance: Optional[dict]
    financial_profile: Optional[dict] = None
    declaration: Optional[dict]


@router.get("/public/e-application/{raw_token}", response_model=PublicEApplicationRead)
async def public_get_e_application(
    raw_token: str,
    session: AsyncSession = Depends(get_session),
):
    e_app, row = await _resolve_by_token(session, raw_token)
    customer = await session.get(Customer, e_app.customer_id)
    if customer is None:
        raise HTTPException(status_code=404, detail="Applicant not found")
    case = await session.get(Case, e_app.case_id)
    policy = await _policy_for_case(session, case) if case else None
    # A questionnaire link only sees its own sections.
    visible = set(PART_SECTIONS[row.part]) if row else set(ALL_SECTIONS)
    section = lambda name: getattr(e_app, name) if name in visible else None  # noqa: E731

    return PublicEApplicationRead(
        status=_link_status(e_app, row),
        part=row.part if row else None,
        customer_name=customer.name,
        cnic=customer.cnic,
        product_name=policy.product_name if policy else None,
        coverage_amount=policy.coverage_amount if policy else None,
        term_years=policy.term_years if policy else None,
        occupation=customer.occupation,
        medical_questionnaire=section("medical_questionnaire"),
        family_history=section("family_history"),
        lifestyle_habits=section("lifestyle_habits"),
        existing_insurance=section("existing_insurance"),
        financial_profile=section("financial_profile"),
        declaration=row.declaration if row else e_app.declaration,
    )


class PublicEApplicationSave(BaseModel):
    medical_questionnaire: Optional[dict] = None
    family_history: Optional[dict] = None
    lifestyle_habits: Optional[dict] = None
    existing_insurance: Optional[dict] = None
    financial_profile: Optional[dict] = None
    declaration: Optional[dict] = None


@router.put("/public/e-application/{raw_token}")
async def public_save_e_application(
    raw_token: str,
    body: PublicEApplicationSave,
    session: AsyncSession = Depends(get_session),
):
    e_app, row = await _resolve_by_token(session, raw_token)
    if _link_status(e_app, row) in (S.SUBMITTED, S.VERIFIED):
        raise HTTPException(status_code=409, detail="This application has already been submitted.")

    now = datetime.utcnow()
    for name in (PART_SECTIONS[row.part] if row else ALL_SECTIONS):
        value = getattr(body, name)
        if value is not None:
            setattr(e_app, name, value)

    if row is not None:
        if body.declaration is not None:
            row.declaration = body.declaration
        if row.status == S.SENT:
            row.status = S.IN_PROGRESS
            row.started_at = now
        row.updated_at = now
        session.add(row)
        _sync_overall(e_app, await _parts_for_case(session, e_app.case_id))
    else:
        if body.declaration is not None:
            e_app.declaration = body.declaration
        if e_app.status == S.SENT:
            e_app.status = S.IN_PROGRESS
            e_app.started_at = now
    e_app.updated_at = now

    session.add(e_app)
    await session.commit()
    return {"status": _link_status(e_app, row)}


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
    e_app, row = await _resolve_by_token(session, raw_token)
    if _link_status(e_app, row) in (S.SUBMITTED, S.VERIFIED):
        raise HTTPException(status_code=409, detail="This application has already been submitted.")

    declaration = (row.declaration if row else e_app.declaration) or {}
    missing = [k for k in REQUIRED_DECLARATION_KEYS if not declaration.get(k)]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Please confirm all declaration checkboxes before submitting: {', '.join(missing)}",
        )
    if not (declaration.get("signature_name") or "").strip():
        raise HTTPException(status_code=422, detail="A typed signature name is required to submit.")

    now = datetime.utcnow()
    ip = request.client.host if request.client else None
    parts = await _parts_for_case(session, e_app.case_id)
    # A questionnaire link submits its part; the combined form submits everything.
    for target in ([row] if row else parts.values()):
        target.status = S.SUBMITTED
        target.submitted_at = now
        target.submitted_ip = ip
        target.declaration = target.declaration or declaration
        target.updated_at = now
        session.add(target)
    if row is None:
        e_app.status = S.SUBMITTED
        e_app.submitted_at = now
        e_app.submitted_ip = ip
        e_app.updated_at = now
    else:
        _sync_overall(e_app, parts)

    session.add(e_app)
    await session.commit()

    # The questionnaire is itself an application requirement; keep the case's
    # requirement rows (and its Pending Documents state) in step with it.
    try:
        from services import underwriting_gate
        case = await session.get(Case, e_app.case_id)
        if case is not None:
            await underwriting_gate.compute_requirements(session, e_app.tenant_id, case)
            await session.commit()
    except Exception:
        await session.rollback()
        log.exception("could not refresh requirements for case %s", e_app.case_id)

    await publish_case_event(
        request, session,
        event_type="EApplicationSubmitted",
        tenant_id=e_app.tenant_id, case_id=e_app.case_id, customer_id=e_app.customer_id,
        detail={"part": row.part if row else None, "status": str(getattr(e_app.status, "value", e_app.status))},
    )
    return {"status": _link_status(e_app, row), "submitted_at": now, "part": row.part if row else None}
