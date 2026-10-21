"""Appending events to the ledger.

The Audit Service, not Kafka, decides ledger order. An append is one database transaction per chain:

  1. ensure_chain(tenant)   create the tenant's (or the platform) chain on first use;
  2. lock_chain(chain)      take the chain row's lock: concurrent appenders for the same chain queue here;
  3. deduplicate            an intent whose (service, source_event_id) is already in the ledger is not written again;
  4. chain                  each new event gets sequence head+1.. and previous_hash = the head's hash, and its own
                            SHA-256 over the canonical event (hash_chain.compute_event_hash);
  5. insert                 the database triggers re-check sequence, previous hash, tenant and environment, and advance
                            the chain head in the same transaction.

Sequence numbers are derived from the locked head, not from a database sequence, so a rolled-back append leaves no
gap; a crash, a retry, a redelivery or two consumers racing can neither duplicate nor skip a number.
"""
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Optional, Sequence
from uuid import UUID, uuid4

from sqlalchemy import select, text, tuple_

from app import db
from app.models import event_sources, events
from app.services import hash_chain
from shared.audit.schema import AuditIntent

log = logging.getLogger("audit.service")

APPENDED = "APPENDED"
DUPLICATE = "DUPLICATE"
REJECTED = "REJECTED"


@dataclass
class AppendResult:
    status: str                       # APPENDED | DUPLICATE | REJECTED
    source_event_id: str
    event_id: Optional[UUID] = None
    chain_id: Optional[str] = None
    sequence_number: Optional[int] = None
    current_hash: Optional[str] = None
    error_code: Optional[str] = None
    error_detail: Optional[str] = None


async def environment_id(conn) -> UUID:
    return (await conn.execute(text("SELECT environment_id FROM environment"))).scalar_one()


def _record(intent: AuditIntent, *, env: UUID, chain_id: str, sequence: int, previous_hash: str, recorded_at: datetime) -> dict:
    record = {
        "event_id": uuid4(), "chain_id": chain_id, "sequence_number": sequence,
        "tenant_id": intent.tenant_id, "environment_id": env,
        "occurred_at": intent.occurred_at, "recorded_at": recorded_at,
        "actor_id": intent.actor_id, "actor_type": intent.actor_type, "actor_role": intent.actor_role,
        "service_name": intent.source_service, "module": intent.module, "action": intent.action,
        "entity_type": intent.entity_type, "entity_id": intent.entity_id, "case_id": intent.case_id,
        "correlation_id": intent.correlation_id, "source_event_id": intent.source_event_id,
        "previous_value": intent.previous_value, "new_value": intent.new_value,
        "outcome": intent.outcome, "metadata": intent.metadata,
        "previous_hash": previous_hash, "hash_version": hash_chain.HASH_VERSION,
    }
    record["current_hash"] = hash_chain.compute_event_hash(chain_id, sequence, previous_hash, record, hash_chain.HASH_VERSION)
    return record


async def append_to_chain(conn, intents: Sequence[AuditIntent], clock: Optional[Callable[[], datetime]] = None) -> list[AppendResult]:
    """Append intents that all belong to ONE chain (same tenant). Runs in the caller's transaction, which must be
    committed or rolled back as a whole. Results are in input order. `clock` is only for tests (aged events)."""
    clock = clock or (lambda: datetime.now(timezone.utc))
    if not intents:
        return []
    tenant_id = intents[0].tenant_id
    if any(i.tenant_id != tenant_id for i in intents):
        raise ValueError("append_to_chain: all intents must belong to the same chain")
    env = await environment_id(conn)
    chain_id = (await conn.execute(text("SELECT ensure_chain(CAST(:t AS uuid))"), {"t": tenant_id})).scalar_one()
    head = (await conn.execute(text("SELECT head_sequence, head_hash FROM lock_chain(:c)"), {"c": chain_id})).mappings().one()
    sequence, previous_hash = int(head["head_sequence"]), head["head_hash"]

    keys = {(i.source_service, i.source_event_id) for i in intents}
    found = {
        (row.service_name, row.source_event_id): row
        for row in (await conn.execute(
            select(event_sources.c.event_id, event_sources.c.chain_id, event_sources.c.sequence_number, event_sources.c.current_hash,
                   event_sources.c.service_name, event_sources.c.source_event_id)
            .where(tuple_(event_sources.c.service_name, event_sources.c.source_event_id).in_(list(keys))))).all()
    }

    results: list[AppendResult] = []
    rows: list[dict] = []
    pending: dict[tuple[str, str], AppendResult] = {}
    for intent in intents:
        key = (intent.source_service, intent.source_event_id)
        prior = found.get(key)
        if prior is not None:
            if prior.chain_id != chain_id:
                results.append(AppendResult(REJECTED, intent.source_event_id, error_code="SOURCE_EVENT_ID_REUSED",
                                            error_detail=f"already recorded in chain {prior.chain_id}"))
            else:
                results.append(AppendResult(DUPLICATE, intent.source_event_id, prior.event_id, chain_id, prior.sequence_number, prior.current_hash))
            continue
        if key in pending:  # the same intent twice in one batch
            first = pending[key]
            results.append(AppendResult(DUPLICATE, intent.source_event_id, first.event_id, chain_id, first.sequence_number, first.current_hash))
            continue
        sequence += 1
        record = _record(intent, env=env, chain_id=chain_id, sequence=sequence, previous_hash=previous_hash,
                         recorded_at=clock())
        previous_hash = record["current_hash"]
        rows.append(record)
        result = AppendResult(APPENDED, intent.source_event_id, record["event_id"], chain_id, sequence, record["current_hash"])
        pending[key] = result
        results.append(result)

    if rows:
        await conn.execute(events.insert(), rows)
    return results


_partitions_ready: set[tuple[str, str]] = set()


async def ensure_partition(at: datetime) -> None:
    """Make sure the monthly partition for `at` exists. Done in its own short transaction BEFORE the append transaction, so partition
    DDL never runs while a chain row lock is held. Cached per database and month."""
    key = (str(db.engine().url.database), at.astimezone(timezone.utc).strftime("%Y%m"))
    if key in _partitions_ready:
        return
    async with db.transaction() as conn:
        await conn.execute(text("SELECT ensure_event_partition(:t)"), {"t": at})
    _partitions_ready.add(key)


async def ingest(intents: Sequence[AuditIntent], transaction: Optional[Callable] = None,
                 clock: Optional[Callable[[], datetime]] = None) -> list[AppendResult]:
    """Append intents, one transaction per chain. Idempotent: running it again with the same intents appends nothing.
    Results are in input order. A database failure raises; nothing from the failing chain is committed."""
    transaction = transaction or db.transaction
    clock = clock or (lambda: datetime.now(timezone.utc))
    if intents:
        await ensure_partition(clock())
    groups: dict[Optional[UUID], list[int]] = {}
    for index, intent in enumerate(intents):
        groups.setdefault(intent.tenant_id, []).append(index)
    out: list[Optional[AppendResult]] = [None] * len(intents)
    for indexes in groups.values():
        async with transaction() as conn:
            results = await append_to_chain(conn, [intents[i] for i in indexes], clock)
        for i, result in zip(indexes, results):
            out[i] = result
    return out  # type: ignore[return-value]
