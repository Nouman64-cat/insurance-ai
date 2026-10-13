"""Tenant-scoped commission earnings API. No synthetic balances or payouts."""
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlmodel import delete, select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, _role_name, oauth2_scheme
from services.commission_engine import accrue_receipt
from shared.models.core import AcquisitionSource, Policy, PremiumReceipt
from shared.models.commission import CommissionAccrual, CommissionAgreement, CommissionAssignment, CommissionEarning

router = APIRouter(prefix="/tenants/{tenant_id}/commissions", tags=["Commission earnings"])
Pct = Annotated[Decimal, Field(ge=0, le=100, max_digits=7, decimal_places=4, allow_inf_nan=False)]


async def caller(tenant_id: UUID, token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)):
    user = await _get_current_user(token, session)
    if not user.is_active or str(getattr(user.status, "value", user.status)) != "ACTIVE":
        raise HTTPException(403, "Account is inactive")
    role = await _role_name(user, session)
    if role != "SuperAdmin" and user.tenant_id != tenant_id:
        raise HTTPException(403, "Tenant access denied")
    if role not in {"Admin", "SuperAdmin", "Agent", "Underwriter", "Viewer"}:
        raise HTTPException(403, "Commission access denied")
    return user, role


async def admin(identity=Depends(caller)):
    if identity[1] not in {"Admin", "SuperAdmin"}:
        raise HTTPException(403, "Commission administration requires Admin")
    return identity[0]


class AgreementIn(BaseModel):
    code: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    version: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=255)
    first_year_pct: Pct
    renewal_pct: Pct
    effective_from: date
    effective_to: date | None = None

    @model_validator(mode="after")
    def valid_dates(self):
        if self.effective_to and self.effective_to < self.effective_from:
            raise ValueError("Effective end precedes start")
        return self


class ProducerIn(BaseModel):
    source_id: UUID
    agreement_id: UUID
    split_pct: Pct


class AssignmentsIn(BaseModel):
    producers: list[ProducerIn] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def valid_split(self):
        if sum(p.split_pct for p in self.producers) != Decimal(100) or any(p.split_pct <= 0 for p in self.producers):
            raise ValueError("Positive producer splits must total exactly 100%")
        if len({p.source_id for p in self.producers}) != len(self.producers):
            raise ValueError("Duplicate producer")
        return self


@router.get("/payees")
async def payees(tenant_id: UUID, identity=Depends(caller), session: AsyncSession = Depends(get_session)):
    query = select(AcquisitionSource).where(AcquisitionSource.tenant_id == tenant_id)
    if identity[1] not in {"Admin", "SuperAdmin", "Underwriter", "Viewer"}:
        query = query.where(AcquisitionSource.user_id == identity[0].id)
    rows = (await session.exec(query.order_by(AcquisitionSource.name))).all()
    return [{"id": r.id, "name": r.name, "code": r.code, "channel": r.source_type, "active": r.is_active} for r in rows]


@router.get("/agreements")
async def agreements(tenant_id: UUID, user=Depends(admin), session: AsyncSession = Depends(get_session)):
    return (await session.exec(select(CommissionAgreement).where(
        CommissionAgreement.tenant_id == tenant_id,
    ).order_by(CommissionAgreement.created_at.desc()))).all()


@router.post("/agreements", status_code=201)
async def create_agreement(tenant_id: UUID, body: AgreementIn, user=Depends(admin), session: AsyncSession = Depends(get_session)):
    row = CommissionAgreement(tenant_id=tenant_id, created_by=user.id, **body.model_dump())
    session.add(row)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, "Agreement code/version already exists")
    return row


@router.post("/agreements/{agreement_id}/approve")
async def approve_agreement(tenant_id: UUID, agreement_id: UUID, user=Depends(admin), session: AsyncSession = Depends(get_session)):
    row = (await session.exec(select(CommissionAgreement).where(
        CommissionAgreement.id == agreement_id, CommissionAgreement.tenant_id == tenant_id,
    ).with_for_update())).first()
    if not row:
        raise HTTPException(404, "Agreement not found")
    if row.created_by == user.id:
        raise HTTPException(403, "A different administrator must approve this agreement")
    if row.status != "DRAFT":
        raise HTTPException(409, "Agreement is already approved and immutable")
    row.status, row.approved_by, row.approved_at = "APPROVED", user.id, datetime.utcnow()
    session.add(row)
    await session.commit()
    return row


@router.get("/policies/{policy_id}/assignments")
async def assignments(tenant_id: UUID, policy_id: UUID, user=Depends(admin), session: AsyncSession = Depends(get_session)):
    return (await session.exec(select(CommissionAssignment).where(
        CommissionAssignment.tenant_id == tenant_id, CommissionAssignment.policy_id == policy_id,
    ))).all()


@router.put("/policies/{policy_id}/assignments")
async def assign(tenant_id: UUID, policy_id: UUID, body: AssignmentsIn, user=Depends(admin), session: AsyncSession = Depends(get_session)):
    policy = (await session.exec(select(Policy).where(
        Policy.id == policy_id, Policy.tenant_id == tenant_id,
    ).with_for_update())).first()
    if not policy:
        raise HTTPException(404, "Policy not found")
    if policy.master_policy_id or policy.family_policy_id:
        raise HTTPException(409, "Group/family commission allocation is not enabled yet")
    posted = (await session.exec(select(CommissionAccrual.id).where(
        CommissionAccrual.tenant_id == tenant_id, CommissionAccrual.policy_id == policy_id,
        CommissionAccrual.status == "POSTED",
    ))).first()
    if posted:
        raise HTTPException(409, "Producer assignments are frozen after the first posting")
    for p in body.producers:
        source = await session.get(AcquisitionSource, p.source_id)
        agreement = await session.get(CommissionAgreement, p.agreement_id)
        if not source or source.tenant_id != tenant_id or not source.is_active:
            raise HTTPException(422, "Producer must be an active acquisition source in this tenant")
        if not agreement or agreement.tenant_id != tenant_id or agreement.status != "APPROVED":
            raise HTTPException(422, "Agreement must be approved in this tenant")
    await session.exec(delete(CommissionAssignment).where(
        CommissionAssignment.tenant_id == tenant_id, CommissionAssignment.policy_id == policy_id,
    ))
    rows = [CommissionAssignment(tenant_id=tenant_id, policy_id=policy_id, created_by=user.id, **p.model_dump()) for p in body.producers]
    session.add_all(rows)
    await session.commit()
    return rows


def scoped_earnings(tenant_id, identity, source_id=None, date_from=None, date_to=None):
    q = select(CommissionEarning).where(CommissionEarning.tenant_id == tenant_id)
    if identity[1] == "Agent":
        q = q.join(AcquisitionSource, AcquisitionSource.id == CommissionEarning.source_id).where(
            AcquisitionSource.tenant_id == tenant_id, AcquisitionSource.user_id == identity[0].id,
        )
    if source_id:
        q = q.where(CommissionEarning.source_id == source_id)
    if date_from:
        q = q.where(CommissionEarning.created_at >= datetime.combine(date_from, datetime.min.time()))
    if date_to:
        from datetime import timedelta
        q = q.where(CommissionEarning.created_at < datetime.combine(date_to + timedelta(days=1), datetime.min.time()))
    return q


@router.get("/earnings")
async def earnings(tenant_id: UUID, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500),
                   source_id: UUID | None = None, date_from: date | None = None, date_to: date | None = None,
                   identity=Depends(caller), session: AsyncSession = Depends(get_session)):
    query = scoped_earnings(tenant_id, identity, source_id, date_from, date_to)
    total = (await session.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    rows = (await session.exec(query.order_by(CommissionEarning.created_at.desc(), CommissionEarning.id).offset(offset).limit(limit))).all()
    return {"items": rows, "total": total, "offset": offset, "limit": limit}


@router.get("/earnings/{earning_id}")
async def earning(tenant_id: UUID, earning_id: UUID, identity=Depends(caller), session: AsyncSession = Depends(get_session)):
    """One earning, with the same scoping as the list (an agent sees only their own). Used by Request
    Management to check that a commission dispute references a real earning the requester may see."""
    row = (await session.exec(scoped_earnings(tenant_id, identity).where(CommissionEarning.id == earning_id))).first()
    if not row:
        raise HTTPException(404, "Earning not found")
    return row


@router.get("/summary")
async def summary(tenant_id: UUID, source_id: UUID | None = None, date_from: date | None = None, date_to: date | None = None, identity=Depends(caller), session: AsyncSession = Depends(get_session)):
    sub = scoped_earnings(tenant_id, identity, source_id, date_from, date_to).subquery()
    count, gross = (await session.execute(select(func.count(), func.coalesce(func.sum(sub.c.gross_amount), 0)).select_from(sub))).one()
    return {"entries": count, "accrued_gross": str(gross), "currency": "PKR", "settlement_enabled": False}


@router.get("/exceptions")
async def exceptions(tenant_id: UUID, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500),
                     user=Depends(admin), session: AsyncSession = Depends(get_session)):
    return (await session.exec(select(CommissionAccrual).where(
        CommissionAccrual.tenant_id == tenant_id, CommissionAccrual.status == "EXCEPTION",
    ).order_by(CommissionAccrual.created_at, CommissionAccrual.id).offset(offset).limit(limit))).all()


class ReconcileIn(BaseModel):
    receipt_ids: list[UUID] = Field(min_length=1, max_length=100)


@router.post("/reconcile")
async def reconcile(tenant_id: UUID, body: ReconcileIn, user=Depends(admin), session: AsyncSession = Depends(get_session)):
    receipts = list((await session.exec(select(PremiumReceipt).where(
        PremiumReceipt.tenant_id == tenant_id, PremiumReceipt.id.in_(body.receipt_ids),
    ).order_by(PremiumReceipt.policy_id, PremiumReceipt.id))).all())
    if len(receipts) != len(set(body.receipt_ids)):
        raise HTTPException(404, "Receipt not found in this tenant")
    results = [await accrue_receipt(session, r) for r in receipts]
    await session.commit()
    return results
