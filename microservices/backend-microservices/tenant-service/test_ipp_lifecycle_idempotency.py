"""Idempotency of the initial-premium request lifecycle (request, remind, review, mark received, withdraw) on real PostgreSQL."""
import asyncio
import unittest
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from idem_testkit import RouteCase
from routers import initial_premium_payment as ipp
from shared.idempotency import IdempotencyError
from shared.models.core import InitialPremiumPayment, IPPStatusEnum, PolicyStatusEnum


class Base(RouteCase):
    routers = (ipp,)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.sent = []
        async def email(session, ipp_row, policy, customer, reminder=False):
            self.sent.append(('request', reminder))
            return True
        async def confirmed(session, ipp_row, policy, customer):
            self.sent.append(('confirmed',))
        async def rejected(session, ipp_row, customer):
            self.sent.append(('rejected',))
        for target, fake in (('email_customer_request', email), ('email_customer_confirmed', confirmed), ('email_customer_rejection', rejected)):
            p = patch.object(ipp.payment_requests, target, new=fake)
            p.start()
            self.addCleanup(p.stop)
        for p in (patch.object(ipp, '_get_current_user_id', new=AsyncMock(return_value=self.identity.id)),
                  patch.object(ipp, '_initiate', new=AsyncMock()),
                  patch.object(ipp.payment_requests, 'publish_change', new=AsyncMock()),
                  patch.object(ipp.payment_requests, 'customer_email', return_value='ali.khan@example.test')):
            p.start()
            self.addCleanup(p.stop)
        self.p = await self.make_policy(status=PolicyStatusEnum.PROPOSED, schedule=False, policy_number=None)
        async with self.factory() as s:
            s.add(InitialPremiumPayment(tenant_id=self.tenant_id, policy_id=self.p.policy_id, amount=12000, method='JazzCash',
                                        reference='IPP-LIFE-1', status=IPPStatusEnum.INITIATED))
            await s.commit()
        self.base_path = self.base(self.p.policy_id) + '/ipp'

    async def row(self):
        async with self.factory() as s:
            from sqlmodel import select
            return (await s.exec(select(InitialPremiumPayment).where(InitialPremiumPayment.policy_id == self.p.policy_id))).one()


class RequestAndRemind(Base):
    async def test_a_retried_request_emails_once_and_replays_the_same_answer(self):
        async with self.client() as c:
            h = self.headers('ipp-request-operation-1')
            first = await c.post(self.base_path + '/request', headers=h)
            self.assertEqual(first.status_code, 200, first.text)
            replay = await c.post(self.base_path + '/request', headers=h)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.headers['idempotency-replayed'], 'true')
        self.assertEqual(replay.json()['emailed'], first.json()['emailed'])
        self.assertEqual(replay.json()['link'], first.json()['link'], 'the link is rebuilt from the record, not stored')
        self.assertEqual(self.sent, [('request', False)])
        self.assertEqual((await self.row()).request_version, 1)
        stored = str((await self.receipts())[0]['response_json'])
        self.assertNotIn('ali.khan@example.test', stored)
        self.assertNotIn('/walk-in/pay/', stored)

    async def test_a_new_key_is_a_new_request_and_issues_a_fresh_link(self):
        async with self.client() as c:
            await c.post(self.base_path + '/request', headers=self.headers('ipp-request-operation-2'))
            second = await c.post(self.base_path + '/request', headers=self.headers('ipp-request-operation-3'))
        self.assertEqual(second.status_code, 200)
        self.assertEqual((await self.row()).request_version, 2)
        self.assertEqual(len(self.sent), 2)

    async def test_remind_is_replayed_without_a_second_reminder(self):
        async with self.client() as c:
            await c.post(self.base_path + '/request', headers=self.headers('ipp-request-operation-4'))
            h = self.headers('ipp-remind-operation-1')
            a = await c.post(self.base_path + '/remind', headers=h)
            b = await c.post(self.base_path + '/remind', headers=h)
        self.assertEqual((a.status_code, b.status_code), (200, 200))
        self.assertEqual((await self.row()).reminder_count, 1)
        self.assertEqual([m for m in self.sent if m == ('request', True)], [('request', True)])

    async def test_concurrent_identical_requests_send_one_email(self):
        async with self.client() as c:
            rs = await asyncio.gather(*[c.post(self.base_path + '/request', headers=self.headers('ipp-request-operation-5')) for _ in range(6)])
        self.assertTrue(all(r.status_code in (200, 409) for r in rs), [r.status_code for r in rs])
        self.assertEqual(len(self.sent), 1)


class ClearingThePremium(Base):
    async def test_mark_received_clears_the_premium_once(self):
        body = {'method': 'Cash', 'reference': 'CASH-1', 'note': 'at the office'}
        async with self.client() as c:
            h = self.headers('ipp-received-operation-1')
            first = await c.post(self.base_path + '/mark-received', json=body, headers=h)
            self.assertEqual(first.status_code, 200, first.text)
            replay = await c.post(self.base_path + '/mark-received', json=body, headers=h)
            other = await c.post(self.base_path + '/mark-received', json=body, headers=self.headers('ipp-received-operation-2'))
            changed = await c.post(self.base_path + '/mark-received', json={**body, 'reference': 'CASH-2'}, headers=h)
        self.assertEqual((replay.status_code, replay.headers['idempotency-replayed']), (200, 'true'))
        self.assertEqual(other.status_code, 409, 'the premium is already realized: the business rule refuses a second clearing')
        self.assertEqual(changed.status_code, 409)
        self.assertEqual((await self.row()).status, IPPStatusEnum.REALIZED)
        self.assertEqual([m for m in self.sent if m == ('confirmed',)], [('confirmed',)], 'the customer is told once')

    async def test_review_accept_replays_and_a_second_review_is_refused(self):
        async with self.factory() as s:
            from sqlmodel import select
            row = (await s.exec(select(InitialPremiumPayment).where(InitialPremiumPayment.policy_id == self.p.policy_id))).one()
            row.proof_status = 'Submitted'
            s.add(row)
            await s.commit()
        async with self.client() as c:
            h = self.headers('ipp-review-operation-1')
            first = await c.post(self.base_path + '/review', json={'decision': 'accept'}, headers=h)
            self.assertEqual(first.status_code, 200, first.text)
            replay = await c.post(self.base_path + '/review', json={'decision': 'accept'}, headers=h)
            again = await c.post(self.base_path + '/review', json={'decision': 'accept'}, headers=self.headers('ipp-review-operation-2'))
        self.assertEqual(replay.headers['idempotency-replayed'], 'true')
        self.assertEqual(again.status_code, 409)
        self.assertEqual((await self.row()).status, IPPStatusEnum.REALIZED)

    async def test_a_crash_after_the_premium_was_cleared_completes_the_retry_without_repeating_it(self):
        body = {'method': 'Cash', 'reference': 'CASH-9'}
        key = 'ipp-received-operation-9'
        real = ipp.payment_requests.publish_change
        async def die(tenant_id):
            raise asyncio.CancelledError()      # the process stops after the commit, before the receipt is recorded
        async with self.client() as c:
            with patch.object(ipp.payment_requests, 'publish_change', new=die):
                with self.assertRaises(BaseException):
                    await c.post(self.base_path + '/mark-received', json=body, headers=self.headers(key))
            self.assertEqual((await self.row()).status, IPPStatusEnum.REALIZED, 'the work did commit')
            async with self.engine.begin() as conn:
                from sqlalchemy import text
                await conn.execute(text("UPDATE idempotency_records SET lease_expires_at = clock_timestamp() - interval '1 second'"))
            retry = await c.post(self.base_path + '/mark-received', json=body, headers=self.headers(key))
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.headers['idempotency-replayed'], 'true')
        self.assertEqual([m for m in self.sent if m == ('confirmed',)], [('confirmed',)], 'not repeated: the domain proved it happened')
        self.assertEqual(await self.scalar("SELECT status FROM idempotency_records WHERE idempotency_key = :k", k=key), 'COMPLETED')

    async def test_a_crash_before_anything_committed_lets_the_retry_run_once(self):
        body = {'method': 'Cash'}
        key = 'ipp-received-operation-8'
        async def die(*a, **k):
            raise asyncio.CancelledError()
        async with self.client() as c:
            with patch.object(ipp, '_staff_name', new=die):           # fails before the premium is touched
                with self.assertRaises(BaseException):
                    await c.post(self.base_path + '/mark-received', json=body, headers=self.headers(key))
            self.assertNotEqual((await self.row()).status, IPPStatusEnum.REALIZED)
            async with self.engine.begin() as conn:
                from sqlalchemy import text
                await conn.execute(text("UPDATE idempotency_records SET lease_expires_at = clock_timestamp() - interval '1 second'"))
            retry = await c.post(self.base_path + '/mark-received', json=body, headers=self.headers(key))
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual((await self.row()).status, IPPStatusEnum.REALIZED)


class Withdraw(Base):
    async def test_withdraw_is_replayed(self):
        async with self.client() as c:
            await c.post(self.base_path + '/request', headers=self.headers('ipp-request-operation-7'))
            h = self.headers('ipp-withdraw-operation-1')
            a = await c.post(self.base_path + '/withdraw', headers=h)
            b = await c.post(self.base_path + '/withdraw', headers=h)
        self.assertEqual((a.status_code, b.status_code), (200, 200), (a.text, b.text))
        self.assertEqual(b.headers['idempotency-replayed'], 'true')


if __name__ == '__main__':
    unittest.main()
