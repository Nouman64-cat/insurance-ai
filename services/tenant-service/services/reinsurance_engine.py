"""
Facultative reinsurance — slip assembly and terms write-back.

This is a *post*-underwriting step, and the distinction matters: the referral is
only meaningful once this insurer's own underwriter has formed a view. A
reinsurer is not being asked "should we insure this person?" — it is being asked
"we intend to accept on these terms; will you take the excess over our
retention, and on what basis?". So the slip carries our decision and our
evidence, and the reinsurer's answer comes back as terms that modify ours.

Three things live here:

  • ``build_slip``  — the underwriting evidence bundle sent to the reinsurer.
    Mirrors the sections of a real facultative application form: the life, the
    cession, the underwriting decision so far, medical evidence, financial
    justification, and the intermediary's report.
  • ``expected_terms`` — a deterministic, clearly-labelled *internal
    expectation* of what the reinsurer will come back with, computed from our
    own AI assessment and medical findings. It is a pricing sanity-check for
    the underwriter, never a substitute for the reinsurer's actual answer: the
    real terms are keyed in from the reinsurer's response, exactly as they are
    today (there is no live reinsurer API to call — Munich Re/Swiss Re
    facultative traffic is email/portal-based).
  • ``terms_to_counter_offer`` — translates accepted reinsurer terms into the
    revised terms this platform already understands (CounterOffer), so an
    imposed extra mortality or exclusion reaches the customer through the same
    accept/decline path as any other revised offer, with the same audit trail.

The cession arithmetic itself is not here — it belongs to the limit book in
services/underwriting_limits.py (``compute_cession``), which the medical and
history screens read too.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from shared.models.core import (
    AgentConfidentialReport,
    Customer,
    MedicalExamOrder,
    Policy,
    ReinsurerDecisionEnum,
    RiskAssessment,
)
from services.underwriting_limits import age_from_dob, compute_cession


def _v(x: Any) -> Optional[str]:
    if x is None:
        return None
    return x.value if hasattr(x, "value") else str(x)


def build_slip(
    *,
    customer: Customer,
    policy: Policy,
    cession: dict,
    assessment: Optional[RiskAssessment] = None,
    medical: Optional[MedicalExamOrder] = None,
    acr: Optional[AgentConfidentialReport] = None,
    history: Optional[dict] = None,
    underwriter_note: Optional[str] = None,
) -> dict:
    """Assemble the facultative slip — the complete file a reinsurer needs.

    Deliberately denormalised into a JSON snapshot: the slip is the record of
    what was disclosed at referral time, so later edits to the case must not
    retroactively change what we are shown to have sent.
    """
    age = age_from_dob(customer.dob)

    slip: dict = {
        "generated_at": datetime.utcnow().isoformat(),
        # ── 1. The life proposed ─────────────────────────────────────────────
        "life": {
            "name": customer.name,
            "cnic": customer.cnic,
            "date_of_birth": customer.dob.isoformat() if customer.dob else None,
            "age": age,
            "gender": _v(customer.gender),
            "occupation": customer.occupation,
            "city": customer.city,
            "declared_annual_income": customer.declared_income,
            "smoker": customer.is_smoker,
            "height_cm": customer.height_cm,
            "weight_kg": customer.weight_kg,
            "bmi": (
                round(customer.weight_kg / ((customer.height_cm / 100) ** 2), 1)
                if customer.height_cm and customer.weight_kg else None
            ),
        },
        # ── 2. The risk offered ──────────────────────────────────────────────
        "risk": {
            "product_name": policy.product_name,
            "insurance_type": _v(policy.insurance_type),
            "sum_assured": policy.coverage_amount,
            "term_years": policy.term_years,
            "policy_status": _v(policy.status),
            "policy_number": policy.policy_number,
            "effective_date": policy.effective_date.isoformat() if policy.effective_date else None,
        },
        # ── 3. The cession requested ─────────────────────────────────────────
        "cession": cession,
        # ── 4. Our underwriting decision so far ──────────────────────────────
        "ceding_underwriting": {
            "ai_decision": _v(assessment.ai_decision) if assessment else None,
            "composite_risk_score": assessment.composite_risk_score if assessment else None,
            "medical_score": assessment.medical_score if assessment else None,
            "financial_score": assessment.financial_score if assessment else None,
            "fraud_probability": assessment.fraud_probability if assessment else None,
            "suggested_loading_pct": assessment.suggested_loading if assessment else None,
            "reasons": list(assessment.reasons or []) if assessment else [],
            "underwriter_note": underwriter_note,
        },
        # ── 5. Medical evidence ──────────────────────────────────────────────
        "medical_evidence": (
            {
                "status": _v(medical.status),
                "non_medical_limit": medical.non_medical_limit,
                "tests_performed": [t.get("code") for t in (medical.required_tests or [])],
                "outcome": _v(medical.outcome),
                "abnormal_findings": medical.abnormal_findings or [],
                "suggested_loading_pct": medical.suggested_loading_pct,
                "completed_at": medical.completed_at.isoformat() if medical.completed_at else None,
            }
            if medical else {"status": "NotOrdered"}
        ),
        # ── 6. Financial justification / anti-selection ──────────────────────
        "financial_justification": (
            {
                "aggregate_sum_assured": history.get("aggregate_sum_assured"),
                "hlv_limit": history.get("hlv_limit"),
                "hlv_ratio": history.get("hlv_ratio"),
                "existing_cover_this_insurer": history.get("internal_inforce_sum_assured"),
                "existing_cover_other_insurers": history.get("external_declared_sum_assured"),
                "history_status": history.get("status"),
                "adverse_findings": [
                    f["message"] for f in (history.get("findings") or [])
                    if f.get("severity") in ("critical", "warning")
                ],
            }
            if history else None
        ),
        # ── 7. Intermediary report ───────────────────────────────────────────
        "intermediary_report": (
            {
                "recommendation": _v(acr.recommendation),
                "adverse_info_known": acr.adverse_info_known,
                "adverse_info_details": acr.adverse_info_details,
                "occupation_verified": acr.occupation_verified,
                "income_source_verified": acr.income_source_verified,
                "hazardous_activity_known": acr.hazardous_activity_known,
                "remarks": acr.remarks,
            }
            if acr else None
        ),
    }
    return slip


def expected_terms(
    *,
    assessment: Optional[RiskAssessment] = None,
    medical: Optional[MedicalExamOrder] = None,
    history: Optional[dict] = None,
) -> dict:
    """An internal expectation of the reinsurer's answer — NOT their answer.

    Reinsurers price the ceded portion off extra mortality (EMR): 100% EMR is
    standard mortality, 150% is half again, and so on. This projects an EMR from
    the same evidence the slip carries, so the underwriter can tell at a glance
    whether the terms that come back are in line or worth challenging. Surfaced
    in the UI explicitly labelled as an expectation.
    """
    emr = 100.0
    drivers: list[str] = []

    if assessment is not None:
        decision = _v(assessment.ai_decision) or ""
        if assessment.suggested_loading:
            emr += float(assessment.suggested_loading)
            drivers.append(f"Ceding insurer's own loading +{assessment.suggested_loading:.0f}%")
        if assessment.composite_risk_score is not None and assessment.composite_risk_score >= 70:
            emr += 25
            drivers.append(f"Composite risk score {assessment.composite_risk_score} (≥70)")
        if assessment.fraud_probability and assessment.fraud_probability >= 0.5:
            emr += 25
            drivers.append(f"Fraud probability {assessment.fraud_probability:.0%}")
        if "Decline" in decision:
            drivers.append("Ceding insurer's AI recommends decline — reinsurer likely to follow")

    exclusions: list[str] = []
    if medical is not None:
        outcome = _v(medical.outcome)
        if medical.suggested_loading_pct:
            emr += float(medical.suggested_loading_pct)
            drivers.append(f"Medical findings +{medical.suggested_loading_pct:.0f}%")
        if outcome == "Adverse":
            emr += 50
            drivers.append("Adverse medical examination outcome")
        for finding in (medical.abnormal_findings or [])[:5]:
            label = finding.get("test") if isinstance(finding, dict) else str(finding)
            if label:
                exclusions.append(f"Conditions related to abnormal {label} findings")

    if history is not None:
        if history.get("hlv_ratio") and history["hlv_ratio"] > 1.5:
            emr += 25
            drivers.append("Aggregate cover materially above Human Life Value ceiling")
        if history.get("has_prior_decline"):
            drivers.append("Prior decline on record — reinsurer will request the original reason")

    emr = round(min(emr, 500.0), 1)
    if emr >= 400:
        decision = ReinsurerDecisionEnum.DECLINE
    elif exclusions:
        decision = ReinsurerDecisionEnum.ACCEPT_WITH_EXCLUSION
    elif emr > 100:
        decision = ReinsurerDecisionEnum.ACCEPT_WITH_LOADING
    else:
        decision = ReinsurerDecisionEnum.ACCEPT

    return {
        "basis": "Internal expectation computed from this insurer's own evidence — "
                 "the reinsurer's actual terms must be recorded when received.",
        "expected_decision": decision.value,
        "expected_extra_mortality_pct": emr,
        "expected_loading_over_standard_pct": round(emr - 100.0, 1),
        "expected_exclusions": exclusions,
        "drivers": drivers or ["No adverse evidence — standard terms expected."],
    }


def terms_to_counter_offer(referral) -> Optional[dict]:
    """Translate a reinsurer's accepted terms into CounterOffer arguments.

    Returns None when the terms need nothing from the customer (standard
    acceptance): there is no revised offer to make, so no counter-offer is
    raised and the policy proceeds on its original terms.
    """
    decision = _v(referral.reinsurer_decision)
    if decision in (None, ReinsurerDecisionEnum.ACCEPT.value):
        return None
    if decision in (ReinsurerDecisionEnum.DECLINE.value, ReinsurerDecisionEnum.POSTPONE.value):
        return None  # handled as a policy decline/postpone, not a revised offer

    exclusions = list(referral.imposed_exclusions or [])
    # EMR is quoted over 100% standard mortality; the customer-facing premium
    # loading is the excess over standard, applied to the ceded share only.
    emr = float(referral.extra_mortality_pct or 100.0)
    loading_over_standard = max(emr - 100.0, 0.0)

    total_sa = float(referral.total_sum_assured or 0)
    ceded = float(referral.treaty_ceded_amount or 0) + float(referral.facultative_ceded_amount or 0)
    ceded_share = (ceded / total_sa) if total_sa else 0.0
    blended_loading = round(loading_over_standard * ceded_share, 2)

    reason_bits = [f"Reinsurer terms applied (ref: {referral.reinsurer_reference or 'n/a'})"]
    if loading_over_standard > 0:
        reason_bits.append(
            f"extra mortality {emr:.0f}% on the ceded PKR {ceded:,.0f} "
            f"({ceded_share:.0%} of the risk) → +{blended_loading:.2f}% blended premium loading"
        )
    if exclusions:
        reason_bits.append(f"exclusions imposed: {', '.join(exclusions)}")
    if referral.reinsurer_conditions:
        reason_bits.append(referral.reinsurer_conditions)

    if exclusions and blended_loading <= 0:
        offer_type = "Exclusion"
    else:
        offer_type = "Loading"

    return {
        "offer_type": offer_type,
        "revised_loading_pct": blended_loading if blended_loading > 0 else None,
        "exclusions": exclusions or None,
        "reason": " — ".join(reason_bits),
    }


def assess(policy: Policy, customer: Customer) -> dict:
    """Convenience wrapper: the cession split for a policy's sum assured,
    age-scaled off the life's own age. The single call routers use to answer
    'does this case need a reinsurer at all?'."""
    return compute_cession(
        float(policy.coverage_amount or 0),
        age_from_dob(customer.dob),
    )
