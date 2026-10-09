import asyncio
import os
import logging

import subprocess
import sys

# ── Pre-import check for pgvector support in database ──────────────────────────
def _check_pgvector_support() -> bool:
    code = """
import asyncio
import os
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

async def check():
    db_url = os.environ.get("DATABASE_URL", "postgresql+asyncpg://postgres:1122@host.docker.internal:5432/insurance_ai")
    engine = create_async_engine(db_url)
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector;"))
    await engine.dispose()

asyncio.run(check())
"""
    try:
        res = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=5)
        return res.returncode == 0
    except Exception:
        return False

if not _check_pgvector_support():
    os.environ["DISABLE_PGVECTOR"] = "true"

from contextlib import asynccontextmanager

from aiokafka import AIOKafkaProducer
from aiokafka.errors import KafkaConnectionError
import re
from uuid import UUID

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

logger = logging.getLogger("tenant-service.main")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

from database import _session_factory
from migrate import run_migrations
from ocr_worker import start_ocr_worker
from services.case_events import publish_data_changed
from routers.tenants import router as tenants_router
from routers.branches import router as branches_router
from routers.users import router as users_router
from routers.auth import router as auth_router
from routers.customers import router as customers_router
from routers.cases import router as cases_router
from routers.artifacts import router as artifacts_router
from routers.organizations import router as organizations_router
from routers.group_policies import router as group_policies_router
from routers.group_census_upload import router as group_census_upload_router
from routers.group_endorsements import router as group_endorsements_router
from routers.group_claims import router as group_claims_router
from routers.group_renewals import router as group_renewals_router
from routers.group_coverages import router as group_coverages_router
from routers.group_ptf import router as group_ptf_router
from services.group_renewal import start_group_renewal_scheduler
from routers.families import router as families_router
from routers.insurance_plans import router as insurance_plans_router
from routers.tokens import router as tokens_router
from routers.llm_config import router as llm_config_router
from routers.acquisition_sources import router as acquisition_sources_router
from routers.roles import router as roles_router
from routers.agent import router as agent_router
from routers.policies import router as policies_router
from routers.pre_issuance import router as pre_issuance_router
from routers.post_issuance import router as post_issuance_router
from routers.e_application import router as e_application_router
from routers.agent_confidential_report import router as agent_confidential_report_router
from routers.initial_premium_payment import router as initial_premium_payment_router
from routers.insurance_history import router as insurance_history_router
from routers.medical_exam import router as medical_exam_router
from routers.reinsurance import router as reinsurance_router
from routers.claims import router as claims_router
from routers.demo import router as demo_router
from routers.rules import router as rules_router
from routers.search import router as search_router
# STAGE B — POST-ISSUANCE: renewal scheduler import disabled for now.
# from routers.renewal_scheduler import start_renewal_scheduler
from shared.models.core import Role

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")

# ── Standard RBAC roles seeded once at startup ────────────────────────────────

from role_seed import SEED_ROLES as _SEED_ROLES


async def _seed_roles(session: AsyncSession) -> None:
    for name, description in _SEED_ROLES:
        exists = (await session.exec(select(Role).where(Role.name == name))).first()
        if not exists:
            session.add(Role(name=name, description=description))
    await session.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await run_migrations()
    async with _session_factory() as session:
        await _seed_roles(session)

    # Kafka producer — shared across all request handlers via app.state
    producer = AIOKafkaProducer(
        bootstrap_servers=KAFKA_BOOTSTRAP,
        value_serializer=lambda v: v.encode("utf-8"),
        key_serializer=lambda k: k.encode("utf-8") if k else None,
        acks="all",
        enable_idempotence=True,
    )
    
    retries = 30
    delay = 2
    for attempt in range(1, retries + 1):
        try:
            logger.info(f"Connecting to Kafka at {KAFKA_BOOTSTRAP} (attempt {attempt}/{retries})...")
            await producer.start()
            logger.info("Successfully connected to Kafka.")
            break
        except (KafkaConnectionError, Exception) as e:
            if attempt == retries:
                logger.error(f"Failed to connect to Kafka after {retries} attempts: {e}")
                raise e
            logger.warning(f"Kafka connection attempt {attempt} failed, retrying in {delay}s...")
            await asyncio.sleep(delay)

    app.state.kafka_producer = producer

    # OCR worker — background asyncio task
    stop_event = asyncio.Event()
    worker_task = start_ocr_worker(stop_event)

    # Group scheme renewals — daily job, opt-in (GROUP_RENEWAL_SCHEDULER=true).
    group_renewal_task = start_group_renewal_scheduler(stop_event, _session_factory)

    # ── STAGE B — POST-ISSUANCE LIFECYCLE (renewal scheduler) ──────────────────
    # Daily state machine (ACTIVE → GracePeriod → Lapsed + renewals). Runs AFTER
    # a policy is issued. Temporarily disabled for now — re-enable with the import
    # above when Stage B is back in scope.
    # renewal_task = start_renewal_scheduler(stop_event)
    # ───────────────────────────────────────────────────────────────────────────

    yield

    # Graceful shutdown
    stop_event.set()
    await worker_task
    if group_renewal_task is not None:
        await group_renewal_task
    # await renewal_task  # STAGE B — disabled (see above)
    await producer.stop()


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="insurance-ai — Tenant Service",
    version="0.1.0",
    description="Manages insurance companies (tenants) and their employees (users). "
                "Every downstream microservice uses the tenant_id issued here.",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

_WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_TENANT_RESOURCE = re.compile(r"^/tenants/([0-9a-fA-F-]{36})/([A-Za-z][\w-]*)")


@app.middleware("http")
async def announce_writes(request: Request, call_next):
    """After every successful write under /tenants/{id}/<resource>, publish a
    DataChanged event so live clients (the agent app's SSE feed) refresh on
    their own. Published in the background — never delays or fails the write."""
    response = await call_next(request)
    if request.method in _WRITE_METHODS and response.status_code < 400:
        match = _TENANT_RESOURCE.match(request.url.path)
        producer = getattr(request.app.state, "kafka_producer", None)
        if match and producer is not None:
            try:
                tenant_id = UUID(match.group(1))
            except ValueError:
                return response
            asyncio.create_task(publish_data_changed(
                producer, tenant_id=tenant_id, resource=match.group(2), method=request.method,
            ))
    return response


app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://.*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tenants_router)
app.include_router(branches_router)
app.include_router(users_router)
app.include_router(auth_router)
app.include_router(customers_router)
app.include_router(cases_router)
app.include_router(artifacts_router)
app.include_router(organizations_router)
app.include_router(group_policies_router)
app.include_router(group_census_upload_router)
app.include_router(group_endorsements_router)
app.include_router(group_claims_router)
app.include_router(group_renewals_router)
app.include_router(group_coverages_router)
app.include_router(group_ptf_router)
app.include_router(families_router)
app.include_router(insurance_plans_router)
app.include_router(tokens_router)
app.include_router(llm_config_router)
app.include_router(acquisition_sources_router)
app.include_router(roles_router)
app.include_router(agent_router)
app.include_router(policies_router)
app.include_router(pre_issuance_router)
app.include_router(post_issuance_router)
app.include_router(e_application_router)
app.include_router(agent_confidential_report_router)
app.include_router(initial_premium_payment_router)
# Pre-underwriting clearance gates 5 & 6 — insurance history, panel medicals.
app.include_router(insurance_history_router)
app.include_router(medical_exam_router)
# Post-underwriting — facultative reinsurance referral (before final approval).
app.include_router(reinsurance_router)
app.include_router(claims_router)
app.include_router(demo_router)
app.include_router(rules_router)
app.include_router(search_router)


@app.get("/health", tags=["Ops"])
async def health_check():
    return {"service": "tenant-service", "status": "healthy"}


@app.get("/roles", tags=["Roles"])
async def list_roles():
    from database import get_session
    async for session in get_session():
        roles = list(await session.exec(select(Role)))
        return [{"id": str(r.id), "name": r.name, "description": r.description} for r in roles]
