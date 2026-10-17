"""Changing the plan on a proposal that is already in pre-underwriting.

A plan change is not just an edit: the premium, the documents required and several pre-underwriting steps were all
worked out for the old plan. This module validates the new plan, previews exactly what it will affect, and applies the
change as one transaction:

  * the policy takes the new plan, cover and term, and its premium is re-priced;
  * the documents the plan requires are re-derived (and the customer's upload link follows);
  * steps that depended on the old plan or cover are reset, so they are redone on the new one: the AI assessment (kept
    as history, marked superseded), the insurance-history screen, a medical assessment that has not been acted on,
    and an initial premium payment that has not been collected;
  * steps about the person rather than the plan are left alone: PEP/sanctions, the agent's report, the e-application.

It refuses once the plan can no longer move: a decision has been made, or the initial premium has been paid.
"""

import logging
from datetime import date, datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import HTTPException
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from services import document_requests as docreq
from shared.models.core import (
    Case,
    CaseAuditTrail,
    Customer,
    InitialPremiumPayment,
    InsuranceHistoryCheck,
    InsurancePlan,
    IPPStatusEnum,
    MedicalExamOrder,
    Policy,
    PolicyEvent,
    PremiumQuote,
    RiskAssessment,
    User,
)
from shared.pricing.calculator import calculate_premium

log = logging.getLogger(__name__)

# By enum value, so this does not depend on the Python member names.
_POLICY_CAN_CHANGE = {"Quoted", "Proposed", "UnderReview", "InformationRequested"}
_CASE_DECIDED = {"Approved", "Rejected", "Closed"}
_MEDICAL_RESETTABLE = {"NotRequired", "Required", "Expired"}      # nothing booked: reassess from scratch
_MEDICAL_BOOKED = {"Invited", "Scheduled"}                        # a clinic or customer is already involved
_MEDICAL_FINAL = {"Completed", "Waived"}                          # a result or a waiver on file stays


def _v(value: Any) -> str:
    return getattr(value, "value", str(value))


def _age(customer: Customer) -> Optional[int]:
    return (date.today() - customer.dob).days // 365 if customer.dob else None


def _money(n: float) -> str:
    return f"PKR {n:,.0f}"


def _describe(plan_label: str, coverage: float, term: int) -> str:
    return f"{plan_label} · {_money(coverage)} · {term} yrs"


def _validate(plan: InsurancePlan, customer: Customer, coverage: float, term: int, dep_name: Optional[str], dep_dob: Optional[date]) -> List[str]:
    """The same rules /quote applies when a plan is first chosen."""
    errors: List[str] = []
    if coverage <= 0:
        errors.append("Coverage amount must be greater than zero.")
    age = _age(customer)
    if age is not None and (age < plan.entry_age_min or age > plan.entry_age_max):
        errors.append(f"The customer's age ({age}) is outside this plan's entry ages ({plan.entry_age_min}–{plan.entry_age_max}).")
    if term < plan.term_min_years or term > plan.term_max_years:
        errors.append(f"The term must be between {plan.term_min_years} and {plan.term_max_years} years.")
    if age is not None and age + term > plan.max_maturity_age:
        errors.append(f"The policy would mature at age {age + term}, above this plan's maximum of {plan.max_maturity_age}.")
    income = customer.declared_income or 0
    if income > 0 and plan.max_income_multiple and coverage > income * plan.max_income_multiple:
        errors.append(f"Coverage is above {plan.max_income_multiple:g}× the declared annual income ({_money(income * plan.max_income_multiple)}).")
    if _v(plan.insurance_type) == "CHILD_EDUCATION_MARRIAGE":
        if not (dep_name or "").strip():
            errors.append("This plan needs the child's name.")
        if dep_dob and plan.dependent_age_min is not None and plan.dependent_age_max is not None:
            dep_age = (date.today() - dep_dob).days // 365
            if dep_age < plan.dependent_age_min or dep_age > plan.dependent_age_max:
                errors.append(f"The child's age ({dep_age}) must be between {plan.dependent_age_min} and {plan.dependent_age_max}.")
    return errors


def _premium(plan: InsurancePlan, customer: Customer, coverage: float) -> Optional[float]:
    age = _age(customer)
    if age is None:
        return None
    breakdown = calculate_premium(
        coverage_amount=coverage,
        base_premium_rate=plan.base_premium_rate,
        smoker_factor=plan.smoker_factor,
        age=age,
        is_smoker=customer.is_smoker or False,
        height_cm=customer.height_cm or 170.0,
        weight_kg=customer.weight_kg or 70.0,
    )
    return breakdown.total_premium


async def _rows(session: AsyncSession, case: Case) -> Dict[str, Any]:
    return {
        "assessments": list((await session.exec(
            select(RiskAssessment).where(RiskAssessment.case_id == case.caseld, RiskAssessment.superseded_at.is_(None))
        )).all()),
        "history": (await session.exec(select(InsuranceHistoryCheck).where(InsuranceHistoryCheck.case_id == case.caseld))).first(),
        "medical": (await session.exec(select(MedicalExamOrder).where(MedicalExamOrder.case_id == case.caseld))).first(),
        "ipp": (await session.exec(select(InitialPremiumPayment).where(InitialPremiumPayment.case_id == case.caseld))).first(),
    }


def _effects(rows: Dict[str, Any]) -> Dict[str, List[Any]]:
    """What the change will redo, what it leaves alone, and what a person still has to look at."""
    resets: List[Dict[str, str]] = []
    keeps: List[str] = ["PEP & sanctions screening", "Agent's confidential report", "E-application answers"]
    review: List[Dict[str, str]] = []

    if rows["assessments"]:
        resets.append({"label": "AI risk assessment", "detail": "The earlier run stays on record as history. Run AI underwriting again on the new plan."})
    history = rows["history"]
    if history is not None and _v(history.status) != "NotStarted":
        resets.append({"label": "Insurance history screening", "detail": "The sum assured changed, so the over-insurance check must be run again."})
    medical = rows["medical"]
    if medical is not None:
        status = _v(medical.status)
        if status in _MEDICAL_RESETTABLE:
            resets.append({"label": "Medical assessment", "detail": "The exam requirement depends on the cover, so it will be assessed again."})
        elif status in _MEDICAL_BOOKED:
            review.append({"label": "Medical exam already arranged", "detail": "Check whether the booked exam is still the right one for the new cover."})
        elif status in _MEDICAL_FINAL:
            keeps.append("Medical exam result on file")
    if rows["ipp"] is not None:
        resets.append({"label": "Initial premium payment", "detail": "The amount is updated to the new premium. Nothing has been collected yet."})
    return {"resets": resets, "keeps": keeps, "review": review}


async def run(session: AsyncSession, tenant_id: UUID, case_id: UUID, body: Any, user: User) -> Dict[str, Any]:
    case = await session.get(Case, case_id)
    if case is None or case.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Case not found.")
    policy = await session.get(Policy, case.policy_id) if case.policy_id else None
    if policy is None or policy.tenant_id != tenant_id:
        raise HTTPException(status_code=409, detail="This case has no proposal to change the plan of.")
    if getattr(policy, "master_policy_id", None) or getattr(policy, "family_policy_id", None):
        raise HTTPException(status_code=409, detail="Group and family proposals are changed from their own screens.")
    if _v(case.caseStatus) in _CASE_DECIDED:
        raise HTTPException(status_code=409, detail=f"This case is already {_v(case.caseStatus).lower()}, so its plan can no longer be changed.")
    if _v(policy.status) not in _POLICY_CAN_CHANGE:
        raise HTTPException(status_code=409, detail=f"The proposal is {_v(policy.status)}, so its plan can no longer be changed.")

    rows = await _rows(session, case)
    ipp = rows["ipp"]
    if ipp is not None and _v(ipp.status) == "Realized":
        raise HTTPException(
            status_code=409,
            detail="The initial premium has already been collected for the current plan. Changing the plan now needs a refund or adjustment from finance.",
        )

    plan = await session.get(InsurancePlan, body.plan_id)
    if plan is None or plan.tenant_id != tenant_id or _v(plan.status) != "Active":
        raise HTTPException(status_code=404, detail="That plan is not available.")
    if _v(plan.category) != "Individual":
        raise HTTPException(status_code=409, detail="Only individual plans can be chosen here.")
    if plan.label == policy.product_name and body.coverage_amount == policy.coverage_amount and body.term_years == policy.term_years:
        raise HTTPException(status_code=400, detail="Nothing to change: that is already the plan, cover and term.")

    customer = await session.get(Customer, policy.customer_id)
    if customer is None:
        raise HTTPException(status_code=404, detail="Customer not found.")
    errors = _validate(plan, customer, body.coverage_amount, body.term_years, body.dependent_name, body.dependent_dob)
    if errors:
        raise HTTPException(status_code=422, detail=" ".join(errors))

    # ── Impact, the same for a preview and for the real thing ────────────────
    old_quote = (await session.exec(select(PremiumQuote).where(PremiumQuote.policy_id == policy.id))).first()
    old_premium = old_quote.total_premium if old_quote is not None else None
    new_premium = _premium(plan, customer, body.coverage_amount)

    old_docs = await docreq.required_documents_for(session, policy)
    new_docs = docreq.required_documents_from_plan(plan, plan.insurance_type)
    result: Dict[str, Any] = {
        "plan": {"from": policy.product_name, "to": plan.label},
        "coverage": {"from": policy.coverage_amount, "to": body.coverage_amount},
        "term": {"from": policy.term_years, "to": body.term_years},
        "premium": {"from": old_premium, "to": new_premium},
        "documents": {
            "added": [d for d in new_docs if d not in old_docs],
            "removed": [d for d in old_docs if d not in new_docs],
            "kept": [d for d in new_docs if d in old_docs],
        },
        **_effects(rows),
    }
    if body.dry_run:
        return {"dry_run": True, "applied": False, **result}

    reason = (body.reason or "").strip()
    if len(reason) < 5:
        raise HTTPException(status_code=422, detail="Give a reason for changing the plan (at least 5 characters).")

    # ── Apply: one transaction ───────────────────────────────────────────────
    now = datetime.utcnow()
    before = _describe(policy.product_name, policy.coverage_amount, policy.term_years)
    before_snapshot = {
        "plan": policy.product_name, "insurance_type": _v(policy.insurance_type),
        "coverage_amount": policy.coverage_amount, "term_years": policy.term_years, "premium": old_premium,
    }

    is_child_plan = _v(plan.insurance_type) == "CHILD_EDUCATION_MARRIAGE"
    policy.product_name = plan.label
    policy.insurance_type = plan.insurance_type
    policy.coverage_amount = body.coverage_amount
    policy.term_years = body.term_years
    policy.dependent_name = ((body.dependent_name or "").strip() or None) if is_child_plan else None
    policy.dependent_dob = body.dependent_dob if is_child_plan else None
    session.add(policy)
    await session.flush()

    from routers.customers import sync_policy_premium_quote   # imported here: that router imports this package
    await sync_policy_premium_quote(policy, customer, session)

    for assessment in rows["assessments"]:
        assessment.superseded_at = now
        assessment.superseded_reason = f"Plan changed to {plan.label}: {reason}"
        session.add(assessment)

    history = rows["history"]
    if history is not None and _v(history.status) != "NotStarted":
        await session.delete(history)

    medical = rows["medical"]
    if medical is not None and _v(medical.status) in _MEDICAL_RESETTABLE:
        await session.delete(medical)

    if ipp is not None:
        if new_premium is not None:
            ipp.amount = new_premium
        if _v(ipp.status) != "NotStarted":      # Initiated or Failed: start the collection again at the new amount
            ipp.status = IPPStatusEnum.NOT_STARTED
            ipp.method = None
            ipp.reference = None
            ipp.initiated_at = None
        ipp.updated_at = now
        session.add(ipp)

    after = _describe(plan.label, body.coverage_amount, body.term_years)
    session.add(PolicyEvent(
        tenant_id=tenant_id,
        policy_id=policy.id,
        event_type="PlanChanged",
        from_status=_v(policy.status),
        to_status=_v(policy.status),
        actor=str(user.id),
        detail_json={
            "from": before_snapshot,
            "to": {
                "plan": plan.label, "insurance_type": _v(plan.insurance_type),
                "coverage_amount": body.coverage_amount, "term_years": body.term_years, "premium": new_premium,
            },
            "reason": reason,
            "case_id": str(case.caseld),
        },
    ))
    session.add(CaseAuditTrail(
        caseld=case.caseld,
        actionPerformed="Plan changed",
        entityChanged="Policy",
        previousValue=before,
        newValue=f"{after} — {reason}",
        performedBy=user.id,
        timestamp=now,
    ))
    case.updatedAt = now
    session.add(case)
    await session.commit()

    # Best-effort follow-ups: the plan change itself is already saved.
    try:
        await session.refresh(policy)
        await docreq.ensure_document_request(session, policy)        # the customer's upload link follows the new plan
    except Exception:
        log.exception("could not refresh the document request after a plan change on policy %s", policy.id)
    try:
        from services import underwriting_gate
        await underwriting_gate.compute_requirements(session, case.tenant_id, case)
    except Exception:
        log.exception("could not recompute requirements after a plan change on case %s", case.caseld)

    return {"dry_run": False, "applied": True, **result}
