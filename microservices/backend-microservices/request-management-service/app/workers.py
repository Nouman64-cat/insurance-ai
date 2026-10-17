"""Background work, all driven by durable database rows (never by in-memory fire-and-forget tasks).

  Outbox relay   publishes committed outbox_events to Kafka (insurance.request.events.v1), oldest first, and marks
                 them published. Unpublished rows survive restarts; a crash after publishing but before marking
                 means the event may be published twice, which the consumers absorb.
  Consumers      (Kafka consumer groups) deduplicate on event_id in processed_messages:
                   executor  carries out approved actions (request.execution_requested)
                   notifier  writes in-app notifications (one per event and recipient)
  Scheduler      re-dispatches retries whose backoff has elapsed, recovers attempts whose worker died (expired
                 lease), and raises overdue reminders. It never approves, rejects or reassigns anything.

Executing an approved action: the domain service (tenant-service) owns and validates the change. It receives a
stable execution key, so an attempt repeated after a crash returns the first result instead of applying twice.
Transient failures retry with exponential backoff up to max_attempts, then the execution is FAILED and stays
visible until an authorized user retries it. A record changed since review is a CONFLICT: never retried
automatically, it needs a fresh review.
"""
import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Awaitable, Callable, Optional
from uuid import UUID, uuid4

from sqlalchemy import text

from app import db, tenant_client
from app.config import settings
from app.records import audit, j, now, outbox
from app.types.registry import TYPES, get_type
from shared.events.kafka_events import REQUEST_EVENTS_TOPIC

log = logging.getLogger("request-management.workers")
SYSTEM = "System"
LEASE = timedelta(minutes=2)


# ── Publishing ───────────────────────────────────────────────────────────────

class Publisher:
    async def publish(self, key: str, value: str) -> None: ...


class KafkaPublisher(Publisher):
    def __init__(self, bootstrap: str):
        self.bootstrap = bootstrap
        self.producer = None

    async def start(self) -> None:
        from aiokafka import AIOKafkaProducer
        self.producer = AIOKafkaProducer(bootstrap_servers=self.bootstrap, acks="all", enable_idempotence=True,
                                         value_serializer=lambda v: v.encode(), key_serializer=lambda k: k.encode())
        await self.producer.start()

    async def stop(self) -> None:
        if self.producer:
            await self.producer.stop()

    async def publish(self, key: str, value: str) -> None:
        assert self.producer is not None
        await self.producer.send_and_wait(REQUEST_EVENTS_TOPIC, value=value, key=key)


def envelope(row: dict) -> dict:
    return {"event_id": str(row["id"]), "event_type": row["event_type"], "occurred_at": row["created_at"].isoformat(),
            "tenant_id": str(row["tenant_id"]), "request_id": str(row["request_id"]) if row["request_id"] else None,
            "data": row["payload"]}


async def relay_once(publisher: Publisher, batch: int = 100) -> int:
    """Publish up to `batch` pending events. Returns how many were published."""
    published = 0
    async with db.transaction() as conn:
        rows = (await conn.execute(text("""
            SELECT * FROM outbox_events WHERE published_at IS NULL ORDER BY created_at, id LIMIT :n FOR UPDATE SKIP LOCKED
        """), {"n": batch})).mappings().all()
        for row in rows:
            try:
                await publisher.publish(str(row["request_id"] or row["tenant_id"]), json.dumps(envelope(dict(row))))
            except Exception as exc:  # broker down: keep the row for the next round, in order
                await conn.execute(text("UPDATE outbox_events SET publish_attempts = publish_attempts + 1, last_error = :e WHERE id = :id"),
                                   {"e": str(exc)[:500], "id": row["id"]})
                break
            await conn.execute(text("UPDATE outbox_events SET published_at = now(), publish_attempts = publish_attempts + 1 WHERE id = :id"),
                               {"id": row["id"]})
            published += 1
    return published


# ── Consuming ────────────────────────────────────────────────────────────────

async def first_delivery(consumer: str, event_id: UUID) -> bool:
    """Record that `consumer` handled this event; False if it already had (a redelivery)."""
    async with db.transaction() as conn:
        row = (await conn.execute(text("""
            INSERT INTO processed_messages (consumer, event_id) VALUES (:c, :e) ON CONFLICT DO NOTHING RETURNING event_id
        """), {"c": consumer, "e": event_id})).first()
    return row is not None


async def handle(consumer: str, event: dict) -> None:
    if consumer == "executor":
        if event["event_type"] == "request.execution_requested":
            await execute(UUID(event["event_id"]), UUID(event["data"]["execution_id"]))
    elif consumer == "notifier":
        await notify(event)


# ── Execution ────────────────────────────────────────────────────────────────

@dataclass
class Outcome:
    kind: str                         # SUCCEEDED | RETRYABLE_ERROR | FAILED | CONFLICT
    code: Optional[str] = None
    message: Optional[str] = None
    result: dict = field(default_factory=dict)


async def correct_customer_profile(execution: dict, req: dict, revision: dict, approver_id: UUID) -> Outcome:
    payload, snapshot = revision["payload"], revision["subject_snapshot"] or {}
    before = snapshot.get("before") or {}
    body = {
        "execution_key": execution["execution_key"], "request_id": str(req["id"]), "revision_no": revision["revision_no"],
        "requested_by": str(req["requester_id"]), "approved_by": str(approver_id),
        "changes": {k: {"before": before.get(k), "after": v} for k, v in payload["changes"].items()},
    }
    try:
        resp = await tenant_client.get_client().apply_profile_correction(req["tenant_id"], UUID(payload["customer_id"]), body)
    except tenant_client.TenantServiceUnavailable as exc:
        return Outcome("RETRYABLE_ERROR", "DOMAIN_UNAVAILABLE", str(exc)[:300])
    detail = resp.body.get("detail") if isinstance(resp.body, dict) else None
    detail = detail if isinstance(detail, dict) else {"message": str(detail or resp.body)[:300]}
    if resp.status == 200:
        return Outcome("SUCCEEDED", result=resp.body)
    if resp.status == 409 and detail.get("code") == "CONFLICT":
        return Outcome("CONFLICT", "CONFLICT", detail.get("message"), result={"fields": detail.get("fields", [])})
    if resp.status >= 500 or resp.status == 429:
        return Outcome("RETRYABLE_ERROR", f"DOMAIN_{resp.status}", detail.get("message"))
    return Outcome("FAILED", detail.get("code") or f"DOMAIN_{resp.status}", detail.get("message"))


HANDLERS: dict[str, Callable[..., Awaitable[Outcome]]] = {"customer.profile_correction": correct_customer_profile}


def backoff(attempt: int) -> timedelta:
    return timedelta(seconds=min(settings.retry_base_seconds * (2 ** max(attempt - 1, 0)), 900))


async def execute(event_id: UUID, execution_id: UUID) -> Optional[str]:
    """Run one attempt of an execution. Returns the outcome kind, or None when there was nothing to do."""
    async with db.transaction() as conn:
        # Deduplication and the claim commit together: a crash can't mark the event handled without starting the attempt.
        first = (await conn.execute(text("""
            INSERT INTO processed_messages (consumer, event_id) VALUES ('executor', :e) ON CONFLICT DO NOTHING RETURNING event_id
        """), {"e": event_id})).first()
        if first is None:
            return None
        ex = (await conn.execute(text("SELECT * FROM executions WHERE id = :id FOR UPDATE"), {"id": execution_id})).mappings().first()
        if not ex or ex["status"] != "PENDING":
            return None  # already running, finished, or superseded
        ex = dict(ex)
        req = dict((await conn.execute(text("SELECT * FROM requests WHERE id = :id FOR UPDATE"), {"id": ex["request_id"]})).mappings().one())
        if req["review_status"] != "APPROVED":
            return None
        revision = dict((await conn.execute(text("SELECT * FROM request_revisions WHERE request_id = :r AND revision_no = :n"),
                                            {"r": ex["request_id"], "n": ex["revision_no"]})).mappings().one())
        approver = (await conn.execute(text(
            "SELECT decided_by FROM decisions WHERE request_id = :r AND revision_no = :n AND decision = 'APPROVED'"
        ), {"r": ex["request_id"], "n": ex["revision_no"]})).scalar_one()
        attempt_no = ex["attempts"] + 1
        await conn.execute(text("""
            UPDATE executions SET status = 'RUNNING', attempts = :n, lease_until = :lease, next_attempt_at = NULL, updated_at = now() WHERE id = :id
        """), {"n": attempt_no, "lease": now() + LEASE, "id": execution_id})
        await conn.execute(text("INSERT INTO execution_attempts (id, execution_id, tenant_id, attempt_no) VALUES (:id, :e, :t, :n)"),
                           {"id": uuid4(), "e": execution_id, "t": ex["tenant_id"], "n": attempt_no})
        await conn.execute(text("UPDATE requests SET execution_status = 'RUNNING', updated_at = now() WHERE id = :id"), {"id": req["id"]})
        await audit(conn, tenant_id=ex["tenant_id"], request_id=req["id"], event_type="EXECUTION_STARTED", actor_id=None, actor_name=SYSTEM,
                    revision_no=ex["revision_no"], from_execution="PENDING", to_execution="RUNNING", data={"attempt": attempt_no})

    handler = HANDLERS.get(ex["operation"])
    try:
        outcome = await handler(ex, req, revision, approver) if handler else Outcome("FAILED", "UNSUPPORTED_OPERATION", ex["operation"])
    except Exception as exc:  # a bug or an unexpected response: retry within the budget, then fail visibly
        log.exception("execution %s attempt %s raised", execution_id, attempt_no)
        outcome = Outcome("RETRYABLE_ERROR", "UNEXPECTED_ERROR", str(exc)[:300])
    await finish(execution_id, attempt_no, outcome)
    return outcome.kind


async def finish(execution_id: UUID, attempt_no: int, outcome: Outcome) -> None:
    async with db.transaction() as conn:
        ex = dict((await conn.execute(text("SELECT * FROM executions WHERE id = :id FOR UPDATE"), {"id": execution_id})).mappings().one())
        if ex["status"] != "RUNNING" or ex["attempts"] != attempt_no:
            return  # a lease recovery took over this attempt
        req = dict((await conn.execute(text("SELECT * FROM requests WHERE id = :id FOR UPDATE"), {"id": ex["request_id"]})).mappings().one())
        await conn.execute(text("""
            UPDATE execution_attempts SET finished_at = now(), outcome = :o, error_code = :c, error_message = :m
            WHERE execution_id = :e AND attempt_no = :n
        """), {"o": outcome.kind, "c": outcome.code, "m": outcome.message, "e": execution_id, "n": attempt_no})
        retry = outcome.kind == "RETRYABLE_ERROR" and attempt_no < ex["max_attempts"]
        status = "SUCCEEDED" if outcome.kind == "SUCCEEDED" else "PENDING" if retry else "FAILED"
        code = None if outcome.kind == "SUCCEEDED" else (outcome.code or outcome.kind)
        if retry:
            code = outcome.code
        await conn.execute(text("""
            UPDATE executions SET status = :s, lease_until = NULL, last_error_code = :c, last_error = :m, result = CAST(:r AS JSONB),
                next_attempt_at = :next, completed_at = CASE WHEN :s IN ('SUCCEEDED', 'FAILED') THEN now() END, updated_at = now()
            WHERE id = :id
        """), {"s": status, "c": code, "m": outcome.message, "r": j(outcome.result), "next": now() + backoff(attempt_no) if retry else None,
               "id": execution_id})
        await conn.execute(text("UPDATE requests SET execution_status = :s, version = version + 1, updated_at = now() WHERE id = :id"),
                           {"s": status, "id": req["id"]})
        event = {"SUCCEEDED": "EXECUTION_SUCCEEDED", "PENDING": "EXECUTION_RETRY_SCHEDULED", "FAILED": "EXECUTION_FAILED"}[status]
        await audit(conn, tenant_id=ex["tenant_id"], request_id=req["id"], event_type=event, actor_id=None, actor_name=SYSTEM,
                    revision_no=ex["revision_no"], from_execution="RUNNING", to_execution=status, reason=outcome.message,
                    data={"attempt": attempt_no, "code": code})
        if status in ("SUCCEEDED", "FAILED"):
            await outbox(conn, tenant_id=ex["tenant_id"], request_id=req["id"],
                         event_type="request.execution_succeeded" if status == "SUCCEEDED" else "request.execution_failed",
                         data={"reference_no": req["reference_no"], "title": req["title"], "request_type": req["request_type"],
                               "requester_id": str(req["requester_id"]), "decided_by": str(req["decided_by"]) if req["decided_by"] else None,
                               "code": code})


# ── Scheduler ────────────────────────────────────────────────────────────────

async def dispatch_due_retries() -> int:
    async with db.transaction() as conn:
        rows = (await conn.execute(text("""
            SELECT e.id, e.tenant_id, e.request_id, e.revision_no, r.reference_no, r.title, r.request_type, r.requester_id
            FROM executions e JOIN requests r ON r.id = e.request_id
            WHERE e.status = 'PENDING' AND e.next_attempt_at IS NOT NULL AND e.next_attempt_at <= now()
            ORDER BY e.next_attempt_at LIMIT 50 FOR UPDATE OF e SKIP LOCKED
        """))).mappings().all()
        for row in rows:
            await conn.execute(text("UPDATE executions SET next_attempt_at = NULL WHERE id = :id"), {"id": row["id"]})
            await outbox(conn, tenant_id=row["tenant_id"], request_id=row["request_id"], event_type="request.execution_requested",
                         data={"execution_id": str(row["id"]), "revision_no": row["revision_no"], "reference_no": row["reference_no"],
                               "title": row["title"], "request_type": row["request_type"], "requester_id": str(row["requester_id"])})
    return len(rows)


async def recover_expired_leases() -> int:
    """An attempt whose worker died mid-call: count it as a transient failure and let the backoff decide."""
    async with db.transaction() as conn:
        rows = (await conn.execute(text("""
            SELECT id, attempts FROM executions WHERE status = 'RUNNING' AND lease_until < now() LIMIT 50 FOR UPDATE SKIP LOCKED
        """))).mappings().all()
    for row in rows:
        await finish(row["id"], row["attempts"], Outcome("RETRYABLE_ERROR", "WORKER_LOST", "The attempt didn't finish; retrying"))
    return len(rows)


async def overdue_reminders() -> int:
    interval = timedelta(hours=settings.reminder_interval_hours)
    async with db.transaction() as conn:
        rows = (await conn.execute(text("""
            SELECT * FROM requests WHERE review_status IN ('SUBMITTED', 'IN_REVIEW') AND due_at < now()
              AND (last_reminder_at IS NULL OR last_reminder_at < :cutoff)
            ORDER BY due_at LIMIT 100 FOR UPDATE SKIP LOCKED
        """), {"cutoff": now() - interval})).mappings().all()
        for row in rows:
            await conn.execute(text("UPDATE requests SET last_reminder_at = now() WHERE id = :id"), {"id": row["id"]})
            await audit(conn, tenant_id=row["tenant_id"], request_id=row["id"], event_type="OVERDUE_REMINDER", actor_id=None, actor_name=SYSTEM)
            await outbox(conn, tenant_id=row["tenant_id"], request_id=row["id"], event_type="request.overdue",
                         data={"reference_no": row["reference_no"], "title": row["title"], "request_type": row["request_type"],
                               "requester_id": str(row["requester_id"]), "assignee": str(row["assignee_user_id"]) if row["assignee_user_id"] else None,
                               "queue_role": row["queue_role"]})
    return len(rows)


# ── Notifications ────────────────────────────────────────────────────────────

TEMPLATES = {
    "request.submitted": ("assigned", "New request to review", "{ref} “{title}” is waiting for your review."),
    "request.resubmitted": ("resubmitted", "Request resubmitted", "{ref} “{title}” was resubmitted with more information."),
    "request.assigned": ("assigned", "Request assigned to you", "{ref} “{title}” was assigned to you."),
    "request.information_requested": ("information_requested", "More information needed", "The reviewer needs more information on {ref} “{title}”."),
    "request.decided": ("decided", "Decision on your request", "{ref} “{title}” was {decision}."),
    "request.cancelled": ("cancelled", "Request cancelled", "{ref} “{title}” was cancelled by the requester."),
    "request.commented": ("commented", "New comment", "There's a new comment on {ref} “{title}”."),
    "request.execution_failed": ("execution_failed", "Approved change couldn't be applied", "{ref} “{title}” was approved, but applying it failed ({code})."),
    "request.execution_succeeded": ("execution_succeeded", "Approved change applied", "{ref} “{title}” was approved and applied."),
    "request.overdue": ("overdue", "Request overdue", "{ref} “{title}” is past its due date."),
}


async def _queue_members(tenant_id: UUID, role: Optional[str], request_type: str, exclude: Optional[str]) -> list[str]:
    if not role:
        return []
    rtype = TYPES.get(request_type)
    users = await tenant_client.get_client().users(tenant_id, roles=[role])
    return [u["id"] for u in users if u.get("is_active") and u["id"] != exclude and (rtype is None or u.get("role_name") in rtype.review_roles)]


async def _admins(tenant_id: UUID, exclude: Optional[str]) -> list[str]:
    users = await tenant_client.get_client().users(tenant_id, roles=["Admin"])
    return [u["id"] for u in users if u.get("is_active") and u["id"] != exclude]


async def recipients(event: dict) -> list[str]:
    kind, d, tenant = event["event_type"], event.get("data") or {}, UUID(event["tenant_id"])
    requester = d.get("requester_id")
    if kind in ("request.submitted", "request.resubmitted", "request.assigned", "request.cancelled"):
        return [d["assignee"]] if d.get("assignee") else await _queue_members(tenant, d.get("queue_role"), d.get("request_type", ""), requester)
    if kind in ("request.information_requested", "request.decided", "request.execution_succeeded"):
        return [requester] if requester else []
    if kind == "request.commented":
        author = d.get("author_id")
        if author == requester:
            return [d["assignee"]] if d.get("assignee") and d["assignee"] != author else []
        return [requester] if requester and requester != author else []
    if kind == "request.execution_failed":
        people = [requester, d.get("decided_by")] + await _admins(tenant, None)
        return list(dict.fromkeys(p for p in people if p))
    if kind == "request.overdue":
        reviewers = [d["assignee"]] if d.get("assignee") else await _queue_members(tenant, d.get("queue_role"), d.get("request_type", ""), requester)
        return list(dict.fromkeys(p for p in reviewers + await _admins(tenant, requester) if p and p != requester))
    return []


async def notify(event: dict) -> int:
    template = TEMPLATES.get(event["event_type"])
    if not template:
        await first_delivery("notifier", UUID(event["event_id"]))
        return 0
    people = await recipients(event)  # directory lookups happen before the transaction
    d = event.get("data") or {}
    kind, title, body = template
    text_body = body.format(ref=d.get("reference_no", ""), title=d.get("title", ""), code=d.get("code") or "error",
                            decision=(d.get("decision") or "").lower() or "decided")
    created = 0
    async with db.transaction() as conn:
        first = (await conn.execute(text("""
            INSERT INTO processed_messages (consumer, event_id) VALUES ('notifier', :e) ON CONFLICT DO NOTHING RETURNING event_id
        """), {"e": UUID(event["event_id"])})).first()
        if first is None:
            return 0
        for person in people:
            created += (await conn.execute(text("""
                INSERT INTO notifications (id, tenant_id, recipient_user_id, request_id, event_id, kind, title, body)
                VALUES (:id, :t, :u, :r, :e, :k, :title, :body) ON CONFLICT (event_id, recipient_user_id) DO NOTHING
            """), {"id": uuid4(), "t": UUID(event["tenant_id"]), "u": UUID(person), "r": UUID(event["request_id"]) if event.get("request_id") else None,
                   "e": UUID(event["event_id"]), "k": kind, "title": title, "body": text_body})).rowcount
    return created


# ── Loops ────────────────────────────────────────────────────────────────────

async def _forever(name: str, step: Callable[[], Awaitable[Any]], idle: float, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            busy = await step()
        except Exception:
            log.exception("%s failed; retrying", name)
            busy = 0
        if not busy:
            try:
                await asyncio.wait_for(stop.wait(), timeout=idle)
            except asyncio.TimeoutError:
                pass


async def _consume(name: str, stop: asyncio.Event) -> None:
    from aiokafka import AIOKafkaConsumer
    while not stop.is_set():
        try:
            await ensure_topic()
        except Exception:
            log.warning("%s: Kafka not reachable yet; retrying", name)
            await asyncio.sleep(5)
            continue
        consumer = AIOKafkaConsumer(REQUEST_EVENTS_TOPIC, bootstrap_servers=settings.kafka_bootstrap, group_id=f"request-management-{name}",
                                    enable_auto_commit=False, auto_offset_reset="earliest")
        try:
            await consumer.start()
            while not stop.is_set():
                batch = await consumer.getmany(timeout_ms=1000, max_records=50)
                for _tp, messages in batch.items():
                    for message in messages:
                        try:
                            await handle(name, json.loads(message.value))
                        except Exception:
                            # Not committed: redelivered later. Handlers are idempotent (processed_messages).
                            log.exception("%s could not handle an event; will retry", name)
                            raise
                if batch:
                    await consumer.commit()
        except Exception:
            log.exception("%s consumer stopped; reconnecting", name)
            await asyncio.sleep(5)
        finally:
            try:
                await consumer.stop()
            except Exception:
                pass


async def _schedule_step() -> int:
    return await dispatch_due_retries() + await recover_expired_leases() + await overdue_reminders()


async def ensure_topic() -> None:
    """Create the event topic if it doesn't exist yet (consumers can't subscribe to a missing topic)."""
    from aiokafka.admin import AIOKafkaAdminClient, NewTopic
    from aiokafka.errors import TopicAlreadyExistsError
    admin = AIOKafkaAdminClient(bootstrap_servers=settings.kafka_bootstrap)
    try:
        await admin.start()
        if REQUEST_EVENTS_TOPIC not in await admin.list_topics():
            try:
                await admin.create_topics([NewTopic(REQUEST_EVENTS_TOPIC, num_partitions=3, replication_factor=1)])
            except TopicAlreadyExistsError:
                pass
    finally:
        await admin.close()


def start(stop: asyncio.Event) -> list[asyncio.Task]:
    async def relay_loop() -> None:
        while not stop.is_set():
            publisher = KafkaPublisher(settings.kafka_bootstrap)
            try:
                await publisher.start()
                await _forever("outbox relay", lambda: relay_once(publisher), 1.0, stop)
            except Exception:
                log.exception("outbox relay can't reach Kafka; retrying")
                await asyncio.sleep(5)
            finally:
                await publisher.stop()

    return [
        asyncio.create_task(relay_loop(), name="outbox-relay"),
        asyncio.create_task(_consume("executor", stop), name="executor"),
        asyncio.create_task(_consume("notifier", stop), name="notifier"),
        asyncio.create_task(_forever("scheduler", _schedule_step, 15.0, stop), name="scheduler"),
    ]
