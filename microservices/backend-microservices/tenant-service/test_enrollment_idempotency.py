"""Family and corporate set-up endpoints (group, organization, master policy) are idempotent on real PostgreSQL."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from idem_testkit import RouteCase
from routers import families, organizations


class Enrollment(RouteCase):
    routers = (families, organizations)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        for module in (families, organizations):
            self.app.dependency_overrides[module.verify_admin] = lambda: None
            p = patch.object(module, 'source_scope', new=AsyncMock(return_value=None))  # staff login: unrestricted
            p.start()
            self.addCleanup(p.stop)

    async def test_a_retried_family_group_is_created_once(self):
        body = {'name': 'Khan household', 'city': 'Lahore'}
        url = f'/tenants/{self.tenant_id}/families'
        async with self.client() as c:
            h = self.headers('family-group-operation-1')
            a = await c.post(url, json=body, headers=h)
            self.assertEqual(a.status_code, 201, a.text)
            b = await c.post(url, json=body, headers=h)
            self.assertEqual((b.status_code, b.headers['idempotency-replayed']), (201, 'true'))
            self.assertEqual(a.json()['id'], b.json()['id'])
            conflict = await c.post(url, json={**body, 'name': 'Someone else'}, headers=h)
            self.assertEqual(conflict.status_code, 409)
            fresh = await c.post(url, json=body, headers=self.headers('family-group-operation-2'))
            self.assertEqual(fresh.status_code, 201)
        self.assertEqual(await self.scalar('SELECT count(*) FROM family_groups'), 2, 'a new key is a new operation')

    async def test_concurrent_organization_creates_once(self):
        url = f'/tenants/{self.tenant_id}/organizations'
        body = {'name': 'Acme Textiles', 'industry': 'Textile'}
        async with self.client() as c:
            rs = await asyncio.gather(*[c.post(url, json=body, headers=self.headers('organization-operation-1')) for _ in range(6)])
        self.assertTrue(all(r.status_code in (201, 409) for r in rs), [r.status_code for r in rs])
        self.assertEqual(await self.scalar('SELECT count(*) FROM organizations'), 1)

    async def test_master_policy_replays_the_rendered_read_model(self):
        async with self.client() as c:
            org = await c.post(f'/tenants/{self.tenant_id}/organizations', json={'name': 'Beta Steel'}, headers=self.headers())
            self.assertEqual(org.status_code, 201, org.text)
            url = f'/tenants/{self.tenant_id}/organizations/{org.json()["id"]}/master-policies'
            body = {'sum_assured_multiple': 24, 'term_years': 1, 'effective_date': '2030-01-01'}
            h = self.headers('master-policy-operation-1')
            a = await c.post(url, json=body, headers=h)
            self.assertEqual(a.status_code, 201, a.text)
            b = await c.post(url, json=body, headers=h)
        self.assertEqual((b.status_code, b.headers['idempotency-replayed']), (201, 'true'))
        self.assertEqual(a.json(), b.json())
        self.assertEqual(await self.scalar('SELECT count(*) FROM master_policies'), 1)

    async def test_no_key_means_the_original_behaviour(self):
        url = f'/tenants/{self.tenant_id}/families'
        async with self.client() as c:
            await c.post(url, json={'name': 'No key'}, headers=self.headers())
            await c.post(url, json={'name': 'No key'}, headers=self.headers())
        self.assertEqual(await self.scalar('SELECT count(*) FROM family_groups'), 2)
        self.assertEqual(await self.scalar('SELECT count(*) FROM idempotency_records'), 0)


if __name__ == '__main__':
    unittest.main()
