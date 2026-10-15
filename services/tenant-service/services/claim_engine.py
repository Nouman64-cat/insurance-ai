"""
Stage B claims engine — coverage on the event date, eligibility, document
checklists, benefit assessment, investigation flags, payee verification,
settlement reconciliation and the 7-step tracker projection (Step 8).

Claims Management is independent of Reinstatement and Renewals. A claim can arise
whenever the relevant cover applies, so the key question is never "what is the
policy's status today?" but "was the cover in force on the EVENT date?" — a policy
that is lapsed or cancelled today may still owe a valid claim for an event inside an
earlier in-force period. `coverage_timeline` rebuilds those periods from the policy's
audit trail (PolicyEvent) and `evaluate_eligibility_facts` applies them.

Router-free like the other engines: pure functions take plain facts and unit-test
without a database; the thin async wrappers gather the facts. The router owns commits,
the Claim status history and the PolicyEvent audit rows.

The checklists, waiting periods and benefit formulas are configurable PLACEHOLDERS
(services/insurer_config.py) — Adamjee publishes the process and the forms, not the
exact wording.
"""

from __future__ import annotations

import difflib
import re
from datetime import date, datetime, timedelta
from typing import Optional
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from services import insurer_config as cfg
from shared.models.core import (
    Beneficiary,
    Claim,
    ClaimProcess,
    ClaimStatusEnum,
    Policy,
    PolicyEvent,
    PolicyRider,
    PremiumSchedule,
    PremiumScheduleStatusEnum,
)

IN_FORCE = frozenset({"Active", "GracePeriod"})

CATEGORIES = cfg.CLAIM_CATEGORIES
APPROVING_STATUSES = (ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL, ClaimStatusEnum.SETTLED)


def _v(x) -> str:
    return x.value if hasattr(x, "value") else str(x)


def _d(x) -> Optional[date]:
    if x is None:
        return None
    return x.date() if isinstance(x, datetime) else x


# ══════════════════════════════════════════════════════════════════════════════
# Working days + the 5–7 working-day decision clock
# ══════════════════════════════════════════════════════════════════════════════

def _holidays() -> set[date]:
    out = set()
    for h in cfg.CLAIM_PUBLIC_HOLIDAYS:
        try:
            out.add(date.fromisoformat(h))
        except ValueError:
            pass
    return out


def is_working_day(d: date, holidays: Optional[set[date]] = None) -> bool:
    return d.weekday() < 5 and d not in (holidays if holidays is not None else _holidays())


def add_working_days(start: date, n: int, holidays: Optional[set[date]] = None) -> date:
    """`start` + n working days (Mon–Fri, minus holidays). Day 0 is `start` itself."""
    hol = holidays if holidays is not None else _holidays()
    d = start
    while n > 0:
        d += timedelta(days=1)
        if is_working_day(d, hol):
            n -= 1
    return d


def working_days_between(a: date, b: date, holidays: Optional[set[date]] = None) -> int:
    """Working days after `a` up to and including `b` (negative when b < a)."""
    if b < a:
        return -working_days_between(b, a, holidays)
    hol = holidays if holidays is not None else _holidays()
    n, d = 0, a
    while d < b:
        d += timedelta(days=1)
        if is_working_day(d, hol):
            n += 1
    return n


def sla_state(*, docs_complete_at: Optional[datetime], decision_at: Optional[datetime], today: date,
              sla_days: Optional[int] = None) -> dict:
    """Adamjee decides normally within 5–7 working days of COMPLETE documentation; the
    clock only starts once every required document is in, and stops at the decision."""
    sla_days = sla_days if sla_days is not None else cfg.CLAIM_DECISION_SLA_WORKING_DAYS
    if docs_complete_at is None:
        return {"state": "not_started", "due_date": None, "working_days_left": None, "sla_days": sla_days,
                "message": "The decision clock starts when all required documents are received."}
    start = _d(docs_complete_at)
    due = add_working_days(start, sla_days)
    if decision_at is not None:
        met = _d(decision_at) <= due
        return {"state": "met" if met else "breached", "due_date": due, "working_days_left": None, "sla_days": sla_days,
                "message": "Decided within the service level." if met else "Decided after the service level date."}
    left = working_days_between(today, due)
    state = "breached" if left < 0 else "at_risk" if left <= 1 else "on_track"
    return {"state": state, "due_date": due, "working_days_left": left, "sla_days": sla_days,
            "message": f"Decision due {due.isoformat()} ({sla_days} working days from complete documents)."}


# ══════════════════════════════════════════════════════════════════════════════
# Coverage in force on the event date
# ══════════════════════════════════════════════════════════════════════════════

def coverage_timeline(events: list[dict], *, effective_date: Optional[date], status_now: str) -> list[dict]:
    """In-force periods of a policy, rebuilt from its status-change audit events.

    Each event: {"at": datetime, "event_type", "to_status", "detail"}. A period is
    [from, to) — `to` is the first day WITHOUT cover (None while still in force). Grace
    period counts as cover. A lapse takes effect at the end of the grace window when the
    event recorded it (`detail.grace_until`), else on the day it was recorded. A
    reinstatement or revival starts a new period on its own date — nothing is covered in
    between.
    """
    periods: list[dict] = []
    cur: Optional[dict] = None
    for e in sorted((x for x in events if x.get("to_status")), key=lambda x: x["at"]):
        to, day = e["to_status"], e["at"].date()
        if to in IN_FORCE:
            if cur is None:
                start = day
                if not periods and effective_date and effective_date > day:
                    start = effective_date      # cover bound before a future-dated inception
                cur = {"from": start, "to": None, "started_by": e["event_type"], "ended_by": None}
                periods.append(cur)
        elif cur is not None:
            end = day
            gu = (e.get("detail") or {}).get("grace_until")
            if to == "Lapsed" and gu:
                try:
                    end = min(date.fromisoformat(gu) + timedelta(days=1), day)
                except ValueError:
                    pass
            cur["to"] = max(end, cur["from"])
            cur["ended_by"] = to
            cur = None
    if not periods and status_now in IN_FORCE and effective_date:
        periods.append({"from": effective_date, "to": None, "started_by": "Inception", "ended_by": None})
    return periods


def covered_on(periods: list[dict], d: date) -> Optional[dict]:
    for p in periods:
        if p["from"] <= d and (p["to"] is None or d < p["to"]):
            return p
    return None


def serialise_periods(periods: list[dict]) -> list[dict]:
    return [{"from": p["from"].isoformat(), "to": p["to"].isoformat() if p["to"] else None,
             "started_by": p["started_by"], "ended_by": p["ended_by"]} for p in periods]


def gap_before(periods: list[dict], d: date) -> Optional[dict]:
    """The uncovered stretch that contains `d`, for a readable rejection reason."""
    prev_end = None
    for p in periods:
        if d < p["from"]:
            return {"from": prev_end, "to": p["from"]}
        prev_end = p["to"]
    return {"from": prev_end, "to": None} if prev_end else None


# ══════════════════════════════════════════════════════════════════════════════
# Benefits (which cover pays this claim type)
# ══════════════════════════════════════════════════════════════════════════════

def find_benefit(*, category: str, insurance_type: str, coverage_amount: float, riders: list[dict], event_date: date) -> dict:
    """The cover that responds to this claim type on the event date.

    Death is the base cover of a life product; accidental death, disability and
    (for non-health products) hospital cover are riders, which must have been attached
    on the event date and not yet exhausted. Health products pay hospitalization from
    the base annual sum insured.
    """
    spec = CATEGORIES[category]
    if insurance_type in spec["insurance_types"]:
        return {"available": True, "source": "Base cover", "label": f"Base cover — {spec['label']}",
                "sum_assured": coverage_amount, "rider_id": None, "detail": f"Payable from the base sum assured of PKR {coverage_amount:,.0f}."}
    keywords = spec["rider_keywords"]
    matches = [r for r in riders if any(k in r["name"].lower() for k in keywords)]
    if not matches:
        what = ", ".join(k for k in keywords) or "this benefit"
        return {"available": False, "source": None, "label": spec["label"], "sum_assured": 0.0, "rider_id": None,
                "detail": f"This product has no {spec['label'].lower()} benefit"
                          + (f" and no rider covering {what} is attached." if keywords else ".")}
    for r in matches:
        added = r.get("added_on")
        removed = r.get("removed_on")
        if r.get("status") == "Claimed":
            continue
        if added and event_date < added:
            continue
        if removed and event_date >= removed:
            continue
        return {"available": True, "source": "Rider", "label": f"Rider — {r['name']}", "sum_assured": r["sum_assured"],
                "rider_id": r["id"], "detail": f"Payable under the {r['name']} rider (sum assured PKR {r['sum_assured']:,.0f})."}
    r = matches[0]
    why = ("the rider benefit was already claimed" if r.get("status") == "Claimed" else
           f"the rider was attached on {r['added_on'].isoformat()}, after the event" if r.get("added_on") and event_date < r["added_on"] else
           f"the rider was removed on {r['removed_on'].isoformat()}, on or before the event")
    return {"available": False, "source": None, "label": spec["label"], "sum_assured": 0.0, "rider_id": None,
            "detail": f"The {r['name']} rider did not respond on {event_date.isoformat()}: {why}."}


# ══════════════════════════════════════════════════════════════════════════════
# Eligibility verification (step 2)
# ══════════════════════════════════════════════════════════════════════════════

def check(key: str, label: str, passed: bool, detail: str, severity: str = "block") -> dict:
    return {"key": key, "label": label, "passed": passed, "detail": detail, "severity": "ok" if passed else severity}


def evaluate_eligibility_facts(
    *,
    category: str,
    event_date: date,
    reported_date: date,
    today: date,
    periods: list[dict],
    policy_status: str,
    maturity_date: Optional[date],
    insurance_type: str,
    coverage_amount: float,
    riders: list[dict],
    covered_relationship: str,
    cause: Optional[str],
    last_reinstatement_date: Optional[date] = None,
    free_look_cancelled: bool = False,
    prior_death_settled: bool = False,
    duplicate_count: int = 0,
    contract_period: Optional[dict] = None,
    is_floater: bool = False,
    arrears_at_event: float = 0.0,
    product_rules: Optional[dict] = None,
) -> dict:
    """Verify the claim against the policy ON THE EVENT DATE (pure).

    `product_rules` (insurer_config.claim_rules) applies the product's own wording on top of
    the defaults: its maximum sum assured, whole-term exclusions and intimation deadline.

    status: Eligible (clean) | Referred (cover applies but an officer must look at one or
    more points) | Ineligible (a hard rule fails).
    """
    checks: list[dict] = []
    rules = product_rules or {}
    spec = CATEGORIES[category]
    in_period = covered_on(periods, event_date)
    cover_start = periods[0]["from"] if periods else None

    checks.append(check("event_date", "Event date is valid", event_date <= today,
                        "The event date is in the future." if event_date > today else f"Event on {event_date.isoformat()}."))

    if free_look_cancelled:
        checks.append(check("coverage", "Cover in force on the event date", False,
                            "The policy was cancelled inside the free-look window with a full refund — no cover ever applied."))
    elif in_period:
        grace = ""
        checks.append(check("coverage", "Cover in force on the event date", True,
                            f"In force from {in_period['from'].isoformat()}"
                            + (f" to {(in_period['to'] - timedelta(days=1)).isoformat()}" if in_period["to"] else " and still running")
                            + grace + "."))
    else:
        gap = gap_before(periods, event_date)
        if not periods:
            detail = "Cover has never been in force on this policy."
        elif cover_start and event_date < cover_start:
            detail = f"The event ({event_date.isoformat()}) was before cover began on {cover_start.isoformat()}."
        elif gap and gap.get("from") and gap.get("to"):
            detail = (f"The event ({event_date.isoformat()}) fell in a period without cover "
                      f"({gap['from'].isoformat()} to {(gap['to'] - timedelta(days=1)).isoformat()}) — the policy had lapsed and was later reinstated.")
        elif gap and gap.get("from"):
            detail = f"The event ({event_date.isoformat()}) was on or after {gap['from'].isoformat()}, when cover ended."
        else:
            detail = "No cover was in force on the event date."
        checks.append(check("coverage", "Cover in force on the event date", False, detail))

    if maturity_date:
        checks.append(check("term", "Within the policy term", event_date <= maturity_date,
                            f"The policy matured on {maturity_date.isoformat()}." if event_date > maturity_date
                            else f"Policy term runs to {maturity_date.isoformat()}."))

    if contract_period and contract_period.get("renewable"):
        checks.append(check("renewed_period", "Within a renewed contract period", bool(contract_period.get("ok")),
                            contract_period.get("detail", "")))

    benefit = find_benefit(category=category, insurance_type=insurance_type, coverage_amount=coverage_amount,
                           riders=riders, event_date=event_date)
    checks.append(check("benefit", f"{spec['label']} benefit applies", benefit["available"], benefit["detail"]))

    plan_max = rules.get("max_sum_assured")
    if plan_max and coverage_amount > plan_max:
        checks.append(check("plan_limit", "Sum assured within the plan's limits", False,
                            f"The policy's sum assured (PKR {coverage_amount:,.0f}) exceeds the plan's maximum of PKR {plan_max:,.0f} — "
                            "it was issued outside the product's limits. Underwriting must confirm the contractual benefit before anything is paid.",
                            "review"))

    if category in ("Death", "AccidentalDeath", "Disability") and not is_floater:
        ok = covered_relationship == "Self"
        checks.append(check("insured_person", "Claim is for the life assured", ok,
                            "The covered person is the life assured." if ok else
                            f"This policy insures the policyholder only; the claim is for their {covered_relationship.lower()}."))

    if category in ("AccidentalDeath",):
        ok = (cause or "") == "Accident"
        checks.append(check("cause", "Cause is an accident", ok,
                            "Cause recorded as an accident." if ok else
                            f"Cause is '{cause or 'not stated'}' — accidental-death cover pays for accidents only."))

    if prior_death_settled:
        checks.append(check("prior_claim", "No death benefit already paid", False,
                            "A death benefit has already been settled on this policy."))

    # Points that need an officer's judgement rather than a hard stop.
    contest_days = cfg.CLAIM_CONTESTABLE_DAYS
    anchors = [d for d in (cover_start, last_reinstatement_date) if d]
    contestable = bool(in_period and any(0 <= (event_date - a).days <= contest_days for a in anchors))
    if contestable:
        which = ("reinstatement" if last_reinstatement_date and 0 <= (event_date - last_reinstatement_date).days <= contest_days
                 and not (cover_start and 0 <= (event_date - cover_start).days <= contest_days) else "inception")
        checks.append(check("contestable", "Outside the contestability period", False,
                            f"The event is within {contest_days} days of {which} — review for non-disclosure before paying.", "review"))
    else:
        checks.append(check("contestable", "Outside the contestability period", True,
                            f"More than {contest_days} days since inception / reinstatement."))

    if cause == "Suicide" and category in ("Death", "AccidentalDeath") and rules.get("suicide_excluded_any_time"):
        # The product excludes suicide for the whole term: no benefit, only an ex-gratia override.
        checks.append(check("exclusion", "Suicide exclusion does not apply", False,
                            "This plan excludes death by suicide at any time during the term — no death benefit is payable."))
    elif cause == "Suicide" and category in ("Death", "AccidentalDeath") and cover_start:
        within = (event_date - (last_reinstatement_date or cover_start)).days <= cfg.CLAIM_SUICIDE_EXCLUSION_DAYS
        checks.append(check("exclusion", "Suicide exclusion does not apply", not within,
                            f"Suicide within {cfg.CLAIM_SUICIDE_EXCLUSION_DAYS} days of cover starting / being reinstated — the policy exclusion may apply."
                            if within else "Outside the suicide-exclusion period.", "review"))

    if rules.get("pre_existing_excluded") and category == "Death" and (cause or "Natural / illness") != "Accident" and cover_start:
        days_in = (event_date - (last_reinstatement_date or cover_start)).days
        checks.append(check("pre_existing", "Death not caused by a pre-existing condition", False,
                            f"This plan excludes death arising from pre-existing medical conditions. Death {days_in} day(s) after cover "
                            "started — confirm from prior treatment records that the cause did not exist before cover began.",
                            "review"))

    wait = cfg.CLAIM_WAITING_PERIOD_DAYS.get(category)
    if wait and cover_start and (cause or "Natural / illness") != "Accident":
        start = max([a for a in anchors] or [cover_start])
        days = (event_date - start).days
        checks.append(check("waiting_period", "Waiting period served", days >= wait,
                            f"Illness {days} days after cover started / was reinstated; the waiting period is {wait} days."
                            if days < wait else f"Waiting period of {wait} days served.", "review"))

    late = (reported_date - event_date).days
    limit = int(rules.get("intimation_days") or cfg.CLAIM_LATE_REPORT_DAYS)
    checks.append(check("late_report", "Reported promptly", late <= limit,
                        f"Reported {late} days after the event (limit {limit})." if late > limit
                        else f"Reported {max(late, 0)} day(s) after the event (limit {limit}).", "review"))

    checks.append(check("duplicate", "No duplicate claim", duplicate_count == 0,
                        f"{duplicate_count} other {spec['label'].lower()}(s) already registered for this date." if duplicate_count
                        else "No other claim of this type for the same date.", "review"))

    if arrears_at_event > 0:
        checks.append(check("arrears", "No premium outstanding at the event date", False,
                            f"PKR {arrears_at_event:,.0f} of premium was unpaid on the event date (grace period) — it will be deducted from the benefit.",
                            "info"))

    blockers = [c for c in checks if c["severity"] == "block"]
    reviews = [c for c in checks if c["severity"] == "review"]
    if blockers:
        status, message = "Ineligible", blockers[0]["detail"]
    elif reviews:
        status, message = "Referred", f"Cover applies on the event date; {len(reviews)} point(s) need an officer's attention."
    else:
        status, message = "Eligible", "Cover applied on the event date and the benefit responds."
    return {
        "status": status, "message": message, "checks": checks, "blockers": blockers, "reviews": reviews,
        "benefit": benefit, "contestable": contestable, "cover_periods": serialise_periods(periods),
        "cover_start": cover_start.isoformat() if cover_start else None, "policy_status_today": policy_status,
    }


# ══════════════════════════════════════════════════════════════════════════════
# Document checklist (step 3)
# ══════════════════════════════════════════════════════════════════════════════

def _applies(when: str, *, segment: str, cause: Optional[str], claimant_is_nominee: bool, contestable: bool) -> bool:
    unnatural = (cause or "") in ("Accident", "Suicide", "Other unnatural")
    return {
        "always": True,
        "individual": segment != "Corporate",
        "group": segment == "Corporate",
        "illness": not unnatural,
        "accident_or_unnatural": unnatural,
        "claimant_not_nominee": not claimant_is_nominee,
        "contestable": contestable,
    }.get(when, True)


def build_checklist(*, category: str, segment: str, cause: Optional[str], claimant_is_nominee: bool,
                    contestable: bool, now: Optional[datetime] = None, product_rules: Optional[dict] = None) -> list[dict]:
    """The Adamjee-style document list for this claim: the type's items filtered by what
    this particular claim needs (individual vs group form, illness vs accident, whether
    the claimant is the named nominee, contestability)."""
    now = now or datetime.utcnow()
    out, seen = [], set()
    # The product's own claim section wins over a default item with the same key.
    extra = list(((product_rules or {}).get("extra_documents") or {}).get(category, []))
    extra_keys = {d["key"] for d in extra}
    base = [d for d in cfg.CLAIM_DOCUMENTS.get(category, []) if d["key"] not in extra_keys]
    core = [d for d in base if d["key"] in ("policy_doc", "bank_details")]
    ordered = [d for d in base if d not in core] + extra + core
    for d in ordered:
        if not _applies(d["when"], segment=segment, cause=cause, claimant_is_nominee=claimant_is_nominee, contestable=contestable):
            continue
        if d["key"] in seen:
            continue
        seen.add(d["key"])
        out.append({
            "key": d["key"], "label": d["label"], "required": bool(d["required"]), "when": d["when"],
            "reason": None if d["when"] == "always" else {
                "illness": "Death from illness", "accident_or_unnatural": "Accident / unnatural cause",
                "claimant_not_nominee": "Claimant is not the named nominee", "contestable": "Contestable period",
                "individual": "Individual / family policy", "group": "Group scheme"}.get(d["when"]),
            "status": "Requested", "requested_at": now.isoformat(), "received_at": None,
            "artifact_id": None, "file_name": None, "note": None,
        })
    return out


def merge_documents(existing: Optional[list], wanted: list[dict]) -> list[dict]:
    """Add checklist items that are not already on the claim; never reset a received one."""
    have = {d["key"] for d in (existing or [])}
    merged = [dict(d) for d in (existing or [])]
    merged += [dict(w) for w in wanted if w["key"] not in have]
    return merged


def outstanding_documents(documents: Optional[list]) -> list[dict]:
    return [d for d in (documents or []) if d.get("required") and d.get("status") not in ("Received", "Waived")]


def documents_progress(documents: Optional[list]) -> dict:
    req = [d for d in (documents or []) if d.get("required")]
    done = [d for d in req if d.get("status") in ("Received", "Waived")]
    return {"required": len(req), "received": len(done), "outstanding": len(req) - len(done),
            "total": len(documents or []), "complete": bool(req) and len(done) == len(req)}


# ══════════════════════════════════════════════════════════════════════════════
# Investigation (step 4)
# ══════════════════════════════════════════════════════════════════════════════

def investigation_flags(
    *, category: str, eligibility: dict, event_date: date, reported_date: date, cover_start: Optional[date],
    duplicate_flag: bool, fraud_probability: float, nominee_mismatch: bool, claimed_amount: float,
) -> dict:
    """Red flags that decide whether the claim needs a real investigation before it is
    assessed. Any high flag requires one."""
    flags: list[dict] = []

    def add(code: str, sev: str, msg: str) -> None:
        flags.append({"code": code, "severity": sev, "message": msg})

    review_keys = {c["key"] for c in eligibility.get("reviews", [])}
    if eligibility.get("contestable"):
        add("contestable", "high" if category in ("Death", "AccidentalDeath") else "medium",
            "Within the contestability period — verify the proposal answers against the medical history.")
    if category in ("Death", "AccidentalDeath") and cover_start and 0 <= (event_date - cover_start).days < cfg.CLAIM_EARLY_CLAIM_DAYS:
        add("early_claim", "high", f"Death {(event_date - cover_start).days} days after cover started (early-claim threshold {cfg.CLAIM_EARLY_CLAIM_DAYS}).")
    if duplicate_flag:
        add("duplicate", "high", "Flagged as a possible duplicate of another claim.")
    if fraud_probability >= 0.5:
        add("fraud_score", "high", f"Fraud score {fraud_probability:.0%} is at or above the review threshold.")
    blocker_keys = {c["key"] for c in eligibility.get("blockers", [])}
    if "exclusion" in review_keys or "exclusion" in blocker_keys:
        add("exclusion", "high", "A policy exclusion (suicide) may apply.")
    if "plan_limit" in review_keys:
        add("plan_limit", "high", "The sum assured exceeds the plan's maximum — confirm the contractual benefit with underwriting.")
    if "pre_existing" in review_keys:
        early = bool(cover_start and 0 <= (event_date - cover_start).days < cfg.CLAIM_EARLY_CLAIM_DAYS)
        add("pre_existing", "high" if early else "medium",
            "The plan excludes death from pre-existing conditions — obtain prior treatment records"
            + (" (early death claim)." if early else "."))
    if "waiting_period" in review_keys:
        add("waiting_period", "medium", "Illness inside the waiting period.")
    if "late_report" in review_keys:
        add("late_report", "medium", f"Reported {(reported_date - event_date).days} days after the event.")
    if nominee_mismatch:
        add("nominee_mismatch", "medium", "The claimant is not the named nominee — confirm entitlement.")
    if claimed_amount > cfg.CLAIM_MANAGER_LIMIT:
        add("high_value", "info", f"Above PKR {cfg.CLAIM_MANAGER_LIMIT:,.0f} — a claims manager must authorise the decision.")
    return {"flags": flags, "requires_investigation": any(f["severity"] == "high" for f in flags)}


# ══════════════════════════════════════════════════════════════════════════════
# Benefit assessment (step 4)
# ══════════════════════════════════════════════════════════════════════════════

def _money(x) -> float:
    return round(float(x), 2)


def _clean_lines(lines: Optional[list[dict]]) -> list[dict]:
    out = []
    for ln in lines or []:
        label = (ln.get("label") or "").strip()
        amount = _money(ln.get("amount") or 0)
        if amount < 0:
            raise ValueError(f"'{label or 'Deduction'}' cannot be negative.")
        if label and amount > 0:
            out.append({"label": label, "amount": amount})
    return out


def assess_benefit(
    *, category: str, claimed_amount: float, benefit: dict, arrears_at_event: float = 0.0,
    disability_pct: Optional[float] = None, deductions: Optional[list[dict]] = None,
    copay_pct: Optional[float] = None, remaining_limit: Optional[float] = None,
) -> dict:
    """Calculate the contractual benefit. Raises ValueError for unusable input.

      Death / AccidentalDeath  sum assured (base, or the accidental-death rider)
                               less premium unpaid at the event date and any other deduction.
      Disability               rider sum assured × the assessed degree of disability.
      Hospitalization          claimed bills less inadmissible items, less co-pay,
                               limited to what is left of the annual sum insured.

    The payable amount never exceeds what was claimed.
    """
    if not benefit.get("available"):
        raise ValueError("No benefit responds to this claim, so there is nothing to assess.")
    ded = _clean_lines(deductions)
    components: list[dict] = []
    deduction_lines: list[dict] = []
    basis = benefit["label"]
    capped_by = None

    if category in ("Death", "AccidentalDeath"):
        gross = _money(benefit["sum_assured"])
        components.append({"label": "Sum assured payable on death" if category == "Death" else "Accidental-death benefit", "amount": gross})
        if arrears_at_event > 0:
            deduction_lines.append({"label": "Premium unpaid at the event date", "amount": _money(arrears_at_event)})
        deduction_lines += ded
        payable = max(gross - sum(x["amount"] for x in deduction_lines), 0.0)
    elif category == "Disability":
        if disability_pct is None or not (0 < disability_pct <= 100):
            raise ValueError("Enter the assessed degree of disability (above 0% and up to 100%).")
        full = _money(benefit["sum_assured"])
        gross = _money(full * disability_pct / 100.0)
        components.append({"label": f"Disability benefit ({disability_pct:g}% of PKR {full:,.0f})", "amount": gross})
        deduction_lines += ded
        payable = max(gross - sum(x["amount"] for x in deduction_lines), 0.0)
    else:  # Hospitalization
        gross = _money(claimed_amount)
        components.append({"label": "Claimed hospital expenses", "amount": gross})
        deduction_lines += [{"label": f"Not admissible: {x['label']}", "amount": x["amount"]} for x in ded]
        admitted = max(gross - sum(x["amount"] for x in deduction_lines), 0.0)
        pct = cfg.CLAIM_COPAY_PCT if copay_pct is None else copay_pct
        if pct and admitted > 0:
            deduction_lines.append({"label": f"Co-payment ({pct:g}%)", "amount": _money(admitted * pct / 100.0)})
        payable = max(gross - sum(x["amount"] for x in deduction_lines), 0.0)
        if remaining_limit is not None and payable > remaining_limit:
            payable, capped_by = max(_money(remaining_limit), 0.0), "remaining annual limit"
            components.append({"label": "Remaining annual sum insured", "amount": payable})

    payable = _money(payable)
    if payable > _money(claimed_amount):
        payable, capped_by = _money(claimed_amount), "amount claimed"
    return {
        "basis": basis, "components": components, "deductions": deduction_lines, "gross": gross,
        "total_deductions": _money(sum(x["amount"] for x in deduction_lines)), "payable": payable,
        "capped_by": capped_by, "claimed_amount": _money(claimed_amount),
        "inputs": {"disability_pct": disability_pct, "copay_pct": copay_pct, "remaining_limit": remaining_limit,
                   "arrears_at_event": _money(arrears_at_event)},
    }


# ══════════════════════════════════════════════════════════════════════════════
# Payee verification + settlement (step 6)
# ══════════════════════════════════════════════════════════════════════════════

def _norm_cnic(s: Optional[str]) -> str:
    return re.sub(r"\D", "", s or "")


def _norm_name(s: Optional[str]) -> list[str]:
    return sorted(re.sub(r"[^a-z ]", " ", (s or "").lower()).split())


def name_similarity(a: Optional[str], b: Optional[str]) -> float:
    ta, tb = _norm_name(a), _norm_name(b)
    if not ta or not tb:
        return 0.0
    return round(difflib.SequenceMatcher(None, " ".join(ta), " ".join(tb)).ratio(), 2)


def split_amounts(total: float, shares: list[float]) -> list[float]:
    """Split `total` by percentage shares; the last payee absorbs rounding."""
    out = [round(total * s / 100.0, 2) for s in shares]
    if out:
        out[-1] = round(total - sum(out[:-1]), 2)
    return out


def derive_payees(
    *, category: str, approved_amount: float, beneficiaries: list[dict], nominee_name: Optional[str],
    nominee_relationship: Optional[str], claimant: dict, covered_person_name: Optional[str],
) -> list[dict]:
    """Who is entitled to be paid. Death benefits go to the nominees in their recorded
    shares (a minor is paid through the guardian); every other benefit goes to the
    claimant / insured."""
    people: list[dict] = []
    if category in ("Death", "AccidentalDeath"):
        if beneficiaries:
            for b in beneficiaries:
                people.append({"beneficiary_name": b["name"], "name": (b.get("guardian_name") if b.get("is_minor") and b.get("guardian_name") else b["name"]),
                               "cnic": b.get("cnic"), "relationship": b["relationship"], "share_pct": b["share_pct"],
                               "is_minor": bool(b.get("is_minor")), "guardian_name": b.get("guardian_name"), "source": "Nominee on record"})
        elif nominee_name:
            people.append({"beneficiary_name": nominee_name, "name": nominee_name, "cnic": None,
                           "relationship": nominee_relationship or "Nominee", "share_pct": 100.0, "is_minor": False,
                           "guardian_name": None, "source": "Nominee on record"})
    if not people:
        people.append({"beneficiary_name": claimant.get("name") or covered_person_name, "name": claimant.get("name") or covered_person_name,
                       "cnic": claimant.get("cnic"), "relationship": claimant.get("relationship") or "Self", "share_pct": 100.0,
                       "is_minor": False, "guardian_name": None, "source": "Claimant"})
    amounts = split_amounts(approved_amount, [p["share_pct"] for p in people])
    out = []
    for i, (p, amt) in enumerate(zip(people, amounts), start=1):
        out.append({**p, "id": f"payee-{i}", "amount": amt, "verified": False, "verified_by": None, "verified_at": None,
                    "method": None, "bank_name": None, "account_title": None, "iban": None, "note": None, "checks": []})
    return out


def payee_checks(payee: dict, *, recorded_cnic: Optional[str] = None) -> dict:
    """Identity + bank-account checks for one payee. Blocking failures stop the
    verification; a review failure (account title not matching) needs a note."""
    checks = []
    cnic = _norm_cnic(payee.get("cnic"))
    checks.append(check("cnic", "CNIC provided (13 digits)", len(cnic) == 13, "CNIC recorded." if len(cnic) == 13 else "Enter the payee's 13-digit CNIC."))
    if recorded_cnic and cnic:
        same = _norm_cnic(recorded_cnic) == cnic
        checks.append(check("cnic_match", "CNIC matches the nominee on record", same,
                            "Matches the CNIC recorded for the nominee." if same else "Does not match the CNIC recorded for this nominee."))
    if payee.get("is_minor"):
        checks.append(check("guardian", "Guardian named for a minor beneficiary", bool(payee.get("guardian_name")),
                            f"Paid through guardian {payee.get('guardian_name')}." if payee.get("guardian_name") else "A minor must be paid through a named guardian."))
    iban = re.sub(r"\s", "", (payee.get("iban") or "").upper())
    checks.append(check("iban", "Valid Pakistani IBAN", bool(re.match(cfg.CLAIM_IBAN_PATTERN, iban)),
                        "IBAN format is valid." if re.match(cfg.CLAIM_IBAN_PATTERN, iban) else "Enter a 24-character IBAN (PK + 2 digits + 4-letter bank code + 16 characters)."))
    checks.append(check("bank", "Bank named", bool((payee.get("bank_name") or "").strip()), "Bank recorded." if (payee.get("bank_name") or "").strip() else "Enter the bank name."))
    title = payee.get("account_title")
    sim = name_similarity(title, payee.get("name"))
    checks.append(check("account_title", "Account title matches the payee", sim >= cfg.CLAIM_FUZZY_NAME_MATCH,
                        f"Account title “{title}” matches “{payee.get('name')}”." if sim >= cfg.CLAIM_FUZZY_NAME_MATCH
                        else f"Account title “{title or '—'}” does not match “{payee.get('name')}” — confirm the account belongs to the payee.", "review"))
    return {"checks": checks, "blockers": [c for c in checks if c["severity"] == "block"],
            "reviews": [c for c in checks if c["severity"] == "review"], "similarity": sim}


def reconcile_settlement(
    *, approved_amount: float, payees: list[dict], payouts: list[dict], claim_status: str, settlement_amount: Optional[float],
) -> dict:
    """Reconcile what was disbursed against what was approved and who was owed it."""
    total = round(sum(p["amount"] for p in payouts), 2)
    variance = round(total - approved_amount, 2)
    refs = [p.get("reference_number") for p in payouts if p.get("reference_number")]
    checks = [
        check("payouts", "Disbursement recorded", bool(payouts), "No payout has been recorded." if not payouts else f"{len(payouts)} payout(s) recorded."),
        check("amount", "Total disbursed equals the approved amount", abs(variance) < 0.01,
              f"Disbursed PKR {total:,.2f} against PKR {approved_amount:,.2f} approved." + (f" Variance {variance:+,.2f}." if abs(variance) >= 0.01 else "")),
        check("references", "Every payout has a unique reference", bool(payouts) and len(refs) == len(payouts) == len(set(refs)),
              "All payouts carry a distinct reference." if payouts and len(refs) == len(payouts) == len(set(refs)) else "A payout is missing a reference, or a reference is repeated."),
        check("status", "All payouts settled", bool(payouts) and all(p.get("status") == "Settled" for p in payouts),
              "All payouts show Settled." if payouts and all(p.get("status") == "Settled" for p in payouts) else "A payout is not in Settled status."),
    ]
    # Match each payee to one payout of the same name AND amount. Matching on name alone
    # would break when one person is paid twice (a guardian paid for herself and for a
    # minor child), so each payout is used at most once.
    remaining = [dict(p) for p in payouts]
    unpaid = []
    for py in payees:
        hit = next((p for p in remaining if (p.get("payee_name") or "").strip().lower() == py["name"].strip().lower()
                    and abs(p["amount"] - py["amount"]) < 0.01), None)
        if hit is None:
            unpaid.append(f"{py['name']} (PKR {py['amount']:,.2f})")
        else:
            remaining.remove(hit)
    checks.append(check("payees", "Each payee received their share", not unpaid,
                        "Every verified payee was paid the amount due." if not unpaid else "No matching payout for: " + ", ".join(unpaid) + "."))
    checks.append(check("claim_status", "Claim is marked Settled", claim_status == "Settled", f"Claim status is {claim_status}."))
    checks.append(check("ledger", "Claim settlement total agrees", settlement_amount is not None and abs((settlement_amount or 0) - total) < 0.01,
                        "The claim's settlement total agrees with the payouts." if settlement_amount is not None and abs((settlement_amount or 0) - total) < 0.01
                        else "The claim's recorded settlement total differs from the payouts.", "review"))
    blockers = [c for c in checks if c["severity"] == "block"]
    return {"status": "Matched" if not blockers else "Exception", "approved": round(approved_amount, 2), "disbursed": total,
            "variance": variance, "checks": checks, "reviews": [c for c in checks if c["severity"] == "review"],
            "checked_at": datetime.utcnow().isoformat()}


# ══════════════════════════════════════════════════════════════════════════════
# Stage projection (7 steps)
# ══════════════════════════════════════════════════════════════════════════════

def _stage(key: str, title: str, state: str, label: str, detail: str = "", n: int = 0) -> dict:
    return {"n": n, "key": key, "title": title, "state": state, "label": label, "detail": detail}


def project_stages(proc: ClaimProcess, claim: Claim, *, payout_total: float = 0.0) -> list[dict]:
    """The seven steps of the claim. States: complete | current | pending | action |
    exception | skipped | not_started."""
    st = _v(claim.status)
    rejected = st == "Declined" or (st == "Closed" and proc.closure_outcome == "Rejected")
    approved = st in ("Approved", "Partial Approval", "Settled") or (st == "Closed" and proc.closure_outcome == "Settled")
    closed = st == "Closed"
    docs = documents_progress(proc.documents_json)
    inv = proc.investigation_json or {}
    needs_inv = bool(inv.get("requires_investigation"))
    ineligible = proc.eligibility_status == "Ineligible" and not proc.eligibility_override_by
    rows = []

    rows.append(_stage("intimation", "Claim intimation", "complete", "Registered",
                       f"{claim.claim_number} · event {proc.event_date.isoformat()}", 1))

    if proc.eligibility_status is None:
        rows.append(_stage("eligibility", "Eligibility verification", "pending", "Pending", "Not verified yet", 2))
    elif proc.eligibility_status == "Eligible":
        rows.append(_stage("eligibility", "Eligibility verification", "complete", "Eligible", "Cover applied on the event date", 2))
    elif proc.eligibility_status == "Referred" or proc.eligibility_override_by:
        rows.append(_stage("eligibility", "Eligibility verification", "complete",
                           "Overridden" if proc.eligibility_override_by else "Eligible · review points",
                           (proc.eligibility_override_note or "An officer should review the flagged points") if proc.eligibility_override_by else "Cover applies; review points flagged", 2))
    else:
        rows.append(_stage("eligibility", "Eligibility verification", "exception", "Not eligible",
                           (proc.eligibility_json or {}).get("message", ""), 2))

    if proc.eligibility_status is None or (ineligible and not rejected):
        rows.append(_stage("documents", "Document collection", "not_started", "Not started", "", 3))
    elif rejected and not docs["complete"]:
        rows.append(_stage("documents", "Document collection", "skipped", "Not required", "", 3))
    elif docs["complete"]:
        rows.append(_stage("documents", "Document collection", "complete", "Complete", f"{docs['received']} of {docs['required']} required documents", 3))
    else:
        rows.append(_stage("documents", "Document collection", "action", "Awaiting documents",
                           f"{docs['received']} of {docs['required']} required documents received", 3))

    investigated = (not needs_inv) or bool(proc.investigation_completed_at)
    if proc.assessed_at and investigated:
        rows.append(_stage("assessment", "Investigation & assessment", "complete", "Assessed",
                           f"Payable PKR {(proc.assessment_json or {}).get('payable', 0):,.0f}", 4))
    elif rejected and not proc.assessed_at:
        rows.append(_stage("assessment", "Investigation & assessment", "skipped", "Not required", "", 4))
    elif not docs["complete"]:
        rows.append(_stage("assessment", "Investigation & assessment", "not_started", "Not started", "", 4))
    elif needs_inv and not proc.investigation_completed_at:
        rows.append(_stage("assessment", "Investigation & assessment", "action", "Investigation required", "Red flags raised", 4))
    else:
        rows.append(_stage("assessment", "Investigation & assessment", "action", "Assessment pending", "Calculate the benefit", 4))

    if rejected:
        rows.append(_stage("decision", "Claims decision", "complete", "Rejected", proc.decision_reason or "", 5))
    elif approved:
        label = "Partially approved" if (st == "Partial Approval" or proc.decision == "PartialApprove") else "Approved"
        rows.append(_stage("decision", "Claims decision", "complete", label, f"PKR {proc.decision_amount:,.0f}", 5))
    elif st == "Referred to Manager":
        rows.append(_stage("decision", "Claims decision", "action", "Referred to manager", "Awaiting a claims manager", 5))
    elif proc.assessed_at and investigated and docs["complete"]:
        rows.append(_stage("decision", "Claims decision", "action", "Awaiting decision", "", 5))
    else:
        rows.append(_stage("decision", "Claims decision", "not_started", "Not started", "", 5))

    if rejected:
        rows.append(_stage("settlement", "Settlement", "skipped", "Not applicable", "No payment — claim rejected", 6))
    elif st == "Settled" or (closed and proc.closure_outcome == "Settled"):
        if proc.reconciled_at:
            rows.append(_stage("settlement", "Settlement", "complete", "Settled & reconciled", f"PKR {payout_total:,.0f} disbursed", 6))
        else:
            rows.append(_stage("settlement", "Settlement", "action", "Reconcile payment", f"PKR {payout_total:,.0f} disbursed", 6))
    elif approved:
        if not proc.payees_verified_at:
            rows.append(_stage("settlement", "Settlement", "action", "Verify payee", "Confirm who is rightfully paid", 6))
        elif not proc.authorized_at:
            rows.append(_stage("settlement", "Settlement", "action", "Authorize disbursement", "", 6))
        else:
            rows.append(_stage("settlement", "Settlement", "action", "Disburse", f"Authorised PKR {proc.authorized_amount:,.0f}", 6))
    else:
        rows.append(_stage("settlement", "Settlement", "not_started", "Not started", "", 6))

    if closed:
        rows.append(_stage("closure", "Claim closure", "complete", "Closed", proc.closure_outcome or "", 7))
    elif rejected or (st == "Settled" and proc.reconciled_at):
        rows.append(_stage("closure", "Claim closure", "action", "Ready to close", "", 7))
    else:
        rows.append(_stage("closure", "Claim closure", "not_started", "Not started", "", 7))
    return rows


# ══════════════════════════════════════════════════════════════════════════════
# Async fact gathering
# ══════════════════════════════════════════════════════════════════════════════

def _segment(policy: Policy) -> str:
    if policy.master_policy_id:
        return "Corporate"
    if policy.family_policy_id:
        return "Family"
    return "Individual"


async def load_events(session: AsyncSession, policy_id: UUID) -> list[dict]:
    rows = (await session.exec(select(PolicyEvent).where(PolicyEvent.policy_id == policy_id)
                               .order_by(PolicyEvent.created_at))).all()  # type: ignore[arg-type]
    return [{"at": e.created_at, "event_type": e.event_type, "from_status": e.from_status, "to_status": e.to_status,
             "detail": e.detail_json or {}} for e in rows]


async def load_riders(session: AsyncSession, policy_id: UUID) -> list[dict]:
    rows = (await session.exec(select(PolicyRider).where(PolicyRider.policy_id == policy_id))).all()
    return [{"id": str(r.id), "name": r.name, "sum_assured": r.sum_assured, "status": r.status,
             "added_on": _d(r.added_at), "removed_on": _d(r.removed_at)} for r in rows]


async def arrears_at(session: AsyncSession, policy_id: UUID, on: date) -> float:
    """Premium that was due on or before `on` and is STILL unpaid — to be deducted from a
    death benefit paid for an event in the grace period."""
    rows = (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy_id))).all()
    return round(sum(max(r.amount_due - r.amount_paid, 0.0) for r in rows
                     if _v(r.status) in (PremiumScheduleStatusEnum.PENDING.value, PremiumScheduleStatusEnum.OVERDUE.value)
                     and r.due_date <= on), 2)


async def paid_hospital_benefits(session: AsyncSession, policy: Policy, since: date) -> float:
    """What this policy has already paid in hospitalization benefit since `since`."""
    procs = (await session.exec(select(ClaimProcess).where(ClaimProcess.policy_id == policy.id,
                                                           ClaimProcess.category == "Hospitalization"))).all()
    total = 0.0
    for pr in procs:
        claim = await session.get(Claim, pr.claim_id)
        if claim and _v(claim.status) in ("Approved", "Partial Approval", "Settled", "Closed") and pr.decision in ("Approve", "PartialApprove") \
                and pr.event_date >= since:
            total += pr.decision_amount
    return round(total, 2)


async def policy_facts(session: AsyncSession, policy: Policy) -> dict:
    events = await load_events(session, policy.id)
    riders = await load_riders(session, policy.id)
    periods = coverage_timeline(events, effective_date=policy.effective_date, status_now=_v(policy.status))
    reinstated = [e["at"].date() for e in events if e["event_type"] == "PolicyReinstated"]
    free_look = any(e["event_type"] == "FreeLookCancellation" for e in events)
    return {"events": events, "riders": riders, "periods": periods, "segment": _segment(policy),
            "last_reinstatement": max(reinstated) if reinstated else None, "free_look_cancelled": free_look}


def benefit_menu(policy: Policy, riders: list[dict], today: date) -> list[dict]:
    """What each claim type would pay on this policy today — for the panel header."""
    out = []
    for key, spec in CATEGORIES.items():
        b = find_benefit(category=key, insurance_type=_v(policy.insurance_type), coverage_amount=policy.coverage_amount,
                         riders=riders, event_date=today)
        out.append({"category": key, "label": spec["label"], "applies": spec["applies"], "available": b["available"],
                    "source": b["source"], "sum_assured": b["sum_assured"], "detail": b["detail"]})
    return out
