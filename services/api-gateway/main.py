"""
API Gateway — single public entry point for the insurance-ai platform.

Responsibilities:
  - Table initialisation on startup (create_db_and_tables via SQLModel).
  - Proxying tenant/user/auth endpoints to the tenant-service (which owns
    that data — see POST /tenants, POST /tenants/{id}/setup).
  - Routing POST /evaluate to the underwriting router.
"""

import asyncio
import json
import os
import httpx
from contextlib import asynccontextmanager
from typing import List
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordBearer
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from database import create_db_and_tables
from kafka_producer import create_producer
from quote_worker import start_quote_worker
from risk_result_worker import start_risk_result_worker
from routers.chat import router as chat_router
from routers.evaluate import router as evaluate_router
from routers.quote import router as quote_router
from routers.suggest import router as suggest_router
from schemas import (
    CurrentUserResponse,
    RoleRead,
    TokenResponse,
    UserCreate,
    UserRead,
    UserUpdate,
)


# ─────────────────────────────────────────────────────────────────────────────
# Lifespan — runs once on startup and on shutdown
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    await create_db_and_tables()
    app.state.kafka_producer = await create_producer()

    # Background Kafka consumers, both driven by one stop event:
    #   • quote worker       — generates quotations for newly created customers.
    #   • risk result worker — persists RiskAssessments for proposals submitted
    #     through the async POST /evaluate path. Without it, results published on
    #     insurance.risk.evaluated.v1 have no subscriber and are discarded.
    stop_event = asyncio.Event()
    worker_tasks = [
        start_quote_worker(stop_event),
        start_risk_result_worker(stop_event),
    ]

    yield

    stop_event.set()
    await asyncio.gather(*worker_tasks, return_exceptions=True)
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
    allow_origin_regex=r"https?://.*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────────────────────
# Global error handler — keeps error responses consistent
# ─────────────────────────────────────────────────────────────────────────────

@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    origin = request.headers.get("origin")
    headers = {}
    if origin:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "An unexpected error occurred. Check the service logs."},
        headers=headers,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Routers
# ─────────────────────────────────────────────────────────────────────────────

app.include_router(evaluate_router)
app.include_router(quote_router)
app.include_router(suggest_router)
app.include_router(chat_router)


# ── Proxy routing to tenant-service ───────────────────────────────────────────

TENANT_SERVICE_URL = os.environ.get("TENANT_SERVICE_URL", "http://tenant-service:8001")
TEXT_SUMMARIZER_URL = os.environ.get("TEXT_SUMMARIZER_URL", "http://text-summarizer:8005")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/token")


async def _proxy_to_tenant(request: Request, url: str) -> Response:
    async with httpx.AsyncClient(follow_redirects=True) as client:
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
                timeout=120.0,
            )
            resp_headers = dict(resp.headers)
            # Strip CORS headers from upstream tenant-service to prevent duplicate CORS headers
            for cors_key in [
                "access-control-allow-origin",
                "access-control-allow-credentials",
                "access-control-allow-methods",
                "access-control-allow-headers",
                "access-control-expose-headers",
                "content-length",
                "transfer-encoding",
            ]:
                resp_headers.pop(cors_key, None)
            if "location" in resp_headers:
                loc = resp_headers["location"]
                loc = loc.replace("http://tenant-service:8001", "http://localhost:8010")
                resp_headers["location"] = loc
            return Response(content=resp.content, status_code=resp.status_code, headers=resp_headers)
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


# ── Bootstrap — SuperAdmin only ────────────────────────────────────────────────

@app.post(
    "/tenants/{tenant_id}/setup",
    tags=["Bootstrap"],
    response_model=UserRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create first Admin user (SuperAdmin only)",
    description=(
        "One-time bootstrap endpoint. Creates the first Admin user for a tenant. "
        "Requires a SuperAdmin JWT. Returns **409** if any user already exists — "
        "after that, use `POST /auth/token` to log in and manage users normally."
    ),
)
async def seed_admin(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/setup")


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
    "/tenants/{tenant_id}/users/directory",
    tags=["Users"],
    response_model=List[UserRead],
    summary="List active users in directory",
)
async def list_directory_users(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/users/directory")


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


# ── Customers ─────────────────────────────────────────────────────────────────

@app.post("/tenants/{tenant_id}/customers", tags=["Customers"], status_code=201, summary="Create an customer (admin only)")
async def create_customer(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/customers")


@app.get("/tenants/{tenant_id}/customers", tags=["Customers"], summary="List all customers (admin only)")
async def list_customers(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/customers")


@app.get("/tenants/{tenant_id}/customers/stats", tags=["Customers"], summary="Get customer stats (admin only)")
async def get_customer_stats(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/customers/stats")


@app.get("/tenants/{tenant_id}/customers/{customer_id}", tags=["Customers"], summary="Get an customer by ID")
async def get_customer(tenant_id: UUID, customer_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/customers/{customer_id}")


@app.delete("/tenants/{tenant_id}/customers/{customer_id}", tags=["Customers"], status_code=204, summary="Delete an customer")
async def delete_customer(tenant_id: UUID, customer_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/customers/{customer_id}")


@app.put("/tenants/{tenant_id}/customers/{customer_id}", tags=["Customers"], summary="Update an customer")
async def update_customer(tenant_id: UUID, customer_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/customers/{customer_id}")


# ── Cases ──────────────────────────────────────────────────────────────────────

@app.post("/tenants/{tenant_id}/cases", tags=["Cases"], status_code=201, summary="Create a case")
async def create_case(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases")


@app.get("/tenants/{tenant_id}/cases", tags=["Cases"], summary="List all cases")
async def list_cases(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases")


@app.get(
    "/tenants/{tenant_id}/cases/{case_id}/detail",
    tags=["Cases"],
    summary="Get bundled case + customer + policy + document checklist + latest risk assessment",
)
async def get_case_detail(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/detail")


@app.get("/tenants/{tenant_id}/cases/{case_id}", tags=["Cases"], summary="Get a case by ID")
async def get_case(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}")


@app.put("/tenants/{tenant_id}/cases/{case_id}", tags=["Cases"], summary="Update a case")
async def update_case(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}")


@app.delete("/tenants/{tenant_id}/cases/{case_id}", tags=["Cases"], status_code=204, summary="Delete a case")
async def delete_case(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}")


@app.patch("/tenants/{tenant_id}/cases/{case_id}/status", tags=["Cases"], summary="Update case status")
async def update_case_status(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/status")


@app.post("/tenants/{tenant_id}/cases/{case_id}/assignments", tags=["Cases"], status_code=201, summary="Assign a case")
async def assign_case(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/assignments")


@app.post("/tenants/{tenant_id}/cases/{case_id}/comments", tags=["Cases"], status_code=201, summary="Add a comment")
async def add_case_comment(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/comments")


@app.get(
    "/tenants/{tenant_id}/cases/{case_id}/document-checklist",
    tags=["Cases"],
    summary="Get required/received/missing documents for a case's plan type",
)
async def get_case_document_checklist(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/document-checklist")


@app.post(
    "/tenants/{tenant_id}/cases/{case_id}/compliance/run",
    tags=["Cases"],
    summary="Run PEP, Sanctions and SECP compliance screening for a case",
)
async def run_case_compliance(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/compliance/run")


# ── Artifacts ─────────────────────────────────────────────────────────────────

@app.post(
    "/tenants/{tenant_id}/cases/{case_id}/artifacts",
    tags=["Artifacts"],
    status_code=201,
    summary="Upload a document (PDF/PNG/JPEG) and run OCR",
)
async def upload_artifact(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/artifacts")


@app.get(
    "/tenants/{tenant_id}/cases/{case_id}/artifacts",
    tags=["Artifacts"],
    summary="List artifacts for a case",
)
async def list_case_artifacts(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/artifacts")


@app.get(
    "/tenants/{tenant_id}/artifacts/{artifact_id}",
    tags=["Artifacts"],
    summary="Get artifact with fresh presigned download URL",
)
async def get_artifact(tenant_id: UUID, artifact_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/artifacts/{artifact_id}")


@app.patch(
    "/tenants/{tenant_id}/artifacts/{artifact_id}",
    tags=["Artifacts"],
    summary="Update artifact metadata (e.g. document_type)",
)
async def update_artifact(tenant_id: UUID, artifact_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/artifacts/{artifact_id}")


@app.delete(
    "/tenants/{tenant_id}/artifacts/{artifact_id}",
    status_code=204,
    tags=["Artifacts"],
    summary="Delete artifact from S3 and database",
)
async def delete_artifact(tenant_id: UUID, artifact_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/artifacts/{artifact_id}")


# ── Pre-Underwriting — E-Application (customer) ────────────────────────────────

@app.post(
    "/tenants/{tenant_id}/cases/{case_id}/e-application/invite",
    tags=["Pre-Underwriting"],
    summary="Generate a tokenized E-Application link for the customer",
)
async def invite_e_application(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/e-application/invite")


@app.get(
    "/tenants/{tenant_id}/cases/{case_id}/e-application",
    tags=["Pre-Underwriting"],
    summary="Get E-Application status/content for a case (staff view)",
)
async def get_e_application(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/e-application")


# Public — no auth, scoped only by the token itself. The customer never logs in.
@app.get(
    "/public/e-application/{raw_token}",
    tags=["Pre-Underwriting"],
    summary="[Public] Fetch E-Application by invite token",
)
async def public_get_e_application(raw_token: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/public/e-application/{raw_token}")


@app.put(
    "/public/e-application/{raw_token}",
    tags=["Pre-Underwriting"],
    summary="[Public] Autosave E-Application draft by invite token",
)
async def public_save_e_application(raw_token: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/public/e-application/{raw_token}")


@app.post(
    "/public/e-application/{raw_token}/submit",
    tags=["Pre-Underwriting"],
    summary="[Public] Submit the completed, signed E-Application",
)
async def public_submit_e_application(raw_token: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/public/e-application/{raw_token}/submit")


# ── Pre-Underwriting — Medical Examination (panel clinics) ────────────────────

@app.post(
    "/tenants/{tenant_id}/cases/{case_id}/medical-exam/assess",
    tags=["Pre-Underwriting"],
    summary="Apply the non-medical-limit grid and raise the medical requirement",
)
async def assess_medical_exam(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/medical-exam/assess")


@app.post(
    "/tenants/{tenant_id}/cases/{case_id}/medical-exam/invite",
    tags=["Pre-Underwriting"],
    summary="Issue a tokenized panel-clinic booking link to the customer",
)
async def invite_medical_exam(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/medical-exam/invite")


@app.get(
    "/tenants/{tenant_id}/cases/{case_id}/medical-exam",
    tags=["Pre-Underwriting"],
    summary="Get the medical examination order for a case (staff view)",
)
async def get_medical_exam(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/medical-exam")


# Public — no auth, scoped only by the booking token itself.
@app.get(
    "/public/medical-exam/{raw_token}",
    tags=["Pre-Underwriting"],
    summary="[Public] Fetch the mandated tests, preparation notes and panel clinics",
)
async def public_get_medical_exam(raw_token: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/public/medical-exam/{raw_token}")


@app.post(
    "/public/medical-exam/{raw_token}/book",
    tags=["Pre-Underwriting"],
    summary="[Public] Book a panel-clinic appointment slot",
)
async def public_book_medical_exam(raw_token: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/public/medical-exam/{raw_token}/book")


@app.post(
    "/public/medical-exam/{raw_token}/complete",
    tags=["Pre-Underwriting"],
    summary="[Public] Mark examination as completed",
)
async def public_complete_medical_exam(raw_token: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/public/medical-exam/{raw_token}/complete")


@app.post(
    "/tenants/{tenant_id}/cases/{case_id}/medical-exam/result",
    tags=["Pre-Underwriting"],
    summary="Record diagnostics results from a panel clinic",
)
async def record_medical_result(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/medical-exam/result")


@app.post(
    "/tenants/{tenant_id}/cases/{case_id}/medical-exam/waive",
    tags=["Pre-Underwriting"],
    summary="Waive the panel medical requirement",
)
async def waive_medical_exam(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/medical-exam/waive")


@app.get(
    "/tenants/{tenant_id}/panel-clinics",
    tags=["Pre-Underwriting"],
    summary="List active panel diagnostic centres",
)
async def list_panel_clinics(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/panel-clinics")


# ── Pre-Underwriting — Insurance History ──────────────────────────────────────

@app.post(
    "/tenants/{tenant_id}/cases/{case_id}/insurance-history/run",
    tags=["Pre-Underwriting"],
    summary="Screen prior/other-insurer cover for over-insurance, replacement and non-disclosure",
)
async def run_insurance_history(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/insurance-history/run")


@app.get(
    "/tenants/{tenant_id}/cases/{case_id}/insurance-history",
    tags=["Pre-Underwriting"],
    summary="Get the insurance-history screen result for a case",
)
async def get_insurance_history(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/insurance-history")


# ── Post-Underwriting — Facultative Reinsurance ───────────────────────────────

@app.get(
    "/tenants/{tenant_id}/policies/{policy_id}/reinsurance",
    tags=["Post-Underwriting"],
    summary="Cession position for a policy — retained / treaty / facultative",
)
async def get_reinsurance(tenant_id: UUID, policy_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/policies/{policy_id}/reinsurance")


@app.post(
    "/tenants/{tenant_id}/policies/{policy_id}/reinsurance/refer",
    tags=["Post-Underwriting"],
    summary="Submit the facultative slip to a reinsurer",
)
async def refer_to_reinsurer(tenant_id: UUID, policy_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/policies/{policy_id}/reinsurance/refer")


@app.post(
    "/tenants/{tenant_id}/policies/{policy_id}/reinsurance/response",
    tags=["Post-Underwriting"],
    summary="Record the reinsurer's decision and terms",
)
async def record_reinsurer_response(tenant_id: UUID, policy_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/policies/{policy_id}/reinsurance/response")


@app.post(
    "/tenants/{tenant_id}/policies/{policy_id}/reinsurance/apply",
    tags=["Post-Underwriting"],
    summary="Write the reinsurer's terms onto the policy and release it",
)
async def apply_reinsurer_terms(tenant_id: UUID, policy_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/policies/{policy_id}/reinsurance/apply")


# ── Pre-Underwriting — Agent's Confidential Report (ACR) ───────────────────────

@app.get(
    "/tenants/{tenant_id}/cases/{case_id}/acr",
    tags=["Pre-Underwriting"],
    summary="Get the Agent's Confidential Report for a case",
)
async def get_acr(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/acr")


@app.put(
    "/tenants/{tenant_id}/cases/{case_id}/acr",
    tags=["Pre-Underwriting"],
    summary="Create/update the Agent's Confidential Report draft",
)
async def upsert_acr(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/acr")


@app.post(
    "/tenants/{tenant_id}/cases/{case_id}/acr/submit",
    tags=["Pre-Underwriting"],
    summary="Submit and lock the Agent's Confidential Report",
)
async def submit_acr(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/acr/submit")


# ── Pre-Underwriting — Initial Premium Payment (IPP) ────────────────────────────

@app.get(
    "/tenants/{tenant_id}/cases/{case_id}/ipp",
    tags=["Pre-Underwriting"],
    summary="Get Initial Premium Payment status for a case",
)
async def get_ipp(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/ipp")


@app.post(
    "/tenants/{tenant_id}/cases/{case_id}/ipp/initiate",
    tags=["Pre-Underwriting"],
    summary="Initiate the Initial Premium Payment for a case (pre-underwriting)",
)
async def initiate_ipp(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/ipp/initiate")


@app.post(
    "/tenants/{tenant_id}/cases/{case_id}/ipp/confirm",
    tags=["Pre-Underwriting"],
    summary="Confirm/settle the Initial Premium Payment for a case",
)
async def confirm_ipp(tenant_id: UUID, case_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases/{case_id}/ipp/confirm")


# ── Text Summarizer ────────────────────────────────────────────────────────────

@app.post("/summarize/stream", tags=["Summarizer"], summary="Stream case summary via SSE (Gemini 2.5 Flash)")
async def summarize_stream(request: Request):
    """Proxies SSE streaming from the text-summarizer service — no auth required on this leg."""
    body = await request.body()

    async def _generate():
        try:
            async with httpx.AsyncClient(timeout=300.0) as client:
                async with client.stream(
                    "POST",
                    f"{TEXT_SUMMARIZER_URL}/summarize/stream",
                    content=body,
                    headers={"Content-Type": "application/json"},
                ) as resp:
                    async for chunk in resp.aiter_bytes():
                        yield chunk
        except httpx.ConnectError:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Text summarizer is unreachable'})}\n\n"
        except httpx.TimeoutException:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Text summarizer timed out after 300 s'})}\n\n"

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


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


@app.api_route("/tenants/{tenant_id}/cases{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_cases(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/cases{path}")


@app.api_route("/tenants/{tenant_id}/customers{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_customers(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/customers{path}")


@app.api_route("/tenants/{tenant_id}/organizations{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_organizations(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/organizations{path}")


@app.api_route("/tenants/{tenant_id}/families{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_families(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/families{path}")


@app.api_route("/tenants/{tenant_id}/insurance-plans{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_insurance_plans(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/insurance-plans{path}")


@app.api_route("/tenants/{tenant_id}/acquisition-sources{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_acquisition_sources(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/acquisition-sources{path}")


@app.api_route("/tenants/{tenant_id}/policies{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_policies(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/policies{path}")


@app.api_route("/tenants/{tenant_id}/requirements{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_requirements(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/requirements{path}")


@app.api_route("/tenants/{tenant_id}/compliance{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_compliance(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/compliance{path}")


# Pre-underwriting medical scheduling: the panel-clinic directory. The exam
# order itself is case-scoped and already covered by the /cases wildcard above.
@app.api_route("/tenants/{tenant_id}/panel-clinics{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_panel_clinics(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/panel-clinics{path}")


# Post-underwriting reinsurance: the reinsurer panel. The referral itself is
# policy-scoped and already covered by the /policies wildcard above.
@app.api_route("/tenants/{tenant_id}/reinsurers{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_reinsurers(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/reinsurers{path}")


@app.api_route("/tenants/{tenant_id}/demo{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_demo(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/demo{path}")


@app.api_route("/tenants/{tenant_id}/rules{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_rules(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/rules{path}")


@app.api_route("/roles", methods=["GET", "OPTIONS"], include_in_schema=False)
async def proxy_roles(request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/roles")


@app.api_route("/tokens/usage", methods=["GET", "POST", "OPTIONS"], include_in_schema=False)
async def proxy_tokens_usage(request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tokens/usage")


# Platform LLM provider config (SuperAdmin). The tenant-service enforces the
# SuperAdmin JWT; the gateway only forwards. `/internal/llm-config` is
# deliberately NOT proxied — services reach it directly on the docker network.
@app.api_route(
    "/platform/llm-config{path:path}",
    methods=["GET", "PUT", "POST", "OPTIONS"],
    include_in_schema=False,
)
async def proxy_platform_llm_config(path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/platform/llm-config{path}")


@app.api_route("/agent/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_agent(path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/agent/{path}")


@app.api_route("/tenants/{tenant_id}/artifacts{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_artifacts(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/artifacts{path}")


# ── Global search — proxied to tenant-service, which owns the searched tables ──

@app.get(
    "/tenants/{tenant_id}/search",
    tags=["Search"],
    summary="Global search across cases, customers, policies and claims",
)
async def global_search(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/search")


@app.api_route("/tenants/{tenant_id}/search{path:path}", methods=["GET", "OPTIONS"], include_in_schema=False)
async def proxy_tenant_search(tenant_id: UUID, path: str, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/search{path}")



# ─────────────────────────────────────────────────────────────────────────────
# Health
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health", tags=["Ops"])
async def health_check():
    return {"service": "api-gateway", "status": "healthy"}


# ─────────────────────────────────────────────────────────────────────────────
# Tenant bootstrap — proxied to the tenant-service, which owns the Tenant table
# and enforces SuperAdmin auth on creation.
# ─────────────────────────────────────────────────────────────────────────────

@app.post(
    "/tenants",
    status_code=status.HTTP_201_CREATED,
    tags=["Bootstrap"],
    summary="Create a tenant (SuperAdmin only)",
    description=(
        "Creates a tenant record. Requires a SuperAdmin JWT. **Required before "
        "calling POST /evaluate.** Copy the returned `id` and send it as the "
        "`X-Tenant-Id` header."
    ),
)
async def create_tenant(request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/")


@app.get(
    "/tenants",
    tags=["Bootstrap"],
    summary="List all tenants",
)
async def list_tenants(request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/")


@app.get(
    "/tenants/{tenant_id}",
    tags=["Bootstrap"],
    summary="Get a tenant by ID",
)
async def get_tenant(tenant_id: UUID, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}")


@app.patch(
    "/tenants/{tenant_id}",
    tags=["Bootstrap"],
    summary="Update a tenant (SuperAdmin only)",
)
async def update_tenant(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}")


@app.delete(
    "/tenants/{tenant_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    tags=["Bootstrap"],
    summary="Delete a tenant (SuperAdmin only)",
)
async def delete_tenant(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}")


# ─────────────────────────────────────────────────────────────────────────────
# Branches — proxied to the tenant-service, which owns the Branch table and
# enforces SuperAdmin auth on writes (see services/tenant-service/routers/branches.py).
# ─────────────────────────────────────────────────────────────────────────────

@app.post(
    "/tenants/{tenant_id}/branches",
    status_code=status.HTTP_201_CREATED,
    tags=["Branches"],
    summary="Create a branch for a tenant (SuperAdmin only)",
)
async def create_branch(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/branches")


@app.get(
    "/tenants/{tenant_id}/branches",
    tags=["Branches"],
    summary="List branches for a tenant",
)
async def list_branches(tenant_id: UUID, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/branches")


@app.get(
    "/branches/{branch_id}",
    tags=["Branches"],
    summary="Get a branch by ID",
)
async def get_branch(branch_id: UUID, request: Request):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/branches/{branch_id}")


@app.patch(
    "/branches/{branch_id}",
    tags=["Branches"],
    summary="Update a branch (SuperAdmin only)",
)
async def update_branch(branch_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/branches/{branch_id}")


@app.delete(
    "/branches/{branch_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    tags=["Branches"],
    summary="Delete a branch (SuperAdmin only)",
)
async def delete_branch(branch_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/branches/{branch_id}")


# ─────────────────────────────────────────────────────────────────────────────
# Claims Management — proxied to tenant-service
# ─────────────────────────────────────────────────────────────────────────────

@app.api_route(
    "/tenants/{tenant_id}/claims",
    methods=["GET", "POST"],
    tags=["Claims"],
    summary="List or create claims",
)
async def proxy_claims(tenant_id: UUID, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/claims")


@app.api_route(
    "/tenants/{tenant_id}/claims/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    tags=["Claims"],
    summary="Proxy claim sub-resource operations",
)
async def proxy_claim_subroutes(tenant_id: UUID, path: str, request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_to_tenant(request, f"{TENANT_SERVICE_URL}/tenants/{tenant_id}/claims/{path}")

