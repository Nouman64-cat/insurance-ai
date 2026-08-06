from datetime import date, datetime
from enum import Enum
from typing import Any, List, Optional
from uuid import UUID, uuid4

from sqlalchemy import Column, Integer, JSON, String, Text, UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel

import os

try:
    from pgvector.sqlalchemy import Vector
    HAS_PGVECTOR = os.environ.get("DISABLE_PGVECTOR", "false").lower() != "true"
except ImportError:
    HAS_PGVECTOR = False


# ─────────────────────────────────────────────────────────────────────────────
# Domain enumerations
# ─────────────────────────────────────────────────────────────────────────────

class Gender(str, Enum):
    MALE = "Male"
    FEMALE = "Female"
    OTHER = "Other"


class MaritalStatus(str, Enum):
    SINGLE = "Single"
    MARRIED = "Married"
    DIVORCED = "Divorced"
    WIDOWED = "Widowed"


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
    FAMILY_FLOATER = "FAMILY_FLOATER"


class PlanCategoryEnum(str, Enum):
    INDIVIDUAL = "Individual"
    GROUP = "Group"
    FAMILY = "Family"


class FamilyRelationshipEnum(str, Enum):
    """A FamilyGroup member's relation to the group's SELF/proposer — exactly
    one member per group must be SELF (services/tenant-service/
    family_underwriting.py enforces this at validation time)."""
    SELF = "Self"
    SPOUSE = "Spouse"
    CHILD = "Child"
    PARENT = "Parent"


class FamilyPlanTypeEnum(str, Enum):
    """Which of the two family-insurance shapes a FamilyPolicy is:
    FLOATER   — one shared sum-insured pool, one Policy row for the whole group.
    LIFE_BUNDLE — each member keeps their own individually-underwritten Policy,
                  grouped here only for a shared discount + single dashboard view.
    """
    FLOATER = "Floater"
    LIFE_BUNDLE = "LifeBundle"


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


class PolicyStatusEnum(str, Enum):
    """Lifecycle of a single Policy row, from indicative quote to bound cover.

    Quoted             — auto-priced or /quote-priced, no case opened yet (non-binding).
    Proposed           — customer selected this quote; an Underwriting Case is open.
    UnderReview        — AI returned Human Review / Approve with Loading; awaiting an
                          underwriter decision (or the aggregation node hasn't run yet).
    InformationRequested — paused, waiting on the customer for documents/medical
                          reports before underwriting can continue.
    Approved           — AI Auto Approve, or an underwriter approved the case.
    AcceptedWithLoadings — Approved with premium loadings applied (underwriting decision).
    Declined           — AI hard-declined, or an underwriter rejected the case.
    Issued             — Policy issued (legacy / transitional; use Active for live cover).
    Active             — Premium paid, coverage is live and in force.
    GracePeriod        — Policy expired without renewal payment; claims still honoured
                          during the grace window (configurable, default 30 days).
    Lapsed             — Coverage terminated — non-payment past grace period.
    Cancelled          — Coverage terminated at customer or insurer request.
    PendingPayment     — Binding initiated; awaiting payment confirmation before
                          coverage activates. Phase 2: payment gateway flips this
                          to Active on settlement webhook.
    """
    QUOTED = "Quoted"
    PROPOSED = "Proposed"
    UNDER_REVIEW = "UnderReview"
    INFORMATION_REQUESTED = "InformationRequested"
    COUNTER_OFFER = "CounterOffer"
    APPROVED = "Approved"
    ACCEPTED_WITH_LOADINGS = "AcceptedWithLoadings"
    PENDING_PAYMENT = "PendingPayment"
    DECLINED = "Declined"
    ISSUED = "Issued"
    ACTIVE = "Active"
    GRACE_PERIOD = "GracePeriod"
    LAPSED = "Lapsed"
    CANCELLED = "Cancelled"
    POSTPONED = "Postponed"
    REINSURER_REFERRED = "ReinsurerReferred"
    NOT_TAKEN_UP = "NotTakenUp"


class ProfileStatusEnum(str, Enum):
    LEAD = "LEAD"
    PROSPECT = "PROSPECT"
    DRAFT = "DRAFT"
    UNDERWRITING_READY = "UNDERWRITING_READY"
    NOT_INTERESTED = "NOT_INTERESTED"
    POLICYHOLDER = "POLICYHOLDER"


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

    # Company profile — captured at onboarding, all optional so existing rows
    # (and any code that only ever set name/code) keep working.
    registration_number: Optional[str] = Field(default=None, max_length=100)  # SECP/company reg. no.
    license_number: Optional[str] = Field(default=None, max_length=100)       # SECP insurance license no.
    head_office_address: Optional[str] = Field(default=None, max_length=500)
    city: Optional[str] = Field(default=None, max_length=100)
    province: Optional[str] = Field(default=None, max_length=100)
    contact_person: Optional[str] = Field(default=None, max_length=255)
    contact_email: Optional[str] = Field(default=None, max_length=255)
    contact_phone: Optional[str] = Field(default=None, max_length=50)
    website: Optional[str] = Field(default=None, max_length=255)
    established_date: Optional[date] = Field(default=None)

    # Relationships
    customers: List["Customer"] = Relationship(back_populates="tenant")
    organizations: List["Organization"] = Relationship(back_populates="tenant")
    acquisition_sources: List["AcquisitionSource"] = Relationship(back_populates="tenant")
    policies: List["Policy"] = Relationship(back_populates="tenant")
    master_policies: List["MasterPolicy"] = Relationship(back_populates="tenant")
    family_groups: List["FamilyGroup"] = Relationship(back_populates="tenant")
    family_policies: List["FamilyPolicy"] = Relationship(back_populates="tenant")
    risk_assessments: List["RiskAssessment"] = Relationship(back_populates="tenant")
    claims: List["Claim"] = Relationship(back_populates="tenant")
    artifacts: List["Artifact"] = Relationship(back_populates="tenant")
    commissions: List["Commission"] = Relationship(back_populates="tenant")
    users: List["User"] = Relationship(back_populates="tenant")
    insurance_plans: List["InsurancePlan"] = Relationship(back_populates="tenant")
    premium_quotes: List["PremiumQuote"] = Relationship(back_populates="tenant")
    branches: List["Branch"] = Relationship(back_populates="tenant")


# ─────────────────────────────────────────────────────────────────────────────
# Branch  —  a physical office (head office / regional / branch / liaison)
# operated by a Tenant, identified by a tenant-scoped branch code.
# ─────────────────────────────────────────────────────────────────────────────

class BranchTypeEnum(str, Enum):
    HEAD_OFFICE = "HEAD_OFFICE"
    REGIONAL_OFFICE = "REGIONAL_OFFICE"
    BRANCH = "BRANCH"
    LIAISON_OFFICE = "LIAISON_OFFICE"


class Branch(SQLModel, table=True):
    """
    One row per physical office of a Tenant. branch_code is unique per tenant
    (not globally) since codes are tenant-issued, e.g. "LHR-01".
    """
    __tablename__ = "branches"
    __table_args__ = (UniqueConstraint("tenant_id", "branch_code", name="uq_branch_tenant_code"),)

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)

    branch_code: str = Field(max_length=50, index=True)
    name: str = Field(max_length=255)
    branch_type: BranchTypeEnum = Field(default=BranchTypeEnum.BRANCH, max_length=50)

    region: Optional[str] = Field(default=None, max_length=100)
    city: str = Field(max_length=100)
    address: Optional[str] = Field(default=None, max_length=500)
    postal_code: Optional[str] = Field(default=None, max_length=20)

    contact_person: Optional[str] = Field(default=None, max_length=255)
    contact_phone: Optional[str] = Field(default=None, max_length=50)
    contact_email: Optional[str] = Field(default=None, max_length=255)

    manager_user_id: Optional[UUID] = Field(default=None, foreign_key="users.id", nullable=True)
    is_active: bool = Field(default=True, nullable=False)
    opened_date: Optional[date] = Field(default=None)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="branches")


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
    branch_id: Optional[UUID] = Field(default=None, foreign_key="branches.id", nullable=True)

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
    cnic: Optional[str] = Field(default=None, max_length=15, nullable=True)
    location: Optional[str] = Field(default=None, max_length=255, nullable=True)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    user: Optional[User] = Relationship(back_populates="profile")


if HAS_PGVECTOR:
    class AgentKnowledgeBase(SQLModel, table=True):
        __tablename__ = "agent_knowledge_base"

        id: UUID = Field(default_factory=uuid4, primary_key=True)
        tenant_id: Optional[UUID] = Field(default=None, index=True) # Nullable for global SOPs
        category: str = Field(max_length=50) # "SOP", "Rule", "Product"
        title: str = Field(max_length=255)
        content: str
        embedding: Any = Field(sa_column=Column(Vector(3072))) # Gemini embeddings are 3072 dims
        created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)


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

    branch_id: Optional[UUID] = Field(default=None, foreign_key="branches.id", index=True, nullable=True)
    assigned_agent_id: Optional[UUID] = Field(default=None, foreign_key="users.id", index=True, nullable=True)
    city: Optional[str] = Field(default=None, max_length=100)
    province: Optional[str] = Field(default=None, max_length=100)

    profile_status: ProfileStatusEnum = Field(default=ProfileStatusEnum.LEAD, max_length=50)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="organizations")
    employees: List["Customer"] = Relationship(back_populates="organization")
    master_policies: List["MasterPolicy"] = Relationship(back_populates="organization")


# ─────────────────────────────────────────────────────────────────────────────
# AcquisitionSource  —  who brought the customer to the insurer
# ─────────────────────────────────────────────────────────────────────────────

class AcquisitionSourceType(str, Enum):
    AGENT = "AGENT"                    # individual tied/independent agent
    BROKER = "BROKER"                  # brokerage firm
    BANCASSURANCE = "BANCASSURANCE"    # a partner bank's insurance desk
    CORPORATE_AGENT = "CORPORATE_AGENT"  # corporate tie-up / referral partner
    DIRECT = "DIRECT"                  # insurer's own direct-sales team / walk-in
    DIGITAL = "DIGITAL"                # online / aggregator / app funnel


class AcquisitionSource(SQLModel, table=True):
    """The distribution channel or intermediary credited with bringing a
    customer to the insurer — an individual agent, a brokerage firm, a partner
    bank's bancassurance desk, a corporate tie-up, the insurer's own direct
    sales team, or a digital funnel.

    Tenant-scoped: every insurer maintains its own producer roster, so `code`
    is unique per tenant (same convention as Branch.branch_code)."""
    __tablename__ = "acquisition_sources"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code", name="uq_acquisition_source_code_per_tenant"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)

    source_type: AcquisitionSourceType = Field(max_length=50, nullable=False)
    name: str = Field(max_length=255)                 # agent's name or firm/bank name
    code: str = Field(index=True, max_length=50)      # tenant-scoped producer code, e.g. AGT-0421

    # Only meaningful for BANCASSURANCE (which bank) / CORPORATE_AGENT (which firm).
    partner_name: Optional[str] = Field(default=None, max_length=255)

    contact_person: Optional[str] = Field(default=None, max_length=255)
    contact_phone: Optional[str] = Field(default=None, max_length=50)
    contact_email: Optional[str] = Field(default=None, max_length=255)
    city: Optional[str] = Field(default=None, max_length=100)
    cnic: Optional[str] = Field(default=None, max_length=20)
    location: Optional[str] = Field(default=None, max_length=255)

    is_active: bool = Field(default=True, nullable=False)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="acquisition_sources")
    customers: List["Customer"] = Relationship(back_populates="acquisition_source")


# ─────────────────────────────────────────────────────────────────────────────
# Customer  —  the person applying for a policy
# ─────────────────────────────────────────────────────────────────────────────

class Customer(SQLModel, table=True):
    """
    Personal and financial profile of an insurance customer.
    CNIC is unique per tenant (same person cannot have two records within one insurer).

    Also doubles as an "employee" record when organization_id is set — a
    business's staff enrolled under a MasterPolicy are Customer rows too, so
    they get the same Case/Artifact/RiskAssessment/Claim machinery for free.
    """
    __tablename__ = "customers"
    __table_args__ = (
        UniqueConstraint("tenant_id", "cnic", name="uq_customer_cnic_per_tenant"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)

    # Set only for employees enrolled under an Organization's group policy;
    # NULL for individual customers (unchanged, existing behavior).
    organization_id: Optional[UUID] = Field(default=None, foreign_key="organizations.id", index=True, nullable=True)

    # Set only for members enrolled under a FamilyGroup (floater or life-bundle
    # policy); NULL for individual and corporate-group customers. A Customer
    # is never both organization_id and family_group_id at once.
    family_group_id: Optional[UUID] = Field(default=None, foreign_key="family_groups.id", index=True, nullable=True)
    family_relationship: Optional[FamilyRelationshipEnum] = Field(default=None, max_length=50)

    # Who brought this customer in — the crediting agent/broker/bank/etc.
    # NULL for legacy rows and any customer created before this was tracked.
    acquisition_source_id: Optional[UUID] = Field(default=None, foreign_key="acquisition_sources.id", index=True, nullable=True)

    # Branch handling this lead, and the internal user (Agent role) assigned to work it.
    branch_id: Optional[UUID] = Field(default=None, foreign_key="branches.id", index=True, nullable=True)
    assigned_agent_id: Optional[UUID] = Field(default=None, foreign_key="users.id", index=True, nullable=True)
    city: Optional[str] = Field(default=None, max_length=100)
    province: Optional[str] = Field(default=None, max_length=100)

    # Identity
    cnic: Optional[str] = Field(default=None, index=True, max_length=15, nullable=True)        # Pakistani National Identity Card
    name: str = Field(max_length=255)
    # Permanent policyholder / client number, minted at Stage B onboarding and
    # reused across every policy this customer holds (e.g. "PH-2026-000123").
    policyholder_id: Optional[str] = Field(default=None, index=True, max_length=50, nullable=True)
    dob: Optional[date] = Field(default=None, nullable=True)
    gender: Optional[Gender] = Field(default=None, max_length=50, nullable=True)
    marital_status: Optional[MaritalStatus] = Field(default=None, max_length=50, nullable=True)

    # Socio-economic profile used by the risk engine
    occupation: Optional[str] = Field(default=None, max_length=255, nullable=True)
    declared_income: Optional[float] = Field(default=None, ge=0, nullable=True)

    # Pricing-relevant risk flags — promoted out of `details` to strongly-typed
    # columns so the (upcoming) Rating/Pricing Engine has a validated contract
    # instead of reading an untyped JSON blob.
    is_smoker: Optional[bool] = Field(default=False, nullable=True)
    height_cm: Optional[float] = Field(default=170.0, gt=0, nullable=True)
    weight_kg: Optional[float] = Field(default=70.0, gt=0, nullable=True)

    profile_status: ProfileStatusEnum = Field(default=ProfileStatusEnum.LEAD, max_length=50)

    details: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="customers")
    organization: Optional[Organization] = Relationship(back_populates="employees")
    family_group: Optional["FamilyGroup"] = Relationship(
        back_populates="members",
        sa_relationship_kwargs={"foreign_keys": "Customer.family_group_id"},
    )
    acquisition_source: Optional["AcquisitionSource"] = Relationship(back_populates="customers")
    policies: List["Policy"] = Relationship(
        back_populates="customer", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    risk_assessments: List["RiskAssessment"] = Relationship(
        back_populates="customer", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    artifacts: List["Artifact"] = Relationship(
        back_populates="customer", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    cases: List["Case"] = Relationship(
        back_populates="customer", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )


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

    # Guaranteed-issue ceiling — computed from group size + average age the
    # first time a census is confirmed (group_underwriting.compute_free_cover_limit).
    # Null until then; not recomputed on later top-up census confirms so the
    # guaranteed-issue/above-FCL split already applied to the existing roster
    # doesn't retroactively change.
    free_cover_limit: Optional[float] = Field(default=None, ge=0)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="master_policies")
    organization: Optional[Organization] = Relationship(back_populates="master_policies")
    certificates: List["Policy"] = Relationship(back_populates="master_policy")


# ─────────────────────────────────────────────────────────────────────────────
# FamilyGroup / FamilyPolicy  —  an admin-created household insured under
# either a shared health floater or a bundle of individually-underwritten
# life policies. Mirrors Organization/MasterPolicy's shape (an "employer" for
# a family unit instead of a business), but deliberately has no Free Cover
# Limit / guaranteed-issue concept — families are small and self-selected, so
# every member is individually risk-scored regardless of plan type (see
# services/tenant-service/routers/families.py).
# ─────────────────────────────────────────────────────────────────────────────

class FamilyGroup(SQLModel, table=True):
    """An admin/underwriter-created household. Members are Customer rows with
    family_group_id set (same nullable-FK-on-Customer pattern Organization
    already uses via organization_id)."""
    __tablename__ = "family_groups"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)

    name: str = Field(max_length=255)                     # e.g. "Ahmed Family"
    contact_person: Optional[str] = Field(default=None, max_length=255)
    contact_email: Optional[str] = Field(default=None, max_length=255)
    contact_phone: Optional[str] = Field(default=None, max_length=50)

    # Household income used for every member's risk-engine income-multiple
    # check on FLOATER plans (children/non-earning spouses have no income of
    # their own — see family_underwriting.py / routers/families.py). Captured
    # once at group creation, not derived from any single member row.
    household_declared_income: Optional[float] = Field(default=None, ge=0)

    # Set once the SELF/proposer member is added — the anchor customer_id
    # used on the single shared Policy row for a FLOATER FamilyPolicy.
    primary_member_customer_id: Optional[UUID] = Field(default=None, foreign_key="customers.id", nullable=True)

    branch_id: Optional[UUID] = Field(default=None, foreign_key="branches.id", index=True, nullable=True)
    assigned_agent_id: Optional[UUID] = Field(default=None, foreign_key="users.id", index=True, nullable=True)
    city: Optional[str] = Field(default=None, max_length=100)
    province: Optional[str] = Field(default=None, max_length=100)

    profile_status: ProfileStatusEnum = Field(default=ProfileStatusEnum.LEAD, max_length=50)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="family_groups")
    members: List["Customer"] = Relationship(
        back_populates="family_group",
        sa_relationship_kwargs={"foreign_keys": "Customer.family_group_id"},
    )
    family_policies: List["FamilyPolicy"] = Relationship(back_populates="family_group")


class FamilyPolicy(SQLModel, table=True):
    """The contract issued under a FamilyGroup — either a shared health
    floater (one pooled Policy for the whole family) or a life-bundle wrapper
    (each member keeps their own individually-underwritten Policy, grouped
    here only for a shared discount + single dashboard view). A FamilyGroup
    may have both kinds simultaneously, exactly like an Organization can have
    multiple MasterPolicy rows."""
    __tablename__ = "family_policies"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    family_group_id: UUID = Field(foreign_key="family_groups.id", index=True, nullable=False)

    plan_type: FamilyPlanTypeEnum = Field(max_length=50)

    # FLOATER only: FAMILY_FLOATER. NULL for LIFE_BUNDLE — each member's own
    # Policy.insurance_type (TERM_LIFE/WHOLE_LIFE) carries that instead, since
    # a life bundle can mix plan types across members.
    insurance_type: Optional[InsuranceTypeEnum] = Field(default=None, max_length=50)

    # FLOATER only: the shared sum-insured pool. NULL for LIFE_BUNDLE, where
    # each member's own Policy.coverage_amount is authoritative instead.
    total_sum_insured: Optional[float] = Field(default=None, ge=0)

    # LIFE_BUNDLE only: family-bundling discount applied to each member's
    # effective base_premium_rate at pricing time. NULL/unused for FLOATER —
    # a floater's price already reflects the pooling benefit structurally
    # (one calculation against the eldest life for the whole pool), so
    # stacking a second discount on top would double-count it.
    discount_percentage: Optional[float] = Field(default=None, ge=0, le=50)

    term_years: int = Field(ge=1, le=40)
    effective_date: date
    status: str = Field(default="Pending", max_length=50)   # Pending / Active / Review

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="family_policies")
    family_group: Optional[FamilyGroup] = Relationship(back_populates="family_policies")
    certificates: List["Policy"] = Relationship(back_populates="family_policy")


# ─────────────────────────────────────────────────────────────────────────────
# Policy  —  the insurance product being applied for
# ─────────────────────────────────────────────────────────────────────────────

class Policy(SQLModel, table=True):
    """
    A requested insurance policy linked to a specific customer and tenant.
    Coverage details drive the risk-engine scoring logic.
    """
    __tablename__ = "policies"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    customer_id: UUID = Field(foreign_key="customers.id", index=True, nullable=False)

    # Set only for a Certificate of Insurance issued under a group MasterPolicy;
    # NULL for individually-underwritten policies (unchanged, existing behavior).
    master_policy_id: Optional[UUID] = Field(default=None, foreign_key="master_policies.id", index=True, nullable=True)

    # Set only for a policy issued under a FamilyGroup — either the single
    # shared Policy for a FLOATER FamilyPolicy (coverage_amount = the pool
    # total), or one of N per-member certificates under a LIFE_BUNDLE
    # FamilyPolicy (own coverage_amount). NULL for everything else. A Policy
    # is never both master_policy_id and family_policy_id at once.
    family_policy_id: Optional[UUID] = Field(default=None, foreign_key="family_policies.id", index=True, nullable=True)

    product_name: str = Field(max_length=255)           # e.g. "Term Life", "Health Platinum"
    insurance_type: InsuranceTypeEnum = Field(max_length=50)
    coverage_amount: float = Field(ge=0)                # in PKR
    term_years: int = Field(ge=1, le=40)

    # Only populated for CHILD_EDUCATION_MARRIAGE — the insured milestone
    # belongs to a dependent, not the proposer/customer.
    dependent_name: Optional[str] = Field(default=None, max_length=255)
    dependent_dob: Optional[date] = Field(default=None)

    # Beneficiary on death — optional at the DB layer (nullable, like
    # dependent_name/dependent_dob above) so existing rows stay valid; the
    # quote/onboarding API layer enforces it as required for new policies.
    nominee_name: Optional[str] = Field(default=None, max_length=255)
    nominee_relationship: Optional[str] = Field(default=None, max_length=100)

    # Lifecycle status — see PolicyStatusEnum. Defaults to Quoted so existing
    # rows (and every row created by the quote worker / POST /quote) stay
    # correct without a backfill.
    status: PolicyStatusEnum = Field(default=PolicyStatusEnum.QUOTED, max_length=50)

    # ── Issuance / Contract fields (populated at issue time) ──────────────────
    # Unique human-readable policy number — e.g. "PL-2026-0001". Null until issued.
    policy_number: Optional[str] = Field(default=None, max_length=50, index=True)
    # Coverage window set when the policy is bound and activated.
    expiry_date: Optional[date] = Field(default=None)
    # End of the grace period window after expiry (default: expiry + 30 days).
    grace_period_end_date: Optional[date] = Field(default=None)
    # Points to the latest PolicyVersion snapshot for this policy.
    current_version_id: Optional[UUID] = Field(default=None, nullable=True)

    # ── Free-look / cooling-off (Stage B step 1 anchor, captured at binding) ───
    # Date the policy documents reached the customer. Set when cover binds
    # (PENDING_PAYMENT → ACTIVE). The statutory free-look window is counted from
    # HERE, not from effective_date — the two can differ.
    delivery_date: Optional[date] = Field(default=None)
    # End of the free-look window (delivery_date + FREE_LOOK_DAYS). A cancellation
    # on or before this date is a full-refund exit; Stage B enforces that.
    free_look_end_date: Optional[date] = Field(default=None)
    # Which mandatory Stage A gates were bypassed in DEMO mode at issuance —
    # a comma-separated list drawn from ComplianceBypassed / BeneficiaryBypassed /
    # RequirementBypassed / ReinsuranceBypassed, or "NotFlagged". In production
    # those gates are hard blockers, so a real issue stays NotFlagged. Width is
    # generous because every flag can be set at once.
    demo_bypass_flags: Optional[str] = Field(default="NotFlagged", max_length=200)
    # Stage B recurring collection — mock standing instruction / auto-debit mandate.
    autopay_enabled: bool = Field(default=False)
    # ── Issuance formalities ──────────────────────────────────────────────────
    # Contract maturity date (effective_date + term, capped by product max age).
    maturity_date: Optional[date] = Field(default=None)
    # Authorising officer + timestamp captured when the policy is issued/bound.
    issued_by: Optional[str] = Field(default=None, max_length=255)
    issued_at: Optional[datetime] = Field(default=None)
    # ─────────────────────────────────────────────────────────────────────────

    effective_date: Optional[date] = Field(default=None)
    assigned_underwriter_id: Optional[UUID] = Field(default=None, foreign_key="users.id", index=True, nullable=True)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="policies")
    customer: Optional[Customer] = Relationship(back_populates="policies")
    master_policy: Optional[MasterPolicy] = Relationship(back_populates="certificates")
    family_policy: Optional["FamilyPolicy"] = Relationship(back_populates="certificates")
    claims: List["Claim"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    commission: Optional["Commission"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    premium_quotes: List["PremiumQuote"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    cases: List["Case"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    policy_versions: List["PolicyVersion"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    premium_schedules: List["PremiumSchedule"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    renewal_transactions: List["RenewalTransaction"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    policy_documents: List["PolicyDocument"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    policy_events: List["PolicyEvent"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    counter_offers: List["CounterOffer"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    policy_requirements: List["PolicyRequirement"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    compliance_checks: List["ComplianceCheck"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    beneficiaries: List["Beneficiary"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    beneficiary_versions: List["BeneficiaryVersion"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    policy_onboarding: Optional["PolicyOnboarding"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    premium_reminders: List["PremiumReminder"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    premium_receipts: List["PremiumReceipt"] = Relationship(
        back_populates="policy", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )


# ─────────────────────────────────────────────────────────────────────────────
# RiskAssessment  —  AI underwriting output for an customer
# ─────────────────────────────────────────────────────────────────────────────

class RiskAssessment(SQLModel, table=True):
    """
    Stores the output produced by the risk-engine and decision-engine for a
    given customer. One customer may have multiple assessments over time
    (re-assessment after additional information, appeals, etc.).
    """
    __tablename__ = "risk_assessments"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    customer_id: UUID = Field(foreign_key="customers.id", index=True, nullable=False)

    # Policy linkage — optional since older rows predate this column
    policy_id: Optional[UUID] = Field(default=None, foreign_key="policies.id", index=True, nullable=True)

    # Idempotency key for the Kafka path. Kafka delivers at-least-once, so a
    # redelivered RiskEvaluated event would otherwise append a duplicate
    # assessment. Set to RiskEvaluatedEvent.correlation_id by
    # api-gateway/risk_result_worker.py and checked before insert; always NULL
    # for assessments written by the synchronous /evaluate/stream path.
    correlation_id: Optional[UUID] = Field(default=None, index=True, nullable=True)

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
    reasons: Optional[List[Any]] = Field(
        default=None,
        sa_column=Column(JSON, nullable=True),
    )

    # Per-category XAI reasons — kept separately from the flat `reasons` above so
    # the underwriting UI can always render the Medical / Financial / Fraud
    # explainability breakdown, even for a persisted assessment (after refresh or
    # when viewing one plan of a multi-plan batch).
    medical_reasons: Optional[List[Any]] = Field(
        default=None,
        sa_column=Column(JSON, nullable=True),
    )
    financial_reasons: Optional[List[Any]] = Field(
        default=None,
        sa_column=Column(JSON, nullable=True),
    )
    fraud_reasons: Optional[List[Any]] = Field(
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
    customer: Optional[Customer] = Relationship(back_populates="risk_assessments")


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
# Artifact  —  a document attached to an customer or a claim
# Defined after Claim because claim_id is a FK to claims.
# ─────────────────────────────────────────────────────────────────────────────

class Artifact(SQLModel, table=True):
    __tablename__ = "artifacts"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    customer_id: Optional[UUID] = Field(default=None, foreign_key="customers.id", index=True)
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
    customer: Optional[Customer] = Relationship(back_populates="artifacts")
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
    customer_id: UUID = Field(foreign_key="customers.id", index=True)

    # The specific Policy application this case is underwriting/claiming
    # against. Optional since older cases predate this column and generic
    # Inquiry cases may not have one — falls back to the customer's most
    # recent Policy (see document-checklist) when absent.
    policy_id: Optional[UUID] = Field(default=None, foreign_key="policies.id", index=True, nullable=True)

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
    customer: Optional["Customer"] = Relationship(back_populates="cases")
    policy: Optional["Policy"] = Relationship(back_populates="cases")
    workflows: List["CaseWorkflow"] = Relationship(
        back_populates="case", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    assignments: List["CaseAssignment"] = Relationship(
        back_populates="case", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    history: List["CaseHistory"] = Relationship(
        back_populates="case", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    escalations: List["CaseEscalation"] = Relationship(
        back_populates="case", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    comments: List["CaseComment"] = Relationship(
        back_populates="case", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    attachments: List["CaseAttachment"] = Relationship(
        back_populates="case", sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )


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


# ─────────────────────────────────────────────────────────────────────────────
# Pre-Underwriting — Customer E-Application & Agent's Confidential Report
#
# Intake-stage documents that must be cleared before a Case moves into
# underwriting risk assessment. Distinct from PolicyRequirement/ComplianceCheck
# (Stage A — Pre-Issuance, i.e. *after* an underwriting decision) — these two
# live earlier, tied to the Case rather than a bound Policy.
# ─────────────────────────────────────────────────────────────────────────────

class EApplicationStatusEnum(str, Enum):
    NOT_SENT = "NotSent"
    SENT = "Sent"
    IN_PROGRESS = "InProgress"
    SUBMITTED = "Submitted"
    VERIFIED = "Verified"
    EXPIRED = "Expired"


class CustomerEApplication(SQLModel, table=True):
    """
    The customer-facing E-Application: medical/health questionnaire, family
    history, lifestyle habits, existing-insurance declaration, and the
    proposer's own declaration/e-signature. Filled by the customer via a
    tokenized public link (no login) — see routers/e_application.py.
    """
    __tablename__ = "customer_e_applications"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    case_id: UUID = Field(foreign_key="cases.caseld", index=True, unique=True, nullable=False)
    customer_id: UUID = Field(foreign_key="customers.id", index=True, nullable=False)

    status: EApplicationStatusEnum = Field(default=EApplicationStatusEnum.NOT_SENT, max_length=50)

    # Never store the raw token — only its sha256 hex digest, checked on lookup.
    invite_token_hash: Optional[str] = Field(default=None, index=True, max_length=64, nullable=True)
    invite_expires_at: Optional[datetime] = Field(default=None, nullable=True)
    sent_at: Optional[datetime] = Field(default=None, nullable=True)
    sent_by: Optional[UUID] = Field(default=None, foreign_key="users.id", nullable=True)

    started_at: Optional[datetime] = Field(default=None, nullable=True)
    submitted_at: Optional[datetime] = Field(default=None, nullable=True)
    submitted_ip: Optional[str] = Field(default=None, max_length=45, nullable=True)
    verified_at: Optional[datetime] = Field(default=None, nullable=True)
    verified_by: Optional[UUID] = Field(default=None, foreign_key="users.id", nullable=True)

    # Yes/No disclosure list + free-text details for each "Yes" — see
    # requirements: medical condition/illness, doctor diagnosis, physical
    # deformity, congenital/birth defect, mental/psychiatric/nervous disorder,
    # smoking/alcohol, pregnancy, general family health.
    medical_questionnaire: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))
    # List of {relation, name, age, is_alive, condition, age_at_onset}
    family_history: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))
    # Hazardous hobbies, occupation hazard, foreign travel, driving/legal history
    lifestyle_habits: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))
    # Self-declared other-insurer policies
    existing_insurance: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))
    # Accuracy/authorization/blank-form/terms checkboxes + typed signature name
    declaration: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)


class ACRStatusEnum(str, Enum):
    NOT_STARTED = "NotStarted"
    DRAFT = "Draft"
    SUBMITTED = "Submitted"


class ACRRecommendationEnum(str, Enum):
    RECOMMEND = "Recommend"
    RECOMMEND_WITH_CAUTION = "RecommendWithCaution"
    DO_NOT_RECOMMEND = "DoNotRecommend"


class AgentConfidentialReport(SQLModel, table=True):
    """
    The selling agent's non-medical risk control: moral hazard, financial
    standing, and general lifestyle observations that data fields alone miss.
    Filled by the agent (agent-app or admin), reviewed read-only by underwriters.
    """
    __tablename__ = "agent_confidential_reports"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    case_id: UUID = Field(foreign_key="cases.caseld", index=True, unique=True, nullable=False)
    agent_id: Optional[UUID] = Field(default=None, foreign_key="users.id", index=True, nullable=True)

    status: ACRStatusEnum = Field(default=ACRStatusEnum.NOT_STARTED, max_length=50)

    # Moral hazard
    known_proposer_since: Optional[str] = Field(default=None, max_length=100, nullable=True)
    relationship_to_proposer: Optional[str] = Field(default=None, max_length=255, nullable=True)
    purpose_of_insurance: Optional[str] = Field(default=None, max_length=255, nullable=True)
    financial_interest_explained: Optional[bool] = Field(default=None, nullable=True)
    adverse_info_known: Optional[bool] = Field(default=None, nullable=True)
    adverse_info_details: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))

    # Financial standing
    occupation_verified: Optional[bool] = Field(default=None, nullable=True)
    income_source_verified: Optional[bool] = Field(default=None, nullable=True)
    estimated_income_opinion: Optional[float] = Field(default=None, ge=0, nullable=True)
    income_consistency_note: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))

    # General lifestyle
    health_appearance_note: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    habits_observed: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))
    hazardous_activity_known: Optional[bool] = Field(default=None, nullable=True)

    # Agent/intermediary declaration — the agent's own attestation, distinct
    # from the customer's declaration captured on CustomerEApplication.
    terms_explained_to_proposer: Optional[bool] = Field(default=None, nullable=True)
    identity_verified_kyc: Optional[bool] = Field(default=None, nullable=True)
    signature_obtained_in_presence: Optional[bool] = Field(default=None, nullable=True)

    recommendation: Optional[ACRRecommendationEnum] = Field(default=None, max_length=50, nullable=True)
    remarks: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))

    submitted_at: Optional[datetime] = Field(default=None, nullable=True)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)


class IPPStatusEnum(str, Enum):
    """Mirrors services/payment_gateway.py's PaymentStatusEnum values — kept as
    a separate enum here since shared/models/core.py doesn't import service
    modules, plus a NOT_STARTED value the gateway itself has no concept of."""
    NOT_STARTED = "NotStarted"
    INITIATED = "Initiated"
    REALIZED = "Realized"
    FAILED = "Failed"


class InitialPremiumPayment(SQLModel, table=True):
    """
    Initial Premium Payment (IPP) — Section 30 of the Insurance Ordinance 2000
    ("no premium, no risk"). Per Adamjee's actual proposal flow, this is
    collected at proposal submission, *before* underwriting risk assessment
    begins — distinct from PremiumSchedule/the /payments/* endpoints in
    policies.py, which collect the (possibly re-priced, post-loading) first
    premium *after* an underwriting decision, right before cover binds.
    Amount is taken from the case's PremiumQuote (the pre-underwriting
    estimate), not the final underwritten premium.
    """
    __tablename__ = "initial_premium_payments"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    case_id: UUID = Field(foreign_key="cases.caseld", index=True, unique=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    amount: float = Field(ge=0)
    status: IPPStatusEnum = Field(default=IPPStatusEnum.NOT_STARTED, max_length=50)
    method: Optional[str] = Field(default=None, max_length=50, nullable=True)
    reference: Optional[str] = Field(default=None, max_length=100, nullable=True)

    initiated_at: Optional[datetime] = Field(default=None, nullable=True)
    realized_at: Optional[datetime] = Field(default=None, nullable=True)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)


# ─────────────────────────────────────────────────────────────────────────────
# 11. TokenUsage
# ─────────────────────────────────────────────────────────────────────────────
class TokenUsage(SQLModel, table=True):
    __tablename__ = "token_usage"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    service_name: str = Field(index=True, max_length=100)
    input_tokens: int = Field(default=0)
    output_tokens: int = Field(default=0)
    total_tokens: int = Field(default=0)
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True, nullable=False)


# =============================================================================
# POLICY ISSUANCE & RENEWALS MODULE
# =============================================================================

# ─────────────────────────────────────────────────────────────────────────────
# PolicyVersion  —  immutable snapshot of policy terms at each lifecycle event
# (issuance, endorsement, renewal). Append-only: never update, always insert.
# ─────────────────────────────────────────────────────────────────────────────

class BillingFrequencyEnum(str, Enum):
    ANNUAL = "Annual"
    SEMI_ANNUAL = "SemiAnnual"
    QUARTERLY = "Quarterly"
    MONTHLY = "Monthly"


class PremiumScheduleStatusEnum(str, Enum):
    PENDING = "Pending"
    PAID = "Paid"
    OVERDUE = "Overdue"
    WAIVED = "Waived"


class RenewalStatusEnum(str, Enum):
    INITIATED = "Initiated"
    UNDERWRITING_REVIEW = "UnderwritingReview"
    QUOTED = "Quoted"
    BOUND = "Bound"
    LAPSED = "Lapsed"


class PolicyDocumentTypeEnum(str, Enum):
    PREMIUM_NOTICE = "PremiumNotice"
    SCHEDULE = "PolicySchedule"          # Declarations page
    CERTIFICATE = "CertificateOfInsurance"
    WORDING = "PolicyWording"            # T&Cs + endorsements
    RENEWAL_NOTICE = "RenewalNotice"


class PolicyVersion(SQLModel, table=True):
    """
    Immutable ledger of policy terms at each contract event.
    Version 1.0 = initial issuance.
    Version 1.x = mid-term endorsements (coverage changes, address updates).
    Version N.0 = annual renewal rebinding.

    Format: major (renewal cycle) + minor (endorsement sequence within cycle).
    e.g. "1.0", "1.1", "2.0".
    """
    __tablename__ = "policy_versions"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    version_number: str = Field(max_length=20)      # e.g. "1.0", "1.1", "2.0"
    effective_from: date = Field(nullable=False)
    effective_to: Optional[date] = Field(default=None)  # null = currently active version

    # Premium breakdown at this version (PKR)
    base_premium: float = Field(ge=0)
    loading_amount: float = Field(default=0.0, ge=0)
    policy_fee: float = Field(default=500.0, ge=0)
    tax_amount: float = Field(default=0.0, ge=0)
    total_premium: float = Field(ge=0)

    # Applied underwriting terms — persisted as JSON for auditability
    loadings_json: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))
    exclusions_json: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))

    # Who or what triggered this version (e.g. user_id for endorsements, "system" for STP renewal)
    created_by: Optional[str] = Field(default=None, max_length=255)
    event_type: str = Field(default="Issuance", max_length=50)  # Issuance | Endorsement | Renewal

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    policy: Optional[Policy] = Relationship(back_populates="policy_versions")


# ─────────────────────────────────────────────────────────────────────────────
# PremiumSchedule  —  recurring billing installment ledger for a policy
# ─────────────────────────────────────────────────────────────────────────────

class PremiumSchedule(SQLModel, table=True):
    """
    One row per billing installment. Created at issuance (and at each renewal
    binding). The scheduler marks rows OVERDUE once due_date passes unpaid;
    the payment gateway (or manual collection flow) marks them PAID.
    """
    __tablename__ = "premium_schedules"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)
    policy_version_id: Optional[UUID] = Field(default=None, nullable=True)  # FK resolved at runtime

    billing_frequency: BillingFrequencyEnum = Field(default=BillingFrequencyEnum.ANNUAL, max_length=50)
    due_date: date = Field(nullable=False, index=True)
    amount_due: float = Field(ge=0)
    amount_paid: float = Field(default=0.0, ge=0)
    status: PremiumScheduleStatusEnum = Field(default=PremiumScheduleStatusEnum.PENDING, max_length=50)

    paid_at: Optional[datetime] = Field(default=None)
    payment_reference: Optional[str] = Field(default=None, max_length=255)

    # Stage B recurring collection (step 3) — installment position + reminder log.
    installment_no: int = Field(default=1, ge=1)          # 1,2,3… within the policy year
    reminder_count: int = Field(default=0, ge=0)
    last_reminder_at: Optional[datetime] = Field(default=None)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    policy: Optional[Policy] = Relationship(back_populates="premium_schedules")


# ─────────────────────────────────────────────────────────────────────────────
# RenewalTransaction  —  tracks one annual renewal cycle for a policy
# ─────────────────────────────────────────────────────────────────────────────

class RenewalTransaction(SQLModel, table=True):
    """
    One row per renewal cycle (year N → year N+1). Progresses through
    INITIATED → QUOTED → BOUND (STP path) or
    INITIATED → UNDERWRITING_REVIEW → QUOTED → BOUND (referral path) or
    any → LAPSED (unpaid after grace period).
    """
    __tablename__ = "renewal_transactions"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    old_version_id: Optional[UUID] = Field(default=None, nullable=True)
    new_version_id: Optional[UUID] = Field(default=None, nullable=True)

    renewal_year: int = Field(nullable=False)                   # e.g. 2, 3, 4 ...
    status: RenewalStatusEnum = Field(default=RenewalStatusEnum.INITIATED, max_length=50)

    # Renewal premium details (may differ from current version due to re-rating)
    renewal_premium: Optional[float] = Field(default=None, ge=0)
    renewal_loading: Optional[float] = Field(default=None, ge=0)

    # Claims during the term — used to decide STP vs. UW referral
    claims_count: int = Field(default=0, ge=0)
    is_stp: bool = Field(default=True)     # False = referred to manual underwriting

    # Scheduler-set timestamps
    notice_sent_at: Optional[datetime] = Field(default=None)
    bound_at: Optional[datetime] = Field(default=None)
    lapsed_at: Optional[datetime] = Field(default=None)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    policy: Optional[Policy] = Relationship(back_populates="renewal_transactions")


# ─────────────────────────────────────────────────────────────────────────────
# PolicyDocument  —  reference to a generated legal document (PDF stub for MVP)
# ─────────────────────────────────────────────────────────────────────────────

class PolicyDocument(SQLModel, table=True):
    """
    Metadata record for each legal document generated at issuance or renewal.
    storage_url points to the object-store path (or a /api download endpoint).
    Phase 2 will wire in real PDF generation; Phase 1 stubs the content.
    """
    __tablename__ = "policy_documents"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)
    policy_version_id: Optional[UUID] = Field(default=None, nullable=True)

    document_type: PolicyDocumentTypeEnum = Field(max_length=50)
    document_name: str = Field(max_length=255)
    storage_url: Optional[str] = Field(default=None, max_length=1000)

    # Phase 1: stub_content holds minimal text summary until real PDF gen is added
    stub_content: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    is_stub: bool = Field(default=True)   # False once real PDF is generated

    generated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    policy: Optional[Policy] = Relationship(back_populates="policy_documents")


# ─────────────────────────────────────────────────────────────────────────────
# PolicyEvent  —  immutable audit/event log for the policy lifecycle
# ─────────────────────────────────────────────────────────────────────────────

class PolicyEvent(SQLModel, table=True):
    """
    Append-only ledger of every lifecycle action on a Policy — issuance,
    payment confirmation, lapse, cancellation, renewal, endorsement, etc.

    This is the policy-level analogue of CaseAuditTrail. Regulators (SECP)
    require an immutable trail of who did what and when, and every state
    transition driven through policy_state_machine.apply_transition() writes
    one row here. Never updated, only inserted.
    """
    __tablename__ = "policy_events"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    # Semantic name of what happened, e.g. "PolicyIssued", "PaymentConfirmed",
    # "PolicyLapsed", "PolicyCancelled", "PolicyRenewed", "StatusTransition".
    event_type: str = Field(max_length=100, index=True)

    # Status snapshot around the transition (string form of PolicyStatusEnum).
    from_status: Optional[str] = Field(default=None, max_length=50)
    to_status: Optional[str] = Field(default=None, max_length=50)

    # Who triggered it — a user id string, "system" (scheduler), or "gateway".
    actor: str = Field(default="system", max_length=255)

    # Free-form structured context (amounts, payment refs, reasons) for audit.
    detail_json: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))

    created_at: datetime = Field(default_factory=datetime.utcnow, index=True, nullable=False)

    policy: Optional[Policy] = Relationship(back_populates="policy_events")


# ═════════════════════════════════════════════════════════════════════════════
# STAGE A — PRE-ISSUANCE GATES
# Between an underwriting decision and a bound contract sit legally-required
# gates: accepting revised terms (counter-offer), clearing requirements,
# collecting the first premium, compliance screening, capturing beneficiaries,
# and generating policy documents. The tables below back the first, second,
# fourth and fifth of those; premium (PremiumSchedule) and documents
# (PolicyDocument) already exist above.
# ═════════════════════════════════════════════════════════════════════════════

class CounterOfferTypeEnum(str, Enum):
    LOADING = "Loading"                     # accept-with-loading (extra premium)
    EXCLUSION = "Exclusion"                 # cover excludes a condition/activity
    REDUCED_SUM_ASSURED = "ReducedSumAssured"
    PLAN_SUBSTITUTION = "PlanSubstitution"  # offered a different product


class CounterOfferStatusEnum(str, Enum):
    PENDING = "Pending"                     # awaiting customer response
    ACCEPTED = "Accepted"
    DECLINED = "Declined"
    EXPIRED = "Expired"                     # validity window elapsed


class CounterOffer(SQLModel, table=True):
    """
    Revised underwriting terms the customer must explicitly accept before the
    policy can bind. Created when underwriting is not a clean accept — loading,
    exclusions, reduced sum assured, or a plan substitution. Has a validity
    window (default 21 days); an unanswered offer past `valid_until` expires and
    the policy is marked NotTakenUp. You cannot bind a contract on terms the
    applicant has not agreed to — this is the record of that agreement.
    """
    __tablename__ = "counter_offers"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    offer_type: CounterOfferTypeEnum = Field(max_length=50)
    status: CounterOfferStatusEnum = Field(default=CounterOfferStatusEnum.PENDING, max_length=50)

    # Original terms snapshot (for a clear side-by-side in the UI).
    original_coverage_amount: Optional[float] = Field(default=None, ge=0)
    original_premium: Optional[float] = Field(default=None, ge=0)
    original_product_name: Optional[str] = Field(default=None, max_length=255)

    # Revised terms — whichever apply to offer_type.
    revised_loading_pct: Optional[float] = Field(default=None, ge=0.0, le=500.0)
    revised_coverage_amount: Optional[float] = Field(default=None, ge=0)
    revised_premium: Optional[float] = Field(default=None, ge=0)
    revised_product_name: Optional[str] = Field(default=None, max_length=255)
    exclusions_json: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))

    reason: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    valid_until: date = Field(nullable=False, index=True)

    created_by: Optional[str] = Field(default=None, max_length=255)   # underwriter user id
    responded_at: Optional[datetime] = Field(default=None)
    response_note: Optional[str] = Field(default=None, max_length=500)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    policy: Optional[Policy] = Relationship(back_populates="counter_offers")


class RequirementTypeEnum(str, Enum):
    MEDICAL_REPORT = "MedicalReport"
    INCOME_PROOF = "IncomeProof"
    KYC_CNIC = "KycCnic"
    ADDITIONAL_DOC = "AdditionalDoc"


class RequirementStatusEnum(str, Enum):
    PENDING = "Pending"        # not yet supplied
    SUBMITTED = "Submitted"    # customer supplied, awaiting verification
    VERIFIED = "Verified"      # accepted by the insurer
    WAIVED = "Waived"          # insurer waived the requirement


class PolicyRequirement(SQLModel, table=True):
    """
    One outstanding pre-issuance requirement for a policy — a medical report,
    income proof, KYC/CNIC verification, or an extra underwriting document.
    Issuance is gated until every requirement is Verified or Waived.
    """
    __tablename__ = "policy_requirements"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    requirement_type: RequirementTypeEnum = Field(max_length=50)
    label: str = Field(max_length=255)
    description: Optional[str] = Field(default=None, max_length=500)
    status: RequirementStatusEnum = Field(default=RequirementStatusEnum.PENDING, max_length=50)

    # Optional link to the uploaded document that satisfied this requirement.
    artifact_id: Optional[UUID] = Field(default=None, foreign_key="artifacts.id", nullable=True)

    submitted_at: Optional[datetime] = Field(default=None)
    verified_by: Optional[str] = Field(default=None, max_length=255)
    verified_at: Optional[datetime] = Field(default=None)
    note: Optional[str] = Field(default=None, max_length=500)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    policy: Optional[Policy] = Relationship(back_populates="policy_requirements")


class ComplianceCheckTypeEnum(str, Enum):
    AML = "AML"                 # anti-money-laundering risk scoring
    SANCTIONS = "Sanctions"     # sanctions / PEP watchlist screening
    SECP = "SECP"               # SECP regulatory / CNIC registry verification


class ComplianceStatusEnum(str, Enum):
    PENDING = "Pending"
    PASSED = "Passed"
    FLAGGED = "Flagged"         # needs manual review / clearance
    FAILED = "Failed"           # hard block


class ComplianceCheck(SQLModel, table=True):
    """
    Result of one mandatory regulatory screening for a policy — AML, sanctions,
    or SECP verification. Produced by services/compliance_engine.py at the
    pre-issuance compliance step. A Flagged check can be manually cleared by an
    officer; a Failed check hard-blocks issuance.
    """
    __tablename__ = "compliance_checks"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)
    customer_id: UUID = Field(foreign_key="customers.id", index=True, nullable=False)

    check_type: ComplianceCheckTypeEnum = Field(max_length=50)
    status: ComplianceStatusEnum = Field(default=ComplianceStatusEnum.PENDING, max_length=50)

    score: Optional[float] = Field(default=None)                    # e.g. AML risk score 0–100
    details_json: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))

    screened_at: Optional[datetime] = Field(default=None)
    cleared_by: Optional[str] = Field(default=None, max_length=255)  # officer who overrode a flag
    cleared_at: Optional[datetime] = Field(default=None)
    clearance_note: Optional[str] = Field(default=None, max_length=500)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    policy: Optional[Policy] = Relationship(back_populates="compliance_checks")


class Beneficiary(SQLModel, table=True):
    """
    A nominee on a policy's death benefit. Multiple beneficiaries per policy;
    the sum of share_pct across a policy's beneficiaries must equal 100. Replaces
    the single free-text Policy.nominee_name (kept for back-compat) with a
    structured, queryable, validatable record.
    """
    __tablename__ = "beneficiaries"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    name: str = Field(max_length=255)
    cnic: Optional[str] = Field(default=None, max_length=15)
    relationship: str = Field(max_length=100)                       # Spouse | Child | Parent | ...
    share_pct: float = Field(ge=0.0, le=100.0)

    date_of_birth: Optional[date] = Field(default=None)
    is_minor: bool = Field(default=False)
    guardian_name: Optional[str] = Field(default=None, max_length=255)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    policy: Optional[Policy] = Relationship(back_populates="beneficiaries")


# ─────────────────────────────────────────────────────────────────────────────
# BeneficiaryVersion  —  immutable audit trail of the beneficiary roster
# Every replace_beneficiaries call snapshots the full roster here with an
# incrementing sequence, so a nominee change during Stage A (and, later, a
# Stage B endorsement) leaves a queryable "who/what/when" history instead of
# silently overwriting rows. Queried by policy_id directly (like Beneficiary,
# no SQLModel relationship needed).
# ─────────────────────────────────────────────────────────────────────────────

class BeneficiaryVersion(SQLModel, table=True):
    __tablename__ = "beneficiary_versions"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    # 1 = initial capture, 2 = first change, 3 = second change, ...
    version_sequence: int = Field(ge=1)

    # Full roster snapshot at this version: list of
    # {name, cnic, relationship, share_pct, date_of_birth, is_minor, guardian_name}.
    beneficiaries_json: list = Field(sa_column=Column(JSON, nullable=False))
    total_share: float = Field(default=0.0, ge=0.0, le=100.0)

    changed_by: Optional[str] = Field(default=None, max_length=255)  # user_id or "system"
    change_reason: Optional[str] = Field(default=None, max_length=500)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False, index=True)

    policy: Optional[Policy] = Relationship(back_populates="beneficiary_versions")


# ═════════════════════════════════════════════════════════════════════════════
# STAGE B — POST-ISSUANCE ONBOARDING (step 2: Welcome & Onboarding)
# Policyholder ID lives on Customer (one per person); the portal account is also
# per-customer; the welcome kit + delivery + acknowledgment are per-policy. Status
# columns are plain strings (like Policy.demo_bypass_flags) to avoid new native
# PG enum types. Values are documented inline and mirrored in Python constants
# on the router / gate for readability.
# ═════════════════════════════════════════════════════════════════════════════

class CustomerPortalAccount(SQLModel, table=True):
    """Simulated self-service portal account for a customer (one per customer).

    The portal itself is mocked (like payment_gateway) — this row holds the
    credentials ops issues at onboarding. Only the bcrypt hash is stored; the
    temporary password is returned once by the API and never persisted.
    """
    __tablename__ = "customer_portal_accounts"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    customer_id: UUID = Field(foreign_key="customers.id", index=True, nullable=False, unique=True)

    username: str = Field(max_length=255)
    password_hash: str = Field(max_length=255)
    status: str = Field(default="Pending", max_length=30)   # Pending | Active | Suspended
    must_reset: bool = Field(default=True)                  # temp password → force change on first login
    invite_token: Optional[str] = Field(default=None, max_length=64)
    invite_expires_at: Optional[datetime] = Field(default=None)
    last_login_at: Optional[datetime] = Field(default=None)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)


class PolicyOnboarding(SQLModel, table=True):
    """Per-policy Stage B onboarding record: welcome kit + delivery + acknowledgment.

    Policyholder ID (Customer.policyholder_id) and the portal account
    (CustomerPortalAccount) are customer-level; this row tracks the parts specific
    to one contract. Queried by policy_id directly (mirrors Beneficiary).
    """
    __tablename__ = "policy_onboarding"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False, unique=True)

    welcome_kit_name: Optional[str] = Field(default=None, max_length=255)
    welcome_kit_path: Optional[str] = Field(default=None, max_length=1000)
    welcome_kit_generated_at: Optional[datetime] = Field(default=None)

    welcome_sent_at: Optional[datetime] = Field(default=None)
    welcome_channel: Optional[str] = Field(default=None, max_length=30)   # Email | SMS | Both | Manual

    acknowledged_at: Optional[datetime] = Field(default=None)
    acknowledgment_method: Optional[str] = Field(default=None, max_length=50)

    status: str = Field(default="Pending", max_length=30)   # Pending | InProgress | Completed

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    policy: Optional[Policy] = Relationship(back_populates="policy_onboarding")


# ═════════════════════════════════════════════════════════════════════════════
# STAGE B — RECURRING PREMIUM COLLECTION (step 3 authenticity)
# Reminder log + payment receipts (with late-payment surcharge and per-collection
# agent commission). Category columns are plain strings to avoid new PG enum
# types. Queried by policy_id / schedule_id directly.
# ═════════════════════════════════════════════════════════════════════════════

class PremiumReminder(SQLModel, table=True):
    """One row per premium reminder sent — the reminder history/audit log."""
    __tablename__ = "premium_reminders"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)
    schedule_id: Optional[UUID] = Field(default=None, index=True, nullable=True)

    kind: str = Field(max_length=30)        # Upcoming | Due | Overdue | GraceWarning | FinalNotice
    channel: str = Field(max_length=20)     # Email | SMS | WhatsApp | Letter
    template: str = Field(max_length=30)    # Friendly | Standard | FinalNotice
    to_address: Optional[str] = Field(default=None, max_length=255)
    message: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    sent_by: Optional[str] = Field(default=None, max_length=255)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False, index=True)

    policy: Optional[Policy] = Relationship(back_populates="premium_reminders")


class PremiumReceipt(SQLModel, table=True):
    """A payment receipt for one collected installment, incl. any grace surcharge
    and the agent commission earned on that collection."""
    __tablename__ = "premium_receipts"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)
    schedule_id: Optional[UUID] = Field(default=None, index=True, nullable=True)

    receipt_no: str = Field(max_length=50, index=True)
    base_amount: float = Field(ge=0)
    surcharge_amount: float = Field(default=0.0, ge=0)
    total_amount: float = Field(ge=0)

    method: Optional[str] = Field(default=None, max_length=30)
    payment_reference: Optional[str] = Field(default=None, max_length=255)

    commission_agent_id: Optional[str] = Field(default=None, max_length=100)
    commission_pct: float = Field(default=0.0, ge=0.0, le=100.0)
    commission_amount: float = Field(default=0.0, ge=0)

    document_path: Optional[str] = Field(default=None, max_length=1000)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False, index=True)

    policy: Optional["Policy"] = Relationship(back_populates="premium_receipts")

# ═════════════════════════════════════════════════════════════════════════════
# STAGE B — POLICY SERVICING & ENDORSEMENTS (mid-term changes)
# Each approved change creates a new PolicyVersion (1.x) and a PolicyEndorsement
# record. Riders are attached benefits that carry their own premium. Status
# columns are plain strings (no new PG enum types). Queried by policy_id.
# ═════════════════════════════════════════════════════════════════════════════

class PolicyRider(SQLModel, table=True):
    """An optional benefit attached to a policy (e.g. Accidental Death, Waiver of
    Premium). Added/removed via an endorsement; carries its own annual premium."""
    __tablename__ = "policy_riders"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    name: str = Field(max_length=120)
    sum_assured: float = Field(default=0.0, ge=0)
    annual_premium: float = Field(default=0.0, ge=0)
    status: str = Field(default="Active", max_length=20)   # Active | Removed
    added_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    removed_at: Optional[datetime] = Field(default=None)


class PolicyEndorsement(SQLModel, table=True):
    """One approved mid-term change. The immutable servicing ledger — nominee,
    address, sum-assured and rider changes each create a row here plus a new
    PolicyVersion (financial ones re-price)."""
    __tablename__ = "policy_endorsements"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    endorsement_no: str = Field(max_length=20, index=True)        # E1, E2, ...
    endorsement_type: str = Field(max_length=30)                  # Nominee | Address | SumAssured | Rider
    summary: str = Field(max_length=500)                          # human-readable "what changed"
    effective_date: date = Field(nullable=False)

    old_version_id: Optional[UUID] = Field(default=None, nullable=True)
    new_version_id: Optional[UUID] = Field(default=None, nullable=True)
    premium_delta: float = Field(default=0.0)                     # +/- change to annual premium
    detail_json: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))

    actor: Optional[str] = Field(default=None, max_length=255)
    document_path: Optional[str] = Field(default=None, max_length=1000)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False, index=True)


# ═════════════════════════════════════════════════════════════════════════════
# PRE-UNDERWRITING — INSURANCE HISTORY (anti-selection / over-insurance screen)
#
# Runs alongside the AML/Sanctions/SECP compliance screen, before the risk
# engine evaluates the case. Two sources are reconciled:
#   • internal  — every other Policy this tenant already holds for the customer,
#   • external  — the other-insurer policies the proposer declared on their
#                 E-Application (CustomerEApplication.existing_insurance).
# The engine (services/insurance_history.py) turns that into an aggregate
# in-force exposure, a Human Life Value multiple, and replacement/non-disclosure
# findings — the three things an underwriter actually decides on.
# ═════════════════════════════════════════════════════════════════════════════

class InsuranceHistoryStatusEnum(str, Enum):
    NOT_STARTED = "NotStarted"
    CLEAR = "Clear"           # no adverse history, aggregate within HLV
    FLAGGED = "Flagged"       # needs underwriter review (over-insurance, replacement, non-disclosure)
    FAILED = "Failed"         # hard adverse history (prior decline / fraud / claim repudiation)


class InsuranceHistoryCheck(SQLModel, table=True):
    """
    One insurance-history screen for a pre-underwriting case.

    A Flagged result can be cleared by an underwriter (same clear/fail pattern
    as ComplianceCheck); a Failed result is an adverse-history hard stop that
    the risk engine and the pre-underwriting gate both honour.
    """
    __tablename__ = "insurance_history_checks"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    case_id: UUID = Field(foreign_key="cases.caseld", index=True, unique=True, nullable=False)
    customer_id: UUID = Field(foreign_key="customers.id", index=True, nullable=False)
    policy_id: Optional[UUID] = Field(default=None, foreign_key="policies.id", index=True, nullable=True)

    status: InsuranceHistoryStatusEnum = Field(
        default=InsuranceHistoryStatusEnum.NOT_STARTED, max_length=50
    )
    score: Optional[float] = Field(default=None)   # 0–100 anti-selection concern score

    # Money view — everything in PKR.
    proposed_sum_assured: float = Field(default=0.0, ge=0)
    internal_inforce_sum_assured: float = Field(default=0.0, ge=0)   # this insurer, in force
    external_declared_sum_assured: float = Field(default=0.0, ge=0)  # other insurers, self-declared
    aggregate_sum_assured: float = Field(default=0.0, ge=0)          # proposed + internal + external
    hlv_limit: Optional[float] = Field(default=None)                 # Human Life Value ceiling
    hlv_ratio: Optional[float] = Field(default=None)                 # aggregate ÷ HLV limit

    # Behavioural flags an underwriter must see.
    has_prior_decline: bool = Field(default=False)       # previously declined / postponed here
    has_prior_lapse: bool = Field(default=False)         # lapsed / NTU history
    replacement_suspected: bool = Field(default=False)   # churning an existing policy
    non_disclosure_suspected: bool = Field(default=False)  # internal policies the e-app omitted

    # [{policy_number, insurer, product, sum_assured, status, effective_date, source}]
    internal_policies_json: Optional[list] = Field(default=None, sa_column=Column(JSON, nullable=True))
    external_policies_json: Optional[list] = Field(default=None, sa_column=Column(JSON, nullable=True))
    findings_json: Optional[list] = Field(default=None, sa_column=Column(JSON, nullable=True))

    checked_at: Optional[datetime] = Field(default=None, nullable=True)
    cleared_by: Optional[str] = Field(default=None, max_length=255)
    cleared_at: Optional[datetime] = Field(default=None, nullable=True)
    clearance_note: Optional[str] = Field(default=None, max_length=500)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)


# ═════════════════════════════════════════════════════════════════════════════
# PRE-UNDERWRITING — MEDICAL EXAMINATION (Non-Medical Limit → panel clinics)
#
# Every insurer publishes a Non-Medical Limit grid: below it a proposal is
# underwritten on the E-Application alone; above it physical diagnostics are
# mandatory (fasting blood sugar, lipid profile, resting ECG, chest X-ray, …)
# and are performed at a contracted panel lab — Chughtai, Aga Khan, IDC,
# Shaukat Khanum. The grid + test panel live in services/underwriting_limits.py.
# ═════════════════════════════════════════════════════════════════════════════

class MedicalExamStatusEnum(str, Enum):
    NOT_ASSESSED = "NotAssessed"   # NML rule has not been run for this case yet
    NOT_REQUIRED = "NotRequired"   # under the Non-Medical Limit — no exam needed
    REQUIRED = "Required"          # over the NML; tests determined, not yet invited
    INVITED = "Invited"            # tokenized booking link issued to the customer
    SCHEDULED = "Scheduled"        # clinic + appointment slot confirmed
    COMPLETED = "Completed"        # results received and attached
    WAIVED = "Waived"              # underwriter waived (e.g. recent exam on file)
    EXPIRED = "Expired"            # booking link lapsed without an appointment


class MedicalExamOutcomeEnum(str, Enum):
    NORMAL = "Normal"                 # all values within range
    MINOR_FINDINGS = "MinorFindings"  # ratable — feeds a loading
    ADVERSE = "Adverse"               # material impairment — decline/postpone territory


class PanelClinic(SQLModel, table=True):
    """
    A diagnostic lab/clinic on the insurer's panel. Seeded per tenant with the
    Pakistani labs insurers actually contract with; a tenant can add its own.
    """
    __tablename__ = "panel_clinics"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code", name="uq_panel_clinic_code_per_tenant"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)

    code: str = Field(max_length=50)            # e.g. "CHUGHTAI-LHR"
    name: str = Field(max_length=255)           # e.g. "Chughtai Lab — Jail Road"
    network: Optional[str] = Field(default=None, max_length=120)   # Chughtai / Aga Khan / IDC / SKMCH
    city: Optional[str] = Field(default=None, max_length=100, index=True)
    address: Optional[str] = Field(default=None, max_length=500)
    phone: Optional[str] = Field(default=None, max_length=50)

    # Which of the standard test codes this site can perform (see
    # underwriting_limits.TEST_CATALOGUE). Empty/None means "all".
    supported_tests: Optional[list] = Field(default=None, sa_column=Column(JSON, nullable=True))
    home_sampling: bool = Field(default=False)  # phlebotomist visits the customer
    turnaround_hours: int = Field(default=48, ge=1)
    is_active: bool = Field(default=True, nullable=False)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)


class MedicalExamOrder(SQLModel, table=True):
    """
    The medical requirement raised for one pre-underwriting case: why it was
    raised (which NML rule fired), which tests are mandated, where and when the
    customer is booked, and what came back.

    Distinct from PolicyRequirement(MedicalReport), which is the *document*
    checklist item at Stage A pre-issuance — this is the clinical order that
    produces that document, and it gates the underwriting decision, not issuance.
    """
    __tablename__ = "medical_exam_orders"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    case_id: UUID = Field(foreign_key="cases.caseld", index=True, unique=True, nullable=False)
    customer_id: UUID = Field(foreign_key="customers.id", index=True, nullable=False)
    policy_id: Optional[UUID] = Field(default=None, foreign_key="policies.id", index=True, nullable=True)

    status: MedicalExamStatusEnum = Field(default=MedicalExamStatusEnum.NOT_ASSESSED, max_length=50)

    # ── Why this order exists ────────────────────────────────────────────────
    applicant_age: Optional[int] = Field(default=None, ge=0, le=120)
    sum_assured_at_risk: float = Field(default=0.0, ge=0)  # aggregate exposure the grid was read against
    non_medical_limit: Optional[float] = Field(default=None)  # the NML for this age band
    trigger_reasons: Optional[list] = Field(default=None, sa_column=Column(JSON, nullable=True))

    # [{code, name, category, fasting_required}] — resolved from the grid.
    required_tests: Optional[list] = Field(default=None, sa_column=Column(JSON, nullable=True))
    estimated_cost: float = Field(default=0.0, ge=0)   # insurer-borne panel cost, PKR

    # ── Appointment ──────────────────────────────────────────────────────────
    clinic_id: Optional[UUID] = Field(default=None, foreign_key="panel_clinics.id", nullable=True)
    appointment_at: Optional[datetime] = Field(default=None, nullable=True)
    home_sampling: bool = Field(default=False)
    appointment_note: Optional[str] = Field(default=None, max_length=500)

    # Tokenized customer booking link — same hashed/expiring scheme as the
    # E-Application invite; the customer never has a login.
    invite_token_hash: Optional[str] = Field(default=None, index=True, max_length=64, nullable=True)
    invite_expires_at: Optional[datetime] = Field(default=None, nullable=True)
    invited_at: Optional[datetime] = Field(default=None, nullable=True)
    invited_by: Optional[UUID] = Field(default=None, foreign_key="users.id", nullable=True)

    # ── Results ──────────────────────────────────────────────────────────────
    # {test_code: {value, unit, reference_range, flag}} as reported by the lab.
    results_json: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))
    outcome: Optional[MedicalExamOutcomeEnum] = Field(default=None, max_length=50, nullable=True)
    abnormal_findings: Optional[list] = Field(default=None, sa_column=Column(JSON, nullable=True))
    suggested_loading_pct: Optional[float] = Field(default=None, ge=0)
    result_artifact_id: Optional[UUID] = Field(default=None, foreign_key="artifacts.id", nullable=True)
    completed_at: Optional[datetime] = Field(default=None, nullable=True)
    reported_by: Optional[str] = Field(default=None, max_length=255)

    waived_by: Optional[str] = Field(default=None, max_length=255)
    waived_at: Optional[datetime] = Field(default=None, nullable=True)
    waiver_reason: Optional[str] = Field(default=None, max_length=500)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)


# ═════════════════════════════════════════════════════════════════════════════
# POST-UNDERWRITING — FACULTATIVE REINSURANCE REFERRAL
#
# Runs *after* the underwriter has formed a view and *before* final approval:
# when the sum assured exceeds the insurer's own retention, the excess must be
# ceded. Automatic treaty capacity absorbs it silently; beyond that the case is
# referred facultatively to a reinsurer (Munich Re, Swiss Re, Hannover Re, RGA,
# SCOR, Pak Re), whose terms are then written back onto the policy as loadings
# and exclusions. Policy.status parks at ReinsurerReferred while this is open —
# the transition already exists in shared/services/policy_state_machine.py.
# ═════════════════════════════════════════════════════════════════════════════

class ReinsuranceReferralTypeEnum(str, Enum):
    TREATY = "Treaty"              # inside automatic treaty capacity — no referral needed
    FACULTATIVE = "Facultative"    # beyond treaty capacity — individual reinsurer consent


class ReinsuranceReferralStatusEnum(str, Enum):
    NOT_REQUIRED = "NotRequired"   # sum assured within retention
    REQUIRED = "Required"          # cession needed, slip not yet sent
    SUBMITTED = "Submitted"        # slip sent to the reinsurer, awaiting terms
    QUOTED = "Quoted"              # reinsurer returned terms, not yet applied
    ACCEPTED = "Accepted"          # terms applied to the policy
    DECLINED = "Declined"          # reinsurer refused the risk
    WITHDRAWN = "Withdrawn"        # insurer pulled the referral


class ReinsurerDecisionEnum(str, Enum):
    ACCEPT = "Accept"                       # standard terms
    ACCEPT_WITH_LOADING = "AcceptWithLoading"   # extra mortality / EMR
    ACCEPT_WITH_EXCLUSION = "AcceptWithExclusion"
    POSTPONE = "Postpone"
    DECLINE = "Decline"


class Reinsurer(SQLModel, table=True):
    """
    A reinsurance counterparty and the commercial terms of its relationship
    with this insurer. `treaty_capacity` is the automatic (obligatory) capacity
    per life; anything above it needs a facultative submission to this company.
    """
    __tablename__ = "reinsurers"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code", name="uq_reinsurer_code_per_tenant"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)

    code: str = Field(max_length=50)             # e.g. "MUNICH-RE"
    name: str = Field(max_length=255)            # e.g. "Munich Re"
    country: Optional[str] = Field(default=None, max_length=100)
    am_best_rating: Optional[str] = Field(default=None, max_length=20)   # e.g. "A+"
    contact_email: Optional[str] = Field(default=None, max_length=255)

    is_lead: bool = Field(default=False)         # the panel's lead reinsurer
    treaty_capacity: float = Field(default=0.0, ge=0)      # automatic capacity per life, PKR
    facultative_capacity: float = Field(default=0.0, ge=0) # max they will consider facultatively
    typical_response_days: int = Field(default=5, ge=1)
    is_active: bool = Field(default=True, nullable=False)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)


class ReinsuranceReferral(SQLModel, table=True):
    """
    One cession decision for a policy: how much this insurer keeps, how much is
    ceded, to whom, on what terms — and whether those terms have been written
    back onto the contract.

    A policy has at most one open referral; the row is kept after the fact as
    the audit record of the cession (SECP + reinsurer bordereaux both need it).
    """
    __tablename__ = "reinsurance_referrals"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)
    customer_id: UUID = Field(foreign_key="customers.id", index=True, nullable=False)
    case_id: Optional[UUID] = Field(default=None, foreign_key="cases.caseld", index=True, nullable=True)

    referral_type: ReinsuranceReferralTypeEnum = Field(
        default=ReinsuranceReferralTypeEnum.FACULTATIVE, max_length=50
    )
    status: ReinsuranceReferralStatusEnum = Field(
        default=ReinsuranceReferralStatusEnum.NOT_REQUIRED, max_length=50
    )

    # ── The cession maths (all PKR) ──────────────────────────────────────────
    total_sum_assured: float = Field(default=0.0, ge=0)
    retention_limit: float = Field(default=0.0, ge=0)   # the insurer's own retention for this risk
    retained_amount: float = Field(default=0.0, ge=0)
    treaty_ceded_amount: float = Field(default=0.0, ge=0)      # absorbed by automatic treaty
    facultative_ceded_amount: float = Field(default=0.0, ge=0) # needing this referral
    cession_pct: Optional[float] = Field(default=None, ge=0, le=100)
    reinsurance_premium: Optional[float] = Field(default=None, ge=0)

    reinsurer_id: Optional[UUID] = Field(default=None, foreign_key="reinsurers.id", index=True, nullable=True)

    # ── The submitted slip ───────────────────────────────────────────────────
    # Underwriting evidence bundled for the reinsurer: risk summary, AI scores,
    # medical results, financial justification, ACR extract.
    slip_json: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))
    submitted_at: Optional[datetime] = Field(default=None, nullable=True)
    submitted_by: Optional[str] = Field(default=None, max_length=255)
    response_due_at: Optional[datetime] = Field(default=None, nullable=True)

    # ── The reinsurer's terms ────────────────────────────────────────────────
    reinsurer_decision: Optional[ReinsurerDecisionEnum] = Field(default=None, max_length=50, nullable=True)
    reinsurer_reference: Optional[str] = Field(default=None, max_length=100)  # their file/slip number
    extra_mortality_pct: Optional[float] = Field(default=None, ge=0)  # EMR loading on the ceded portion
    extra_premium_per_mille: Optional[float] = Field(default=None, ge=0)
    imposed_exclusions: Optional[list] = Field(default=None, sa_column=Column(JSON, nullable=True))
    reinsurer_conditions: Optional[str] = Field(default=None, max_length=1000)
    responded_at: Optional[datetime] = Field(default=None, nullable=True)

    # ── Write-back onto the contract ─────────────────────────────────────────
    terms_applied: bool = Field(default=False)
    terms_applied_at: Optional[datetime] = Field(default=None, nullable=True)
    applied_counter_offer_id: Optional[UUID] = Field(
        default=None, foreign_key="counter_offers.id", nullable=True
    )

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
