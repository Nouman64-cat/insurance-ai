"""Stage A pre-issuance writes (requirements, beneficiaries) are idempotent on real PostgreSQL."""
import asyncio
import unittest

from idem_testkit import RouteCase
from routers import pre_issuance
from shared.models.core import PolicyStatusEnum


class PreIssuance(RouteCase):
    routers = (pre_issuance,)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.p = await self.make_policy(status=PolicyStatusEnum.UNDER_REVIEW, policy_number='POL-IDEM-PRE')
        self.url = self.base(self.p.policy_id)

    async def test_a_retried_requirement_list_is_created_once_and_replayed(self):
        items = [{'requirement_type': 'KycCnic', 'label': 'CNIC copy'}, {'requirement_type': 'IncomeProof', 'label': 'Salary slip'}]
        async with self.client() as c:
            h = self.headers('requirements-operation-1')
            a = await c.post(self.url + '/requirements', json=items, headers=h)
            self.assertEqual(a.status_code, 200, a.text)
            b = await c.post(self.url + '/requirements', json=items, headers=h)
            # Without a key a repeat creates nothing (the endpoint skips types it has), so only the replay can return the original list.
            self.assertEqual((b.headers['idempotency-replayed'], len(b.json())), ('true', 2))
            self.assertEqual([r['id'] for r in a.json()], [r['id'] for r in b.json()])
            conflict = await c.post(self.url + '/requirements', json=items[:1], headers=h)
            self.assertEqual(conflict.status_code, 409)
        self.assertEqual(await self.scalar('SELECT count(*) FROM policy_requirements'), 2)

    async def test_requirement_decision_is_replayed_with_its_current_state(self):
        async with self.client() as c:
            made = await c.post(self.url + '/requirements', json=[{'requirement_type': 'KycCnic', 'label': 'CNIC copy'}], headers=self.headers())
            req = made.json()[0]['id']
            url = f'/tenants/{self.tenant_id}/requirements/{req}/waive'
            h = self.headers('requirement-waive-operation-1')
            a = await c.post(url, json={'note': 'seen in person'}, headers=h)
            self.assertEqual(a.status_code, 200, a.text)
            b = await c.post(url, json={'note': 'seen in person'}, headers=h)
        self.assertEqual((b.headers['idempotency-replayed'], b.json()['status']), ('true', 'Waived'))
        self.assertEqual(await self.scalar("SELECT count(*) FROM idempotency_records WHERE operation = 'tenant.preissuance.waive_requirement' AND status = 'COMPLETED'"), 1)

    async def test_beneficiaries_are_replaced_once_and_the_receipt_holds_no_names(self):
        body = {'beneficiaries': [{'name': 'Sana Ahmed', 'cnic': '35202-1234567-1', 'relationship': 'Spouse', 'share_pct': 100}], 'changed_by': 'agent'}
        async with self.client() as c:
            h = self.headers('beneficiaries-operation-1')
            a = await c.put(self.url + '/beneficiaries', json=body, headers=h)
            self.assertEqual(a.status_code, 200, a.text)
            b = await c.put(self.url + '/beneficiaries', json=body, headers=h)
        self.assertEqual((b.headers['idempotency-replayed'], b.json()['beneficiaries'][0]['name'], b.json()['version_sequence']), ('true', 'Sana Ahmed', 1))
        self.assertEqual(await self.scalar('SELECT count(*) FROM beneficiary_versions'), 1, 'a retry must not append a second roster snapshot')
        stored = str(await self.scalar("SELECT response_json FROM idempotency_records WHERE operation = 'tenant.preissuance.replace_beneficiaries'"))
        self.assertNotIn('Sana', stored)
        self.assertNotIn('35202', stored)

    async def test_concurrent_identical_requests_run_once(self):
        items = [{'requirement_type': 'KycCnic', 'label': 'CNIC copy'}]
        async with self.client() as c:
            rs = await asyncio.gather(*[c.post(self.url + '/requirements', json=items, headers=self.headers('requirements-operation-2')) for _ in range(6)])
        self.assertTrue(all(r.status_code in (200, 409) for r in rs), [r.status_code for r in rs])
        self.assertEqual(await self.scalar('SELECT count(*) FROM policy_requirements'), 1)


if __name__ == '__main__':
    unittest.main()
