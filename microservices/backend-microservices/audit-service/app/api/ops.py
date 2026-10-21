"""Health and pipeline status: is the ledger being fed, how far behind is the consumer, is anything stuck."""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import desc, func, select, text

from app import db
from app.auth import Identity, current_identity, scope_for
from app.models import chains, dead_letters, events, verification_runs
from app.services.hash_chain import format_timestamp

router = APIRouter(prefix="/v1", tags=["Operations"])


@router.get("/healthz", summary="Liveness and database reachability")
async def healthz(request: Request):
    async with db.engine().connect() as conn:
        await conn.execute(text("SELECT 1"))
    consumer = getattr(request.app.state, "consumer", None)
    return {"status": "ok", "consumer_running": bool(consumer and consumer.stats.running)}


@router.get("/ops/status", summary="Ledger and pipeline status")
async def ops_status(request: Request, identity: Identity = Depends(current_identity)):
    scope = scope_for(identity)
    consumer = getattr(request.app.state, "consumer", None)
    tenant_filter = [] if scope.unrestricted else [events.c.tenant_id == scope.tenant_id]
    async with db.engine().connect() as conn:
        total, last = (await conn.execute(
            select(func.count(), func.max(events.c.recorded_at)).select_from(events).where(*tenant_filter))).one()
        chain_stmt = select(chains.c.chain_id)
        if not scope.unrestricted:
            chain_stmt = chain_stmt.where(chains.c.tenant_id == scope.tenant_id)
        chain_ids = [r[0] for r in (await conn.execute(chain_stmt)).all()]
        invalid, unverified, last_run = 0, 0, None
        for chain_id in chain_ids:
            run = (await conn.execute(select(verification_runs.c.status, verification_runs.c.finished_at)
                                      .where(verification_runs.c.chain_id == chain_id)
                                      .order_by(desc(verification_runs.c.finished_at)).limit(1))).first()
            if run is None:
                unverified += 1
                continue
            invalid += run.status == "INVALID"
            last_run = max(last_run, run.finished_at) if last_run else run.finished_at
        out = {
            "ledger": {"events": total, "chains": len(chain_ids), "last_event_at": format_timestamp(last) if last else None},
            "verification": {"invalid_chains": invalid, "unverified_chains": unverified,
                             "last_run_at": format_timestamp(last_run) if last_run else None},
            "pipeline": {"consumer_running": bool(consumer and consumer.stats.running),
                         "total_lag": consumer.status()["total_lag"] if consumer else None},
        }
        if identity.is_super_admin:
            out["pipeline"] = consumer.status() if consumer else {"running": False}
            out["dead_letters"] = {"count": (await conn.execute(select(func.count()).select_from(dead_letters))).scalar_one()}
    return out


@router.get("/ops/dead-letters", summary="SuperAdmin: messages the ledger refused")
async def list_dead_letters(identity: Identity = Depends(current_identity), limit: int = 50):
    if not identity.is_super_admin:
        raise HTTPException(403, "Only the platform administrator can see dead letters.")
    async with db.engine().connect() as conn:
        rows = (await conn.execute(select(dead_letters).order_by(desc(dead_letters.c.id)).limit(max(1, min(limit, 200))))).all()
    return {"items": [{"id": r.id, "received_at": format_timestamp(r.received_at), "topic": r.topic, "partition": r.partition_id,
                       "offset": r.msg_offset, "error_code": r.error_code, "error_detail": r.error_detail} for r in rows]}
