"""Pure data shapes for the underwriting workflow — no DB, no FastAPI.

These enums are the single source of truth for the corresponding Postgres
enum types (shared/models/core.py's CaseRequirementStatusEnum and
VerificationSeverityEnum import these directly rather than redeclaring the
same values) so the DB schema and the rule engines can never drift apart.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, List, Optional
from uuid import UUID

from pydantic import BaseModel, Field


# ─────────────────────────────────────────────────────────────────────────────
# Requirements Engine shapes (brief §4)
# ─────────────────────────────────────────────────────────────────────────────

class RequirementCategory(str, Enum):
    MEDICAL = "Medical"
    FINANCIAL = "Financial"
    IDENTITY = "Identity"
    OTHER = "Other"


class RequirementStatus(str, Enum):
    MISSING = "Missing"
    REQUESTED = "Requested"
    SUBMITTED = "Submitted"
    SATISFIED = "Satisfied"
    WAIVED = "Waived"
    INVALID = "Invalid"


# Canonical requirement codes. A plain string column (not a DB enum) stores
# these on CaseRequirement so a new code never needs a migration — this list
# is the documented, centralized set an insurer would extend.
class RequirementCode(str, Enum):
    CNIC = "CNIC"
    SALARY_SLIP = "SALARY_SLIP"
    BANK_STATEMENT = "BANK_STATEMENT"
    TAX_DOCUMENT = "TAX_DOCUMENT"
    MEDICAL_QUESTIONNAIRE = "MEDICAL_QUESTIONNAIRE"
    MEDICAL_EXAMINATION = "MEDICAL_EXAMINATION"
    ECG = "ECG"
    LAB_REPORTS = "LAB_REPORTS"
    PHYSICIAN_REPORT = "PHYSICIAN_REPORT"
    ADDITIONAL_DOCUMENT = "ADDITIONAL_DOCUMENT"


class RequirementSpec(BaseModel):
    """One requirement, as produced by determine_requirements() and mirrored
    1:1 onto a CaseRequirement row by underwriting_gate.compute_requirements."""

    code: str
    category: RequirementCategory
    required: bool
    status: RequirementStatus = RequirementStatus.MISSING
    reason: str
    satisfied_by_artifact_id: Optional[UUID] = None


# ─────────────────────────────────────────────────────────────────────────────
# Verification shapes (brief §3)
# ─────────────────────────────────────────────────────────────────────────────

class VerificationSeverity(str, Enum):
    INFO = "Info"
    LOW = "Low"
    MEDIUM = "Medium"
    HIGH = "High"


class VerificationFindingSpec(BaseModel):
    field: str
    severity: VerificationSeverity
    declared_value: Optional[Any] = None
    observed_value: Optional[Any] = None
    source_artifact_id: Optional[UUID] = None
    explanation: str


# ─────────────────────────────────────────────────────────────────────────────
# Medical underwriting (brief §6)
# ─────────────────────────────────────────────────────────────────────────────

class MedicalRiskClass(str, Enum):
    PREFERRED = "Preferred"
    STANDARD = "Standard"
    SUBSTANDARD = "Substandard"
    RATED = "Rated"
    POSTPONE = "Postpone"
    DECLINE = "Decline"
    MEDICAL_REVIEW_REQUIRED = "Medical Review Required"


class MedicalUnderwritingResult(BaseModel):
    risk_score: int = Field(ge=0, le=100)
    risk_class: MedicalRiskClass
    loading_percentage: Optional[float] = None
    requires_human_review: bool = False
    reasons: List[Any] = Field(default_factory=list)
    evidence_refs: List[str] = Field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Financial underwriting (brief §7)
# ─────────────────────────────────────────────────────────────────────────────

class FinancialUnderwritingResult(BaseModel):
    financially_justified: bool
    declared_income: float
    verified_income: Optional[float] = None
    coverage_to_income_ratio: float
    maximum_supported_cover: Optional[float] = None
    referral_required: bool = False
    reasons: List[Any] = Field(default_factory=list)
    evidence_refs: List[str] = Field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Fraud assessment (brief §8)
# ─────────────────────────────────────────────────────────────────────────────

class FraudSeverity(str, Enum):
    LOW = "Low"
    MEDIUM = "Medium"
    HIGH = "High"
    CRITICAL = "Critical"


class FraudAssessment(BaseModel):
    probability: float = Field(ge=0.0, le=1.0)
    severity: FraudSeverity
    investigation_required: bool = False
    reasons: List[Any] = Field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Final decision (brief §9/§10) — superset of the existing AIDecision enum.
# Values match shared.models.core.AIDecision member NAMEs so the two never
# drift; see migrate.py for the ALTER TYPE additions for the new 3 values.
# ─────────────────────────────────────────────────────────────────────────────

class UnderwritingDecision(str, Enum):
    AUTO_APPROVE = "Auto Approve"
    APPROVE_WITH_LOADING = "Approve with Loading"
    HUMAN_REVIEW = "Human Review"
    DECLINE = "Decline"
    POSTPONE = "Postpone"
    REQUEST_ADDITIONAL_EVIDENCE = "Request Additional Evidence"
    FRAUD_INVESTIGATION = "Fraud Investigation"
