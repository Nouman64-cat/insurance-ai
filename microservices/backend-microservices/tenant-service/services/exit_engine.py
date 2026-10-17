"""
Stage B exit engine — maturity, expiry, early surrender and corporate expiry (Step 9).

The module is the END of a policy's life. It decides whether cover has reached its
contractual end, whether a maturity or surrender payment is owed and how much, and when
the policy may be formally closed:

  Maturity          savings / investment-linked policy reaches maturity → pay the proceeds
  Expiry            protection-only term ends → close, nothing to pay
  Surrender         the policyholder leaves early → pay the eligible net surrender value
  CorporateExpiry   a group certificate's master policy was not renewed → close the cover
  DeathClaimClosure the policy a paid death claim already ended → issue closure + archive
                    (the death benefit itself belongs to Claims Management)

An approved extension is a Renewals matter (Module 7): while a contract renewal is open this
module never closes the policy.

Router-free like the other engines. Fund values, surrender charges and tax are PLACEHOLDERS
(services/insurer_config.py EXIT_*): Adamjee states the maturity value of unit-linked plans is
the cash value less indebtedness and recoverable amounts, but the unit prices and charge
schedule are not public. `fund_value` is the one function to replace with the real feed.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from services import claim_engine, insurer_config as cfg
from services.renewal_engine import add_years
from shared.models.core import (
    Claim,
    ClaimStatusEnum,
    GroupRenewal,
    MasterPolicy,
    Policy,
    PolicyEvent,
    PolicyExit,
    PolicyLoan,
    PremiumSchedule,
    PremiumScheduleStatusEnum,
)

IN_FORCE = frozenset({"Active", "GracePeriod"})
OPEN_STATUSES = ("Open",)
TYPE_LABELS = {
    "Maturity": "Maturity with benefit", "Expiry": "Expiry without benefit", "Surrender": "Early surrender",
    "CorporateExpiry": "Corporate coverage expiry", "DeathClaimClosure": "Closure after death claim",
}
BENEFIT_TYPES = ("Maturity", "Surrender")
FINAL_STATUS = {"Maturity": "Matured", "Surrender": "Surrendered", "Expiry": "Expired", "CorporateExpiry": "Expired"}
FINAL_EVENT = {"Maturity": "PolicyMatured", "Surrender": "PolicySurrendered", "Expiry": "PolicyExpired", "CorporateExpiry": "PolicyExpired"}

_OPEN_CLAIM_STATUSES = frozenset({
    ClaimStatusEnum.NEW, ClaimStatusEnum.TRIAGED, ClaimStatusEnum.UNDER_INVESTIGATION, ClaimStatusEnum.PENDING_DOCUMENTS,
    ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL, ClaimStatusEnum.REFERRED_TO_MANAGER,
    ClaimStatusEnum.REINSURANCE_REFERRED, ClaimStatusEnum.REUNDERWRITING_REQUIRED, ClaimStatusEnum.SETTLED,
})   # SETTLED = paid but not yet closed: the policy effects of the claim are still to be applied


def _v(x) -> str:
    return x.value if hasattr(x, "value") else str(x)


def _money(x: float) -> float:
    return round(float(x), 2)


# ══════════════════════════════════════════════════════════════════════════════
# Value + settlement maths (steps 3 and 5)
# ══════════════════════════════════════════════════════════════════════════════

def completed_years(effective: Optional[date], on: date) -> int:
    if not effective or on < effective:
        return 0
    years = on.year - effective.year - ((on.month, on.day) < (effective.month, effective.day))
    return max(years, 0)


def fund_value(contributions: list[tuple[date, float]], valuation: date, rules: dict) -> dict:
    """PLACEHOLDER fund: each premium, net of the allocation charge, grown at the assumed
    annual rate from the day it was paid to the valuation date. Replace with the unit-price feed."""
    alloc, g = float(rules["allocation_pct"]) / 100.0, float(rules["assumed_growth_pct"]) / 100.0
    paid = invested = total = 0.0
    for d, amt in contributions:
        if d > valuation or amt <= 0:
            continue
        paid += amt
        net = amt * alloc
        invested += net
        total += net * (1.0 + g) ** ((valuation - d).days / 365.0)
    return {"premiums_paid": _money(paid), "invested": _money(invested), "value": _money(total),
            "growth": _money(total - invested), "valuation_date": valuation.isoformat()}


def surrender_factor(years: int, rules: dict) -> Optional[float]:
    """% of the fund payable on surrender after `years` completed years; None below the minimum."""
    if years < int(rules["surrender_min_years"]):
        return None
    table = {int(k): float(v) for k, v in rules["surrender_factors"].items()}
    eligible = [k for k in table if k <= years]
    return table[max(eligible)] if eligible else None


def loan_balance(principal: float, annual_pct: float, disbursed_on: date, repaid: float, on: date) -> dict:
    """Simple interest to `on`; repayments reduce the total owed."""
    days = max((on - disbursed_on).days, 0)
    interest = _money(principal * annual_pct / 100.0 * days / 365.0)
    return {"interest": interest, "balance": _money(max(principal + interest - repaid, 0.0))}


def calculate_settlement(
    *, exit_type: str, valuation_date: date, contributions: list[tuple[date, float]], effective_date: Optional[date],
    sum_assured: float, rules: dict, loans: list[dict], premium_arrears: float = 0.0,
    recoverables: Optional[list[dict]] = None,
) -> dict:
    """The contractually payable amount. Pure.

    Maturity   fund value at maturity (not below the guaranteed floor, if any)
    Surrender  fund value × the surrender factor for the completed years
    otherwise  nothing is payable
    less loans (principal + interest), premium unpaid, other recoverable amounts, and tax.
    """
    fund = fund_value(contributions, valuation_date, rules)
    years = completed_years(effective_date, valuation_date)
    lines: list[dict] = []
    gross, factor, basis = 0.0, None, "No benefit is payable at the end of this policy."

    if exit_type == "Maturity":
        gross = fund["value"]
        floor = _money(sum_assured * float(rules["maturity_guarantee_pct"]) / 100.0)
        basis = "Fund value at maturity"
        lines.append({"label": "Fund value at maturity", "amount": gross})
        if floor > gross:
            lines.append({"label": f"Raised to the guaranteed minimum ({rules['maturity_guarantee_pct']:g}% of sum assured)", "amount": _money(floor - gross)})
            gross = floor
    elif exit_type == "Surrender":
        factor = surrender_factor(years, rules)
        if factor is None:
            raise ValueError(f"A policy needs {rules['surrender_min_years']} completed years before it has a surrender value (this one has {years}).")
        gross = _money(fund["value"] * factor / 100.0)
        basis = f"Surrender value — {factor:g}% of the fund after {years} completed year(s)"
        lines.append({"label": "Fund value", "amount": fund["value"]})
        lines.append({"label": f"Surrender charge ({100 - factor:g}% of the fund)", "amount": -_money(fund["value"] - gross)})

    deductions: list[dict] = []
    for ln in loans:
        deductions.append({"label": f"Policy loan {ln.get('reference') or ''} (incl. interest)".replace("  ", " ").strip(), "amount": ln["balance"],
                           "kind": "loan", "loan_id": ln.get("id")})
    if premium_arrears > 0:
        deductions.append({"label": "Premium unpaid and due", "amount": _money(premium_arrears), "kind": "arrears"})
    for r in recoverables or []:
        amt = _money(r.get("amount") or 0)
        if amt < 0:
            raise ValueError(f"'{r.get('label') or 'Recoverable amount'}' cannot be negative.")
        if (r.get("label") or "").strip() and amt > 0:
            deductions.append({"label": r["label"].strip(), "amount": amt, "kind": "recoverable", "note": r.get("note")})

    total_ded = _money(sum(d["amount"] for d in deductions))
    after = _money(gross - total_ded)
    shortfall = _money(max(-after, 0.0))
    taxable = max(after, 0.0)
    tax_pct = float(rules["withholding_pct"])
    tax = _money(taxable * tax_pct / 100.0) if tax_pct else 0.0
    net = _money(max(after - tax, 0.0))
    return {
        "exit_type": exit_type, "basis": basis, "valuation_date": valuation_date.isoformat(), "completed_years": years,
        "fund": fund, "surrender_factor": factor, "lines": lines, "gross": gross, "deductions": deductions,
        "total_deductions": total_ded, "tax_pct": tax_pct, "tax": tax, "net": net, "shortfall": shortfall,
        "payable": exit_type in BENEFIT_TYPES and net > 0,
    }


# ══════════════════════════════════════════════════════════════════════════════
# Detection, timing and eligibility (steps 1–3)
# ══════════════════════════════════════════════════════════════════════════════

def detect_exit_type(*, profile: str, is_group: bool, closed_by_claim: bool) -> str:
    """What a policy's natural end looks like. A surrender is never auto-detected — it is requested."""
    if closed_by_claim:
        return "DeathClaimClosure"
    if is_group or profile == "Group":
        return "CorporateExpiry"
    return "Maturity" if profile == "Savings" else "Expiry"


def timing(maturity_date: Optional[date], today: date, window_days: int) -> dict:
    if not maturity_date:
        return {"state": "Unknown", "days_until": None, "window_opens_on": None}
    days = (maturity_date - today).days
    state = "Reached" if days <= 0 else "InWindow" if days <= window_days else "Upcoming"
    return {"state": state, "days_until": days, "window_opens_on": maturity_date - timedelta(days=window_days)}


def check(key: str, label: str, passed: bool, detail: str, severity: str = "block") -> dict:
    return {"key": key, "label": label, "passed": passed, "detail": detail, "severity": "ok" if passed else severity}


def evaluate_eligibility_facts(
    *,
    exit_type: str,
    status: str,
    today: date,
    maturity_date: Optional[date],
    profile: str,
    effective_date: Optional[date],
    free_look_end: Optional[date],
    open_claims: int,
    open_renewal_no: Optional[str],
    open_reinstatement_no: Optional[str],
    extension_allowed: bool,
    rules: dict,
    master_expiry: Optional[date] = None,
    group_renewal_status: Optional[str] = None,
    claim_open_after_closure: int = 0,
    owner_known: bool = True,
) -> dict:
    """Is the policy eligible to leave by this route? Pure. Status Eligible | Referred | Ineligible."""
    checks: list[dict] = []
    in_force = status in IN_FORCE
    reached = bool(maturity_date and today >= maturity_date)

    if exit_type == "DeathClaimClosure":
        checks.append(check("status", "Policy already ended by the claim", status == "Cancelled",
                            "The policy was ended when the death claim was paid." if status == "Cancelled" else f"The policy is '{status}', not ended by a claim."))
        checks.append(check("claim_resolved", "Death claim fully resolved", claim_open_after_closure == 0,
                            "The claim is closed." if claim_open_after_closure == 0 else "A death claim on this policy is still being resolved in Claims Management."))
    elif exit_type == "CorporateExpiry":
        expired = bool(master_expiry and today >= master_expiry)
        checks.append(check("status", "Certificate still on the books", status in IN_FORCE or status == "Lapsed",
                            f"Certificate is {status}." if status in IN_FORCE or status == "Lapsed" else f"The certificate is '{status}'."))
        checks.append(check("master_expired", "Master policy has reached its end", expired,
                            f"The master policy expires on {master_expiry.isoformat()}." if master_expiry and not expired
                            else "The master policy has expired." if expired else "The master policy has no expiry date."))
        busy = group_renewal_status in ("Open", "Quoted", "Accepted")
        checks.append(check("renewal", "Master policy is not being renewed", not busy,
                            f"A group renewal is in progress ({group_renewal_status}) — finalise it before closing the cover." if busy
                            else "No group renewal is in progress."))
    else:
        if exit_type == "Surrender":
            checks.append(check("product", "Product has a surrender value", profile == "Savings",
                                "A savings / investment product builds a surrender value." if profile == "Savings"
                                else "This is a protection-only product: it has no cash or surrender value."))
        if exit_type in ("Maturity", "Surrender"):
            checks.append(check("status", "Policy in force", in_force,
                                "Policy is in force." if in_force else
                                "The policy has lapsed — revive it through Reinstatement (Step 6) before it can mature or be surrendered." if status == "Lapsed"
                                else f"The policy is '{status}'."))
        else:
            checks.append(check("status", "Policy can be closed", status in IN_FORCE or status == "Lapsed",
                                f"Policy is {status}." if status in IN_FORCE or status == "Lapsed" else f"The policy is '{status}'."))
        if exit_type == "Surrender":
            if free_look_end and today <= free_look_end and status == "Active":
                checks.append(check("free_look", "Outside the free-look window", False,
                                    f"The free-look window is open until {free_look_end.isoformat()} — cancel with a full refund instead of surrendering."))
            years = completed_years(effective_date, today)
            minimum = int(rules["surrender_min_years"])
            checks.append(check("min_years", f"At least {minimum} completed policy years", years >= minimum,
                                f"{years} completed year(s); surrender needs {minimum}." if years < minimum else f"{years} completed year(s)."))
            checks.append(check("not_matured", "Not yet at maturity", not reached,
                                "The policy has reached maturity — process it as a maturity." if reached else
                                f"Matures {maturity_date.isoformat()}." if maturity_date else "No maturity date on record."))
        else:
            checks.append(check("maturity", "Contractual end reached", reached,
                                f"The term ended on {maturity_date.isoformat()}." if reached else
                                f"The term ends on {maturity_date.isoformat()}; proceeds and closure are available from that date." if maturity_date
                                else "No maturity date on record.", "info"))
        checks.append(check("claims", "No claim still open on the policy", open_claims == 0,
                            "No open claim." if open_claims == 0 else
                            f"{open_claims} claim(s) are open or paid but not yet closed — resolve them in Claims Management before the policy is closed."))
        checks.append(check("reinstatement", "No reinstatement in progress", open_reinstatement_no is None,
                            "No reinstatement case is open." if open_reinstatement_no is None else f"Reinstatement {open_reinstatement_no} is open."))

    if exit_type in ("Maturity", "Surrender", "Expiry"):
        checks.append(check("extension", "No extension being finalised", open_renewal_no is None,
                            "No contract renewal is open." if open_renewal_no is None else
                            f"Contract renewal {open_renewal_no} (an approved extension) is open in Renewals — finish it before closing the policy."))
    if exit_type in BENEFIT_TYPES:
        checks.append(check("owner", "Policy owner on record", owner_known,
                            "The policyholder is on record and is the only valid payee." if owner_known else "No policyholder is recorded for this policy.", "block"))

    blockers = [c for c in checks if c["severity"] == "block"]
    reviews = [c for c in checks if c["severity"] == "review"]
    if blockers:
        status_out, message = "Ineligible", blockers[0]["detail"]
    elif reviews:
        status_out, message = "Referred", f"{len(reviews)} point(s) need an officer's attention."
    else:
        status_out, message = "Eligible", "The policy can leave by this route."
    return {"status": status_out, "message": message, "checks": checks, "blockers": blockers, "reviews": reviews,
            "maturity_reached": reached, "extension_allowed": extension_allowed}


# ══════════════════════════════════════════════════════════════════════════════
# Documents + consent (step 4)
# ══════════════════════════════════════════════════════════════════════════════

def build_documents(exit_type: str, now: Optional[datetime] = None) -> list[dict]:
    now = now or datetime.utcnow()
    return [{"key": d["key"], "label": d["label"], "required": bool(d["required"]), "when": "always", "reason": None,
             "status": "Requested", "requested_at": now.isoformat(), "received_at": None, "artifact_id": None,
             "file_name": None, "note": None} for d in cfg.EXIT_DOCUMENTS.get(exit_type, [])]


def declarations_for(exit_type: str) -> list[dict]:
    return [dict(d) for d in cfg.EXIT_DECLARATIONS.get(exit_type, [])]


def consent_complete(exit_type: str, consent: Optional[dict]) -> bool:
    wanted = declarations_for(exit_type)
    if not wanted:
        return True
    accepted = {d["key"] for d in (consent or {}).get("declarations", []) if d.get("accepted")}
    return all(d["key"] in accepted for d in wanted) and bool((consent or {}).get("by")) and bool((consent or {}).get("method"))


def needs_paperwork(exit_type: str) -> bool:
    return exit_type in BENEFIT_TYPES


# ══════════════════════════════════════════════════════════════════════════════
# Settlement controls (step 6)
# ══════════════════════════════════════════════════════════════════════════════

def needs_dual_control(net: float, rules: dict, role: str) -> bool:
    """Above the limit the person who authorises the payment may not be the one who calculated it.
    A SuperAdmin acts at platform level and is exempt."""
    return net > float(rules["dual_control_limit"]) and role != "SuperAdmin"


def reconcile_exit(*, net: float, payee_name: str, payouts: list[dict]) -> dict:
    """Compare what was disbursed with what was authorised and who was owed it."""
    total = _money(sum(p["amount"] for p in payouts))
    variance = _money(total - net)
    refs = [p.get("reference") for p in payouts if p.get("reference")]
    named = all((p.get("payee_name") or "").strip().lower() == payee_name.strip().lower() for p in payouts) if payouts else False
    checks = [
        check("payout", "Payment recorded", bool(payouts), "No payment has been recorded." if not payouts else f"{len(payouts)} payment(s) recorded."),
        check("amount", "Amount paid equals the settlement", abs(variance) < 0.01,
              f"Paid PKR {total:,.2f} against PKR {net:,.2f} due." + (f" Variance {variance:+,.2f}." if abs(variance) >= 0.01 else "")),
        check("payee", "Paid to the verified policyholder", named, "Paid to the verified payee." if named else "The payee on the payment differs from the verified payee."),
        check("reference", "Unique payment reference", bool(payouts) and len(refs) == len(payouts) == len(set(refs)),
              "Every payment has its own reference." if payouts and len(refs) == len(payouts) == len(set(refs)) else "A payment reference is missing or repeated."),
        check("status", "Payment settled", bool(payouts) and all(p.get("status") == "Settled" for p in payouts),
              "Settled." if payouts and all(p.get("status") == "Settled" for p in payouts) else "A payment is not in Settled status."),
    ]
    blockers = [c for c in checks if c["severity"] == "block"]
    return {"status": "Matched" if not blockers else "Exception", "net": _money(net), "paid": total, "variance": variance,
            "checks": checks, "checked_at": datetime.utcnow().isoformat()}


# ══════════════════════════════════════════════════════════════════════════════
# Stage projection (7 steps)
# ══════════════════════════════════════════════════════════════════════════════

def _stage(n: int, key: str, title: str, state: str, label: str, detail: str = "") -> dict:
    return {"n": n, "key": key, "title": title, "state": state, "label": label, "detail": detail}


def project_stages(case: PolicyExit) -> list[dict]:
    """The seven steps. States: complete | action | pending | exception | skipped | not_started."""
    t = case.exit_type
    benefit = t in BENEFIT_TYPES
    st = case.status
    closed = st == "Completed"
    dead = st in ("Declined", "Cancelled")
    elig = case.eligibility_status
    ineligible = elig == "Ineligible"
    docs = claim_engine.documents_progress(case.documents_json)
    paperwork_done = (docs["complete"] or not (case.documents_json or [])) and consent_complete(t, case.consent_json)
    s = (case.settlement_json or {})
    nil = benefit and case.calculated_at is not None and not s.get("payable")
    rows = []

    rows.append(_stage(1, "identify", "Identify upcoming maturity" if t != "Surrender" else "Identify surrender request", "complete", "Identified",
                       f"{TYPE_LABELS[t]}" + (f" · matures {case.maturity_date.isoformat()}" if case.maturity_date and t != "Surrender" else "")))

    ext = case.extension_decision
    ext_json = case.extension_json or {}
    if t in ("CorporateExpiry", "DeathClaimClosure"):
        rows.append(_stage(2, "extension", "Check renewal or extension", "skipped", "Not applicable",
                           "Group renewals run at master-policy level" if t == "CorporateExpiry" else "The policy ended with the claim"))
    elif ext_json.get("open_renewal_no") and not closed:
        rows.append(_stage(2, "extension", "Check renewal or extension", "exception", "Extension in progress", f"Renewals case {ext_json['open_renewal_no']} must be finished first"))
    elif ext in ("NotApplicable", "Declined"):
        rows.append(_stage(2, "extension", "Check renewal or extension", "complete", "No extension" if ext == "NotApplicable" else "Extension declined",
                           "The product has no extension option" if ext == "NotApplicable" else (case.extension_json or {}).get("note", "")))
    elif ext == "Redirected":
        rows.append(_stage(2, "extension", "Check renewal or extension", "exception", "Sent to Renewals", ""))
    else:
        rows.append(_stage(2, "extension", "Check renewal or extension", "action", "Confirm no extension", "The product permits an extension"))

    if elig is None:
        rows.append(_stage(3, "eligibility", "Verify eligibility & financials", "pending", "Pending", ""))
    elif ineligible:
        rows.append(_stage(3, "eligibility", "Verify eligibility & financials", "exception", "Not eligible", (case.eligibility_json or {}).get("message", "")))
    else:
        rows.append(_stage(3, "eligibility", "Verify eligibility & financials", "complete", "Verified" if elig == "Eligible" else "Verified · review points", ""))

    if not benefit:
        rows.append(_stage(4, "documents", "Collect documents & consent", "skipped", "Not required", "No payment is made"))
    elif ineligible or elig is None:
        rows.append(_stage(4, "documents", "Collect documents & consent", "not_started", "Not started", ""))
    elif paperwork_done:
        rows.append(_stage(4, "documents", "Collect documents & consent", "complete", "Complete", f"{docs['received']} of {docs['required']} documents · consent recorded"))
    else:
        rows.append(_stage(4, "documents", "Collect documents & consent", "action", "Awaiting documents / consent",
                           f"{docs['received']} of {docs['required']} documents" + ("" if consent_complete(t, case.consent_json) else " · consent outstanding")))

    if not benefit:
        rows.append(_stage(5, "settlement", "Calculate final settlement", "skipped", "No benefit payable", ""))
    elif case.accepted_at:
        rows.append(_stage(5, "settlement", "Calculate final settlement", "complete", "Accepted", f"Net PKR {case.net_payable:,.0f}"))
    elif st == "Declined":
        rows.append(_stage(5, "settlement", "Calculate final settlement", "exception", "Declined by the customer", case.closed_reason or ""))
    elif case.calculated_at:
        rows.append(_stage(5, "settlement", "Calculate final settlement", "action", "Awaiting acceptance", f"Net PKR {case.net_payable:,.0f}"))
    elif paperwork_done and not ineligible:
        rows.append(_stage(5, "settlement", "Calculate final settlement", "action", "Calculate settlement", ""))
    else:
        rows.append(_stage(5, "settlement", "Calculate final settlement", "not_started", "Not started", ""))

    if not benefit:
        rows.append(_stage(6, "disbursement", "Authorize & disburse", "skipped", "Not applicable", ""))
    elif nil and case.accepted_at:
        rows.append(_stage(6, "disbursement", "Authorize & disburse", "skipped", "Nothing to pay", "Deductions absorb the whole value"))
    elif case.reconciled_at:
        rows.append(_stage(6, "disbursement", "Authorize & disburse", "complete", "Paid & reconciled", f"PKR {case.net_payable:,.0f}"))
    elif case.disbursed_at:
        rows.append(_stage(6, "disbursement", "Authorize & disburse", "action", "Reconcile payment", ""))
    elif case.authorized_at:
        rows.append(_stage(6, "disbursement", "Authorize & disburse", "action", "Disburse", f"Authorised PKR {case.net_payable:,.0f}"))
    elif case.accepted_at:
        rows.append(_stage(6, "disbursement", "Authorize & disburse", "action", "Verify payee" if not case.payee_verified_at else "Authorize", ""))
    else:
        rows.append(_stage(6, "disbursement", "Authorize & disburse", "not_started", "Not started", ""))

    ready = (case.reconciled_at or (nil and case.accepted_at) or not benefit) and not ineligible and elig is not None and not dead
    if closed:
        rows.append(_stage(7, "closure", "Close policy & archive", "complete", "Closed", f"Policy {FINAL_STATUS.get(t, 'closed')}".strip()))
    elif dead:
        rows.append(_stage(7, "closure", "Close policy & archive", "exception", st, case.closed_reason or ""))
    elif ready:
        rows.append(_stage(7, "closure", "Close policy & archive", "action", "Ready to close", ""))
    else:
        rows.append(_stage(7, "closure", "Close policy & archive", "not_started", "Not started", ""))
    return rows


# ══════════════════════════════════════════════════════════════════════════════
# Async fact gathering
# ══════════════════════════════════════════════════════════════════════════════

async def get_open_case(session: AsyncSession, policy_id: UUID) -> Optional[PolicyExit]:
    return (await session.exec(select(PolicyExit).where(PolicyExit.policy_id == policy_id, PolicyExit.status == "Open")
                               .order_by(PolicyExit.created_at.desc()))).first()  # type: ignore[arg-type]


async def contributions(session: AsyncSession, policy_id: UUID) -> list[tuple[date, float]]:
    rows = (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy_id))).all()
    out = []
    for r in rows:
        if _v(r.status) == PremiumScheduleStatusEnum.WAIVED.value or (r.amount_paid or 0) <= 0:
            continue
        out.append(((r.paid_at.date() if r.paid_at else r.due_date), float(r.amount_paid)))
    return sorted(out)


async def loans_on(session: AsyncSession, policy_id: UUID, on: date) -> list[dict]:
    rows = (await session.exec(select(PolicyLoan).where(PolicyLoan.policy_id == policy_id,
                                                        PolicyLoan.status == "Outstanding"))).all()
    out = []
    for ln in rows:
        b = loan_balance(ln.principal, ln.annual_interest_pct, ln.disbursed_on, ln.repaid_amount, on)
        out.append({"id": str(ln.id), "reference": ln.reference, "principal": ln.principal, "annual_interest_pct": ln.annual_interest_pct,
                    "disbursed_on": ln.disbursed_on.isoformat(), "repaid": ln.repaid_amount, **b})
    return out


async def premium_arrears_on(session: AsyncSession, policy_id: UUID, on: date) -> float:
    rows = (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy_id))).all()
    return _money(sum(max(r.amount_due - r.amount_paid, 0.0) for r in rows
                      if _v(r.status) in (PremiumScheduleStatusEnum.PENDING.value, PremiumScheduleStatusEnum.OVERDUE.value) and r.due_date <= on))


async def open_claims_count(session: AsyncSession, policy_id: UUID) -> int:
    claims = (await session.exec(select(Claim).where(Claim.policy_id == policy_id))).all()
    return sum(1 for c in claims if (c.status if isinstance(c.status, ClaimStatusEnum) else ClaimStatusEnum(c.status)) in _OPEN_CLAIM_STATUSES)


async def closed_by_claim(session: AsyncSession, policy_id: UUID) -> Optional[dict]:
    ev = (await session.exec(select(PolicyEvent).where(PolicyEvent.policy_id == policy_id, PolicyEvent.event_type == "PolicyTerminatedByClaim")
                             .order_by(PolicyEvent.created_at.desc()))).first()  # type: ignore[arg-type]
    return {"claim_no": (ev.detail_json or {}).get("claim_no"), "at": ev.created_at, "benefit_paid": (ev.detail_json or {}).get("benefit_paid"),
            "category": (ev.detail_json or {}).get("category")} if ev else None


async def master_facts(session: AsyncSession, policy: Policy) -> dict:
    if not policy.master_policy_id:
        return {}
    mp = await session.get(MasterPolicy, policy.master_policy_id)
    latest = (await session.exec(select(GroupRenewal).where(GroupRenewal.master_policy_id == policy.master_policy_id)
                                 .order_by(GroupRenewal.created_at.desc()))).first()  # type: ignore[arg-type]
    return {"master_id": str(policy.master_policy_id), "organization_id": str(mp.organization_id) if mp else None,
            "master_number": mp.policy_number if mp else None, "master_expiry": mp.expiry_date if mp else None,
            "master_status": mp.status if mp else None, "renewal_status": latest.status if latest else None}
