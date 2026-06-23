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
from typing import List
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordBearer
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import create_db_and_tables, get_session
from kafka_producer import create_producer
from routers.evaluate import router as evaluate_router
from schemas import (
    CurrentUserResponse,
    RoleRead,
    TokenResponse,
    UserCreate,
    UserRead,
    UserUpdate,
)
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
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/token")


async def _proxy_to_tenant(request: Request, url: str) -> Response:
    async with httpx.AsyncClient() as client:
        headers = dict(request.headers)
        headers.pop("host", None)
        body = await request.body()
        try:
            resp = await client.request(
                method=request.method,
                url=url,
                headers=headers,
                params=request.query_params,
                content=body,
                timeout=30.0,
            )
            return Response(content=resp.content, status_code=resp.status_code, headers=dict(resp.headers))
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Error connecting to tenant service: {exc}")


# ── Authentication ─────────────────────────────────────────────────────────────

@app.post(
    "/auth/token",
    tags=["Authentication"],
    response_model=TokenResponse,
    summary="Login",
    openapi_extra={
        "requestBody": {
            "content": {
                "application/x-www-form-urlencoded": {
                    "schema": {
                        "type": "object",
                        "properties": {
                            "username": {"type": "string", "description": "User email"},
                            "password": {"type": "string", "format": "password"},
                        },
                        "required": ["username", "password"],
                    }
                }
            },
            "required": True,
        }
    },
)
async def login(request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/auth/token")


@app.get("/auth/me", tags=["Authentication"], response_model=CurrentUserResponse, summary="Get current user")
async def get_current_user(request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/auth/me")


# ── Users ──────────────────────────────────────────────────────────────────────

@app.post(
    "/tenants/{tenant_id}/users",
    tags=["Users"],
    response_model=UserRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create a user",
)
async def create_user(tenant_id: UUID, body: UserCreate, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/users/")


@app.get(
    "/tenants/{tenant_id}/users/",
    tags=["Users"],
    response_model=List[UserRead],
    summary="List users (admin only)",
)
async def list_users(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/users/")


@app.get(
    "/tenants/{tenant_id}/users/{user_id}",
    tags=["Users"],
    response_model=UserRead,
    summary="Get a user by ID",
)
async def get_user(tenant_id: UUID, user_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/users/{user_id}")


@app.patch(
    "/tenants/{tenant_id}/users/{user_id}",
    tags=["Users"],
    response_model=UserRead,
    summary="Update a user (admin only)",
)
async def update_user(tenant_id: UUID, user_id: UUID, body: UserUpdate, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/users/{user_id}")


@app.delete(
    "/tenants/{tenant_id}/users/{user_id}",
    tags=["Users"],
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a user (admin only)",
)
async def delete_user(tenant_id: UUID, user_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/users/{user_id}")


# ── Applicants ─────────────────────────────────────────────────────────────────

@app.post("/tenants/{tenant_id}/applicants", tags=["Applicants"], status_code=201, summary="Create an applicant (admin only)")
async def create_applicant(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/applicants")


@app.get("/tenants/{tenant_id}/applicants", tags=["Applicants"], summary="List all applicants (admin only)")
async def list_applicants(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/applicants")


@app.get("/tenants/{tenant_id}/applicants/{applicant_id}", tags=["Applicants"], summary="Get an applicant by ID")
async def get_applicant(tenant_id: UUID, applicant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/applicants/{applicant_id}")


@app.delete("/tenants/{tenant_id}/applicants/{applicant_id}", tags=["Applicants"], status_code=204, summary="Delete an applicant")
async def delete_applicant(tenant_id: UUID, applicant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/applicants/{applicant_id}")


@app.put("/tenants/{tenant_id}/applicants/{applicant_id}", tags=["Applicants"], summary="Update an applicant")
async def update_applicant(tenant_id: UUID, applicant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/applicants/{applicant_id}")


# ── Roles ──────────────────────────────────────────────────────────────────────

@app.get("/roles", tags=["Roles"], response_model=List[RoleRead], summary="List all roles")
async def list_roles(request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/roles")


# ── Catch-all proxy (hidden from Swagger) ──────────────────────────────────────

@app.api_route("/auth/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_auth(path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/auth/{path}")


@app.api_route("/tenants/{tenant_id}/users{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_users(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/users{path}")


@app.api_route("/tenants/{tenant_id}/applicants{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_applicants(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/applicants{path}")


@app.api_route("/roles", methods=["GET", "OPTIONS"], include_in_schema=False)
async def proxy_roles(request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/roles")



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
