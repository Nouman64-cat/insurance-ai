"""
Pre-underwriting insurance-history screen — anti-selection & over-insurance.

Compliance screening (compliance_engine.py) asks "is this person allowed to be
insured?". This module asks the other pre-underwriting question: "is this person
*already* insured, and does the total add up?" Three distinct risks hide there:

  • Over-insurance — aggregate cover across all insurers exceeding what the
    life's income can justify (the Human Life Value ceiling). The classic
    moral-hazard signature, and the reason insurers exchange sum-assured data.
  • Replacement / churning — a fresh proposal taken out while an equivalent
    policy is being lapsed or surrendered, usually agent-driven, which costs
    the customer their accrued values and the insurer its acquisition cost.
  • Non-disclosure — policies this insurer can see on its own books that the
    proposer omitted from the E-Application's existing-insurance declaration.
    A misstatement here voids the contract, so it must surface before issue,
    not at claim stage.

Two data sources are reconciled:
  1. INTERNAL — every other Policy row this tenant holds for the customer.
     Authoritative: it is our own book.
  2. EXTERNAL — the other-insurer policies the proposer declared on their
     E-Application (`CustomerEApplication.existing_insurance`). Self-reported.

Pakistan has no live central life-insurance register to query (unlike motor's
IMEI-style checks), so the external leg is declaration-based, exactly as it is
at Adamjee/EFU/Jubilee today. The module is written so that when an industry
bureau feed does become available it drops in as a third source without any
change to the scoring or the callers — see `_external_from_declaration`.

Returns a plain dict; routers/insurance_history.py persists it onto an
InsuranceHistoryCheck row. Deterministic: the same inputs always produce the
same finding set, so seeded demo customers exercise the flag → clear path
reliably.
"""

from __future__ import annotations

from typing import Any, Optional
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from services.underwriting_limits import age_from_dob, hlv_limit, hlv_multiple
from shared.models.core import (
    Customer,
    CustomerEApplication,
    InsuranceHistoryStatusEnum,
    Policy,
    PolicyStatusEnum,
)

# Policy statuses that represent cover actually at risk right now — these are
# the ones that aggregate against the Human Life Value ceiling.
_IN_FORCE_STATUSES = {
    PolicyStatusEnum.ACTIVE,
    PolicyStatusEnum.ISSUED,
    PolicyStatusEnum.GRACE_PERIOD,
    PolicyStatusEnum.PENDING_PAYMENT,
}
# Applications still moving through the funnel — not yet cover, but they will
# be, so an underwriter must see them when sizing total exposure.
_PIPELINE_STATUSES = {
    PolicyStatusEnum.PROPOSED,
    PolicyStatusEnum.UNDER_REVIEW,
    PolicyStatusEnum.INFORMATION_REQUESTED,
    PolicyStatusEnum.COUNTER_OFFER,
    PolicyStatusEnum.APPROVED,
    PolicyStatusEnum.ACCEPTED_WITH_LOADINGS,
    PolicyStatusEnum.REINSURER_REFERRED,
    PolicyStatusEnum.POSTPONED,
}
_ADVERSE_STATUSES = {PolicyStatusEnum.DECLINED}
_TERMINATED_STATUSES = {
    PolicyStatusEnum.LAPSED,
    PolicyStatusEnum.CANCELLED,
    PolicyStatusEnum.NOT_TAKEN_UP,
}

# Score thresholds — mirrors compliance_engine's flag/fail convention so the
# two pre-underwriting screens read the same way in the UI.
_FLAG_THRESHOLD = 40.0
_FAIL_THRESHOLD = 85.0


def _v(x: Any) -> str:
    return x.value if hasattr(x, "value") else str(x)


def _num(x: Any) -> float:
    """Coerce a declared amount to a float. The E-Application captures sums
    assured as free text ("2,500,000", "25 lac"), so anything unparseable is
    counted as zero rather than crashing the screen."""
    if x is None:
        return 0.0
    if isinstance(x, (int, float)):
        return float(x)
    cleaned = "".join(ch for ch in str(x) if ch.isdigit() or ch == ".")
    try:
        return float(cleaned) if cleaned else 0.0
    except ValueError:
        return 0.0


async def _internal_policies(
    session: AsyncSession,
    tenant_id: UUID,
    customer_id: UUID,
    exclude_policy_id: Optional[UUID],
) -> list[dict]:
    """Every other policy this insurer already holds for the customer."""
    stmt = (
        select(Policy)
        .where(Policy.tenant_id == tenant_id, Policy.customer_id == customer_id)
        .order_by(Policy.created_at.desc())  # type: ignore[arg-type]
    )
    rows = (await session.exec(stmt)).all()

    out: list[dict] = []
    for p in rows:
        if exclude_policy_id and p.id == exclude_policy_id:
            continue
        status = p.status if isinstance(p.status, PolicyStatusEnum) else PolicyStatusEnum(_v(p.status))
        if status in _IN_FORCE_STATUSES:
            bucket = "InForce"
        elif status in _PIPELINE_STATUSES:
            bucket = "Pipeline"
        elif status in _ADVERSE_STATUSES:
            bucket = "Declined"
        elif status in _TERMINATED_STATUSES:
            bucket = "Terminated"
        else:
            bucket = "Other"

        out.append({
            "source": "internal",
            "policy_id": str(p.id),
            "policy_number": p.policy_number,
            "insurer": "This insurer",
            "product": p.product_name,
            "sum_assured": float(p.coverage_amount or 0),
            "term_years": p.term_years,
            "status": _v(status),
            "bucket": bucket,
            "effective_date": p.effective_date.isoformat() if p.effective_date else None,
            "created_at": p.created_at.isoformat() if p.created_at else None,
        })
    return out


def _external_from_declaration(e_app: Optional[CustomerEApplication]) -> tuple[list[dict], dict]:
    """Parse the proposer's self-declared other-insurer cover.

    Returns (policies, declaration_flags). This is the seam an industry bureau
    feed would plug into later — callers only ever see the normalised list.
    """
    if e_app is None or not e_app.existing_insurance:
        return [], {
            "declared": False,
            "has_existing_policies": None,
            "applied_last_2_years": None,
            "was_declined_or_deferred": None,
            "declined_details": None,
        }

    decl = e_app.existing_insurance or {}
    raw = decl.get("policies") or []
    policies: list[dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        policies.append({
            "source": "external_declared",
            "insurer": (entry.get("insurer_name") or "Undisclosed insurer").strip(),
            "policy_number": (entry.get("policy_number") or "").strip() or None,
            "product": entry.get("product") or None,
            "sum_assured": _num(entry.get("sum_assured")),
            "status": entry.get("status") or "Unknown",
            "bucket": "InForce" if (entry.get("status") or "Active") == "Active" else "Terminated",
        })

    flags = {
        "declared": True,
        "has_existing_policies": bool(decl.get("has_existing_policies")),
        "applied_last_2_years": bool(decl.get("applied_last_2_years")),
        "was_declined_or_deferred": bool(decl.get("was_declined_or_deferred")),
        "declined_details": (decl.get("declined_details") or "").strip() or None,
    }
    return policies, flags


async def screen(
    session: AsyncSession,
    *,
    tenant_id: UUID,
    customer: Customer,
    policy: Optional[Policy],
    e_app: Optional[CustomerEApplication] = None,
) -> dict:
    """Run the full insurance-history screen for one pre-underwriting case."""
    age = age_from_dob(customer.dob)
    proposed_sa = float(policy.coverage_amount or 0) if policy else 0.0

    internal = await _internal_policies(
        session, tenant_id, customer.id, policy.id if policy else None
    )
    external, decl_flags = _external_from_declaration(e_app)

    internal_inforce = sum(p["sum_assured"] for p in internal if p["bucket"] == "InForce")
    internal_pipeline = sum(p["sum_assured"] for p in internal if p["bucket"] == "Pipeline")
    external_inforce = sum(p["sum_assured"] for p in external if p["bucket"] == "InForce")

    aggregate = proposed_sa + internal_inforce + internal_pipeline + external_inforce

    hlv_cap = hlv_limit(customer.declared_income, age)
    ratio = round(aggregate / hlv_cap, 2) if hlv_cap else None

    findings: list[dict] = []
    score = 0.0

    def add(severity: str, code: str, message: str, points: float) -> None:
        nonlocal score
        score += points
        findings.append({"severity": severity, "code": code, "message": message, "points": points})

    # ── Prior adverse decisions on our own book ──────────────────────────────
    prior_declines = [p for p in internal if p["bucket"] == "Declined"]
    if prior_declines:
        add(
            "critical", "PRIOR_DECLINE",
            f"{len(prior_declines)} previous proposal(s) with this insurer were declined — "
            "the original decline reason must be reviewed before re-offering terms.",
            60,
        )

    # A decline elsewhere is the single most predictive disclosure in financial
    # underwriting; it is asked precisely because the applicant is unlikely to
    # volunteer it otherwise.
    if decl_flags.get("was_declined_or_deferred"):
        add(
            "critical", "EXTERNAL_DECLINE",
            "Applicant declared a previous decline/deferral by another insurer"
            + (f": {decl_flags['declined_details']}" if decl_flags.get("declined_details") else "")
            + " — obtain the other insurer's reason before proceeding.",
            50,
        )

    # ── Over-insurance against Human Life Value ──────────────────────────────
    if hlv_cap is None:
        add(
            "warning", "NO_INCOME",
            "No declared income on file — the aggregate sum assured cannot be justified "
            "against a Human Life Value ceiling. Financial underwriting evidence required.",
            25,
        )
    elif ratio is not None and ratio > 1.5:
        add(
            "critical", "OVER_INSURED",
            f"Aggregate cover PKR {aggregate:,.0f} is {ratio:.1f}× the Human Life Value ceiling of "
            f"PKR {hlv_cap:,.0f} ({hlv_multiple(age):.0f}× declared income) — materially over-insured.",
            55,
        )
    elif ratio is not None and ratio > 1.0:
        add(
            "warning", "AT_HLV_CEILING",
            f"Aggregate cover PKR {aggregate:,.0f} exceeds the Human Life Value ceiling of "
            f"PKR {hlv_cap:,.0f} — financial justification required for the excess.",
            30,
        )

    # ── Replacement / churning ───────────────────────────────────────────────
    lapsing_external = [
        p for p in external
        if str(p.get("status", "")).lower() in ("lapsed", "surrendered")
    ]
    replacement_suspected = bool(lapsing_external)
    if replacement_suspected:
        add(
            "warning", "REPLACEMENT",
            f"{len(lapsing_external)} declared other-insurer policy(ies) are lapsed/surrendered while "
            "this proposal is being taken out — possible replacement (churning). "
            "A replacement disclosure form is required.",
            25,
        )

    recently_terminated = [p for p in internal if p["bucket"] == "Terminated"]
    has_prior_lapse = bool(recently_terminated)
    if has_prior_lapse:
        add(
            "info", "PRIOR_LAPSE",
            f"{len(recently_terminated)} previous policy(ies) with this insurer lapsed, were cancelled, "
            "or were not taken up — check persistency before granting full commission terms.",
            10,
        )

    # ── Non-disclosure: our own book vs what they declared ───────────────────
    material_internal = [p for p in internal if p["bucket"] in ("InForce", "Pipeline")]
    non_disclosure = bool(
        material_internal
        and decl_flags.get("declared")
        and not decl_flags.get("has_existing_policies")
    )
    if non_disclosure:
        add(
            "critical", "NON_DISCLOSURE",
            f"Applicant declared no existing insurance, but {len(material_internal)} policy(ies) are "
            "on this insurer's own books — a material misstatement that voids the contract if not "
            "resolved before issue.",
            45,
        )

    # ── Stacking on our own book ─────────────────────────────────────────────
    if len(material_internal) >= 3:
        add(
            "warning", "MULTIPLE_POLICIES",
            f"{len(material_internal)} concurrent policies with this insurer — review aggregate "
            "retention and cumulative exposure on this single life.",
            20,
        )

    if not findings:
        findings.append({
            "severity": "info", "code": "CLEAR",
            "message": "No prior declines, no over-insurance against Human Life Value, "
                       "no replacement or non-disclosure indicators.",
            "points": 0,
        })

    score = min(score, 100.0)
    if score >= _FAIL_THRESHOLD:
        status = InsuranceHistoryStatusEnum.FAILED
    elif score >= _FLAG_THRESHOLD:
        status = InsuranceHistoryStatusEnum.FLAGGED
    else:
        status = InsuranceHistoryStatusEnum.CLEAR

    return {
        "status": status.value,
        "score": round(score, 1),
        "age": age,
        "proposed_sum_assured": round(proposed_sa, 2),
        "internal_inforce_sum_assured": round(internal_inforce + internal_pipeline, 2),
        "external_declared_sum_assured": round(external_inforce, 2),
        "aggregate_sum_assured": round(aggregate, 2),
        "hlv_limit": hlv_cap,
        "hlv_ratio": ratio,
        "hlv_multiple": hlv_multiple(age),
        "has_prior_decline": bool(prior_declines) or bool(decl_flags.get("was_declined_or_deferred")),
        "has_prior_lapse": has_prior_lapse,
        "replacement_suspected": replacement_suspected,
        "non_disclosure_suspected": non_disclosure,
        "internal_policies": internal,
        "external_policies": external,
        "declaration_flags": decl_flags,
        "findings": findings,
        "thresholds": {"flag": _FLAG_THRESHOLD, "fail": _FAIL_THRESHOLD},
        "e_application_available": e_app is not None,
    }
