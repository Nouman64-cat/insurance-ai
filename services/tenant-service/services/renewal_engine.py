"""
Stage B renewal engine — cycle planning, eligibility, risk evaluation,
reconciliation and the stage projection for Step 7 (Policy Renewals).

Two processes live here and must never be mixed:

  PremiumRenewal   collect the next scheduled premium of a policy that simply
                   continues (Individual, Family). Paying year 2 of a 20-year
                   policy does NOT renew the contract. Risk evaluation and
                   acceptance are skipped unless the product requires them.
  ContractRenewal  renew cover for another contractual term (eligible annually
                   renewable products). Needs risk evaluation (STP or referral)
                   and the customer's acceptance of the renewed terms.
                   Group Life renews at master-policy level elsewhere
                   (services/group_renewal.py) and is only *pointed to* here.

Router-free like billing_gate / reinstatement_engine: the pure functions take
plain facts so they unit-test without a database; the thin async wrappers gather
those facts. The router owns commits, PolicyEvent audit rows and Kafka publish.
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta
from typing import Optional
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from services import insurer_config
from services.billing_gate import _row_state, surcharge_for
from services.underwriting_limits import age_from_dob
from shared.models.core import (
    Claim,
    ClaimStatusEnum,
    Customer,
    Policy,
    PolicyRenewal,
    PolicyStatusEnum,
    PolicyVersion,
    PremiumSchedule,
    PremiumScheduleStatusEnum,
)

OPEN_STATUSES = ("Open", "Referred")
CLOSED_STATUSES = ("Completed", "Declined", "Cancelled")

PREMIUM = "PremiumRenewal"
CONTRACT = "ContractRenewal"
TYPE_LABELS = {PREMIUM: "Premium Renewal", CONTRACT: "Contract Renewal"}

_MONTHS_PER_PERIOD = {"Annual": 12, "SemiAnnual": 6, "Quarterly": 3, "Monthly": 1}
_PERIODS_PER_YEAR = {"Annual": 1, "SemiAnnual": 2, "Quarterly": 4, "Monthly": 12}

_OPEN_CLAIM_STATUSES = frozenset({
    ClaimStatusEnum.NEW, ClaimStatusEnum.TRIAGED, ClaimStatusEnum.UNDER_INVESTIGATION,
    ClaimStatusEnum.PENDING_DOCUMENTS, ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL,
    ClaimStatusEnum.REFERRED_TO_MANAGER, ClaimStatusEnum.REINSURANCE_REFERRED,
    ClaimStatusEnum.REUNDERWRITING_REQUIRED,
})

IN_FORCE = (PolicyStatusEnum.ACTIVE.value, PolicyStatusEnum.GRACE_PERIOD.value)


def _v(x) -> str:
    return x.value if hasattr(x, "value") else str(x)


# ══════════════════════════════════════════════════════════════════════════════
# 1. Dates + cycle planning (step 1 — "Identify upcoming renewals")
# ══════════════════════════════════════════════════════════════════════════════

def add_months(d: date, months: int) -> date:
    """Calendar-month arithmetic that clamps the day (31 Jan + 1 month → 28/29 Feb)."""
    total = d.year * 12 + (d.month - 1) + months
    year, month = divmod(total, 12)
    return date(year, month + 1, min(d.day, calendar.monthrange(year, month + 1)[1]))


def add_years(d: date, years: int) -> date:
    return add_months(d, 12 * years)


def plan_premium_cycle(
    *, rows: list, effective_date: Optional[date], maturity_date: Optional[date],
    annual_premium: float, today: date,
) -> Optional[dict]:
    """The next premium due on the policy.

    If an instalment is already unpaid in the ledger, that is the cycle (it is
    "in the ledger"). Otherwise the next one is generated: the first date on the
    policy's own frequency grid that falls after the last instalment — unless it
    would land on/after maturity, in which case the premium-paying term is done.

    Returns None when there is no ledger to plan from, or
    {"term_complete": True} when nothing further falls due.
    """
    rows = [r for r in rows if _v(r.status) != PremiumScheduleStatusEnum.WAIVED.value] or list(rows)
    if not rows:
        return None

    unpaid = sorted(
        (r for r in rows if _v(r.status) in (PremiumScheduleStatusEnum.PENDING.value,
                                             PremiumScheduleStatusEnum.OVERDUE.value)),
        key=lambda r: (r.due_date, r.installment_no),
    )
    if unpaid:
        r = unpaid[0]
        return {
            "due_date": r.due_date, "in_ledger": True, "schedule_id": r.id,
            "frequency": _v(r.billing_frequency), "installment_no": r.installment_no,
            "amount": round(max(r.amount_due - r.amount_paid, 0.0), 2), "term_complete": False,
        }

    last = max(rows, key=lambda r: (r.due_date, r.installment_no))
    freq = _v(last.billing_frequency)
    step = _MONTHS_PER_PERIOD.get(freq, 12)
    anchor = effective_date or last.due_date
    # Walk the policy's frequency grid; skip grid points that are really the row
    # we already have (the seeded year uses 365//n-day spacing, so a grid point can
    # land a day or two after its seeded twin).
    tolerance = timedelta(days=max(step * 30 // 2, 7))
    j = 1
    due = add_months(anchor, step * j)
    while due <= last.due_date + tolerance:
        j += 1
        due = add_months(anchor, step * j)

    if maturity_date and due >= maturity_date:
        return {"term_complete": True}
    per = _PERIODS_PER_YEAR.get(freq, 1)
    return {
        "due_date": due, "in_ledger": False, "schedule_id": None, "frequency": freq,
        "installment_no": last.installment_no + 1,
        "amount": round(annual_premium / per, 2), "term_complete": False,
    }


def current_period_end(effective_date: Optional[date], rules: dict, completed_period_ends: list[date]) -> Optional[date]:
    """End of the contractual period currently running (ContractRenewal products)."""
    if completed_period_ends:
        return max(completed_period_ends)
    if effective_date is None:
        return None
    return add_years(effective_date, int(rules["renewal_term_years"]))


def classify_cycle(rules: dict, due_date: date, period_end: Optional[date]) -> str:
    """A cycle is a Contract Renewal only when the product renews as a contract AND
    the due date falls on/after the end of the current contractual period. Every
    other premium on such a product, and every premium on any other product, is a
    plain Premium Renewal."""
    if rules.get("contract_renewable") and period_end is not None and due_date >= period_end:
        return CONTRACT
    return PREMIUM


def timing(due_date: date, today: date, notice_days: int) -> dict:
    opens = due_date - timedelta(days=notice_days)
    days_until = (due_date - today).days
    if days_until < 0:
        state = "Overdue"
    elif today >= opens:
        state = "Due" if days_until == 0 else "InWindow"
    else:
        state = "Upcoming"
    return {"window_opens_on": opens, "days_until": days_until, "state": state}


# ══════════════════════════════════════════════════════════════════════════════
# 2. Eligibility (step 2 — "Verify eligibility")
# ══════════════════════════════════════════════════════════════════════════════

def check(key: str, label: str, passed: bool, detail: str, severity: str = "block") -> dict:
    return {"key": key, "label": label, "passed": passed, "detail": detail,
            "severity": "ok" if passed else severity}


def evaluate_eligibility_facts(
    *,
    status: str,
    renewal_type: str,
    due_date: Optional[date],
    today: date,
    maturity_date: Optional[date],
    is_group_certificate: bool,
    term_complete: bool,
    age_at_due: Optional[int],
    rules: dict,
    open_claims: int = 0,
    fatal_claims: int = 0,
    coverage_amount: float = 0.0,
    active_case_no: Optional[str] = None,
) -> dict:
    """Pure eligibility decision.

    outcome: eligible | resume | blocked | use_reinstatement | group_scheme | term_complete
    """
    def done(outcome: str, message: str, checks: list[dict]) -> dict:
        return {"outcome": outcome, "eligible": outcome == "eligible", "message": message, "checks": checks,
                "blockers": [c for c in checks if c["severity"] == "block"],
                "reviews": [c for c in checks if c["severity"] == "review"]}

    if is_group_certificate:
        return done("group_scheme",
                    "This is a group-life certificate — it renews with its master policy, not individually.",
                    [check("scope", "Individual or family policy", False,
                           "Group certificates renew annually at master-policy level.", "info")])
    if status == PolicyStatusEnum.LAPSED.value:
        return done("use_reinstatement",
                    "The policy has lapsed — revive it through Reinstatement (Step 6) before any renewal.",
                    [check("status", "Policy in force", False, "Policy is Lapsed.", "info")])
    if status not in IN_FORCE:
        return done("blocked", f"Renewal applies to in-force policies only (current: {status}).",
                    [check("status", "Policy in force", False, f"Policy is '{status}'.")])
    if term_complete:
        return done("term_complete", "No further premium falls due — the policy term is complete.",
                    [check("term", "Premium-paying term still running", False,
                           "Every premium up to maturity has been scheduled.", "info")])

    checks = [check("status", "Policy in force", True,
                    "Policy is Active." if status == PolicyStatusEnum.ACTIVE.value
                    else "Policy is in its grace period — renewal collection will also revive it.")]
    if maturity_date and due_date:
        checks.append(check("term", "Within the policy term", due_date < maturity_date or renewal_type == CONTRACT,
                            f"Due {due_date.isoformat()}; policy matures {maturity_date.isoformat()}."))
    if renewal_type == CONTRACT:
        max_age = int(rules["max_renewal_age"])
        ok_age = age_at_due is not None and age_at_due <= max_age
        checks.append(check(
            "age_limit", "Within the product's maximum renewal age", ok_age,
            (f"Age {age_at_due} at renewal; the product renews up to age {max_age}." if age_at_due is not None
             else "Date of birth unknown — the renewal age limit cannot be verified.")))
    checks.append(check("coverage", "Cover in place", coverage_amount > 0,
                        f"Sum assured PKR {coverage_amount:,.0f}." if coverage_amount > 0 else "No sum assured on record."))
    has_fatal = fatal_claims > 0
    checks.append(check("fatal_claim", "No paid death claim", not has_fatal,
                        "A death claim has been settled on this policy." if has_fatal else "No settled death claim."))
    checks.append(check("open_claims", "No claim pending", open_claims == 0,
                        f"{open_claims} claim(s) open — the underwriter should look at them." if open_claims
                        else "No open claim.", "review"))
    checks.append(check("duplicate", "No other renewal in progress", active_case_no is None,
                        f"Renewal {active_case_no} is already open — resume it." if active_case_no
                        else "No renewal case is open."))

    blockers = [c for c in checks if c["severity"] == "block" and c["key"] != "duplicate"]
    if blockers:
        return done("blocked", blockers[0]["detail"], checks)
    if active_case_no:
        return done("resume", f"Renewal {active_case_no} is already open — resume it.", checks)
    return done("eligible", "The policy is eligible for renewal.", checks)


# ══════════════════════════════════════════════════════════════════════════════
# 3. Risk evaluation (step 4 — STP rules or referral)
# ══════════════════════════════════════════════════════════════════════════════

def risk_required(renewal_type: str, rules: dict) -> bool:
    """Ordinary premium renewals skip risk evaluation unless the product asks for it."""
    return renewal_type == CONTRACT or bool(rules.get("reassessment_required"))


def evaluate_risk(
    *, renewal_type: str, rules: dict, age_at_due: Optional[int], claims_in_period: int, open_claims: int,
) -> dict:
    """Straight-through-processing rules. Outcome NotRequired | STP | Referred.

    A referral never declines on its own — an underwriter decides."""
    if not risk_required(renewal_type, rules):
        return {"required": False, "outcome": "NotRequired", "reasons": [], "metrics": {}}

    reasons = []
    if claims_in_period > int(rules["stp_max_claims"]):
        reasons.append(f"{claims_in_period} claim(s) in the expiring period (STP allows {rules['stp_max_claims']}).")
    if open_claims:
        reasons.append(f"{open_claims} claim(s) still open.")
    if age_at_due is not None and age_at_due >= int(rules["reassess_from_age"]):
        reasons.append(f"Age {age_at_due} is at or above the reassessment age of {rules['reassess_from_age']}.")
    if rules.get("reassessment_required") and renewal_type != CONTRACT:
        reasons.append("The product requires reassessment at every renewal.")
    return {
        "required": True, "outcome": "Referred" if reasons else "STP", "reasons": reasons,
        "metrics": {"age": age_at_due, "claims_in_period": claims_in_period, "open_claims": open_claims,
                    "stp_max_claims": rules["stp_max_claims"], "reassess_from_age": rules["reassess_from_age"]},
    }


# ══════════════════════════════════════════════════════════════════════════════
# 4. Quote (contract renewals re-rate; premium renewals carry the instalment)
# ══════════════════════════════════════════════════════════════════════════════

def build_quote(
    *, current_annual: float, renewal_annual: float, loading_pct: float, frequency: str,
    period_start: Optional[date], period_end: Optional[date], rating_basis: str = "",
) -> dict:
    """Renewal premium = re-rated annual premium plus any underwriter loading on the
    base. The first instalment of the renewed period is what gets collected."""
    additional = round(renewal_annual * loading_pct / 100.0, 2)
    total = round(renewal_annual + additional, 2)
    per = _PERIODS_PER_YEAR.get(frequency, 1)
    return {
        "current_annual": round(current_annual, 2), "renewal_annual": round(renewal_annual, 2),
        "loading_pct": loading_pct, "additional_annual": additional, "new_annual": total,
        "change_pct": round((total - current_annual) / current_annual * 100, 1) if current_annual else None,
        "frequency": frequency, "instalment": round(total / per, 2),
        "period_start": period_start.isoformat() if period_start else None,
        "period_end": period_end.isoformat() if period_end else None,
        "rating_basis": rating_basis,
    }


# ══════════════════════════════════════════════════════════════════════════════
# 5. Reconciliation (step 6 — payment vs amount due)
# ══════════════════════════════════════════════════════════════════════════════

def reconcile_facts(
    *, expected: float, schedule_status: str, schedule_amount_due: float, schedule_amount_paid: float,
    schedule_reference: Optional[str], receipts: list[dict], accrual_statuses: list[str], policy_status: str,
) -> dict:
    """Reconcile what was actually received against what was due.

    `expected` is the instalment amount the case quoted. Each receipt dict carries
    base_amount / surcharge_amount / total_amount / payment_reference. Late-payment
    surcharge is explained variance, not an exception.
    """
    paid = schedule_status == PremiumScheduleStatusEnum.PAID.value
    base_received = round(sum(r["base_amount"] for r in receipts), 2)
    surcharge = round(sum(r["surcharge_amount"] for r in receipts), 2)
    total_received = round(sum(r["total_amount"] for r in receipts), 2)
    variance = round(base_received - expected, 2)
    refs = {r.get("payment_reference") for r in receipts if r.get("payment_reference")}

    checks = [
        check("paid", "Instalment settled in the ledger", paid,
              "The instalment is marked Paid." if paid else f"The instalment is {schedule_status}."),
        check("receipt", "One receipt issued", len(receipts) == 1,
              "Receipt issued." if len(receipts) == 1 else
              "No receipt has been issued." if not receipts else
              f"{len(receipts)} receipts exist for this instalment — part-payments, or a possible duplicate.",
              "block" if not receipts else "review"),
        check("amount", "Amount received matches amount due", abs(variance) < 0.01,
              f"Received PKR {base_received:,.2f} against PKR {expected:,.2f} due."
              + (f" Variance {variance:+,.2f}." if abs(variance) >= 0.01 else "")),
        check("reference", "Payment reference recorded",
              bool(schedule_reference) and (not refs or schedule_reference in refs),
              f"Reference {schedule_reference}." if schedule_reference else "No payment reference on the instalment."),
        check("in_force", "Policy in force", policy_status in IN_FORCE, f"Policy is {policy_status}."),
        check("commission", "Commission accrual posted", all(s == "POSTED" for s in accrual_statuses) and bool(accrual_statuses),
              "Commission accrued." if accrual_statuses and all(s == "POSTED" for s in accrual_statuses)
              else "Commission accrual needs attention in the earnings ledger.", "review"),
    ]
    blockers = [c for c in checks if c["severity"] == "block"]
    return {
        "status": "Matched" if not blockers else "Exception",
        "expected": round(expected, 2), "received": total_received, "base_received": base_received,
        "surcharge": surcharge, "variance": variance, "checks": checks,
        "reviews": [c for c in checks if c["severity"] == "review"],
        "checked_at": datetime.utcnow().isoformat(),
    }


# ══════════════════════════════════════════════════════════════════════════════
# 6. Stage projection (the processing tracker shown in the UI)
# ══════════════════════════════════════════════════════════════════════════════

def _stage(key: str, title: str, state: str, label: str, detail: str = "", covers: tuple = ()) -> dict:
    return {"key": key, "title": title, "state": state, "label": label, "detail": detail, "covers": list(covers)}


def project_stages(
    case: Optional[PolicyRenewal], *, live_eligibility: Optional[dict] = None,
    renewal_type: str = PREMIUM, schedule: Optional[PremiumSchedule] = None,
    risk_applies: bool = False, acceptance_applies: bool = False,
) -> list[dict]:
    """The renewal's processing rows. States: complete | pending | awaiting | action |
    exception | not_started | skipped. With no case yet, eligibility reflects the live
    check and everything else is waiting to begin."""
    eligible = bool(live_eligibility and live_eligibility.get("eligible")) or bool(case)
    elig = _stage("eligibility", "Eligibility verified",
                  "complete" if eligible else "exception",
                  "Complete" if eligible else "Not eligible",
                  (live_eligibility or {}).get("message", "") if not case else "Product terms, age limit, cover and policy status checked.",
                  (1, 2))
    if case is None:
        rows = [elig, _stage("notice", "Renewal notice", "pending", "Pending", covers=(3,))]
        if risk_applies:
            rows.append(_stage("risk", "Risk evaluation", "not_started", "Not started", covers=(4,)))
        if acceptance_applies:
            rows.append(_stage("acceptance", "Customer acceptance", "not_started", "Not started", covers=(5,)))
        rows += [_stage("collection", "Premium collection", "awaiting" if eligible else "not_started",
                        "Awaiting payment" if eligible else "Not started", covers=(6,)),
                 _stage("reconciliation", "Payment reconciliation", "not_started", "Not started", covers=(6,)),
                 _stage("confirmation", "Renewal confirmation", "not_started", "Not started", covers=(7, 8))]
        return rows

    closed = case.status in CLOSED_STATUSES and case.status != "Completed"
    paid = schedule is not None and _v(schedule.status) == PremiumScheduleStatusEnum.PAID.value
    partial = bool(schedule) and not paid and (schedule.amount_paid or 0) > 0

    rows = [elig]
    if case.notice_sent_at:
        rows.append(_stage("notice", "Renewal notice", "complete", "Sent",
                           f"{case.notice_channel} · {case.notice_count} sent"
                           + ("" if case.notice_delivered in (None, True) else " · not delivered"), (3,)))
    elif case.status in CLOSED_STATUSES:
        # Not a gate: the customer may pay before any notice goes out.
        rows.append(_stage("notice", "Renewal notice", "skipped", "Not sent", covers=(3,)))
    else:
        rows.append(_stage("notice", "Renewal notice", "pending", "Pending",
                           "Not sent yet — Adamjee issues it one month before the due date.", (3,)))

    risk_clear = True
    if case.risk_required:
        oc = case.risk_outcome
        if oc == "STP" or oc == "Approved":
            rows.append(_stage("risk", "Risk evaluation", "complete", "Cleared (STP)" if oc == "STP" else "Approved", covers=(4,)))
        elif oc == "Referred":
            risk_clear = False
            rows.append(_stage("risk", "Risk evaluation", "action", "Awaiting underwriting", covers=(4,)))
        elif oc == "Declined":
            risk_clear = False
            rows.append(_stage("risk", "Risk evaluation", "exception", "Declined", covers=(4,)))
        else:
            risk_clear = False
            rows.append(_stage("risk", "Risk evaluation", "pending", "Pending", covers=(4,)))
    if case.acceptance_required:
        if case.accepted_at:
            rows.append(_stage("acceptance", "Customer acceptance", "complete", "Accepted", covers=(5,)))
        elif closed:
            rows.append(_stage("acceptance", "Customer acceptance", "exception", "Declined", covers=(5,)))
        else:
            rows.append(_stage("acceptance", "Customer acceptance",
                               "awaiting" if risk_clear else "not_started",
                               "Awaiting acceptance" if risk_clear else "Not started", covers=(5,)))
    gate_open = risk_clear and (not case.acceptance_required or bool(case.accepted_at))

    if paid:
        rows.append(_stage("collection", "Premium collection", "complete", "Collected",
                           f"PKR {schedule.amount_paid:,.0f} · ref {schedule.payment_reference or '—'}", (6,)))
    elif closed:
        rows.append(_stage("collection", "Premium collection", "not_started", "Not collected", covers=(6,)))
    elif not gate_open:
        rows.append(_stage("collection", "Premium collection", "not_started", "Not started",
                           "Opens once risk is cleared and the terms are accepted.", (6,)))
    else:
        rows.append(_stage("collection", "Premium collection", "awaiting",
                           "Part-paid" if partial else "Awaiting payment", covers=(6,)))

    if case.reconciled_at:
        rows.append(_stage("reconciliation", "Payment reconciliation", "complete",
                           "Matched" if (case.reconciliation_json or {}).get("status") == "Matched" else "Reconciled (exception noted)",
                           covers=(6,)))
    elif (case.reconciliation_json or {}).get("status") == "Exception":
        rows.append(_stage("reconciliation", "Payment reconciliation", "exception", "Exception", covers=(6,)))
    elif paid:
        rows.append(_stage("reconciliation", "Payment reconciliation", "pending", "Ready to reconcile", covers=(6,)))
    else:
        rows.append(_stage("reconciliation", "Payment reconciliation", "not_started", "Not started", covers=(6,)))

    if case.status == "Completed":
        rows.append(_stage("confirmation", "Renewal confirmation", "complete" if case.confirmation_generated_at else "pending",
                           "Issued" if case.confirmation_generated_at else "Pending", covers=(7, 8)))
    elif case.reconciled_at:
        rows.append(_stage("confirmation", "Renewal confirmation", "pending", "Ready to complete", covers=(7, 8)))
    else:
        rows.append(_stage("confirmation", "Renewal confirmation", "not_started", "Not started", covers=(7, 8)))
    return rows


# ══════════════════════════════════════════════════════════════════════════════
# 7. Async fact gathering
# ══════════════════════════════════════════════════════════════════════════════

async def get_open_case(session: AsyncSession, policy_id: UUID) -> Optional[PolicyRenewal]:
    return (await session.exec(
        select(PolicyRenewal).where(PolicyRenewal.policy_id == policy_id,
                                    PolicyRenewal.status.in_(OPEN_STATUSES))  # type: ignore[attr-defined]
        .order_by(PolicyRenewal.created_at.desc())  # type: ignore[arg-type]
    )).first()


async def current_version(session: AsyncSession, policy: Policy) -> Optional[PolicyVersion]:
    if policy.current_version_id:
        v = await session.get(PolicyVersion, policy.current_version_id)
        if v:
            return v
    return (await session.exec(
        select(PolicyVersion).where(PolicyVersion.policy_id == policy.id)
        .order_by(PolicyVersion.created_at.desc())  # type: ignore[arg-type]
    )).first()


async def completed_period_ends(session: AsyncSession, policy_id: UUID) -> list[date]:
    rows = (await session.exec(select(PolicyRenewal).where(
        PolicyRenewal.policy_id == policy_id, PolicyRenewal.renewal_type == CONTRACT,
        PolicyRenewal.status == "Completed"))).all()
    return [r.period_end for r in rows if r.period_end]


async def claims_facts(session: AsyncSession, policy_id: UUID, since: Optional[date]) -> dict:
    claims = (await session.exec(select(Claim).where(Claim.policy_id == policy_id))).all()
    in_period = [c for c in claims if since is None or (c.reported_date and c.reported_date >= since)]
    return {
        "open": sum(1 for c in claims if c.status in _OPEN_CLAIM_STATUSES),
        "fatal": sum(1 for c in claims if c.status == ClaimStatusEnum.SETTLED and "death" in (c.claim_type or "").lower()),
        "in_period": len(in_period),
    }


async def applicant_age_on(session: AsyncSession, policy: Policy, on: Optional[date]) -> Optional[int]:
    customer = await session.get(Customer, policy.customer_id)
    return age_from_dob(customer.dob if customer else None, on)


async def plan_for_policy(session: AsyncSession, policy: Policy, today: Optional[date] = None) -> dict:
    """Everything the UI needs before a case exists: the rules, the planned cycle,
    its type, timing and live eligibility."""
    today = today or date.today()
    rules = insurer_config.renewal_rules(policy.product_name)
    status = _v(policy.status)
    rows = list((await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy.id))).all())
    version = await current_version(session, policy)
    annual = version.total_premium if version else sum(r.amount_due for r in rows)
    is_group = policy.master_policy_id is not None
    case = await get_open_case(session, policy.id)

    cycle = None if is_group else plan_premium_cycle(
        rows=rows, effective_date=policy.effective_date, maturity_date=policy.maturity_date,
        annual_premium=annual, today=today)
    term_complete = bool(cycle and cycle.get("term_complete"))
    due = cycle.get("due_date") if cycle and not term_complete else None

    period_end = current_period_end(policy.effective_date, rules, await completed_period_ends(session, policy.id)) \
        if rules.get("contract_renewable") else None
    rtype = classify_cycle(rules, due, period_end) if due else PREMIUM

    # A contract renewal is dated by the period boundary, not by the instalment.
    if rtype == CONTRACT and period_end:
        due = period_end

    claim_since = (period_end and add_years(period_end, -int(rules["renewal_term_years"]))) or policy.effective_date
    claims = await claims_facts(session, policy.id, claim_since)
    age = await applicant_age_on(session, policy, due)
    elig = evaluate_eligibility_facts(
        status=status, renewal_type=rtype, due_date=due, today=today, maturity_date=policy.maturity_date,
        is_group_certificate=is_group, term_complete=term_complete, age_at_due=age, rules=rules,
        open_claims=claims["open"], fatal_claims=claims["fatal"], coverage_amount=policy.coverage_amount,
        active_case_no=case.renewal_no if case else None,
    )
    tm = timing(due, today, int(rules["notice_days"])) if due else None
    schedule = next((r for r in rows if cycle and cycle.get("schedule_id") == r.id), None)
    surcharge = surcharge_for(schedule.amount_due, _row_state(schedule, today)) if schedule else 0.0
    return {
        "rules": rules, "renewal_type": rtype, "renewal_type_label": TYPE_LABELS[rtype],
        "cycle": cycle, "due_date": due, "period_end": period_end, "timing": tm,
        "amount": cycle.get("amount") if cycle and not term_complete else None,
        "surcharge": surcharge, "annual_premium": annual, "eligibility": elig,
        "claims": claims, "age_at_due": age, "open_case": case, "schedule": schedule, "rows": rows,
    }
