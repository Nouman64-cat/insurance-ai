"""Tests for the Requirements Engine (brief §23 "Requirements" section).

Run with: cd shared && python -m pytest underwriting/test_requirements_rules.py
(or from repo root: pytest shared/underwriting/test_requirements_rules.py)
"""

from __future__ import annotations

from shared.underwriting.profile import build_profile
from shared.underwriting.requirements_rules import determine_requirements, requirements_satisfied
from shared.underwriting.results import RequirementStatus, VerificationFindingSpec, VerificationSeverity


def _young_low_risk_profile():
    customer = {
        "cnic": "1", "name": "Young", "dob": "2000-01-01", "gender": "Female",
        "occupation": "Teacher", "declared_income": 1_200_000, "is_smoker": False,
        "height_cm": 165, "weight_kg": 60,
    }
    policy = {"product_name": "Term Life", "insurance_type": "TERM_LIFE", "coverage_amount": 2_000_000, "term_years": 10}
    return build_profile(customer, policy)


def _older_high_coverage_profile():
    customer = {
        "cnic": "2", "name": "Older", "dob": "1965-01-01", "gender": "Male",
        "occupation": "Manager", "declared_income": 2_000_000, "is_smoker": False,
        "height_cm": 175, "weight_kg": 80,
    }
    policy = {"product_name": "Whole Life", "insurance_type": "WHOLE_LIFE", "coverage_amount": 25_000_000, "term_years": 20}
    return build_profile(customer, policy)


def test_young_low_risk_requires_minimal_evidence():
    specs = determine_requirements(_young_low_risk_profile(), [])
    required_codes = {s.code for s in specs if s.required}
    assert required_codes == {"CNIC", "MEDICAL_QUESTIONNAIRE"}


def test_older_high_coverage_triggers_additional_medical_requirements():
    specs = determine_requirements(_older_high_coverage_profile(), [])
    required_codes = {s.code for s in specs if s.required}
    assert {"MEDICAL_EXAMINATION", "ECG", "LAB_REPORTS"}.issubset(required_codes)
    assert {"SALARY_SLIP", "BANK_STATEMENT"}.issubset(required_codes)


def test_missing_required_artifact_blocks_satisfaction():
    specs = determine_requirements(_young_low_risk_profile(), [])
    assert all(s.status == RequirementStatus.MISSING for s in specs if s.required)
    assert requirements_satisfied(specs) is False


def test_uploading_matching_document_satisfies_requirement():
    customer = {
        "cnic": "3", "name": "Has Docs", "dob": "1995-01-01", "gender": "Male",
        "occupation": "Accountant", "declared_income": 1_500_000, "is_smoker": False,
    }
    policy = {"product_name": "Term Life", "insurance_type": "TERM_LIFE", "coverage_amount": 1_500_000, "term_years": 10}
    artifact_id = "11111111-1111-1111-1111-111111111111"
    profile = build_profile(
        customer, policy,
        document_evidence=[{"artifact_id": artifact_id, "document_type": "CNIC", "ocr_confidence_score": 0.9, "extracted_metadata": {}}],
    )
    specs = determine_requirements(profile, [])
    cnic_spec = next(s for s in specs if s.code == "CNIC")
    assert cnic_spec.status == RequirementStatus.SATISFIED
    assert str(cnic_spec.satisfied_by_artifact_id) == artifact_id


def test_smoker_lowers_the_medical_exam_coverage_tier():
    """A smoker should reach the medical-exam tier at a lower coverage amount
    than an equivalent non-smoker (SMOKER_COVERAGE_TIER_FACTOR < 1) — a
    coverage amount between 70% and 100% of the 5,000,000 tier threshold
    should require it for a smoker but not for a non-smoker."""
    base_customer = {
        "cnic": "4", "name": "Borderline", "dob": "1985-01-01", "gender": "Male",
        "occupation": "Analyst", "declared_income": 3_000_000,
    }
    policy = {"product_name": "Term Life", "insurance_type": "TERM_LIFE", "coverage_amount": 4_000_000, "term_years": 10}

    non_smoker = build_profile({**base_customer, "is_smoker": False}, policy)
    smoker = build_profile({**base_customer, "is_smoker": True}, policy)

    non_smoker_requires_exam = any(
        s.code == "MEDICAL_EXAMINATION" and s.required for s in determine_requirements(non_smoker, [])
    )
    smoker_requires_exam = any(
        s.code == "MEDICAL_EXAMINATION" and s.required for s in determine_requirements(smoker, [])
    )
    assert smoker_requires_exam is True
    assert non_smoker_requires_exam is False


def test_high_severity_prior_finding_adds_additional_document_requirement():
    profile = _young_low_risk_profile()
    prior = [VerificationFindingSpec(
        field="declared_income", severity=VerificationSeverity.HIGH,
        declared_value=1_200_000, observed_value=400_000,
        explanation="Large income mismatch.",
    )]
    specs = determine_requirements(profile, prior)
    assert any(s.code.startswith("ADDITIONAL_DOCUMENT:") for s in specs)
