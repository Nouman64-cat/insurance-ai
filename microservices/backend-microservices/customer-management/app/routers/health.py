from fastapi import APIRouter
from sqlalchemy import text

from app import db
from app.errors import ApiError

router = APIRouter(tags=["Health"])


@router.get("/v1/healthz")
async def healthz():
    """Liveness: the process is up. Does not touch dependencies."""
    return {"status": "ok", "service": "customer-management"}


@router.get("/v1/readyz")
async def readyz():
    """Readiness: the database answers and the schema is migrated."""
    try:
        async with db.engine().connect() as conn:
            await conn.execute(text("SELECT 1"))
            ok = (await conn.execute(text("SELECT count(*) FROM accounts"))).scalar_one() >= 0
    except Exception as exc:  # noqa: BLE001 - reported, never leaked
        raise ApiError(503, "NOT_READY", "The service is not ready") from exc
    return {"status": "ready" if ok else "starting", "database": "ok"}
