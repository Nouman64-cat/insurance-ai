"""
API Gateway — single public entry point for the insurance-ai platform.

Responsibilities:
  - Table initialisation on startup (create_db_and_tables via SQLModel).
  - Tenant bootstrap endpoints (POST /tenants, GET /tenants/{id}).
  - Routing POST /evaluate to the underwriting router.

In a production system the tenant lifecycle would live in a dedicated
tenant-service; these bootstrap routes are here solely to make the
prototype runnable without standing up every microservice.
"""

from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlmodel.ext.asyncio.session import AsyncSession

from database import create_db_and_tables, get_session
from routers.evaluate import router as evaluate_router
from shared.models.core import Tenant


# ─────────────────────────────────────────────────────────────────────────────
# Lifespan — runs once on startup and on shutdown
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Create missing DB tables before the first request is served."""
    await create_db_and_tables()
    yield
    # Teardown: nothing to clean up for now.


# ─────────────────────────────────────────────────────────────────────────────
# App
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="insurance-ai — API Gateway",
    version="0.1.0",
    description=(
        "Single public entry point for the insurance-ai underwriting platform. "
        "Validates requests, calls the Risk Engine, and persists results to "
        "PostgreSQL."
    ),
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)


# ─────────────────────────────────────────────────────────────────────────────
# Global error handler — keeps error responses consistent
# ─────────────────────────────────────────────────────────────────────────────

@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "An unexpected error occurred. Check the service logs."},
    )


# ─────────────────────────────────────────────────────────────────────────────
# Routers
# ─────────────────────────────────────────────────────────────────────────────

app.include_router(evaluate_router)


# ─────────────────────────────────────────────────────────────────────────────
# Health
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health", tags=["Ops"])
async def health_check():
    return {"service": "api-gateway", "status": "healthy"}


# ─────────────────────────────────────────────────────────────────────────────
# Tenant bootstrap
# These routes live here for prototype convenience.
# Move to the tenant-service when that microservice is implemented.
# ─────────────────────────────────────────────────────────────────────────────

@app.post(
    "/tenants",
    status_code=status.HTTP_201_CREATED,
    tags=["Bootstrap"],
    summary="Create a tenant",
    description=(
        "Creates a tenant record. **Required before calling POST /evaluate.** "
        "Copy the returned `id` and send it as the `X-Tenant-Id` header."
    ),
)
async def create_tenant(
    name: str,
    session: AsyncSession = Depends(get_session),
):
    tenant = Tenant(name=name)
    session.add(tenant)
    await session.commit()
    await session.refresh(tenant)
    return {
        "id": str(tenant.id),
        "name": tenant.name,
        "created_at": tenant.created_at,
    }


@app.get(
    "/tenants/{tenant_id}",
    tags=["Bootstrap"],
    summary="Get a tenant by ID",
)
async def get_tenant(
    tenant_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    tenant: Tenant | None = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tenant '{tenant_id}' not found.",
        )
    return {
        "id": str(tenant.id),
        "name": tenant.name,
        "created_at": tenant.created_at,
    }
