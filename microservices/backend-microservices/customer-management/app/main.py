"""Customer Management service. See README.md."""
import asyncio
import json
import logging
import sys
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError

from app import db, migrate
from app.config import settings
from app.errors import ApiError, api_error_handler, unhandled_error_handler, validation_error_handler
from app.routers import auth, family, health, internal, live, portal, support, walk_in
from shared.audit.context import CorrelationContextMiddleware
from shared.audit.outbox import KafkaPublisher as AuditPublisher, OutboxRelay


class JsonFormatter(logging.Formatter):
    """One JSON object per line. Messages are written by this code and never carry credentials or personal data."""
    def format(self, record: logging.LogRecord) -> str:
        out = {"ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"), "level": record.levelname, "logger": record.name, "msg": record.getMessage()}
        for k in ("request_id", "method", "path", "status", "ms", "account_id"):
            if hasattr(record, k):
                out[k] = getattr(record, k)
        if record.exc_info:
            out["exc"] = record.exc_info[0].__name__ if record.exc_info[0] else None
        return json.dumps(out)


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)  # its request lines carry document handles in the query string
    logging.getLogger("uvicorn.access").disabled = True  # replaced by the request log below (no query strings)


configure_logging()
log = logging.getLogger("customer-management")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not settings.jwt_secret or len(settings.jwt_secret) < 32:
        raise RuntimeError("CM_JWT_SECRET must be set (32+ characters)")
    if settings.run_migrations_on_start and settings.migration_database_url:
        applied = await migrate.run()
        log.info("migrations: %s", applied or "up to date")
    stop = asyncio.Event()
    relay_task = None
    if settings.audit_enabled:   # publishes committed audit intents to Kafka for the Audit Service (shared/audit/outbox.py)
        app.state.audit_relay = OutboxRelay(db.transaction, AuditPublisher(settings.kafka_bootstrap), name="customer-management audit")
        relay_task = asyncio.create_task(app.state.audit_relay.run(stop), name="audit-outbox-relay")
    try:
        yield
    finally:
        stop.set()
        if relay_task is not None:
            relay_task.cancel()
            await asyncio.gather(relay_task, return_exceptions=True)
        await db.dispose()


app = FastAPI(title="Customer Management", version="1.0.0", lifespan=lifespan,
              description="Customer portal back end for individual policyholders. Reached through the API gateway at /customer-management/v1.")
app.add_middleware(CorrelationContextMiddleware)   # X-Correlation-Id from the gateway, recorded on audit events
app.add_exception_handler(ApiError, api_error_handler)
app.add_exception_handler(RequestValidationError, validation_error_handler)
app.add_exception_handler(Exception, unhandled_error_handler)


@app.middleware("http")
async def request_log(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
    started = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    # path only: query strings can carry document handles, never logged
    log.info("request", extra={"request_id": request_id, "method": request.method, "path": request.url.path, "status": response.status_code,
                               "ms": round((time.perf_counter() - started) * 1000, 1), "account_id": getattr(request.state, "account_id", None)})
    return response


app.include_router(health.router)
app.include_router(auth.router)
app.include_router(portal.router)
app.include_router(support.router)
app.include_router(live.router)
app.include_router(family.router)
app.include_router(walk_in.router)
app.include_router(internal.router)
