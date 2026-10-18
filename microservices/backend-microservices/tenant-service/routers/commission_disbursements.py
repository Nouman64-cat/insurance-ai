"""Gross commission disbursement approval and manual payment recording.

No bank calls. Reservations and row locks prevent one earning being paid twice.
Rejected/cancelled batches retain their history and release their reservations.
"""
from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.commissions import admin
from shared.models.core import Policy, AcquisitionSource
from shared.models.commission import (CommissionEarning, CommissionDisbursement,
    CommissionDisbursementItem, CommissionDisbursementEvent)

router = APIRouter(prefix='/tenants/{tenant_id}/commissions/disbursements', tags=['Commission disbursements'])


def hold_reason(policy, source):
    if not source or not source.is_active:
        return 'Producer is missing or inactive'
    if str(getattr(policy.status, 'value', policy.status)) not in {'Active', 'GracePeriod'}:
        return 'Policy must be in force; cancellations and exits require review'
    if not policy.free_look_end_date:
        return 'Policy free-look end date is missing'
    if policy.free_look_end_date >= date.today():
        return 'Policy is still in its free-look period'
    return None


async def eligibility(session, tenant_id, rows):
    policies = {p.id: p for p in (await session.exec(select(Policy).where(
        Policy.tenant_id == tenant_id, Policy.id.in_([e.policy_id for e in rows])))).all()} if rows else {}
    sources = {s.id: s for s in (await session.exec(select(AcquisitionSource).where(
        AcquisitionSource.tenant_id == tenant_id, AcquisitionSource.id.in_([e.source_id for e in rows])))).all()} if rows else {}
    return {e.id: ('Policy not found in tenant' if e.policy_id not in policies else
        'Gross earning must be positive' if e.gross_amount <= 0 else
        f'Commission is payable from {e.disburse_date.isoformat()}' if e.disburse_date and e.disburse_date > date.today() else
        hold_reason(policies[e.policy_id], sources.get(e.source_id))) for e in rows}


@router.get('/eligible')
async def eligible(tenant_id: UUID, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=100),
                   user=Depends(admin), session: AsyncSession = Depends(get_session)):
    reserved = select(CommissionDisbursementItem.reserved_earning_id).where(
        CommissionDisbursementItem.reserved_earning_id.is_not(None))
    rows = (await session.exec(select(CommissionEarning).where(
        CommissionEarning.tenant_id == tenant_id, CommissionEarning.id.not_in(reserved)
    ).order_by(CommissionEarning.created_at, CommissionEarning.id).offset(offset).limit(limit + 1))).all()
    shown = rows[:limit]
    reasons = await eligibility(session, tenant_id, shown)
    return {'items': [{'earning': e, 'hold_reason': reasons[e.id]} for e in shown],
            'has_more': len(rows) > limit, 'offset': offset}


class BatchIn(BaseModel):
    earning_ids: list[UUID] = Field(min_length=1, max_length=100)

    @field_validator('earning_ids')
    @classmethod
    def unique(cls, value):
        if len(set(value)) != len(value):
            raise ValueError('Select each earning once')
        return value


class ReasonIn(BaseModel):
    reason: str = Field(min_length=1, max_length=500)

    @field_validator('reason')
    @classmethod
    def not_blank(cls, value):
        if not value.strip():
            raise ValueError('A reason is required')
        return value.strip()


class PaymentIn(BaseModel):
    payment_reference: str = Field(min_length=1, max_length=150)
    confirmed: bool = False

    @field_validator('payment_reference')
    @classmethod
    def reference(cls, value):
        if not value.strip():
            raise ValueError('Payment reference is required')
        return value.strip()


async def batch_for_update(session, tenant_id, batch_id):
    row = (await session.exec(select(CommissionDisbursement).where(
        CommissionDisbursement.tenant_id == tenant_id, CommissionDisbursement.id == batch_id).with_for_update())).first()
    if not row:
        raise HTTPException(404, 'Disbursement not found')
    return row


def event(session, batch, user, action, detail=None):
    session.add(CommissionDisbursementEvent(batch_id=batch.id, actor_id=user.id, action=action, detail=detail))


async def check_batch(session, tenant_id, batch):
    items = (await session.exec(select(CommissionDisbursementItem).where(
        CommissionDisbursementItem.batch_id == batch.id))).all()
    # Same lock order as creation. Policy state is checked again at every transition.
    rows = (await session.exec(select(CommissionEarning).where(
        CommissionEarning.tenant_id == tenant_id,
        CommissionEarning.id.in_([i.earning_id for i in items])).order_by(CommissionEarning.id).with_for_update())).all()
    if not rows or len(rows) != len(items) or sum(e.gross_amount for e in rows) != batch.gross_amount:
        raise HTTPException(409, 'Batch allocation does not match its immutable earnings')
    if any(i.reserved_earning_id != i.earning_id for i in items):
        raise HTTPException(409, 'Batch no longer reserves its earnings')
    # Serialize against policy state transitions, not just competing payouts.
    await session.exec(select(Policy).where(Policy.id.in_([e.policy_id for e in rows])).order_by(Policy.id).with_for_update())
    await session.exec(select(AcquisitionSource).where(AcquisitionSource.id.in_([e.source_id for e in rows])).order_by(AcquisitionSource.id).with_for_update())
    reasons = await eligibility(session, tenant_id, rows)
    if any(reasons.values()):
        raise HTTPException(409, 'Disbursement held: ' + next(r for r in reasons.values() if r))
    return items


@router.post('', status_code=201)
async def create(tenant_id: UUID, body: BatchIn, user=Depends(admin), session: AsyncSession = Depends(get_session)):
    rows = (await session.exec(select(CommissionEarning).where(
        CommissionEarning.tenant_id == tenant_id, CommissionEarning.id.in_(body.earning_ids)
    ).order_by(CommissionEarning.id).with_for_update())).all()
    if len(rows) != len(body.earning_ids):
        raise HTTPException(404, 'An earning was not found in this tenant')
    existing = (await session.exec(select(CommissionDisbursementItem).where(
        CommissionDisbursementItem.reserved_earning_id.in_(body.earning_ids)))).first()
    if existing:
        raise HTTPException(409, 'An earning is already reserved or paid in another batch')
    reasons = await eligibility(session, tenant_id, rows)
    if any(reasons.values()):
        raise HTTPException(409, 'Disbursement held: ' + next(r for r in reasons.values() if r))
    row = CommissionDisbursement(tenant_id=tenant_id, created_by=user.id,
        gross_amount=sum((e.gross_amount for e in rows), Decimal(0)))
    session.add(row); await session.flush()
    session.add_all([CommissionDisbursementItem(batch_id=row.id, earning_id=e.id,
        reserved_earning_id=e.id, gross_amount=e.gross_amount) for e in rows])
    event(session, row, user, 'CREATED')
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, 'An earning is already reserved in another batch')
    return row


@router.get('')
async def batches(tenant_id: UUID, offset: int = Query(0, ge=0), user=Depends(admin), session: AsyncSession = Depends(get_session)):
    return (await session.exec(select(CommissionDisbursement).where(
        CommissionDisbursement.tenant_id == tenant_id).order_by(
            CommissionDisbursement.created_at.desc(), CommissionDisbursement.id).offset(offset).limit(50))).all()


@router.get('/{batch_id}')
async def detail(tenant_id: UUID, batch_id: UUID, user=Depends(admin), session: AsyncSession = Depends(get_session)):
    batch = await batch_for_update(session, tenant_id, batch_id)
    items = (await session.exec(select(CommissionDisbursementItem).where(CommissionDisbursementItem.batch_id == batch.id))).all()
    entries = (await session.exec(select(CommissionEarning).where(
        CommissionEarning.tenant_id == tenant_id, CommissionEarning.id.in_([i.earning_id for i in items])))).all()
    events = (await session.exec(select(CommissionDisbursementEvent).where(
        CommissionDisbursementEvent.batch_id == batch.id).order_by(CommissionDisbursementEvent.created_at, CommissionDisbursementEvent.id))).all()
    return {'batch': batch, 'earnings': entries, 'events': events}


@router.post('/{batch_id}/submit')
async def submit(tenant_id: UUID, batch_id: UUID, user=Depends(admin), session: AsyncSession = Depends(get_session)):
    row = await batch_for_update(session, tenant_id, batch_id)
    if row.status != 'DRAFT' or row.created_by != user.id:
        raise HTTPException(409, 'Only the creator may submit a draft batch')
    await check_batch(session, tenant_id, row)
    row.status, row.submitted_at = 'SUBMITTED', datetime.utcnow()
    session.add(row); event(session, row, user, 'SUBMITTED'); await session.commit()
    return row


@router.post('/{batch_id}/approve')
async def approve(tenant_id: UUID, batch_id: UUID, user=Depends(admin), session: AsyncSession = Depends(get_session)):
    row = await batch_for_update(session, tenant_id, batch_id)
    if row.created_by == user.id:
        raise HTTPException(403, 'A different administrator must approve disbursement')
    if row.status != 'SUBMITTED':
        raise HTTPException(409, 'Only submitted batches may be approved')
    await check_batch(session, tenant_id, row)
    row.status, row.approved_by, row.approved_at = 'APPROVED', user.id, datetime.utcnow()
    session.add(row); event(session, row, user, 'APPROVED'); await session.commit()
    return row


@router.post('/{batch_id}/reject')
async def reject(tenant_id: UUID, batch_id: UUID, body: ReasonIn, user=Depends(admin), session: AsyncSession = Depends(get_session)):
    row = await batch_for_update(session, tenant_id, batch_id)
    if row.status not in {'DRAFT', 'SUBMITTED', 'APPROVED'}:
        raise HTTPException(409, 'Paid or closed batches cannot be rejected')
    if row.status != 'DRAFT' and row.created_by == user.id:
        raise HTTPException(403, 'A different administrator must reject a submitted batch')
    items = (await session.exec(select(CommissionDisbursementItem).where(CommissionDisbursementItem.batch_id == row.id))).all()
    for item in items:
        item.reserved_earning_id = None; session.add(item)
    row.status = 'CANCELLED' if row.status == 'DRAFT' else 'REJECTED'
    session.add(row); event(session, row, user, row.status, body.reason); await session.commit()
    return row


@router.post('/{batch_id}/record-payment')
async def record_payment(tenant_id: UUID, batch_id: UUID, body: PaymentIn, user=Depends(admin), session: AsyncSession = Depends(get_session)):
    row = await batch_for_update(session, tenant_id, batch_id)
    if not body.confirmed:
        raise HTTPException(422, 'Confirm that the external payment has actually completed')
    if row.status == 'PAID' and row.payment_reference == body.payment_reference:
        return row
    if row.status != 'APPROVED':
        raise HTTPException(409, 'An approved batch is required before recording payment')
    await check_batch(session, tenant_id, row)
    row.status, row.paid_by, row.paid_at = 'PAID', user.id, datetime.utcnow()
    row.payment_reference = body.payment_reference
    session.add(row); event(session, row, user, 'PAID', body.payment_reference)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, 'Payment reference is already recorded for another batch')
    return row
