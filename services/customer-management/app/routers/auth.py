"""Customer sign-in. Customers use the credentials the post-issuance process already generated; there is no
self-registration. Tokens are returned to the portal's server (BFF), which keeps them in httpOnly cookies."""
import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from app import accounts, db, tenant_client
from app.accounts import Principal
from app.deps import client_ip, current_customer, password_change_session, user_agent
from app.errors import ApiError

log = logging.getLogger("customer-management.auth")
router = APIRouter(prefix="/v1", tags=["Authentication"])


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class LoginIn(Strict):
    username: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=256)
    tenant_code: Optional[str] = Field(default=None, max_length=50)


class RefreshIn(Strict):
    refresh_token: str = Field(min_length=20, max_length=200)


class PasswordIn(Strict):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)


class PreferencesIn(Strict):
    language: str = Field(pattern="^(en|ur)$")


@router.post("/auth/login")
async def login(body: LoginIn, request: Request):
    return await db.run_committing(lambda conn: accounts.login(
        conn, username=body.username, password=body.password, tenant_code=body.tenant_code, ip=client_ip(request), user_agent=user_agent(request)))


@router.post("/auth/refresh")
async def refresh(body: RefreshIn, request: Request):
    return await db.run_committing(lambda conn: accounts.refresh(conn, body.refresh_token, client_ip(request), user_agent(request)))


@router.post("/auth/logout")
async def logout(principal: Principal = Depends(password_change_session)):
    async with db.transaction() as conn:
        await accounts.revoke_session(conn, principal.session_id)
        await accounts.audit(conn, "LOGOUT", account_id=principal.account_id, tenant_id=principal.tenant_id)
    return {"ok": True}


async def _mirror_to_legacy(principal: Principal) -> None:
    """Keep the staff onboarding view truthful (activated, last sign-in) and the legacy hash current so a rollback to the
    old flow cannot lock customers out. One direction only, best effort: Customer Management stays the authority."""
    try:
        async with db.engine().connect() as conn:
            row = (await conn.execute(text("SELECT password_hash, must_change_password, last_login_at FROM accounts WHERE id = :id"),
                                      {"id": principal.account_id})).mappings().first()
        if row:
            c = tenant_client.get_client()
            await c.post(f"{c.scope(principal.tenant_id, principal.customer_id)}/portal-sync",
                         {"password_hash": row["password_hash"], "must_reset": row["must_change_password"],
                          "last_login_at": row["last_login_at"].isoformat() if row["last_login_at"] else None})
    except Exception as exc:  # noqa: BLE001
        log.warning("legacy mirror failed: %s", type(exc).__name__)


@router.post("/auth/password/first-change")
async def first_change(body: PasswordIn, request: Request, tasks: BackgroundTasks, principal: Principal = Depends(password_change_session)):
    """Replace the temporary password. Only valid while the account still has one."""
    if not principal.must_change_password:
        raise ApiError(409, "NOT_REQUIRED", "Your password has already been set. Use change password instead.")
    result = await db.run_committing(lambda conn: accounts.set_password(
        conn, principal, current_password=body.current_password, new_password=body.new_password, first_change=True,
        ip=client_ip(request), user_agent=user_agent(request)))
    tasks.add_task(_mirror_to_legacy, principal)
    return result


@router.post("/auth/password/change")
async def change_password(body: PasswordIn, request: Request, tasks: BackgroundTasks, principal: Principal = Depends(current_customer)):
    result = await db.run_committing(lambda conn: accounts.set_password(
        conn, principal, current_password=body.current_password, new_password=body.new_password, first_change=False,
        ip=client_ip(request), user_agent=user_agent(request)))
    tasks.add_task(_mirror_to_legacy, principal)
    return result


@router.get("/me")
async def me(principal: Principal = Depends(password_change_session)):
    return {"account_id": str(principal.account_id), "username": principal.username, "display_name": principal.display_name,
            "language": principal.language, "tenant_code": principal.tenant_code, "must_change_password": principal.must_change_password,
            "scope": principal.scope}


@router.patch("/me/preferences")
async def preferences(body: PreferencesIn, principal: Principal = Depends(current_customer)):
    async with db.transaction() as conn:
        await conn.execute(text("UPDATE accounts SET language = :l, updated_at = now() WHERE id = :id"), {"l": body.language, "id": principal.account_id})
    return {"language": body.language}
