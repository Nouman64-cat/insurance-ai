"""
Pydantic request / response schemas for the API Gateway.

These are deliberately separate from the SQLModel table classes in
shared.models.core so that the API contract can evolve independently of the
database schema.
"""

from datetime import date, datetime
from typing import List, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field

from shared.models.core import Gender, InsuranceTypeEnum, UserStatus, MaritalStatus


# ─────────────────────────────────────────────────────────────────────────────
# Auth / User / Role — gateway-side mirrors for Swagger documentation
# ─────────────────────────────────────────────────────────────────────────────

class TokenResponse(BaseModel):
    access_token: str
    token_type: str


class CurrentUserResponse(BaseModel):
    id: UUID
    email: str
    full_name: str
    tenant_id: UUID
    tenant_name: Optional[str] = None
    role_id: UUID
    role_name: str
    branch_id: Optional[UUID] = None
    branch_name: Optional[str] = None
    branch_code: Optional[str] = None
    is_active: bool


class UserCreate(BaseModel):
    username: str
    email: str
    password: str
    role_id: UUID
    branch_id: Optional[UUID] = None
    first_name: str
    last_name: str
    phone: Optional[str] = None
    department: Optional[str] = None
    employee_id: Optional[str] = None
    designation: Optional[str] = None
    date_of_joining: Optional[date] = None


class UserRead(BaseModel):
    id: UUID
    tenant_id: UUID
    role_id: UUID
    branch_id: Optional[UUID] = None
    email: str
    username: str
    full_name: str
    is_active: bool
    status: UserStatus
    created_at: datetime
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None
    avatar_url: Optional[str] = None
    department: Optional[str] = None
    employee_id: Optional[str] = None
    designation: Optional[str] = None
    date_of_joining: Optional[date] = None


class UserUpdate(BaseModel):
    role_id: Optional[UUID] = None
    is_active: Optional[bool] = None
    password: Optional[str] = None
    status: Optional[UserStatus] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None
    department: Optional[str] = None
    employee_id: Optional[str] = None
    designation: Optional[str] = None
    date_of_joining: Optional[date] = None


class RoleRead(BaseModel):
    id: UUID
    name: str
    description: str


# ─────────────────────────────────────────────────────────────────────────────
# Request bodies
# ─────────────────────────────────────────────────────────────────────────────

class ApplicantIn(BaseModel):
    cnic: str = Field(
        ...,
        description="Pakistani National Identity Card number (13 digits, hyphens optional).",
        examples=["3520112345671"],
    )
    name: str = Field(..., examples=["Muhammad Ali Khan"])
    dob: date = Field(..., description="Date of birth (YYYY-MM-DD).", examples=["1985-06-15"])
    gender: Gender = Field(..., examples=["Male"])
    marital_status: Optional[MaritalStatus] = Field(default=None, examples=["Married"])
    occupation: str = Field(..., examples=["Software Engineer"])
    declared_income: float = Field(
        ..., ge=0, description="Annual declared income in PKR.", examples=[1200000]
    )


class PolicyIn(BaseModel):
    product_name: str = Field(..., examples=["Term Life 20"])
    insurance_type: InsuranceTypeEnum = Field(..., examples=["TERM_LIFE"])
    coverage_amount: float = Field(
        ..., gt=0, description="Requested coverage amount in PKR.", examples=[5000000]
    )
    term_years: int = Field(..., ge=1, le=40, examples=[20])
    dependent_name: Optional[str] = Field(
        default=None, description="Required only for CHILD_EDUCATION_MARRIAGE plans."
    )
    dependent_dob: Optional[date] = Field(
        default=None, description="Required only for CHILD_EDUCATION_MARRIAGE plans."
    )


class EvaluateRequest(BaseModel):
    applicant: ApplicantIn
    policy: PolicyIn
    case_id: Optional[UUID] = None
    ai_summary: Optional[str] = None

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "applicant": {
                        "cnic": "3520112345671",
                        "name": "Muhammad Ali Khan",
                        "dob": "1985-06-15",
                        "gender": "Male",
                        "occupation": "Software Engineer",
                        "declared_income": 1200000,
                    },
                    "policy": {
                        "product_name": "Term Life 20",
                        "insurance_type": "TERM_LIFE",
                        "coverage_amount": 5000000,
                        "term_years": 20,
                    },
                }
            ]
        }
    }


# ─────────────────────────────────────────────────────────────────────────────
# Response body
# ─────────────────────────────────────────────────────────────────────────────

class EvaluateResponse(BaseModel):
    # ── Identifiers ───────────────────────────────────────────────────────────
    assessment_id: UUID
    applicant_id: UUID
    policy_id: UUID
    tenant_id: UUID

    # ── Scores ────────────────────────────────────────────────────────────────
    medical_score: int = Field(..., ge=0, le=100)
    financial_score: int = Field(..., ge=0, le=100)
    fraud_probability: float = Field(..., ge=0.0, le=1.0)
    composite_risk_score: int = Field(
        ...,
        ge=0,
        le=100,
        description=(
            "Weighted aggregate: medical×0.40 + financial×0.35 + fraud_pct×0.25. "
            "Derived at evaluation time; not persisted to the database."
        ),
    )

    # ── Decision ──────────────────────────────────────────────────────────────
    ai_decision: str
    suggested_loading: Optional[float] = Field(
        None, description="% premium loading applied; null when decision is not 'Approve with Loading'."
    )

    # ── Explainability ────────────────────────────────────────────────────────
    reasons: List[str] = Field(
        ..., description="Ordered list of human-readable scoring reasons for the Underwriter UI."
    )

    created_at: datetime


# ─────────────────────────────────────────────────────────────────────────────
# POST /quote — instant, deterministic premium quotation (no AI, no Kafka)
# ─────────────────────────────────────────────────────────────────────────────

class QuoteApplicantIn(BaseModel):
    cnic: str = Field(..., description="Pakistani National Identity Card number.", examples=["3520112345671"])
    name: str = Field(..., examples=["Muhammad Ali Khan"])
    dob: date = Field(..., description="Date of birth (YYYY-MM-DD).", examples=["1990-04-01"])
    gender: Gender = Field(..., examples=["Male"])
    marital_status: Optional[MaritalStatus] = Field(default=None, examples=["Married"])
    occupation: str = Field(..., examples=["Software Engineer"])
    monthly_income: float = Field(
        ..., gt=0, description="Gross monthly salary in PKR — annualized (x12) server-side.", examples=[250000]
    )
    is_smoker: bool = Field(..., examples=[False])
    height_cm: float = Field(..., gt=0, examples=[175])
    weight_kg: float = Field(..., gt=0, examples=[75])


class QuotePolicyIn(BaseModel):
    plan_code: str = Field(..., description="InsurancePlan.code from the tenant's catalog.", examples=["SALARY_PROTECTION_PLAN"])
    coverage_amount: float = Field(..., gt=0, description="Requested coverage amount in PKR.", examples=[10_000_000])
    term_years: int = Field(..., ge=1, le=40, examples=[10])
    nominee_name: str = Field(..., examples=["Amna Khan"])
    nominee_relationship: str = Field(..., examples=["Mother"])


class QuoteRequest(BaseModel):
    applicant: QuoteApplicantIn
    policy: QuotePolicyIn


class QuoteResponse(BaseModel):
    eligible: bool
    eligibility_errors: List[str] = Field(default_factory=list)

    # Populated only when eligible=True
    quote_id: Optional[UUID] = None
    applicant_id: Optional[UUID] = None
    policy_id: Optional[UUID] = None
    annual_income: Optional[float] = None
    plan_code: Optional[str] = None
    plan_label: Optional[str] = None
    coverage_amount: Optional[float] = None
    term_years: Optional[int] = None
    base_premium: Optional[float] = None
    loading_applied: Optional[float] = None
    total_premium: Optional[float] = None
    rate_version: Optional[str] = None
    reasons: List[str] = Field(default_factory=list)
    created_at: Optional[datetime] = None


# ─────────────────────────────────────────────────────────────────────────────
# GET /quotes — tenant-wide list of generated quotations (manual + auto)
# ─────────────────────────────────────────────────────────────────────────────

class QuoteListItem(BaseModel):
    quote_id: UUID
    applicant_id: UUID
    applicant_name: str
    applicant_cnic: str
    policy_id: UUID
    plan_label: str
    insurance_type: InsuranceTypeEnum
    coverage_amount: float
    term_years: int
    base_premium: float
    loading_applied: float
    total_premium: float
    rate_version: str
    created_at: datetime


# ─────────────────────────────────────────────────────────────────────────────
# GET /quotes/{quote_id} — full detail behind a single quotation row
# ─────────────────────────────────────────────────────────────────────────────

class QuoteDetail(QuoteListItem):
    # Applicant — full risk profile, not just name/CNIC
    applicant_dob: date
    applicant_age: int
    applicant_gender: Gender
    applicant_marital_status: Optional[MaritalStatus] = None
    applicant_occupation: str
    applicant_declared_income: float
    applicant_is_smoker: bool
    applicant_height_cm: float
    applicant_weight_kg: float
    applicant_bmi: Optional[float] = None

    # Policy — beneficiary / dependent details, when set
    nominee_name: Optional[str] = None
    nominee_relationship: Optional[str] = None
    dependent_name: Optional[str] = None
    dependent_dob: Optional[date] = None


# ─────────────────────────────────────────────────────────────────────────────
# Async / Kafka response
# ─────────────────────────────────────────────────────────────────────────────

class ProposalAcceptedResponse(BaseModel):
    """Returned immediately by POST /evaluate in the async Kafka flow."""
    event_id: UUID = Field(
        ..., description="Correlation ID — use this to match the RiskEvaluated event."
    )
    proposal_id: UUID = Field(
        ..., description="Stable proposal identifier carried through every downstream event."
    )
    status: Literal["accepted"] = "accepted"
    message: str = "Proposal queued for async risk evaluation."
