"""Route-level idempotency for premium collection and free-look refunds on real PostgreSQL."""
import asyncio
import unittest
from unittest.mock import patch

from idem_testkit import RouteCase
from routers import post_issuance
from shared.models.core import PolicyStatusEnum, PremiumScheduleStatusEnum as S

PENDING, PAID = S.PENDING, S.PAID


class Base(RouteCase):
    routers = (post_issuance,)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        # PDF rendering is a local-file effect; the receipt row and number are what the ledger depends on.
        patcher = patch('routers.post_issuance.document_generator.generate_receipt', return_value={'file_path': '/tmp/receipt-test.pdf'})
        patcher.start()
        self.addCleanup(patcher.stop)

    async def count(self, table, p):
        return await self.scalar(f"SELECT count(*) FROM {table} WHERE policy_id = :p", p=p)

    async def events(self, p, event_type):
        return await self.scalar("SELECT count(*) FROM policy_events WHERE policy_id = :p AND event_type = :t", p=p, t=event_type)


class CollectInstallment(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.p = await self.make_policy(status=PolicyStatusEnum.ACTIVE, installments=[(5000.0, PENDING, 0), (5000.0, PENDING, 30)])
        self.path = self.base(self.p.policy_id) + f'/premiums/{self.p.schedule_ids[0]}/collect'
        self.body = {'method': 'BankTransfer', 'reference': 'COLLECT-REF-1'}

    async def test_retry_creates_one_receipt_and_replays_the_billing_outcome(self):
        async with self.client() as c:
            first = await c.post(self.path, json=self.body, headers=self.headers('collect-operation-001'))
            self.assertEqual(first.status_code, 200, first.text)
            await self.engine.dispose()
            replay = await c.post(self.path, json=self.body, headers=self.headers('collect-operation-001'))
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.headers['idempotency-replayed'], 'true')
        self.assertEqual(replay.json()['summary'], first.json()['summary'])
        self.assertEqual(await self.count('premium_receipts', self.p.policy_id), 1)
        self.assertEqual(await self.events(self.p.policy_id, 'PremiumCollected'), 1)
        self.assertEqual(await self.scalar("SELECT count(*) FROM business_outbox WHERE payload->>'event_type' = 'PremiumCollected'"), 1)
        stored = (await self.receipts())[0]
        self.assertEqual(set(stored['response_json']), {'policy_id'}, 'only the policy id is retained; the view is rebuilt on replay')

    async def test_a_second_key_for_the_same_installment_is_refused_by_the_ledger(self):
        async with self.client() as c:
            await c.post(self.path, json=self.body, headers=self.headers('collect-operation-002'))
            again = await c.post(self.path, json=self.body, headers=self.headers('collect-operation-003'))
            changed = await c.post(self.path, json={**self.body, 'reference': 'OTHER'}, headers=self.headers('collect-operation-002'))
        self.assertEqual(again.status_code, 400)
        self.assertEqual(changed.status_code, 409)
        self.assertEqual(await self.count('premium_receipts', self.p.policy_id), 1)

    async def test_concurrent_collection_posts_one_payment(self):
        async with self.client() as c:
            rs = await asyncio.gather(*[c.post(self.path, json=self.body, headers=self.headers('collect-operation-004')) for _ in range(6)])
            rs += await asyncio.gather(*[c.post(self.path, json=self.body, headers=self.headers(f'collect-other-{i:03d}-key')) for i in range(3)])
        self.assertGreaterEqual(sum(r.status_code == 200 for r in rs[:6]), 1)
        self.assertTrue(all(r.status_code in (200, 409) for r in rs[:6]))
        self.assertEqual(await self.count('premium_receipts', self.p.policy_id), 1)
        self.assertEqual(await self.events(self.p.policy_id, 'PremiumCollected'), 1)

    async def test_declined_payment_is_recorded_and_the_same_operation_can_be_retried(self):
        async with self.client() as c:
            declined = await c.post(self.path, json={**self.body, 'realize': False}, headers=self.headers('collect-operation-005'))
            self.assertEqual(declined.status_code, 402)
            self.assertEqual(await self.events(self.p.policy_id, 'PremiumPaymentFailed'), 1)
            self.assertEqual(await self.count('premium_receipts', self.p.policy_id), 0)
            paid = await c.post(self.path, json=self.body, headers=self.headers('collect-operation-006'))
        self.assertEqual(paid.status_code, 200, paid.text)
        self.assertEqual(await self.count('premium_receipts', self.p.policy_id), 1)

    async def test_the_next_installment_is_a_new_operation(self):
        second = self.base(self.p.policy_id) + f'/premiums/{self.p.schedule_ids[1]}/collect'
        async with self.client() as c:
            one = await c.post(self.path, json=self.body, headers=self.headers('collect-operation-007'))
            two = await c.post(second, json={**self.body, 'reference': 'COLLECT-REF-2'}, headers=self.headers('collect-operation-008'))
        self.assertEqual((one.status_code, two.status_code), (200, 200))
        self.assertEqual(await self.count('premium_receipts', self.p.policy_id), 2)
        self.assertEqual(await self.scalar("SELECT count(DISTINCT receipt_no) FROM premium_receipts WHERE policy_id = :p", p=self.p.policy_id), 2)


class BulkCollect(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.p = await self.make_policy(status=PolicyStatusEnum.ACTIVE, installments=[(5000.0, PENDING, 0), (5000.0, PENDING, 30), (5000.0, PENDING, 60)])
        self.path = self.base(self.p.policy_id) + '/premiums/bulk-collect'
        self.body = {'amount': 10000, 'method': 'BankTransfer', 'reference': 'BULK-REF-1'}

    async def test_retry_applies_the_lump_sum_once(self):
        async with self.client() as c:
            first = await c.post(self.path, json=self.body, headers=self.headers('bulk-operation-001'))
            self.assertEqual(first.status_code, 200, first.text)
            replay = await c.post(self.path, json=self.body, headers=self.headers('bulk-operation-001'))
        self.assertEqual(replay.headers['idempotency-replayed'], 'true')
        self.assertEqual(await self.count('premium_receipts', self.p.policy_id), 2)
        self.assertEqual(await self.scalar("SELECT count(*) FROM premium_schedules WHERE policy_id = :p AND status = 'PAID'", p=self.p.policy_id), 2)
        self.assertEqual(await self.scalar("SELECT COALESCE(sum(total_amount), 0) FROM premium_receipts WHERE policy_id = :p", p=self.p.policy_id), 10000)

    async def test_a_genuinely_new_collection_has_a_new_key_and_applies_to_what_is_left(self):
        async with self.client() as c:
            await c.post(self.path, json=self.body, headers=self.headers('bulk-operation-002'))
            more = await c.post(self.path, json={**self.body, 'amount': 5000, 'reference': 'BULK-REF-2'}, headers=self.headers('bulk-operation-003'))
        self.assertEqual(more.status_code, 200, more.text)
        self.assertEqual(await self.count('premium_receipts', self.p.policy_id), 3)

    async def test_concurrent_identical_bulk_requests_collect_once(self):
        async with self.client() as c:
            rs = await asyncio.gather(*[c.post(self.path, json=self.body, headers=self.headers('bulk-operation-004')) for _ in range(5)])
        self.assertTrue(all(r.status_code in (200, 409) for r in rs))
        self.assertEqual(await self.count('premium_receipts', self.p.policy_id), 2)


class FreeLookRefund(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.p = await self.make_policy(status=PolicyStatusEnum.ACTIVE, installments=[(8000.0, PAID, 0)], free_look_days=10)
        self.path = self.base(self.p.policy_id) + '/free-look/cancel'
        self.body = {'reason': 'changed mind', 'requested_by': 'customer'}

    async def test_refund_happens_once_and_retries_return_the_same_refund(self):
        async with self.client() as c:
            first = await c.post(self.path, json=self.body, headers=self.headers('refund-operation-001'))
            self.assertEqual(first.status_code, 200, first.text)
            replay = await c.post(self.path, json=self.body, headers=self.headers('refund-operation-001'))
            other = await c.post(self.path, json=self.body, headers=self.headers('refund-operation-002'))
        self.assertEqual(replay.json(), first.json())
        self.assertEqual(replay.headers['idempotency-replayed'], 'true')
        self.assertEqual(other.status_code, 400, 'the cancelled policy cannot be refunded again whatever the key')
        self.assertEqual(await self.events(self.p.policy_id, 'FreeLookCancellation'), 1)
        self.assertEqual(first.json()['refund_amount'], 8000)

    async def test_concurrent_refunds_pay_once(self):
        async with self.client() as c:
            rs = await asyncio.gather(*[c.post(self.path, json=self.body, headers=self.headers('refund-operation-003')) for _ in range(5)])
            rs += await asyncio.gather(*[c.post(self.path, json=self.body, headers=self.headers(f'refund-other-{i:03d}-key')) for i in range(3)])
        self.assertEqual(sum(r.status_code == 200 for r in rs[:5]) >= 1, True)
        self.assertEqual(await self.events(self.p.policy_id, 'FreeLookCancellation'), 1)
        self.assertEqual(await self.scalar("SELECT count(*) FROM premium_schedules WHERE policy_id = :p AND status = 'WAIVED'", p=self.p.policy_id), 1)

    async def test_deduction_rules_still_apply(self):
        async with self.client() as c:
            bad = await c.post(self.path, json={**self.body, 'medical_exam_deduction': 9000}, headers=self.headers('refund-operation-004'))
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(await self.events(self.p.policy_id, 'FreeLookCancellation'), 0)


if __name__ == '__main__':
    unittest.main()
