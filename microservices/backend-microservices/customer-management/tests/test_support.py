"""Support tickets from the customer portal: the customer is identified by the session, a linked policy must be theirs, and the
browser can set nothing but the ticket's words, category and policy."""
from unittest.mock import patch
from uuid import uuid4

from app.routers import support
from tests.support import Base


class Support(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.calls = []

        async def fake(p, method, path, body=None, operation_key=None):
            self.operation_key = operation_key
            self.calls.append((method, path, body, str(p.customer_id)))
            return {"items": []} if method == "GET" and path == support.BASE else {"id": str(uuid4()), "status": "OPEN", "events": []}
        self.patch = patch.object(support, "_call", fake)
        self.patch.start()

    async def asyncTearDown(self):
        self.patch.stop()
        await super().asyncTearDown()

    def body(self, **kw):
        return {"title": "Update my address", "description": "I moved house last month", "category": "POLICY_SERVICING", **kw}

    async def test_requires_a_customer_session(self):
        self.assertEqual((await self.client.get("/v1/support/tickets")).status_code, 401)
        self.assertEqual((await self.client.post("/v1/support/tickets", json=self.body())).status_code, 401)

    async def test_create_needs_a_key_and_ignores_nothing_it_should_refuse(self):
        token, _ = await self.active_session()
        h = self.bearer(token)
        self.assertEqual((await self.client.post("/v1/support/tickets", json=self.body(), headers=h)).status_code, 400)                       # no key
        key = {**h, "idempotency-key": str(uuid4())}
        for extra in ({"priority": "URGENT"}, {"customer_id": str(uuid4())}, {"internal": True}):
            self.assertEqual((await self.client.post("/v1/support/tickets", json=self.body(**extra), headers=key)).status_code, 422, extra)    # not the browser's to set
        self.assertEqual((await self.client.post("/v1/support/tickets", json=self.body(title="x"), headers=key)).status_code, 422)
        ok = await self.client.post("/v1/support/tickets", json=self.body(), headers=key)
        self.assertEqual(ok.status_code, 200)
        method, path, sent, cust = self.calls[-1]
        self.assertEqual((method, path, cust), ("POST", support.BASE, str(self.customer_id)))                                                  # the account's customer
        self.assertNotIn("idempotency_key", sent)
        self.assertEqual(self.operation_key, key["idempotency-key"])

    async def test_a_policy_must_belong_to_the_customer(self):
        token, _ = await self.active_session()
        h = {**self.bearer(token), "idempotency-key": str(uuid4())}
        pid = uuid4()
        r = await self.client.post("/v1/support/tickets", json=self.body(policy_id=str(pid)), headers=h)
        self.assertEqual(r.status_code, 404)                                                                                                     # the adapter has no such policy for them
        self.fake.routes[f"/policies/{pid}"] = {"id": str(pid)}
        r = await self.client.post("/v1/support/tickets", json=self.body(policy_id=str(pid)), headers=h)
        self.assertEqual(r.status_code, 200)

    async def test_reply_and_withdraw_only_take_words(self):
        token, _ = await self.active_session()
        h, tid = self.bearer(token), uuid4()
        self.assertEqual((await self.client.post(f"/v1/support/tickets/{tid}/reply", json={"body": "Thanks", "internal": True}, headers=h)).status_code, 422)
        self.assertEqual((await self.client.post(f"/v1/support/tickets/{tid}/reply", json={"body": "Thanks"}, headers=h)).status_code, 200)
        self.assertEqual((await self.client.post(f"/v1/support/tickets/{tid}/withdraw", headers=h)).status_code, 200)
