"""Requirements Engine — deterministic/configurable (brief §4).

Decides what evidence a case needs based on age, coverage, coverage-to-income
ratio, declared medical conditions, smoker status, BMI, occupation hazard,
and prior verification findings.

These thresholds are a v1 demonstration config, not an actuarially reviewed
rule set — exactly like services/risk-engine/underwriting_rules.py's
disclaimer for UNDERWRITING_RULES. That module already carries its own
per-insurance-type medical_exam_tiers used for plan validation/eligibility
display; it is deliberately left untouched here rather than refactored to
share this module's tiers, since the two serve different questions ("is this
plan/term/coverage combination even valid for this product" vs "what
documents does this specific case still need") and risk-engine's existing,
citation-backed table is already working. A future iteration could key this
module's tiers per insurance_type the same way if the two need to converge.
"""

from __future__ import annotations

from typing import List, Optional
from uuid import UUID

from .profile import UnderwritingProfile
from .results import RequirementCategory, RequirementCode, RequirementSpec, RequirementStatus, VerificationFindingSpec, VerificationSeverity

# ─────────────────────────────────────────────────────────────────────────────
# Centralized thresholds — edit here, not scattered across call sites.
# ─────────────────────────────────────────────────────────────────────────────

# (min_coverage_pkr, [requirement codes added at/above this coverage])
MEDICAL_EXAM_COVERAGE_TIERS: List[tuple[float, List[RequirementCode]]] = [
    (0, []),
    (5_000_000, [RequirementCode.MEDICAL_EXAMINATION]),
    (15_000_000, [RequirementCode.MEDICAL_EXAMINATION, RequirementCode.ECG, RequirementCode.LAB_REPORTS]),
    (30_000_000, [RequirementCode.MEDICAL_EXAMINATION, RequirementCode.ECG, RequirementCode.LAB_REPORTS, RequirementCode.PHYSICIAN_REPORT]),
]

# Smokers are medically underwritten more conservatively — hit the same exam
# tiers at a fraction of the coverage a non-smoker would need.
SMOKER_COVERAGE_TIER_FACTOR = 0.7

# Age at/above which an ECG is always added once any medical exam is required.
ECG_AGE_THRESHOLD = 45

# BMI at/above which a physician report is required regardless of coverage.
BMI_PHYSICIAN_REPORT_THRESHOLD = 35.0

# Coverage-to-income ratio bands for financial evidence.
FINANCIAL_DOCS_RATIO_THRESHOLD = 10.0
TAX_DOCUMENT_RATIO_THRESHOLD = 20.0

_MEDICAL_KEYWORDS = {
    RequirementCode.MEDICAL_EXAMINATION: ("medical exam", "medical report", "medical certificate"),
    RequirementCode.ECG: ("ecg", "electrocardiogram"),
    RequirementCode.LAB_REPORTS: ("lab report", "laboratory", "blood test", "lab "),
    RequirementCode.PHYSICIAN_REPORT: ("physician report", "doctor's report", "attending physician"),
    RequirementCode.SALARY_SLIP: ("salary",),
    RequirementCode.BANK_STATEMENT: ("bank statement", "bank "),
    RequirementCode.TAX_DOCUMENT: ("tax",),
    RequirementCode.CNIC: ("cnic", "identity", "national id"),
}


def _match_document(code: RequirementCode, document_evidence: list[dict]) -> tuple[RequirementStatus, Optional[UUID]]:
    keywords = _MEDICAL_KEYWORDS.get(code, ())
    best: Optional[dict] = None
    for doc in document_evidence:
        doc_type = (doc.get("document_type") or "").lower()
        if any(kw in doc_type for kw in keywords):
            if best is None or (doc.get("ocr_confidence_score") or 0) > (best.get("ocr_confidence_score") or 0):
                best = doc
    if best is None:
        return RequirementStatus.MISSING, None
    confidence = best.get("ocr_confidence_score") or 0
    artifact_id = best.get("artifact_id")
    if confidence >= 0.7:
        return RequirementStatus.SATISFIED, artifact_id
    if confidence > 0:
        return RequirementStatus.SUBMITTED, artifact_id
    return RequirementStatus.INVALID, artifact_id


def _medical_exam_codes_for_coverage(coverage: float, is_smoker: Optional[bool]) -> List[RequirementCode]:
    # Dividing (not multiplying) by the factor is what makes a smoker reach
    # a given tier at a FRACTION of the coverage a non-smoker needs: e.g.
    # factor 0.7 means a smoker hits the 5,000,000 tier at only 3,500,000 of
    # actual coverage (5,000,000 * 0.7), since coverage / 0.7 >= 5,000,000
    # <=> coverage >= 3,500,000.
    effective_coverage = coverage / SMOKER_COVERAGE_TIER_FACTOR if is_smoker else coverage
    applicable: List[RequirementCode] = []
    for threshold, codes in sorted(MEDICAL_EXAM_COVERAGE_TIERS):
        if effective_coverage >= threshold:
            applicable = codes
    return applicable


def _has_declared_condition(declared_conditions: dict) -> bool:
    """CustomerEApplication.medical_questionnaire is a Yes/No disclosure dict
    (see shared/models/core.py's docstring) — any truthy "yes"-shaped value
    counts as a declared condition worth a physician report."""
    if not declared_conditions:
        return False
    for value in declared_conditions.values():
        if isinstance(value, dict):
            if str(value.get("answer", "")).strip().lower() in ("yes", "true"):
                return True
        elif isinstance(value, bool) and value:
            return True
        elif str(value).strip().lower() in ("yes", "true"):
            return True
    return False


def determine_requirements(
    profile: UnderwritingProfile,
    prior_findings: Optional[List[VerificationFindingSpec]] = None,
) -> List[RequirementSpec]:
    prior_findings = prior_findings or []
    document_evidence = profile.document_evidence
    coverage = float(profile.policy_request.get("coverage_amount") or 0)
    ratio = profile.financial.get("coverage_to_income_ratio")
    is_smoker = profile.lifestyle.get("is_smoker")
    bmi = profile.medical_history.get("bmi")
    declared_conditions = profile.medical_history.get("declared_conditions") or {}

    specs: List[RequirementSpec] = []

    def add(code: RequirementCode, category: RequirementCategory, required: bool, reason: str) -> None:
        status, artifact_id = _match_document(code, document_evidence)
        specs.append(RequirementSpec(
            code=code.value, category=category, required=required,
            status=status, reason=reason, satisfied_by_artifact_id=artifact_id,
        ))

    # Identity — always mandatory.
    add(RequirementCode.CNIC, RequirementCategory.IDENTITY, True,
        "Identity verification is mandatory for every underwriting case.")

    # Medical questionnaire — always mandatory (the customer e-application).
    mq_status = RequirementStatus.SATISFIED if declared_conditions else RequirementStatus.MISSING
    specs.append(RequirementSpec(
        code=RequirementCode.MEDICAL_QUESTIONNAIRE.value, category=RequirementCategory.MEDICAL,
        required=True, status=mq_status,
        reason="Every case needs a completed medical/lifestyle questionnaire.",
    ))

    # Medical exam tier, by coverage (smoker-adjusted).
    exam_codes = set(_medical_exam_codes_for_coverage(coverage, is_smoker))
    if exam_codes and profile.demographics.get("age") and profile.demographics["age"] >= ECG_AGE_THRESHOLD:
        exam_codes.add(RequirementCode.ECG)
    if bmi is not None and bmi >= BMI_PHYSICIAN_REPORT_THRESHOLD:
        exam_codes.add(RequirementCode.MEDICAL_EXAMINATION)
        exam_codes.add(RequirementCode.PHYSICIAN_REPORT)
    if _has_declared_condition(declared_conditions):
        exam_codes.add(RequirementCode.PHYSICIAN_REPORT)

    _EXAM_REASONS = {
        RequirementCode.MEDICAL_EXAMINATION: f"Coverage amount ({coverage:,.0f}) requires a medical examination.",
        RequirementCode.ECG: "Age or coverage tier requires an ECG.",
        RequirementCode.LAB_REPORTS: f"Coverage amount ({coverage:,.0f}) requires laboratory reports.",
        RequirementCode.PHYSICIAN_REPORT: "A declared condition, elevated BMI, or high coverage requires a physician report.",
    }
    for code in (RequirementCode.MEDICAL_EXAMINATION, RequirementCode.ECG,
                 RequirementCode.LAB_REPORTS, RequirementCode.PHYSICIAN_REPORT):
        if code in exam_codes:
            add(code, RequirementCategory.MEDICAL, True, _EXAM_REASONS[code])

    # Financial evidence, by coverage-to-income ratio.
    if ratio is None:
        add(RequirementCode.SALARY_SLIP, RequirementCategory.FINANCIAL, True,
            "Declared income could not be used to compute a coverage ratio — income evidence is required.")
    elif ratio > FINANCIAL_DOCS_RATIO_THRESHOLD:
        add(RequirementCode.SALARY_SLIP, RequirementCategory.FINANCIAL, True,
            f"Coverage-to-income ratio ({ratio:.1f}x) exceeds {FINANCIAL_DOCS_RATIO_THRESHOLD:g}x — income evidence required.")
        add(RequirementCode.BANK_STATEMENT, RequirementCategory.FINANCIAL, True,
            f"Coverage-to-income ratio ({ratio:.1f}x) exceeds {FINANCIAL_DOCS_RATIO_THRESHOLD:g}x — bank evidence required.")
        if ratio > TAX_DOCUMENT_RATIO_THRESHOLD:
            add(RequirementCode.TAX_DOCUMENT, RequirementCategory.FINANCIAL, True,
                f"Coverage-to-income ratio ({ratio:.1f}x) exceeds {TAX_DOCUMENT_RATIO_THRESHOLD:g}x — tax evidence required.")

    # Prior high-severity verification findings escalate to an explicit
    # additional-document requirement rather than being silently absorbed.
    for finding in prior_findings:
        if finding.severity == VerificationSeverity.HIGH:
            specs.append(RequirementSpec(
                code=f"{RequirementCode.ADDITIONAL_DOCUMENT.value}:{finding.field}",
                category=RequirementCategory.OTHER, required=True,
                status=RequirementStatus.MISSING,
                reason=f"Discrepancy detected in '{finding.field}': {finding.explanation}",
            ))

    return specs


def requirements_satisfied(specs: List[RequirementSpec]) -> bool:
    return all(
        spec.status in (RequirementStatus.SATISFIED, RequirementStatus.WAIVED)
        for spec in specs
        if spec.required
    )
