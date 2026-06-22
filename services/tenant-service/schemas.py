from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, field_validator


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

class UserCreate(BaseModel):
    email: EmailStr
    password: str
    full_name: str
    role_id: UUID

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
    full_name: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    role_id: Optional[UUID] = None
    is_active: Optional[bool] = None
