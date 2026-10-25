"""Shared authorization dependencies for the core application's routers (built on the existing login and tenant checks; nothing here is a bypass).

Every dependency answers three questions in this order, and refuses at the first that fails:
  1. WHO is asking?       a valid, unexpired token of an active, not-deleted user          -> 401 otherwise
  2. WHICH tenant?        the user belongs to the tenant in the path (a Super Admin may reach any) -> 403 otherwise
  3. MAY they do this?    the user's role is one of the roles allowed for the action        -> 403 otherwise

The tenant id in the path is never trusted on its own: it is compared with the tenant of the verified user. A route that takes an id of a record (customer, policy, case...) must still check that the record belongs to the tenant.

  tenant_member            any active user of the tenant (reads that every role needs)
  require_roles("Admin")   those roles, plus the Super Admin
  member_or_service        a tenant member, OR a platform service that presents the shared internal secret (a service has no tenant of its own: the caller names it, so use this only
                           on routes that read nothing but what the request itself carries)

Roles are the seeded ones: SuperAdmin, Admin, Underwriter, Agent, Viewer, Finance, ClaimsManager, ClaimsAdjuster."""
import os
from typing import Optional
from uuid import UUID

from fastapi import Depends, Header, HTTPException, status
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, _role_name, oauth2_scheme, optional_oauth2_scheme
from routers.users import verify_tenant_member
from services.internal_auth import check_internal_secret
from shared.models.core import User

ADMIN = ("Admin",)
UNDERWRITING = ("Underwriter", "Admin")                  # authoring rules, deciding cases
tenant_member = verify_tenant_member


def require_roles(*allowed: str):
    """A dependency that admits only these roles (and the Super Admin) of the tenant in the path, and returns the verified user."""
    allowed_set = set(allowed) | {"SuperAdmin"}

    async def dependency(tenant_id: UUID, token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)) -> User:
        await verify_tenant_member(tenant_id, token, session)         # 401 / inactive / another tenant
        user = await _get_current_user(token, session)
        role = await _role_name(user, session)
        if role not in allowed_set:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"This action needs one of: {', '.join(sorted(allowed_set))}.")
        return user

    dependency.__name__ = "require_roles_" + "_".join(sorted(allowed_set))
    return dependency


async def acting_member(tenant_id: UUID, token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)) -> User:
    """Login + tenant membership, returning the verified user (so an audit entry names who really acted, not who the request body claims)."""
    await verify_tenant_member(tenant_id, token, session)
    return await _get_current_user(token, session)


def internal_secret() -> str:
    return os.environ.get("INTERNAL_API_SECRET", "").strip()


async def member_or_service(tenant_id: UUID, token: Optional[str] = Depends(optional_oauth2_scheme),
                            x_internal_secret: str = Header(default=""), session: AsyncSession = Depends(get_session)) -> Optional[User]:
    """A tenant member with a token, or a platform service with the internal secret. No token and no secret is a 401; a token is judged as a token (never silently replaced by the secret)."""
    if token:
        await verify_tenant_member(tenant_id, token, session)
        return await _get_current_user(token, session)
    if not x_internal_secret:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated", headers={"WWW-Authenticate": "Bearer"})
    check_internal_secret(internal_secret(), x_internal_secret)
    return None
