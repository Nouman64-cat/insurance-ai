"""Tenant-scoped commission earnings API. No synthetic balances or payouts."""
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, or_, cast, String
from sqlalchemy.exc import IntegrityError
from sqlmodel import delete, select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, _role_name, oauth2_scheme
from services.agent_commission import AGENT_COMMISSION_RULE_SET_CODE, commission_rate
from services.commission_engine import accrue_receipt, automatic_assignment, payable_from, resolve_allocation
from shared.commissions.calculator import money
from shared.models.core import AcquisitionSource, Customer, User, InsurancePlan, Policy, PremiumReceipt, PremiumSchedule
from shared.models.commission import (CommissionAccrual, CommissionAgreement, CommissionAssignment,
    CommissionEarning, CommissionPlanRule, CommissionDisbursement, CommissionDisbursementItem)

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
    # Rates come from the RS-COM-002 rule set; a legacy agreement_id in the body is ignored.
    source_id: UUID
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


class PlanRuleIn(BaseModel):
    plan_id: UUID
    agreement_id: UUID


@router.get('/plan-rules')
async def plan_rules(tenant_id: UUID, user=Depends(admin), session: AsyncSession = Depends(get_session)):
    plans = (await session.exec(select(InsurancePlan).where(
        InsurancePlan.tenant_id == tenant_id, InsurancePlan.category == 'Individual').order_by(InsurancePlan.label))).all()
    rules = (await session.exec(select(CommissionPlanRule).where(CommissionPlanRule.tenant_id == tenant_id))).all()
    return {'plans': [{'id': p.id, 'label': p.label, 'code': p.code} for p in plans], 'rules': rules}


@router.post('/plan-rules', status_code=201)
async def create_plan_rule(tenant_id: UUID, body: PlanRuleIn, user=Depends(admin), session: AsyncSession = Depends(get_session)):
    plan = (await session.exec(select(InsurancePlan).where(
        InsurancePlan.id == body.plan_id, InsurancePlan.tenant_id == tenant_id).with_for_update())).first()
    agreement = await session.get(CommissionAgreement, body.agreement_id)
    if not plan or str(getattr(plan.category, 'value', plan.category)) != 'Individual':
        raise HTTPException(422, 'Select an individual plan in this tenant')
    if not agreement or agreement.tenant_id != tenant_id or agreement.status != 'APPROVED':
        raise HTTPException(422, 'Select an approved agreement in this tenant')
    existing = (await session.exec(select(CommissionAgreement).join(
        CommissionPlanRule, CommissionPlanRule.agreement_id == CommissionAgreement.id).where(
            CommissionPlanRule.tenant_id == tenant_id, CommissionPlanRule.plan_id == plan.id))).all()
    if any(a.id == agreement.id for a in existing):
        raise HTTPException(409, 'This agreement is already linked to the plan')
    if any(a.effective_from == agreement.effective_from for a in existing):
        raise HTTPException(409, 'A plan rate version already starts on this date')
    row = CommissionPlanRule(tenant_id=tenant_id, plan_id=plan.id, agreement_id=agreement.id, created_by=user.id)
    session.add(row); await session.commit()
    return row


@router.get("/setup")
async def setup(tenant_id: UUID, customer_id: UUID | None = None,
                search: str = Query("", max_length=200), user=Depends(admin),
                session: AsyncSession = Depends(get_session)):
    """Read-only configuration checklist; never infer a contract from ownership."""
    customer = None
    if customer_id:
        customer = (await session.exec(select(Customer).where(
            Customer.id == customer_id, Customer.tenant_id == tenant_id))).first()
        if not customer:
            raise HTTPException(404, "Customer not found in this tenant")
    sources = {r.id: r for r in (await session.exec(select(AcquisitionSource).where(
        AcquisitionSource.tenant_id == tenant_id))).all()}
    q = select(Policy, Customer).join(Customer, Customer.id == Policy.customer_id).where(
        Policy.tenant_id == tenant_id, Customer.tenant_id == tenant_id,
        Policy.master_policy_id.is_(None), Policy.family_policy_id.is_(None))
    if customer_id:
        q = q.where(Policy.customer_id == customer_id)
    if search.strip():
        term = '%' + search.strip().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        q = q.where(or_(cast(Policy.id, String) == search.strip(), Customer.name.ilike(term, escape='\\'), Policy.product_name.ilike(term, escape='\\'),
                        Policy.policy_number.ilike(term, escape='\\')))
    rows = (await session.exec(q.order_by(Policy.created_at.desc(), Policy.id).limit(51))).all()
    policy_ids = [p.id for p, _ in rows[:50]]
    assignments = (await session.exec(select(CommissionAssignment).where(
        CommissionAssignment.tenant_id == tenant_id, CommissionAssignment.policy_id.in_(policy_ids)))).all() if policy_ids else []
    posted = set((await session.exec(select(CommissionAccrual.policy_id).where(
        CommissionAccrual.tenant_id == tenant_id, CommissionAccrual.policy_id.in_(policy_ids),
        CommissionAccrual.status == 'POSTED'))).all()) if policy_ids else set()
    owners = {c.id: c for _, c in rows[:50]}
    agent_ids = [c.assigned_agent_id for c in owners.values() if c.assigned_agent_id]
    users = (await session.exec(select(User).where(User.tenant_id == tenant_id, User.id.in_(agent_ids)))).all() if agent_ids else []
    configuration = {'customers': owners, 'users': {u.id: u for u in users}, 'sources': sources}
    def suggested(c):
        source = sources.get(c.acquisition_source_id)
        if source and source.is_active:
            return source.id
        linked = [s.id for s in sources.values() if s.is_active and c.assigned_agent_id and s.user_id == c.assigned_agent_id]
        return linked[0] if len(linked) == 1 else None
    result = []
    for policy, owner in rows[:50]:
        split = [a for a in assignments if a.policy_id == policy.id]
        reasons = []
        automatic = None
        if not split:
            try:
                candidate = await automatic_assignment(session, policy, configuration)
                automatic = {'source_id': candidate.source_id, 'split_pct': '100'}
            except ValueError as exc:
                reasons.append(str(exc))
        elif sum(a.split_pct for a in split) != Decimal(100) or any(a.split_pct <= 0 for a in split):
            reasons.append('Producer splits must total 100%')
        for allocation in split:
            source = sources.get(allocation.source_id)
            if not source or not source.is_active:
                reasons.append('Producer is missing or inactive')
        result.append({'id': policy.id, 'policy_number': policy.policy_number,
            'customer_id': owner.id, 'customer_name': owner.name, 'product_name': policy.product_name,
            'status': policy.status, 'recommended_source_id': suggested(owner),
            'assignments': split, 'frozen': policy.id in posted,
            'ready': not reasons, 'automatic': automatic, 'blocking_reasons': sorted(set(reasons))})
    context = None
    if customer:
        agent = await session.get(User, customer.assigned_agent_id) if customer.assigned_agent_id else None
        source = sources.get(customer.acquisition_source_id)
        context = {'id': customer.id, 'name': customer.name, 'cnic': customer.cnic,
            'assigned_agent_name': agent.full_name if agent and agent.tenant_id == tenant_id else None,
            'acquisition_source_name': source.name if source else None,
            'recommended_source_id': suggested(customer)}
    return {'actor_id': user.id, 'customer': context, 'policies': result, 'has_more': len(rows) > 50,
        'commission_rule_set_code': AGENT_COMMISSION_RULE_SET_CODE,
        'basis_description': 'Receipt base including fees/duty; excludes surcharge',
        'settlement_enabled': False}


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
        if not source or source.tenant_id != tenant_id or not source.is_active:
            raise HTTPException(422, "Producer must be an active acquisition source in this tenant")
    await session.exec(delete(CommissionAssignment).where(
        CommissionAssignment.tenant_id == tenant_id, CommissionAssignment.policy_id == policy_id,
    ))
    rows = [CommissionAssignment(tenant_id=tenant_id, policy_id=policy_id, created_by=user.id, **p.model_dump()) for p in body.producers]
    session.add_all(rows)
    await session.commit()
    return rows


class RatePreviewIn(BaseModel):
    """A hypothetical premium for an individual policy. Fields mirror what RS-COM-002 rules test."""
    policy_year: int = Field(1, ge=1, le=100)
    installment_number: int = Field(1, ge=1, le=1200)
    premium_amount: Decimal = Field(Decimal(0), ge=0, max_digits=18, decimal_places=2)
    insurance_type: str | None = Field(None, max_length=50)
    product_name: str | None = Field(None, max_length=255)
    source_type: str = Field('AGENT', max_length=50)
    channel_code: str | None = Field(None, max_length=100)
    source_code: str | None = Field(None, max_length=50)


def decision_out(decision, base):
    rate = decision['rate']
    return {'rule_set_code': AGENT_COMMISSION_RULE_SET_CODE, 'rule_code': decision['rule_code'],
            'rule_version': decision['rule_version'], 'reason': decision['reason'], 'recurring': decision['recurring'],
            'withholding_tax_pct': decision['withholding_tax_pct'], 'rate_pct': None if rate is None else f'{rate.normalize():f}',
            'payable': rate is not None,
            'gross_amount': None if rate is None else str(money(Decimal(base) * rate / 100))}


@router.post('/rate-preview')
async def rate_preview(tenant_id: UUID, body: RatePreviewIn, identity=Depends(caller), session: AsyncSession = Depends(get_session)):
    """What RS-COM-002 pays on a hypothetical premium. Read-only: nothing is committed."""
    context = {'category': 'Individual', 'insurance_type': body.insurance_type, 'product_name': body.product_name,
               'coverage_amount': None, 'term_years': None, 'policy_year': body.policy_year,
               'premium_type': 'FIRST_YEAR' if body.policy_year == 1 else 'RENEWAL',
               'installment_number': body.installment_number, 'is_first_premium': body.installment_number == 1,
               'premium_amount': float(body.premium_amount), 'source_type': body.source_type,
               'source_code': body.source_code, 'channel_code': body.channel_code or body.source_type}
    try:
        decision = await commission_rate(session, tenant_id, context)
    except ValueError as exc:
        return {'matched': False, 'reason': str(exc), 'context': context}
    return {'matched': True, **decision_out(decision, body.premium_amount), 'context': context}


@router.get('/policies/{policy_id}/preview')
async def policy_preview(tenant_id: UUID, policy_id: UUID, schedule_id: UUID | None = None,
                         installment: int | None = Query(None, ge=1, le=1200),
                         amount: Decimal | None = Query(None, ge=0, max_digits=18, decimal_places=2),
                         user=Depends(admin), session: AsyncSession = Depends(get_session)):
    """What a premium on this policy would post, using the same path as receipt posting. Writes nothing.
    Defaults to the earliest unpaid installment (the first one when all are paid) and its amount due."""
    policy = (await session.exec(select(Policy).where(Policy.id == policy_id, Policy.tenant_id == tenant_id))).first()
    if not policy:
        raise HTTPException(404, 'Policy not found')
    schedules = list((await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy.id).order_by(
        PremiumSchedule.due_date, PremiumSchedule.created_at))).all())
    if schedule_id or installment:
        schedule = next((x for x in schedules if x.id == schedule_id), None) if schedule_id else \
            (schedules[installment - 1] if installment <= len(schedules) else None)
        if not schedule:
            raise HTTPException(404, 'Installment not found on this policy')
    else:
        schedule = next((x for x in schedules if x.amount_paid < x.amount_due), schedules[0] if schedules else None)
    head = {'policy_id': policy.id, 'policy_number': policy.policy_number, 'product_name': policy.product_name}
    if not schedule:
        return {**head, 'ready': False, 'reason': 'The policy has no premium installments yet'}
    base = money(amount if amount is not None else schedule.amount_due)
    head.update(schedule_id=schedule.id, due_date=schedule.due_date, basis_amount=str(base))
    try:
        year, installment, automatic, _, resolved, amounts = await resolve_allocation(session, policy, schedule, base)
    except ValueError as exc:
        return {**head, 'ready': False, 'reason': str(exc)}
    today = date.today()
    return {**head, 'ready': True, 'policy_year': year, 'installment_number': installment,
            'is_first_premium': installment == 1, 'allocation_method': 'AUTO_AGENT' if automatic else 'POLICY_ASSIGNMENT',
            'producers': [{'source_id': source.id, 'payee_name': source.name, 'payee_code': source.code,
                           'split_pct': str(assignment.split_pct), **decision_out(decision, base),
                           'gross_amount': str(amounts[source.id]) if decision['rate'] is not None else None,
                           'disburse_date_if_collected_today': payable_from(source, today) if decision['rate'] is not None else None}
                          for assignment, source, decision, _ in resolved]}


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
                   disbursement_status: Literal['ACCRUED','DRAFT','SUBMITTED','APPROVED','PAID'] | None = None,
                   identity=Depends(caller), session: AsyncSession = Depends(get_session)):
    query = scoped_earnings(tenant_id, identity, source_id, date_from, date_to)
    reserved_ids = select(CommissionDisbursementItem.reserved_earning_id).join(
        CommissionDisbursement, CommissionDisbursement.id == CommissionDisbursementItem.batch_id).where(
            CommissionDisbursement.tenant_id == tenant_id, CommissionDisbursementItem.reserved_earning_id.is_not(None))
    if disbursement_status == 'ACCRUED':
        query = query.where(CommissionEarning.id.not_in(reserved_ids))
    elif disbursement_status:
        query = query.where(CommissionEarning.id.in_(reserved_ids.where(CommissionDisbursement.status == disbursement_status)))
    total = (await session.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    rows = (await session.exec(query.order_by(CommissionEarning.created_at.desc(), CommissionEarning.id).offset(offset).limit(limit))).all()
    states = (await session.exec(select(CommissionDisbursementItem.reserved_earning_id, CommissionDisbursement.status).join(
        CommissionDisbursement, CommissionDisbursement.id == CommissionDisbursementItem.batch_id).where(
            CommissionDisbursement.tenant_id == tenant_id,
            CommissionDisbursementItem.reserved_earning_id.in_([e.id for e in rows])))).all() if rows else []
    by_id = dict(states)
    return {"items": [{**e.model_dump(), 'disbursement_status': by_id.get(e.id, 'ACCRUED')} for e in rows],
            "total": total, "offset": offset, "limit": limit}


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
    paid = (await session.execute(select(func.coalesce(func.sum(sub.c.gross_amount), 0)).select_from(sub).join(
        CommissionDisbursementItem, CommissionDisbursementItem.reserved_earning_id == sub.c.id).join(
            CommissionDisbursement, CommissionDisbursement.id == CommissionDisbursementItem.batch_id).where(
                CommissionDisbursement.tenant_id == tenant_id, CommissionDisbursement.status == 'PAID'))).scalar_one()
    return {"entries": count, "accrued_gross": str(gross), 'paid_gross': str(paid),
            "currency": "PKR", "settlement_enabled": False, 'disbursement_enabled': True,
            'payment_mode': 'MANUAL_CONFIRMATION'}


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
