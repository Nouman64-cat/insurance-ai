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
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

logger = logging.getLogger("tenant-service.main")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

from database import _session_factory
from migrate import run_migrations
from ocr_worker import start_ocr_worker
from routers.tenants import router as tenants_router
from routers.branches import router as branches_router
from routers.users import router as users_router
from routers.auth import router as auth_router
from routers.customers import router as customers_router
from routers.cases import router as cases_router
from routers.artifacts import router as artifacts_router
from routers.organizations import router as organizations_router
from routers.families import router as families_router
from routers.insurance_plans import router as insurance_plans_router
from routers.tokens import router as tokens_router
from routers.acquisition_sources import router as acquisition_sources_router
from routers.agent import router as agent_router
from routers.policies import router as policies_router
from routers.pre_issuance import router as pre_issuance_router
from routers.post_issuance import router as post_issuance_router
from routers.demo import router as demo_router
# STAGE B — POST-ISSUANCE: renewal scheduler import disabled for now.
# from routers.renewal_scheduler import start_renewal_scheduler
from shared.models.core import Role

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")

# ── Standard RBAC roles seeded once at startup ────────────────────────────────

_SEED_ROLES = [
    ("SuperAdmin",  "Platform-level access — create tenants and bootstrap their first Admin."),
    ("Admin",       "Full tenant access — manage that tenant's users and all resources."),
    ("Underwriter", "Evaluate proposals, review risk assessments, and make decisions."),
    ("Agent",       "Submit proposals and track their status."),
    ("Viewer",      "Read-only access to dashboards and reports."),
]


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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
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
app.include_router(families_router)
app.include_router(insurance_plans_router)
app.include_router(tokens_router)
app.include_router(acquisition_sources_router)
app.include_router(agent_router)
app.include_router(policies_router)
app.include_router(pre_issuance_router)
app.include_router(post_issuance_router)
app.include_router(demo_router)


@app.get("/health", tags=["Ops"])
async def health_check():
    return {"service": "tenant-service", "status": "healthy"}


@app.get("/roles", tags=["Roles"])
async def list_roles():
    from database import get_session
    async for session in get_session():
        roles = list(await session.exec(select(Role)))
        return [{"id": str(r.id), "name": r.name, "description": r.description} for r in roles]
