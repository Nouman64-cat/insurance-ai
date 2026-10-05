"""Tests for the deterministic decision engine (brief §23 "Decision" section).

Run with: pytest shared/underwriting/test_decision_rules.py
"""

from __future__ import annotations

from shared.underwriting.decision_rules import decide
from shared.underwriting.results import (
    FinancialUnderwritingResult,
    FraudAssessment,
    FraudSeverity,
    MedicalRiskClass,
    MedicalUnderwritingResult,
    UnderwritingDecision,
    VerificationFindingSpec,
    VerificationSeverity,
)

CLEAN_MEDICAL = MedicalUnderwritingResult(
    risk_score=10, risk_class=MedicalRiskClass.PREFERRED, requires_human_review=False, reasons=[], evidence_refs=[],
)
JUSTIFIED_FINANCIAL = FinancialUnderwritingResult(
    financially_justified=True, declared_income=1_000_000, coverage_to_income_ratio=3.0,
    referral_required=False, reasons=[], evidence_refs=[],
)
CLEAN_FRAUD = FraudAssessment(probability=0.02, severity=FraudSeverity.LOW, investigation_required=False, reasons=[])


def test_clean_low_risk_case_auto_approves():
    decision, _ = decide(
        requirements_satisfied=True, medical=CLEAN_MEDICAL, financial=JUSTIFIED_FINANCIAL, fraud=CLEAN_FRAUD, findings=[],
    )
    assert decision == UnderwritingDecision.AUTO_APPROVE


def test_rated_medical_case_approves_with_loading():
    rated_medical = MedicalUnderwritingResult(
        risk_score=60, risk_class=MedicalRiskClass.RATED, loading_percentage=50.0,
        requires_human_review=False, reasons=[], evidence_refs=[],
    )
    decision, _ = decide(
        requirements_satisfied=True, medical=rated_medical, financial=JUSTIFIED_FINANCIAL, fraud=CLEAN_FRAUD, findings=[],
    )
    assert decision == UnderwritingDecision.APPROVE_WITH_LOADING


def test_missing_requirements_requests_additional_evidence():
    decision, _ = decide(
        requirements_satisfied=False, medical=CLEAN_MEDICAL, financial=JUSTIFIED_FINANCIAL, fraud=CLEAN_FRAUD, findings=[],
    )
    assert decision == UnderwritingDecision.REQUEST_ADDITIONAL_EVIDENCE


def test_severe_medical_finding_declines_regardless_of_finances():
    """Serious medical risk cannot be mathematically cancelled by good
    finances (brief completion criterion #10) — a sequential rule chain, not
    a weighted average, makes this true by construction."""
    decline_medical = MedicalUnderwritingResult(
        risk_score=95, risk_class=MedicalRiskClass.DECLINE, requires_human_review=False,
        reasons=["Severe pre-existing condition"], evidence_refs=[],
    )
    excellent_financial = FinancialUnderwritingResult(
        financially_justified=True, declared_income=10_000_000, coverage_to_income_ratio=0.5,
        referral_required=False, reasons=[], evidence_refs=[],
    )
    decision, _ = decide(
        requirements_satisfied=True, medical=decline_medical, financial=excellent_financial, fraud=CLEAN_FRAUD, findings=[],
    )
    assert decision == UnderwritingDecision.DECLINE


def test_severe_fraud_cannot_be_cancelled_by_low_other_scores():
    """Severe fraud risk cannot be mathematically cancelled by low medical/
    financial risk (brief completion criterion #11)."""
    severe_fraud = FraudAssessment(probability=0.9, severity=FraudSeverity.CRITICAL, investigation_required=True, reasons=["Fraud ring detected"])
    decision, _ = decide(
        requirements_satisfied=True, medical=CLEAN_MEDICAL, financial=JUSTIFIED_FINANCIAL, fraud=severe_fraud, findings=[],
    )
    assert decision == UnderwritingDecision.FRAUD_INVESTIGATION


def test_postpone_medical_classification_postpones():
    postpone_medical = MedicalUnderwritingResult(
        risk_score=85, risk_class=MedicalRiskClass.POSTPONE, requires_human_review=False, reasons=[], evidence_refs=[],
    )
    decision, _ = decide(
        requirements_satisfied=True, medical=postpone_medical, financial=JUSTIFIED_FINANCIAL, fraud=CLEAN_FRAUD, findings=[],
    )
    assert decision == UnderwritingDecision.POSTPONE


def test_ambiguous_medical_classification_requires_human_review():
    ambiguous_medical = MedicalUnderwritingResult(
        risk_score=50, risk_class=MedicalRiskClass.MEDICAL_REVIEW_REQUIRED, requires_human_review=True,
        reasons=["Document findings need review"], evidence_refs=[],
    )
    decision, _ = decide(
        requirements_satisfied=True, medical=ambiguous_medical, financial=JUSTIFIED_FINANCIAL, fraud=CLEAN_FRAUD, findings=[],
    )
    assert decision == UnderwritingDecision.HUMAN_REVIEW


def test_high_severity_discrepancy_requires_human_review():
    high_finding = VerificationFindingSpec(
        field="declared_income", severity=VerificationSeverity.HIGH,
        declared_value=3_000_000, observed_value=900_000, explanation="Income mismatch.",
    )
    decision, _ = decide(
        requirements_satisfied=True, medical=CLEAN_MEDICAL, financial=JUSTIFIED_FINANCIAL, fraud=CLEAN_FRAUD,
        findings=[high_finding],
    )
    assert decision == UnderwritingDecision.HUMAN_REVIEW


def test_unjustified_financial_with_referral_goes_to_human_review():
    weak_financial = FinancialUnderwritingResult(
        financially_justified=False, declared_income=500_000, coverage_to_income_ratio=25.0,
        maximum_supported_cover=5_000_000, referral_required=True, reasons=["Over coverage ceiling"], evidence_refs=[],
    )
    decision, _ = decide(
        requirements_satisfied=True, medical=CLEAN_MEDICAL, financial=weak_financial, fraud=CLEAN_FRAUD, findings=[],
    )
    assert decision == UnderwritingDecision.HUMAN_REVIEW


def test_unjustified_financial_without_referral_declines():
    weak_financial = FinancialUnderwritingResult(
        financially_justified=False, declared_income=500_000, coverage_to_income_ratio=25.0,
        maximum_supported_cover=5_000_000, referral_required=False, reasons=["Over coverage ceiling"], evidence_refs=[],
    )
    decision, _ = decide(
        requirements_satisfied=True, medical=CLEAN_MEDICAL, financial=weak_financial, fraud=CLEAN_FRAUD, findings=[],
    )
    assert decision == UnderwritingDecision.DECLINE
