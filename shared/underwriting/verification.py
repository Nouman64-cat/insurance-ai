"""Cross-document / declared-vs-evidenced verification (brief §3).

Pure function over an already-built UnderwritingProfile — produces structured
VerificationFindingSpec records rather than plain strings, each carrying the
declared value, the observed value, and (where known) which artifact the
observed value came from.
"""

from __future__ import annotations

from typing import List

from .profile import UnderwritingProfile
from .results import VerificationFindingSpec, VerificationSeverity

# Relative-difference bands for the declared-vs-verified income check.
INCOME_MISMATCH_HIGH = 0.50
INCOME_MISMATCH_MEDIUM = 0.30
INCOME_MISMATCH_LOW = 0.15


def _income_severity(declared: float, verified: float) -> VerificationSeverity | None:
    if declared <= 0:
        return None
    diff_ratio = abs(declared - verified) / declared
    if diff_ratio >= INCOME_MISMATCH_HIGH:
        return VerificationSeverity.HIGH
    if diff_ratio >= INCOME_MISMATCH_MEDIUM:
        return VerificationSeverity.MEDIUM
    if diff_ratio >= INCOME_MISMATCH_LOW:
        return VerificationSeverity.LOW
    return None


def verify_profile(profile: UnderwritingProfile) -> List[VerificationFindingSpec]:
    findings: List[VerificationFindingSpec] = []

    # ── Declared vs verified income ─────────────────────────────────────────
    declared_income = profile.financial.get("declared_income") or 0
    verified_income = profile.financial.get("verified_income")
    if verified_income is not None and declared_income > 0:
        severity = _income_severity(declared_income, verified_income)
        if severity is not None:
            findings.append(VerificationFindingSpec(
                field="declared_income",
                severity=severity,
                declared_value=declared_income,
                observed_value=verified_income,
                explanation=(
                    f"Declared income ({declared_income:,.0f}) differs from income "
                    f"evidenced by uploaded documents ({verified_income:,.0f})."
                ),
            ))

    # ── Identity evidence vs declared identity ──────────────────────────────
    identity_evidence = profile.identity.get("evidence") or {}
    declared_cnic = profile.identity.get("cnic")
    evidenced_cnic = identity_evidence.get("cnic")
    if declared_cnic and evidenced_cnic and str(declared_cnic).strip() != str(evidenced_cnic).strip():
        findings.append(VerificationFindingSpec(
            field="cnic",
            severity=VerificationSeverity.HIGH,
            declared_value=declared_cnic,
            observed_value=evidenced_cnic,
            explanation="The CNIC on file does not match the CNIC extracted from the identity document.",
        ))

    declared_dob = profile.demographics.get("dob")
    evidenced_dob = identity_evidence.get("dob")
    if declared_dob and evidenced_dob and str(declared_dob)[:10] != str(evidenced_dob)[:10]:
        findings.append(VerificationFindingSpec(
            field="dob",
            severity=VerificationSeverity.MEDIUM,
            declared_value=declared_dob,
            observed_value=evidenced_dob,
            explanation="Date of birth on file does not match the identity document.",
        ))

    # ── Declared vs document-evidenced medical conditions ───────────────────
    declared_conditions = profile.medical_history.get("declared_conditions") or {}
    document_findings = profile.medical_history.get("document_findings") or []
    declared_any_condition = any(
        str(v.get("answer", v)).strip().lower() in ("yes", "true")
        if isinstance(v, dict) else str(v).strip().lower() in ("yes", "true")
        for v in declared_conditions.values()
    ) if declared_conditions else False

    for doc in document_findings:
        conditions = doc.get("conditions") or []
        if conditions and not declared_any_condition:
            findings.append(VerificationFindingSpec(
                field="medical_history",
                severity=VerificationSeverity.HIGH,
                declared_value="No conditions declared",
                observed_value=conditions,
                source_artifact_id=doc.get("evidence_source"),
                explanation=(
                    f"Medical report evidence lists condition(s) {conditions} that were "
                    "not disclosed on the customer's medical questionnaire."
                ),
            ))

    # ── Employer mismatch ────────────────────────────────────────────────────
    employer_declared = profile.financial.get("employer_declared")
    employer_evidence = profile.financial.get("employer_evidence")
    if employer_declared and employer_evidence and str(employer_declared).strip().lower() != str(employer_evidence).strip().lower():
        findings.append(VerificationFindingSpec(
            field="employer",
            severity=VerificationSeverity.LOW,
            declared_value=employer_declared,
            observed_value=employer_evidence,
            explanation="Declared employer does not match the employer named on income evidence.",
        ))

    # ── Important fields absent from supporting documents ───────────────────
    if profile.raw.get("document_completeness", {}).get("has_medical_document") and not document_findings:
        findings.append(VerificationFindingSpec(
            field="medical_report_detail",
            severity=VerificationSeverity.INFO,
            explanation="A medical document was submitted but no structured findings could be extracted from it.",
        ))

    return findings
