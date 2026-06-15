"""
Pydantic request / response schemas for the API Gateway.

These are deliberately separate from the SQLModel table classes in
shared.models.core so that the API contract can evolve independently of the
database schema.
"""

from datetime import date, datetime
from typing import List, Optional
from uuid import UUID

from pydantic import BaseModel, Field

from shared.models.core import Gender


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
