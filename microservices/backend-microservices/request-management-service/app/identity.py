"""Who is calling. Verified with tenant-service's /auth/me on the caller's own token, the same check the portal,
the Automation Chat and the Underwriting Workbench rely on.

Nothing the browser says about itself is trusted: the user id, tenant, role and branch all come from /auth/me. An
X-Tenant-Id header that disagrees with the session is rejected outright (it means a client is trying to act on a
tenant it doesn't belong to). Inactive, suspended or deleted accounts are refused, and accounts without a tenant
(SuperAdmin) have no access to tenant requests.

Verified identities are cached for REQUEST_MGMT_IDENTITY_CACHE_SECONDS (default 15) per token, so a deactivated
user is cut off within that time.
"""
import hashlib
import time
from dataclasses import dataclass
from typing import Optional
from uuid import UUID

from fastapi import Request

from app import tenant_client
from app.config import settings
from app.errors import ApiError, forbidden, unauthenticated
from app.permissions import is_known_role


@dataclass(frozen=True)
class Identity:
    user_id: UUID
    tenant_id: UUID
    name: str
    email: str
    role: str
    branch_id: Optional[UUID]
    token: str


_cache: dict[str, tuple[float, Identity]] = {}


def clear_cache() -> None:
    _cache.clear()


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer ") or len(header) < 20:
        raise unauthenticated()
    return header[7:].strip()


async def resolve(token: str) -> Identity:
    key = hashlib.sha256(token.encode()).hexdigest()
    hit = _cache.get(key)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    try:
        resp = await tenant_client.get_client().me(token)
    except tenant_client.TenantServiceUnavailable:
        raise ApiError(503, "AUTH_UNAVAILABLE", "The sign-in service can't be reached. Try again shortly.")
    if resp.status in (401, 404):
        raise unauthenticated("Your session has expired or was revoked. Sign in again.")
    if resp.status != 200 or not isinstance(resp.body, dict):
        raise ApiError(503, "AUTH_UNAVAILABLE", "The sign-in service returned an error.")
    me = resp.body
    if not me.get("is_active") or str(me.get("status", "")).upper() != "ACTIVE":
        raise forbidden("Your account is not active.", code="ACCOUNT_INACTIVE")
    if not me.get("tenant_id"):
        raise forbidden("Requests belong to a tenant; platform accounts have no access.", code="NO_TENANT")
    role = me.get("role_name") or "Viewer"
    if not is_known_role(role):
        raise forbidden("Your role has no access to requests.", code="ROLE_NOT_ALLOWED")
    identity = Identity(
        user_id=UUID(me["id"]), tenant_id=UUID(me["tenant_id"]),
        name=me.get("full_name") or me.get("email") or "User", email=me.get("email") or "",
        role=role, branch_id=UUID(me["branch_id"]) if me.get("branch_id") else None, token=token,
    )
    _cache[key] = (time.monotonic() + settings.identity_cache_seconds, identity)
    if len(_cache) > 5000:
        now = time.monotonic()
        for k in [k for k, (exp, _) in _cache.items() if exp < now]:
            _cache.pop(k, None)
    return identity


async def current_identity(request: Request) -> Identity:
    identity = await resolve(_bearer(request))
    claimed = request.headers.get("x-tenant-id")
    if claimed and claimed.strip() and claimed.strip().lower() != str(identity.tenant_id):
        raise forbidden("The tenant in this request doesn't match your session.", code="TENANT_MISMATCH")
    return identity
