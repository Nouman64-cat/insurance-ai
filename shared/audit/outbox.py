"""Transactional outbox for audit intents.

A service that owns a business change writes an audit intent into its own `audit_outbox` table *in the same database
transaction* as the change (`enqueue` / `enqueue_sync` take the caller's connection). The change and its audit intent
therefore commit together or not at all: if the intent cannot be persisted, the business transaction fails, so an
operation is never reported as audited when it is not.

An `OutboxRelay` then publishes committed intents to Kafka (insurance.audit.events.v1) and marks them published.
A crash between publishing and marking only causes a re-publish; the Audit Service deduplicates on
(source_service, source_event_id). If Kafka is down the rows simply wait: nothing is lost and the business path is
never blocked on the broker.

The table lives in each owning service's schema (the connection's search_path decides which), so the helpers use an
unqualified name. `OUTBOX_DDL` creates it idempotently.
"""
import asyncio
import json
import logging
import re
import time
from typing import Any, AsyncContextManager, Callable, Optional, Protocol
from uuid import UUID, uuid4

from sqlalchemy import text

from shared.audit.context import AuditContext, get_context
from shared.audit.schema import AUDIT_EVENTS_TOPIC, PLATFORM_KEY, SUCCESS, AuditIntent, utcnow

log = logging.getLogger("audit.outbox")

OUTBOX_DDL: tuple[str, ...] = (
    """CREATE TABLE IF NOT EXISTS audit_outbox (
        id UUID PRIMARY KEY,
        tenant_id UUID,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at TIMESTAMPTZ,
        publish_attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS audit_outbox_pending ON audit_outbox (created_at) WHERE published_at IS NULL",
)

OUTBOX_TABLE = "audit_outbox"
_TABLE_NAME = re.compile(r"^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$")


def _table(name: str) -> str:
    """A table name that is safe to put in SQL (optionally schema-qualified)."""
    if not _TABLE_NAME.match(name):
        raise ValueError(f"unsafe outbox table name: {name!r}")
    return name


def _insert(table: str):
    return text(f"INSERT INTO {_table(table)} (id, tenant_id, payload) VALUES (:id, :tenant, CAST(:payload AS JSONB))")


# ── Building intents ─────────────────────────────────────────────────────────

def _actor_fields(ctx: AuditContext, actor_id: Optional[str], actor_type: Optional[str], actor_role: Optional[str]) -> dict:
    """Who acted. An explicit actor_id (a row that records its own actor) wins; otherwise the request's caller. When the
    explicit actor IS the caller, the caller's role and display name complete it."""
    if actor_id is None:
        return {"actor_id": ctx.actor_id, "actor_type": actor_type or ctx.actor_type, "actor_role": ctx.actor_role, "actor_name": ctx.actor_name}
    same = actor_id == ctx.actor_id
    return {"actor_id": actor_id, "actor_type": actor_type or "USER",
            "actor_role": actor_role or (ctx.actor_role if same else None), "actor_name": ctx.actor_name if same else None}


def build_intent(source_service: str, *, module: str, action: str, entity_type: str, entity_id: Any = None,
                 tenant_id: Optional[UUID] = None, case_id: Any = None, previous_value: Optional[dict] = None,
                 new_value: Optional[dict] = None, outcome: str = SUCCESS, metadata: Optional[dict] = None,
                 actor_id: Optional[str] = None, actor_type: Optional[str] = None, actor_role: Optional[str] = None,
                 occurred_at=None, context: Optional[AuditContext] = None) -> AuditIntent:
    """An intent for something that just happened. Actor and correlation id default to the current audit context
    (set by the service's HTTP middleware); explicit arguments win. Without a caller the actor is SYSTEM."""
    ctx = context or get_context()
    actor = _actor_fields(ctx, actor_id, actor_type, actor_role)
    meta = dict(metadata or {})
    if actor.pop("actor_name"):
        meta.setdefault("actor_name", ctx.actor_name)
    if ctx.client_ip and module == "administration" and action.startswith(("auth.", "access.")):
        meta.setdefault("client_ip", ctx.client_ip)
    return AuditIntent(
        source_service=source_service,
        source_event_id=str(uuid4()),
        tenant_id=tenant_id if tenant_id is not None else ctx.tenant_id,
        occurred_at=occurred_at or utcnow(),
        module=module, action=action, entity_type=entity_type,
        entity_id=None if entity_id is None else str(entity_id),
        case_id=None if case_id is None else str(case_id),
        correlation_id=ctx.correlation_id,
        previous_value=previous_value, new_value=new_value, outcome=outcome, metadata=meta,
        **actor,
    )


def _params(intent: AuditIntent) -> dict:
    return {"id": UUID(intent.source_event_id), "tenant": intent.tenant_id,
            "payload": intent.model_dump_json()}


# ── Writing (inside the caller's transaction) ───────────────────────────────

def enqueue_sync(connection, intent: AuditIntent, table: str = OUTBOX_TABLE) -> None:
    """Queue an intent on a synchronous connection (SQLAlchemy ORM flush events run synchronously)."""
    connection.execute(_insert(table), _params(intent))


async def enqueue(conn, intent: AuditIntent, table: str = OUTBOX_TABLE) -> None:
    """Queue an intent on the caller's AsyncConnection / AsyncSession: it commits or rolls back with the caller."""
    await conn.execute(_insert(table), _params(intent))


# ── Publishing ───────────────────────────────────────────────────────────────

class Publisher(Protocol):
    async def publish(self, key: str, value: str) -> None: ...


class KafkaPublisher:
    """Lazily-connected producer: starting the service never depends on the broker being up, and a failed send
    drops the connection so the next attempt reconnects."""

    def __init__(self, bootstrap: str, topic: str = AUDIT_EVENTS_TOPIC):
        self.bootstrap = bootstrap
        self.topic = topic
        self._producer = None
        self._lock = asyncio.Lock()

    async def _ensure(self):
        async with self._lock:
            if self._producer is None:
                from aiokafka import AIOKafkaProducer
                producer = AIOKafkaProducer(bootstrap_servers=self.bootstrap, acks="all", enable_idempotence=True,
                                            value_serializer=lambda v: v.encode(), key_serializer=lambda k: k.encode(),
                                            request_timeout_ms=10_000)
                await producer.start()
                self._producer = producer
            return self._producer

    async def publish(self, key: str, value: str) -> None:
        producer = await self._ensure()
        try:
            await asyncio.wait_for(producer.send_and_wait(self.topic, value=value, key=key), timeout=15)
        except Exception:
            await self.stop()
            raise

    async def stop(self) -> None:
        async with self._lock:
            producer, self._producer = self._producer, None
        if producer is not None:
            try:
                await producer.stop()
            except Exception:
                pass


class OutboxRelay:
    """Publishes committed audit intents, oldest first, and records the result on each row."""

    def __init__(self, transaction: Callable[[], AsyncContextManager], publisher: Publisher, *, batch: int = 100,
                 interval: float = 1.0, prune_after_days: int = 7, name: str = "audit-outbox", table: str = OUTBOX_TABLE):
        self.table = _table(table)
        self.transaction = transaction
        self.publisher = publisher
        self.batch = batch
        self.interval = interval
        self.prune_after_days = prune_after_days
        self.name = name
        self.consecutive_failures = 0
        self.last_error: Optional[str] = None
        self._last_prune = 0.0

    async def relay_once(self) -> int:
        """Publish up to `batch` pending intents. Returns how many were published."""
        published = 0
        async with self.transaction() as conn:
            rows = (await conn.execute(text(
                f"SELECT id, tenant_id, payload FROM {self.table} WHERE published_at IS NULL "
                "ORDER BY created_at, id LIMIT :n FOR UPDATE SKIP LOCKED"), {"n": self.batch})).mappings().all()
            for row in rows:
                payload = row["payload"] if isinstance(row["payload"], str) else json.dumps(row["payload"])
                try:
                    await self.publisher.publish(str(row["tenant_id"] or PLATFORM_KEY), payload)
                except Exception as exc:  # broker down: keep the rest for the next round, in order
                    self.consecutive_failures += 1
                    self.last_error = f"{type(exc).__name__}: {exc}"[:500]
                    await conn.execute(text(f"UPDATE {self.table} SET publish_attempts = publish_attempts + 1, "
                                            "last_error = :e WHERE id = :id"), {"e": self.last_error, "id": row["id"]})
                    break
                await conn.execute(text(f"UPDATE {self.table} SET published_at = now(), "
                                        "publish_attempts = publish_attempts + 1, last_error = NULL WHERE id = :id"),
                                   {"id": row["id"]})
                published += 1
        if published:
            self.consecutive_failures = 0
            self.last_error = None
        return published

    async def prune(self) -> int:
        """Drop published rows past the retention window (the outbox is a transport buffer; the record of truth is
        the Audit Service's ledger)."""
        async with self.transaction() as conn:
            result = await conn.execute(text(
                f"DELETE FROM {self.table} WHERE published_at IS NOT NULL AND published_at < now() - make_interval(days => :d)"),
                {"d": self.prune_after_days})
            return result.rowcount or 0

    async def run(self, stop: asyncio.Event) -> None:
        log.info("%s relay started", self.name)
        while not stop.is_set():
            try:
                moved = await self.relay_once()
                if time.monotonic() - self._last_prune > 3600:
                    self._last_prune = time.monotonic()
                    await self.prune()
            except Exception as exc:  # database trouble: keep going
                moved = 0
                self.consecutive_failures += 1
                self.last_error = f"{type(exc).__name__}: {exc}"[:500]
                log.warning("%s relay round failed: %s", self.name, exc)
            if moved >= self.batch:
                continue  # more waiting: go again at once
            delay = self.interval if self.consecutive_failures == 0 else min(30.0, self.interval * 2 ** min(self.consecutive_failures, 5))
            try:
                await asyncio.wait_for(stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass
        close = getattr(self.publisher, "stop", None)
        if close is not None:
            await close()
        log.info("%s relay stopped", self.name)

    async def stats(self) -> dict:
        """Undelivered audit intents, for the owning service's health endpoint."""
        async with self.transaction() as conn:
            row = (await conn.execute(text(f"""
                SELECT count(*) FILTER (WHERE published_at IS NULL) AS pending,
                       count(*) FILTER (WHERE published_at IS NULL AND publish_attempts >= 3) AS failing,
                       EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE published_at IS NULL)) AS oldest_pending_seconds,
                       max(published_at) AS last_published_at
                FROM {self.table}"""))).mappings().one()
        return {"pending": int(row["pending"] or 0), "failing": int(row["failing"] or 0),
                "oldest_pending_seconds": float(row["oldest_pending_seconds"]) if row["oldest_pending_seconds"] is not None else None,
                "last_published_at": row["last_published_at"].isoformat() if row["last_published_at"] else None,
                "consecutive_publish_failures": self.consecutive_failures, "last_error": self.last_error}
