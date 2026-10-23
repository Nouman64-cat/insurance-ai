"""Administrative creates (branches, rule sets and versions) are idempotent on real PostgreSQL."""
import unittest

from idem_testkit import RouteCase
from routers import branches, rules


class AdminSetup(RouteCase):
    routers = (branches, rules)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.base_rules = f'/tenants/{self.tenant_id}/rules'

    async def test_a_retried_rule_version_is_one_version(self):
        async with self.client() as c:
            cat = await c.post(self.base_rules + '/categories', json={'code': 'CAT-IDEM', 'name': 'Cat'}, headers=self.headers('rule-category-op-1'))
            self.assertEqual(cat.status_code, 201, cat.text)
            replay = await c.post(self.base_rules + '/categories', json={'code': 'CAT-IDEM', 'name': 'Cat'}, headers=self.headers('rule-category-op-1'))
            self.assertEqual((replay.status_code, replay.headers['idempotency-replayed'], replay.json()), (201, 'true', cat.json()))
            sub = await c.post(f"{self.base_rules}/categories/{cat.json()['id']}/subcategories", json={'code': 'SUB-IDEM', 'name': 'Sub'}, headers=self.headers())
            rs = await c.post(self.base_rules + '/sets', json={'rule_code': 'RS-IDEM', 'name': 'Set', 'scope_type': 'GLOBAL', 'subcategory_id': sub.json()['id']},
                              headers=self.headers('rule-set-op-1'))
            self.assertEqual(rs.status_code, 201, rs.text)
            url = f"{self.base_rules}/sets/{rs.json()['id']}/versions"
            a = await c.post(url, headers=self.headers('rule-version-op-1'))
            b = await c.post(url, headers=self.headers('rule-version-op-1'))
            self.assertEqual((a.status_code, b.headers['idempotency-replayed'], b.json()), (201, 'true', a.json()))
            c2 = await c.post(url, headers=self.headers('rule-version-op-2'))
            self.assertNotEqual(c2.json()['version_number'], a.json()['version_number'], 'a new key is a new version')
        self.assertEqual(await self.scalar('SELECT count(*) FROM rule_versions'), 3, 'initial 1.0.0 plus exactly two requested versions')


if __name__ == '__main__':
    unittest.main()
