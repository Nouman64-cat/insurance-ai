from datetime import date, datetime
from enum import Enum
from typing import List, Optional
from uuid import UUID, uuid4

from sqlalchemy import Column, Integer, JSON, String, Text, UniqueConstraint
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


class InsuranceTypeEnum(str, Enum):
    TERM_LIFE = "TERM_LIFE"
    WHOLE_LIFE = "WHOLE_LIFE"
    ENDOWMENT = "ENDOWMENT"
    CHILD_EDUCATION_MARRIAGE = "CHILD_EDUCATION_MARRIAGE"
    GROUP_LIFE = "GROUP_LIFE"
    SAVINGS = "SAVINGS"
    SINGLE_PREMIUM = "SINGLE_PREMIUM"
    HEALTH_CASH = "HEALTH_CASH"


class PlanCategoryEnum(str, Enum):
    INDIVIDUAL = "Individual"
    GROUP = "Group"


class ProductCategoryEnum(str, Enum):
    """Business/distribution channel a plan is sold through — orthogonal to
    PlanCategoryEnum (Individual/Group, the underwriting axis)."""
    CONVENTIONAL = "Conventional"
    TAKAFUL = "Takaful"
    BANCASSURANCE = "Bancassurance"


class PlanStatusEnum(str, Enum):
    DRAFT = "Draft"
    ACTIVE = "Active"
    ARCHIVED = "Archived"


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
    code: str = Field(unique=True, index=True, max_length=50)
    is_active: bool = Field(default=True, nullable=False)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    applicants: List["Applicant"] = Relationship(back_populates="tenant")
    organizations: List["Organization"] = Relationship(back_populates="tenant")
    policies: List["Policy"] = Relationship(back_populates="tenant")
    master_policies: List["MasterPolicy"] = Relationship(back_populates="tenant")
    risk_assessments: List["RiskAssessment"] = Relationship(back_populates="tenant")
    claims: List["Claim"] = Relationship(back_populates="tenant")
    artifacts: List["Artifact"] = Relationship(back_populates="tenant")
    commissions: List["Commission"] = Relationship(back_populates="tenant")
    users: List["User"] = Relationship(back_populates="tenant")
    insurance_plans: List["InsurancePlan"] = Relationship(back_populates="tenant")
    premium_quotes: List["PremiumQuote"] = Relationship(back_populates="tenant")


# ─────────────────────────────────────────────────────────────────────────────
# Role  —  RBAC role definitions (seeded once at startup)
# ─────────────────────────────────────────────────────────────────────────────

class Role(SQLModel, table=True):
    __tablename__ = "roles"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    name: str = Field(unique=True, index=True, max_length=100)
    description: str = Field(default="", max_length=500)

    users: List["User"] = Relationship(back_populates="role")


# ─────────────────────────────────────────────────────────────────────────────
# UserStatus & UserType
# ─────────────────────────────────────────────────────────────────────────────

class UserStatus(str, Enum):
    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"
    SUSPENDED = "SUSPENDED"
    LOCKED = "LOCKED"


class UserType(SQLModel, table=True):
    __tablename__ = "user_types"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    type_name: str = Field(unique=True, index=True, max_length=100)
    description: str = Field(default="", max_length=500)
    is_active: bool = Field(default=True, nullable=False)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    users: List["User"] = Relationship(back_populates="user_type")


# ─────────────────────────────────────────────────────────────────────────────
# User  —  an employee (underwriter / agent / admin) belonging to a Tenant
# ─────────────────────────────────────────────────────────────────────────────

class User(SQLModel, table=True):
    __tablename__ = "users"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    role_id: UUID = Field(foreign_key="roles.id", nullable=False)
    user_type_id: Optional[UUID] = Field(default=None, foreign_key="user_types.id", nullable=True)

    email: str = Field(unique=True, index=True, max_length=255)
    username: str = Field(unique=True, index=True, max_length=255)
    hashed_password: str = Field(max_length=255)
    full_name: str = Field(max_length=255)
    status: UserStatus = Field(default=UserStatus.ACTIVE, max_length=50, nullable=False)
    is_active: bool = Field(default=True, nullable=False)
    is_verified: bool = Field(default=False, nullable=False)
    failed_login_count: int = Field(default=0, nullable=False)
    last_login: Optional[datetime] = Field(default=None, nullable=True)
    is_deleted: bool = Field(default=False, nullable=False)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    tenant: Optional[Tenant] = Relationship(back_populates="users")
    role: Optional[Role] = Relationship(back_populates="users")
    user_type: Optional[UserType] = Relationship(back_populates="users")
    profile: Optional["UserProfile"] = Relationship(back_populates="user", sa_relationship_kwargs={"uselist": False, "cascade": "all, delete-orphan"})


# ─────────────────────────────────────────────────────────────────────────────
# UserProfile  —  detailed profile information for a User
# ─────────────────────────────────────────────────────────────────────────────

class UserProfile(SQLModel, table=True):
    __tablename__ = "user_profiles"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    user_id: UUID = Field(foreign_key="users.id", index=True, unique=True, nullable=False)

    first_name: str = Field(max_length=255)
    last_name: str = Field(max_length=255)
    phone: Optional[str] = Field(default=None, max_length=50, nullable=True)
    avatar_url: Optional[str] = Field(default=None, max_length=500, nullable=True)
    department: Optional[str] = Field(default=None, max_length=255, nullable=True)
    employee_id: Optional[str] = Field(default=None, max_length=100, nullable=True)
    designation: Optional[str] = Field(default=None, max_length=255, nullable=True)
    date_of_joining: Optional[date] = Field(default=None, nullable=True)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    user: Optional[User] = Relationship(back_populates="profile")


# ─────────────────────────────────────────────────────────────────────────────
# Organization  —  a business/employer insuring its staff under a group policy
# ─────────────────────────────────────────────────────────────────────────────

class Organization(SQLModel, table=True):
    """
    A small/medium business (or any employer) that insures its employees under
    one or more MasterPolicy contracts, rather than individuals shopping for
    their own coverage.
    """
    __tablename__ = "organizations"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)

    name: str = Field(max_length=255)
    registration_number: Optional[str] = Field(default=None, max_length=100)  # NTN / business reg no.
    industry: Optional[str] = Field(default=None, max_length=255)
    contact_person: Optional[str] = Field(default=None, max_length=255)
    contact_email: Optional[str] = Field(default=None, max_length=255)
    contact_phone: Optional[str] = Field(default=None, max_length=50)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="organizations")
    employees: List["Applicant"] = Relationship(back_populates="organization")
    master_policies: List["MasterPolicy"] = Relationship(back_populates="organization")


# ─────────────────────────────────────────────────────────────────────────────
# Applicant  —  the person applying for a policy
# ─────────────────────────────────────────────────────────────────────────────

class Applicant(SQLModel, table=True):
    """
    Personal and financial profile of an insurance applicant.
    CNIC is unique per tenant (same person cannot have two records within one insurer).

    Also doubles as an "employee" record when organization_id is set — a
    business's staff enrolled under a MasterPolicy are Applicant rows too, so
    they get the same Case/Artifact/RiskAssessment/Claim machinery for free.
    """
    __tablename__ = "applicants"
    __table_args__ = (
        UniqueConstraint("tenant_id", "cnic", name="uq_applicant_cnic_per_tenant"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)

    # Set only for employees enrolled under an Organization's group policy;
    # NULL for individual applicants (unchanged, existing behavior).
    organization_id: Optional[UUID] = Field(default=None, foreign_key="organizations.id", index=True, nullable=True)

    # Identity
    cnic: str = Field(index=True, max_length=15)        # Pakistani National Identity Card
    name: str = Field(max_length=255)
    dob: date
    gender: Gender

    # Socio-economic profile used by the risk engine
    occupation: str = Field(max_length=255)
    declared_income: float = Field(ge=0)

    # Pricing-relevant risk flags — promoted out of `details` to strongly-typed
    # columns so the (upcoming) Rating/Pricing Engine has a validated contract
    # instead of reading an untyped JSON blob.
    is_smoker: bool = Field(nullable=False)
    height_cm: float = Field(gt=0)
    weight_kg: float = Field(gt=0)

    details: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="applicants")
    organization: Optional[Organization] = Relationship(back_populates="employees")
    policies: List["Policy"] = Relationship(back_populates="applicant")
    risk_assessments: List["RiskAssessment"] = Relationship(back_populates="applicant")
    artifacts: List["Artifact"] = Relationship(back_populates="applicant")


# ─────────────────────────────────────────────────────────────────────────────
# MasterPolicy  —  a group contract between an Organization and the insurer
# ─────────────────────────────────────────────────────────────────────────────

class MasterPolicy(SQLModel, table=True):
    """
    The single contract issued to an Organization covering its employees (e.g.
    Group Life). Each covered employee gets their own Policy row (their
    Certificate of Insurance) linked back here via Policy.master_policy_id.
    """
    __tablename__ = "master_policies"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    organization_id: UUID = Field(foreign_key="organizations.id", index=True, nullable=False)

    insurance_type: InsuranceTypeEnum = Field(max_length=50)   # GROUP_LIFE in v1
    sum_assured_multiple: float = Field(ge=0)                  # e.g. 24.0 = 24x monthly basic salary
    term_years: int = Field(ge=1, le=40)
    effective_date: date
    status: str = Field(default="Pending", max_length=50)      # Pending / Active / Review

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="master_policies")
    organization: Optional[Organization] = Relationship(back_populates="master_policies")
    certificates: List["Policy"] = Relationship(back_populates="master_policy")


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

    # Set only for a Certificate of Insurance issued under a group MasterPolicy;
    # NULL for individually-underwritten policies (unchanged, existing behavior).
    master_policy_id: Optional[UUID] = Field(default=None, foreign_key="master_policies.id", index=True, nullable=True)

    product_name: str = Field(max_length=255)           # e.g. "Term Life", "Health Platinum"
    insurance_type: InsuranceTypeEnum = Field(max_length=50)
    coverage_amount: float = Field(ge=0)                # in PKR
    term_years: int = Field(ge=1, le=40)

    # Only populated for CHILD_EDUCATION_MARRIAGE — the insured milestone
    # belongs to a dependent, not the proposer/applicant.
    dependent_name: Optional[str] = Field(default=None, max_length=255)
    dependent_dob: Optional[date] = Field(default=None)

    # Beneficiary on death — optional at the DB layer (nullable, like
    # dependent_name/dependent_dob above) so existing rows stay valid; the
    # quote/onboarding API layer enforces it as required for new policies.
    nominee_name: Optional[str] = Field(default=None, max_length=255)
    nominee_relationship: Optional[str] = Field(default=None, max_length=100)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="policies")
    applicant: Optional[Applicant] = Relationship(back_populates="policies")
    master_policy: Optional[MasterPolicy] = Relationship(back_populates="certificates")
    claims: List["Claim"] = Relationship(back_populates="policy")
    commission: Optional["Commission"] = Relationship(back_populates="policy")
    premium_quotes: List["PremiumQuote"] = Relationship(back_populates="policy")


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

    # Policy linkage — optional since older rows predate this column
    policy_id: Optional[UUID] = Field(default=None, foreign_key="policies.id", index=True, nullable=True)

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

    # Composite weighted score (0–100) computed by the risk engine aggregation node
    composite_risk_score: Optional[int] = Field(default=None, ge=0, le=100)

    # Case linkage — optional since Live Evaluation has no case context
    case_id: Optional[UUID] = Field(default=None, foreign_key="cases.caseld", nullable=True)

    # AI case summary generated by the text-summarizer before evaluation
    ai_summary: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))

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
    applicant_id: Optional[UUID] = Field(default=None, foreign_key="applicants.id", index=True)
    claim_id: Optional[UUID] = Field(default=None, foreign_key="claims.id", index=True)
    case_id: Optional[UUID] = Field(default=None, foreign_key="cases.caseld", index=True)
    uploaded_by: Optional[UUID] = Field(default=None, foreign_key="users.id", index=True)

    document_type: str = Field(max_length=100)
    file_name: Optional[str] = Field(default=None, sa_column=Column(String(255), nullable=True))
    file_size: Optional[int] = Field(default=None, sa_column=Column(Integer, nullable=True))
    file_type: Optional[str] = Field(default=None, sa_column=Column(String(100), nullable=True))
    storage_url: Optional[str] = Field(default=None, sa_column=Column(String(1000), nullable=True))
    ocr_result: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    ocr_confidence_score: float = Field(default=0.0, ge=0.0, le=1.0)
    authenticity_score: float = Field(default=1.0, ge=0.0, le=1.0)
    quality_score: float = Field(default=1.0, ge=0.0, le=1.0)
    tampered_flag: bool = Field(default=False)
    status: str = Field(default="Processing", max_length=50)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

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


# ─────────────────────────────────────────────────────────────────────────────
# PremiumQuote  —  ledger of premium calculations produced by the (upcoming)
# Rating/Pricing Engine for a given Policy. Append-only: re-pricing a policy
# creates a new row rather than overwriting the previous quote.
# ─────────────────────────────────────────────────────────────────────────────

class PremiumQuote(SQLModel, table=True):
    __tablename__ = "premium_quotes"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    base_premium: float = Field(ge=0)
    loading_applied: float = Field(default=0.0, ge=0)   # currency amount added on top of base_premium
    total_premium: float = Field(ge=0)
    rate_version: str = Field(max_length=50)             # ties the quote back to the InsurancePlan.rate_version used

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="premium_quotes")
    policy: Optional[Policy] = Relationship(back_populates="premium_quotes")


# ─────────────────────────────────────────────────────────────────────────────
# InsurancePlan  —  a tenant's catalog entry defining the eligibility rules and
# required documents for a plan type. Editable per-tenant by an Admin (the
# static PLANS list in the frontend and UNDERWRITING_RULES/REQUIRED_DOCUMENTS in
# the services are the seed defaults this table is populated from).
# ─────────────────────────────────────────────────────────────────────────────

class InsurancePlan(SQLModel, table=True):
    __tablename__ = "insurance_plans"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code", name="uq_insurance_plan_code_per_tenant"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)

    # Identity / classification
    code: str = Field(index=True, max_length=50)                 # e.g. "TERM_LIFE" — unique per tenant
    label: str = Field(max_length=255)                           # e.g. "Term Life"
    insurance_type: InsuranceTypeEnum = Field(max_length=50)
    category: PlanCategoryEnum = Field(default=PlanCategoryEnum.INDIVIDUAL, max_length=50)
    product_category: ProductCategoryEnum = Field(default=ProductCategoryEnum.CONVENTIONAL, max_length=50)
    partner_bank: Optional[str] = Field(default=None, max_length=255)  # set for Bancassurance plans
    status: PlanStatusEnum = Field(default=PlanStatusEnum.DRAFT, max_length=50)
    description: str = Field(default="", sa_column=Column(Text, nullable=False))
    color: str = Field(default="blue", max_length=30)            # UI accent/badge colour

    # Eligibility band (proposer)
    entry_age_min: int = Field(ge=0, le=120)
    entry_age_max: int = Field(ge=0, le=120)
    entry_age_label: str = Field(default="Proposer", max_length=100)

    # Dependent band — only meaningful for CHILD_EDUCATION_MARRIAGE
    dependent_age_min: Optional[int] = Field(default=None, ge=0, le=120)
    dependent_age_max: Optional[int] = Field(default=None, ge=0, le=120)

    # Term / maturity / coverage limits
    term_min_years: int = Field(ge=1, le=100)
    term_max_years: int = Field(ge=1, le=100)
    max_maturity_age: int = Field(ge=0, le=120)
    max_income_multiple: float = Field(ge=0)

    # Group-specific (optional; only for GROUP plans)
    min_group_size: Optional[int] = Field(default=None, ge=0)
    underwriting_basis: Optional[str] = Field(default=None, max_length=255)

    # Pricing framework — consumed by the (upcoming) Rating/Pricing Engine.
    # Defaults are neutral (0 rate / 1.0x factor) so existing plans stay valid
    # until real rates are loaded per plan.
    base_premium_rate: float = Field(default=0.0, ge=0)   # e.g. PKR per 1,000 sum assured per year
    smoker_factor: float = Field(default=1.0, ge=0)       # multiplier applied to base_premium_rate for smokers
    rate_version: str = Field(default="v1", max_length=50)  # identifies which rate table these values belong to

    # Nested reference data stored as JSON:
    #   medical_exam_tiers: [{"minSumAssured": 0, "tier": "No medical exam required"}, ...]
    #   required_documents: ["CNIC", "Medical Report", ...]
    medical_exam_tiers: List[dict] = Field(default_factory=list, sa_column=Column(JSON, nullable=False))
    required_documents: List[str] = Field(default_factory=list, sa_column=Column(JSON, nullable=False))

    is_active: bool = Field(default=True, nullable=False)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    tenant: Optional[Tenant] = Relationship(back_populates="insurance_plans")


# ─────────────────────────────────────────────────────────────────────────────
# Case Management Enums
# ─────────────────────────────────────────────────────────────────────────────

class CaseTypeEnum(str, Enum):
    UNDERWRITING = "Underwriting"
    CLAIM = "Claim"
    INQUIRY = "Inquiry"

class CaseStatusEnum(str, Enum):
    NEW = "New"
    IN_PROGRESS = "InProgress"
    PENDING_DOCUMENTS = "Pending Documents"
    UNDER_REVIEW = "Under Review"
    APPROVED = "Approved"
    REJECTED = "Rejected"
    CLOSED = "Closed"

class CasePriorityEnum(str, Enum):
    LOW = "Low"
    NORMAL = "Normal"
    HIGH = "High"
    CRITICAL = "Critical"

class SourceChannelEnum(str, Enum):
    AGENT = "Agent"
    BANCASSURANCE = "Bancassurance"
    ONLINE = "Online"
    BRANCH = "Branch"
    MOBILE = "Mobile"

class StatusCategoryEnum(str, Enum):
    OPEN = "Open"
    ACTIVE = "Active"
    PENDING = "Pending"
    TERMINAL = "Terminal"

class WorkflowStateEnum(str, Enum):
    RUNNING = "Running"
    PAUSED = "Paused"
    COMPLETED = "Completed"
    FAILED = "Failed"

class AssignedRoleEnum(str, Enum):
    UNDERWRITER = "Underwriter"
    ANALYST = "Analyst"
    MANAGER = "Manager"
    COORDINATOR = "Coordinator"
    REVIEWER = "Reviewer"

class AssignmentTypeEnum(str, Enum):
    PRIMARY = "Primary"
    SECONDARY = "Secondary"
    ESCALATION = "Escalation"
    TEMPORARY = "Temporary"

class AssignmentStatusEnum(str, Enum):
    ACTIVE = "Active"
    COMPLETED = "Completed"
    TRANSFERRED = "Transferred"
    REVOKED = "Revoked"

class ActionTypeEnum(str, Enum):
    STATUS_CHANGE = "StatusChange"
    ASSIGNMENT = "Assignment"
    COMMENT = "Comment"
    ESCALATION = "Escalation"
    DOCUMENT_UPLOAD = "DocumentUpload"
    DECISION = "Decision"

class ResolutionStatusEnum(str, Enum):
    OPEN = "Open"
    RESOLVED = "Resolved"
    PENDING = "Pending"
    CLOSED = "Closed"

class CommentTypeEnum(str, Enum):
    INTERNAL = "Internal"
    EXTERNAL = "External"

class VisibilityLevelEnum(str, Enum):
    PRIVATE = "Private"
    TEAM = "Team"
    ALL = "All"

class DocumentClassificationEnum(str, Enum):
    MEDICAL = "Medical"
    FINANCIAL = "Financial"
    IDENTITY = "Identity"
    LEGAL = "Legal"
    OTHER = "Other"


# ─────────────────────────────────────────────────────────────────────────────
# 1. Case
# ─────────────────────────────────────────────────────────────────────────────
class Case(SQLModel, table=True):
    __tablename__ = "cases"

    caseld: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True)
    applicant_id: UUID = Field(foreign_key="applicants.id", index=True)
    caseNumber: str = Field(index=True, unique=True, max_length=50)
    caseType: CaseTypeEnum = Field(max_length=50)
    caseStatus: CaseStatusEnum = Field(default=CaseStatusEnum.NEW, max_length=50)
    priorityLevel: CasePriorityEnum = Field(default=CasePriorityEnum.NORMAL, max_length=50)
    sourceChannel: SourceChannelEnum = Field(max_length=50)
    createdAt: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    updatedAt: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    assignedTeamld: Optional[UUID] = Field(default=None, nullable=True)
    assignedAgentId: Optional[UUID] = Field(default=None, foreign_key="users.id", nullable=True)
    slaDeadline: Optional[datetime] = Field(default=None, nullable=True)
    escalationLevel: int = Field(default=0)
    parentCaseld: Optional[UUID] = Field(default=None, foreign_key="cases.caseld", nullable=True)

    # Relationships
    workflows: List["CaseWorkflow"] = Relationship(back_populates="case")
    assignments: List["CaseAssignment"] = Relationship(back_populates="case")
    history: List["CaseHistory"] = Relationship(back_populates="case")
    escalations: List["CaseEscalation"] = Relationship(back_populates="case")
    comments: List["CaseComment"] = Relationship(back_populates="case")
    attachments: List["CaseAttachment"] = Relationship(back_populates="case")


# ─────────────────────────────────────────────────────────────────────────────
# 2. CaseStatus
# ─────────────────────────────────────────────────────────────────────────────
class CaseStatus(SQLModel, table=True):
    __tablename__ = "case_statuses"

    statusld: UUID = Field(default_factory=uuid4, primary_key=True)
    statusName: CaseStatusEnum = Field(max_length=50, unique=True)
    statusCategory: StatusCategoryEnum = Field(max_length=50)
    isFinalStatus: bool = Field(default=False)
    description: Optional[str] = Field(default=None, nullable=True)


# ─────────────────────────────────────────────────────────────────────────────
# 3. CaseWorkflow
# ─────────────────────────────────────────────────────────────────────────────
class CaseWorkflow(SQLModel, table=True):
    __tablename__ = "case_workflows"

    workflowid: UUID = Field(default_factory=uuid4, primary_key=True)
    caseld: UUID = Field(foreign_key="cases.caseld", index=True)
    currentStep: str = Field(max_length=100)
    previousStep: Optional[str] = Field(default=None, max_length=100, nullable=True)
    workflowState: WorkflowStateEnum = Field(max_length=50)
    triggeredBy: Optional[UUID] = Field(default=None, nullable=True)
    lastUpdatedAt: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    workflowVersion: str = Field(max_length=20)

    case: Optional[Case] = Relationship(back_populates="workflows")


# ─────────────────────────────────────────────────────────────────────────────
# 4. CaseAssignment
# ─────────────────────────────────────────────────────────────────────────────
class CaseAssignment(SQLModel, table=True):
    __tablename__ = "case_assignments"

    assignmentld: UUID = Field(default_factory=uuid4, primary_key=True)
    caseld: UUID = Field(foreign_key="cases.caseld", index=True)
    assignedToUserld: UUID = Field(foreign_key="users.id", index=True)
    assignedRole: AssignedRoleEnum = Field(max_length=50)
    assignmentType: AssignmentTypeEnum = Field(max_length=50)
    assignedAt: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    workloadPercentage: float = Field(default=100.0)
    assignmentStatus: AssignmentStatusEnum = Field(default=AssignmentStatusEnum.ACTIVE, max_length=50)

    case: Optional[Case] = Relationship(back_populates="assignments")


# ─────────────────────────────────────────────────────────────────────────────
# 5. CaseHistory
# ─────────────────────────────────────────────────────────────────────────────
class CaseHistory(SQLModel, table=True):
    __tablename__ = "case_histories"

    historyld: UUID = Field(default_factory=uuid4, primary_key=True)
    caseld: UUID = Field(foreign_key="cases.caseld", index=True)
    actionType: ActionTypeEnum = Field(max_length=50)
    fromStatus: Optional[str] = Field(default=None, max_length=50, nullable=True)
    toStatus: Optional[str] = Field(default=None, max_length=50, nullable=True)
    changedBy: UUID = Field(foreign_key="users.id", index=True)
    changeTimestamp: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    systemGeneratedFlag: bool = Field(default=False)

    case: Optional[Case] = Relationship(back_populates="history")


# ─────────────────────────────────────────────────────────────────────────────
# 6. CasePriority
# ─────────────────────────────────────────────────────────────────────────────
class CasePriority(SQLModel, table=True):
    __tablename__ = "case_priorities"

    priorityld: UUID = Field(default_factory=uuid4, primary_key=True)
    priorityLevel: CasePriorityEnum = Field(max_length=50, unique=True)
    priorityScore: int = Field()
    escalationRuleld: Optional[UUID] = Field(default=None, nullable=True)


# ─────────────────────────────────────────────────────────────────────────────
# 7. CaseEscalation
# ─────────────────────────────────────────────────────────────────────────────
class CaseEscalation(SQLModel, table=True):
    __tablename__ = "case_escalations"

    escalationld: UUID = Field(default_factory=uuid4, primary_key=True)
    caseld: UUID = Field(foreign_key="cases.caseld", index=True)
    escalationLevel: int = Field()
    escalationReason: str = Field(nullable=False)
    escalatedTo: UUID = Field(foreign_key="users.id", index=True)
    escalationTimestamp: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    resolutionStatus: ResolutionStatusEnum = Field(default=ResolutionStatusEnum.OPEN, max_length=50)

    case: Optional[Case] = Relationship(back_populates="escalations")


# ─────────────────────────────────────────────────────────────────────────────
# 8. CaseComment
# ─────────────────────────────────────────────────────────────────────────────
class CaseComment(SQLModel, table=True):
    __tablename__ = "case_comments"

    commentld: UUID = Field(default_factory=uuid4, primary_key=True)
    caseld: UUID = Field(foreign_key="cases.caseld", index=True)
    authorld: UUID = Field(foreign_key="users.id", index=True)
    commentText: str = Field(nullable=False)
    commentType: CommentTypeEnum = Field(max_length=50)
    createdAt: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    visibilityLevel: VisibilityLevelEnum = Field(max_length=50)

    case: Optional[Case] = Relationship(back_populates="comments")


# ─────────────────────────────────────────────────────────────────────────────
# 9. CaseAttachment
# ─────────────────────────────────────────────────────────────────────────────
class CaseAttachment(SQLModel, table=True):
    __tablename__ = "case_attachments"

    attachmentid: UUID = Field(default_factory=uuid4, primary_key=True)
    caseld: UUID = Field(foreign_key="cases.caseld", index=True)
    fileName: str = Field(max_length=255)
    fileType: str = Field(max_length=50)
    fileSize: Optional[int] = Field(default=None, nullable=True)
    storageUrl: str = Field(max_length=500)
    uploadedBy: UUID = Field(foreign_key="users.id", index=True)
    uploadedAt: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    documentClassification: DocumentClassificationEnum = Field(max_length=50)

    case: Optional[Case] = Relationship(back_populates="attachments")


# ─────────────────────────────────────────────────────────────────────────────
# 10. CaseAuditTrail
# ─────────────────────────────────────────────────────────────────────────────
class CaseAuditTrail(SQLModel, table=True):
    __tablename__ = "case_audit_trails"

    auditld: UUID = Field(default_factory=uuid4, primary_key=True)
    caseld: UUID = Field(index=True)
    actionPerformed: str = Field(max_length=200)
    entityChanged: str = Field(max_length=100)
    previousValue: Optional[str] = Field(default=None, nullable=True)
    newValue: Optional[str] = Field(default=None, nullable=True)
    performedBy: UUID = Field(foreign_key="users.id", index=True)
    timestamp: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    ipAddress: Optional[str] = Field(default=None, max_length=45, nullable=True)
