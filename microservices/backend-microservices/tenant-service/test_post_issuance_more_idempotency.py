"""Onboarding, endorsement, ledger-adjustment and notification actions on a policy are idempotent on real PostgreSQL."""
import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from sqlalchemy import text

from idem_testkit import RouteCase
from routers import post_issuance
from shared.models.core import PolicyStatusEnum, PremiumScheduleStatusEnum as S


class PolicyActions(RouteCase):
    routers = (post_issuance,)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.p = await self.make_policy(status=PolicyStatusEnum.ACTIVE, installments=[(5000.0, S.PENDING, 0), (5000.0, S.PENDING, 30)])
        self.url = self.base(self.p.policy_id)

    async def test_waiving_an_installment_is_applied_once_and_replayed(self):
        url = self.url + f'/premiums/{self.p.schedule_ids[0]}/waive'
        async with self.client() as c:
            h = self.headers('waive-operation-1')
            a = await c.post(url, json={'note': 'goodwill'}, headers=h)
            self.assertEqual(a.status_code, 200, a.text)
            b = await c.post(url, json={'note': 'goodwill'}, headers=h)
            fresh = await c.post(url, json={'note': 'goodwill'}, headers=self.headers('waive-operation-2'))
        self.assertEqual((b.status_code, b.headers['idempotency-replayed']), (200, 'true'))
        self.assertEqual(fresh.status_code, 400, 'a new operation on an already-waived installment is refused by the ledger')
        self.assertEqual(await self.scalar("SELECT count(*) FROM policy_events WHERE policy_id = :p AND event_type = 'PremiumWaived'", p=self.p.policy_id), 1)

    async def test_autopay_toggle_and_endorsement_replay(self):
        async with self.client() as c:
            a = await c.post(self.url + '/premiums/autopay', json={'enabled': True}, headers=self.headers('autopay-operation-1'))
            b = await c.post(self.url + '/premiums/autopay', json={'enabled': True}, headers=self.headers('autopay-operation-1'))
            self.assertEqual((a.status_code, b.headers['idempotency-replayed']), (200, 'true'))
            body = {'address': '12 Canal Road', 'city': 'Lahore', 'actor': 'ops'}
            e1 = await c.post(self.url + '/endorsements/address', json=body, headers=self.headers('endorse-address-1'))
            e2 = await c.post(self.url + '/endorsements/address', json=body, headers=self.headers('endorse-address-1'))
            self.assertEqual(e1.status_code, 200, e1.text)
            self.assertEqual((e2.headers['idempotency-replayed'], e2.json()), ('true', e1.json()))
            e3 = await c.post(self.url + '/endorsements/address', json={**body, 'city': 'Karachi'}, headers=self.headers('endorse-address-1'))
            self.assertEqual(e3.status_code, 409)
        self.assertEqual(await self.scalar('SELECT count(*) FROM policy_endorsements WHERE policy_id = :p', p=self.p.policy_id), 1)

    async def test_contact_capture_and_policyholder_id_replay(self):
        async with self.client() as c:
            h = self.headers('contact-operation-1')
            a = await c.post(self.url + '/onboarding/contact', json={'email': 'ali@example.com', 'phone': '03001234567'}, headers=h)
            self.assertEqual(a.status_code, 200, a.text)
            b = await c.post(self.url + '/onboarding/contact', json={'email': 'ali@example.com', 'phone': '03001234567'}, headers=h)
            self.assertEqual(b.headers['idempotency-replayed'], 'true')
            stored = str(await self.scalar("SELECT response_json FROM idempotency_records WHERE operation = 'tenant.onboarding.set_onboarding_contact'"))
            self.assertNotIn('ali@example.com', stored)
            i1 = await c.post(self.url + '/onboarding/policyholder-id', headers=self.headers('policyholder-operation-1'))
            i2 = await c.post(self.url + '/onboarding/policyholder-id', headers=self.headers('policyholder-operation-1'))
        self.assertEqual(i1.status_code, 200, i1.text)
        self.assertEqual((i2.json(), i2.headers['idempotency-replayed']), (i1.json(), 'true'))

    async def test_issuance_email_is_sent_once_and_the_receipt_masks_the_recipient(self):
        async with self.engine.begin() as conn:
            await conn.execute(text("UPDATE policies SET policy_number = 'POL-IDEM-MAIL' WHERE id = :p"), {'p': self.p.policy_id})
            await conn.execute(text("UPDATE customers SET details = CAST(:d AS json) WHERE id = :c"),
                               {'d': json.dumps({'contact_email': 'ali.khan@example.com'}), 'c': self.p.customer_id})
        send = AsyncMock(return_value=True)
        with patch.object(post_issuance.email_utils, 'send_email', send):
            async with self.client() as c:
                h = self.headers('issuance-mail-operation-1')
                a = await c.post(self.url + '/issuance/send-email', headers=h)
                self.assertEqual(a.status_code, 200, a.text)
                b = await c.post(self.url + '/issuance/send-email', headers=h)
                rs = await asyncio.gather(*[c.post(self.url + '/issuance/send-email', headers=self.headers('issuance-mail-operation-2')) for _ in range(4)])
        self.assertEqual(b.headers['idempotency-replayed'], 'true')
        self.assertEqual(b.json()['sent_to'], 'a***@example.com')
        self.assertEqual(send.await_count, 2, 'one send per distinct operation, none for the replay or the concurrent duplicates')
        self.assertTrue(all(r.status_code in (200, 409) for r in rs), [r.status_code for r in rs])
        stored = str(await self.scalar("SELECT response_json FROM idempotency_records WHERE operation = 'tenant.issuance.send_email' LIMIT 1"))
        self.assertNotIn('ali.khan', stored)

    async def test_a_reminder_is_sent_once_and_the_receipt_masks_the_address(self):
        async with self.engine.begin() as conn:
            await conn.execute(text("UPDATE customers SET details = CAST(:d AS json) WHERE id = :c"),
                               {'d': json.dumps({'contact_email': 'reminder.person@example.com'}), 'c': self.p.customer_id})
        send = AsyncMock(return_value=True)
        url = self.url + f'/premiums/{self.p.schedule_ids[0]}/remind'
        with patch.object(post_issuance.email_utils, 'send_email', send):
            async with self.client() as c:
                h = self.headers('remind-operation-1')
                a = await c.post(url, json={'channel': 'Email', 'template': 'Standard'}, headers=h)
                self.assertEqual(a.status_code, 200, a.text)
                b = await c.post(url, json={'channel': 'Email', 'template': 'Standard'}, headers=h)
        self.assertEqual((b.headers['idempotency-replayed'], b.json()['reminder']['to'], b.json()['reminder']['delivered']), ('true', 'r***@example.com', True))
        self.assertEqual(send.await_count, 1)
        self.assertIn('installments', b.json(), 'the billing view is rebuilt from the ledger')
        stored = str(await self.scalar("SELECT response_json FROM idempotency_records WHERE operation = 'tenant.premium.remind_installment'"))
        self.assertNotIn('reminder.person', stored)


if __name__ == '__main__':
    unittest.main()
