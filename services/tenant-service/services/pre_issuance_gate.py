"""
Stage A readiness — the single source of truth for "can this policy be issued?".

Both the pre-issuance UI (GET /pre-issuance) and the issuance endpoint
(policies.issue_policy) call ``compute_readiness`` so the checklist the user sees
and the gate the server enforces can never drift apart.

Kept free of any router imports so both routers can depend on it without a cycle.

Gate rules for the ISSUE action (drafting the contract → PENDING_PAYMENT):
  • no counter-offer still Pending (revised terms must be accepted/declined),
  • every PolicyRequirement is Verified or Waived,
  • all three ComplianceChecks (AML / Sanctions / SECP) are Passed or cleared,
  • beneficiaries exist and their shares sum to 100%,
  • any facultative reinsurance cession is placed — the excess over retention
    must sit with a reinsurer before this insurer writes the cover.

For DEMO mode, compliance and beneficiary gates are downgraded to "warnings" —
the issue still proceeds but the UI shows an orange alert explaining these would
block a real issuance.

Premium collection (step 3) and document generation (step 6) happen at/after the
draft, so they are reported as steps but are not issue blockers.
"""

from __future__ import annotations

from typing import Optional
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import (
    Beneficiary,
    ComplianceCheck,
    ComplianceCheckTypeEnum,
    ComplianceStatusEnum,
    CounterOffer,
    CounterOfferStatusEnum,
    Customer,
    Policy,
    PolicyDocument,
    PolicyRequirement,
    PremiumSchedule,
    PremiumScheduleStatusEnum,
    ReinsuranceReferral,
    ReinsuranceReferralStatusEnum,
    RequirementStatusEnum,
)
from services.underwriting_limits import age_from_dob, compute_cession

_REQUIRED_COMPLIANCE = {
    ComplianceCheckTypeEnum.AML.value,
    ComplianceCheckTypeEnum.SANCTIONS.value,
    ComplianceCheckTypeEnum.SECP.value,
}


def _v(x) -> str:
    return x.value if hasattr(x, "value") else str(x)


async def _reinsurance_step(
    session: AsyncSession, policy: Policy, warnings: list[str]
) -> tuple[dict, bool]:
    """Whether this policy's cession is placed.

    Read from the same limit book the referral router uses, so the checklist can
    never disagree with what the underwriter was asked to place. Like compliance
    and beneficiaries above, an unplaced cession is downgraded to a warning in
    DEMO mode and recorded in demo_bypass_flags rather than blocking the issue.
    """
    customer = await session.get(Customer, policy.customer_id)
    cession = compute_cession(
        float(policy.coverage_amount or 0),
        age_from_dob(customer.dob) if customer else None,
    )

    referral = (await session.exec(
        select(ReinsuranceReferral)
        .where(ReinsuranceReferral.policy_id == policy.id)
        .order_by(ReinsuranceReferral.created_at.desc())  # type: ignore[arg-type]
    )).first()

    if not cession["referral_required"]:
        return {
            "status": "not_required",
            "retention_limit": cession["retention_limit"],
            "automatic_capacity": cession["automatic_capacity"],
            "retained_amount": cession["retained_amount"],
            "treaty_ceded_amount": cession["treaty_ceded_amount"],
            "facultative_ceded_amount": 0.0,
            "referral": None,
        }, False

    ref_status = _v(referral.status) if referral else None
    placed = bool(
        referral
        and referral.terms_applied
        and ref_status == ReinsuranceReferralStatusEnum.ACCEPTED.value
    )

    if placed:
        status = "placed"
    elif referral is None:
        status = "not_referred"
    elif ref_status == ReinsuranceReferralStatusEnum.DECLINED.value:
        status = "declined"
    else:
        status = "pending"

    bypassed = not placed
    if bypassed:
        warnings.append(
            f"Facultative cession of PKR {cession['facultative_ceded_amount']:,.0f} above the "
            f"retention of PKR {cession['retention_limit']:,.0f} is not placed "
            f"({status.replace('_', ' ')}) — demo bypass, required in production"
        )

    return {
        "status": status,
        "retention_limit": cession["retention_limit"],
        "automatic_capacity": cession["automatic_capacity"],
        "retained_amount": cession["retained_amount"],
        "treaty_ceded_amount": cession["treaty_ceded_amount"],
        "facultative_ceded_amount": cession["facultative_ceded_amount"],
        "referral": (
            {
                "id": str(referral.id),
                "status": ref_status,
                "reinsurer_decision": _v(referral.reinsurer_decision),
                "terms_applied": referral.terms_applied,
            }
            if referral else None
        ),
    }, bypassed


async def compute_readiness(session: AsyncSession, policy: Policy) -> dict:
    pid = policy.id

    offers = (await session.exec(
        select(CounterOffer).where(CounterOffer.policy_id == pid)
        .order_by(CounterOffer.created_at.desc())  # type: ignore[arg-type]
    )).all()
    reqs = (await session.exec(select(PolicyRequirement).where(PolicyRequirement.policy_id == pid))).all()
    checks = (await session.exec(select(ComplianceCheck).where(ComplianceCheck.policy_id == pid))).all()
    bens = (await session.exec(select(Beneficiary).where(Beneficiary.policy_id == pid))).all()
    schedules = (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == pid))).all()
    docs = (await session.exec(select(PolicyDocument).where(PolicyDocument.policy_id == pid))).all()

    blockers: list[str] = []
    warnings: list[str] = []  # soft alerts — shown in UI but do not block issuance

    # ── Step 1 — Revised terms (counter-offer) ────────────────────────────────
    latest_offer = offers[0] if offers else None
    if latest_offer is None:
        revised = {"status": "not_required", "offer": None}
    else:
        ost = _v(latest_offer.status)
        revised = {"status": ost.lower(), "offer": {"id": str(latest_offer.id),
                   "offer_type": _v(latest_offer.offer_type), "valid_until": latest_offer.valid_until.isoformat()}}
        if latest_offer.status == CounterOfferStatusEnum.PENDING:
            blockers.append("Revised terms awaiting customer acceptance")

    # ── Step 2 — Requirements ─────────────────────────────────────────────────
    cleared_req = [r for r in reqs if r.status in (RequirementStatusEnum.VERIFIED, RequirementStatusEnum.WAIVED)]
    outstanding = [r for r in reqs if r not in cleared_req]
    requirements = {
        "status": "none" if not reqs else ("complete" if not outstanding else "incomplete"),
        "total": len(reqs), "cleared": len(cleared_req),
        "outstanding": [r.label for r in outstanding],
    }
    requirement_bypassed = False
    if outstanding:
        warnings.append(f"{len(outstanding)} requirement(s) not yet cleared (demo bypass — required in production)")
        requirement_bypassed = True

    # ── Step 3 — First premium (post-draft; informational) ────────────────────
    paid = [s for s in schedules if s.status == PremiumScheduleStatusEnum.PAID]
    premium = {
        "status": "paid" if paid else ("pending" if schedules else "none"),
        "total": len(schedules), "paid": len(paid),
    }

    # ── Step 4 — Compliance (AML / Sanctions / SECP) ──────────────────────────
    by_type = {_v(c.check_type): c for c in checks}
    missing = _REQUIRED_COMPLIANCE - set(by_type)
    bad = [c for c in checks if c.status in (ComplianceStatusEnum.FLAGGED, ComplianceStatusEnum.FAILED)]
    compliance_bypassed = False  # would this gate block a real (non-demo) issuance?
    if missing:
        comp_status = "not_run"
        # DEMO: downgraded from hard blocker to warning
        warnings.append("Compliance screening not yet run (demo bypass — required in production)")
        compliance_bypassed = True
    elif bad:
        comp_status = "flagged"
        # DEMO: downgraded from hard blocker to warning
        warnings.append(f"{len(bad)} compliance check(s) need clearance (demo bypass — required in production)")
        compliance_bypassed = True
    else:
        comp_status = "clear"
    compliance = {
        "status": comp_status,
        "checks": [{"id": str(c.id), "check_type": _v(c.check_type), "status": _v(c.status),
                    "score": c.score} for c in checks],
    }

    # ── Step 5 — Beneficiaries (Σ share = 100) ────────────────────────────────
    total_share = round(sum(b.share_pct for b in bens), 2)
    ben_valid = bool(bens) and abs(total_share - 100.0) < 0.01
    beneficiaries = {
        "status": "valid" if ben_valid else ("invalid" if bens else "none"),
        "total_share": total_share, "count": len(bens),
    }
    beneficiary_bypassed = not ben_valid  # would this gate block a real issuance?
    if not ben_valid:
        # DEMO: downgraded from hard blocker to warning
        warnings.append("Beneficiaries must be captured and sum to 100% (demo bypass — required in production)")

    # ── Step 6 — Documents (produced at draft; informational pre-issue) ───────
    non_stub = [d for d in docs if not d.is_stub]
    documents = {
        "status": "ready" if (docs and len(non_stub) == len(docs)) else ("incomplete" if docs else "none"),
        "total": len(docs), "generated": len(non_stub),
    }

    # ── Step 7 — Reinsurance cession (post-underwriting, pre-issue) ───────────
    # Cover written above retention with the excess unplaced leaves the insurer
    # carrying a risk it never intended to hold net, so this is a real gate —
    # but it only bites on policies that actually breach automatic capacity.
    reinsurance, reinsurance_bypassed = await _reinsurance_step(session, policy, warnings)

    # Which mandatory gates are being waved through in DEMO mode. Persisted onto
    # the policy at issuance so Stage B (and audit) knows what to backfill before
    # this contract can be treated as production-grade.
    demo_flags = []
    if compliance_bypassed: demo_flags.append("ComplianceBypassed")
    if beneficiary_bypassed: demo_flags.append("BeneficiaryBypassed")
    if requirement_bypassed: demo_flags.append("RequirementBypassed")
    if reinsurance_bypassed: demo_flags.append("ReinsuranceBypassed")
    demo_bypass_flags = ",".join(demo_flags) if demo_flags else "NotFlagged"

    return {
        "policy_id": str(pid),
        "status": _v(policy.status),
        "demo_bypass_flags": demo_bypass_flags,
        "steps": {
            "revised_terms": revised,
            "requirements": requirements,
            "premium": premium,
            "compliance": compliance,
            "beneficiaries": beneficiaries,
            "documents": documents,
            "reinsurance": reinsurance,
        },
        "ready_to_issue": len(blockers) == 0,  # warnings alone do NOT block
        "blockers": blockers,
        "warnings": warnings,  # demo-only soft alerts shown to user but not enforced
    }


class NotReadyToIssue(Exception):
    """Raised by assert_ready_to_issue when a Stage A gate is unmet."""

    def __init__(self, blockers: list[str]):
        self.blockers = blockers
        super().__init__("; ".join(blockers))


async def assert_ready_to_issue(session: AsyncSession, policy: Policy) -> dict:
    readiness = await compute_readiness(session, policy)
    if not readiness["ready_to_issue"]:
        raise NotReadyToIssue(readiness["blockers"])
    return readiness
