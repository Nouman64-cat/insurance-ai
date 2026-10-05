"""Deterministic decision engine (brief §9) — replaces the old
0.40*medical + 0.40*financial + 0.20*fraud weighted composite as the thing
that actually branches the outcome. The composite score can still be
computed and shown on a dashboard, but decide() never looks at it.

Severe medical risk cannot be mathematically cancelled by good finances, and
severe fraud cannot be cancelled by low medical/financial risk, because this
is a sequential rule chain, not a weighted sum — each branch either returns
immediately or falls through to the next check.
"""

from __future__ import annotations

from typing import List, Optional, Tuple

from .results import (
    FraudAssessment,
    FraudSeverity,
    MedicalRiskClass,
    MedicalUnderwritingResult,
    FinancialUnderwritingResult,
    UnderwritingDecision,
    VerificationFindingSpec,
    VerificationSeverity,
)

# Fraud severities that always force a fraud-specific outcome rather than
# being absorbed into a generic Human Review.
FRAUD_INVESTIGATION_SEVERITIES = {FraudSeverity.HIGH, FraudSeverity.CRITICAL}


def decide(
    *,
    requirements_satisfied: bool,
    medical: MedicalUnderwritingResult,
    financial: FinancialUnderwritingResult,
    fraud: FraudAssessment,
    findings: Optional[List[VerificationFindingSpec]] = None,
) -> Tuple[UnderwritingDecision, List[str]]:
    findings = findings or []
    reasons: List[str] = []

    if not requirements_satisfied:
        reasons.append("Mandatory underwriting requirements are not yet satisfied.")
        return UnderwritingDecision.REQUEST_ADDITIONAL_EVIDENCE, reasons

    if fraud.investigation_required or fraud.severity in FRAUD_INVESTIGATION_SEVERITIES:
        reasons.append(f"Fraud signal severity is {fraud.severity.value} (probability {fraud.probability:.2f}).")
        reasons.extend(str(r) for r in fraud.reasons)
        return UnderwritingDecision.FRAUD_INVESTIGATION, reasons

    if fraud.severity == FraudSeverity.MEDIUM:
        reasons.append("Fraud signal is elevated but not conclusive — underwriter review required.")
        return UnderwritingDecision.HUMAN_REVIEW, reasons

    if medical.risk_class == MedicalRiskClass.DECLINE:
        reasons.append("Medical underwriting classification is Decline.")
        reasons.extend(str(r) for r in medical.reasons)
        return UnderwritingDecision.DECLINE, reasons

    if medical.risk_class == MedicalRiskClass.POSTPONE:
        reasons.append("Medical underwriting classification is Postpone.")
        reasons.extend(str(r) for r in medical.reasons)
        return UnderwritingDecision.POSTPONE, reasons

    if medical.risk_class == MedicalRiskClass.MEDICAL_REVIEW_REQUIRED or medical.requires_human_review:
        reasons.append("Medical findings are ambiguous or inconclusive — underwriter review required.")
        return UnderwritingDecision.HUMAN_REVIEW, reasons

    if not financial.financially_justified:
        reasons.append("Requested coverage is not financially justified by declared/verified income.")
        reasons.extend(str(r) for r in financial.reasons)
        if financial.referral_required:
            return UnderwritingDecision.HUMAN_REVIEW, reasons
        return UnderwritingDecision.DECLINE, reasons

    high_findings = [f for f in findings if f.severity == VerificationSeverity.HIGH]
    if high_findings:
        reasons.append(f"{len(high_findings)} unresolved high-severity verification discrepancy(ies).")
        return UnderwritingDecision.HUMAN_REVIEW, reasons

    if medical.risk_class in (MedicalRiskClass.SUBSTANDARD, MedicalRiskClass.RATED) or medical.loading_percentage:
        reasons.append(f"Medical classification {medical.risk_class.value} requires a premium loading.")
        return UnderwritingDecision.APPROVE_WITH_LOADING, reasons

    if financial.referral_required:
        reasons.append("Financial underwriting flagged this case for referral.")
        return UnderwritingDecision.HUMAN_REVIEW, reasons

    medium_findings = [f for f in findings if f.severity == VerificationSeverity.MEDIUM]
    if medium_findings:
        reasons.append(f"{len(medium_findings)} unresolved medium-severity verification discrepancy(ies).")
        return UnderwritingDecision.HUMAN_REVIEW, reasons

    reasons.append("Medical, financial, and fraud assessments all clear with no unresolved discrepancies.")
    return UnderwritingDecision.AUTO_APPROVE, reasons
