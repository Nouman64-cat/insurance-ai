"""The walk-in customer's 'I have paid' calls (a link is the only credential) are idempotent on real PostgreSQL."""
import asyncio
import io
import unittest
from unittest.mock import AsyncMock, patch

from idem_testkit import RouteCase
from routers import customer_portal_walkin as walkin
from services import payment_requests
from shared.models.core import IPPStatusEnum, InitialPremiumPayment, PolicyStatusEnum


class WalkInPay(RouteCase):
    routers = (walkin,)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.app.dependency_overrides[walkin.signed_by_customer_management] = lambda: None
        self.p = await self.make_policy(status=PolicyStatusEnum.PROPOSED, schedule=False, policy_number=None)
        async with self.factory() as s:
            ipp = InitialPremiumPayment(tenant_id=self.tenant_id, policy_id=self.p.policy_id, amount=12000, method='JazzCash', reference='IPP-WALKIN-1',
                                        status=IPPStatusEnum.INITIATED)
            payment_requests.start_request(ipp, 'staff')
            s.add(ipp)
            await s.commit()
            await s.refresh(ipp)
            self.token = payment_requests.make_token(ipp)
        self.notify = AsyncMock()
        for target in ('notify_staff_proof', 'publish_change'):
            p = patch.object(payment_requests, target, new=self.notify if target == 'notify_staff_proof' else AsyncMock())
            p.start()
            self.addCleanup(p.stop)
        self.url = f'/internal/customer-portal/v1/walk-in/pay/{self.token}'

    async def test_a_retried_declaration_notifies_staff_once_and_replays_the_view(self):
        body = {'method': 'JazzCash', 'reference': 'TX-100200'}
        async with self.client() as c:
            h = {'Idempotency-Key': 'walkin-declare-operation-1'}
            a = await c.post(self.url + '/declare', json=body, headers=h)
            self.assertEqual(a.status_code, 200, a.text)
            b = await c.post(self.url + '/declare', json=body, headers=h)
            conflict = await c.post(self.url + '/declare', json={**body, 'reference': 'TX-OTHER'}, headers=h)
            rs = await asyncio.gather(*[c.post(self.url + '/declare', json=body, headers={'Idempotency-Key': 'walkin-declare-operation-2'}) for _ in range(5)])
        self.assertEqual((b.status_code, b.headers['idempotency-replayed'], b.json()['state']), (200, 'true', 'ProofSubmitted'))
        self.assertEqual(conflict.status_code, 409)
        self.assertTrue(all(r.status_code in (200, 409) for r in rs), [r.status_code for r in rs])
        self.assertEqual(self.notify.await_count, 2, 'one staff notification per distinct operation')

    async def test_a_retried_proof_upload_stores_one_artifact(self):
        with patch.object(walkin, '_upload_to_s3', return_value='s3://bucket/proof.png') as upload:
            async with self.client() as c:
                files = lambda: {'file': ('receipt.png', io.BytesIO(b'\x89PNG fake receipt'), 'image/png')}
                h = {'Idempotency-Key': 'walkin-proof-operation-1'}
                a = await c.post(self.url + '/proof', files=files(), data={'method': 'JazzCash', 'reference': 'TX-77'}, headers=h)
                self.assertEqual(a.status_code, 200, a.text)
                b = await c.post(self.url + '/proof', files=files(), data={'method': 'JazzCash', 'reference': 'TX-77'}, headers=h)
                other = await c.post(self.url + '/proof', files={'file': ('receipt.png', io.BytesIO(b'a different image'), 'image/png')},
                                     data={'method': 'JazzCash', 'reference': 'TX-77'}, headers=h)
        self.assertEqual((b.status_code, b.headers['idempotency-replayed']), (200, 'true'))
        self.assertEqual(other.status_code, 409, 'a different file under the same key is a different request')
        self.assertEqual(upload.call_count, 1)
        self.assertEqual(await self.scalar("SELECT count(*) FROM artifacts WHERE document_type = 'Payment Proof'"), 1)

    async def test_a_key_does_not_cross_links(self):
        async with self.client() as c:
            a = await c.post(self.url + '/declare', json={'method': 'JazzCash'}, headers={'Idempotency-Key': 'walkin-declare-operation-3'})
            bad = await c.post('/internal/customer-portal/v1/walk-in/pay/not-a-real-token/declare', json={'method': 'JazzCash'},
                               headers={'Idempotency-Key': 'walkin-declare-operation-3'})
        self.assertEqual(a.status_code, 200)
        self.assertEqual(bad.status_code, 404, 'the link is checked again on every call, replays included')


if __name__ == '__main__':
    unittest.main()
