"""Reliable delivery: the transactional outbox, the relay, and the Kafka consumer's processing (no broker needed)."""
import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest import mock
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.exc import DataError, OperationalError
from sqlalchemy.ext.asyncio import create_async_engine

from app.consumers.kafka_consumer import AuditConsumer, Message
from app.services import audit_service, chain_verifier
from shared.audit.context import AuditContext, audit_context
from shared.audit.outbox import OUTBOX_DDL, OutboxRelay, build_intent, enqueue
from shared.audit.schema import AUDIT_EVENTS_TOPIC
from tests.support import LedgerCase, intent


class FakePublisher:
    def __init__(self):
        self.sent: list[tuple[str, str]] = []
        self.fail = False
        self.fail_after: int | None = None

    async def publish(self, key: str, value: str) -> None:
        if self.fail or (self.fail_after is not None and len(self.sent) >= self.fail_after):
            raise ConnectionError("broker unavailable")
        self.sent.append((key, value))


def message(i, offset=0, partition=0) -> Message:
    return Message(AUDIT_EVENTS_TOPIC, partition, offset, str(i.tenant_id), i.model_dump_json().encode())


class OutboxCase(LedgerCase):
    """A stand-in for an owning service: its own schema with a business table and the audit outbox."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.svc = create_async_engine(self.database.owner_url, connect_args={"server_settings": {"search_path": "svc"}})
        await self.database.create_schema("svc")
        async with self.svc.begin() as conn:
            await conn.execute(text("CREATE TABLE IF NOT EXISTS biz (id TEXT PRIMARY KEY)"))
            for statement in OUTBOX_DDL:
                await conn.execute(text(statement))
            await conn.execute(text("DELETE FROM audit_outbox"))

    async def asyncTearDown(self):
        await self.svc.dispose()
        await super().asyncTearDown()

    @asynccontextmanager
    async def transaction(self):
        async with self.svc.begin() as conn:
            yield conn

    async def svc_rows(self, sql):
        async with self.svc.connect() as conn:
            return (await conn.execute(text(sql))).mappings().all()


class AtomicityTests(OutboxCase):
    async def test_business_change_and_audit_intent_commit_together(self):
        tenant = uuid4()
        async with self.transaction() as conn:
            await conn.execute(text("INSERT INTO biz VALUES ('commit-1')"))
            await enqueue(conn, build_intent("test-service", module="policies", action="policy.issued", entity_type="policy", tenant_id=tenant))
        self.assertEqual(len(await self.svc_rows("SELECT * FROM biz WHERE id = 'commit-1'")), 1)
        self.assertEqual(len(await self.svc_rows("SELECT * FROM audit_outbox")), 1)

    async def test_rollback_discards_both_the_change_and_its_intent(self):
        class Abort(Exception):
            pass
        with self.assertRaises(Abort):
            async with self.transaction() as conn:
                await conn.execute(text("INSERT INTO biz VALUES ('rollback-1')"))
                await enqueue(conn, build_intent("test-service", module="policies", action="policy.issued", entity_type="policy", tenant_id=uuid4()))
                raise Abort()
        self.assertEqual(await self.svc_rows("SELECT * FROM biz WHERE id = 'rollback-1'"), [])
        self.assertEqual(await self.svc_rows("SELECT * FROM audit_outbox"), [])

    async def test_if_the_intent_cannot_be_stored_the_business_change_fails_too(self):
        with self.assertRaises(Exception):
            async with self.transaction() as conn:
                await conn.execute(text("INSERT INTO biz VALUES ('no-intent')"))
                await conn.execute(text("DROP TABLE audit_outbox"))  # the outbox is unavailable
                await enqueue(conn, build_intent("test-service", module="m", action="a", entity_type="e"))
        async with self.svc.begin() as conn:
            for statement in OUTBOX_DDL:  # restore for the following tests
                await conn.execute(text(statement))
        self.assertEqual(await self.svc_rows("SELECT * FROM biz WHERE id = 'no-intent'"), [])

    async def test_intents_take_actor_and_correlation_from_the_request_context(self):
        ctx = AuditContext(actor_id="u-7", actor_type="USER", actor_role="Underwriter", actor_name="U Seven", tenant_id=uuid4(), correlation_id="req-9")
        with audit_context(**ctx.__dict__):
            built = build_intent("test-service", module="policies", action="policy.issued", entity_type="policy")
        self.assertEqual((built.actor_id, built.actor_role, built.correlation_id, built.tenant_id), ("u-7", "Underwriter", "req-9", ctx.tenant_id))
        self.assertEqual(built.metadata["actor_name"], "U Seven")
        outside = build_intent("test-service", module="m", action="a", entity_type="e")
        self.assertEqual((outside.actor_type, outside.actor_id), ("SYSTEM", None))


class RelayTests(OutboxCase):
    async def queue(self, n, tenant=None):
        tenant = tenant or uuid4()
        intents = [build_intent("test-service", module="policies", action="policy.issued", entity_type="policy", entity_id=i, tenant_id=tenant) for i in range(n)]
        for built in intents:
            async with self.transaction() as conn:
                await enqueue(conn, built)
        return tenant, intents

    def relay(self, publisher, **kw):
        return OutboxRelay(self.transaction, publisher, **kw)

    async def test_publishes_oldest_first_and_marks_published(self):
        _, intents = await self.queue(4)
        publisher = FakePublisher()
        self.assertEqual(await self.relay(publisher).relay_once(), 4)
        self.assertEqual([json.loads(v)["source_event_id"] for _, v in publisher.sent], [i.source_event_id for i in intents])
        self.assertEqual(await self.relay(publisher).relay_once(), 0)
        self.assertEqual(len(await self.svc_rows("SELECT * FROM audit_outbox WHERE published_at IS NULL")), 0)

    async def test_kafka_unavailable_then_recovered_loses_nothing_and_keeps_order(self):
        _, intents = await self.queue(3)
        publisher = FakePublisher()
        relay = self.relay(publisher)
        publisher.fail = True
        self.assertEqual(await relay.relay_once(), 0)
        self.assertEqual(await relay.relay_once(), 0)
        stats = await relay.stats()
        self.assertEqual((stats["pending"], stats["consecutive_publish_failures"]), (3, 2))
        self.assertIn("broker unavailable", stats["last_error"])
        [first, *_] = await self.svc_rows("SELECT publish_attempts, last_error FROM audit_outbox ORDER BY created_at, id")
        self.assertGreaterEqual(first["publish_attempts"], 1)
        publisher.fail = False
        self.assertEqual(await relay.relay_once(), 3)
        self.assertEqual([json.loads(v)["source_event_id"] for _, v in publisher.sent], [i.source_event_id for i in intents])
        stats = await relay.stats()
        self.assertEqual((stats["pending"], stats["consecutive_publish_failures"], stats["last_error"]), (0, 0, None))

    async def test_a_failure_part_way_keeps_only_the_unsent_pending(self):
        await self.queue(5)
        publisher = FakePublisher()
        publisher.fail_after = 2
        relay = self.relay(publisher)
        self.assertEqual(await relay.relay_once(), 2)
        self.assertEqual((await relay.stats())["pending"], 3)
        publisher.fail_after = None
        self.assertEqual(await relay.relay_once(), 3)
        self.assertEqual(len(publisher.sent), 5)

    async def test_two_relays_never_publish_the_same_row(self):
        await self.queue(30)
        a, b = FakePublisher(), FakePublisher()
        await asyncio.gather(self.relay(a, batch=10).relay_once(), self.relay(b, batch=10).relay_once(),
                             self.relay(a, batch=10).relay_once(), self.relay(b, batch=10).relay_once())
        ids = [json.loads(v)["source_event_id"] for _, v in a.sent + b.sent]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(ids), 30)

    async def test_stats_report_undelivered_intents(self):
        await self.queue(2)
        stats = await self.relay(FakePublisher()).stats()
        self.assertEqual((stats["pending"], stats["failing"]), (2, 0))
        self.assertGreaterEqual(stats["oldest_pending_seconds"], 0)

    async def test_published_rows_are_pruned_after_retention(self):
        await self.queue(2)
        relay = self.relay(FakePublisher(), prune_after_days=7)
        await relay.relay_once()
        async with self.svc.begin() as conn:
            await conn.execute(text("UPDATE audit_outbox SET published_at = now() - interval '30 days'"))
        self.assertEqual(await relay.prune(), 2)

    async def test_run_loop_survives_a_broker_outage(self):
        await self.queue(2)
        publisher = FakePublisher()
        publisher.fail = True
        relay = self.relay(publisher, interval=0.05)
        stop = asyncio.Event()
        task = asyncio.create_task(relay.run(stop))
        await asyncio.sleep(0.3)
        self.assertEqual(publisher.sent, [])
        publisher.fail = False
        await asyncio.sleep(2.5)  # backoff after the failures is bounded, then it drains
        stop.set()
        await task
        self.assertEqual(len(publisher.sent), 2)


class EndToEndWithoutKafkaTests(OutboxCase):
    async def test_outbox_to_ledger_survives_redelivery_and_reordering(self):
        tenant = uuid4()
        for n in range(5):
            async with self.transaction() as conn:
                await enqueue(conn, build_intent("test-service", module="policies", action="policy.issued", entity_type="policy", entity_id=n,
                                                 tenant_id=tenant, occurred_at=datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=n)))
        publisher = FakePublisher()
        await OutboxRelay(self.transaction, publisher).relay_once()
        wire = [Message(AUDIT_EVENTS_TOPIC, 0, off, k, v.encode()) for off, (k, v) in enumerate(publisher.sent)]
        consumer = AuditConsumer("unused", "test")
        await consumer.process_messages(list(reversed(wire)))   # delivered out of order
        await consumer.process_messages(wire)                   # and redelivered
        rows = await self.fetch("SELECT entity_id, sequence_number FROM events WHERE tenant_id = :t ORDER BY sequence_number", t=tenant)
        self.assertEqual([r["entity_id"] for r in rows], ["4", "3", "2", "1", "0"])   # ledger order = commit order, not Kafka's or the clock's
        self.assertEqual((consumer.stats.appended, consumer.stats.duplicates), (5, 5))
        self.assertEqual((await chain_verifier.verify_chain(await self.chain_id(tenant))).status, "VALID")


class ConsumerTests(LedgerCase):
    async def test_messages_become_ledger_events(self):
        tenant = uuid4()
        consumer = AuditConsumer("unused", "test")
        await consumer.process_messages([message(intent(tenant, n), n) for n in range(3)])
        self.assertEqual(len(await self.fetch("SELECT 1 FROM events WHERE tenant_id = :t", t=tenant)), 3)
        self.assertEqual((consumer.stats.consumed, consumer.stats.appended), (3, 3))

    async def test_redelivery_is_idempotent(self):
        tenant = uuid4()
        batch = [message(intent(tenant, n), n) for n in range(3)]
        consumer = AuditConsumer("unused", "test")
        await consumer.process_messages(batch)
        await consumer.process_messages(batch)
        self.assertEqual(len(await self.fetch("SELECT 1 FROM events WHERE tenant_id = :t", t=tenant)), 3)
        self.assertEqual(consumer.stats.duplicates, 3)

    async def test_poison_messages_are_dead_lettered_and_do_not_block_the_rest(self):
        tenant = uuid4()
        good = message(intent(tenant, 1), 3)
        junk = [Message(AUDIT_EVENTS_TOPIC, 0, 1, None, b"not json"), Message(AUDIT_EVENTS_TOPIC, 0, 2, "k", b'{"source_service": "x"}')]
        consumer = AuditConsumer("unused", "test")
        await consumer.process_messages([junk[0], junk[1], good])
        self.assertEqual(len(await self.fetch("SELECT 1 FROM events WHERE tenant_id = :t", t=tenant)), 1)
        dead = await self.fetch("SELECT msg_offset, error_code FROM dead_letters ORDER BY msg_offset")
        self.assertEqual([(d["msg_offset"], d["error_code"]) for d in dead if d["msg_offset"] in (1, 2)], [(1, "INVALID_MESSAGE"), (2, "INVALID_MESSAGE")])
        await consumer.process_messages([junk[0]])   # the same poison message again does not duplicate its dead letter
        self.assertEqual(len([d for d in await self.fetch("SELECT 1 FROM dead_letters WHERE msg_offset = 1")]), 1)

    async def test_a_source_id_reused_across_tenants_is_dead_lettered(self):
        a, b = uuid4(), uuid4()
        consumer = AuditConsumer("unused", "test")
        await consumer.process_messages([message(intent(a, 1, source_event_id="reused"), 10)])
        await consumer.process_messages([message(intent(b, 1, source_event_id="reused"), 11)])
        self.assertEqual([r["error_code"] for r in await self.fetch("SELECT error_code FROM dead_letters WHERE msg_offset = 11")], ["SOURCE_EVENT_ID_REUSED"])
        self.assertEqual(await self.fetch("SELECT 1 FROM events WHERE tenant_id = :t", t=b), [])

    async def test_database_outage_is_not_dead_lettering_and_recovers(self):
        tenant = uuid4()
        batch = [message(intent(tenant, n), 20 + n) for n in range(3)]
        consumer = AuditConsumer("unused", "test")
        outage = OperationalError("stmt", {}, ConnectionResetError("server closed the connection"))
        with mock.patch.object(audit_service, "ingest", side_effect=outage):
            with self.assertRaises(OperationalError):
                await consumer.process_messages(batch)
        self.assertEqual(consumer.stats.dead_lettered, 0)
        self.assertEqual(await self.fetch("SELECT 1 FROM events WHERE tenant_id = :t", t=tenant), [])
        await consumer.process_messages(batch)                  # the broker redelivers from the last committed offset
        self.assertEqual(len(await self.fetch("SELECT 1 FROM events WHERE tenant_id = :t", t=tenant)), 3)

    async def test_a_non_transient_batch_failure_is_isolated_message_by_message(self):
        tenant = uuid4()
        batch = [message(intent(tenant, n), 30 + n) for n in range(3)]
        real = audit_service.ingest
        calls = {"n": 0}

        async def flaky(intents, transaction=None):
            calls["n"] += 1
            if len(intents) > 1:
                raise DataError("stmt", {}, Exception("invalid input"))
            if intents[0].entity_id == "POL-1":
                raise DataError("stmt", {}, Exception("this one can never be stored"))
            return await real(intents, transaction)

        consumer = AuditConsumer("unused", "test")
        with mock.patch.object(audit_service, "ingest", flaky):
            await consumer.process_messages(batch)
        stored = await self.fetch("SELECT entity_id FROM events WHERE tenant_id = :t ORDER BY sequence_number", t=tenant)
        self.assertEqual([r["entity_id"] for r in stored], ["POL-0", "POL-2"])
        self.assertEqual([r["error_code"] for r in await self.fetch("SELECT error_code FROM dead_letters WHERE msg_offset = 31")], ["APPEND_FAILED"])

    async def test_status_reports_counters(self):
        consumer = AuditConsumer("unused", "test")
        await consumer.process_messages([message(intent(uuid4(), 1), 40)])
        status = consumer.status()
        self.assertEqual((status["consumed"], status["appended"], status["running"], status["total_lag"]), (1, 1, False, 0))
