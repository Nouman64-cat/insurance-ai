"""Owner-database business outbox with fenced, short-transaction delivery leases.

Enqueue with business writes. Send outside database transactions. A crash after
broker acceptance can redeliver the same event ID; consumers must deduplicate it.
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4

from sqlalchemy import Column, DateTime, Index, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel

log = logging.getLogger('business.outbox')


class BusinessOutbox(SQLModel, table=True):
    __tablename__ = 'business_outbox'
    __table_args__ = (Index('ix_business_outbox_pending', 'available_at', postgresql_where=text('published_at IS NULL')),)
    id: UUID = Field(primary_key=True)
    topic: str = Field(max_length=200)
    message_key: str = Field(max_length=160)
    payload: dict = Field(sa_column=Column(JSONB, nullable=False))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), sa_column=Column(DateTime(timezone=True), nullable=False))
    available_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), sa_column=Column(DateTime(timezone=True), nullable=False))
    published_at: Optional[datetime] = Field(default=None, sa_column=Column(DateTime(timezone=True)))
    lease_token: Optional[UUID] = None
    lease_until: Optional[datetime] = Field(default=None, sa_column=Column(DateTime(timezone=True)))
    attempts: int = 0
    last_error_code: Optional[str] = Field(default=None, max_length=80)


def enqueue_policy_event(session, policy, event):
    from shared.events.kafka_events import POLICY_LIFECYCLE_TOPIC, PolicyLifecycleEvent, PolicyLifecyclePayload
    envelope = PolicyLifecycleEvent(event_id=event.id, timestamp=event.created_at, event_type=event.event_type,
        tenant_id=event.tenant_id, payload=PolicyLifecyclePayload(policy_id=policy.id,
            policy_number=policy.policy_number, customer_id=policy.customer_id,
            from_status=event.from_status, to_status=event.to_status, actor=event.actor, detail=event.detail_json))
    session.add(BusinessOutbox(id=event.id, topic=POLICY_LIFECYCLE_TOPIC,
                              message_key=str(event.tenant_id), payload=envelope.model_dump(mode='json')))


async def deliver_one(factory, producer, *, lease_seconds=60):
    """Return True when a message was claimed (including a retryable send failure)."""
    token = uuid4()
    async with factory() as session:
        async with session.begin():
            row = (await session.execute(text('''
                WITH candidate AS (
                    SELECT id FROM business_outbox
                    WHERE published_at IS NULL AND available_at <= clock_timestamp()
                      AND (lease_until IS NULL OR lease_until <= clock_timestamp())
                    ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT 1
                )
                UPDATE business_outbox AS o SET lease_token=:token,
                    lease_until=clock_timestamp() + :lease * interval '1 second', attempts=attempts+1
                FROM candidate WHERE o.id=candidate.id
                RETURNING o.id, o.topic, o.message_key, o.payload
            '''), {'token': token, 'lease': lease_seconds})).mappings().first()
    if row is None:
        return False
    import json
    try:
        # Bound the send below the lease duration. A timeout is uncertain, so the
        # next delivery retains the same immutable event ID and envelope.
        await asyncio.wait_for(producer.send_and_wait(row['topic'], value=json.dumps(row['payload']),
                                                      key=row['message_key']), timeout=max(1, lease_seconds / 2))
    except Exception:
        async with factory() as session:
            async with session.begin():
                await session.execute(text('''UPDATE business_outbox
                    SET lease_until=NULL, lease_token=NULL, last_error_code='BROKER_SEND_FAILED',
                        available_at=clock_timestamp() + interval '5 seconds'
                    WHERE id=:id AND lease_token=:token AND published_at IS NULL'''), {'id': row['id'], 'token': token})
        log.warning('business_outbox_send_failed topic=%s', row['topic'])
        return True
    async with factory() as session:
        async with session.begin():
            await session.execute(text('''UPDATE business_outbox SET published_at=clock_timestamp(),
                lease_until=NULL, lease_token=NULL, last_error_code=NULL
                WHERE id=:id AND lease_token=:token AND published_at IS NULL'''), {'id': row['id'], 'token': token})
    return True


async def relay(stop, factory, producer):
    while not stop.is_set():
        try:
            if await deliver_one(factory, producer):
                continue
        except Exception:
            log.exception('business_outbox_relay_failed')
        try:
            await asyncio.wait_for(stop.wait(), timeout=1)
        except asyncio.TimeoutError:
            pass
