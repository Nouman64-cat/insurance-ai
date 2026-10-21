"""Read-side queries for the dashboard: filtered, paginated events, one event with its chain neighbours, filter facets,
and the chains visible to the caller. Every query takes a Scope; a tenant administrator's scope is their own tenant's
chain only, so one tenant can never read another's records."""
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import and_, desc, func, or_, select
from sqlalchemy.sql.elements import ColumnElement

from app.models import chains, event_sources, events, verification_runs
from app import demo_tools
from app.services import source_recovery
from app.services.hash_chain import format_timestamp

PLATFORM = "platform"


@dataclass(frozen=True)
class Scope:
    """What a caller may see. tenant_id set: that tenant's chain only. unrestricted: every chain (SuperAdmin)."""
    tenant_id: Optional[UUID] = None
    unrestricted: bool = False


@dataclass
class EventFilters:
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    actor: Optional[str] = None
    module: Optional[str] = None
    action: Optional[str] = None
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    case_id: Optional[str] = None
    correlation_id: Optional[str] = None
    outcome: Optional[str] = None
    service_name: Optional[str] = None
    chain_id: Optional[str] = None
    sequence: Optional[int] = None
    q: Optional[str] = None
    tenant: Optional[str] = None      # a tenant id, or "platform" (SuperAdmin only; ignored for tenant scopes)


def _like(term: str) -> str:
    escaped = term.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
    return f"%{escaped}%"


def _clauses(filters: EventFilters, scope: Scope) -> list[ColumnElement]:
    clauses: list[ColumnElement] = []
    if not scope.unrestricted:
        clauses.append(events.c.tenant_id == scope.tenant_id)   # a None tenant matches nothing: NULL = NULL is not true
    elif filters.tenant:
        if filters.tenant == PLATFORM:
            clauses.append(events.c.tenant_id.is_(None))
        else:
            clauses.append(events.c.tenant_id == UUID(filters.tenant))
    if filters.date_from:
        clauses.append(events.c.occurred_at >= filters.date_from)
    if filters.date_to:
        clauses.append(events.c.occurred_at <= filters.date_to)
    if filters.actor:
        clauses.append(or_(events.c.actor_id == filters.actor,
                           events.c.metadata["actor_name"].astext.ilike(_like(filters.actor), escape="\\")))
    for column, value in ((events.c.module, filters.module), (events.c.action, filters.action),
                          (events.c.entity_type, filters.entity_type), (events.c.entity_id, filters.entity_id),
                          (events.c.case_id, filters.case_id), (events.c.correlation_id, filters.correlation_id),
                          (events.c.outcome, filters.outcome), (events.c.service_name, filters.service_name),
                          (events.c.chain_id, filters.chain_id)):
        if value:
            clauses.append(column == value)
    if filters.sequence is not None:
        clauses.append(events.c.sequence_number == filters.sequence)
    if filters.q:
        term = _like(filters.q)
        clauses.append(or_(*(c.ilike(term, escape="\\") for c in (
            events.c.action, events.c.entity_type, events.c.entity_id, events.c.actor_id, events.c.case_id,
            events.c.correlation_id, events.c.metadata["actor_name"].astext))))
    return clauses


def event_to_api(row: Any) -> dict:
    data = dict(row._mapping) if hasattr(row, "_mapping") else dict(row)
    out = {
        "event_id": str(data["event_id"]), "tenant_id": str(data["tenant_id"]) if data["tenant_id"] else None,
        "environment_id": str(data["environment_id"]), "chain_id": data["chain_id"],
        "sequence_number": data["sequence_number"],
        "timestamp": format_timestamp(data["occurred_at"]), "recorded_at": format_timestamp(data["recorded_at"]),
        "actor_id": data["actor_id"], "actor_type": data["actor_type"], "actor_role": data["actor_role"],
        "actor_name": (data["metadata"] or {}).get("actor_name"),
        "service_name": data["service_name"], "module": data["module"], "action": data["action"],
        "entity_type": data["entity_type"], "entity_id": data["entity_id"], "case_id": data["case_id"],
        "correlation_id": data["correlation_id"], "source_event_id": data["source_event_id"],
        "previous_value": data["previous_value"], "new_value": data["new_value"], "outcome": data["outcome"],
        "metadata": data["metadata"], "previous_hash": data["previous_hash"], "current_hash": data["current_hash"],
        "hash_version": data["hash_version"],
    }
    return out


async def list_events(conn, filters: EventFilters, scope: Scope, page: int = 1, page_size: int = 25) -> dict:
    where = and_(*_clauses(filters, scope)) if _clauses(filters, scope) else None
    base = select(events)
    count = select(func.count()).select_from(events)
    if where is not None:
        base, count = base.where(where), count.where(where)
    total = (await conn.execute(count)).scalar_one()
    rows = (await conn.execute(
        base.order_by(desc(events.c.recorded_at), desc(events.c.sequence_number)).limit(page_size).offset((page - 1) * page_size))).all()
    return {"items": [event_to_api(r) for r in rows], "total": total, "page": page, "page_size": page_size}


async def get_event(conn, event_id: UUID, scope: Scope) -> Optional[dict]:
    """One event, with its immediate neighbours in the chain (for the hash-link view)."""
    clauses = [events.c.event_id == event_id]
    if not scope.unrestricted:
        clauses.append(events.c.tenant_id == scope.tenant_id)
    row = (await conn.execute(select(events).where(and_(*clauses)))).first()
    if row is None:
        return None
    out = event_to_api(row)
    for label, sequence in (("previous_event", row.sequence_number - 1), ("next_event", row.sequence_number + 1)):
        neighbour = (await conn.execute(
            select(events.c.event_id, events.c.sequence_number, events.c.current_hash, events.c.previous_hash, events.c.action)
            .where(events.c.chain_id == row.chain_id, events.c.sequence_number == sequence))).first()
        out[label] = None if neighbour is None else {
            "event_id": str(neighbour.event_id), "sequence_number": neighbour.sequence_number,
            "current_hash": neighbour.current_hash, "previous_hash": neighbour.previous_hash, "action": neighbour.action}
    return out


async def get_missing_event(conn, chain_id: str, sequence: int, scope: Scope, recover: bool = True) -> Optional[dict]:
    """What the database still knows about a sequence number a verification flagged as missing.

    The event row itself is gone; its original source message may still be recoverable from Kafka. Three independent
    records survive: the idempotency index (event id, source service and source id, time, hash), and the neighbours on
    either side, whose previous_hash must equal the missing event's hash. If those agree, the gap is a deletion of
    exactly that event, not a corrupted link."""
    chain = (await conn.execute(select(chains.c.chain_id, chains.c.tenant_id, chains.c.environment_id, chains.c.genesis_hash)
                                .where(chains.c.chain_id == chain_id))).first()
    if chain is None or (not scope.unrestricted and (scope.tenant_id is None or chain.tenant_id != scope.tenant_id)):
        return None

    present = (await conn.execute(
        select(events.c.event_id).where(events.c.chain_id == chain_id, events.c.sequence_number == sequence))).first()
    source = (await conn.execute(
        select(event_sources).where(event_sources.c.chain_id == chain_id, event_sources.c.sequence_number == sequence))).first()

    async def neighbour(seq: int) -> Optional[dict]:
        row = (await conn.execute(
            select(events.c.event_id, events.c.sequence_number, events.c.current_hash, events.c.previous_hash, events.c.action)
            .where(events.c.chain_id == chain_id, events.c.sequence_number == seq))).first()
        return None if row is None else {
            "event_id": str(row.event_id), "sequence_number": row.sequence_number, "current_hash": row.current_hash,
            "previous_hash": row.previous_hash, "action": row.action}

    previous_event, next_event = await neighbour(sequence - 1), await neighbour(sequence + 1)
    recorded = None if source is None else {
        "event_id": str(source.event_id), "service_name": source.service_name, "source_event_id": source.source_event_id,
        "recorded_at": format_timestamp(source.recorded_at), "current_hash": source.current_hash}
    expected_hash = next_event["previous_hash"] if next_event else None
    out = {
        "chain_id": chain_id, "sequence_number": sequence,
        "present": present is not None, "event_id": str(present.event_id) if present else None,
        "recorded": recorded, "expected_hash": expected_hash,
        "hash_confirmed": bool(recorded and expected_hash and recorded["current_hash"] == expected_hash),
        "previous_event": previous_event, "next_event": next_event,
        "recovered": None,
    }
    if recover and present is None:
        parked = await demo_tools.bin_entry(chain_id, sequence)   # demo mode only: the exact row, no broker needed
        if parked:
            out["recovered"] = {"event": parked["event"], "source": "recycle_bin", "partition": None, "offset": None,
                                "hash_verified": parked["hash_verified"]}
    if recover and present is None and out["recovered"] is None and source is not None and (previous_event or sequence == 1):
        found = await source_recovery.recover(
            source_service=source.service_name, source_event_id=source.source_event_id, recorded_at=source.recorded_at,
            event_id=source.event_id, environment_id=chain.environment_id, chain_id=chain_id, sequence=sequence,
            previous_hash=previous_event["current_hash"] if previous_event else chain.genesis_hash)
        if found and found["record"]["tenant_id"] == chain.tenant_id:
            record = found["record"]
            # The proof: the hash recomputed from the recovered fields is the hash the ledger recorded for this sequence.
            out["recovered"] = {
                "event": event_to_api(record), "source": "kafka", "partition": found["partition"], "offset": found["offset"],
                "hash_verified": record["current_hash"] == source.current_hash,
            }
    return out


async def facets(conn, scope: Scope) -> dict:
    """Distinct values for the filter dropdowns (bounded)."""
    where = [] if scope.unrestricted else [events.c.tenant_id == scope.tenant_id]

    async def distinct(column, limit=200):
        stmt = select(column).where(column.is_not(None), *where).distinct().order_by(column).limit(limit)
        return [r[0] for r in (await conn.execute(stmt)).all()]

    return {
        "modules": await distinct(events.c.module), "actions": await distinct(events.c.action),
        "entity_types": await distinct(events.c.entity_type), "outcomes": await distinct(events.c.outcome),
        "services": await distinct(events.c.service_name),
    }


def run_to_api(row: Any) -> dict:
    data = dict(row._mapping)
    return {
        "run_id": str(data["run_id"]), "chain_id": data["chain_id"], "tenant_id": str(data["tenant_id"]) if data["tenant_id"] else None,
        "trigger": data["trigger"], "requested_by": data["requested_by"],
        "started_at": format_timestamp(data["started_at"]), "finished_at": format_timestamp(data["finished_at"]),
        "duration_ms": data["duration_ms"], "status": data["status"], "from_sequence": data["from_sequence"],
        "to_sequence": data["to_sequence"], "head_sequence": data["head_sequence"],
        "total_events_checked": data["total_events_checked"], "first_invalid_sequence": data["first_invalid_sequence"],
        "reason": data["reason"], "details": data["details"], "head_checked": data["head_checked"],
    }


async def list_chains(conn, scope: Scope) -> list[dict]:
    """The chains the caller may see, each with its head and its most recent verification run."""
    stmt = select(chains).order_by(chains.c.scope.desc(), chains.c.created_at)
    if not scope.unrestricted:
        stmt = stmt.where(chains.c.tenant_id == scope.tenant_id)
    out = []
    for chain in (await conn.execute(stmt)).all():
        run = (await conn.execute(
            select(verification_runs).where(verification_runs.c.chain_id == chain.chain_id)
            .order_by(desc(verification_runs.c.finished_at)).limit(1))).first()
        out.append({
            "chain_id": chain.chain_id, "scope": chain.scope, "tenant_id": str(chain.tenant_id) if chain.tenant_id else None,
            "environment_id": str(chain.environment_id), "genesis_hash": chain.genesis_hash,
            "head_sequence": chain.head_sequence, "head_hash": chain.head_hash,
            "updated_at": format_timestamp(chain.updated_at),
            "last_verification": run_to_api(run) if run else None,
        })
    return out


async def list_runs(conn, scope: Scope, chain_id: Optional[str] = None, limit: int = 20) -> list[dict]:
    stmt = select(verification_runs).order_by(desc(verification_runs.c.finished_at)).limit(limit)
    if not scope.unrestricted:
        stmt = stmt.where(verification_runs.c.tenant_id == scope.tenant_id)
    if chain_id:
        stmt = stmt.where(verification_runs.c.chain_id == chain_id)
    return [run_to_api(r) for r in (await conn.execute(stmt)).all()]
