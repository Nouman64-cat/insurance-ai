from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, field_validator
from shared.models.core import UserStatus, Gender


# ── Tenant ────────────────────────────────────────────────────────────────────

class TenantCreate(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("name must not be blank")
        return v.strip()


class TenantRead(BaseModel):
    id: UUID
    name: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class TenantUpdate(BaseModel):
    name: Optional[str] = None
    is_active: Optional[bool] = None


# ── Role ──────────────────────────────────────────────────────────────────────

class RoleRead(BaseModel):
    id: UUID
    name: str
    description: str

    model_config = {"from_attributes": True}


# ── User ──────────────────────────────────────────────────────────────────────

class SeedAdminCreate(BaseModel):
    """Used by the no-auth bootstrap endpoint — creates the first Admin for a tenant."""
    email: EmailStr
    username: str
    password: str
    first_name: str
    last_name: str

    @field_validator("password")
    @classmethod
    def password_min_length(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("password must be at least 8 characters")
        return v


class UserCreate(BaseModel):
    username: str
    email: EmailStr
    password: str
    role_id: UUID
    
    # Profile fields
    first_name: str
    last_name: str
    phone: Optional[str] = None
    department: Optional[str] = None
    employee_id: Optional[str] = None
    designation: Optional[str] = None
    date_of_joining: Optional[date] = None

    @field_validator("password")
    @classmethod
    def password_min_length(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("password must be at least 8 characters")
        return v


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


# ── Applicant ─────────────────────────────────────────────────────────────────

from enum import Enum

class MaritalStatus(str, Enum):
    SINGLE   = "Single"
    MARRIED  = "Married"
    DIVORCED = "Divorced"
    WIDOWED  = "Widowed"

class ApplicantCreate(BaseModel):
    cnic:             str          # e.g. "35201-1234567-1"
    first_name:       str
    last_name:        str
    date_of_birth:    date
    gender:           Gender       # "Male" | "Female" | "Other"
    marital_status:   Optional[MaritalStatus] = None
    nationality:      str = "Pakistani"
    occupation:       str
    declared_income:  float        # annual PKR
    details:          Optional[dict] = None

    @field_validator("cnic")
    @classmethod
    def validate_cnic(cls, v: str) -> str:
        import re
        v = v.strip()
        if re.fullmatch(r"\d{13}", v):
            v = f"{v[:5]}-{v[5:12]}-{v[12]}"
        if not re.fullmatch(r"\d{5}-\d{7}-\d", v):
            raise ValueError("cnic must be 13 digits or in the format XXXXX-XXXXXXX-X")
        return v

class ApplicantRead(BaseModel):
    id:               UUID
    tenant_id:        UUID
    cnic:             str
    name:             str
    dob:              date
    gender:           Gender
    occupation:       str
    declared_income:  float
    created_at:       datetime
    details:          Optional[dict] = None

    model_config = {"from_attributes": True}

class ApplicantUpdate(BaseModel):
    cnic:             Optional[str] = None
    first_name:       Optional[str] = None
    last_name:        Optional[str] = None
    date_of_birth:    Optional[date] = None
    gender:           Optional[Gender] = None
    marital_status:   Optional[MaritalStatus] = None
    nationality:      Optional[str] = None
    occupation:       Optional[str] = None
    declared_income:  Optional[float] = None
    details:          Optional[dict] = None


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
    applicant_id:     UUID
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
    applicant_id:     UUID
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
