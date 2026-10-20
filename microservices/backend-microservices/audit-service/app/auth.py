"""Who is calling, and what part of the ledger they may see.

Verified with tenant-service's /auth/me on the caller's own token (the same check the portal, Request Management and
Customer Service rely on); nothing the browser says about itself is trusted. Only the roles in AUDIT_READ_ROLES get in:

  Admin       their own tenant's chain, read-only (an X-Tenant-Id that disagrees with the session is rejected);
  SuperAdmin  every chain, including the platform chain;
  anyone else 403.

There is deliberately no role that can write: the API has no create/update/delete route for audit records.
"""
import hashlib
import time
from dataclasses import dataclass
from typing import Optional
from uuid import UUID

import httpx
from fastapi import HTTPException, Request

from app.config import settings
from app.services.query_service import Scope


@dataclass(frozen=True)
class Identity:
    user_id: UUID
    tenant_id: Optional[UUID]
    name: str
    email: str
    role: str
    token: str

    @property
    def is_super_admin(self) -> bool:
        return self.role == "SuperAdmin"

    @property
    def requester(self) -> str:
        return f"{self.name} <{self.email}> ({self.role})"[:200]


async def fetch_me(token: str) -> tuple[int, object]:
    """tenant-service /auth/me for this token: (status, body). Replaced in tests."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{settings.tenant_service_url}/auth/me", headers={"Authorization": f"Bearer {token}"})
    try:
        return resp.status_code, resp.json()
    except ValueError:
        return resp.status_code, None


_cache: dict[str, tuple[float, Identity]] = {}


def clear_cache() -> None:
    _cache.clear()


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer ") or len(header) < 20:
        raise HTTPException(401, "Sign in to view the audit trail.")
    return header[7:].strip()


async def resolve(token: str) -> Identity:
    key = hashlib.sha256(token.encode()).hexdigest()
    hit = _cache.get(key)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    try:
        status, body = await fetch_me(token)
    except httpx.HTTPError:
        raise HTTPException(503, "The sign-in service can't be reached. Try again shortly.")
    if status in (401, 404):
        raise HTTPException(401, "Your session has expired or was revoked. Sign in again.")
    if status != 200 or not isinstance(body, dict):
        raise HTTPException(503, "The sign-in service returned an error.")
    if not body.get("is_active") or str(body.get("status", "")).upper() != "ACTIVE":
        raise HTTPException(403, "Your account is not active.")
    role = body.get("role_name") or "Viewer"
    if role not in settings.read_roles:
        raise HTTPException(403, "Your role cannot view the audit trail.")
    tenant_id = UUID(body["tenant_id"]) if body.get("tenant_id") else None
    if tenant_id is None and role != "SuperAdmin":
        raise HTTPException(403, "The audit trail belongs to a tenant; this account has none.")
    identity = Identity(user_id=UUID(body["id"]), tenant_id=tenant_id, name=body.get("full_name") or body.get("email") or "User",
                        email=body.get("email") or "", role=role, token=token)
    _cache[key] = (time.monotonic() + settings.identity_cache_seconds, identity)
    if len(_cache) > 2000:
        now = time.monotonic()
        for k in [k for k, (exp, _) in _cache.items() if exp < now]:
            _cache.pop(k, None)
    return identity


async def current_identity(request: Request) -> Identity:
    identity = await resolve(_bearer(request))
    claimed = request.headers.get("x-tenant-id")
    if claimed and claimed.strip() and identity.tenant_id and claimed.strip().lower() != str(identity.tenant_id):
        raise HTTPException(403, "The tenant in this request doesn't match your session.")
    return identity


def scope_for(identity: Identity) -> Scope:
    if identity.is_super_admin:
        return Scope(unrestricted=True)
    return Scope(tenant_id=identity.tenant_id)
