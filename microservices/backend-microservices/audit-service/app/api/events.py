"""Read-only audit event API. There is no create, update or delete route for audit records anywhere in this service:
events enter the ledger only through the Kafka consumer, and nothing can change them afterwards."""
from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import text

from app import db
from app.auth import Identity, current_identity, scope_for
from app.services import query_service
from app.services.query_service import PLATFORM, EventFilters

router = APIRouter(prefix="/v1", tags=["Audit events"])


@router.get("/events", summary="Search the audit trail (paginated, newest first)")
async def list_events(
    date_from: Optional[datetime] = Query(None, alias="from", description="Action time, inclusive"),
    date_to: Optional[datetime] = Query(None, alias="to", description="Action time, inclusive"),
    actor: Optional[str] = Query(None, max_length=200, description="Actor id (exact) or part of the actor's name"),
    module: Optional[str] = Query(None, max_length=48),
    action: Optional[str] = Query(None, max_length=96),
    entity_type: Optional[str] = Query(None, max_length=64),
    entity_id: Optional[str] = Query(None, max_length=128),
    case_id: Optional[str] = Query(None, max_length=128),
    correlation_id: Optional[str] = Query(None, max_length=128),
    outcome: Optional[str] = Query(None, pattern="^(SUCCESS|FAILURE|DENIED)$"),
    service_name: Optional[str] = Query(None, max_length=64),
    chain_id: Optional[str] = Query(None, max_length=128, description="One chain (with sequence: the exact event a verification flagged)"),
    sequence: Optional[int] = Query(None, ge=1),
    q: Optional[str] = Query(None, max_length=200, description="Free text over action, entity, actor, case and correlation id"),
    tenant: Optional[str] = Query(None, max_length=64, description="SuperAdmin only: a tenant id or 'platform'"),
    page: int = Query(1, ge=1, le=100_000),
    page_size: int = Query(25, ge=1, le=100),
    identity: Identity = Depends(current_identity),
):
    scope = scope_for(identity)
    if tenant:
        if tenant != PLATFORM:
            try:
                UUID(tenant)
            except ValueError:
                raise HTTPException(422, "tenant must be a tenant id or 'platform'")
        if not scope.unrestricted and tenant != str(identity.tenant_id):
            raise HTTPException(403, "You can only view your own tenant's audit trail.")
    filters = EventFilters(date_from=date_from, date_to=date_to, actor=actor, module=module, action=action, entity_type=entity_type,
                           entity_id=entity_id, case_id=case_id, correlation_id=correlation_id, outcome=outcome,
                           service_name=service_name, chain_id=chain_id, sequence=sequence, q=q, tenant=tenant)
    async with db.engine().connect() as conn:
        return await query_service.list_events(conn, filters, scope, page, page_size)


@router.get("/events/facets", summary="Values for the filter dropdowns")
async def event_facets(identity: Identity = Depends(current_identity)):
    async with db.engine().connect() as conn:
        return await query_service.facets(conn, scope_for(identity))


@router.get("/events/{event_id}", summary="One event with its hash-chain neighbours")
async def get_event(event_id: UUID, identity: Identity = Depends(current_identity)):
    async with db.engine().connect() as conn:
        event = await query_service.get_event(conn, event_id, scope_for(identity))
    if event is None:
        raise HTTPException(404, "Audit event not found")
    return event


@router.get("/chains/{chain_id}/sequence/{sequence}", summary="What survives about one sequence number (used when a verification reports it missing)")
async def get_sequence(chain_id: str, sequence: int = Path(ge=1), identity: Identity = Depends(current_identity)):
    async with db.engine().connect() as conn:
        found = await query_service.get_missing_event(conn, chain_id, sequence, scope_for(identity))
    if found is None:
        raise HTTPException(404, "Chain not found")
    found["archived"] = None
    if not found.get("present"):   # not "missing" if it moved to cold storage: say which signed archive holds it
        async with db.engine().connect() as conn:
            arch = (await conn.execute(text("""SELECT archive_id, archive_number, start_sequence, end_sequence FROM archive_catalog
                                               WHERE chain_id = :c AND start_sequence <= :s AND end_sequence >= :s"""), {"c": chain_id, "s": sequence})).first()
        if arch is not None:
            found["archived"] = {"archive_id": str(arch.archive_id), "archive_number": arch.archive_number,
                                 "start_sequence": arch.start_sequence, "end_sequence": arch.end_sequence}
    return found


@router.get("/chains", summary="The chains you can see, with head and latest verification")
async def list_chains(identity: Identity = Depends(current_identity)):
    async with db.engine().connect() as conn:
        return {"items": await query_service.list_chains(conn, scope_for(identity))}
