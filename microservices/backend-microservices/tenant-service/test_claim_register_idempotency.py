"""Claim registration and status steps (the register API) are idempotent on real PostgreSQL."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from idem_testkit import RouteCase
from routers import claims
from shared.models.core import PolicyStatusEnum, Role, User


class ClaimRegister(RouteCase):
    routers = (claims,)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.p = await self.make_policy(status=PolicyStatusEnum.ACTIVE, policy_number='POL-IDEM-CLM')
        async with self.factory() as s:
            role = Role(name=f'Claims-{uuid4().hex[:6]}', tenant_id=self.tenant_id) if hasattr(Role, 'tenant_id') else Role(name=f'Claims-{uuid4().hex[:6]}')
            s.add(role)
            await s.flush()
            self.user = User(tenant_id=self.tenant_id, role_id=role.id, email=f'{uuid4().hex}@test.invalid', username=uuid4().hex, hashed_password='x', full_name='Claims Officer')
            s.add(self.user)
            await s.commit()
        patch_role = patch.object(claims, '_role_name', new=AsyncMock(return_value='ClaimsManager'))
        patch_role.start()
        self.addCleanup(patch_role.stop)
        for name in ('_assert_role', '_assert_claims_role'):
            p = patch.object(claims, name, new=AsyncMock(return_value=self.user))
            p.start()
            self.addCleanup(p.stop)
        self.body = {'policy_id': str(self.p.policy_id), 'claim_type': 'Hospitalization', 'submitted_amount': 50000, 'incident_date': '2026-10-01',
                     'claimant_name': 'Test Claimant'}

    async def test_a_retried_registration_files_one_claim_and_replays_the_card(self):
        url = f'/tenants/{self.tenant_id}/claims'
        async with self.client() as c:
            h = self.headers('claim-register-op-1')
            a = await c.post(url, json=self.body, headers=h)
            self.assertEqual(a.status_code, 201, a.text)
            b = await c.post(url, json=self.body, headers=h)
            conflict = await c.post(url, json={**self.body, 'submitted_amount': 60000}, headers=h)
            rs = await asyncio.gather(*[c.post(url, json={**self.body, 'claim_type': 'Surgery'}, headers=self.headers('claim-register-op-2')) for _ in range(5)])
        self.assertEqual((b.status_code, b.headers['idempotency-replayed'], b.json()['id']), (201, 'true', a.json()['id']))
        self.assertEqual(conflict.status_code, 409)
        self.assertTrue(all(r.status_code in (201, 409) for r in rs), [r.status_code for r in rs])
        self.assertEqual(await self.scalar('SELECT count(*) FROM claims'), 2)

    async def test_a_retried_status_change_is_applied_once(self):
        async with self.client() as c:
            created = await c.post(f'/tenants/{self.tenant_id}/claims', json=self.body, headers=self.headers())
            self.assertEqual(created.status_code, 201, created.text)
            url = f"/tenants/{self.tenant_id}/claims/{created.json()['id']}/status"
            h = self.headers('claim-status-op-1')
            a = await c.patch(url, json={'status': 'Triaged'}, headers=h)
            self.assertEqual(a.status_code, 200, a.text)
            b = await c.patch(url, json={'status': 'Triaged'}, headers=h)
            plain = await c.patch(url, json={'status': 'Triaged'}, headers=self.headers())
        self.assertEqual((b.status_code, b.headers['idempotency-replayed']), (200, 'true'))
        self.assertEqual(plain.status_code, 400, 'without a key the state machine refuses the repeat, as before')

    async def test_a_retried_decision_is_recorded_once(self):
        async with self.client() as c:
            created = await c.post(f'/tenants/{self.tenant_id}/claims', json=self.body, headers=self.headers())
            url = f"/tenants/{self.tenant_id}/claims/{created.json()['id']}/adjudicate"
            h = self.headers('claim-decision-op-1')
            a = await c.post(url, json={'decision': 'DECLINED', 'notes': 'Outside the policy period'}, headers=h)
            self.assertEqual(a.status_code, 200, a.text)
            b = await c.post(url, json={'decision': 'DECLINED', 'notes': 'Outside the policy period'}, headers=h)
            conflict = await c.post(url, json={'decision': 'DECLINED', 'notes': 'A different note'}, headers=h)
        self.assertEqual((b.status_code, b.headers['idempotency-replayed']), (200, 'true'))
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(await self.scalar("SELECT count(*) FROM claim_status_histories WHERE to_status = 'Declined'"), 1)


if __name__ == '__main__':
    unittest.main()
