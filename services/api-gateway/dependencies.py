"""
Reusable FastAPI dependencies for the API Gateway.

  get_tenant_id  — extracts and type-validates the X-Tenant-Id header.
                   Every route that touches the database must declare this
                   dependency to enforce per-tenant data isolation.

  get_settings   — returns a cached Settings object read from env vars.
                   Use this instead of os.environ.get() in route handlers
                   so the values can be overridden in tests.

  require_roles  — decodes the same JWT tenant-service issues (frontend
                   already attaches it as a Bearer token to every request —
                   see ClientLayout.tsx) and 403s unless the caller's role is
                   in the allowed list. Mirrors
                   tenant-service/routers/auth.py::verify_admin; duplicated
                   here (not imported) because api-gateway and tenant-service
                   are separate containers that only share the `shared/`
                   bind mount, not each other's routers.
"""

import os
from functools import lru_cache
from typing import Optional
from uuid import UUID

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from aiokafka import AIOKafkaProducer
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from shared.models.core import Role, User

JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY", "change-me-in-production")
JWT_ALGORITHM = "HS256"

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/token", auto_error=False)


# ─────────────────────────────────────────────────────────────────────────────
# Settings
# ─────────────────────────────────────────────────────────────────────────────

class Settings:
    risk_engine_url: str = os.environ.get(
        "RISK_ENGINE_URL", "http://risk-engine:8002"
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


# ─────────────────────────────────────────────────────────────────────────────
# Tenant identity
# ─────────────────────────────────────────────────────────────────────────────

async def get_kafka_producer(request: Request) -> AIOKafkaProducer:
    """Inject the shared AIOKafka producer from app.state into route handlers."""
    return request.app.state.kafka_producer


async def get_tenant_id(
    x_tenant_id: UUID = Header(
        ...,
        description=(
            "UUID of the tenant making this request. "
            "Must match an existing row in the `tenants` table."
        ),
    ),
) -> UUID:
    """
    Validates that the X-Tenant-Id header is present and is a well-formed UUID.
    FastAPI raises HTTP 422 automatically if the value cannot be parsed as UUID.

    The returned UUID is passed to route handlers as `tenant_id` and applied
    as a WHERE clause on every database query to enforce multi-tenant isolation.
    """
    return x_tenant_id


# ─────────────────────────────────────────────────────────────────────────────
# User identity / role enforcement
# ─────────────────────────────────────────────────────────────────────────────

async def get_current_user(
    token: Optional[str] = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
) -> User:
    """Decode the Bearer token (issued by tenant-service /auth/token) and
    load the User row it names. 401s on any missing/invalid/expired token."""
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )
    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Could not validate credentials",
            )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
        )

    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


def require_roles(*allowed_role_names: str):
    """
    Dependency factory — 403s unless the current user's Role.name is one of
    `allowed_role_names`. Usage: `Depends(require_roles("Underwriter", "Admin"))`.
    """

    async def _dependency(
        user: User = Depends(get_current_user),
        session: AsyncSession = Depends(get_session),
    ) -> User:
        role = await session.get(Role, user.role_id)
        role_name = role.name if role else "Viewer"
        if role_name not in allowed_role_names:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"This action requires one of: {', '.join(allowed_role_names)} (you are {role_name}).",
            )
        return user

    return _dependency
