"""
Stage B reinstatement engine — eligibility, arrears, underwriting assessment and
the 9-step workflow projection for reviving a lapsed policy.

Router-free (mirrors billing_gate / endorsement_engine): the pure functions here
take plain facts so they can be unit-tested without a database, and the thin
async wrappers gather those facts from the session. The router owns committing,
the PolicyEvent audit rows and the Kafka publish.

A reinstatement is NOT a new issuance. The original policy number and history are
preserved; a PolicyReinstatement case is attached to them. Paying the overdue
premium never reinstates on its own — underwriting must approve.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from services import insurer_config
from services.billing_gate import _row_state, surcharge_for
from services.pricing_engine import GRACE_PERIOD_DAYS
from services.underwriting_limits import age_from_dob, non_medical_limit
from shared.models.core import (
    Claim,
    ClaimStatusEnum,
    Customer,
    Policy,
    PolicyEvent,
    PolicyReinstatement,
    PolicyStatusEnum,
    PremiumSchedule,
    PremiumScheduleStatusEnum,
)

# A case in one of these statuses is "resumable" — never open a second one.
OPEN_STATUSES = ("Open", "EvidenceRequested", "TermsOffered", "Approved")
CLOSED_STATUSES = ("Reinstated", "Declined", "Withdrawn")

# Claims in these states mean an insured event is being, or has been, handled on
# this policy — reviving it underneath the claim is not a servicing decision.
_OPEN_CLAIM_STATUSES = frozenset({
    ClaimStatusEnum.NEW, ClaimStatusEnum.TRIAGED, ClaimStatusEnum.UNDER_INVESTIGATION,
    ClaimStatusEnum.PENDING_DOCUMENTS, ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL,
    ClaimStatusEnum.REFERRED_TO_MANAGER, ClaimStatusEnum.REINSURANCE_REFERRED,
    ClaimStatusEnum.REUNDERWRITING_REQUIRED,
})

# PolicyEvent types a future surrender flow is expected to write (Step 9). Until
# that flow exists nothing emits them, so this check passes — it is wired now so
# the block applies the moment surrenders start being recorded.
_SURRENDER_EVENT_TYPES = ("PolicySurrendered", "SurrenderRequested")

DECLINE_DECISIONS = ("Decline",)
APPROVING_DECISIONS = ("Approve", "ApproveWithTerms")


def _v(x) -> str:
    return x.value if hasattr(x, "value") else str(x)


# ══════════════════════════════════════════════════════════════════════════════
# 1. Eligibility (steps 1 — "Detect lapsed policy")
# ══════════════════════════════════════════════════════════════════════════════

def check(key: str, label: str, passed: bool, detail: str, severity: str = "block") -> dict:
    """One eligibility line. severity: block (hard stop) | review (needs a human) | info."""
    return {"key": key, "label": label, "passed": passed, "detail": detail,
            "severity": severity if not passed else "ok"}


_NOT_LAPSED_OUTCOMES = {
    PolicyStatusEnum.ACTIVE.value: (
        "not_required", "The policy is Active — no reinstatement is required.",
        "Policy is Active; cover is already in force.", "info"),
    PolicyStatusEnum.GRACE_PERIOD.value: (
        "use_collection",
        "The policy is still inside its grace period — collect the overdue premium in Premium Collection.",
        "Policy is in its grace period; clear the arrears through ordinary collection.", "info"),
    PolicyStatusEnum.CANCELLED.value: (
        "blocked",
        "A cancelled policy cannot be reinstated here — it needs a separately authorised restoration procedure.",
        "Policy is Cancelled; reinstatement is not available without a separately authorised procedure.", "block"),
}


def _window_check(lapse_date: Optional[date], days_lapsed: Optional[int], window_days: int,
                  window_ends: Optional[date]) -> dict:
    label = "Within the product's reinstatement window"
    if lapse_date is None or days_lapsed is None or window_ends is None:
        return check("window", label, True, f"Lapse date unknown; the {window_days}-day window cannot be verified.")
    if days_lapsed <= window_days:
        return check("window", label, True,
                     f"Lapsed {days_lapsed} day(s) ago; the {window_days}-day window closes {window_ends.isoformat()}.")
    return check("window", label, False,
                 f"Lapsed {days_lapsed} day(s) ago — beyond the {window_days}-day window that closed "
                 f"{window_ends.isoformat()}.")


def _term_check(end: Optional[date], today: date) -> dict:
    label = "Contract still running"
    if end and end < today:
        return check("contract_term", label, False, f"Contract ended on {end.isoformat()}; revival is no longer possible.")
    return check("contract_term", label, True,
                 f"Contract runs to {end.isoformat()}." if end else "No end date on record.")


def evaluate_eligibility_facts(
    *,
    status: str,
    today: date,
    lapse_date: Optional[date],
    rules: dict,
    expiry_date: Optional[date] = None,
    maturity_date: Optional[date] = None,
    open_claims: int = 0,
    fatal_claims: int = 0,
    surrender_events: int = 0,
    active_case_no: Optional[str] = None,
) -> dict:
    """Pure eligibility decision from plain facts.

    outcome:
      eligible       — a reinstatement case may be opened
      resume         — an open case already exists; resume it instead
      not_required   — policy is Active, nothing to reinstate
      use_collection — policy is in its grace period: ordinary premium collection
      blocked        — a hard rule stops the request
    """
    window_days = int(rules["window_days"])
    days_lapsed = (today - lapse_date).days if lapse_date else None
    window_ends = (lapse_date + timedelta(days=window_days)) if lapse_date else None

    base = {
        "policy_status": status,
        "lapse_date": lapse_date.isoformat() if lapse_date else None,
        "days_lapsed": days_lapsed,
        "window_days": window_days,
        "window_ends_on": window_ends.isoformat() if window_ends else None,
        "window_days_left": ((window_ends - today).days if window_ends else None),
    }

    def done(outcome: str, eligible: bool, message: str, checks: list[dict]) -> dict:
        return {**base, "outcome": outcome, "eligible": eligible, "message": message,
                "checks": checks, "blockers": [c for c in checks if c["severity"] == "block"],
                "reviews": [c for c in checks if c["severity"] == "review"]}

    status_label = "Policy status"
    if status in _NOT_LAPSED_OUTCOMES:
        outcome, message, detail, severity = _NOT_LAPSED_OUTCOMES[status]
        return done(outcome, False, message, [check("status", status_label, False, detail, severity)])
    if status != PolicyStatusEnum.LAPSED.value:
        return done("blocked", False, f"Reinstatement applies to lapsed policies only (current: {status}).",
                    [check("status", status_label, False, f"Policy is '{status}', not Lapsed.")])

    has_conflict = bool(open_claims or fatal_claims)
    checks = [
        check("status", status_label, True, "Policy is Lapsed — eligible for evaluation."),
        _term_check(maturity_date or expiry_date, today),
        _window_check(lapse_date, days_lapsed, window_days, window_ends),
        check("claims", "No conflicting claim", not has_conflict,
              "A claim is open or has been paid on this policy — refer to claims before any revival."
              if has_conflict else "No open or settled claim on this policy."),
        check("surrender", "No surrender in progress", surrender_events == 0,
              "A surrender is recorded against this policy." if surrender_events else "No surrender recorded."),
        check("duplicate", "No other reinstatement in progress", active_case_no is None,
              f"Case {active_case_no} is already open — resume it instead of starting another."
              if active_case_no else "No reinstatement case is open."),
    ]

    blockers = [c for c in checks if c["severity"] == "block" and c["key"] != "duplicate"]
    if blockers:
        return done("blocked", False, blockers[0]["detail"], checks)
    if active_case_no:
        return done("resume", False, f"Reinstatement case {active_case_no} is already open — resume it.", checks)
    return done("eligible", True, "The policy is eligible for a reinstatement request.", checks)


async def lapse_date_for(session: AsyncSession, policy: Policy) -> Optional[date]:
    """When the policy lapsed: the latest PolicyLapsed audit event, else the end of
    the grace window on the oldest unpaid instalment, else the last status change."""
    evt = (await session.exec(
        select(PolicyEvent)
        .where(PolicyEvent.policy_id == policy.id, PolicyEvent.event_type == "PolicyLapsed")
        .order_by(PolicyEvent.created_at.desc())  # type: ignore[arg-type]
    )).first()
    if evt:
        return evt.created_at.date()
    rows = (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy.id))).all()
    unpaid = [s for s in rows if _v(s.status) in
              (PremiumScheduleStatusEnum.PENDING.value, PremiumScheduleStatusEnum.OVERDUE.value)]
    if unpaid:
        return min(s.due_date for s in unpaid) + timedelta(days=GRACE_PERIOD_DAYS + 1)
    return policy.updated_at.date() if policy.updated_at else None


async def get_open_case(session: AsyncSession, policy_id: UUID) -> Optional[PolicyReinstatement]:
    return (await session.exec(
        select(PolicyReinstatement)
        .where(PolicyReinstatement.policy_id == policy_id,
               PolicyReinstatement.status.in_(OPEN_STATUSES))  # type: ignore[attr-defined]
        .order_by(PolicyReinstatement.created_at.desc())  # type: ignore[arg-type]
    )).first()


async def evaluate_eligibility(
    session: AsyncSession, policy: Policy, today: Optional[date] = None, ignore_case_id: Optional[UUID] = None,
) -> dict:
    """Gather the facts for `evaluate_eligibility_facts`. `ignore_case_id` lets an
    existing case re-check eligibility without tripping its own duplicate guard."""
    today = today or date.today()
    rules = insurer_config.reinstatement_rules(policy.product_name)

    claims = (await session.exec(select(Claim).where(Claim.policy_id == policy.id))).all()
    open_claims = sum(1 for c in claims if c.status in _OPEN_CLAIM_STATUSES)
    # A paid-out claim on a lapsed policy means the benefit is gone — not revivable.
    fatal_claims = sum(1 for c in claims
                       if c.status in (ClaimStatusEnum.SETTLED,)
                       and "death" in (c.claim_type or "").lower())

    surrenders = (await session.exec(
        select(PolicyEvent).where(PolicyEvent.policy_id == policy.id,
                                  PolicyEvent.event_type.in_(_SURRENDER_EVENT_TYPES))  # type: ignore[attr-defined]
    )).all()

    case = await get_open_case(session, policy.id)
    active_no = case.case_no if (case and case.id != ignore_case_id) else None

    status = _v(policy.status)
    lapse = await lapse_date_for(session, policy) if status == PolicyStatusEnum.LAPSED.value else None
    result = evaluate_eligibility_facts(
        status=status, today=today, lapse_date=lapse, rules=rules,
        expiry_date=policy.expiry_date, maturity_date=policy.maturity_date,
        open_claims=open_claims, fatal_claims=fatal_claims,
        surrender_events=len(surrenders), active_case_no=active_no,
    )
    result["rules"] = rules
    result["active_case_id"] = str(case.id) if case else None
    return result


# ══════════════════════════════════════════════════════════════════════════════
# 2. Arrears + authorised charges (step 3 — "Calculate arrears")
# ══════════════════════════════════════════════════════════════════════════════

def compute_arrears_lines(schedules: list, today: date, rules: dict) -> dict:
    """Unpaid premiums due on or before `today`, plus the charges the product
    authorises: the standing late-payment surcharge, optional simple interest, and
    an optional one-off reinstatement fee. Pure — takes the schedule rows.

    Every figure is frozen into the case at calculation time; payment settles
    exactly these lines.
    """
    interest_pct = float(rules.get("interest_pct_annual") or 0.0)
    fee = round(float(rules.get("fee_amount") or 0.0), 2)

    lines = []
    for s in sorted(schedules, key=lambda r: (r.due_date, r.installment_no)):
        if _v(s.status) not in (PremiumScheduleStatusEnum.PENDING.value, PremiumScheduleStatusEnum.OVERDUE.value):
            continue
        if s.due_date > today:
            continue
        outstanding = round(max(s.amount_due - s.amount_paid, 0.0), 2)
        if outstanding <= 0:
            continue
        days_overdue = max((today - s.due_date).days, 0)
        surcharge = surcharge_for(s.amount_due, _row_state(s, today))
        interest = round(outstanding * interest_pct / 100.0 * days_overdue / 365.0, 2) if interest_pct else 0.0
        lines.append({
            "schedule_id": str(s.id),
            "installment_no": s.installment_no,
            "due_date": s.due_date.isoformat(),
            "days_overdue": days_overdue,
            "premium": outstanding,
            "surcharge": surcharge,
            "interest": interest,
            "total": round(outstanding + surcharge + interest, 2),
        })

    premiums = round(sum(l["premium"] for l in lines), 2)
    surcharges = round(sum(l["surcharge"] for l in lines), 2)
    interest = round(sum(l["interest"] for l in lines), 2)
    return {
        "as_of": today.isoformat(),
        "lines": lines,
        "premiums": premiums,
        "surcharges": surcharges,
        "interest": interest,
        "fee": fee,
        "total": round(premiums + surcharges + interest + fee, 2),
    }


async def compute_arrears(session: AsyncSession, policy: Policy, rules: dict, today: Optional[date] = None) -> dict:
    rows = (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy.id))).all()
    return compute_arrears_lines(list(rows), today or date.today(), rules)


# ══════════════════════════════════════════════════════════════════════════════
# 3. Health declaration + underwriting assessment (steps 4–5)
# ══════════════════════════════════════════════════════════════════════════════

_RECOMMENDATION_RANK = {"StraightThrough": 0, "Review": 1, "EvidenceRequired": 2, "Refer": 3}

# Adverse answers → how serious, and which supporting document each one calls for.
_ANSWER_SEVERITY = {
    "good_health": "high", "hospitalised": "high", "new_condition": "high",
    "pending_tests": "high", "other_insurer_action": "high",
    "new_medication": "medium", "tobacco_change": "medium", "occupation_change": "medium",
}
_ANSWER_EVIDENCE = {
    "hospitalised": ("medical_records", "Discharge summary / medical records for the hospital stay or surgery", True),
    "new_condition": ("medical_records", "Medical records for the newly diagnosed condition", True),
    "pending_tests": ("medical_records", "Test results or specialist report for the pending investigation", True),
    "new_medication": ("medication_list", "Current prescription / medication list from the treating doctor", False),
    "occupation_change": ("occupation_details", "Occupation / hazardous-activity questionnaire", False),
    "other_insurer_action": ("insurer_letter", "Copy of the other insurer's decision letter", True),
}


def declaration_questions() -> list[dict]:
    return [dict(q) for q in insurer_config.REINSTATEMENT_DECLARATION_QUESTIONS]


def adverse_answers(declaration: Optional[dict]) -> list[str]:
    """Keys of the declaration answers that need underwriter attention."""
    answers = (declaration or {}).get("answers") or {}
    adverse = []
    for q in insurer_config.REINSTATEMENT_DECLARATION_QUESTIONS:
        if q["key"] in answers and bool(answers[q["key"]]) == q["adverse_if"]:
            adverse.append(q["key"])
    return adverse


def assess(
    *, declaration: Optional[dict], lapse_days: Optional[int], age: Optional[int],
    sum_assured: float, rules: dict,
) -> dict:
    """Evaluate what changed since issue: lapse duration, declared health/risk
    changes, and sum assured against the Non-Medical Limit for the applicant's age.

    This is a deterministic recommendation for the underwriter — it never approves
    or declines on its own.
    """
    flags: list[dict] = []
    evidence: dict[str, dict] = {}
    rec = "StraightThrough"

    def raise_to(level: str) -> None:
        nonlocal rec
        if _RECOMMENDATION_RANK[level] > _RECOMMENDATION_RANK[rec]:
            rec = level

    questions = {q["key"]: q for q in insurer_config.REINSTATEMENT_DECLARATION_QUESTIONS}
    details = (declaration or {}).get("details") or {}
    adverse = adverse_answers(declaration)

    for key in adverse:
        sev = _ANSWER_SEVERITY.get(key, "medium")
        note = (details.get(key) or "").strip()
        flags.append({
            "code": f"declared_{key}", "severity": sev,
            "message": questions[key]["text"] + (f" — “{note}”" if note else ""),
        })
        raise_to("Refer" if sev == "high" else "Review")
        if key in _ANSWER_EVIDENCE:
            ekey, label, required = _ANSWER_EVIDENCE[key]
            prior = evidence.get(ekey)
            evidence[ekey] = {"key": ekey, "label": label, "required": required or bool(prior and prior["required"]),
                              "reason": "Declared on the health declaration", "source": "assessment"}

    nml = non_medical_limit(age)
    over_nml = sum_assured > nml
    medical_days = int(rules["medical_evidence_days"])
    if lapse_days is not None and lapse_days > medical_days and over_nml:
        flags.append({
            "code": "medical_beyond_nml", "severity": "high",
            "message": (f"Lapsed {lapse_days} days (> {medical_days}) and sum assured PKR {sum_assured:,.0f} exceeds the "
                        f"Non-Medical Limit of PKR {nml:,.0f}"
                        + (f" for age {age}." if age is not None else " (age unknown — most conservative band).")),
        })
        evidence["medical_exam"] = {
            "key": "medical_exam", "label": "Medical examination at a panel clinic", "required": True,
            "reason": f"Lapse over {medical_days} days with cover above the Non-Medical Limit", "source": "assessment"}
        raise_to("EvidenceRequired")
    elif lapse_days is not None and lapse_days > int(rules["declaration_only_days"]):
        flags.append({
            "code": "extended_lapse", "severity": "info",
            "message": f"Lapsed {lapse_days} days — beyond the {rules['declaration_only_days']}-day declaration-only band; "
                       "underwriter discretion on further evidence.",
        })
        raise_to("Review")

    if "good_health" in adverse:
        summary = "The applicant did not confirm good health — refer to a senior underwriter; a decline is likely."
    elif rec == "Refer":
        summary = "Adverse health or risk changes were declared — refer for full underwriting review."
    elif rec == "EvidenceRequired":
        summary = "Supporting medical evidence is required before a decision."
    elif rec == "Review":
        summary = "No serious disclosures, but the underwriter should review before approving."
    else:
        summary = "Clean declaration within the declaration-only band — eligible for straight approval."

    return {
        "recommendation": rec,
        "summary": summary,
        "flags": flags,
        "evidence": list(evidence.values()),
        "metrics": {
            "lapse_days": lapse_days, "age": age, "sum_assured": sum_assured,
            "non_medical_limit": nml, "over_non_medical_limit": over_nml,
            "adverse_count": len(adverse),
        },
        "assessed_at": datetime.utcnow().isoformat(),
    }


async def applicant_age(session: AsyncSession, policy: Policy, today: Optional[date] = None) -> Optional[int]:
    customer = await session.get(Customer, policy.customer_id)
    return age_from_dob(customer.dob if customer else None, today)


def merge_evidence(existing: Optional[list], wanted: list[dict], now: Optional[datetime] = None) -> list[dict]:
    """Add evidence requests that are not already on the case; never drop or reset
    one that has been received."""
    now = now or datetime.utcnow()
    merged = [dict(e) for e in (existing or [])]
    have = {e["key"] for e in merged}
    for w in wanted:
        if w["key"] in have:
            continue
        merged.append({
            "key": w["key"], "label": w["label"], "reason": w.get("reason"),
            "required": bool(w.get("required", True)), "source": w.get("source", "assessment"),
            "status": "Requested", "requested_at": now.isoformat(),
            "received_at": None, "note": None, "file_name": None, "file_path": None,
        })
    return merged


def required_evidence_outstanding(evidence: Optional[list]) -> list[dict]:
    return [e for e in (evidence or []) if e.get("required") and e.get("status") != "Received"]


# ══════════════════════════════════════════════════════════════════════════════
# 4. Workflow projection (the 9 steps) + serialisation
# ══════════════════════════════════════════════════════════════════════════════

STEPS: list[tuple[str, str, str]] = [
    ("detect", "Detect lapsed policy", "Confirm the policy is lapsed and eligible"),
    ("request", "Create reinstatement request", "Register the case and identify the applicant"),
    ("arrears", "Calculate arrears", "Unpaid premiums and authorised charges"),
    ("declaration", "Collect health declaration", "Signed disclosure and supporting documents"),
    ("assessment", "Perform underwriting", "Evaluate changes in medical and risk circumstances"),
    ("decision", "Capture underwriting decision", "Approve, request evidence, offer revised terms or decline"),
    ("payment", "Verify payment & conditions", "Realised funds and acceptance of any revised terms"),
    ("restore", "Restore coverage", "Authorised policy transition and effective date"),
    ("confirmation", "Issue confirmation", "Documentation, customer notice and audit record"),
]


def conditions(case: PolicyReinstatement) -> dict:
    """The gates that must all hold before cover can be restored (checked again,
    with a fresh eligibility pass, when the restore action runs)."""
    decision = case.decision
    approved = decision in APPROVING_DECISIONS and case.status in ("Approved", "Reinstated")
    terms_ok = decision != "ApproveWithTerms" or case.terms_response == "Accepted"
    paid = bool(case.payment_realized_at) and case.payment_amount + 0.005 >= (case.total_payable or 0.0)
    return {
        "declaration": bool(case.declaration_signed_at),
        "evidence": not required_evidence_outstanding(case.evidence_json),
        "decision": approved,
        "terms": terms_ok,
        "payment": paid,
    }


def _payment_detail(case: PolicyReinstatement) -> str:
    text = "Funds realised" if case.payment_realized_at else "Awaiting payment"
    if case.terms_response == "Accepted":
        return text + " · terms accepted"
    if case.terms_response == "Rejected":
        return text + " · terms rejected"
    if case.decision == "ApproveWithTerms":
        return text + " · awaiting acceptance of revised terms"
    return text


def _declaration_detail(case: PolicyReinstatement) -> str:
    text = "Signed" if case.declaration_signed_at else "Awaiting signed declaration"
    outstanding = required_evidence_outstanding(case.evidence_json)
    return f"{text} · {len(outstanding)} document(s) outstanding" if outstanding else text


_DECISION_LABELS = {"Approve": "Approved", "ApproveWithTerms": "Approved with revised terms",
                    "RequestEvidence": "More evidence requested", "Decline": "Declined"}


def _confirmation_detail(case: PolicyReinstatement) -> str:
    if case.confirmation_sent_at:
        return "Sent to customer"
    return "Generated" if case.confirmation_generated_at else "Not issued"


def _step_details(case: PolicyReinstatement) -> dict:
    assessed = (case.assessment_json or {}).get("recommendation") if case.assessed_at else None
    return {
        "detect": f"Lapsed {case.lapse_date.isoformat()}" if case.lapse_date else "Lapsed",
        "request": f"{case.case_no} · {case.applicant_name or 'applicant'}",
        "arrears": f"PKR {case.total_payable:,.0f} to clear" if case.arrears_calculated_at else "Not calculated",
        "declaration": _declaration_detail(case),
        "assessment": assessed or "Not assessed",
        "decision": _DECISION_LABELS.get(case.decision or "", "Awaiting decision"),
        "payment": _payment_detail(case),
        "restore": f"Effective {case.effective_date.isoformat()}" if case.effective_date else "Not restored",
        "confirmation": _confirmation_detail(case),
    }


def build_workflow(case: PolicyReinstatement) -> list[dict]:
    """Project the case onto the 9-step process. The first not-done step is
    `current`; once the case is closed unfinished steps read `closed`."""
    c = conditions(case)
    closed = case.status in ("Declined", "Withdrawn")
    done = {
        "detect": True,
        "request": True,
        "arrears": bool(case.arrears_calculated_at),
        "declaration": c["declaration"] and c["evidence"],
        "assessment": bool(case.assessed_at),
        "decision": case.decision in APPROVING_DECISIONS or case.status == "Declined",
        "payment": c["payment"] and c["terms"],
        "restore": case.status == "Reinstated",
        "confirmation": bool(case.confirmation_generated_at),
    }

    detail = _step_details(case)

    steps, current_seen = [], False
    for n, (key, title, blurb) in enumerate(STEPS, start=1):
        if done[key]:
            state = "done"
        elif closed:
            state = "closed"
        elif not current_seen:
            state, current_seen = "current", True
        else:
            state = "pending"
        steps.append({"n": n, "key": key, "title": title, "blurb": blurb, "state": state, "detail": detail[key]})
    return steps


def _iso(d) -> Optional[str]:
    return d.isoformat() if d else None


def case_summary(case: PolicyReinstatement) -> dict:
    """Compact row for the case history list."""
    return {
        "id": str(case.id), "case_no": case.case_no, "status": case.status,
        "decision": case.decision, "applicant_name": case.applicant_name,
        "total_payable": case.total_payable, "lapse_date": _iso(case.lapse_date),
        "effective_date": _iso(case.effective_date), "created_at": case.created_at.isoformat(),
        "closed_reason": case.closed_reason,
    }


def case_view(case: PolicyReinstatement) -> dict:
    """Full JSON for one case. File paths are server-side only — never exposed."""
    evidence = [{k: v for k, v in e.items() if k != "file_path"} | {"has_file": bool(e.get("file_path"))}
                for e in (case.evidence_json or [])]
    return {
        **case_summary(case),
        "applicant_relationship": case.applicant_relationship,
        "request_channel": case.request_channel,
        "reason": case.reason,
        "requested_by": case.requested_by,
        "window_ends_on": _iso(case.window_ends_on),
        "eligibility": case.eligibility_json,
        "rules": case.rules_json,
        "arrears": case.arrears_json,
        "arrears_calculated_at": _iso(case.arrears_calculated_at),
        "declaration": case.declaration_json,
        "declaration_signed_at": _iso(case.declaration_signed_at),
        "declaration_signed_by": case.declaration_signed_by,
        "evidence": evidence,
        "assessment": case.assessment_json,
        "assessed_at": _iso(case.assessed_at),
        "decision_notes": case.decision_notes,
        "decided_by": case.decided_by,
        "decided_at": _iso(case.decided_at),
        "terms": case.terms_json,
        "terms_response": case.terms_response,
        "terms_responded_at": _iso(case.terms_responded_at),
        "terms_responded_by": case.terms_responded_by,
        "decision_history": case.decision_history_json or [],
        "payment": {
            "amount": case.payment_amount, "method": case.payment_method,
            "reference": case.payment_reference, "realized_at": _iso(case.payment_realized_at),
            "refund_reference": case.refund_reference,
        },
        "reinstated_at": _iso(case.reinstated_at),
        "receipts": case.receipts_json or [],
        "confirmation": {
            "generated_at": _iso(case.confirmation_generated_at),
            "sent_at": _iso(case.confirmation_sent_at), "sent_to": case.confirmation_sent_to,
        },
        "conditions": conditions(case),
        "workflow": build_workflow(case),
        "is_open": case.status in OPEN_STATUSES,
        "updated_at": case.updated_at.isoformat(),
    }
