"""Request Management -> Audit Service: every audit event is mirrored by an audit intent in the same transaction.

Run (see support.py):
    docker compose run --rm --no-deps -e REQUEST_MGMT_DB_OWNER_PASSWORD=... -e REQUEST_MGMT_DB_APP_PASSWORD=... \
        request-management-service python -m unittest tests.test_audit_outbox -v
"""
import asyncio
import json

from sqlalchemy import text

from app import db, service
from app.errors import ApiError
from shared.audit.outbox import OutboxRelay
from shared.audit.schema import AuditIntent
from tests.support import create_database, drop_database
from tests.test_requests import World


def setUpModule():
    asyncio.run(create_database())


def tearDownModule():
    asyncio.run(drop_database())


class FakePublisher:
    def __init__(self):
        self.sent = []

    async def publish(self, key, value):
        self.sent.append((key, value))


class AuditOutboxTests(World):
    async def intents(self, tenant):
        async with db.transaction() as conn:
            rows = (await conn.execute(text("SELECT payload FROM audit_outbox WHERE tenant_id = :t ORDER BY created_at, id"), {"t": tenant})).all()
        return [AuditIntent.model_validate(r[0]) for r in rows]

    async def test_every_audit_event_has_a_matching_intent(self):
        rid = await self.correction()
        async with db.transaction() as conn:
            events = (await conn.execute(text("SELECT event_type FROM audit_events WHERE tenant_id = :t ORDER BY created_at, id"), {"t": self.tenant_a})).all()
        intents = await self.intents(self.tenant_a)
        self.assertEqual([f"request.{e[0].lower()}" for e in events], [i.action for i in intents])
        created = next(i for i in intents if i.action == "request.created")
        self.assertEqual((created.entity_type, created.entity_id, created.module, created.source_service), ("request", str(rid), "customers_leads", "request-management"))
        submitted = next(i for i in intents if i.action == "request.submitted")
        self.assertEqual((submitted.actor_role, submitted.actor_type, submitted.new_value.get("review_status")), ("Agent", "USER", "SUBMITTED"))
        self.assertEqual(submitted.metadata["actor_name"], "Ali Agent")
        rule = next(i for i in intents if i.action == "request.routing_rule_created")
        self.assertEqual((rule.entity_type, rule.actor_role), ("routing_rule", "Admin"))

    async def test_intents_stay_inside_their_tenant(self):
        await self.correction()
        other = await self.intents(self.tenant_b)
        self.assertEqual(other, [])

    async def test_a_rolled_back_action_leaves_no_audit_intent(self):
        me = await self.me(self.agent)
        before = len(await self.intents(self.tenant_a))
        with self.assertRaises(ApiError):
            await service.create_draft(me, {"request_type": "customer_profile_correction", "title": "x", "payload": {"customer_id": "not-a-uuid"}}, None)
        self.assertEqual(len(await self.intents(self.tenant_a)), before)

    async def test_the_relay_publishes_them_and_the_payload_is_sanitized(self):
        await self.correction(changes={"contact.email": "secret.person@example.test"})
        publisher = FakePublisher()
        relay = OutboxRelay(db.transaction, publisher)
        while await relay.relay_once():
            pass
        self.assertTrue(publisher.sent)
        mine = [json.loads(v) for key, v in publisher.sent if key == str(self.tenant_a)]
        self.assertTrue(mine)
        self.assertTrue(all(m["tenant_id"] == str(self.tenant_a) for m in mine))
        self.assertEqual((await relay.stats())["pending"], 0)
        self.assertNotIn("secret.person@example.test", json.dumps(mine))
