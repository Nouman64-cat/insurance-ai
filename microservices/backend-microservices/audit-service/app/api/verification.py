"""On-demand chain verification (the scheduled run lives in services/chain_verifier.scheduler)."""
import asyncio
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from app import db
from app.auth import Identity, current_identity, scope_for
from app.models import chains
from app.schemas import VerificationRequest
from app.services import chain_verifier, query_service

router = APIRouter(prefix="/v1/verification", tags=["Verification"])

# One verification per chain at a time: it reads the whole chain, so repeated clicks must not pile up.
_running: dict[str, asyncio.Lock] = {}


async def _resolve_chain(body: VerificationRequest, identity: Identity) -> str:
    async with db.engine().connect() as conn:
        if not identity.is_super_admin:
            row = (await conn.execute(select(chains.c.chain_id).where(chains.c.tenant_id == identity.tenant_id))).first()
            if row is None or (body.chain_id and body.chain_id != row.chain_id):
                raise HTTPException(404, "No audit chain found for your tenant yet.")
            return row.chain_id
        if body.chain_id:
            stmt = select(chains.c.chain_id).where(chains.c.chain_id == body.chain_id)
        elif body.tenant_id == query_service.PLATFORM:
            stmt = select(chains.c.chain_id).where(chains.c.tenant_id.is_(None))
        elif body.tenant_id:
            try:
                stmt = select(chains.c.chain_id).where(chains.c.tenant_id == UUID(body.tenant_id))
            except ValueError:
                raise HTTPException(422, "tenant_id must be a tenant id or 'platform'")
        else:
            raise HTTPException(422, "Name a chain_id or a tenant_id (or 'platform').")
        row = (await conn.execute(stmt)).first()
        if row is None:
            raise HTTPException(404, "Audit chain not found.")
        return row.chain_id


async def _verify(chain_id: str, body: VerificationRequest, identity: Identity):
    lock = _running.setdefault(chain_id, asyncio.Lock())
    if lock.locked():
        raise HTTPException(409, "A verification of this chain is already running.")
    async with lock:
        try:
            result = await chain_verifier.verify_chain(
                chain_id, from_sequence=body.from_sequence, to_sequence=body.to_sequence,
                trusted_previous_hash=body.trusted_previous_hash)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        run_id = await chain_verifier.record_run(result, "ON_DEMAND", identity.requester)
    return {**result.to_api(), "run_id": str(run_id) if run_id else None}


@router.post("/run", summary="Verify a chain (or a bounded range of it) now")
async def run_verification(body: VerificationRequest, identity: Identity = Depends(current_identity)):
    chain_id = await _resolve_chain(body, identity)
    return await _verify(chain_id, body, identity)


@router.post("/run-all", summary="SuperAdmin: verify every chain now")
async def run_all(identity: Identity = Depends(current_identity)):
    if not identity.is_super_admin:
        raise HTTPException(403, "Only the platform administrator can verify every chain.")
    async with db.engine().connect() as conn:
        chain_ids = [r[0] for r in (await conn.execute(select(chains.c.chain_id).order_by(chains.c.created_at))).all()]
    return {"results": [await _verify(c, VerificationRequest(), identity) for c in chain_ids]}


@router.get("/runs", summary="Verification history")
async def list_runs(chain_id: Optional[str] = Query(None, max_length=128), limit: int = Query(20, ge=1, le=100),
                    identity: Identity = Depends(current_identity)):
    async with db.engine().connect() as conn:
        return {"items": await query_service.list_runs(conn, scope_for(identity), chain_id, limit)}
