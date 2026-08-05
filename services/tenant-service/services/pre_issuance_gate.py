"""
Stage A readiness — the single source of truth for "can this policy be issued?".

Both the pre-issuance UI (GET /pre-issuance) and the issuance endpoint
(policies.issue_policy) call ``compute_readiness`` so the checklist the user sees
and the gate the server enforces can never drift apart.

Kept free of any router imports so both routers can depend on it without a cycle.

Gate rules for the ISSUE action (drafting the contract → PENDING_PAYMENT).

In production every one of these is a hard blocker:
  • no counter-offer still Pending (revised terms must be accepted/declined),
  • every PolicyRequirement is Verified or Waived,
  • all three ComplianceChecks (AML / Sanctions / SECP) are Passed or cleared,
  • beneficiaries exist and their shares sum to 100%,
  • any facultative reinsurance cession is placed — the excess over retention
    must sit with a reinsurer before this insurer writes the cover.

In DEMO mode (the default — see DEMO_MODE below) only the first is enforced.
The other FOUR — requirements, compliance, beneficiaries and reinsurance — are
downgraded to warnings: the issue proceeds, the UI shows an orange alert, and
each bypass is recorded in ``demo_bypass_flags`` on the policy so Stage B and
audit know what still needs backfilling.

Set DEMO_MODE=false to enforce all five, which is what a real deployment does.
(The docstring here used to describe all five as enforced while the code only
ever blocked on the counter-offer, and mentioned the demo downgrade for two of
the four gates that are actually downgraded.)

Premium collection (step 3) and document generation (step 6) happen at/after the
draft, so they are reported as steps but are not issue blockers.
"""

from __future__ import annotations

import os

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
    ReinsurerDecisionEnum,
    RequirementStatusEnum,
)
from services import compliance_engine
from services.underwriting_limits import age_from_dob, compute_cession

# Whether the four mandatory-but-demo-bypassed gates block an issue. Defaults to
# demo behaviour (warnings only) to preserve the existing walkthrough; set
# DEMO_MODE=false in a real deployment so requirements, compliance,
# beneficiaries and reinsurance become hard blockers like the counter-offer.
DEMO_MODE: bool = os.environ.get("DEMO_MODE", "true").lower() not in ("false", "0", "no")


def _gate(blockers: list[str], warnings: list[str], message: str) -> bool:
    """Record an unmet mandatory gate and report whether it was bypassed.

    In production it lands in ``blockers`` and stops the issue; in demo mode it
    lands in ``warnings`` and is flagged on the policy instead.
    """
    if DEMO_MODE:
        warnings.append(f"{message} (demo bypass — required in production)")
        return True
    blockers.append(message)
    return False

_REQUIRED_COMPLIANCE = {
    ComplianceCheckTypeEnum.AML.value,
    ComplianceCheckTypeEnum.SANCTIONS.value,
    ComplianceCheckTypeEnum.SECP.value,
}


def _v(x) -> str:
    return x.value if hasattr(x, "value") else str(x)


async def _reinsurance_step(
    session: AsyncSession, policy: Policy, blockers: list[str], warnings: list[str]
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
    ref_decision = _v(referral.reinsurer_decision) if referral and referral.reinsurer_decision else None

    # A cession is placed only when the reinsurer actually took the risk. The
    # POSTPONE path in routers/reinsurance.py also parks the referral at
    # ACCEPTED/terms_applied (it has finished processing the response), so
    # testing those two alone reported a postponed — i.e. still unplaced —
    # cession as covered. The reinsurer's own decision is the deciding fact.
    placed = bool(
        referral
        and referral.terms_applied
        and ref_status == ReinsuranceReferralStatusEnum.ACCEPTED.value
        and ref_decision not in (
            ReinsurerDecisionEnum.POSTPONE.value,
            ReinsurerDecisionEnum.DECLINE.value,
        )
    )

    if placed:
        status = "placed"
    elif referral is None:
        status = "not_referred"
    elif ref_decision == ReinsurerDecisionEnum.DECLINE.value or ref_status == ReinsuranceReferralStatusEnum.DECLINED.value:
        status = "declined"
    elif ref_decision == ReinsurerDecisionEnum.POSTPONE.value:
        status = "postponed"
    else:
        status = "pending"

    bypassed = False
    if not placed:
        bypassed = _gate(
            blockers, warnings,
            f"Facultative cession of PKR {cession['facultative_ceded_amount']:,.0f} above the "
            f"retention of PKR {cession['retention_limit']:,.0f} is not placed "
            f"({status.replace('_', ' ')})",
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
        requirement_bypassed = _gate(
            blockers, warnings, f"{len(outstanding)} requirement(s) not yet cleared",
        )

    # ── Step 3 — First premium (post-draft; informational) ────────────────────
    paid = [s for s in schedules if s.status == PremiumScheduleStatusEnum.PAID]
    premium = {
        "status": "paid" if paid else ("pending" if schedules else "none"),
        "total": len(schedules), "paid": len(paid),
    }

    # ── Step 4 — Compliance (AML / Sanctions / SECP) ──────────────────────────
    by_type = {_v(c.check_type): c for c in checks}
    missing = _REQUIRED_COMPLIANCE - set(by_type)
    # Gate on the same effective status the two compliance UIs display, so the
    # checklist can never disagree with what the officer is looking at.
    effective = {c.id: compliance_engine.effective_status(c) for c in checks}
    bad = [c for c in checks
           if effective[c.id] in (ComplianceStatusEnum.FLAGGED, ComplianceStatusEnum.FAILED)]
    compliance_bypassed = False  # would this gate block a real (non-demo) issuance?
    if missing:
        comp_status = "not_run"
        compliance_bypassed = _gate(blockers, warnings, "Compliance screening not yet run")
    elif bad:
        comp_status = "flagged"
        compliance_bypassed = _gate(
            blockers, warnings, f"{len(bad)} compliance check(s) need clearance",
        )
    else:
        comp_status = "clear"
    compliance = {
        "status": comp_status,
        "checks": [{"id": str(c.id), "check_type": _v(c.check_type),
                    "status": effective[c.id].value, "raw_status": _v(c.status),
                    "score": c.score} for c in checks],
    }

    # ── Step 5 — Beneficiaries (Σ share = 100) ────────────────────────────────
    total_share = round(sum(b.share_pct for b in bens), 2)
    ben_valid = bool(bens) and abs(total_share - 100.0) < 0.01
    beneficiaries = {
        "status": "valid" if ben_valid else ("invalid" if bens else "none"),
        "total_share": total_share, "count": len(bens),
    }
    beneficiary_bypassed = False  # would this gate block a real issuance?
    if not ben_valid:
        beneficiary_bypassed = _gate(
            blockers, warnings, "Beneficiaries must be captured and sum to 100%",
        )

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
    reinsurance, reinsurance_bypassed = await _reinsurance_step(session, policy, blockers, warnings)

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
