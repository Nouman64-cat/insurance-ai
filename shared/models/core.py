from datetime import date, datetime
from enum import Enum
from typing import List, Optional
from uuid import UUID, uuid4

from sqlalchemy import Column, JSON, UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel


# ─────────────────────────────────────────────────────────────────────────────
# Domain enumerations
# ─────────────────────────────────────────────────────────────────────────────

class Gender(str, Enum):
    MALE = "Male"
    FEMALE = "Female"
    OTHER = "Other"


class AIDecision(str, Enum):
    AUTO_APPROVE = "Auto Approve"
    APPROVE_WITH_LOADING = "Approve with Loading"
    HUMAN_REVIEW = "Human Review"
    DECLINE = "Decline"


# ─────────────────────────────────────────────────────────────────────────────
# Tenant  —  top-level isolation boundary
# ─────────────────────────────────────────────────────────────────────────────

class Tenant(SQLModel, table=True):
    """
    One row per insurance company / distribution partner using the platform.
    Every other table carries a tenant_id FK so queries can be scoped per tenant.
    """
    __tablename__ = "tenants"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    name: str = Field(unique=True, index=True, max_length=255)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    applicants: List["Applicant"] = Relationship(back_populates="tenant")
    policies: List["Policy"] = Relationship(back_populates="tenant")
    risk_assessments: List["RiskAssessment"] = Relationship(back_populates="tenant")
    claims: List["Claim"] = Relationship(back_populates="tenant")
    artifacts: List["Artifact"] = Relationship(back_populates="tenant")
    commissions: List["Commission"] = Relationship(back_populates="tenant")


# ─────────────────────────────────────────────────────────────────────────────
# Applicant  —  the person applying for a policy
# ─────────────────────────────────────────────────────────────────────────────

class Applicant(SQLModel, table=True):
    """
    Personal and financial profile of an insurance applicant.
    CNIC is unique per tenant (same person cannot have two records within one insurer).
    """
    __tablename__ = "applicants"
    __table_args__ = (
        UniqueConstraint("tenant_id", "cnic", name="uq_applicant_cnic_per_tenant"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)

    # Identity
    cnic: str = Field(index=True, max_length=15)        # Pakistani National Identity Card
    name: str = Field(max_length=255)
    dob: date
    gender: Gender

    # Socio-economic profile used by the risk engine
    occupation: str = Field(max_length=255)
    declared_income: float = Field(ge=0)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="applicants")
    policies: List["Policy"] = Relationship(back_populates="applicant")
    risk_assessments: List["RiskAssessment"] = Relationship(back_populates="applicant")
    artifacts: List["Artifact"] = Relationship(back_populates="applicant")


# ─────────────────────────────────────────────────────────────────────────────
# Policy  —  the insurance product being applied for
# ─────────────────────────────────────────────────────────────────────────────

class Policy(SQLModel, table=True):
    """
    A requested insurance policy linked to a specific applicant and tenant.
    Coverage details drive the risk-engine scoring logic.
    """
    __tablename__ = "policies"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    applicant_id: UUID = Field(foreign_key="applicants.id", index=True, nullable=False)

    product_name: str = Field(max_length=255)           # e.g. "Term Life", "Health Platinum"
    coverage_amount: float = Field(ge=0)                # in PKR
    term_years: int = Field(ge=1, le=40)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="policies")
    applicant: Optional[Applicant] = Relationship(back_populates="policies")
    claims: List["Claim"] = Relationship(back_populates="policy")
    commission: Optional["Commission"] = Relationship(back_populates="policy")


# ─────────────────────────────────────────────────────────────────────────────
# RiskAssessment  —  AI underwriting output for an applicant
# ─────────────────────────────────────────────────────────────────────────────

class RiskAssessment(SQLModel, table=True):
    """
    Stores the output produced by the risk-engine and decision-engine for a
    given applicant. One applicant may have multiple assessments over time
    (re-assessment after additional information, appeals, etc.).
    """
    __tablename__ = "risk_assessments"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    applicant_id: UUID = Field(foreign_key="applicants.id", index=True, nullable=False)

    # Scoring  (0–100 for medical/financial; 0.0–1.0 for fraud probability)
    medical_score: int = Field(ge=0, le=100)
    financial_score: int = Field(ge=0, le=100)
    fraud_probability: float = Field(ge=0.0, le=1.0)

    # Decision output
    ai_decision: AIDecision
    # Premium loading percentage (e.g. 25.0 means +25% on base premium)
    suggested_loading: Optional[float] = Field(default=None, ge=0.0, le=500.0)

    # Explainable-AI reasons — stored as a JSON array of human-readable strings
    # e.g. ["BMI above threshold", "High-risk occupation", "Income–coverage ratio 8x"]
    reasons: Optional[List[str]] = Field(
        default=None,
        sa_column=Column(JSON, nullable=True),
    )

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="risk_assessments")
    applicant: Optional[Applicant] = Relationship(back_populates="risk_assessments")


# ─────────────────────────────────────────────────────────────────────────────
# Claim  —  a benefit claim filed against an active policy
# ─────────────────────────────────────────────────────────────────────────────

class Claim(SQLModel, table=True):
    __tablename__ = "claims"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    claim_type: str = Field(max_length=100)         # e.g. 'Hospitalization', 'Death', 'Reimbursement'
    submitted_amount: float = Field(ge=0)
    approved_amount: float = Field(default=0, ge=0)
    status: str = Field(max_length=50)              # e.g. 'Approved', 'Rejected', 'Investigation'
    fraud_probability: float = Field(ge=0.0, le=1.0)
    duplicate_flag: bool = Field(default=False)
    ai_recommendation: str = Field(max_length=500)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="claims")
    policy: Optional[Policy] = Relationship(back_populates="claims")
    artifacts: List["Artifact"] = Relationship(back_populates="claim")


# ─────────────────────────────────────────────────────────────────────────────
# Artifact  —  a document attached to an applicant or a claim
# Defined after Claim because claim_id is a FK to claims.
# ─────────────────────────────────────────────────────────────────────────────

class Artifact(SQLModel, table=True):
    __tablename__ = "artifacts"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    # An artifact is attached to an applicant, a claim, or both — both FKs are optional.
    applicant_id: Optional[UUID] = Field(default=None, foreign_key="applicants.id", index=True)
    claim_id: Optional[UUID] = Field(default=None, foreign_key="claims.id", index=True)

    document_type: str = Field(max_length=100)      # e.g. 'CNIC', 'Salary Slip', 'Medical Report'
    ocr_confidence_score: float = Field(ge=0.0, le=1.0)
    authenticity_score: float = Field(ge=0.0, le=1.0)
    quality_score: float = Field(ge=0.0, le=1.0)
    tampered_flag: bool = Field(default=False)
    status: str = Field(max_length=50)              # e.g. 'Accepted', 'Re-submission Requested'

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships — SQLAlchemy disambiguates the two optional FKs because
    # each points to a different table (applicants vs claims).
    tenant: Optional[Tenant] = Relationship(back_populates="artifacts")
    applicant: Optional[Applicant] = Relationship(back_populates="artifacts")
    claim: Optional[Claim] = Relationship(back_populates="artifacts")


# ─────────────────────────────────────────────────────────────────────────────
# Commission  —  agent commission record for a sold policy
# ─────────────────────────────────────────────────────────────────────────────

class Commission(SQLModel, table=True):
    __tablename__ = "commissions"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    agent_id: str = Field(index=True, max_length=100)
    overall_ai_score: float = Field(ge=0.0, le=100.0)
    commission_percentage: float = Field(ge=0.0, le=100.0)
    calculated_amount: float = Field(ge=0)
    bonus_eligible: bool = Field(default=False)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    # Policy.commission is Optional[Commission] (not a list) → SQLModel sets uselist=False.
    tenant: Optional[Tenant] = Relationship(back_populates="commissions")
    policy: Optional[Policy] = Relationship(back_populates="commission")
