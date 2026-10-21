"""DEMO-ONLY tamper tools: delete a ledger event and restore it, so the hash chain and signed checkpoints can be seen
catching it. Everything here is inert unless ENV_VAR=demo; the routes are not even mounted otherwise (app/main.py).

Why this needs its own database connection: the ledger's append-only triggers reject UPDATE/DELETE for every role, and the
service's normal role has no DELETE right at all. A deletion is only possible as the schema owner, with the table's
triggers switched off for the length of one transaction. That is exactly the "someone with database access" attack the
verifier exists to detect, so this module is the one place the service ever acts as that attacker, on purpose.

A deleted event is not lost: its complete row is parked in audit.recycle_bin (created on first use, never by a
migration, so a production schema never has it) and put back byte-for-byte on restore. Nothing else is touched: the
chain head, event_sources (the idempotency index) and the signed checkpoints stay as they were, which is why the
verifiers notice."""
import logging
import os
from typing import Optional
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.config import settings
from shared.audit import hashing

log = logging.getLogger("audit.demo")

_engine: Optional[AsyncEngine] = None
_ready = False

_DDL = """
CREATE TABLE IF NOT EXISTS recycle_bin (
    bin_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL,
    chain_id        TEXT NOT NULL,
    sequence_number BIGINT NOT NULL,
    doc             JSONB NOT NULL,
    deleted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_by      TEXT,
    restored_at     TIMESTAMPTZ,
    restored_by     TEXT
)"""


class DemoError(Exception):
    """A refusal with a message safe to show the user."""


def enabled() -> bool:
    return os.environ.get("ENV_VAR", "").strip().lower() == "demo"


def _owner_engine() -> AsyncEngine:
    global _engine
    if not enabled():
        raise DemoError("Demo tools are disabled.")
    if not settings.migration_database_url:
        raise DemoError("Demo tools need AUDIT_MIGRATION_DATABASE_URL (the schema owner) to be set.")
    if _engine is None:
        _engine = create_async_engine(settings.migration_database_url, pool_size=2, max_overflow=0, pool_pre_ping=True,
                                      connect_args={"server_settings": {"search_path": settings.schema,
                                                                        "application_name": "audit-service-demo"}})
    return _engine


async def _conn_ready(conn) -> None:
    global _ready
    if not _ready:
        await conn.execute(text(_DDL))
        _ready = True


async def prepare() -> None:
    """Create the recycle bin table at startup (demo mode only), so it exists before anyone opens the bin."""
    if not enabled():
        return
    async with _owner_engine().begin() as conn:
        await _conn_ready(conn)


async def dispose() -> None:
    global _engine, _ready
    if _engine is not None:
        await _engine.dispose()
    _engine, _ready = None, False


async def delete_event(event_id: UUID, *, chain_scope: Optional[UUID], unrestricted: bool, actor: str) -> dict:
    """Move one event into the recycle bin and remove it from the ledger."""
    async with _owner_engine().begin() as conn:
        await _conn_ready(conn)
        row = (await conn.execute(
            text("SELECT chain_id, tenant_id, sequence_number FROM events WHERE event_id = :id"), {"id": event_id})).first()
        if row is None:
            raise DemoError("That event no longer exists.")
        if not unrestricted and (chain_scope is None or row.tenant_id != chain_scope):
            raise DemoError("You can only delete events from your own tenant's chain.")
        await conn.execute(text("ALTER TABLE events DISABLE TRIGGER events_immutable"))
        await conn.execute(text(
            "INSERT INTO recycle_bin (event_id, chain_id, sequence_number, doc, deleted_by) "
            "SELECT event_id, chain_id, sequence_number, to_jsonb(e), :by FROM events e WHERE event_id = :id"),
            {"id": event_id, "by": actor})
        deleted = (await conn.execute(text("DELETE FROM events WHERE event_id = :id"), {"id": event_id})).rowcount
        await conn.execute(text("ALTER TABLE events ENABLE TRIGGER events_immutable"))
        if deleted != 1:
            raise DemoError("The event could not be deleted.")
    log.warning("DEMO: event #%s of chain %s deleted by %s", row.sequence_number, row.chain_id, actor)
    return {"chain_id": row.chain_id, "sequence_number": row.sequence_number}


async def restore_event(bin_id: UUID, *, chain_scope: Optional[UUID], unrestricted: bool, actor: str) -> dict:
    """Put a recycled event back exactly where it was (same sequence, same hashes)."""
    async with _owner_engine().begin() as conn:
        await _conn_ready(conn)
        entry = (await conn.execute(
            text("SELECT b.chain_id, b.sequence_number, b.event_id, (b.doc->>'tenant_id') AS tenant_id, b.restored_at "
                 "FROM recycle_bin b WHERE b.bin_id = :id FOR UPDATE"), {"id": bin_id})).first()
        if entry is None or entry.restored_at is not None:
            raise DemoError("That event is not in the recycle bin.")
        if not unrestricted and (chain_scope is None or entry.tenant_id != str(chain_scope)):
            raise DemoError("You can only restore events from your own tenant's chain.")
        clash = (await conn.execute(
            text("SELECT 1 FROM events WHERE chain_id = :c AND sequence_number = :s"),
            {"c": entry.chain_id, "s": entry.sequence_number})).first()
        if clash:
            raise DemoError("An event already exists at that sequence number.")
        # The insert trigger only accepts head+1; a restored event is by definition behind the head.
        await conn.execute(text("ALTER TABLE events DISABLE TRIGGER events_insert"))
        await conn.execute(text(
            "INSERT INTO events SELECT r.* FROM recycle_bin b, LATERAL jsonb_populate_record(NULL::events, b.doc) r "
            "WHERE b.bin_id = :id"), {"id": bin_id})
        await conn.execute(text("ALTER TABLE events ENABLE TRIGGER events_insert"))
        await conn.execute(text("UPDATE recycle_bin SET restored_at = now(), restored_by = :by WHERE bin_id = :id"),
                           {"id": bin_id, "by": actor})
    log.warning("DEMO: event #%s of chain %s restored by %s", entry.sequence_number, entry.chain_id, actor)
    return {"chain_id": entry.chain_id, "sequence_number": entry.sequence_number}


async def list_bin(*, chain_scope: Optional[UUID], unrestricted: bool) -> list[dict]:
    """Deleted events (newest deletion first), each with the full original row."""
    from app.services.query_service import event_to_api
    async with _owner_engine().begin() as conn:
        await _conn_ready(conn)
        rows = (await conn.execute(text(
            "SELECT b.bin_id, b.deleted_at, b.deleted_by, r.* FROM recycle_bin b, "
            "LATERAL jsonb_populate_record(NULL::events, b.doc) r WHERE b.restored_at IS NULL "
            "AND (:all OR r.tenant_id = :tenant) ORDER BY b.deleted_at DESC"),
            {"all": unrestricted, "tenant": chain_scope})).all()
    return [{"bin_id": str(r.bin_id), "deleted_at": hashing.format_timestamp(r.deleted_at), "deleted_by": r.deleted_by,
             "event": event_to_api(r)} for r in rows]


async def bin_entry(chain_id: str, sequence: int) -> Optional[dict]:
    """The recycled event for this sequence number, if the demo bin holds one: the full row and whether it still hashes
    to the value it was recorded with. None when demo mode is off or nothing is parked there."""
    if not enabled():
        return None
    from app.services.query_service import event_to_api
    try:
        async with _owner_engine().begin() as conn:
            await _conn_ready(conn)
            row = (await conn.execute(text(
                "SELECT b.bin_id, b.deleted_at, r.* FROM recycle_bin b, LATERAL jsonb_populate_record(NULL::events, b.doc) r "
                "WHERE b.chain_id = :c AND b.sequence_number = :s AND b.restored_at IS NULL "
                "ORDER BY b.deleted_at DESC LIMIT 1"), {"c": chain_id, "s": sequence})).first()
    except Exception as exc:   # an optional lookup must never break the page
        log.warning("recycle bin lookup failed: %s", exc)
        return None
    if row is None:
        return None
    record = dict(row._mapping)
    recomputed = hashing.compute_event_hash(record["chain_id"], record["sequence_number"], record["previous_hash"], record,
                                            record["hash_version"])
    return {"bin_id": str(row.bin_id), "event": event_to_api(row), "hash_verified": recomputed == record["current_hash"]}
