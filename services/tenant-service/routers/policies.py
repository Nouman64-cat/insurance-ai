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
from datetime import date, datetime, timedelta
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from services.pricing_engine import GRACE_PERIOD_DAYS, PricingEngine
from shared.models.core import (
    BillingFrequencyEnum,
    Claim,
    Customer,
    InsurancePlan,
    Policy,
    PolicyDocument,
    PolicyDocumentTypeEnum,
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
    year = datetime.utcnow().year
    result = await session.exec(
        select(Policy).where(
            Policy.tenant_id == tenant_id,
            Policy.policy_number.is_not(None),  # type: ignore[arg-type]
        )
    )
    count = len(list(result.all())) + 1
    return f"POL-{year}-{count:04d}"


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


def _make_stub_docs(policy_number: str, product_name: str) -> list[dict]:
    return [
        {"type": PolicyDocumentTypeEnum.SCHEDULE,    "name": f"Policy Schedule – {policy_number}"},
        {"type": PolicyDocumentTypeEnum.CERTIFICATE, "name": f"Certificate of Insurance – {policy_number}"},
        {"type": PolicyDocumentTypeEnum.WORDING,     "name": f"Policy Wording & Endorsements – {product_name}"},
    ]


# ── GET /stats ────────────────────────────────────────────────────────────────

@router.get("/tenants/{tenant_id}/policies/stats")
async def policy_stats(tenant_id: UUID, session: AsyncSession = Depends(get_session)):
    result = await session.exec(select(Policy).where(Policy.tenant_id == tenant_id))
    all_policies = list(result.all())
    today = date.today()
    return {
        "total": len(all_policies),
        "pending_issuance": sum(1 for p in all_policies if _st(p) in ("Approved", "AcceptedWithLoadings", "PendingPayment")),
        "active": sum(1 for p in all_policies if _st(p) == "Active"),
        "grace_period": sum(1 for p in all_policies if _st(p) == "GracePeriod"),
        "lapsed": sum(1 for p in all_policies if _st(p) == "Lapsed"),
        "expiring_30d": sum(
            1 for p in all_policies
            if _st(p) == "Active" and p.expiry_date and 0 <= (p.expiry_date - today).days <= 30
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
        st = _st(p)
        if st not in ("ACTIVE", "GRACE_PERIOD") or not p.expiry_date:
            continue
        days_left = (p.expiry_date - today).days
        if days_left > days:
            continue
        urgency = ("grace" if st == "GRACE_PERIOD" else
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
        "nominee_name": policy.nominee_name, "status": _st(policy),
        "effective_date": policy.effective_date.isoformat() if policy.effective_date else None,
        "expiry_date": policy.expiry_date.isoformat() if policy.expiry_date else None,
        "grace_period_end_date": policy.grace_period_end_date.isoformat() if policy.grace_period_end_date else None,
        "current_version_id": str(policy.current_version_id) if policy.current_version_id else None,
        "versions": versions, "premium_schedules": schedules,
        "renewal_transactions": renewals, "documents": documents,
        "created_at": policy.created_at.isoformat(),
    }


# ── POST /issue ───────────────────────────────────────────────────────────────
# Refinement 2: entire issuance wrapped in atomic BEGIN block.
# Refinement 1: pricing via PricingEngine.calculate() — no product logic in router.
# Refinement (Q2): APPROVED → PENDING_PAYMENT → ACTIVE (mock immediate settlement).

@router.post("/tenants/{tenant_id}/policies/{policy_id}/issue")
async def issue_policy(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    # ── Pre-flight checks (outside transaction — read-only) ──────────────────
    policy = await _get_policy(session, tenant_id, policy_id)
    status_val = _st(policy)
    if status_val not in ("Approved", "AcceptedWithLoadings", "Issued"):
        raise HTTPException(400, f"Policy must be Approved or AcceptedWithLoadings to issue (current: {status_val})")
    if policy.policy_number:
        raise HTTPException(400, "Policy already issued")

    cust = await session.get(Customer, policy.customer_id)
    is_smoker = bool(getattr(cust, "is_smoker", False))

    ra_res = await session.exec(
        select(RiskAssessment)
        .where(RiskAssessment.policy_id == policy_id)
        .order_by(RiskAssessment.created_at.desc())  # type: ignore[arg-type]
    )
    ra = ra_res.first()
    loading_pct = float(getattr(ra, "suggested_loading", 0) or 0)

    ins_type_str = policy.insurance_type.value if hasattr(policy.insurance_type, "value") else str(policy.insurance_type)
    base_rate, smoker_factor = await _load_plan_rates(session, tenant_id, policy.insurance_type)

    # ── Pricing (decoupled — Refinement 1) ──────────────────────────────────
    breakdown = PricingEngine.calculate(
        insurance_type=ins_type_str,
        coverage_amount=policy.coverage_amount,
        term_years=policy.term_years,
        base_rate=base_rate,
        smoker_factor=smoker_factor,
        loading_pct=loading_pct,
        is_smoker=is_smoker,
    )

    today = date.today()
    effective = policy.effective_date or today
    expiry = date(effective.year + policy.term_years, effective.month, effective.day)
    grace_end = expiry + timedelta(days=GRACE_PERIOD_DAYS)

    # ── Atomic transaction block (Refinement 2) ──────────────────────────────
    try:
        # Step 1: PENDING_PAYMENT intermediate state (Refinement Q2)
        policy.status = PolicyStatusEnum.PENDING_PAYMENT
        policy.updated_at = datetime.utcnow()
        session.add(policy)
        await session.flush()

        policy_number = await _next_policy_number(session, tenant_id)

        # Step 2: PolicyVersion 1.0 — immutable contract snapshot
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

        # Step 3: First premium schedule installment
        schedule = PremiumSchedule(
            policy_id=policy_id,
            policy_version_id=version.id,
            billing_frequency=BillingFrequencyEnum.ANNUAL,
            due_date=effective,
            amount_due=breakdown.total_premium,
            amount_paid=breakdown.total_premium,   # mock pay-to-bind
            status=PremiumScheduleStatusEnum.PAID,
            paid_at=datetime.utcnow(),
            payment_reference="MOCK-PAY-TO-BIND-v1",
        )
        session.add(schedule)

        # Step 4: Stub document records
        for doc_info in _make_stub_docs(policy_number, policy.product_name):
            session.add(PolicyDocument(
                policy_id=policy_id,
                policy_version_id=version.id,
                document_type=doc_info["type"],
                document_name=doc_info["name"],
                stub_content=f"[STUB] {doc_info['name']} — real PDF in Phase 2.",
                is_stub=True,
            ))

        # Step 5: PENDING_PAYMENT → ACTIVE (mock payment confirmed)
        policy.policy_number = policy_number
        policy.status = PolicyStatusEnum.ACTIVE
        policy.effective_date = effective
        policy.expiry_date = expiry
        policy.grace_period_end_date = grace_end
        policy.current_version_id = version.id
        policy.updated_at = datetime.utcnow()
        session.add(policy)

        # Step 6: Promote Customer to POLICYHOLDER
        customer = await session.get(Customer, policy.customer_id)
        if customer and customer.profile_status != ProfileStatusEnum.POLICYHOLDER:
            customer.profile_status = ProfileStatusEnum.POLICYHOLDER
            session.add(customer)


        # Step 6: Promote customer to POLICYHOLDER
        if cust:
            cust.profile_status = ProfileStatusEnum.POLICYHOLDER
            session.add(cust)

        await session.commit()

    except Exception as exc:
        await session.rollback()
        log.error("Issuance failed for policy %s — rolled back: %s", policy_id, exc, exc_info=True)
        raise HTTPException(500, f"Issuance failed and was rolled back: {exc}") from exc

    log.info("Policy issued: %s (%s) — premium PKR %.0f", policy_number, policy_id, breakdown.total_premium)
    return {
        "policy_number": policy_number,
        "status": "Active",
        "effective_date": effective.isoformat(),
        "expiry_date": expiry.isoformat(),
        "grace_period_end_date": grace_end.isoformat(),
        "premium_breakdown": breakdown.to_dict(),
        "version": "1.0",
        "documents_generated": 3,
        "grace_period_days": GRACE_PERIOD_DAYS,
    }


# ── POST /renew ───────────────────────────────────────────────────────────────

@router.post("/tenants/{tenant_id}/policies/{policy_id}/renew")
async def renew_policy(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    if _st(policy) not in ("Active", "GracePeriod"):
        raise HTTPException(400, f"Policy must be Active or GracePeriod to renew (current: {_st(policy)})")

    rt_all = list((await session.exec(select(RenewalTransaction).where(RenewalTransaction.policy_id == policy_id))).all())
    renewal_year = len(rt_all) + 2

    claims_count = len(list((await session.exec(select(Claim).where(Claim.policy_id == policy_id))).all()))
    is_stp = claims_count == 0

    cust = await session.get(Customer, policy.customer_id)
    is_smoker = bool(getattr(cust, "is_smoker", False))

    ins_type_str = policy.insurance_type.value if hasattr(policy.insurance_type, "value") else str(policy.insurance_type)
    base_rate, smoker_factor = await _load_plan_rates(session, tenant_id, policy.insurance_type)
    age_index = 1.02 ** (renewal_year - 1)   # +2% per renewal year

    breakdown = PricingEngine.calculate(
        insurance_type=ins_type_str,
        coverage_amount=policy.coverage_amount,
        term_years=policy.term_years,
        base_rate=base_rate,
        smoker_factor=smoker_factor,
        loading_pct=0.0,
        is_smoker=is_smoker,
        age_index=age_index,
    )

    try:
        # Close the current version
        curr_ver_res = await session.exec(
            select(PolicyVersion).where(PolicyVersion.policy_id == policy_id)
            .order_by(PolicyVersion.created_at.desc())  # type: ignore[arg-type]
        )
        curr_ver = curr_ver_res.first()
        if curr_ver and curr_ver.effective_to is None:
            curr_ver.effective_to = policy.expiry_date or date.today()
            session.add(curr_ver)

        curr_vnum = curr_ver.version_number if curr_ver else "1.0"
        new_vnum = f"{int(curr_vnum.split('.')[0]) + 1}.0"
        old_expiry = policy.expiry_date or date.today()
        new_expiry = date(old_expiry.year + 1, old_expiry.month, old_expiry.day)
        new_grace = new_expiry + timedelta(days=GRACE_PERIOD_DAYS)

        new_version = PolicyVersion(
            policy_id=policy_id,
            version_number=new_vnum,
            effective_from=old_expiry,
            effective_to=None,
            base_premium=breakdown.base_premium,
            loading_amount=breakdown.loading_amount,
            policy_fee=breakdown.policy_fee,
            tax_amount=breakdown.tax_amount,
            total_premium=breakdown.total_premium,
            loadings_json={"rating_basis": breakdown.rating_basis, "age_index": round(age_index, 4)},
            created_by="system" if is_stp else "underwriter",
            event_type="Renewal",
        )
        session.add(new_version)
        await session.flush()

        session.add(RenewalTransaction(
            policy_id=policy_id,
            old_version_id=curr_ver.id if curr_ver else None,
            new_version_id=new_version.id,
            renewal_year=renewal_year,
            status=RenewalStatusEnum.BOUND,
            renewal_premium=breakdown.total_premium,
            claims_count=claims_count,
            is_stp=is_stp,
            bound_at=datetime.utcnow(),
        ))
        session.add(PremiumSchedule(
            policy_id=policy_id,
            policy_version_id=new_version.id,
            billing_frequency=BillingFrequencyEnum.ANNUAL,
            due_date=old_expiry,
            amount_due=breakdown.total_premium,
            amount_paid=breakdown.total_premium,
            status=PremiumScheduleStatusEnum.PAID,
            paid_at=datetime.utcnow(),
            payment_reference=f"MOCK-RENEWAL-Y{renewal_year}",
        ))

        policy.status = PolicyStatusEnum.ACTIVE
        policy.expiry_date = new_expiry
        policy.grace_period_end_date = new_grace
        policy.current_version_id = new_version.id
        policy.updated_at = datetime.utcnow()
        session.add(policy)
        await session.commit()

    except Exception as exc:
        await session.rollback()
        log.error("Renewal failed for policy %s — rolled back: %s", policy_id, exc, exc_info=True)
        raise HTTPException(500, f"Renewal failed and was rolled back: {exc}") from exc

    return {
        "policy_number": policy.policy_number,
        "new_version": new_vnum,
        "renewal_year": renewal_year,
        "new_expiry_date": new_expiry.isoformat(),
        "renewal_premium": breakdown.total_premium,
        "is_stp": is_stp,
        "claims_during_term": claims_count,
        "age_index_applied": round(age_index, 4),
    }


# ── POST /lapse ───────────────────────────────────────────────────────────────

@router.post("/tenants/{tenant_id}/policies/{policy_id}/lapse")
async def lapse_policy(tenant_id: UUID, policy_id: UUID, session: AsyncSession = Depends(get_session)):
    policy = await _get_policy(session, tenant_id, policy_id)
    policy.status = PolicyStatusEnum.LAPSED
    policy.updated_at = datetime.utcnow()
    session.add(policy)
    await session.commit()
    return {"policy_id": str(policy_id), "status": "Lapsed"}


# ── POST /cancel ──────────────────────────────────────────────────────────────

@router.post("/tenants/{tenant_id}/policies/{policy_id}/cancel")
async def cancel_policy(tenant_id: UUID, policy_id: UUID, session: AsyncSession = Depends(get_session)):
    policy = await _get_policy(session, tenant_id, policy_id)
    policy.status = PolicyStatusEnum.CANCELLED
    policy.updated_at = datetime.utcnow()
    session.add(policy)
    await session.commit()
    return {"policy_id": str(policy_id), "status": "Cancelled"}


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
