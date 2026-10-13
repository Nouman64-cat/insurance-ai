"""Service-to-service endpoints (tenant-service -> Customer Management). Signed with TENANT_TO_CM_KEY; never routed by
the API gateway. Password HASHES are accepted here (so already-issued temporary passwords keep working) and are never
returned, logged or published."""
from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from app import accounts, db
from app.deps import signed_by_tenant_service
from app.errors import not_found

router = APIRouter(prefix="/internal/v1", tags=["Internal"], include_in_schema=False, dependencies=[Depends(signed_by_tenant_service)])


class AccountIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: UUID
    tenant_code: str = Field(max_length=50)
    customer_id: UUID
    username: str = Field(min_length=1, max_length=255)
    password_hash: str = Field(min_length=20, max_length=255, pattern=r"^\$2[aby]\$")  # bcrypt only
    display_name: str = ""
    credential_expires_at: Optional[datetime] = None
    mode: Literal["ensure", "reset"] = "ensure"
    reason: Optional[str] = Field(default=None, max_length=300)


@router.put("/accounts")
async def put_account(body: AccountIn):
    async with db.transaction() as conn:
        return await accounts.ensure_account(
            conn, tenant_id=body.tenant_id, tenant_code=body.tenant_code, customer_id=body.customer_id, username=body.username,
            password_hash=body.password_hash, display_name=body.display_name, credential_expires_at=body.credential_expires_at,
            mode=body.mode, reason=body.reason)


@router.get("/accounts/by-customer/{customer_id}")
async def by_customer(customer_id: UUID, tenant_id: UUID = Query(...)):
    async with db.engine().connect() as conn:
        row = (await conn.execute(text("SELECT id, username, state, must_change_password, last_login_at, activated_at FROM accounts "
                                       "WHERE tenant_id = :t AND customer_id = :c"), {"t": tenant_id, "c": customer_id})).mappings().first()
    if row is None:
        raise not_found("Account")
    return {**{k: (str(v) if k == "id" else v) for k, v in dict(row).items()}}


class StateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: Optional[str] = Field(default=None, max_length=300)


@router.post("/accounts/{account_id}/suspend")
async def suspend(account_id: UUID, body: StateIn):
    async with db.transaction() as conn:
        if not await accounts.set_state(conn, account_id, "SUSPENDED", body.reason or "Suspended by staff"):
            raise not_found("Account")
    return {"state": "SUSPENDED"}


@router.post("/accounts/{account_id}/release")
async def release(account_id: UUID, body: StateIn):
    async with db.transaction() as conn:
        if not await accounts.set_state(conn, account_id, "ACTIVE", body.reason):
            raise not_found("Account")
    return {"state": "RELEASED"}
