"""
Policy Issuance & Renewals router — v2 (architectural refinements applied):

  1. Pricing decoupled: PricingEngine.calculate() replaces all inline formulas.
  2. Atomic transactions: /issue and /renew wrapped in explicit BEGIN/ROLLBACK.
  3. Advisory lock: pg_try_advisory_lock(42) prevents duplicate scheduler runs
     if workers > 1 is ever set accidentally.
  4. PENDING_PAYMENT intermediate state: APPROVED → PENDING_PAYMENT → ACTIVE.
  5. Grace period from env: GRACE_PERIOD_DAYS env var (default 30).
"""

import logging
import os
from datetime import date, datetime, timedelta
from typing import List, Optional
from uuid import UUID

from aiokafka import AIOKafkaProducer
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from services import payment_gateway
from services.policy_documents import generate_and_store_documents, generate_and_store_premium_notice
from services.pre_issuance_gate import NotReadyToIssue, assert_ready_to_issue, compute_readiness
from services.pricing_engine import GRACE_PERIOD_DAYS, PricingEngine
from shared.services.policy_state_machine import IllegalStateTransition, apply_transition, record_event
from shared.events.kafka_events import (
    POLICY_LIFECYCLE_TOPIC,
    PolicyLifecycleEvent,
    PolicyLifecyclePayload,
)
from shared.models.core import (
    Beneficiary,
    BillingFrequencyEnum,
    Claim,
    CounterOffer,
    CounterOfferStatusEnum,
    CounterOfferTypeEnum,
    Customer,
    InitialPremiumPayment,
    InsurancePlan,
    IPPStatusEnum,
    MedicalExamOrder,
    MedicalExamStatusEnum,
    Policy,
    PolicyDocument,
    PolicyDocumentTypeEnum,
    PolicyEvent,
    PolicyStatusEnum,
    PolicyVersion,
    PremiumSchedule,
    PremiumScheduleStatusEnum,
    ProfileStatusEnum,
    RenewalStatusEnum,
    RenewalTransaction,
    RiskAssessment,
    Case,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["Policy Issuance & Renewals"])


# ── Request bodies ────────────────────────────────────────────────────────────

class PaymentInitiateRequest(BaseModel):
    method: Optional[str] = None      # JazzCash | Easypaisa | Card | BankTransfer


class PaymentConfirmRequest(BaseModel):
    method: Optional[str] = None
    reference: Optional[str] = None   # echo of the intent reference (webhook style)
    amount: Optional[float] = None    # defaults to the schedule's amount_due
    realize: bool = True              # False simulates a failed / abandoned payment

# ── helpers ───────────────────────────────────────────────────────────────────

def _st(p) -> str:
    """String-safe status extractor — avoids VARCHAR vs enum cast errors."""
    return p.status.value if hasattr(p.status, "value") else str(p.status)


async def _get_policy(session: AsyncSession, tenant_id: UUID, policy_id: UUID) -> Policy:
    policy = await session.get(Policy, policy_id)
    if not policy or policy.tenant_id != tenant_id:
        raise HTTPException(404, "Policy not found")
    return policy


async def _next_policy_number(session: AsyncSession, tenant_id: UUID) -> str:
    """Allocate the next policy number for this tenant and year.

    Previously this counted existing numbered policies and added one, which had
    two defects: two concurrent issuances counted the same total and minted the
    SAME number (Policy.policy_number is unique — one of them 500s), and any
    deleted policy made the counter walk backwards over a number already used.

    Now it takes a transaction-scoped advisory lock keyed on the tenant, then
    derives the next value from the highest suffix actually in use — so it is
    both collision-free under concurrency and monotonic across deletions. The
    lock is released automatically when the surrounding transaction ends.
    """
    year = datetime.utcnow().year
    prefix = f"PL-{year}-"

    # Serialise number allocation per tenant. tenant_id.int is 128 bits; fold it
    # into the signed 64-bit space pg_advisory_xact_lock expects.
    lock_key = (tenant_id.int % (2 ** 62)) - (2 ** 61)
    await session.exec(text("SELECT pg_advisory_xact_lock(:k)").bindparams(k=lock_key))

    rows = await session.exec(
        select(Policy.policy_number).where(
            Policy.tenant_id == tenant_id,
            Policy.policy_number.is_not(None),      # type: ignore[arg-type]
            Policy.policy_number.startswith(prefix),  # type: ignore[attr-defined]
        )
    )
    highest = 0
    for number in rows.all():
        try:
            highest = max(highest, int(str(number).rsplit("-", 1)[-1]))
        except (ValueError, IndexError):     # hand-edited / legacy format — skip
            continue
    return f"{prefix}{highest + 1:04d}"


async def _realized_ipp(session: AsyncSession, policy: Policy) -> Optional[InitialPremiumPayment]:
    """The already-collected pre-underwriting initial premium for this policy.

    Section 30 ("no premium, no risk") has the first premium collected at
    proposal submission, before underwriting runs — see
    routers/initial_premium_payment.py. Issuance must therefore credit what was
    already banked instead of raising a second, full-price demand for the same
    first premium, which is what happened before this existed.
    """
    return (await session.exec(
        select(InitialPremiumPayment).where(
            InitialPremiumPayment.policy_id == policy.id,
            InitialPremiumPayment.status == IPPStatusEnum.REALIZED,
        )
        .order_by(InitialPremiumPayment.realized_at.desc())  # type: ignore[arg-type]
    )).first()


def _age_from_dob(dob: Optional[date]) -> Optional[int]:
    """Age in whole years at today's date, or None when the DOB is unknown."""
    if dob is None:
        return None
    today = date.today()
    return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))


async def _effective_loading_pct(session: AsyncSession, policy: Policy) -> tuple[float, str]:
    """The loading percentage the contract must actually be priced at.

    Three sources can rate a case up, and before this helper existed only the
    first was ever read — so an accepted Loading counter-offer and an adverse
    panel medical both priced at standard rates:

      1. An ACCEPTED Loading counter-offer. This wins outright: the customer was
         shown revised terms and agreed to them, so it is the contractual price
         regardless of what the models suggest.
      2. Otherwise the harsher of the panel medical's rating
         (MedicalExamOrder.suggested_loading_pct) and the AI's holistic
         suggestion (RiskAssessment.suggested_loading). Taking the max is the
         conservative reading — neither assessment cancels the other out.

    Returns (loading_pct, human-readable basis) for the audit trail.
    """
    offer = (await session.exec(
        select(CounterOffer)
        .where(
            CounterOffer.policy_id == policy.id,
            CounterOffer.status == CounterOfferStatusEnum.ACCEPTED,
            CounterOffer.offer_type == CounterOfferTypeEnum.LOADING,
        )
        .order_by(CounterOffer.responded_at.desc())  # type: ignore[arg-type]
    )).first()
    if offer is not None and offer.revised_loading_pct:
        return float(offer.revised_loading_pct), "accepted counter-offer"

    ra = (await session.exec(
        select(RiskAssessment).where(RiskAssessment.policy_id == policy.id)
        .order_by(RiskAssessment.created_at.desc())  # type: ignore[arg-type]
    )).first()
    ai_loading = float(getattr(ra, "suggested_loading", 0) or 0)

    # MedicalExamOrder.policy_id is nullable (the order is keyed by case), so
    # fall back to the case link rather than silently missing the rating.
    med = (await session.exec(
        select(MedicalExamOrder)
        .where(MedicalExamOrder.policy_id == policy.id)
        .order_by(MedicalExamOrder.updated_at.desc())  # type: ignore[arg-type]
    )).first()
    if med is None:
        case_ids = [
            c.caseld for c in
            (await session.exec(select(Case).where(Case.policy_id == policy.id))).all()
        ]
        if case_ids:
            med = (await session.exec(
                select(MedicalExamOrder)
                .where(MedicalExamOrder.case_id.in_(case_ids))  # type: ignore[attr-defined]
                .order_by(MedicalExamOrder.updated_at.desc())   # type: ignore[arg-type]
            )).first()
    med_loading = 0.0
    if med is not None and med.status == MedicalExamStatusEnum.COMPLETED:
        med_loading = float(med.suggested_loading_pct or 0)

    if med_loading >= ai_loading and med_loading > 0:
        return med_loading, "panel medical findings"
    if ai_loading > 0:
        return ai_loading, "AI risk assessment"
    return 0.0, "standard rates"


async def _price_breakdown(session: AsyncSession, tenant_id: UUID, policy: Policy,
                           coverage_override: Optional[float] = None):
    """Compute the premium breakdown for a policy (shared by /issue, the
    issuance-preview and endorsement re-quotes). Reads the customer's rating
    factors, resolves the effective loading, and delegates to
    PricingEngine.calculate() — which runs the same shared formula POST /quote
    used, so the issued contract matches the quote the customer accepted.
    Pass coverage_override to re-price a sum-assured change without mutating
    the policy."""
    cust = await session.get(Customer, policy.customer_id)
    is_smoker = bool(getattr(cust, "is_smoker", False))
    loading_pct, _basis = await _effective_loading_pct(session, policy)
    ins_type_str = policy.insurance_type.value if hasattr(policy.insurance_type, "value") else str(policy.insurance_type)
    base_rate, smoker_factor = await _load_plan_rates(session, tenant_id, policy.insurance_type)
    return PricingEngine.calculate(
        insurance_type=ins_type_str,
        coverage_amount=coverage_override if coverage_override is not None else policy.coverage_amount,
        term_years=policy.term_years,
        base_rate=base_rate,
        smoker_factor=smoker_factor,
        loading_pct=loading_pct,
        is_smoker=is_smoker,
        age=_age_from_dob(getattr(cust, "dob", None)),
        height_cm=getattr(cust, "height_cm", None),
        weight_kg=getattr(cust, "weight_kg", None),
    ), loading_pct


def _maturity_date(effective: date, term_years: int) -> date:
    """Contract maturity = effective + term (safe for Feb-29 effective dates)."""
    try:
        return date(effective.year + term_years, effective.month, effective.day)
    except ValueError:
        return date(effective.year + term_years, effective.month, effective.day - 1)


async def _load_plan_rates(session: AsyncSession, tenant_id: UUID, insurance_type) -> tuple[float, float]:
    """Return (base_rate, smoker_factor) from the InsurancePlan table."""
    from services.pricing_engine import get_default_rates
    ins_type_str = insurance_type.value if hasattr(insurance_type, "value") else str(insurance_type)
    plan_res = await session.exec(
        select(InsurancePlan).where(
            InsurancePlan.tenant_id == tenant_id,
            InsurancePlan.insurance_type == insurance_type,
        )
    )
    plan = plan_res.first()
    if plan and plan.base_premium_rate:
        return float(plan.base_premium_rate), float(plan.smoker_factor or 1.0)
    return get_default_rates(ins_type_str)


async def _publish_policy_event(request: Optional[Request], policy: Policy, event: PolicyEvent) -> None:
    """Fire-and-forget: mirror a committed PolicyEvent onto Kafka so downstream
    services (notifications, document generation) can react. A failed publish
    must never fail the lifecycle transaction — the PolicyEvent row is the
    source of truth, this is just the decoupled fan-out."""
    if request is None or not hasattr(request, "app") or not hasattr(request.app, "state"):
        return
    producer: Optional[AIOKafkaProducer] = getattr(request.app.state, "kafka_producer", None)
    if producer is None:
        return
    envelope = PolicyLifecycleEvent(
        event_type=event.event_type,
        tenant_id=policy.tenant_id,
        payload=PolicyLifecyclePayload(
            policy_id=policy.id,
            policy_number=policy.policy_number,
            customer_id=policy.customer_id,
            from_status=event.from_status,
            to_status=event.to_status,
            actor=event.actor,
            detail=event.detail_json,
        ),
    )
    try:
        await producer.send_and_wait(
            POLICY_LIFECYCLE_TOPIC,
            value=envelope.model_dump_json(),
            key=str(policy.tenant_id),
        )
    except Exception as err:  # noqa: BLE001 — best-effort fan-out
        log.warning("Failed to publish policy lifecycle event %s: %s", event.event_type, err)


async def _pending_schedule(session: AsyncSession, policy_id: UUID) -> Optional[PremiumSchedule]:
    """Earliest still-unpaid installment for a policy (by due date)."""
    res = await session.exec(
        select(PremiumSchedule).where(PremiumSchedule.policy_id == policy_id)
    )
    unpaid = [
        s for s in res.all()
        if (s.status.value if hasattr(s.status, "value") else str(s.status))
        in (PremiumScheduleStatusEnum.PENDING.value, PremiumScheduleStatusEnum.OVERDUE.value)
    ]
    unpaid.sort(key=lambda s: s.due_date)
    return unpaid[0] if unpaid else None


# Days the customer has to walk away for a full refund after delivery. Config via
# env so different regulators (PK default: 14) can be honoured without a redeploy.
FREE_LOOK_DAYS = int(os.environ.get("FREE_LOOK_DAYS", "14"))

# Number of installments in one policy year, by billing frequency.
_INSTALLMENTS_PER_YEAR = {
    BillingFrequencyEnum.ANNUAL: 1,
    BillingFrequencyEnum.SEMI_ANNUAL: 2,
    BillingFrequencyEnum.QUARTERLY: 4,
    BillingFrequencyEnum.MONTHLY: 12,
}


def _build_premium_schedule(
    policy_id: UUID, version_id: UUID, total_annual_premium: float,
    effective: date, billing_frequency: BillingFrequencyEnum, first_reference: Optional[str],
    prepaid_amount: float = 0.0, prepaid_at: Optional[datetime] = None,
) -> list[PremiumSchedule]:
    """Build the first policy-year installment ledger for a billing frequency.

    ANNUAL (today's default) yields a single installment; the finer cadences
    split the annual premium evenly and space the due dates across the year.

    ``prepaid_amount`` is the pre-underwriting Initial Premium Payment already
    realized against this policy. It is credited to the first installment, which
    settles as PAID when the credit covers it — otherwise the balance stays
    collectable as a top-up. Without this the applicant was billed the whole
    first premium a second time at issuance.
    """
    n = _INSTALLMENTS_PER_YEAR.get(billing_frequency, 1)
    per = round(total_annual_premium / n, 2)
    step_days = 365 // n
    rows: list[PremiumSchedule] = []
    for i in range(n):
        # Absorb rounding drift into the first installment so the year still sums.
        amount = round(total_annual_premium - per * (n - 1), 2) if i == 0 else per
        credit = round(min(prepaid_amount, amount), 2) if i == 0 else 0.0
        settled = i == 0 and credit >= amount - 0.01
        rows.append(PremiumSchedule(
            policy_id=policy_id,
            policy_version_id=version_id,
            billing_frequency=billing_frequency,
            due_date=effective + timedelta(days=step_days * i),
            amount_due=amount,
            amount_paid=credit,
            status=PremiumScheduleStatusEnum.PAID if settled else PremiumScheduleStatusEnum.PENDING,
            paid_at=(prepaid_at or datetime.utcnow()) if settled else None,
            payment_reference=first_reference if i == 0 else None,
            installment_no=i + 1,
        ))
    return rows


async def _bind_cover(
    session: AsyncSession, policy: Policy, *, actor: str, detail: dict,
) -> PolicyEvent:
    """Take a fully-paid policy live: PENDING_PAYMENT → ACTIVE plus everything
    that legally follows from cover incepting.

    Shared by ``/payments/confirm`` (the applicant settles the balance) and
    ``/issue`` (the pre-underwriting Initial Premium Payment already covered the
    first premium, so there is nothing left to collect). Both routes must do
    identical work — free-look clock, case closure, policyholder promotion,
    binding documents — so it lives here rather than being written twice.
    """
    event = apply_transition(
        session, policy, PolicyStatusEnum.ACTIVE,
        event_type="PaymentConfirmed", actor=actor, detail=detail,
    )

    # Start the free-look clock. Delivery = the moment cover binds and docs go
    # out; the statutory window runs from here (NOT effective_date). Stage B
    # step 1 reads these to allow a full-refund cancellation inside the window.
    policy.delivery_date = date.today()
    policy.free_look_end_date = policy.delivery_date + timedelta(days=FREE_LOOK_DAYS)

    # Finalize the pre-issuance workflow now that cover is in force.
    await _close_cases_and_promote(session, policy)

    # Generate the binding documents (Schedule, Certificate, Wording)
    await generate_and_store_documents(session, policy, policy.current_version_id)

    return event


async def _close_cases_and_promote(session: AsyncSession, policy: Policy) -> None:
    """Close underwriting cases for a policy and promote the customer (and their
    family/org) to POLICYHOLDER. Runs at payment confirmation — cover is now
    legally in force, so the pre-issuance workflow artifacts are finalized."""
    from shared.models.core import Case, CaseStatusEnum, FamilyGroup, Organization

    closed_case_ids: set = set()

    # Cases directly linked to this policy
    cases_by_policy = (await session.exec(select(Case).where(Case.policy_id == policy.id))).all()
    for case in cases_by_policy:
        if case.caseStatus == CaseStatusEnum.APPROVED:
            case.caseStatus = CaseStatusEnum.CLOSED
            case.updatedAt = datetime.utcnow()
            session.add(case)
            closed_case_ids.add(case.caseld)

    # Cases for this customer with no policy_id FK set (orphan approved cases)
    from sqlalchemy import cast, String as SAString
    cases_by_customer = (await session.exec(
        select(Case).where(
            Case.tenant_id == policy.tenant_id,
            Case.customer_id == policy.customer_id,
            cast(Case.caseStatus, SAString) == CaseStatusEnum.APPROVED.value,
        )
    )).all()
    for case in cases_by_customer:
        if case.caseld not in closed_case_ids:
            case.caseStatus = CaseStatusEnum.CLOSED
            case.updatedAt = datetime.utcnow()
            session.add(case)

    # Promote Customer (and their family/org group) to POLICYHOLDER
    customer = await session.get(Customer, policy.customer_id)
    if customer:
        customer.profile_status = ProfileStatusEnum.POLICYHOLDER
        session.add(customer)
        if customer.family_group_id:
            fg = await session.get(FamilyGroup, customer.family_group_id)
            if fg:
                fg.profile_status = ProfileStatusEnum.POLICYHOLDER
                session.add(fg)
        if customer.organization_id:
            org = await session.get(Organization, customer.organization_id)
            if org:
                org.profile_status = ProfileStatusEnum.POLICYHOLDER
                session.add(org)


# ── GET /stats ────────────────────────────────────────────────────────────────

@router.get("/tenants/{tenant_id}/policies/stats")
async def policy_stats(tenant_id: UUID, session: AsyncSession = Depends(get_session)):
    result = await session.exec(select(Policy).where(Policy.tenant_id == tenant_id))
    all_policies = list(result.all())
    today = date.today()
    return {
        "total": len(all_policies),
        "pending_issuance": sum(1 for p in all_policies if _st(p).upper() in ("APPROVED", "ACCEPTEDWITHLOADINGS", "PENDINGPAYMENT")),
        "active": sum(1 for p in all_policies if _st(p).upper() == "ACTIVE"),
        "grace_period": sum(1 for p in all_policies if _st(p).upper() == "GRACEPERIOD"),
        "lapsed": sum(1 for p in all_policies if _st(p).upper() == "LAPSED"),
        "cancelled": sum(1 for p in all_policies if _st(p).upper() == "CANCELLED"),
        "expiring_30d": sum(
            1 for p in all_policies
            if _st(p).upper() == "ACTIVE" and p.expiry_date and 0 <= (p.expiry_date - today).days <= 30
        ),
    }


# ── GET /renewals/upcoming ────────────────────────────────────────────────────

@router.get("/tenants/{tenant_id}/policies/renewals/upcoming")
async def upcoming_renewals(
    tenant_id: UUID,
    days: int = Query(90, ge=1, le=365),
    session: AsyncSession = Depends(get_session),
):
    today = date.today()
    result = await session.exec(select(Policy).where(Policy.tenant_id == tenant_id))
    upcoming = []
    for p in result.all():
        # _st() returns the enum *value* ("Active" / "GracePeriod"). Comparing
        # against SCREAMING_SNAKE names here matched nothing, so this endpoint
        # silently returned an empty list for every tenant.
        st = _st(p)
        if st not in (PolicyStatusEnum.ACTIVE.value, PolicyStatusEnum.GRACE_PERIOD.value) or not p.expiry_date:
            continue
        days_left = (p.expiry_date - today).days
        if days_left > days:
            continue
        urgency = ("grace" if st == PolicyStatusEnum.GRACE_PERIOD.value else
                   "15d" if days_left <= 15 else
                   "30d" if days_left <= 30 else
                   "60d" if days_left <= 60 else "90d")
        cust = await session.get(Customer, p.customer_id)
        upcoming.append({
            "policy_id": str(p.id),
            "policy_number": p.policy_number,
            "customer_id": str(p.customer_id),
            "customer_name": cust.name if cust else "—",
            "product_name": p.product_name,
            "coverage_amount": p.coverage_amount,
            "expiry_date": p.expiry_date.isoformat(),
            "grace_period_end_date": p.grace_period_end_date.isoformat() if p.grace_period_end_date else None,
            "status": st,
            "days_to_expiry": days_left,
            "urgency": urgency,
        })
    return sorted(upcoming, key=lambda x: x["days_to_expiry"])


# ── GET /policies ─────────────────────────────────────────────────────────────

@router.get("/tenants/{tenant_id}/policies")
async def list_policies(
    tenant_id: UUID,
    status: Optional[str] = None,
    customer_id: Optional[UUID] = None,
    session: AsyncSession = Depends(get_session),
):
    q = select(Policy).where(Policy.tenant_id == tenant_id)
    if customer_id:
        q = q.where(Policy.customer_id == customer_id)
    result = await session.exec(q)
    policies = list(result.all())
    if status:
        policies = [p for p in policies if _st(p) == status]
    out = []
    for p in policies:
        cust = await session.get(Customer, p.customer_id)
        
        segment = "individual"
        if getattr(p, "family_policy_id", None):
            segment = "family"
        elif getattr(p, "master_policy_id", None):
            segment = "organization"
            
        case_res = await session.exec(select(Case).where(Case.policy_id == p.id))
        case_obj = case_res.first()
        case_number = case_obj.caseNumber if case_obj else None
        case_status = case_obj.caseStatus if case_obj else None

        out.append({
            "id": str(p.id),
            "policy_number": p.policy_number,
            "customer_id": str(p.customer_id),
            "customer_name": cust.name if cust else "—",
            "family_group_id": str(cust.family_group_id) if cust and cust.family_group_id else None,
            "product_name": p.product_name,
            "insurance_type": p.insurance_type.value if hasattr(p.insurance_type, "value") else str(p.insurance_type),
            "coverage_amount": p.coverage_amount,
            "term_years": p.term_years,
            "status": _st(p),
            "segment": segment,
            "case_number": case_number,
            "case_status": case_status,
            "effective_date": p.effective_date.isoformat() if p.effective_date else None,
            "expiry_date": p.expiry_date.isoformat() if p.expiry_date else None,
            "created_at": p.created_at.isoformat(),
        })
    return out


# ── GET /policies/{pid} ───────────────────────────────────────────────────────

@router.get("/tenants/{tenant_id}/policies/{policy_id}")
async def get_policy_detail(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    cust = await session.get(Customer, policy.customer_id)

    versions = [
        {"id": str(v.id), "version_number": v.version_number,
         "effective_from": v.effective_from.isoformat(),
         "effective_to": v.effective_to.isoformat() if v.effective_to else None,
         "total_premium": v.total_premium, "event_type": v.event_type,
         "rating_basis": v.loadings_json.get("rating_basis", "") if v.loadings_json else "",
         "created_at": v.created_at.isoformat()}
        for v in (await session.exec(select(PolicyVersion).where(PolicyVersion.policy_id == policy_id))).all()
    ]
    schedules = [
        {"id": str(s.id), "due_date": s.due_date.isoformat(),
         "amount_due": s.amount_due, "amount_paid": s.amount_paid,
         "status": s.status.value if hasattr(s.status, "value") else str(s.status)}
        for s in (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy_id))).all()
    ]
    renewals = [
        {"id": str(r.id), "renewal_year": r.renewal_year,
         "status": r.status.value if hasattr(r.status, "value") else str(r.status),
         "renewal_premium": r.renewal_premium, "is_stp": r.is_stp,
         "created_at": r.created_at.isoformat()}
        for r in (await session.exec(select(RenewalTransaction).where(RenewalTransaction.policy_id == policy_id))).all()
    ]
    documents = [
        {"id": str(d.id),
         "document_type": d.document_type.value if hasattr(d.document_type, "value") else str(d.document_type),
         "document_name": d.document_name, "is_stub": d.is_stub,
         "generated_at": d.generated_at.isoformat()}
        for d in (await session.exec(select(PolicyDocument).where(PolicyDocument.policy_id == policy_id))).all()
    ]

    return {
        "id": str(policy.id), "policy_number": policy.policy_number,
        "customer_id": str(policy.customer_id), "customer_name": cust.name if cust else "—",
        "product_name": policy.product_name,
        "insurance_type": policy.insurance_type.value if hasattr(policy.insurance_type, "value") else str(policy.insurance_type),
        "coverage_amount": policy.coverage_amount, "term_years": policy.term_years,
        "nominee_name": policy.nominee_name, "nominee_relationship": policy.nominee_relationship,
        "dependent_name": policy.dependent_name, "dependent_dob": policy.dependent_dob.isoformat() if policy.dependent_dob else None,
        "status": _st(policy),
        "effective_date": policy.effective_date.isoformat() if policy.effective_date else None,
        "expiry_date": policy.expiry_date.isoformat() if policy.expiry_date else None,
        "maturity_date": policy.maturity_date.isoformat() if policy.maturity_date else None,
        "issued_by": policy.issued_by,
        "issued_at": policy.issued_at.isoformat() if policy.issued_at else None,
        "grace_period_end_date": policy.grace_period_end_date.isoformat() if policy.grace_period_end_date else None,
        "delivery_date": policy.delivery_date.isoformat() if policy.delivery_date else None,
        "free_look_end_date": policy.free_look_end_date.isoformat() if policy.free_look_end_date else None,
        "demo_bypass_flags": policy.demo_bypass_flags,
        "current_version_id": str(policy.current_version_id) if policy.current_version_id else None,
        "versions": versions, "premium_schedules": schedules,
        "renewal_transactions": renewals, "documents": documents,
        "created_at": policy.created_at.isoformat(),
        "customer": {
            "cnic": cust.cnic if cust else None,
            "dob": cust.dob.isoformat() if cust and cust.dob else None,
            "gender": cust.gender.value if cust and hasattr(cust.gender, "value") else str(cust.gender) if cust and cust.gender else None,
            "marital_status": cust.marital_status.value if cust and hasattr(cust.marital_status, "value") else str(cust.marital_status) if cust and cust.marital_status else None,
            "phone": cust.details.get("phone") if cust and cust.details else None,
            "email": cust.details.get("email") if cust and cust.details else None,
            "city": cust.city if cust else None,
            "province": cust.province if cust else None,
            "occupation": cust.occupation if cust else None,
            "declared_income": cust.declared_income if cust else None,
            "is_smoker": cust.is_smoker if cust else False,
            "height_cm": cust.height_cm if cust else None,
            "weight_kg": cust.weight_kg if cust else None,
            "policyholder_id": cust.policyholder_id if cust else None,
            "created_at": cust.created_at.isoformat() if cust else None,
        } if cust else None,
    }


# ── POST /issue ───────────────────────────────────────────────────────────────
# Phase 1 (payment gate): /issue no longer flips straight to ACTIVE. It drafts
# the contract (policy number, PolicyVersion 1.0, documents), writes the first
# premium installment as PENDING, and stops at PENDING_PAYMENT. Coverage only
# goes live once POST /payments/confirm realizes the first premium — so a policy
# can NEVER reach ACTIVE without a PAID schedule row.
# Pricing stays decoupled via PricingEngine.calculate(); the whole draft is one
# atomic transaction; every status change goes through the state machine.

@router.get("/tenants/{tenant_id}/policies/{policy_id}/issuance-preview")
async def issuance_preview(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    """Everything the issuance Review screen needs in one call: the insured, the
    contract terms (with the maturity date it *will* get), the real premium
    breakdown, the beneficiaries, and the Stage-A readiness (blockers/warnings)."""
    policy = await _get_policy(session, tenant_id, policy_id)
    cust = await session.get(Customer, policy.customer_id)
    breakdown, loading_pct = await _price_breakdown(session, tenant_id, policy)

    effective = policy.effective_date or date.today()
    maturity = _maturity_date(effective, policy.term_years)
    readiness = await compute_readiness(session, policy)

    bens = (await session.exec(select(Beneficiary).where(Beneficiary.policy_id == policy_id))).all()

    return {
        "policy_id": str(policy.id),
        "status": _st(policy),
        "already_issued": bool(policy.policy_number),
        "insured": {
            "name": cust.name if cust else "—",
            "cnic": cust.cnic if cust else None,
            "dob": cust.dob.isoformat() if (cust and cust.dob) else None,
            "policyholder_id": cust.policyholder_id if cust else None,
            "is_smoker": bool(getattr(cust, "is_smoker", False)),
        },
        "contract": {
            "product_name": policy.product_name,
            "insurance_type": policy.insurance_type.value if hasattr(policy.insurance_type, "value") else str(policy.insurance_type),
            "coverage_amount": policy.coverage_amount,
            "term_years": policy.term_years,
            "effective_date": effective.isoformat(),
            "maturity_date": maturity.isoformat(),
            "billing_frequency": "Annual",
            "loading_pct": loading_pct,
        },
        "premium_breakdown": breakdown.to_dict(),
        "beneficiaries": [
            {"name": b.name, "relationship": b.relationship, "share_pct": b.share_pct}
            for b in bens
        ],
        "readiness": {
            "ready_to_issue": readiness["ready_to_issue"],
            "blockers": readiness["blockers"],
            "warnings": readiness["warnings"],
        },
    }


@router.post("/tenants/{tenant_id}/policies/{policy_id}/issue")
async def issue_policy(
    tenant_id: UUID, policy_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    # ── Pre-flight checks (outside transaction — read-only) ──────────────────
    policy = await _get_policy(session, tenant_id, policy_id)
    status_val = _st(policy)
    if status_val not in ("Approved", "AcceptedWithLoadings", "Issued", "UnderReview"):
        raise HTTPException(
            400,
            "Policy must be Approved, AcceptedWithLoadings, Issued, or UnderReview to issue "
            f"(current: {status_val})",
        )
    if policy.policy_number:
        raise HTTPException(400, "Policy already issued")

    # Stage A gate — cannot draft the contract until every pre-issuance step is
    # satisfied (revised terms accepted, requirements cleared, compliance passed,
    # beneficiaries capturing 100%). Same rules the /pre-issuance checklist shows.
    try:
        readiness = await assert_ready_to_issue(session, policy)
    except NotReadyToIssue as exc:
        raise HTTPException(400, f"Pre-issuance checklist incomplete: {exc}") from exc
    # Record which mandatory gates (compliance / beneficiaries) were waved through
    # in DEMO mode so Stage B and audit know this contract still needs backfilling.
    demo_bypass_flags = readiness.get("demo_bypass_flags", "NotFlagged")

    # ── Pricing ──────────────────────────────────────────────────────────────
    # Same shared formula POST /quote ran, and the effective loading now honours
    # an accepted counter-offer and the panel medical, not just the AI's number.
    breakdown, loading_pct = await _price_breakdown(session, tenant_id, policy)
    _, loading_basis = await _effective_loading_pct(session, policy)

    today = date.today()
    effective = policy.effective_date or today
    expiry = _maturity_date(effective, policy.term_years)
    grace_end = expiry + timedelta(days=GRACE_PERIOD_DAYS)

    # Credit the pre-underwriting Initial Premium Payment: the applicant already
    # settled the first premium at proposal, so only a balance (if the final
    # underwritten premium came out higher) can still be owed.
    ipp = await _realized_ipp(session, policy)
    prepaid = float(ipp.amount or 0) if ipp else 0.0
    balance_due = round(max(0.0, breakdown.total_premium - prepaid), 2)
    fully_prepaid = balance_due <= 0.01

    # Payment intent for whatever is still outstanding. Nothing to raise when the
    # initial premium already covered the contract.
    intent = payment_gateway.initiate_payment(balance_due) if not fully_prepaid else None

    # ── Atomic draft transaction ─────────────────────────────────────────────
    try:
        if _st(policy) == "UnderReview":
            apply_transition(
                session, policy, PolicyStatusEnum.APPROVED,
                event_type="UnderwritingApproved",
                actor="demo-bypass",
                detail={"note": "Implicitly approved during issuance (demo mode)"}
            )

        policy_number = await _next_policy_number(session, tenant_id)

        # PolicyVersion 1.0 — immutable contract snapshot
        version = PolicyVersion(
            policy_id=policy_id,
            version_number="1.0",
            effective_from=effective,
            effective_to=None,
            base_premium=breakdown.base_premium,
            loading_amount=breakdown.loading_amount,
            policy_fee=breakdown.policy_fee,
            tax_amount=breakdown.tax_amount,
            total_premium=breakdown.total_premium,
            loadings_json={
                "loading_pct": loading_pct,
                "rating_basis": breakdown.rating_basis,
            },
            created_by="system",
            event_type="Issuance",
        )
        session.add(version)
        await session.flush()  # get version.id before FK usage

        # First policy-year installment ledger, with the already-realized initial
        # premium credited against the first row. ANNUAL (default) = one row;
        # finer cadences seed the whole year so Stage B has a ledger to collect
        # against. The earliest row must be PAID before cover can bind.
        billing_frequency = BillingFrequencyEnum.ANNUAL
        for schedule in _build_premium_schedule(
            policy_id, version.id, breakdown.total_premium,
            effective, billing_frequency,
            intent.reference if intent else (ipp.reference if ipp else None),
            prepaid_amount=prepaid,
            prepaid_at=ipp.realized_at if ipp else None,
        ):
            session.add(schedule)

        # Draft the contract fields and move to PENDING_PAYMENT (no cover yet).
        policy.policy_number = policy_number
        policy.effective_date = effective
        policy.expiry_date = expiry
        policy.maturity_date = _maturity_date(effective, policy.term_years)
        policy.grace_period_end_date = grace_end
        policy.current_version_id = version.id
        policy.demo_bypass_flags = demo_bypass_flags
        # Issuance formalities — the authorising officer + timestamp.
        policy.issued_by = "issuance-officer"
        policy.issued_at = datetime.utcnow()

        # Generate the Premium Notice (bill) now that the contract fields are set.
        await generate_and_store_premium_notice(session, policy, version.id)
        documents_generated = 1

        event = apply_transition(
            session, policy, PolicyStatusEnum.PENDING_PAYMENT,
            event_type="PolicyIssued",
            actor="system",
            detail={
                "policy_number": policy_number,
                "total_premium": breakdown.total_premium,
                "loading_pct": loading_pct,
                "loading_basis": loading_basis,
                "initial_premium_credited": round(prepaid, 2),
                "balance_due": balance_due,
                "payment_reference": intent.reference if intent else None,
                "version": "1.0",
            },
        )
        events = [event]

        # The initial premium already covers the contract — there is nothing left
        # to collect, so cover incepts now rather than parking the policy at
        # PendingPayment behind a zero-value payment the user would have to fake.
        if fully_prepaid:
            events.append(await _bind_cover(
                session, policy,
                actor="system",
                detail={
                    "payment_reference": ipp.reference if ipp else None,
                    "amount": round(prepaid, 2),
                    "method": ipp.method if ipp else None,
                    "source": "InitialPremiumPayment",
                },
            ))
            documents_generated += 3

        await session.commit()

    except IllegalStateTransition as exc:
        await session.rollback()
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        await session.rollback()
        log.exception("Issuance failed for policy %s — rolled back", policy_id)
        raise HTTPException(500, f"Issuance failed and was rolled back: {exc}") from exc

    for ev in events:
        await _publish_policy_event(request, policy, ev)

    log.info(
        "Policy %s: %s (%s) — premium PKR %.0f (loading %.1f%% via %s), "
        "initial premium credited PKR %.0f, balance PKR %.0f",
        "issued and activated" if fully_prepaid else "drafted (pending payment)",
        policy_number, policy_id, breakdown.total_premium, loading_pct, loading_basis,
        prepaid, balance_due,
    )
    return {
        "policy_number": policy_number,
        "status": _st(policy),
        "effective_date": effective.isoformat(),
        "expiry_date": expiry.isoformat(),
        "maturity_date": policy.maturity_date.isoformat() if policy.maturity_date else None,
        "grace_period_end_date": grace_end.isoformat(),
        "premium_breakdown": breakdown.to_dict(),
        "version": "1.0",
        "documents_generated": documents_generated,
        "grace_period_days": GRACE_PERIOD_DAYS,
        "total_premium": round(breakdown.total_premium, 2),
        "initial_premium_credited": round(prepaid, 2),
        "amount_due": balance_due,
        "payment": intent.to_dict() if intent else None,
        "available_payment_methods": payment_gateway.available_methods(),
        "delivery_date": policy.delivery_date.isoformat() if policy.delivery_date else None,
        "free_look_end_date": policy.free_look_end_date.isoformat() if policy.free_look_end_date else None,
    }


# ── POST /payments/initiate ───────────────────────────────────────────────────
# Optional step: let an agent/customer pick a channel (JazzCash, Easypaisa,
# card, bank transfer) for a policy already sitting in PENDING_PAYMENT. Refreshes
# the pending installment's payment_reference to the chosen channel's intent.

@router.post("/tenants/{tenant_id}/policies/{policy_id}/payments/initiate")
async def initiate_payment(
    tenant_id: UUID, policy_id: UUID,
    body: PaymentInitiateRequest,
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    if _st(policy) != PolicyStatusEnum.PENDING_PAYMENT.value:
        raise HTTPException(400, f"Policy is not awaiting payment (current: {_st(policy)})")

    schedule = await _pending_schedule(session, policy_id)
    if schedule is None:
        raise HTTPException(400, "No pending premium installment found for this policy")

    try:
        intent = payment_gateway.initiate_payment(schedule.amount_due, body.method)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    schedule.payment_reference = intent.reference
    session.add(schedule)
    await session.commit()

    return {
        "policy_id": str(policy_id),
        "amount_due": round(schedule.amount_due, 2),
        "payment": intent.to_dict(),
        "available_payment_methods": payment_gateway.available_methods(),
    }


# ── POST /payments/confirm ────────────────────────────────────────────────────
# Webhook-style settlement callback. Marks the first premium PAID and only then
# binds cover: PENDING_PAYMENT → ACTIVE, closes underwriting cases, promotes the
# customer to POLICYHOLDER. This is the single gate that activates a policy.

@router.post("/tenants/{tenant_id}/policies/{policy_id}/payments/confirm")
async def confirm_payment(
    tenant_id: UUID, policy_id: UUID,
    request: Request,
    body: PaymentConfirmRequest,
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    if _st(policy) != PolicyStatusEnum.PENDING_PAYMENT.value:
        raise HTTPException(400, f"Policy is not awaiting payment (current: {_st(policy)})")

    schedule = await _pending_schedule(session, policy_id)
    if schedule is None:
        raise HTTPException(400, "No pending premium installment found for this policy")

    amount = body.amount if body.amount is not None else schedule.amount_due
    reference = body.reference or schedule.payment_reference or payment_gateway.generate_reference(
        payment_gateway.PaymentMethodEnum.JAZZCASH
    )
    try:
        intent = payment_gateway.confirm_payment(reference, amount, body.method, realize=body.realize)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    # Failed / abandoned settlement — stay in PENDING_PAYMENT, record the attempt.
    if intent.status != payment_gateway.PaymentStatusEnum.REALIZED:
        record_event(
            session, policy,
            event_type="PaymentFailed",
            from_status=PolicyStatusEnum.PENDING_PAYMENT,
            to_status=PolicyStatusEnum.PENDING_PAYMENT,
            actor="gateway",
            detail={"payment_reference": reference, "amount": amount, "method": intent.method.value},
        )
        await session.commit()
        raise HTTPException(402, "Payment was not realized — policy remains pending payment")

    try:
        # Mark the installment PAID.
        schedule.amount_paid = schedule.amount_due
        schedule.status = PremiumScheduleStatusEnum.PAID
        schedule.paid_at = intent.realized_at or datetime.utcnow()
        schedule.payment_reference = intent.reference
        session.add(schedule)

        # Bind cover: PENDING_PAYMENT → ACTIVE (guarded by the state machine),
        # plus free-look clock, case closure, promotion and binding documents.
        event = await _bind_cover(
            session, policy,
            actor="gateway",
            detail={
                "payment_reference": intent.reference,
                "amount": round(amount, 2),
                "method": intent.method.value,
                "schedule_id": str(schedule.id),
            },
        )

        await session.commit()

    except IllegalStateTransition as exc:
        await session.rollback()
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        await session.rollback()
        log.exception("Payment confirmation failed for policy %s — rolled back", policy_id)
        raise HTTPException(500, f"Payment confirmation failed and was rolled back: {exc}") from exc

    await _publish_policy_event(request, policy, event)

    log.info("Policy activated: %s (%s) — first premium realized (ref=%s)",
             policy.policy_number, policy_id, intent.reference)
    return {
        "policy_id": str(policy_id),
        "policy_number": policy.policy_number,
        "status": "Active",
        "effective_date": policy.effective_date.isoformat() if policy.effective_date else None,
        "expiry_date": policy.expiry_date.isoformat() if policy.expiry_date else None,
        "grace_period_end_date": policy.grace_period_end_date.isoformat() if policy.grace_period_end_date else None,
        "delivery_date": policy.delivery_date.isoformat() if policy.delivery_date else None,
        "free_look_end_date": policy.free_look_end_date.isoformat() if policy.free_look_end_date else None,
        "payment": intent.to_dict(),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# STAGE B — POST-ISSUANCE LIFECYCLE (renew / lapse / cancel)
# Temporarily commented out for now. These actions run AFTER a policy has been
# issued and activated. Re-enable when Stage B is back in scope.
# ═══════════════════════════════════════════════════════════════════════════════
# # ── POST /renew ───────────────────────────────────────────────────────────────
#
# @router.post("/tenants/{tenant_id}/policies/{policy_id}/renew")
# async def renew_policy(
#     tenant_id: UUID, policy_id: UUID,
#     request: Request,
#     session: AsyncSession = Depends(get_session),
# ):
#     policy = await _get_policy(session, tenant_id, policy_id)
#     if _st(policy) not in ("Active", "GracePeriod"):
#         raise HTTPException(400, f"Policy must be Active or GracePeriod to renew (current: {_st(policy)})")
#
#     rt_all = list((await session.exec(select(RenewalTransaction).where(RenewalTransaction.policy_id == policy_id))).all())
#     renewal_year = len(rt_all) + 2
#
#     claims_count = len(list((await session.exec(select(Claim).where(Claim.policy_id == policy_id))).all()))
#     is_stp = claims_count == 0
#
#     cust = await session.get(Customer, policy.customer_id)
#     is_smoker = bool(getattr(cust, "is_smoker", False))
#
#     ins_type_str = policy.insurance_type.value if hasattr(policy.insurance_type, "value") else str(policy.insurance_type)
#     base_rate, smoker_factor = await _load_plan_rates(session, tenant_id, policy.insurance_type)
#     age_index = 1.02 ** (renewal_year - 1)   # +2% per renewal year
#
#     breakdown = PricingEngine.calculate(
#         insurance_type=ins_type_str,
#         coverage_amount=policy.coverage_amount,
#         term_years=policy.term_years,
#         base_rate=base_rate,
#         smoker_factor=smoker_factor,
#         loading_pct=0.0,
#         is_smoker=is_smoker,
#         age_index=age_index,
#     )
#
#     try:
#         # Close the current version
#         curr_ver_res = await session.exec(
#             select(PolicyVersion).where(PolicyVersion.policy_id == policy_id)
#             .order_by(PolicyVersion.created_at.desc())  # type: ignore[arg-type]
#         )
#         curr_ver = curr_ver_res.first()
#         if curr_ver and curr_ver.effective_to is None:
#             curr_ver.effective_to = policy.expiry_date or date.today()
#             session.add(curr_ver)
#
#         curr_vnum = curr_ver.version_number if curr_ver else "1.0"
#         new_vnum = f"{int(curr_vnum.split('.')[0]) + 1}.0"
#         old_expiry = policy.expiry_date or date.today()
#         new_expiry = date(old_expiry.year + 1, old_expiry.month, old_expiry.day)
#         new_grace = new_expiry + timedelta(days=GRACE_PERIOD_DAYS)
#
#         new_version = PolicyVersion(
#             policy_id=policy_id,
#             version_number=new_vnum,
#             effective_from=old_expiry,
#             effective_to=None,
#             base_premium=breakdown.base_premium,
#             loading_amount=breakdown.loading_amount,
#             policy_fee=breakdown.policy_fee,
#             tax_amount=breakdown.tax_amount,
#             total_premium=breakdown.total_premium,
#             loadings_json={"rating_basis": breakdown.rating_basis, "age_index": round(age_index, 4)},
#             created_by="system" if is_stp else "underwriter",
#             event_type="Renewal",
#         )
#         session.add(new_version)
#         await session.flush()
#
#         session.add(RenewalTransaction(
#             policy_id=policy_id,
#             old_version_id=curr_ver.id if curr_ver else None,
#             new_version_id=new_version.id,
#             renewal_year=renewal_year,
#             status=RenewalStatusEnum.BOUND,
#             renewal_premium=breakdown.total_premium,
#             claims_count=claims_count,
#             is_stp=is_stp,
#             bound_at=datetime.utcnow(),
#         ))
#         session.add(PremiumSchedule(
#             policy_id=policy_id,
#             policy_version_id=new_version.id,
#             billing_frequency=BillingFrequencyEnum.ANNUAL,
#             due_date=old_expiry,
#             amount_due=breakdown.total_premium,
#             amount_paid=breakdown.total_premium,
#             status=PremiumScheduleStatusEnum.PAID,
#             paid_at=datetime.utcnow(),
#             payment_reference=f"MOCK-RENEWAL-Y{renewal_year}",
#         ))
#
#         policy.expiry_date = new_expiry
#         policy.grace_period_end_date = new_grace
#         policy.current_version_id = new_version.id
#
#         # Rebind cover for the new term (ACTIVE self-transition, or GRACE→ACTIVE).
#         event = apply_transition(
#             session, policy, PolicyStatusEnum.ACTIVE,
#             event_type="PolicyRenewed",
#             actor="system" if is_stp else "underwriter",
#             detail={
#                 "renewal_year": renewal_year,
#                 "new_version": new_vnum,
#                 "renewal_premium": breakdown.total_premium,
#                 "is_stp": is_stp,
#             },
#         )
#         await session.commit()
#
#     except IllegalStateTransition as exc:
#         await session.rollback()
#         raise HTTPException(400, str(exc)) from exc
#     except Exception as exc:
#         await session.rollback()
#         log.exception("Renewal failed for policy %s — rolled back", policy_id)
#         raise HTTPException(500, f"Renewal failed and was rolled back: {exc}") from exc
#
#     await _publish_policy_event(request, policy, event)
#
#     return {
#         "policy_number": policy.policy_number,
#         "new_version": new_vnum,
#         "renewal_year": renewal_year,
#         "new_expiry_date": new_expiry.isoformat(),
#         "renewal_premium": breakdown.total_premium,
#         "is_stp": is_stp,
#         "claims_during_term": claims_count,
#         "age_index_applied": round(age_index, 4),
#     }
#
#
# # ── POST /lapse ───────────────────────────────────────────────────────────────
#
# @router.post("/tenants/{tenant_id}/policies/{policy_id}/lapse")
# async def lapse_policy(
#     tenant_id: UUID, policy_id: UUID,
#     request: Request,
#     session: AsyncSession = Depends(get_session),
# ):
#     policy = await _get_policy(session, tenant_id, policy_id)
#     try:
#         event = apply_transition(
#             session, policy, PolicyStatusEnum.LAPSED,
#             event_type="PolicyLapsed", actor="system",
#         )
#         await session.commit()
#     except IllegalStateTransition as exc:
#         await session.rollback()
#         raise HTTPException(400, str(exc)) from exc
#     await _publish_policy_event(request, policy, event)
#     return {"policy_id": str(policy_id), "status": "Lapsed"}
#
#
# # ── POST /cancel ──────────────────────────────────────────────────────────────
#
# @router.post("/tenants/{tenant_id}/policies/{policy_id}/cancel")
# async def cancel_policy(
#     tenant_id: UUID, policy_id: UUID,
#     request: Request,
#     session: AsyncSession = Depends(get_session),
# ):
#     policy = await _get_policy(session, tenant_id, policy_id)
#     try:
#         event = apply_transition(
#             session, policy, PolicyStatusEnum.CANCELLED,
#             event_type="PolicyCancelled", actor="system",
#         )
#         await session.commit()
#     except IllegalStateTransition as exc:
#         await session.rollback()
#         raise HTTPException(400, str(exc)) from exc
#     await _publish_policy_event(request, policy, event)
#     return {"policy_id": str(policy_id), "status": "Cancelled"}


# ── GET /documents ────────────────────────────────────────────────────────────

@router.get("/tenants/{tenant_id}/policies/{policy_id}/documents")
async def list_policy_documents(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    await _get_policy(session, tenant_id, policy_id)
    result = await session.exec(select(PolicyDocument).where(PolicyDocument.policy_id == policy_id))
    return [
        {
            "id": str(d.id),
            "document_type": d.document_type.value if hasattr(d.document_type, "value") else str(d.document_type),
            "document_name": d.document_name,
            "is_stub": d.is_stub,
            "stub_content": d.stub_content,
            "generated_at": d.generated_at.isoformat(),
        }
        for d in result.all()
    ]


# ── GET /events (lifecycle audit trail) ───────────────────────────────────────

@router.get("/tenants/{tenant_id}/policies/{policy_id}/events")
async def list_policy_events(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    await _get_policy(session, tenant_id, policy_id)
    result = await session.exec(
        select(PolicyEvent)
        .where(PolicyEvent.policy_id == policy_id)
        .order_by(PolicyEvent.created_at.asc())  # type: ignore[arg-type]
    )
    return [
        {
            "id": str(e.id),
            "event_type": e.event_type,
            "from_status": e.from_status,
            "to_status": e.to_status,
            "actor": e.actor,
            "detail": e.detail_json,
            "created_at": e.created_at.isoformat(),
        }
        for e in result.all()
    ]
