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

from shared.models.core import Gender, UserStatus


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
    role_id: UUID
    role_name: str
    is_active: bool


class UserCreate(BaseModel):
    username: str
    email: str
    password: str
    role_id: UUID
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
    occupation: str = Field(..., examples=["Software Engineer"])
    declared_income: float = Field(
        ..., ge=0, description="Annual declared income in PKR.", examples=[1200000]
    )


class PolicyIn(BaseModel):
    product_name: str = Field(..., examples=["Term Life 20"])
    coverage_amount: float = Field(
        ..., gt=0, description="Requested coverage amount in PKR.", examples=[5000000]
    )
    term_years: int = Field(..., ge=1, le=40, examples=[20])


class EvaluateRequest(BaseModel):
    applicant: ApplicantIn
    policy: PolicyIn

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
