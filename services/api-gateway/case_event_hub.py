"""
Case Event Hub — fans case events from Kafka out to connected browsers (SSE).

Lifecycle
---------
1. Poll insurance.case.events.v1 with a consumer group unique to THIS process,
   starting at "latest" — every gateway replica gets every event (broadcast),
   and nothing published while no one was listening is replayed.
2. Hand each event to every live subscriber queue for the event's tenant.
3. GET /events/stream (routers/events.py) registers a queue per open browser
   tab and streams whatever lands in it as `data: {...}` lines.

Why this exists
---------------
Some case progress happens outside any staff session — most notably the
customer submitting their e-application from the public tokenised link. The
copilot had no way to learn about it until someone asked; this pushes it the
moment it happens so the chat can start verification on its own.

Delivery is best-effort (in-memory, no offsets committed): a browser that is
offline when the event fires simply re-reads the case status when it reconnects.
"""

import asyncio
import logging
import os
import uuid
from collections import defaultdict
from uuid import UUID

from aiokafka import AIOKafkaConsumer
from aiokafka.errors import KafkaConnectionError
from pydantic import ValidationError

from shared.events.kafka_events import CASE_EVENTS_TOPIC, CaseEvent

logger = logging.getLogger("api-gateway.case-event-hub")

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
# Per-process group → broadcast semantics across gateway replicas.
CONSUMER_GROUP = f"api-gateway-case-events-{uuid.uuid4().hex[:12]}"
_QUEUE_MAX = 100

_subscribers: dict[UUID, set[asyncio.Queue]] = defaultdict(set)


def subscribe(tenant_id: UUID) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAX)
    _subscribers[tenant_id].add(q)
    return q


def unsubscribe(tenant_id: UUID, q: asyncio.Queue) -> None:
    subs = _subscribers.get(tenant_id)
    if subs is None:
        return
    subs.discard(q)
    if not subs:
        _subscribers.pop(tenant_id, None)


def _publish_local(event: CaseEvent) -> None:
    message = {
        "type": "case_event",
        "event_id": str(event.event_id),
        "event_type": event.event_type,
        "timestamp": event.timestamp.isoformat(),
        **event.payload.model_dump(mode="json"),
    }
    for q in list(_subscribers.get(event.tenant_id, ())):
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            # A stalled tab shouldn't hold memory forever — drop for it only.
            logger.warning("subscriber queue full, dropping %s", event.event_type)


async def run_consumer(stop_event: asyncio.Event) -> None:
    consumer = AIOKafkaConsumer(
        CASE_EVENTS_TOPIC,
        bootstrap_servers=KAFKA_BOOTSTRAP,
        group_id=CONSUMER_GROUP,
        auto_offset_reset="latest",
        enable_auto_commit=False,
        # The topic is auto-created on first publish; refresh metadata often so
        # a hub that started before it existed picks it up quickly.
        metadata_max_age_ms=30_000,
        value_deserializer=lambda raw: raw.decode("utf-8"),
    )

    for attempt in range(1, 31):
        try:
            await consumer.start()
            break
        except KafkaConnectionError as exc:
            if stop_event.is_set():
                return
            logger.warning("Kafka not ready for case event hub (attempt %s): %s", attempt, exc)
            await asyncio.sleep(2)
    else:
        logger.error("Case event hub could not connect to Kafka — live case events disabled")
        return

    logger.info("Case event hub started — polling %s", CASE_EVENTS_TOPIC)
    try:
        while not stop_event.is_set():
            batches = await consumer.getmany(timeout_ms=1000)
            for msgs in batches.values():
                for msg in msgs:
                    try:
                        event = CaseEvent.model_validate_json(msg.value)
                    except ValidationError as exc:
                        logger.error("invalid case event, skipping | error=%s", exc)
                        continue
                    _publish_local(event)
    finally:
        await consumer.stop()
        logger.info("Case event hub shut down cleanly")


def start_case_event_hub(stop_event: asyncio.Event) -> asyncio.Task:
    return asyncio.create_task(run_consumer(stop_event), name="case-event-hub")
