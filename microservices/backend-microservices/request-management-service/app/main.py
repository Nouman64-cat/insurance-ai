"""Request Management service. See README.md."""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError

from app import db, live, migrate, workers
from shared.audit.context import CorrelationContextMiddleware
from app.api.routes import router
from app.config import settings
from app.errors import ApiError, api_error_handler, validation_error_handler

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("request-management")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.run_migrations_on_start and settings.migration_database_url:
        applied = await migrate.run()
        log.info("migrations: %s", applied or "up to date")
    stop = asyncio.Event()
    tasks = workers.start(stop) if settings.workers_enabled else []
    try:
        yield
    finally:
        stop.set()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await live.hub.stop()
        await db.dispose()


app = FastAPI(title="Request Management", version="1.0.0", lifespan=lifespan,
              description="Requests, routing, review decisions and approved-action execution. Reached through the API gateway at /request-management.")
app.add_exception_handler(ApiError, api_error_handler)
app.add_exception_handler(RequestValidationError, validation_error_handler)
app.add_middleware(CorrelationContextMiddleware)   # X-Correlation-Id from the gateway, recorded on this request's audit events
app.include_router(router)
