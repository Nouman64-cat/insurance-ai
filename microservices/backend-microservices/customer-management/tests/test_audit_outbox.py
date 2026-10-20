"""Customer Management -> Audit Service: every security event is mirrored by an audit intent, in the same transaction."""
import json

from sqlalchemy import text

from app import db
from shared.audit.outbox import OutboxRelay
from shared.audit.schema import AuditIntent
from tests.support import NEW_PASSWORD, TEMP_PASSWORD, Base


class FakePublisher:
    def __init__(self):
        self.sent = []

    async def publish(self, key, value):
        self.sent.append((key, value))


class AuditOutbox(Base):
    async def intents(self) -> list[AuditIntent]:
        async with db.transaction() as conn:
            rows = (await conn.execute(text("SELECT payload FROM audit_outbox ORDER BY created_at, id"))).all()
        return [AuditIntent.model_validate(r[0]) for r in rows]

    async def security_kinds(self) -> list[str]:
        async with db.transaction() as conn:
            return [r[0] for r in (await conn.execute(text("SELECT kind FROM security_events ORDER BY at, id"))).all()]

    async def test_every_security_event_has_a_matching_intent(self):
        await self.provision_account()
        await self.login(password="wrong-password")
        ok = await self.login()
        self.assertEqual(ok.status_code, 200, ok.text)
        kinds = await self.security_kinds()
        intents = await self.intents()
        self.assertEqual([f"customer_portal.{k.lower()}" for k in kinds], [i.action for i in intents])
        failed = next(i for i in intents if i.action == "customer_portal.login_failed")
        self.assertEqual((failed.outcome, failed.module, failed.entity_type), ("FAILURE", "administration", "customer_portal_account"))
        success = next(i for i in intents if i.action == "customer_portal.login_success")
        self.assertEqual((success.outcome, success.actor_type, success.tenant_id, success.source_service),
                         ("SUCCESS", "CUSTOMER", self.tenant_id, "customer-management"))
        self.assertEqual(success.actor_id, success.entity_id)

    async def test_no_credential_ever_appears_in_an_intent(self):
        await self.provision_account()
        await self.login(password="wrong-password")
        await self.login()
        wire = json.dumps([i.model_dump(mode="json") for i in await self.intents()])
        for secret in (TEMP_PASSWORD, "wrong-password", NEW_PASSWORD):
            self.assertNotIn(secret, wire)

    async def test_intents_are_deliverable(self):
        await self.provision_account()
        await self.login()
        publisher = FakePublisher()
        relay = OutboxRelay(db.transaction, publisher)
        while await relay.relay_once():
            pass
        self.assertTrue(publisher.sent)
        self.assertEqual({k for k, _ in publisher.sent}, {str(self.tenant_id)})
        self.assertEqual((await relay.stats())["pending"], 0)

    async def test_the_application_role_still_cannot_change_security_events(self):
        await self.provision_account()
        with self.assertRaises(Exception):
            async with db.transaction() as conn:
                await conn.execute(text("UPDATE security_events SET kind = 'X'"))
