"""Request dependencies: who is calling, and from where."""
from typing import Optional

from fastapi import Depends, Header, Request

from app import accounts, db, security
from app.accounts import Principal
from app.config import settings
from app.errors import ApiError, forbidden, unauthenticated
from shared.security.service_auth import CALLER_HEADER, verify


def client_ip(request: Request) -> str:
    # The portal's BFF forwards the browser's address; direct callers fall back to the socket peer.
    return (request.headers.get("x-client-ip") or (request.client.host if request.client else "") or "unknown")[:64]


def user_agent(request: Request) -> str:
    return (request.headers.get("x-client-user-agent") or request.headers.get("user-agent") or "")[:300]


async def _principal(request: Request, authorization: Optional[str]) -> Principal:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise unauthenticated()
    claims = security.decode_access_token(authorization[7:].strip())
    if claims is None:
        raise ApiError(401, "SESSION_EXPIRED", "Your session has ended. Please sign in again.")
    async with db.transaction() as conn:
        principal = await accounts.principal_for(conn, claims)
    if principal is None:
        raise ApiError(401, "SESSION_EXPIRED", "Your session has ended. Please sign in again.")
    request.state.account_id = str(principal.account_id)
    return principal


async def current_customer(request: Request, authorization: Optional[str] = Header(None)) -> Principal:
    """A signed-in customer with a FULL session. A first-login (password change only) token is refused here."""
    principal = await _principal(request, authorization)
    if principal.scope != "full":
        raise ApiError(403, "PASSWORD_CHANGE_REQUIRED", "Set a new password before continuing.")
    return principal


async def password_change_session(request: Request, authorization: Optional[str] = Header(None)) -> Principal:
    """Either a first-login token or a full session — whoever may change their own password."""
    return await _principal(request, authorization)


async def signed_by_tenant_service(request: Request) -> None:
    """tenant-service -> Customer Management calls: HMAC with TENANT_TO_CM_KEY and the caller name checked."""
    path = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    body = await request.body()
    if not settings.from_tenant_key or request.headers.get(CALLER_HEADER) != "tenant-service" \
            or not verify(settings.from_tenant_key, request.method, path, body, request.headers):
        raise ApiError(401, "SERVICE_AUTH_FAILED", "Invalid service signature")
