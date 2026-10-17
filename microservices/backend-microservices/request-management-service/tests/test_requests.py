"""Request Management behaviour against a real (disposable) database. See support.py for how to run."""
import asyncio
import json
import unittest
import uuid
from uuid import UUID

import httpx
from sqlalchemy import text

from app import db, live, queries, routing, routing_admin, service, workers, attachments
from app.types.registry import get_type
from app.config import settings
from app.errors import ApiError
from app.main import app
from tests.support import FakeTenantService, create_database, drop_database, install, url, APP_PW, TEST_DB, who

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def setUpModule():
    asyncio.run(create_database())


def tearDownModule():
    asyncio.run(drop_database())


class MemoryStorage(attachments.Storage):
    def __init__(self):
        self.files = {}

    async def put(self, key, data, content_type):
        self.files[key] = data

    async def get(self, key):
        return self.files[key]


class World(unittest.IsolatedAsyncioTestCase):
    """Two tenants. Tenant A: an admin, two underwriters, two agents. Tenant B: an admin and an agent."""

    async def asyncSetUp(self):
        db.configure(url("request_mgmt_app", APP_PW, TEST_DB))
        async with db.transaction() as conn:   # each test starts with an empty outbox and no due work from earlier tests
            await conn.execute(text("UPDATE request_management.outbox_events SET published_at = now() WHERE published_at IS NULL"))
            await conn.execute(text("UPDATE request_management.executions SET next_attempt_at = NULL, lease_until = NULL WHERE status IN ('PENDING', 'RUNNING')"))
            await conn.execute(text("UPDATE request_management.requests SET last_reminder_at = now() WHERE due_at < now()"))
        self.fake = FakeTenantService()
        install(self.fake)
        attachments.set_storage(MemoryStorage())
        self.tenant_a, self.tenant_b = uuid.uuid4(), uuid.uuid4()
        f = self.fake
        self.admin = f.add_user(self.tenant_a, "Admin", "Amina Admin")
        self.uw1 = f.add_user(self.tenant_a, "Underwriter", "Umar Underwriter")
        self.uw2 = f.add_user(self.tenant_a, "Underwriter", "Usman Underwriter")
        self.agent = f.add_user(self.tenant_a, "Agent", "Ali Agent")
        self.agent2 = f.add_user(self.tenant_a, "Agent", "Asma Agent")
        self.admin_b = f.add_user(self.tenant_b, "Admin", "Bilal Admin")
        self.agent_b = f.add_user(self.tenant_b, "Agent", "Bushra Agent")
        self.customer = f.add_customer(self.tenant_a, [self.agent, self.uw1, self.admin])
        self.earning = f.add_earning(self.tenant_a, [self.agent])
        admin = await who(f, self.admin)
        # Corrections go to the underwriter team; general requests to a named underwriter; disputes to admins.
        await routing_admin.create_rule(admin, {"request_type": "customer_profile_correction", "target_kind": "ROLE", "target_role": "Underwriter", "sla_hours": 24})
        await routing_admin.create_rule(admin, {"request_type": "general", "target_kind": "USER", "target_user_id": str(f.uid(self.uw1))})
        await routing_admin.create_rule(admin, {"request_type": "commission_dispute", "target_kind": "ROLE", "target_role": "Admin"})

    async def asyncTearDown(self):
        await db.dispose()

    # helpers
    async def me(self, token):
        return await who(self.fake, token)

    async def detail(self, token, rid):
        return await queries.detail(await self.me(token), rid)

    async def correction(self, token=None, changes=None, submit=True):
        token = token or self.agent
        me = await self.me(token)
        rid = await service.create_draft(me, {"request_type": "customer_profile_correction", "title": "Fix email",
                                              "payload": {"customer_id": str(self.customer), "changes": changes or {"contact.email": "new@example.test"},
                                                          "reason": "Customer changed their email address"}}, None)
        if submit:
            d = await self.detail(token, rid)
            await service.submit(me, rid, {"expected_version": d["version"]}, None)
        return rid

    async def claim(self, token, rid):
        d = await self.detail(token, rid)
        await service.start_review(await self.me(token), rid, {"expected_version": d["version"]})
        return await self.detail(token, rid)

    async def approve(self, token, rid, **extra):
        d = await self.detail(token, rid)
        body = {"expected_version": d["version"], "revision_no": d["submitted_revision_no"], "reason": "Looks right", **extra}
        await service.decide(await self.me(token), rid, "APPROVED", body, None)
        return await self.detail(token, rid)

    async def run_outbox(self):
        """Deliver every pending outbox event to both consumers, as the Kafka path would."""
        delivered = []

        class Collect(workers.Publisher):
            async def publish(self, key, value):
                delivered.append(json.loads(value))

        while await workers.relay_once(Collect()):
            pass
        for event in delivered:
            await workers.handle("executor", event)
            await workers.handle("notifier", event)
        return delivered

    async def expect(self, coro, code):
        with self.assertRaises(ApiError) as ctx:
            await coro
        self.assertEqual(ctx.exception.code, code, ctx.exception.message)
        return ctx.exception


class TenantIsolationAndSpoofing(World):
    async def test_other_tenant_cannot_see_or_act(self):
        rid = await self.correction()
        await self.expect(self.detail(self.admin_b, rid), "NOT_FOUND")
        await self.expect(queries.timeline(await self.me(self.agent_b), rid), "NOT_FOUND")
        listed = await queries.list_requests(await self.me(self.admin_b), "tenant", {}, 1, 50)
        self.assertEqual(listed["total"], 0)
        await self.expect(service.cancel(await self.me(self.admin_b), rid, {"expected_version": 1, "reason": "not mine"}), "NOT_FOUND")

    async def test_spoofed_tenant_header_and_body_fields_are_rejected_or_ignored(self):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            h = {"Authorization": f"Bearer {self.agent}"}
            r = await client.get("/v1/summary", headers={**h, "X-Tenant-Id": str(self.tenant_b)})
            self.assertEqual(r.status_code, 403)
            self.assertEqual(r.json()["error"]["code"], "TENANT_MISMATCH")
            # requester and role in the body are not fields of the API: the session decides.
            r = await client.post("/v1/requests", headers=h, json={"request_type": "general", "title": "Need access",
                                  "requester_id": str(self.fake.uid(self.admin)), "role": "Admin",
                                  "payload": {"category": "ACCESS", "description": "Please grant report access"}})
            self.assertEqual(r.status_code, 201, r.text)
            self.assertEqual(r.json()["requester_id"], str(self.fake.uid(self.agent)))
            self.assertEqual(r.json()["requester_role"], "Agent")
            r = await client.get("/v1/routing-rules", headers=h)
            self.assertEqual(r.status_code, 403)
            r = await client.get("/v1/summary", headers={"Authorization": "Bearer forged-token-forged-token"})
            self.assertEqual(r.status_code, 401)
            self.assertEqual(r.json()["error"]["code"], "UNAUTHENTICATED")

    async def test_revoked_and_inactive_users_are_refused(self):
        self.fake.me_status[self.agent] = 401          # revoked / expired at the source
        await self.expect(self.me(self.agent), "UNAUTHENTICATED")
        inactive = self.fake.add_user(self.tenant_a, "Agent", active=False)
        await self.expect(self.me(inactive), "ACCOUNT_INACTIVE")
        superadmin = self.fake.add_user(self.tenant_a, "SuperAdmin")
        self.fake.me_by_token[superadmin]["tenant_id"] = None
        await self.expect(self.me(superadmin), "NO_TENANT")


class SeparationOfDuties(World):
    async def test_requester_cannot_approve_own_request_even_as_admin(self):
        # An admin files a dispute; disputes route to admins. With only one admin, routing refuses rather than route to them.
        me = await self.me(self.admin)
        self.fake.access[self.admin].add(self.earning)
        rid = await service.create_draft(me, {"request_type": "commission_dispute", "title": "Wrong rate",
                                              "payload": {"earning_id": str(self.earning), "dispute_kind": "RATE", "explanation": "Rate should be 12 percent"}}, None)
        err = await self.expect(service.submit(me, rid, {"expected_version": 1}, None), "ROUTING_FAILED")
        self.assertIn("other than you", err.message)
        self.assertEqual((await self.detail(self.admin, rid))["review_status"], "DRAFT")   # kept as a draft
        # Force the request onto its own requester (as a bad data fix might) and try to decide: still refused.
        async with db.transaction() as conn:
            await conn.execute(text("UPDATE request_management.requests SET review_status='IN_REVIEW', assignee_user_id=requester_id, submitted_revision_no=1 WHERE id=:id"), {"id": rid})
        d = await self.detail(self.admin, rid)
        self.assertNotIn("approve", d["allowed_actions"])
        await self.expect(service.decide(me, rid, "APPROVED", {"expected_version": d["version"], "revision_no": 1, "reason": "fine", "resolution": "UPHELD"}, None), "SELF_APPROVAL")

    async def test_unauthorized_queue_access_and_reassignment(self):
        rid = await self.correction()
        agent2 = await self.me(self.agent2)
        await self.expect(self.detail(self.agent2, rid), "NOT_FOUND")             # another agent's request
        await self.expect(queries.list_requests(agent2, "tenant", {}, 1, 20), "ADMIN_ONLY")
        self.assertEqual((await queries.list_requests(agent2, "review", {}, 1, 20))["total"], 0)
        d = await self.detail(self.uw1, rid)
        self.assertTrue(d["viewer"]["in_queue"])
        await self.expect(service.reassign(await self.me(self.uw1), rid, {"expected_version": d["version"], "target_user_id": str(self.fake.uid(self.uw2)), "reason": "busy today"}), "ACTION_NOT_ALLOWED")
        # Admin reassignment: never to the requester, never to someone outside the tenant.
        admin = await self.me(self.admin)
        await self.expect(service.reassign(admin, rid, {"expected_version": d["version"], "target_user_id": str(self.fake.uid(self.agent)), "reason": "try it"}), "SELF_APPROVAL")
        await self.expect(service.reassign(admin, rid, {"expected_version": d["version"], "target_user_id": str(self.fake.uid(self.admin_b)), "reason": "try it"}), "VALIDATION")
        await service.reassign(admin, rid, {"expected_version": d["version"], "target_user_id": str(self.fake.uid(self.uw2)), "reason": "Umar is on leave"})
        d = await self.detail(self.uw2, rid)
        self.assertEqual(d["assignee_user_id"], str(self.fake.uid(self.uw2)))
        self.assertEqual([e["reason"] for e in await queries.timeline(await self.me(self.agent), rid) if e["event_type"] == "REASSIGNED"], [None])  # internal reason hidden


class ChosenReviewer(World):
    async def test_requester_may_name_a_reviewer_only_from_the_routed_team(self):
        me = await self.me(self.agent)
        async with db.transaction() as conn:
            preview = await routing.options(conn, self.tenant_a, get_type("customer_profile_correction"), me.branch_id, me.user_id)
        self.assertEqual(preview["queue_role"], "Underwriter")
        self.assertEqual({r["full_name"] for r in preview["reviewers"]}, {"Umar Underwriter", "Usman Underwriter"})

        rid = await self.correction(submit=False)
        # Outside the team (an admin), a stranger, and garbage are all refused; the request stays a draft.
        for bad, code in ((str(self.fake.uid(self.admin)), "ROUTING_FAILED"), (str(self.fake.uid(self.admin_b)), "ROUTING_FAILED"),
                          (str(self.fake.uid(self.agent)), "ROUTING_FAILED"), ("not-an-id", "VALIDATION")):
            await self.expect(service.submit(me, rid, {"expected_version": 1, "reviewer_id": bad}, None), code)
        self.assertEqual((await self.detail(self.agent, rid))["review_status"], "DRAFT")

        uw2 = str(self.fake.uid(self.uw2))
        await service.submit(me, rid, {"expected_version": 1, "reviewer_id": uw2}, None)
        d = await self.detail(self.uw2, rid)
        self.assertEqual((d["assignee_user_id"], d["queue_role"]), (uw2, "Underwriter"))   # straight to them, still the team's
        await self.expect(self.detail(self.uw1, rid), "NOT_FOUND")                       # not up for grabs by the rest of the team
        d = await self.claim(self.uw2, rid)
        await service.release(await self.me(self.uw2), rid, {"expected_version": d["version"]})
        self.assertTrue((await self.detail(self.uw1, rid))["viewer"]["in_queue"])        # released back to the team

    async def test_named_reviewer_rule_accepts_only_that_reviewer(self):
        me = await self.me(self.agent)
        rid = await service.create_draft(me, {"request_type": "general", "title": "Need a letter",
                                              "payload": {"category": "OTHER", "description": "Please issue a letter for the customer"}}, None)
        await self.expect(service.submit(me, rid, {"expected_version": 1, "reviewer_id": str(self.fake.uid(self.uw2))}, None), "ROUTING_FAILED")
        await service.submit(me, rid, {"expected_version": 1, "reviewer_id": str(self.fake.uid(self.uw1))}, None)
        self.assertEqual((await self.detail(self.uw1, rid))["assignee_user_id"], str(self.fake.uid(self.uw1)))


class LiveUpdates(World):
    async def asyncTearDown(self):
        await live.hub.stop()
        await super().asyncTearDown()

    async def test_each_subscriber_learns_only_what_they_may_see(self):
        rid = await self.correction()
        notice = {"tenant_id": str(self.tenant_a), "request_id": str(rid)}
        kind, data = await live.view(await self.me(self.agent), notice)
        self.assertEqual((kind, data["review_status"]), ("request", "SUBMITTED"))
        self.assertIsNone(await live.view(await self.me(self.agent2), notice))      # someone else's request
        self.assertIsNone(await live.view(await self.me(self.admin_b), notice))     # another tenant
        await self.claim(self.uw1, rid)
        self.assertEqual((await live.view(await self.me(self.uw1), notice))[1]["review_status"], "IN_REVIEW")
        self.assertEqual(await live.view(await self.me(self.uw2), notice), ("queue", {}))   # claimed: only "the queue changed"

    async def test_committed_changes_reach_subscribers_of_that_tenant_only(self):
        async with live.hub.subscribe(self.tenant_a) as mine, live.hub.subscribe(self.tenant_b) as theirs:
            await asyncio.sleep(0.5)                       # let the listener connect
            rid = await self.correction()
            notices = []
            while True:
                try:
                    notices.append(await asyncio.wait_for(mine.get(), timeout=2))
                except asyncio.TimeoutError:
                    break
            self.assertIn("SUBMITTED", [n["review_status"] for n in notices if n.get("request_id") == str(rid)])
            self.assertTrue(theirs.empty())


class Lifecycle(World):
    async def test_invalid_transitions_are_rejected(self):
        rid = await self.correction(submit=False)
        me = await self.me(self.agent)
        await self.expect(service.decide(await self.me(self.uw1), rid, "APPROVED", {"expected_version": 1, "revision_no": 1, "reason": "ok"}, None), "NOT_FOUND")  # reviewers can't see drafts
        await service.submit(me, rid, {"expected_version": 1}, None)
        d = await self.detail(self.uw1, rid)
        await self.expect(service.decide(await self.me(self.uw1), rid, "APPROVED", {"expected_version": d["version"], "revision_no": 1, "reason": "ok"}, None), "INVALID_TRANSITION")  # not claimed yet
        await self.claim(self.uw1, rid)
        await self.approve(self.uw1, rid)
        d = await self.detail(self.agent, rid)
        await self.expect(service.cancel(me, rid, {"expected_version": d["version"], "reason": "too late now"}), "INVALID_TRANSITION")
        await self.expect(service.start_review(await self.me(self.uw1), rid, {"expected_version": d["version"]}), "INVALID_TRANSITION")

    async def test_approval_uses_the_exact_reviewed_revision(self):
        rid = await self.correction()
        d = await self.claim(self.uw1, rid)
        uw = await self.me(self.uw1)
        await service.request_information(uw, rid, {"expected_version": d["version"], "revision_no": 1, "message": "Please confirm the domain spelling"})
        d = await self.detail(self.agent, rid)
        me = await self.me(self.agent)
        await service.update_draft(me, rid, {"expected_version": d["version"], "payload": {"customer_id": str(self.customer), "changes": {"contact.email": "fixed@example.test"}, "reason": "Corrected the typo in the domain"}})
        d = await self.detail(self.agent, rid)
        self.assertEqual(d["current_revision_no"], 2)
        await service.resubmit(me, rid, {"expected_version": d["version"], "response": "Fixed the spelling"}, None)
        d = await self.claim(self.uw1, rid)
        self.assertEqual(d["submitted_revision_no"], 2)
        # Approving what was seen earlier (revision 1) is refused.
        await self.expect(service.decide(uw, rid, "APPROVED", {"expected_version": d["version"], "revision_no": 1, "reason": "ok"}, None), "STALE_REVISION")
        d = await self.approve(self.uw1, rid)
        self.assertEqual(d["decision"]["revision_no"], 2)
        self.assertEqual(d["changes"][0]["after"], "fixed@example.test")
        async with db.transaction() as conn:   # revision 1 is immutable
            with self.assertRaises(Exception):
                await conn.execute(text("UPDATE request_management.request_revisions SET payload='{}' WHERE request_id=:r AND revision_no=1"), {"r": rid})

    async def test_concurrent_decisions_produce_one_result(self):
        rid = await self.correction()
        d = await self.claim(self.uw1, rid)
        uw = await self.me(self.uw1)
        body = {"expected_version": d["version"], "revision_no": 1, "reason": "Decided at the same time"}
        results = await asyncio.gather(service.decide(uw, rid, "APPROVED", dict(body), None),
                                       service.decide(uw, rid, "REJECTED", dict(body), None), return_exceptions=True)
        failures = [r for r in results if isinstance(r, ApiError)]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0].code, "STALE_VERSION")
        async with db.transaction() as conn:
            n = (await conn.execute(text("SELECT count(*) FROM request_management.decisions WHERE request_id=:r AND decision IN ('APPROVED','REJECTED')"), {"r": rid})).scalar()
        self.assertEqual(n, 1)

    async def test_duplicate_submission_and_execution_do_not_duplicate(self):
        rid = await self.correction(submit=False)
        me = await self.me(self.agent)
        await service.submit(me, rid, {"expected_version": 1}, "submit-key-123")
        await service.submit(me, rid, {"expected_version": 1}, "submit-key-123")   # retried by the client: replayed
        await self.expect(service.submit(me, rid, {"expected_version": 1}, None), "STALE_VERSION")      # a plain resend: refused, not resubmitted
        await self.expect(service.submit(me, rid, {"expected_version": 2}, None), "INVALID_TRANSITION")  # even with the current version
        await self.expect(service.submit(me, rid, {"expected_version": 2}, "submit-key-123"), "IDEMPOTENCY_CONFLICT")
        async with db.transaction() as conn:
            n = (await conn.execute(text("SELECT count(*) FROM request_management.audit_events WHERE request_id=:r AND event_type='SUBMITTED'"), {"r": rid})).scalar()
        self.assertEqual(n, 1)
        # Duplicate create with the same key returns the same draft.
        body = {"request_type": "general", "title": "Same thing", "payload": {"category": "OTHER", "description": "Just one of these please"}}
        self.assertEqual(await service.create_draft(me, body, "create-key-1"), await service.create_draft(me, body, "create-key-1"))
        # Execution: the same event delivered twice applies once.
        await self.claim(self.uw1, rid)
        await self.approve(self.uw1, rid)
        events = await self.run_outbox()
        execution_event = next(e for e in events if e["event_type"] == "request.execution_requested")
        await workers.handle("executor", execution_event)   # redelivery
        self.assertEqual(len(self.fake.correction_calls), 1)
        self.assertEqual((await self.detail(self.agent, rid))["execution_status"], "SUCCEEDED")
        self.assertEqual(self.fake.customers[self.customer]["details"]["contact"]["email"], "new@example.test")

    async def test_crash_after_domain_update_does_not_apply_twice(self):
        rid = await self.correction()
        await self.claim(self.uw1, rid)
        await self.approve(self.uw1, rid)
        original = workers.finish

        async def crash(*args, **kwargs):  # the domain change commits, then the worker dies before recording it
            raise RuntimeError("worker died")
        workers.finish = crash
        try:
            with self.assertRaises(RuntimeError):
                await self.run_outbox()
        finally:
            workers.finish = original
        async with db.transaction() as conn:   # lease expires
            await conn.execute(text("UPDATE request_management.executions SET lease_until = now() - interval '1 minute' WHERE request_id=:r"), {"r": rid})
        await workers.recover_expired_leases()
        async with db.transaction() as conn:
            await conn.execute(text("UPDATE request_management.executions SET next_attempt_at = now() WHERE request_id=:r"), {"r": rid})
        await workers.dispatch_due_retries()
        await self.run_outbox()
        self.assertEqual(len(self.fake.correction_calls), 2)                       # asked twice ...
        self.assertEqual(len(self.fake.corrections), 1)                            # ... applied once
        self.assertEqual((await self.detail(self.agent, rid))["execution_status"], "SUCCEEDED")

    async def test_customer_changed_since_review_is_a_conflict(self):
        rid = await self.correction()
        await self.claim(self.uw1, rid)
        await self.approve(self.uw1, rid)
        self.fake.customers[self.customer]["details"]["contact"]["email"] = "someone-else@example.test"
        await self.run_outbox()
        d = await self.detail(self.uw1, rid)
        self.assertEqual(d["review_status"], "APPROVED")
        self.assertEqual(d["execution_status"], "FAILED")
        self.assertEqual(d["execution"]["last_error_code"], "CONFLICT")
        self.assertNotIn("retry_execution", d["allowed_actions"])                   # never forced through
        self.assertIn("reopen_for_review", d["allowed_actions"])
        self.assertEqual(self.fake.customers[self.customer]["details"]["contact"]["email"], "someone-else@example.test")
        await service.reopen_for_review(await self.me(self.uw1), rid, {"expected_version": d["version"], "reason": "Email changed after review; please confirm"})
        d = await self.detail(self.agent, rid)
        self.assertEqual(d["review_status"], "NEEDS_INFORMATION")
        await service.resubmit(await self.me(self.agent), rid, {"expected_version": d["version"], "response": "Still want the new email"}, None)
        d = await self.claim(self.uw1, rid)
        self.assertEqual(d["changes"][0]["before"], "someone-else@example.test")    # reviewed against the current record
        await self.approve(self.uw1, rid)
        await self.run_outbox()
        self.assertEqual((await self.detail(self.agent, rid))["execution_status"], "SUCCEEDED")

    async def test_failed_execution_stays_visible_and_retries_safely(self):
        object.__setattr__(settings, "max_execution_attempts", 2)
        try:
            rid = await self.correction()
            await self.claim(self.uw1, rid)
            await self.approve(self.uw1, rid)
            self.fake.fail_next = [503, 503]
            await self.run_outbox()
            d = await self.detail(self.uw1, rid)
            self.assertEqual(d["execution_status"], "PENDING")                     # retry scheduled with backoff
            async with db.transaction() as conn:
                await conn.execute(text("UPDATE request_management.executions SET next_attempt_at = now() WHERE request_id=:r"), {"r": rid})
            await workers.dispatch_due_retries()
            await self.run_outbox()
            d = await self.detail(self.uw1, rid)
            self.assertEqual(d["execution_status"], "FAILED")
            self.assertEqual(d["execution"]["attempts"], 2)
            await self.expect(service.retry_execution(await self.me(self.agent), rid, {"expected_version": d["version"]}, None), "ACTION_NOT_ALLOWED")
            await service.retry_execution(await self.me(self.uw1), rid, {"expected_version": d["version"], "reason": "Tenant service is back"}, "retry-key-1")
            d2 = await self.detail(self.uw1, rid)
            await service.retry_execution(await self.me(self.uw1), rid, {"expected_version": d["version"], "reason": "Tenant service is back"}, "retry-key-1")  # replayed
            await self.run_outbox()
            d = await self.detail(self.agent, rid)
            self.assertEqual(d2["execution_status"], "PENDING")
            self.assertEqual(d["execution_status"], "SUCCEEDED")
            self.assertEqual(len(self.fake.corrections), 1)
            # Notifications for the failure reached the requester, once.
            async with db.transaction() as conn:
                kinds = [r[0] for r in (await conn.execute(text("SELECT kind FROM request_management.notifications WHERE recipient_user_id=:u"), {"u": self.fake.uid(self.agent)})).all()]
            self.assertEqual(kinds.count("execution_failed"), 1)
        finally:
            object.__setattr__(settings, "max_execution_attempts", 5)


class Visibility(World):
    async def test_internal_comments_and_attachments_are_hidden_from_the_requester(self):
        rid = await self.correction()
        d = await self.claim(self.uw1, rid)
        uw, agent = await self.me(self.uw1), await self.me(self.agent)
        await service.add_comment(uw, rid, {"body": "Check the KYC file first", "visibility": "INTERNAL"})
        await service.add_comment(uw, rid, {"body": "We're reviewing this", "visibility": "REQUESTER"})
        await self.expect(service.add_comment(agent, rid, {"body": "let me see", "visibility": "INTERNAL"}), "INTERNAL_NOT_ALLOWED")
        internal_id = await attachments.upload(uw, rid, "kyc.png", PNG, "INTERNAL")
        public_id = await attachments.upload(agent, rid, "proof.png", PNG, "REQUESTER")
        mine = await self.detail(self.agent, rid)
        self.assertEqual([c["body"] for c in mine["comments"]], ["We're reviewing this"])
        self.assertEqual([a["id"] for a in mine["attachments"]], [str(public_id)])
        await self.expect(attachments.download(agent, rid, internal_id), "NOT_FOUND")
        self.assertEqual((await attachments.download(uw, rid, internal_id))[0], PNG)
        await self.expect(attachments.download(await self.me(self.admin_b), rid, public_id), "NOT_FOUND")
        await self.expect(attachments.upload(agent, rid, "evil.exe", b"MZ\x90\x00not-a-pdf", "REQUESTER"), "VALIDATION")
        self.assertNotIn("COMMENT_ADDED:INTERNAL", [f"{e['event_type']}:{e['data'].get('visibility')}" for e in await queries.timeline(agent, rid)])


class Reliability(World):
    async def test_outbox_survives_a_publisher_failure_and_restart(self):
        rid = await self.correction()

        class Down(workers.Publisher):
            async def publish(self, key, value):
                raise ConnectionError("broker unavailable")

        self.assertEqual(await workers.relay_once(Down()), 0)                       # nothing lost, nothing published
        async with db.transaction() as conn:
            pending = (await conn.execute(text("SELECT count(*) FROM request_management.outbox_events WHERE published_at IS NULL"))).scalar()
        self.assertGreaterEqual(pending, 1)
        events = await self.run_outbox()                                            # "restarted" relay delivers them
        self.assertTrue(any(e["event_type"] == "request.submitted" for e in events))
        for event in events:                                                        # a redelivery changes nothing
            await workers.handle("notifier", event)
        async with db.transaction() as conn:
            n = (await conn.execute(text("SELECT count(*) FROM request_management.notifications WHERE request_id=:r"), {"r": rid})).scalar()
        self.assertEqual(n, 2)  # both underwriters in the queue, once each; never the requester

    async def test_overdue_reminders_never_decide_or_reassign(self):
        rid = await self.correction()
        async with db.transaction() as conn:
            await conn.execute(text("UPDATE request_management.requests SET due_at = now() - interval '2 hours' WHERE id=:r"), {"r": rid})
        self.assertEqual(await workers.overdue_reminders(), 1)
        self.assertEqual(await workers.overdue_reminders(), 0)                      # once per interval
        await self.run_outbox()
        d = await self.detail(self.uw1, rid)
        self.assertEqual(d["review_status"], "SUBMITTED")
        self.assertIsNone(d["assignee_user_id"])
        self.assertTrue(d["overdue"])
        async with db.transaction() as conn:
            recipients = {r[0] for r in (await conn.execute(text("SELECT recipient_user_id FROM request_management.notifications WHERE kind='overdue'"))).all()}
        self.assertNotIn(self.fake.uid(self.agent), recipients)
        self.assertIn(self.fake.uid(self.admin), recipients)


if __name__ == "__main__":
    unittest.main()
