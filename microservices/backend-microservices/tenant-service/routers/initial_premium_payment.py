"""
Pre-Underwriting — Initial Premium Payment (IPP).

Section 30 of the Insurance Ordinance 2000: "no premium, no risk" — and per
Adamjee's actual proposal flow, the first premium is collected at proposal
submission, *before* underwriting even evaluates the risk (not after a
decision, which is what policies.py's /payments/* endpoints already handle —
see InitialPremiumPayment's docstring in shared/models/core.py for the
distinction). Reuses the same mocked payment_gateway module policies.py uses;
only the *when* and the *amount source* differ — this is priced off the
case's PremiumQuote (the pre-underwriting estimate), not the final
underwritten premium.
"""

from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from jose import JWTError
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import decode_access_token, oauth2_scheme
from services import payment_gateway, payment_requests
from shared.models.core import (
    Case,
    IPPStatusEnum,
    InitialPremiumPayment,
    Policy,
    PolicyStatusEnum,
    PremiumQuote,
    Tenant,
    User,
    Customer,
)

router = APIRouter(tags=["Pre-Underwriting — Initial Premium Payment"])


async def _get_current_user_id(token: str) -> UUID:
    try:
        payload = decode_access_token(token)
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
        return UUID(user_id)
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


from family_approval import owner_case_id


async def _get_case(session: AsyncSession, tenant_id: UUID, case_id: UUID) -> Case:
    case = await session.get(Case, case_id)
    if case is None or case.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


def _enum_val(v) -> Optional[str]:
    return v.value if hasattr(v, "value") else (str(v) if v is not None else None)


async def _premium_for(session: AsyncSession, tenant_id: UUID, policy_id: UUID) -> tuple[float, Optional[dict]]:
    """What is collected before underwriting, and how the premium is made up. Priced WITHOUT loading: that is decided by underwriting and
    is added at policy issuance, together with the remaining part of this premium. This is the SAME calculation issuance uses (base, loading, policy fee, stamp duty,
    sales tax), so the amount collected before underwriting is the amount the policy will carry, not a rougher estimate of it."""
    policy = await session.get(Policy, policy_id)
    if policy is not None:
        try:
            from routers.policies import _price_breakdown
            breakdown, _loading = await _price_breakdown(session, tenant_id, policy, loading_override=0.0)
            if breakdown.total_premium and breakdown.total_premium > 0:
                # RS-PAY-001: only part of the premium is collected now; the rest is paid at policy issuance.
                from services.payment_split import resolve_split
                split = await resolve_split(session, tenant_id, total=float(breakdown.total_premium), insurance_type=_enum_val(policy.insurance_type),
                                            product_name=policy.product_name, coverage_amount=policy.coverage_amount)
                return split["upfront_amount"], {**breakdown.to_dict(), "split": split}
        except Exception:                                            # pricing unavailable for this policy: fall back to the quote
            pass
    return round(await _latest_quote_amount(session, tenant_id, policy_id), 2), None


async def _latest_quote_amount(session: AsyncSession, tenant_id: UUID, policy_id: UUID) -> float:
    stmt = (
        select(PremiumQuote)
        .where(PremiumQuote.tenant_id == tenant_id, PremiumQuote.policy_id == policy_id)
        .order_by(PremiumQuote.created_at.desc())
    )
    quote = (await session.exec(stmt)).first()
    if quote is not None and quote.total_premium:
        return quote.total_premium

    policy = await session.get(Policy, policy_id)
    if policy and policy.coverage_amount:
        return round(float(policy.coverage_amount) * 0.01035, 2)

    raise HTTPException(
        status_code=409,
        detail="No premium quote found for this case's policy — cannot determine the initial premium amount.",
    )


class IPPRead(BaseModel):
    status: IPPStatusEnum
    amount: Optional[float]
    method: Optional[str]
    reference: Optional[str]
    initiated_at: Optional[datetime]
    realized_at: Optional[datetime]
    # Customer-side payment (see services/payment_requests.py)
    requested_at: Optional[datetime] = None
    requested_by: Optional[str] = None
    request_expires_at: Optional[datetime] = None
    link: Optional[str] = None                  # the customer's secure payment link, for staff to copy
    proof_status: str = "None"                  # None | Submitted | Accepted | Rejected
    proof_uploaded_at: Optional[datetime] = None
    proof_note: Optional[str] = None
    proof_artifact_id: Optional[UUID] = None
    proof_method: Optional[str] = None           # what the customer says they paid with
    proof_reference: Optional[str] = None        # the transaction id they quoted
    proof_review_note: Optional[str] = None
    proof_reviewed_by: Optional[str] = None      # who confirmed / rejected it, or marked the payment received
    proof_reviewed_at: Optional[datetime] = None
    reminder_count: int = 0
    last_reminded_at: Optional[datetime] = None
    link_expired: bool = False
    amount_due: Optional[float] = None           # the premium to collect, known before anything has been requested
    breakdown: Optional[dict] = None             # how that premium is made up
    breakdown_due: Optional[dict] = None         # the same, worked out now, for a payment not yet requested


def _to_read(ipp: Optional[InitialPremiumPayment]) -> IPPRead:
    if ipp is None:
        return IPPRead(status=IPPStatusEnum.NOT_STARTED, amount=None, method=None, reference=None,
                        initiated_at=None, realized_at=None)
    return IPPRead(status=ipp.status, amount=ipp.amount, method=ipp.method, reference=ipp.reference,
                    initiated_at=ipp.initiated_at, realized_at=ipp.realized_at,
                    requested_at=ipp.requested_at, requested_by=ipp.requested_by, request_expires_at=ipp.request_expires_at,
                    link=payment_requests.pay_link(ipp) if ipp.request_version > 0 else None,
                    proof_status=ipp.proof_status, proof_uploaded_at=ipp.proof_uploaded_at, proof_note=ipp.proof_note,
                    proof_artifact_id=ipp.proof_artifact_id, proof_method=ipp.proof_method, proof_reference=ipp.proof_reference,
                    proof_review_note=ipp.proof_review_note, proof_reviewed_by=ipp.proof_reviewed_by, proof_reviewed_at=ipp.proof_reviewed_at,
                    reminder_count=ipp.reminder_count, last_reminded_at=ipp.last_reminded_at, breakdown=ipp.breakdown_json,
                    link_expired=ipp.request_version > 0 and not payment_requests.is_open(ipp), amount_due=ipp.amount)


async def _find_ipp(session: AsyncSession, tenant_id: UUID, case_id: Optional[UUID], policy_id: Optional[UUID]) -> Optional[InitialPremiumPayment]:
    """The payment for this case or policy. A payment collected on the proposal has a policy but no case yet."""
    conds = []
    if case_id is not None:
        conds.append(InitialPremiumPayment.case_id == case_id)
    if policy_id is not None:
        conds.append(InitialPremiumPayment.policy_id == policy_id)
    return (await session.exec(select(InitialPremiumPayment).where(InitialPremiumPayment.tenant_id == tenant_id, or_(*conds)))).first()


class IPPInitiateRequest(BaseModel):
    method: Optional[str] = None  # JazzCash | Easypaisa | Card | BankTransfer


class IPPInitiateResponse(BaseModel):
    amount: float
    payment: dict
    available_payment_methods: list


class IPPConfirmRequest(BaseModel):
    method: Optional[str] = None
    reference: Optional[str] = None
    realize: bool = True


async def _initiate(session: AsyncSession, tenant_id: UUID, policy_id: UUID, case_id: Optional[UUID], method: Optional[str]) -> IPPInitiateResponse:
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None or not tenant.is_active:
        raise HTTPException(status_code=404, detail="Tenant not found or inactive")

    ipp = await _find_ipp(session, tenant_id, case_id, policy_id)
    if ipp is not None and ipp.status == IPPStatusEnum.REALIZED:
        raise HTTPException(status_code=409, detail="Initial premium has already been paid for this case.")

    amount, breakdown = await _premium_for(session, tenant_id, policy_id)
    try:
        intent = payment_gateway.initiate_payment(amount, method)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    def _apply(row: InitialPremiumPayment, now: datetime) -> None:
        row.amount = amount
        row.breakdown_json = breakdown
        row.status = IPPStatusEnum.INITIATED
        row.method = intent.method.value
        row.reference = intent.reference
        if not row.initiated_at:
            row.initiated_at = now
        if row.case_id is None and case_id is not None:
            row.case_id = case_id
        row.updated_at = now

    now = datetime.utcnow()
    if ipp is None:
        ipp = InitialPremiumPayment(tenant_id=tenant_id, case_id=case_id, policy_id=policy_id, amount=amount, breakdown_json=breakdown,
                                    status=IPPStatusEnum.INITIATED, method=intent.method.value, reference=intent.reference,
                                    initiated_at=now, updated_at=now)
        session.add(ipp)
    else:
        _apply(ipp, now)
        session.add(ipp)

    try:
        await session.commit()
    except IntegrityError:
        # Two initiations at once (the payment window asks as it opens, and a page can ask twice): both saw no row, and
        # one insert lost to the unique index. Initiating is idempotent — take the row the other request wrote and refresh it.
        await session.rollback()
        ipp = await _find_ipp(session, tenant_id, case_id, policy_id)
        if ipp is None:
            raise
        if ipp.status == IPPStatusEnum.REALIZED:
            raise HTTPException(status_code=409, detail="Initial premium has already been paid for this case.")
        _apply(ipp, datetime.utcnow())
        session.add(ipp)
        await session.commit()
    await session.refresh(ipp)

    return IPPInitiateResponse(amount=round(amount, 2), payment=intent.to_dict(), available_payment_methods=payment_gateway.available_methods())


async def _confirm(session: AsyncSession, tenant_id: UUID, policy_id: Optional[UUID], case_id: Optional[UUID], body: IPPConfirmRequest) -> IPPRead:
    ipp = await _find_ipp(session, tenant_id, case_id, policy_id)
    if ipp is None:
        raise HTTPException(status_code=404, detail="No initial premium payment has been initiated for this case yet.")
    if ipp.status == IPPStatusEnum.REALIZED:
        raise HTTPException(status_code=409, detail="Initial premium has already been paid for this case.")

    reference = body.reference or ipp.reference
    method = body.method or ipp.method
    try:
        payment_gateway.require_payer_reference(body.reference, ipp.reference)
        intent = payment_gateway.confirm_payment(reference, ipp.amount, method, realize=body.realize)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    now = datetime.utcnow()
    if intent.status != payment_gateway.PaymentStatusEnum.REALIZED:
        ipp.status = IPPStatusEnum.FAILED
        ipp.updated_at = now
        session.add(ipp)
        await session.commit()
        raise HTTPException(status_code=402, detail="Payment was not realized — please retry.")

    ipp.status = IPPStatusEnum.REALIZED
    ipp.method = intent.method.value
    ipp.reference = intent.reference
    ipp.realized_at = intent.realized_at or now
    ipp.updated_at = now
    session.add(ipp)
    await session.commit()
    await session.refresh(ipp)
    return _to_read(ipp)


# ── by case (the original, underwriting-side entry points) ────────────────────

@router.get("/tenants/{tenant_id}/cases/{case_id}/ipp", response_model=IPPRead)
async def get_ipp(tenant_id: UUID, case_id: UUID, token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)):
    await _get_current_user_id(token)
    case = await _get_case(session, tenant_id, case_id)
    owner = await owner_case_id(session, case, "ipp")      # the head's, for an insured spouse
    return _to_read(await _find_ipp(session, tenant_id, owner, case.policy_id if owner == case.caseld else None))


@router.post("/tenants/{tenant_id}/cases/{case_id}/ipp/initiate", response_model=IPPInitiateResponse)
async def initiate_ipp(tenant_id: UUID, case_id: UUID, body: IPPInitiateRequest, token: str = Depends(oauth2_scheme),
                       session: AsyncSession = Depends(get_session)):
    await _get_current_user_id(token)
    case = await _get_case(session, tenant_id, case_id)
    if case.policy_id is None:
        raise HTTPException(status_code=409, detail="This case has no linked policy/quote yet.")
    owner = await owner_case_id(session, case, "ipp")      # one premium for the family policy — recorded on the head's case
    return await _initiate(session, tenant_id, case.policy_id, owner, body.method)


@router.post("/tenants/{tenant_id}/cases/{case_id}/ipp/confirm", response_model=IPPRead)
async def confirm_ipp(tenant_id: UUID, case_id: UUID, body: IPPConfirmRequest, token: str = Depends(oauth2_scheme),
                      session: AsyncSession = Depends(get_session)):
    await _get_current_user_id(token)
    case = await _get_case(session, tenant_id, case_id)
    owner = await owner_case_id(session, case, "ipp")
    return await _confirm(session, tenant_id, case.policy_id if owner == case.caseld else None, owner, body)


# ── by policy (the proposal-side entry points: the payment comes after Start Review, before underwriting opens) ──

# A proposal can be paid once its review has started. Before that there is nothing to pay for yet.
PAYABLE_STATUSES = (PolicyStatusEnum.UNDER_REVIEW,)


async def _get_policy(session: AsyncSession, tenant_id: UUID, policy_id: UUID) -> Policy:
    policy = await session.get(Policy, policy_id)
    if policy is None or policy.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Proposal not found")
    return policy


@router.get("/tenants/{tenant_id}/policies/{policy_id}/ipp", response_model=IPPRead)
async def get_policy_ipp(tenant_id: UUID, policy_id: UUID, token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)):
    await _get_current_user_id(token)
    await _get_policy(session, tenant_id, policy_id)
    ipp = await _find_ipp(session, tenant_id, None, policy_id)
    out = _to_read(ipp)
    if ipp is None or ipp.status != IPPStatusEnum.REALIZED:          # not yet received: show what it would be now, never a stale figure
        try:
            out.amount_due, out.breakdown_due = await _premium_for(session, tenant_id, policy_id)
        except HTTPException:
            pass
    return out


@router.post("/tenants/{tenant_id}/policies/{policy_id}/ipp/initiate", response_model=IPPInitiateResponse)
async def initiate_policy_ipp(tenant_id: UUID, policy_id: UUID, body: IPPInitiateRequest, token: str = Depends(oauth2_scheme),
                              session: AsyncSession = Depends(get_session)):
    await _get_current_user_id(token)
    policy = await _get_policy(session, tenant_id, policy_id)
    existing = await _find_ipp(session, tenant_id, None, policy_id)
    if policy.status not in PAYABLE_STATUSES and existing is None:
        raise HTTPException(status_code=409, detail="Start the review of this application before collecting the initial premium.")
    return await _initiate(session, tenant_id, policy_id, None, body.method)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/ipp/confirm", response_model=IPPRead)
async def confirm_policy_ipp(tenant_id: UUID, policy_id: UUID, body: IPPConfirmRequest, token: str = Depends(oauth2_scheme),
                             session: AsyncSession = Depends(get_session)):
    await _get_current_user_id(token)
    await _get_policy(session, tenant_id, policy_id)
    return await _confirm(session, tenant_id, policy_id, None, body)


# ── customer pays from their side: secure link + email, screenshot proof, staff review ──

async def _staff_name(session: AsyncSession, user_id: UUID) -> str:
    user = await session.get(User, user_id)
    return user.full_name if user else "staff"


class IPPRequestResult(BaseModel):
    ipp: IPPRead
    link: str
    emailed: bool
    customer_email: Optional[str]


@router.post("/tenants/{tenant_id}/policies/{policy_id}/ipp/request", response_model=IPPRequestResult)
async def request_policy_payment(tenant_id: UUID, policy_id: UUID, token: str = Depends(oauth2_scheme),
                                 session: AsyncSession = Depends(get_session)):
    """Ask the customer to pay: creates (or renews) the secure payment link and emails it to them. Calling it again sends
    a fresh link and retires the old one."""
    user_id = await _get_current_user_id(token)
    policy = await _get_policy(session, tenant_id, policy_id)
    ipp = await _find_ipp(session, tenant_id, None, policy_id)
    if ipp is None and policy.status not in PAYABLE_STATUSES:
        raise HTTPException(status_code=409, detail="Start the review of this application before asking the customer to pay.")
    if ipp is not None and ipp.status == IPPStatusEnum.REALIZED:
        raise HTTPException(status_code=409, detail="Initial premium has already been paid for this case.")
    if ipp is None or ipp.status != IPPStatusEnum.REALIZED:         # always re-priced here, so the customer is asked for today's figure
        await _initiate(session, tenant_id, policy_id, None, None)
        ipp = await _find_ipp(session, tenant_id, None, policy_id)
    customer = await session.get(Customer, policy.customer_id)
    payment_requests.start_request(ipp, await _staff_name(session, user_id))
    session.add(ipp)
    await session.commit()
    await session.refresh(ipp)
    emailed = await payment_requests.email_customer_request(session, ipp, policy, customer)
    return IPPRequestResult(ipp=_to_read(ipp), link=payment_requests.pay_link(ipp), emailed=emailed, customer_email=payment_requests.customer_email(customer))


class IPPReviewRequest(BaseModel):
    decision: str            # "accept" | "reject"
    note: Optional[str] = None


@router.post("/tenants/{tenant_id}/policies/{policy_id}/ipp/review", response_model=IPPRead)
async def review_policy_payment_proof(tenant_id: UUID, policy_id: UUID, body: IPPReviewRequest, token: str = Depends(oauth2_scheme),
                                      session: AsyncSession = Depends(get_session)):
    """Staff look at the customer's screenshot. Accepting it clears the initial premium (so the application can go to
    underwriting); rejecting it asks the customer to upload again."""
    user_id = await _get_current_user_id(token)
    policy = await _get_policy(session, tenant_id, policy_id)
    ipp = await _find_ipp(session, tenant_id, None, policy_id)
    if ipp is None or ipp.proof_status != "Submitted":
        raise HTTPException(status_code=409, detail="There is no payment screenshot waiting for review.")
    if body.decision not in ("accept", "reject"):
        raise HTTPException(status_code=422, detail="decision must be accept or reject")
    now = datetime.utcnow()
    ipp.proof_reviewed_at, ipp.proof_reviewed_by, ipp.proof_review_note = now, await _staff_name(session, user_id), (body.note or None)
    ipp.updated_at = now
    if body.decision == "accept":
        ipp.proof_status = "Accepted"
        ipp.status = IPPStatusEnum.REALIZED
        ipp.realized_at = now
        ipp.method = ipp.method or "Customer payment"
    else:
        ipp.proof_status = "Rejected"
    session.add(ipp)
    await session.commit()
    await session.refresh(ipp)
    customer = await session.get(Customer, policy.customer_id)
    if body.decision == "reject":
        await payment_requests.email_customer_rejection(session, ipp, customer)
    else:
        await payment_requests.email_customer_confirmed(session, ipp, policy, customer)
    await payment_requests.publish_change(tenant_id)
    return _to_read(ipp)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/ipp/remind", response_model=IPPRequestResult)
async def remind_policy_payment(tenant_id: UUID, policy_id: UUID, token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)):
    """Email the customer a reminder with their payment link. If the link has expired a fresh one is issued (the old one stops working)."""
    user_id = await _get_current_user_id(token)
    policy = await _get_policy(session, tenant_id, policy_id)
    ipp = await _find_ipp(session, tenant_id, None, policy_id)
    if ipp is None or ipp.request_version < 1:
        raise HTTPException(status_code=409, detail="Payment has not been requested from the customer yet.")
    if ipp.status == IPPStatusEnum.REALIZED:
        raise HTTPException(status_code=409, detail="Initial premium has already been paid for this case.")
    if not payment_requests.is_open(ipp):
        payment_requests.start_request(ipp, await _staff_name(session, user_id))
    ipp.reminder_count += 1
    ipp.last_reminded_at = datetime.utcnow()
    session.add(ipp)
    await session.commit()
    await session.refresh(ipp)
    customer = await session.get(Customer, policy.customer_id)
    emailed = await payment_requests.email_customer_request(session, ipp, policy, customer, reminder=True)
    return IPPRequestResult(ipp=_to_read(ipp), link=payment_requests.pay_link(ipp), emailed=emailed, customer_email=payment_requests.customer_email(customer))


class IPPReceivedRequest(BaseModel):
    method: str                         # Cash | Bank transfer | Cheque | JazzCash | Easypaisa | Card | Other
    reference: Optional[str] = None
    note: Optional[str] = None


@router.post("/tenants/{tenant_id}/policies/{policy_id}/ipp/mark-received", response_model=IPPRead)
async def mark_policy_payment_received(tenant_id: UUID, policy_id: UUID, body: IPPReceivedRequest, token: str = Depends(oauth2_scheme),
                                       session: AsyncSession = Depends(get_session)):
    """Staff record that the premium has been received (cash at the office, a bank transfer they checked, a customer's message…).
    It clears the initial premium at once, whether or not a link was ever sent."""
    user_id = await _get_current_user_id(token)
    policy = await _get_policy(session, tenant_id, policy_id)
    ipp = await _find_ipp(session, tenant_id, None, policy_id)
    if ipp is not None and ipp.status == IPPStatusEnum.REALIZED:
        raise HTTPException(status_code=409, detail="Initial premium has already been paid for this case.")
    if ipp is None and policy.status not in PAYABLE_STATUSES:
        raise HTTPException(status_code=409, detail="Start the review of this application before recording the payment.")
    if not body.method.strip():
        raise HTTPException(status_code=422, detail="Say how the payment was received.")
    if ipp is None or not ipp.amount or ipp.status != IPPStatusEnum.REALIZED:   # recorded against the current premium, not an old estimate
        await _initiate(session, tenant_id, policy_id, None, None)
        ipp = await _find_ipp(session, tenant_id, None, policy_id)
    now = datetime.utcnow()
    ipp.status, ipp.realized_at, ipp.updated_at = IPPStatusEnum.REALIZED, now, now
    ipp.method = body.method.strip()[:50]
    if body.reference and body.reference.strip():
        ipp.reference = body.reference.strip()[:100]
    ipp.proof_status = "Accepted"
    ipp.proof_reviewed_by, ipp.proof_reviewed_at, ipp.proof_review_note = await _staff_name(session, user_id), now, (body.note or "").strip()[:500] or None
    session.add(ipp)
    await session.commit()
    await session.refresh(ipp)
    customer = await session.get(Customer, policy.customer_id)
    await payment_requests.email_customer_confirmed(session, ipp, policy, customer)
    await payment_requests.publish_change(tenant_id)
    return _to_read(ipp)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/ipp/withdraw", response_model=IPPRead)
async def withdraw_policy_payment_request(tenant_id: UUID, policy_id: UUID, token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)):
    """Stop the customer's link from working (asked in error, or the customer will pay another way). A new request can be sent later."""
    await _get_current_user_id(token)
    await _get_policy(session, tenant_id, policy_id)
    ipp = await _find_ipp(session, tenant_id, None, policy_id)
    if ipp is None or ipp.request_version < 1 or ipp.status == IPPStatusEnum.REALIZED:
        raise HTTPException(status_code=409, detail="There is no open payment request to withdraw.")
    ipp.request_expires_at = datetime.utcnow() - timedelta(seconds=1)
    ipp.updated_at = datetime.utcnow()
    session.add(ipp)
    await session.commit()
    await session.refresh(ipp)
    await payment_requests.publish_change(tenant_id)
    return _to_read(ipp)


@router.get("/tenants/{tenant_id}/policies/{policy_id}/ipp/receipt")
async def policy_payment_receipt(tenant_id: UUID, policy_id: UUID, token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)) -> dict:
    """The receipt for the initial premium, once it has cleared."""
    await _get_current_user_id(token)
    await _get_policy(session, tenant_id, policy_id)
    ipp = await _find_ipp(session, tenant_id, None, policy_id)
    if ipp is None or ipp.status != IPPStatusEnum.REALIZED:
        raise HTTPException(status_code=409, detail="The initial premium has not been received yet.")
    return await payment_requests.build_receipt(session, ipp)
