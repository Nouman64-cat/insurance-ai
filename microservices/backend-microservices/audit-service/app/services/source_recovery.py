"""Recover a deleted ledger event from the Kafka message it was ingested from.

The ledger never keeps a second copy of an event, but every event first travelled through the audit topic as a full
AuditIntent. While the broker still retains that message (retention.ms; 7 days by default) the event can be rebuilt
and, because the ledger hash covers every field, *proven* to be the original: the hash recomputed from the recovered
fields must equal the hash the ledger recorded for that sequence number. A recovery whose hash does not match is
reported as unverified and must not be relied on."""
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID

from app.config import settings
from shared.audit import hashing
from shared.audit.schema import AUDIT_EVENTS_TOPIC, AuditIntent

log = logging.getLogger("audit.recovery")

LOOKBACK = timedelta(hours=6)      # the message is produced before the ledger records it (outbox delay)
LOOKAHEAD = timedelta(minutes=5)
MAX_SCANNED = 50_000
TIMEOUT_SECONDS = 8.0


async def _find_message(source_service: str, source_event_id: str, recorded_at: datetime) -> Optional[tuple[AuditIntent, int, int]]:
    from aiokafka import AIOKafkaConsumer
    # No group id: a standalone reader that is assigned every partition and never commits, so it cannot disturb the
    # ledger consumer's offsets.
    consumer = AIOKafkaConsumer(AUDIT_EVENTS_TOPIC, bootstrap_servers=settings.kafka_bootstrap, group_id=None,
                                enable_auto_commit=False)
    try:
        await consumer.start()
        tps = sorted(consumer.assignment(), key=lambda tp: tp.partition)
        if not tps:
            return None
        start_ms = int((recorded_at - LOOKBACK).timestamp() * 1000)
        stop_ms = int((recorded_at + LOOKAHEAD).timestamp() * 1000)
        starts = await consumer.offsets_for_times({tp: start_ms for tp in tps})
        ends = await consumer.end_offsets(tps)
        live = []
        for tp in tps:
            found = starts.get(tp)
            if found is None or found.offset >= ends[tp]:
                continue
            consumer.seek(tp, found.offset)
            live.append(tp)
        scanned = 0
        while live and scanned < MAX_SCANNED:
            batch = await consumer.getmany(*live, timeout_ms=1000, max_records=500)
            if not batch:
                continue
            for tp, records in batch.items():
                for record in records:
                    scanned += 1
                    if record.timestamp > stop_ms:
                        live = [t for t in live if t != tp]
                        break
                    try:
                        intent = AuditIntent.model_validate_json(record.value or b"")
                    except ValueError:
                        continue
                    if intent.source_service == source_service and intent.source_event_id == source_event_id:
                        return intent, record.partition, record.offset
            live = [tp for tp in live if await consumer.position(tp) < ends[tp]]
        return None
    finally:
        await consumer.stop()


def rebuild(intent: AuditIntent, *, event_id: UUID, environment_id: UUID, chain_id: str, sequence: int,
            previous_hash: str, recorded_at: datetime) -> dict:
    """The ledger record exactly as audit_service._record builds it (same fields, same hash function)."""
    record = {
        "event_id": event_id, "chain_id": chain_id, "sequence_number": sequence,
        "tenant_id": intent.tenant_id, "environment_id": environment_id,
        "occurred_at": intent.occurred_at, "recorded_at": recorded_at,
        "actor_id": intent.actor_id, "actor_type": intent.actor_type, "actor_role": intent.actor_role,
        "service_name": intent.source_service, "module": intent.module, "action": intent.action,
        "entity_type": intent.entity_type, "entity_id": intent.entity_id, "case_id": intent.case_id,
        "correlation_id": intent.correlation_id, "source_event_id": intent.source_event_id,
        "previous_value": intent.previous_value, "new_value": intent.new_value,
        "outcome": intent.outcome, "metadata": intent.metadata,
        "previous_hash": previous_hash, "hash_version": hashing.HASH_VERSION,
    }
    record["current_hash"] = hashing.compute_event_hash(chain_id, sequence, previous_hash, record, hashing.HASH_VERSION)
    return record


async def recover(*, source_service: str, source_event_id: str, recorded_at: datetime, event_id: UUID, environment_id: UUID,
                  chain_id: str, sequence: int, previous_hash: str) -> Optional[dict]:
    """The rebuilt record plus where it came from, or None when the broker no longer has (or cannot give) the message."""
    try:
        found = await asyncio.wait_for(_find_message(source_service, source_event_id, recorded_at), TIMEOUT_SECONDS)
    except Exception as exc:  # broker down, topic gone, timeout: recovery is best effort and must never break the page
        log.warning("source recovery failed for %s/%s: %s", source_service, source_event_id, exc)
        return None
    if found is None:
        return None
    intent, partition, offset = found
    record = rebuild(intent, event_id=event_id, environment_id=environment_id, chain_id=chain_id, sequence=sequence,
                     previous_hash=previous_hash, recorded_at=recorded_at)
    return {"record": record, "partition": partition, "offset": offset}
