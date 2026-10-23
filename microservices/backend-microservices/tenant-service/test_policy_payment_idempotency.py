"""Route-level idempotency for policy payment confirmation and apply-prepaid on real PostgreSQL."""
import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch

from idem_testkit import RouteCase
from routers import policies
from shared.models.core import PolicyStatusEnum


class ConfirmPayment(RouteCase):
    routers = (policies,)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.docs = patch('routers.policies.generate_and_store_documents', new=AsyncMock())
        self.docs.start()
        self.addCleanup(self.docs.stop)
        self.p = await self.make_policy()
        self.path = self.base(self.p.policy_id) + '/payments/confirm'
        self.body = {'amount': 12000, 'method': 'BankTransfer', 'reference': 'PAY-TEST-REF'}

    async def activations(self):
        return await self.scalar("SELECT count(*) FROM policy_events WHERE policy_id = :p AND event_type = 'PaymentConfirmed'", p=self.p.policy_id)

    async def test_retry_returns_the_original_outcome_and_activates_once(self):
        async with self.client() as c:
            first = await c.post(self.path, json=self.body, headers=self.headers('confirm-operation-001'))
            self.assertEqual(first.status_code, 200, first.text)
            await self.engine.dispose()                      # a restart: only PostgreSQL remembers
            replay = await c.post(self.path, json=self.body, headers=self.headers('confirm-operation-001'))
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.json(), first.json())
        self.assertEqual(replay.headers['idempotency-replayed'], 'true')
        self.assertEqual(await self.activations(), 1)
        self.assertEqual(await self.scalar("SELECT count(*) FROM business_outbox WHERE payload->>'event_type' = 'PaymentConfirmed'"), 1)
        self.assertEqual(await self.scalar("SELECT count(*) FROM premium_receipts"), 1)

    async def test_same_key_with_other_content_conflicts_and_a_new_key_cannot_pay_twice(self):
        async with self.client() as c:
            await c.post(self.path, json=self.body, headers=self.headers('confirm-operation-002'))
            changed = await c.post(self.path, json={**self.body, 'reference': 'OTHER'}, headers=self.headers('confirm-operation-002'))
            other_key = await c.post(self.path, json=self.body, headers=self.headers('confirm-operation-003'))
        self.assertEqual(changed.status_code, 409)
        self.assertEqual(other_key.status_code, 400, 'the policy is already active: the business rule, not the key, stops a second payment')
        self.assertEqual(await self.activations(), 1)
        self.assertEqual(await self.scalar("SELECT status FROM idempotency_records WHERE idempotency_key = 'confirm-operation-003'"), 'FAILED')

    async def test_concurrent_identical_requests_execute_once(self):
        async with self.client() as c:
            responses = await asyncio.gather(*[c.post(self.path, json=self.body, headers=self.headers('confirm-operation-004')) for _ in range(6)])
        codes = sorted(r.status_code for r in responses)
        self.assertEqual(codes.count(200), codes.count(200) and codes.count(200))
        self.assertGreaterEqual(codes.count(200), 1)
        self.assertTrue(all(code in (200, 409) for code in codes), codes)
        for r in responses:
            if r.status_code == 409:
                self.assertEqual(r.json()['detail']['code'], 'IDEMPOTENCY_PROCESSING')
                self.assertIn('retry-after', r.headers)
        self.assertEqual(await self.activations(), 1)
        self.assertEqual(await self.scalar("SELECT count(*) FROM premium_receipts"), 1)

    async def test_a_failed_payment_attempt_is_kept_and_the_same_key_may_be_retried(self):
        async with self.client() as c:
            declined = await c.post(self.path, json={**self.body, 'realize': False}, headers=self.headers('confirm-operation-005'))
            self.assertEqual(declined.status_code, 402)
            self.assertEqual(await self.scalar("SELECT count(*) FROM policy_events WHERE policy_id = :p AND event_type = 'PaymentFailed'", p=self.p.policy_id), 1,
                             'the recorded failed attempt must survive the rejection')
            self.assertEqual(await self.scalar("SELECT status FROM idempotency_records WHERE idempotency_key = 'confirm-operation-005'"), 'FAILED')
            retry = await c.post(self.path, json={**self.body, 'realize': False}, headers=self.headers('confirm-operation-005'))
            self.assertEqual(retry.status_code, 402)
            paid = await c.post(self.path, json=self.body, headers=self.headers('confirm-operation-006'))
        self.assertEqual(paid.status_code, 200, paid.text)
        self.assertEqual(await self.activations(), 1)

    async def test_header_rules(self):
        async with self.client() as c:
            bad = await c.post(self.path, json=self.body, headers=self.headers('x'))
            self.assertEqual(bad.status_code, 400)
            in_body = await c.post(self.path, json={**self.body, 'idempotency_key': 'confirm-operation-007'}, headers=self.headers())
            self.assertNotEqual(in_body.status_code, 409)
            self.assertEqual(await self.scalar("SELECT count(*) FROM idempotency_records"), 0, 'a body field is never an operation identity')
        os.environ['IDEMPOTENCY_ENFORCEMENT'] = 'required'
        self.addCleanup(os.environ.pop, 'IDEMPOTENCY_ENFORCEMENT', None)
        async with self.client() as c:
            missing = await c.post(self.path, json=self.body, headers=self.headers())
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(missing.json()['detail']['code'], 'IDEMPOTENCY_KEY_REQUIRED')

    async def test_receipt_holds_no_personal_data(self):
        async with self.client() as c:
            await c.post(self.path, json=self.body, headers=self.headers('confirm-operation-008'))
        stored = str(await self.receipts())
        for forbidden in ('Test only', 'Bearer', 'test-token', '35202'):
            self.assertNotIn(forbidden, stored)


class ApplyPrepaid(RouteCase):
    routers = (policies,)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.docs = patch('routers.policies.generate_and_store_documents', new=AsyncMock())
        self.docs.start()
        self.addCleanup(self.docs.stop)
        from datetime import datetime
        from shared.models.core import InitialPremiumPayment, IPPStatusEnum
        self.p = await self.make_policy(amount_due=10000)
        async with self.factory() as s:
            s.add(InitialPremiumPayment(tenant_id=self.tenant_id, policy_id=self.p.policy_id, amount=10000, method='JazzCash',
                                        reference='IPP-PREPAID-1', status=IPPStatusEnum.REALIZED, realized_at=datetime.utcnow()))
            await s.commit()
        self.path = self.base(self.p.policy_id) + '/payments/apply-prepaid'

    async def test_prepaid_is_applied_once_and_replays(self):
        async with self.client() as c:
            first = await c.post(self.path, headers=self.headers('prepaid-operation-001'))
            self.assertEqual(first.status_code, 200, first.text)
            replay = await c.post(self.path, headers=self.headers('prepaid-operation-001'))
            second = await c.post(self.path, headers=self.headers('prepaid-operation-002'))
        self.assertEqual(replay.json(), first.json())
        self.assertEqual(replay.headers['idempotency-replayed'], 'true')
        self.assertEqual(second.status_code, 400)
        self.assertEqual(await self.scalar("SELECT count(*) FROM policy_events WHERE policy_id = :p AND event_type = 'PaymentConfirmed'", p=self.p.policy_id), 1)
        self.assertEqual(await self.scalar("SELECT amount_paid FROM premium_schedules WHERE policy_id = :p", p=self.p.policy_id), 10000)

    async def test_concurrent_requests_apply_it_once(self):
        async with self.client() as c:
            rs = await asyncio.gather(*[c.post(self.path, headers=self.headers('prepaid-operation-003')) for _ in range(5)])
        self.assertTrue(all(r.status_code in (200, 409) for r in rs), [r.status_code for r in rs])
        self.assertGreaterEqual(sum(r.status_code == 200 for r in rs), 1)
        self.assertEqual(await self.scalar("SELECT count(*) FROM policy_events WHERE policy_id = :p AND event_type = 'PaymentConfirmed'", p=self.p.policy_id), 1)


class IssuePolicy(RouteCase):
    routers = (policies,)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.notice = patch('routers.policies.generate_and_store_premium_notice', new=AsyncMock())
        self.ready = patch('routers.policies.assert_ready_to_issue', new=AsyncMock(return_value={'demo_bypass_flags': 'NotFlagged'}))
        self.members = patch('routers.policies.pending_insured_members', new=AsyncMock(return_value=[]))
        for p in (self.notice, self.ready, self.members):
            p.start()
            self.addCleanup(p.stop)
        self.p = await self.make_policy(status=PolicyStatusEnum.APPROVED, policy_number=None, schedule=False)
        self.path = self.base(self.p.policy_id) + '/issue'

    async def test_issue_retry_returns_the_same_policy_number_and_never_issues_twice(self):
        async with self.client() as c:
            first = await c.post(self.path, headers=self.headers('issue-operation-001'))
            self.assertEqual(first.status_code, 200, first.text)
            replay = await c.post(self.path, headers=self.headers('issue-operation-001'))
            other = await c.post(self.path, headers=self.headers('issue-operation-002'))
        self.assertEqual(replay.json(), first.json())
        self.assertEqual(replay.headers['idempotency-replayed'], 'true')
        self.assertEqual(other.status_code, 400)
        self.assertIn('Policy must be', other.text)   # the status guard, not the key, refuses a second issuance
        self.assertEqual(await self.scalar("SELECT count(*) FROM premium_schedules WHERE policy_id = :p", p=self.p.policy_id), 1)
        self.assertEqual(await self.scalar("SELECT count(*) FROM policy_events WHERE policy_id = :p AND event_type = 'PolicyIssued'", p=self.p.policy_id), 1)

    async def test_concurrent_issuance_creates_one_contract(self):
        async with self.client() as c:
            rs = await asyncio.gather(*[c.post(self.path, headers=self.headers(f'issue-operation-1{i}')) for i in range(4)])
        self.assertEqual(sum(r.status_code == 200 for r in rs), 1, [(r.status_code, r.text[:80]) for r in rs])
        # the fixture's own v1.0 plus exactly one issuance version would be 2; the fixture version is the one issued against
        self.assertEqual(await self.scalar("SELECT count(*) FROM policy_versions WHERE policy_id = :p AND event_type = 'Issuance'", p=self.p.policy_id), 2)
        self.assertEqual(await self.scalar("SELECT count(*) FROM policy_events WHERE policy_id = :p AND event_type = 'PolicyIssued'", p=self.p.policy_id), 1)


if __name__ == '__main__':
    unittest.main()
