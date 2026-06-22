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

import os
import httpx
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import create_db_and_tables, get_session
from kafka_producer import create_producer
from routers.evaluate import router as evaluate_router
from shared.models.core import Tenant


# ─────────────────────────────────────────────────────────────────────────────
# Lifespan — runs once on startup and on shutdown
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    await create_db_and_tables()
    app.state.kafka_producer = await create_producer()
    yield
    await app.state.kafka_producer.stop()


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
# CORS — allow the Next.js dev server and any localhost port to call the API
# ─────────────────────────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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


# ── Proxy routing to tenant-service ───────────────────────────────────────────

TENANT_SERVICE_URL = os.environ.get("TENANT_SERVICE_URL", "http://tenant-service:8001")

@app.api_route("/auth/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
async def proxy_auth(path: str, request: Request):
    async with httpx.AsyncClient() as client:
        headers = dict(request.headers)
        headers.pop("host", None)
        body = await request.body()
        url = f"{TENANT_SERVICE_URL}/auth/{path}"
        try:
            resp = await client.request(
                method=request.method,
                url=url,
                headers=headers,
                params=request.query_params,
                content=body,
                timeout=30.0
            )
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                headers=dict(resp.headers)
            )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Error connecting to tenant service: {exc}"
            )

@app.api_route("/tenants/{tenant_id}/users{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
async def proxy_tenant_users(tenant_id: UUID, path: str, request: Request):
    async with httpx.AsyncClient() as client:
        headers = dict(request.headers)
        headers.pop("host", None)
        body = await request.body()
        url = f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/users{path}"
        try:
            resp = await client.request(
                method=request.method,
                url=url,
                headers=headers,
                params=request.query_params,
                content=body,
                timeout=30.0
            )
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                headers=dict(resp.headers)
            )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Error connecting to tenant service: {exc}"
            )


@app.api_route("/roles", methods=["GET", "OPTIONS"])
async def proxy_roles(request: Request):
    async with httpx.AsyncClient() as client:
        headers = dict(request.headers)
        headers.pop("host", None)
        url = f"{TENANT_SERVICE_URL}/roles"
        try:
            resp = await client.request(
                method=request.method,
                url=url,
                headers=headers,
                params=request.query_params,
                timeout=30.0
            )
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                headers=dict(resp.headers)
            )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Error connecting to tenant service: {exc}"
            )


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
    existing = (await session.exec(select(Tenant).where(Tenant.name == name))).first()
    if existing:
        return {"id": str(existing.id), "name": existing.name, "created_at": existing.created_at}

    tenant = Tenant(name=name)
    session.add(tenant)
    await session.commit()
    await session.refresh(tenant)
    return {"id": str(tenant.id), "name": tenant.name, "created_at": tenant.created_at}


@app.get(
    "/tenants",
    tags=["Bootstrap"],
    summary="List all tenants",
)
async def list_tenants(
    session: AsyncSession = Depends(get_session),
):
    tenants = list(await session.exec(select(Tenant)))
    return [{"id": str(t.id), "name": t.name, "created_at": t.created_at} for t in tenants]


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
