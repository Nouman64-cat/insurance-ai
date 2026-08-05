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
from services import payment_gateway
from shared.models.core import (
    Case,
    IPPStatusEnum,
    InitialPremiumPayment,
    Policy,
    PremiumQuote,
    Tenant,
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


async def _get_case(session: AsyncSession, tenant_id: UUID, case_id: UUID) -> Case:
    case = await session.get(Case, case_id)
    if case is None or case.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


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


def _to_read(ipp: Optional[InitialPremiumPayment]) -> IPPRead:
    if ipp is None:
        return IPPRead(status=IPPStatusEnum.NOT_STARTED, amount=None, method=None, reference=None,
                        initiated_at=None, realized_at=None)
    return IPPRead(status=ipp.status, amount=ipp.amount, method=ipp.method, reference=ipp.reference,
                    initiated_at=ipp.initiated_at, realized_at=ipp.realized_at)


@router.get("/tenants/{tenant_id}/cases/{case_id}/ipp", response_model=IPPRead)
async def get_ipp(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user_id(token)
    await _get_case(session, tenant_id, case_id)

    stmt = select(InitialPremiumPayment).where(
        InitialPremiumPayment.tenant_id == tenant_id,
        InitialPremiumPayment.case_id == case_id
    )
    ipp = (await session.exec(stmt)).first()
    return _to_read(ipp)


class IPPInitiateRequest(BaseModel):
    method: Optional[str] = None  # JazzCash | Easypaisa | Card | BankTransfer


class IPPInitiateResponse(BaseModel):
    amount: float
    payment: dict
    available_payment_methods: list


@router.post("/tenants/{tenant_id}/cases/{case_id}/ipp/initiate", response_model=IPPInitiateResponse)
async def initiate_ipp(
    tenant_id: UUID,
    case_id: UUID,
    body: IPPInitiateRequest,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user_id(token)
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None or not tenant.is_active:
        raise HTTPException(status_code=404, detail="Tenant not found or inactive")

    case = await _get_case(session, tenant_id, case_id)
    if case.policy_id is None:
        raise HTTPException(status_code=409, detail="This case has no linked policy/quote yet.")

    stmt = select(InitialPremiumPayment).where(
        InitialPremiumPayment.tenant_id == tenant_id,
        InitialPremiumPayment.case_id == case_id
    )
    ipp = (await session.exec(stmt)).first()
    if ipp is not None and ipp.status == IPPStatusEnum.REALIZED:
        raise HTTPException(status_code=409, detail="Initial premium has already been paid for this case.")

    amount = await _latest_quote_amount(session, tenant_id, case.policy_id)

    try:
        intent = payment_gateway.initiate_payment(amount, body.method)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    now = datetime.utcnow()
    if ipp is None:
        ipp = InitialPremiumPayment(
            tenant_id=tenant_id,
            case_id=case_id,
            policy_id=case.policy_id,
            amount=amount,
            status=IPPStatusEnum.INITIATED,
            method=intent.method.value,
            reference=intent.reference,
            initiated_at=now,
            updated_at=now,
        )
        session.add(ipp)
    else:
        ipp.amount = amount
        ipp.status = IPPStatusEnum.INITIATED
        ipp.method = intent.method.value
        ipp.reference = intent.reference
        if not ipp.initiated_at:
            ipp.initiated_at = now
        ipp.updated_at = now
        session.add(ipp)

    await session.commit()
    await session.refresh(ipp)

    return IPPInitiateResponse(
        amount=round(amount, 2),
        payment=intent.to_dict(),
        available_payment_methods=payment_gateway.available_methods(),
    )


class IPPConfirmRequest(BaseModel):
    method: Optional[str] = None
    reference: Optional[str] = None
    realize: bool = True


@router.post("/tenants/{tenant_id}/cases/{case_id}/ipp/confirm", response_model=IPPRead)
async def confirm_ipp(
    tenant_id: UUID,
    case_id: UUID,
    body: IPPConfirmRequest,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user_id(token)
    await _get_case(session, tenant_id, case_id)

    stmt = select(InitialPremiumPayment).where(
        InitialPremiumPayment.tenant_id == tenant_id,
        InitialPremiumPayment.case_id == case_id
    )
    ipp = (await session.exec(stmt)).first()
    if ipp is None:
        raise HTTPException(status_code=404, detail="No initial premium payment has been initiated for this case yet.")
    if ipp.status == IPPStatusEnum.REALIZED:
        raise HTTPException(status_code=409, detail="Initial premium has already been paid for this case.")

    reference = body.reference or ipp.reference
    method = body.method or ipp.method
    try:
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

