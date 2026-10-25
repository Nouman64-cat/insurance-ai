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
from case_hold import refuse_writes_on_held_case
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

logger = logging.getLogger("tenant-service.main")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

from database import _session_factory
from migrate import run_migrations
from ocr_worker import start_ocr_worker
from services.case_events import publish_data_changed
from services.audit_capture import AuditContextMiddleware, audit_status, install_capture, start_audit_relay
from routers.tenants import router as tenants_router
from routers.branches import router as branches_router
from routers.users import router as users_router
from routers.auth import router as auth_router
from routers.customers import router as customers_router
from routers.cases import router as cases_router
from routers.underwriting_tracks import router as underwriting_tracks_router
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
from routers.reinstatement import router as reinstatement_router
from routers.renewals import router as renewals_router
from routers.claim_workflow import router as claim_workflow_router
from routers.policy_exit import router as policy_exit_router
from routers.e_application import router as e_application_router
from routers.document_requests import router as document_requests_router
from routers.agent_confidential_report import router as agent_confidential_report_router
from routers.initial_premium_payment import router as initial_premium_payment_router
from routers.insurance_history import router as insurance_history_router
from routers.medical_exam import router as medical_exam_router
from routers.reinsurance import router as reinsurance_router
from routers.claims import router as claims_router
from routers.demo import router as demo_router
from routers.rules import router as rules_router, early_router as rules_early_router
from routers.search import router as search_router
from routers.commissions import router as commissions_router
from routers.commission_disbursements import router as commission_disbursements_router
from routers.request_management_internal import router as request_management_internal_router
from routers.customer_portal_internal import router as customer_portal_internal_router
from routers.customer_portal_family import router as customer_portal_family_router
from routers.customer_portal_walkin import router as customer_portal_walkin_router
from routers.walk_in_leads import router as walk_in_leads_router
# STAGE B — POST-ISSUANCE: renewal scheduler import disabled for now.
# from routers.renewal_scheduler import start_renewal_scheduler
from shared.models.core import Role

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")

# Audit trail: every significant business change is captured at ORM flush time into the transactional audit_outbox
# (same transaction as the change); the relay below publishes it to Kafka for the Audit Service.
install_capture()

# ── Standard RBAC roles seeded once at startup ────────────────────────────────

from role_seed import SEED_ROLES as _SEED_ROLES


async def _seed_roles(session: AsyncSession) -> None:
    """Create each built-in role once. A built-in a SuperAdmin later renamed or
    deleted stays that way — except SuperAdmin itself, which must always exist."""
    from shared.models.core import SystemRoleSeed

    for name, description in _SEED_ROLES:
        exists = (await session.exec(select(Role).where(Role.name == name))).first()
        already_seeded = await session.get(SystemRoleSeed, name) is not None
        if not exists and (not already_seeded or name == "SuperAdmin"):
            session.add(Role(name=name, description=description))
        if not already_seeded:
            session.add(SystemRoleSeed(name=name))
    await session.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await run_migrations()
    async with _session_factory() as session:
        await _seed_roles(session)
        try:
            from routers.rules import ensure_knockout_rule_set
            await ensure_knockout_rule_set(session)
        except Exception:
            logging.getLogger(__name__).exception("Could not seed the early-knockout rule set")
        try:
            from routers.rules import ensure_profile_risk_rule_set
            await ensure_profile_risk_rule_set(session)
        except Exception:
            logging.getLogger(__name__).exception("Could not seed the profile risk screening rule set")
        try:
            from routers.rules import ensure_payment_split_rule_set
            await ensure_payment_split_rule_set(session)
        except Exception:
            logging.getLogger(__name__).exception("Could not seed the initial-premium split rule set")
        try:
            from routers.rules import ensure_agent_commission_rule_set
            await ensure_agent_commission_rule_set(session)
        except Exception:
            logging.getLogger(__name__).exception("Could not seed the agent commission rule set")

    # Kafka producer — shared across all request handlers via app.state
    if os.getenv("EVAL_MOCK_EXTERNALS") == "1":
        # The evaluation stack has no broker (and no route to one). The stand-in refuses to exist outside an evaluation
        # process (shared/evaluation/safety.py), so this switch can never quietly drop events in a real deployment.
        from shared.evaluation.recording_producer import RecordingProducer
        producer = RecordingProducer()
    else:
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
    audit_relay_task = start_audit_relay(stop_event, producer)
    from shared.events.outbox import relay as business_outbox_relay
    business_relay_task = asyncio.create_task(business_outbox_relay(stop_event, _session_factory, producer))
    from shared.idempotency import maintenance as idempotency_maintenance
    from database import engine as _db_engine
    idempotency_task = asyncio.create_task(idempotency_maintenance.run(stop_event, _db_engine))

    # Group scheme renewals — daily job, opt-in (GROUP_RENEWAL_SCHEDULER=true).
    group_renewal_task = start_group_renewal_scheduler(stop_event, _session_factory)
    from services.policy_delivery import start_delivery_worker
    delivery_task = start_delivery_worker(stop_event, _session_factory)
    from services.lead_routing import start_sweeper
    walkin_task = start_sweeper(stop_event, _session_factory) if os.environ.get("WALKIN_SWEEP", "true").lower() == "true" else None

    # Evaluation data lake (MinIO): prepare the bucket and settle any dataset publication a restart interrupted.
    # Never blocks or fails startup; the lake is also prepared on first use.
    from services.eval_lake import warm_up_lake
    lake_task = asyncio.create_task(warm_up_lake())

    # ── STAGE B — POST-ISSUANCE LIFECYCLE (renewal scheduler) ──────────────────
    # Daily state machine (ACTIVE → GracePeriod → Lapsed + renewals). Runs AFTER
    # a policy is issued. Temporarily disabled for now — re-enable with the import
    # above when Stage B is back in scope.
    # renewal_task = start_renewal_scheduler(stop_event)
    # ───────────────────────────────────────────────────────────────────────────

    yield

    # Graceful shutdown
    lake_task.cancel()
    stop_event.set()
    await worker_task
    if audit_relay_task is not None:
        await audit_relay_task
    await delivery_task
    await business_relay_task
    await idempotency_task
    if walkin_task is not None:
        await walkin_task
    if group_renewal_task is not None:
        await group_renewal_task
    # await renewal_task  # STAGE B — disabled (see above)
    await producer.stop()


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="GetInsuredAI — Tenant Service",
    version="0.1.0",
    description="Manages insurance companies (tenants) and their employees (users). "
                "Every downstream microservice uses the tenant_id issued here.",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

_WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_TENANT_RESOURCE = re.compile(r"^/tenants/([0-9a-fA-F-]{36})/([A-Za-z][\w-]*)")


# Underwriting hold: a held case refuses every write (case_hold.py).
app.middleware("http")(refuse_writes_on_held_case)
# Pre-underwriting gates wait until both the Medical and Financial underwriters are assigned (underwriter_assignment.py).
from underwriter_assignment import refuse_gates_until_underwriters_assigned
app.middleware("http")(refuse_gates_until_underwriters_assigned)
from specialist_access import restrict_specialist_writes
app.middleware("http")(restrict_specialist_writes)


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


# Who is acting + the request's correlation id, for the audit events this request produces (services/audit_capture.py).
app.add_middleware(AuditContextMiddleware)

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
app.include_router(underwriting_tracks_router)
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
from routers.agent_config import router as agent_config_router
app.include_router(agent_config_router)
app.include_router(acquisition_sources_router)
app.include_router(roles_router)
app.include_router(agent_router)
app.include_router(policies_router)
app.include_router(pre_issuance_router)
app.include_router(post_issuance_router)
app.include_router(reinstatement_router)
app.include_router(renewals_router)
app.include_router(claim_workflow_router)
app.include_router(policy_exit_router)
from routers.underwriting_questionnaires import router as underwriting_questionnaires_router
app.include_router(underwriting_questionnaires_router)
app.include_router(e_application_router)
app.include_router(document_requests_router)
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
app.include_router(rules_early_router)
app.include_router(search_router)
app.include_router(commissions_router)
app.include_router(commission_disbursements_router)
app.include_router(request_management_internal_router)
app.include_router(customer_portal_internal_router)
app.include_router(customer_portal_family_router)
app.include_router(customer_portal_walkin_router)
app.include_router(walk_in_leads_router)


@app.get("/health", tags=["Ops"])
async def health_check():
    return {"service": "tenant-service", "status": "healthy"}


@app.get("/health/idempotency", tags=["Ops"])
async def idempotency_health():
    """Idempotency upkeep: records by status, attempts stuck past their lease, unknown outcomes awaiting a decision. No keys or business data."""
    from shared.idempotency import maintenance
    from database import engine
    return await maintenance.status(engine)


@app.get("/health/audit", tags=["Ops"])
async def audit_health():
    """Audit pipeline health: undelivered audit intents (outbox) and capture failures."""
    return await audit_status()


@app.get("/roles", tags=["Roles"])
async def list_roles():
    from database import get_session
    async for session in get_session():
        roles = list(await session.exec(select(Role)))
        return [{"id": str(r.id), "name": r.name, "description": r.description} for r in roles]

from routers.claim_financial_review import router as claim_financial_review_router
app.include_router(claim_financial_review_router)

from routers.eval_datasets import router as eval_datasets_router
app.include_router(eval_datasets_router)
from routers.eval_jobs import internal as eval_jobs_internal_router, router as eval_jobs_router
from routers.eval_drift import internal as eval_drift_internal_router, router as eval_drift_router
app.include_router(eval_drift_router)
from routers.eval_budget import router as eval_budget_router
app.include_router(eval_budget_router)
from routers.eval_costs import router as eval_costs_router
app.include_router(eval_costs_router)
from routers.eval_studio import router as eval_studio_router
app.include_router(eval_studio_router)
app.include_router(eval_drift_internal_router)
app.include_router(eval_jobs_router)
from routers.eval_models import benchmarks as eval_benchmarks_router, router as eval_models_router
from routers.eval_runs import benchmark_views as eval_benchmark_views_router, results as eval_results_router, runs as eval_runs_router
from routers.doc_templates import admin as doc_templates_admin_router, reader as doc_templates_reader_router
app.include_router(doc_templates_admin_router)
app.include_router(doc_templates_reader_router)
app.include_router(eval_runs_router)
app.include_router(eval_results_router)
app.include_router(eval_benchmark_views_router)   # before the benchmark routes: /eval/benchmarks/history must not be read as a benchmark id
app.include_router(eval_models_router)
app.include_router(eval_benchmarks_router)
app.include_router(eval_jobs_internal_router)   # the worker's side: shared secret, never proxied by the gateway

from routers.document_forgery import router as document_forgery_router
app.include_router(document_forgery_router)

from routers.document_intelligence import router as document_intelligence_router
app.include_router(document_intelligence_router)
