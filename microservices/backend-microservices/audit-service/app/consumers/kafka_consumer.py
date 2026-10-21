"""Kafka -> ledger.

Consumes insurance.audit.events.v1 as a consumer group and appends each intent to the ledger through
audit_service.ingest. The guarantees come from the ledger, not from Kafka:

  * offsets are committed only AFTER the ledger transaction commits (at-least-once);
  * a redelivered message is a no-op (the ledger deduplicates on service + source_event_id);
  * Kafka order is not trusted: sequence numbers are assigned when the ledger transaction commits;
  * a database outage is retried with backoff and the batch is re-read from the last committed offset;
  * a message that can never be stored (malformed, or a source id reused across chains) is written to dead_letters
    and skipped, so one poison message never blocks the topic.
"""
import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Iterable, Optional

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, InterfaceError, OperationalError

from app import db
from app.services import audit_service
from shared.audit.schema import AUDIT_EVENTS_TOPIC, AuditIntent

log = logging.getLogger("audit.consumer")

MAX_RAW = 8192


@dataclass
class Message:
    topic: str
    partition: int
    offset: int
    key: Optional[str]
    value: bytes


@dataclass
class ConsumerStats:
    running: bool = False
    batches: int = 0
    consumed: int = 0
    appended: int = 0
    duplicates: int = 0
    rejected: int = 0
    dead_lettered: int = 0
    last_message_at: Optional[str] = None
    last_error: Optional[str] = None
    last_error_at: Optional[str] = None
    lag: dict = field(default_factory=dict)


def is_transient(exc: BaseException) -> bool:
    """Trouble reaching the database (retry), as opposed to a message the ledger will never accept."""
    if isinstance(exc, (OperationalError, InterfaceError, OSError, asyncio.TimeoutError, ConnectionError)):
        return True
    if isinstance(exc, DBAPIError) and exc.connection_invalidated:
        return True
    return False


class AuditConsumer:
    def __init__(self, bootstrap: str, group: str, topic: str = AUDIT_EVENTS_TOPIC, batch: int = 200,
                 transaction: Optional[Callable] = None):
        self.bootstrap, self.group, self.topic, self.batch = bootstrap, group, topic, batch
        self.transaction = transaction or db.transaction
        self.stats = ConsumerStats()
        self._consumer = None

    # ── Processing (independent of Kafka, so it is testable without a broker) ──────────────────────

    async def process_messages(self, messages: Iterable[Message]) -> None:
        """Append a batch. Returns normally when every message is either in the ledger or in dead_letters; raises
        only for a transient failure (the caller must then NOT commit offsets and retry)."""
        parsed: list[tuple[Message, AuditIntent]] = []
        for message in messages:
            self.stats.consumed += 1
            self.stats.last_message_at = datetime.now(timezone.utc).isoformat()
            try:
                parsed.append((message, AuditIntent.model_validate_json(message.value)))
            except Exception as exc:
                await self._dead_letter(message, "INVALID_MESSAGE", str(exc))
        if not parsed:
            return
        try:
            results = await audit_service.ingest([intent for _, intent in parsed], self.transaction)
            self._count(results)
            for (message, _), result in zip(parsed, results):
                if result.status == audit_service.REJECTED:
                    await self._dead_letter(message, result.error_code or "REJECTED", result.error_detail)
            return
        except Exception as exc:
            if is_transient(exc):
                raise
            log.warning("batch of %d could not be appended together (%s); retrying one by one", len(parsed), exc)
        # A non-transient failure inside the batch: isolate the offender.
        for message, intent in parsed:
            try:
                results = await audit_service.ingest([intent], self.transaction)
            except Exception as exc:
                if is_transient(exc):
                    raise
                await self._dead_letter(message, "APPEND_FAILED", f"{type(exc).__name__}: {exc}"[:1000])
                continue
            self._count(results)
            if results[0].status == audit_service.REJECTED:
                await self._dead_letter(message, results[0].error_code or "REJECTED", results[0].error_detail)

    def _count(self, results) -> None:
        for result in results:
            if result.status == audit_service.APPENDED:
                self.stats.appended += 1
            elif result.status == audit_service.DUPLICATE:
                self.stats.duplicates += 1
            else:
                self.stats.rejected += 1

    async def _dead_letter(self, message: Message, code: str, detail: Optional[str]) -> None:
        self.stats.dead_lettered += 1
        log.error("dead-lettering %s[%s]@%s: %s %s", message.topic, message.partition, message.offset, code, detail)
        raw = message.value.decode("utf-8", "replace")[:MAX_RAW].replace("\x00", "")
        async with self.transaction() as conn:
            await conn.execute(text("""
                INSERT INTO dead_letters (topic, partition_id, msg_offset, message_key, raw_value, error_code, error_detail)
                VALUES (:t, :p, :o, :k, :v, :c, :d) ON CONFLICT (topic, partition_id, msg_offset) DO NOTHING
            """), {"t": message.topic, "p": message.partition, "o": message.offset, "k": message.key, "v": raw,
                   "c": code, "d": (detail or "")[:2000]})

    # ── Kafka loop ───────────────────────────────────────────────────────────────────────────────

    async def _ensure_topic(self) -> None:
        try:
            from aiokafka.admin import AIOKafkaAdminClient, NewTopic
            from aiokafka.errors import TopicAlreadyExistsError
            admin = AIOKafkaAdminClient(bootstrap_servers=self.bootstrap)
            await admin.start()
            try:
                await admin.create_topics([NewTopic(name=self.topic, num_partitions=3, replication_factor=1)])
            except TopicAlreadyExistsError:
                pass
            finally:
                await admin.close()
        except Exception as exc:  # the broker may auto-create it; subscribing will tell
            log.info("could not ensure topic %s (%s)", self.topic, exc)

    async def run(self, stop: asyncio.Event) -> None:
        from aiokafka import AIOKafkaConsumer
        backoff = 1.0
        while not stop.is_set():
            consumer = None
            try:
                await self._ensure_topic()
                consumer = AIOKafkaConsumer(self.topic, bootstrap_servers=self.bootstrap, group_id=self.group,
                                            enable_auto_commit=False, auto_offset_reset="earliest",
                                            max_poll_records=self.batch, session_timeout_ms=30_000)
                await consumer.start()
                self._consumer = consumer
                self.stats.running = True
                log.info("consuming %s as group %s", self.topic, self.group)
                while not stop.is_set():
                    data = await consumer.getmany(timeout_ms=1000, max_records=self.batch)
                    await self._update_lag(consumer)
                    messages = [Message(r.topic, r.partition, r.offset, r.key.decode() if r.key else None, r.value or b"")
                                for records in data.values() for r in records]
                    if not messages:
                        continue
                    try:
                        await self.process_messages(messages)
                    except Exception as exc:  # database trouble: re-read from the last committed offset
                        self._error(exc)
                        for tp, records in data.items():
                            consumer.seek(tp, records[0].offset)
                        await self._sleep(stop, backoff)
                        backoff = min(backoff * 2, 30.0)
                        continue
                    backoff = 1.0
                    self.stats.batches += 1
                    await consumer.commit()
            except Exception as exc:  # broker unavailable etc.: the producers' outboxes keep the events meanwhile
                self._error(exc)
                await self._sleep(stop, backoff)
                backoff = min(backoff * 2, 30.0)
            finally:
                self.stats.running = False
                self._consumer = None
                if consumer is not None:
                    try:
                        await consumer.stop()
                    except Exception:
                        pass

    async def _update_lag(self, consumer) -> None:
        try:
            lag = {}
            for tp in consumer.assignment():
                end = (await consumer.end_offsets([tp]))[tp]
                lag[f"{tp.topic}[{tp.partition}]"] = max(0, end - await consumer.position(tp))
            self.stats.lag = lag
        except Exception:
            pass

    def _error(self, exc: BaseException) -> None:
        self.stats.last_error = f"{type(exc).__name__}: {exc}"[:500]
        self.stats.last_error_at = datetime.now(timezone.utc).isoformat()
        log.warning("consumer error: %s", self.stats.last_error)

    @staticmethod
    async def _sleep(stop: asyncio.Event, seconds: float) -> None:
        try:
            await asyncio.wait_for(stop.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    def status(self) -> dict:
        s = self.stats
        return {"running": s.running, "group": self.group, "topic": self.topic, "batches": s.batches, "consumed": s.consumed,
                "appended": s.appended, "duplicates": s.duplicates, "rejected": s.rejected, "dead_lettered": s.dead_lettered,
                "last_message_at": s.last_message_at, "last_error": s.last_error, "last_error_at": s.last_error_at,
                "lag": s.lag, "total_lag": sum(s.lag.values()) if s.lag else 0}
