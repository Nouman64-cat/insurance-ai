"""Audit Service: the centralized, tenant-isolated, SHA-256 hash-chained audit ledger.

Public API (via the gateway): /audit/v1/...   Direct (dev): http://localhost:8030/v1/healthz

Events arrive only through Kafka (insurance.audit.events.v1) from the services' transactional outboxes. This service
assigns the authoritative sequence and hashes when it commits them. The HTTP API is read-only plus chain verification.
"""
import asyncio
import logging
import socket
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import db, demo_tools, migrate
from app.api import archive as archive_api, checkpoints, demo as demo_api, events, ops, verification
from app.archive import configuration as archive_configuration
from app.archive.configuration import RuntimeArchive
from app.archive.scheduler import ArchiveScheduler
from app.checkpoints.generator import CheckpointGenerator
from app.checkpoints.scheduler import CheckpointScheduler
from app.signing.signer_factory import get_signer
from app.config import settings
from app.consumers.kafka_consumer import AuditConsumer
from app.services import chain_verifier
from app.verification import integrity_verifier

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("audit.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.run_migrations_on_start and settings.migration_database_url:
        applied = await migrate.run()
        log.info("migrations applied: %s", applied or "none (up to date)")
    try:
        await demo_tools.prepare()
    except Exception as exc:   # demo tools are optional; the ledger must start regardless
        log.error("demo tools unavailable: %s", exc)
    stop = asyncio.Event()
    tasks: list[asyncio.Task] = []
    app.state.consumer = None
    if settings.consumer_enabled:
        consumer = AuditConsumer(settings.kafka_bootstrap, settings.consumer_group, batch=settings.consumer_batch)
        app.state.consumer = consumer
        tasks.append(asyncio.create_task(consumer.run(stop), name="audit-consumer"))
    if settings.verify_enabled:
        tasks.append(asyncio.create_task(chain_verifier.scheduler(stop), name="audit-verifier"))
    app.state.signer = app.state.generator = None
    signer = get_signer(settings)   # None when AUDIT_SIGNING_ENABLED=false; the ledger itself runs either way
    if signer is not None:
        instance_id = f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"
        app.state.signer = signer
        app.state.generator = CheckpointGenerator(signer, instance_id)
        tasks.append(asyncio.create_task(CheckpointScheduler(app.state.generator).run(stop), name="audit-checkpoints"))
        if settings.verify_enabled:
            tasks.append(asyncio.create_task(integrity_verifier.scheduler(stop), name="audit-anchored-verifier"))
    app.state.archive = app.state.archive_runtime = None
    await archive_configuration.initialize(settings)
    if signer is not None:
        try:
            runtime = RuntimeArchive(settings, signer, f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}")
            _, effective, services = await runtime.snapshot()
            app.state.archive, app.state.archive_runtime = services, runtime
            tasks.append(asyncio.create_task(ArchiveScheduler(services, config=effective, runtime=runtime).run(stop), name="audit-archive"))
        except Exception as exc:   # archiving is optional infrastructure: the ledger, checkpoints and verification keep running without it
            log.error("archiving is DISABLED: %s", exc)
    yield
    stop.set()
    await asyncio.gather(*tasks, return_exceptions=True)
    await db.dispose()
    await demo_tools.dispose()


app = FastAPI(
    title="GetInsuredAI — Audit Service",
    version="1.0.0",
    description="Append-only, SHA-256 hash-chained audit ledger. Read-only API plus chain verification.",
    lifespan=lifespan,
)
app.include_router(events.router)
app.include_router(verification.router)
app.include_router(ops.router)
app.include_router(checkpoints.router)
app.include_router(archive_api.router)
app.include_router(demo_api.status_router)
if demo_tools.enabled():   # DEMO ONLY: the delete/restore routes do not exist in any other environment
    app.include_router(demo_api.router)
