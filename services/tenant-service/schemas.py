from datetime import date, datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, field_validator, model_validator
from shared.models.core import (
    UserStatus,
    Gender,
    InsuranceTypeEnum,
    PlanCategoryEnum,
    ProductCategoryEnum,
    PlanStatusEnum,
    PolicyStatusEnum,
    BranchTypeEnum,
    MaritalStatus,
    AcquisitionSourceType,
    FamilyPlanTypeEnum,
    FamilyRelationshipEnum,
    ProfileStatusEnum,
)


# ── Tenant ────────────────────────────────────────────────────────────────────

class TenantCreate(BaseModel):
    name: str
    code: str

    # Company profile — optional, captured at onboarding
    registration_number: Optional[str] = None
    license_number: Optional[str] = None
    head_office_address: Optional[str] = None
    city: Optional[str] = None
    province: Optional[str] = None
    contact_person: Optional[str] = None
    contact_email: Optional[EmailStr] = None
    contact_phone: Optional[str] = None
    website: Optional[str] = None
    established_date: Optional[date] = None

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("name must not be blank")
        return v.strip()

    @field_validator("code")
    @classmethod
    def code_format(cls, v: str) -> str:
        v = v.strip().upper()
        if not v:
            raise ValueError("code must not be blank")
        if not v.replace("-", "").replace("_", "").isalnum():
            raise ValueError("code must be alphanumeric (hyphens/underscores allowed)")
        return v


class TenantRead(BaseModel):
    id: UUID
    name: str
    code: str
    is_active: bool
    created_at: datetime

    registration_number: Optional[str] = None
    license_number: Optional[str] = None
    head_office_address: Optional[str] = None
    city: Optional[str] = None
    province: Optional[str] = None
    contact_person: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    website: Optional[str] = None
    established_date: Optional[date] = None

    model_config = {"from_attributes": True}


class TenantUpdate(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    is_active: Optional[bool] = None

    registration_number: Optional[str] = None
    license_number: Optional[str] = None
    head_office_address: Optional[str] = None
    city: Optional[str] = None
    province: Optional[str] = None
    contact_person: Optional[str] = None
    contact_email: Optional[EmailStr] = None
    contact_phone: Optional[str] = None
    website: Optional[str] = None
    established_date: Optional[date] = None


# ── Branch ────────────────────────────────────────────────────────────────────

class BranchCreate(BaseModel):
    branch_code: str
    name: str
    branch_type: BranchTypeEnum = BranchTypeEnum.BRANCH
    region: Optional[str] = None
    city: str
    address: Optional[str] = None
    postal_code: Optional[str] = None
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    contact_email: Optional[EmailStr] = None
    manager_user_id: Optional[UUID] = None
    opened_date: Optional[date] = None

    @field_validator("branch_code")
    @classmethod
    def branch_code_format(cls, v: str) -> str:
        v = v.strip().upper()
        if not v:
            raise ValueError("branch_code must not be blank")
        if not v.replace("-", "").replace("_", "").isalnum():
            raise ValueError("branch_code must be alphanumeric (hyphens/underscores allowed)")
        return v

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("name must not be blank")
        return v.strip()

    @field_validator("city")
    @classmethod
    def city_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("city must not be blank")
        return v.strip()


class BranchRead(BaseModel):
    id: UUID
    tenant_id: UUID
    branch_code: str
    name: str
    branch_type: BranchTypeEnum
    region: Optional[str] = None
    city: str
    address: Optional[str] = None
    postal_code: Optional[str] = None
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    contact_email: Optional[str] = None
    manager_user_id: Optional[UUID] = None
    is_active: bool
    opened_date: Optional[date] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class BranchUpdate(BaseModel):
    name: Optional[str] = None
    branch_type: Optional[BranchTypeEnum] = None
    region: Optional[str] = None
    city: Optional[str] = None
    address: Optional[str] = None
    postal_code: Optional[str] = None
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    contact_email: Optional[EmailStr] = None
    manager_user_id: Optional[UUID] = None
    is_active: Optional[bool] = None
    opened_date: Optional[date] = None


# ── Role ──────────────────────────────────────────────────────────────────────

class RoleRead(BaseModel):
    id: UUID
    name: str
    description: str

    model_config = {"from_attributes": True}


# ── User ──────────────────────────────────────────────────────────────────────

class SeedAdminCreate(BaseModel):
    """Used by the SuperAdmin bootstrap endpoint — creates the first Admin for a
    tenant. Username and password are auto-generated and emailed to the Admin.
    branch_id is required — a SuperAdmin always picks which office this Admin
    runs (see routers/users.py seed_admin)."""
    email: EmailStr
    full_name: str
    branch_id: UUID

    @field_validator("full_name")
    @classmethod
    def full_name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("full_name must not be blank")
        return v.strip()


class UserCreate(BaseModel):
    """Username and password are auto-generated and emailed to the new user.

    branch_id is required when a SuperAdmin creates an Admin, but ignored when
    an Admin creates a User — the new User instead inherits the creating
    Admin's own branch_id (see routers/users.py create_user)."""
    email: EmailStr
    full_name: str
    role_id: UUID
    branch_id: Optional[UUID] = None

    @field_validator("full_name")
    @classmethod
    def full_name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("full_name must not be blank")
        return v.strip()


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

    # Profile fields
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None
    avatar_url: Optional[str] = None
    department: Optional[str] = None
    employee_id: Optional[str] = None
    designation: Optional[str] = None
    date_of_joining: Optional[date] = None

    model_config = {"from_attributes": True}


class UserUpdate(BaseModel):
    role_id: Optional[UUID] = None
    branch_id: Optional[UUID] = None
    is_active: Optional[bool] = None
    password: Optional[str] = None
    status: Optional[UserStatus] = None

    # Profile fields
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None
    department: Optional[str] = None
    employee_id: Optional[str] = None
    designation: Optional[str] = None
    date_of_joining: Optional[date] = None

    @field_validator("password")
    @classmethod
    def password_min_length(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and len(v) < 8:
            raise ValueError("password must be at least 8 characters")
        return v


class ProfileUpdate(BaseModel):
    """Self-service update for the logged-in user's own profile.
    Deliberately excludes role/status/tenant — those require Admin/SuperAdmin."""
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None
    department: Optional[str] = None
    employee_id: Optional[str] = None
    designation: Optional[str] = None
    date_of_joining: Optional[date] = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def new_password_min_length(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("new_password must be at least 8 characters")
        return v


# ── Customer ─────────────────────────────────────────────────────────────────

from enum import Enum

class MaritalStatus(str, Enum):
    SINGLE   = "Single"
    MARRIED  = "Married"
    DIVORCED = "Divorced"
    WIDOWED  = "Widowed"

class CustomerCreate(BaseModel):
    cnic:             Optional[str] = None
    first_name:       str
    last_name:        Optional[str] = ""
    date_of_birth:    Optional[date] = None
    gender:           Optional[Gender] = None
    marital_status:   Optional[MaritalStatus] = None
    nationality:      str = "Pakistani"
    occupation:       Optional[str] = None
    declared_income:  Optional[float] = None
    is_smoker:        Optional[bool] = False
    height_cm:        Optional[float] = 170.0
    weight_kg:        Optional[float] = 70.0
    profile_status:   Optional[ProfileStatusEnum] = None
    acquisition_source_id: Optional[UUID] = None
    details:          Optional[dict] = None

    @field_validator("cnic")
    @classmethod
    def validate_cnic(cls, v: Optional[str]) -> Optional[str]:
        if not v or not v.strip():
            return None
        import re
        v = v.strip()
        if re.fullmatch(r"\d{13}", v):
            v = f"{v[:5]}-{v[5:12]}-{v[12]}"
        if not re.fullmatch(r"\d{5}-\d{7}-\d", v):
            raise ValueError("cnic must be 13 digits or in the format XXXXX-XXXXXXX-X")
        return v

    @field_validator("height_cm")
    @classmethod
    def height_cm_positive(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and v <= 0:
            raise ValueError("height_cm must be greater than 0")
        return v

    @field_validator("weight_kg")
    @classmethod
    def weight_kg_positive(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and v <= 0:
            raise ValueError("weight_kg must be greater than 0")
        return v

class AcquisitionSourceRead(BaseModel):
    """Who brought the customer in — the crediting agent / broker / bank / etc.
    Compact shape embedded inside CustomerRead."""
    id:               UUID
    source_type:      AcquisitionSourceType
    name:             str
    code:             str
    partner_name:     Optional[str] = None
    city:             Optional[str] = None

    model_config = {"from_attributes": True}

class AcquisitionSourceCreate(BaseModel):
    source_type:      AcquisitionSourceType
    name:             str
    code:             str
    partner_name:     Optional[str] = None
    contact_person:   Optional[str] = None
    contact_phone:    Optional[str] = None
    contact_email:    Optional[str] = None
    city:             Optional[str] = None
    is_active:        bool = True

class AcquisitionSourceUpdate(BaseModel):
    source_type:      Optional[AcquisitionSourceType] = None
    name:             Optional[str] = None
    code:             Optional[str] = None
    partner_name:     Optional[str] = None
    contact_person:   Optional[str] = None
    contact_phone:    Optional[str] = None
    contact_email:    Optional[str] = None
    city:             Optional[str] = None
    is_active:        Optional[bool] = None

class AcquisitionSourceFull(BaseModel):
    """Full shape returned by the management endpoints."""
    id:               UUID
    tenant_id:        UUID
    source_type:      AcquisitionSourceType
    name:             str
    code:             str
    partner_name:     Optional[str] = None
    contact_person:   Optional[str] = None
    contact_phone:    Optional[str] = None
    contact_email:    Optional[str] = None
    city:             Optional[str] = None
    is_active:        bool
    created_at:       datetime
    customer_count:   int = 0    # how many customers this source has brought in

    model_config = {"from_attributes": True}

class CustomerRead(BaseModel):
    id:               UUID
    tenant_id:        UUID
    cnic:             Optional[str] = None
    name:             str
    dob:              Optional[date] = None
    gender:           Optional[Gender] = None
    marital_status:   Optional[MaritalStatus] = None
    occupation:       Optional[str] = None
    declared_income:  Optional[float] = None
    is_smoker:        Optional[bool] = False
    height_cm:        Optional[float] = 170.0
    weight_kg:        Optional[float] = 70.0
    profile_status:   ProfileStatusEnum = ProfileStatusEnum.LEAD
    created_at:       datetime
    details:          Optional[dict] = None

    # Who brought this customer in (nullable — legacy/API-created rows may have none)
    acquisition_source_id: Optional[UUID] = None
    acquisition_source:    Optional[AcquisitionSourceRead] = None

    model_config = {"from_attributes": True}

class CustomerStatsRead(BaseModel):
    """Counts backing the KPI cards atop the admin Customers directory."""
    total_customers:      int
    active_policyholders: int   # has >=1 Policy in Approved/Issued status — "taking insurance"
    full_details:         int   # PROSPECT/UNDERWRITING_READY, not yet an active policyholder
    quick_leads:          int   # LEAD, not yet an active policyholder
    not_interested:       int   # explicitly disqualified/declined

class CustomerUpdate(BaseModel):
    cnic:             Optional[str] = None
    first_name:       Optional[str] = None
    last_name:        Optional[str] = None
    date_of_birth:    Optional[date] = None
    gender:           Optional[Gender] = None
    marital_status:   Optional[MaritalStatus] = None
    nationality:      Optional[str] = None
    occupation:       Optional[str] = None
    declared_income:  Optional[float] = None
    is_smoker:        Optional[bool] = None
    height_cm:        Optional[float] = None
    weight_kg:        Optional[float] = None
    profile_status:   Optional[ProfileStatusEnum] = None
    acquisition_source_id: Optional[UUID] = None
    details:          Optional[dict] = None

    @field_validator("height_cm")
    @classmethod
    def height_cm_positive(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and v <= 0:
            raise ValueError("height_cm must be greater than 0")
        return v

    @field_validator("weight_kg")
    @classmethod
    def weight_kg_positive(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and v <= 0:
            raise ValueError("weight_kg must be greater than 0")
        return v


# ── Policy ────────────────────────────────────────────────────────────────────

class PolicyCreate(BaseModel):
    plan_id:              Optional[UUID] = None
    product_name:         str
    insurance_type:       InsuranceTypeEnum
    coverage_amount:      float
    term_years:           int
    dependent_name:       Optional[str] = None
    dependent_dob:        Optional[date] = None
    nominee_name:          Optional[str] = None
    nominee_relationship: Optional[str] = None


class PolicyRead(BaseModel):
    id:               UUID
    tenant_id:        UUID
    customer_id:     UUID
    product_name:     str
    insurance_type:   InsuranceTypeEnum
    coverage_amount:  float
    term_years:       int
    dependent_name:   Optional[str] = None
    dependent_dob:    Optional[date] = None
    nominee_name:      Optional[str] = None
    nominee_relationship: Optional[str] = None
    status:           PolicyStatusEnum
    created_at:       datetime

    model_config = {"from_attributes": True}


# ── Organization / Group insurance ─────────────────────────────────────────────

class OrganizationCreate(BaseModel):
    name: str
    registration_number: Optional[str] = None
    industry: Optional[str] = None
    contact_person: Optional[str] = None
    contact_email: Optional[EmailStr] = None
    contact_phone: Optional[str] = None

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("name must not be blank")
        return v.strip()


class OrganizationUpdate(BaseModel):
    name: Optional[str] = None
    registration_number: Optional[str] = None
    industry: Optional[str] = None
    contact_person: Optional[str] = None
    contact_email: Optional[EmailStr] = None
    contact_phone: Optional[str] = None

class OrganizationRead(BaseModel):
    id: UUID
    tenant_id: UUID
    name: str
    registration_number: Optional[str] = None
    industry: Optional[str] = None
    contact_person: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    created_at: datetime

    # Computed, populated only by the list/get endpoints (routers/organizations.py) —
    # not persisted columns. Defaults let create/update responses skip the extra queries.
    employee_count:       int = 0
    master_policy_status: Optional[str] = None   # "Active" | "Pending" | None (no policy yet)

    model_config = {"from_attributes": True}


class OrganizationStatsRead(BaseModel):
    """Counts backing the KPI cards atop the admin Organizations directory."""
    total_organizations: int
    active:               int   # has a MasterPolicy with status Active
    in_progress:          int   # has a MasterPolicy, none Active yet (census/setup pending)
    new_no_policy:        int   # no MasterPolicy at all yet


class MasterPolicyCreate(BaseModel):
    sum_assured_multiple: float
    term_years: int
    effective_date: date


class MasterPolicyRead(BaseModel):
    id: UUID
    tenant_id: UUID
    organization_id: UUID
    insurance_type: InsuranceTypeEnum
    sum_assured_multiple: float
    term_years: int
    effective_date: date
    status: str
    free_cover_limit: Optional[float] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class CensusRequest(BaseModel):
    """Raw employee rows — kept as loose dicts (rather than a strict per-field
    model) so group_underwriting.validate_census() can report friendly
    per-row errors instead of an opaque FastAPI 422 on the first bad row."""
    employees: List[Dict[str, Any]]


class CensusValidationResponse(BaseModel):
    is_valid: bool
    total: int
    duplicate_cnics: List[str] = []
    missing_fields: List[str] = []
    errors: List[str] = []
    # Preview only (nothing persisted yet) — omitted when is_valid is False,
    # since a malformed batch (e.g. bad dob) can't have its average age computed.
    computed_free_cover_limit: Optional[float] = None


class CensusEmployeeOutcome(BaseModel):
    customer_id: UUID
    policy_id: UUID
    coverage_amount: float
    status: PolicyStatusEnum
    premium_total: float
    suggested_loading: Optional[float] = None
    risk_assessment_id: Optional[UUID] = None


class CensusConfirmResponse(BaseModel):
    free_cover_limit: float
    employees: List[CensusEmployeeOutcome]


# ─────────────────────────────────────────────────────────────────────────────
# Family Insurance Schemas — mirrors the Organization/MasterPolicy/Census
# schemas above; see services/tenant-service/routers/families.py.
# ─────────────────────────────────────────────────────────────────────────────

class FamilyGroupCreate(BaseModel):
    name: str
    contact_person: Optional[str] = None
    contact_email: Optional[EmailStr] = None
    contact_phone: Optional[str] = None
    household_declared_income: Optional[float] = None

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("name must not be blank")
        return v.strip()


class FamilyGroupUpdate(BaseModel):
    name: Optional[str] = None
    contact_person: Optional[str] = None
    contact_email: Optional[EmailStr] = None
    contact_phone: Optional[str] = None
    household_declared_income: Optional[float] = None

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not v.strip():
            raise ValueError("name must not be blank")
        if v is not None:
            return v.strip()
        return v


class FamilyGroupRead(BaseModel):
    id: UUID
    tenant_id: UUID
    name: str
    contact_person: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    household_declared_income: Optional[float] = None
    primary_member_customer_id: Optional[UUID] = None
    created_at: datetime

    # Computed, populated only by the list/get endpoints (routers/families.py) —
    # not persisted columns. Defaults let create/update responses skip the extra queries.
    member_count:         int = 0
    family_policy_status: Optional[str] = None   # "Active" | "Pending" | None (no policy yet)

    model_config = {"from_attributes": True}


class FamilyStatsRead(BaseModel):
    """Counts backing the KPI cards atop the admin Family Insurance directory."""
    total_families: int
    active:          int   # has a FamilyPolicy with status Active
    in_progress:     int   # members added and/or a Pending policy, none Active yet
    new_no_members:  int   # just created, no members added yet


class FloaterPolicyCreate(BaseModel):
    total_sum_insured: float
    term_years: int
    effective_date: date


class LifeBundlePolicyCreate(BaseModel):
    term_years: int
    effective_date: date
    discount_percentage: float = 0.0


class FamilyPolicyRead(BaseModel):
    id: UUID
    tenant_id: UUID
    family_group_id: UUID
    plan_type: FamilyPlanTypeEnum
    insurance_type: Optional[InsuranceTypeEnum] = None
    total_sum_insured: Optional[float] = None
    discount_percentage: Optional[float] = None
    term_years: int
    effective_date: date
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


class FamilyMembersRequest(BaseModel):
    """Raw member rows — kept as loose dicts, same reasoning as CensusRequest:
    family_underwriting.validate_family_members() reports friendly per-row
    errors instead of an opaque FastAPI 422 on the first bad row."""
    members: List[Dict[str, Any]]


class FamilyValidationResponse(BaseModel):
    is_valid: bool
    total: int
    duplicate_cnics: List[str] = []
    missing_fields: List[str] = []
    errors: List[str] = []


class FamilyMemberOutcome(BaseModel):
    customer_id: UUID
    policy_id: UUID                       # shared, for FLOATER; own, for LIFE_BUNDLE
    relationship: FamilyRelationshipEnum
    status: PolicyStatusEnum
    premium_total: Optional[float] = None
    suggested_loading: Optional[float] = None
    risk_assessment_id: Optional[UUID] = None


class FamilyConfirmResponse(BaseModel):
    family_policy_id: UUID
    total_sum_insured: Optional[float] = None
    members: List[FamilyMemberOutcome]


# ─────────────────────────────────────────────────────────────────────────────
# Case Schemas
# ─────────────────────────────────────────────────────────────────────────────
from shared.models.core import (
    CaseTypeEnum,
    CaseStatusEnum,
    CasePriorityEnum,
    SourceChannelEnum,
    AssignedRoleEnum,
    CommentTypeEnum,
    VisibilityLevelEnum
)

class CaseCreate(BaseModel):
    customer_id:     UUID
    policy_id:        Optional[UUID] = None
    caseType:         CaseTypeEnum
    priorityLevel:    CasePriorityEnum = CasePriorityEnum.NORMAL
    sourceChannel:    SourceChannelEnum
    assignedTeamld:   Optional[UUID] = None
    assignedAgentId:  Optional[UUID] = None

class CaseUpdate(BaseModel):
    caseType:         Optional[CaseTypeEnum] = None
    priorityLevel:    Optional[CasePriorityEnum] = None
    sourceChannel:    Optional[SourceChannelEnum] = None
    assignedAgentId:  Optional[UUID] = None

class CaseRead(BaseModel):
    caseld:           UUID
    caseNumber:       str
    tenant_id:        UUID
    customer_id:     UUID
    policy_id:        Optional[UUID] = None
    caseType:         CaseTypeEnum
    caseStatus:       CaseStatusEnum
    priorityLevel:    CasePriorityEnum
    sourceChannel:    SourceChannelEnum
    createdAt:        datetime
    updatedAt:        datetime
    assignedTeamld:   Optional[UUID] = None
    assignedAgentId:  Optional[UUID] = None
    slaDeadline:      Optional[datetime] = None
    escalationLevel:  int
    parentCaseld:     Optional[UUID] = None

    # Enrichment — only populated by GET /cases (the Underwriting queue);
    # None on create/update/get-single responses, which return the bare Case row.
    customer_name:        Optional[str] = None
    customer_cnic:        Optional[str] = None
    product_name:           Optional[str] = None
    coverage_amount:         Optional[float] = None
    latest_ai_decision:      Optional[str] = None
    latest_composite_score:  Optional[int] = None

    model_config = {"from_attributes": True}

class CaseStatusUpdate(BaseModel):
    status: CaseStatusEnum

class CaseAssignmentCreate(BaseModel):
    assignedToUserld: UUID
    assignedRole: AssignedRoleEnum

class CaseCommentCreate(BaseModel):
    commentText: str
    commentType: CommentTypeEnum
    visibilityLevel: VisibilityLevelEnum


# ── Insurance Plans ───────────────────────────────────────────────────────────

class MedicalExamTierSchema(BaseModel):
    minSumAssured: float
    tier: str

    @field_validator("minSumAssured")
    @classmethod
    def non_negative(cls, v: float) -> float:
        if v < 0:
            raise ValueError("minSumAssured must not be negative")
        return v

    @field_validator("tier")
    @classmethod
    def tier_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("tier must not be blank")
        return v.strip()


class InsurancePlanCreate(BaseModel):
    code: str
    label: str
    insurance_type: InsuranceTypeEnum
    category: PlanCategoryEnum = PlanCategoryEnum.INDIVIDUAL
    product_category: ProductCategoryEnum = ProductCategoryEnum.CONVENTIONAL
    partner_bank: Optional[str] = None
    status: PlanStatusEnum = PlanStatusEnum.DRAFT
    description: str = ""
    color: str = "blue"

    entry_age_min: int
    entry_age_max: int
    entry_age_label: str = "Proposer"
    dependent_age_min: Optional[int] = None
    dependent_age_max: Optional[int] = None

    term_min_years: int
    term_max_years: int
    max_maturity_age: int
    max_income_multiple: float

    min_group_size: Optional[int] = None
    underwriting_basis: Optional[str] = None

    # Pricing framework — defaults are neutral (0 rate / 1.0x factor) until
    # real rates are loaded per plan.
    base_premium_rate: float = 0.0
    smoker_factor: float = 1.0
    rate_version: str = "v1"

    medical_exam_tiers: List[MedicalExamTierSchema] = []
    required_documents: List[str] = []

    @field_validator("code")
    @classmethod
    def code_format(cls, v: str) -> str:
        v = v.strip().upper()
        if not v:
            raise ValueError("code must not be blank")
        if not v.replace("-", "").replace("_", "").isalnum():
            raise ValueError("code must be alphanumeric (hyphens/underscores allowed)")
        return v

    @field_validator("label")
    @classmethod
    def label_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("label must not be blank")
        return v.strip()

    @model_validator(mode="after")
    def check_bands(self) -> "InsurancePlanCreate":
        if self.entry_age_max < self.entry_age_min:
            raise ValueError("entry_age_max must be >= entry_age_min")
        if self.term_max_years < self.term_min_years:
            raise ValueError("term_max_years must be >= term_min_years")
        if (self.dependent_age_min is None) != (self.dependent_age_max is None):
            raise ValueError("dependent_age_min and dependent_age_max must be set together")
        if (
            self.dependent_age_min is not None
            and self.dependent_age_max is not None
            and self.dependent_age_max < self.dependent_age_min
        ):
            raise ValueError("dependent_age_max must be >= dependent_age_min")
        return self


class InsurancePlanUpdate(BaseModel):
    label: Optional[str] = None
    insurance_type: Optional[InsuranceTypeEnum] = None
    category: Optional[PlanCategoryEnum] = None
    product_category: Optional[ProductCategoryEnum] = None
    partner_bank: Optional[str] = None
    status: Optional[PlanStatusEnum] = None
    description: Optional[str] = None
    color: Optional[str] = None

    entry_age_min: Optional[int] = None
    entry_age_max: Optional[int] = None
    entry_age_label: Optional[str] = None
    dependent_age_min: Optional[int] = None
    dependent_age_max: Optional[int] = None

    term_min_years: Optional[int] = None
    term_max_years: Optional[int] = None
    max_maturity_age: Optional[int] = None
    max_income_multiple: Optional[float] = None

    min_group_size: Optional[int] = None
    underwriting_basis: Optional[str] = None

    base_premium_rate: Optional[float] = None
    smoker_factor: Optional[float] = None
    rate_version: Optional[str] = None

    medical_exam_tiers: Optional[List[MedicalExamTierSchema]] = None
    required_documents: Optional[List[str]] = None
    is_active: Optional[bool] = None


class InsurancePlanRead(BaseModel):
    id: UUID
    tenant_id: UUID
    code: str
    label: str
    insurance_type: InsuranceTypeEnum
    category: PlanCategoryEnum
    product_category: ProductCategoryEnum
    partner_bank: Optional[str]
    status: PlanStatusEnum
    description: str
    color: str

    entry_age_min: int
    entry_age_max: int
    entry_age_label: str
    dependent_age_min: Optional[int]
    dependent_age_max: Optional[int]

    term_min_years: int
    term_max_years: int
    max_maturity_age: int
    max_income_multiple: float

    min_group_size: Optional[int]
    underwriting_basis: Optional[str]

    base_premium_rate: float
    smoker_factor: float
    rate_version: str

    medical_exam_tiers: List[MedicalExamTierSchema]
    required_documents: List[str]

    is_active: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
