"""Corporate scheme set-up (benefit classes and their extra cover) is idempotent on real PostgreSQL."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from idem_testkit import RouteCase
from routers import group_coverages, organizations


class SchemeSetup(RouteCase):
    routers = (organizations, group_coverages)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        for module in (organizations, group_coverages):
            self.app.dependency_overrides[module.verify_admin] = lambda: None
        p = patch.object(organizations, 'source_scope', new=AsyncMock(return_value=None))
        p.start()
        self.addCleanup(p.stop)
        async with self.client() as c:
            org = await c.post(f'/tenants/{self.tenant_id}/organizations', json={'name': 'Gamma Mills'}, headers=self.headers())
            self.org = org.json()['id']
            mp = await c.post(f'/tenants/{self.tenant_id}/organizations/{self.org}/master-policies',
                              json={'sum_assured_multiple': 24, 'term_years': 1, 'effective_date': '2030-01-01'}, headers=self.headers())
            self.assertEqual(mp.status_code, 201, mp.text)
            self.mp = mp.json()['id']
        self.base_url = f'/tenants/{self.tenant_id}/organizations/{self.org}/master-policies/{self.mp}'

    async def test_benefit_class_and_extra_cover_are_created_once_and_replayed(self):
        async with self.client() as c:
            cls = await c.post(self.base_url + '/benefit-classes', json={'name': 'Managers', 'basis': 'Flat', 'flat_amount': 5_000_000, 'is_default': True},
                               headers=self.headers('class-operation-1'))
            self.assertEqual(cls.status_code, 201, cls.text)
            again = await c.post(self.base_url + '/benefit-classes', json={'name': 'Managers', 'basis': 'Flat', 'flat_amount': 5_000_000, 'is_default': True},
                                 headers=self.headers('class-operation-1'))
            self.assertEqual((again.status_code, again.headers['idempotency-replayed'], again.json()), (201, 'true', cls.json()))
            class_id = cls.json()['id']
            url = f'{self.base_url}/benefit-classes/{class_id}/coverages'
            body = {'coverage_type': 'AccidentalDeath', 'percent_of_base': 100}
            a = await c.post(url, json=body, headers=self.headers('coverage-operation-1'))
            self.assertEqual(a.status_code, 201, a.text)
            b = await c.post(url, json=body, headers=self.headers('coverage-operation-1'))
            self.assertEqual((b.status_code, b.headers['idempotency-replayed']), (201, 'true'))
            plain = await c.post(url, json=body, headers=self.headers())
            self.assertEqual(plain.status_code, 409, 'without a key the second add is refused, as before')
            rs = await asyncio.gather(*[c.post(url, json={'coverage_type': 'Disability', 'percent_of_base': 50}, headers=self.headers('coverage-operation-2')) for _ in range(5)])
        self.assertTrue(all(r.status_code in (201, 409) for r in rs), [r.status_code for r in rs])
        self.assertEqual(await self.scalar('SELECT count(*) FROM group_benefit_classes'), 1)
        self.assertEqual(await self.scalar("SELECT count(*) FROM group_class_coverages WHERE coverage_type = 'Disability'"), 1)


if __name__ == '__main__':
    unittest.main()
