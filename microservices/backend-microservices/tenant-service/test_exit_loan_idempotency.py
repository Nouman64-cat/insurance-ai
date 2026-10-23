"""Recording a policy loan (money lent against the policy) happens once per operation on real PostgreSQL."""
import asyncio
import unittest

from idem_testkit import RouteCase
from routers import policy_exit
from shared.models.core import PolicyStatusEnum


class Loans(RouteCase):
    routers = (policy_exit,)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.stub_role_dependencies()
        self.p = await self.make_policy(status=PolicyStatusEnum.ACTIVE, policy_number='POL-IDEM-LOAN')

    async def test_a_retried_loan_is_recorded_once(self):
        url = self.base(self.p.policy_id) + '/exit/loans'
        body = {'principal': 25000, 'annual_interest_pct': 8, 'disbursed_on': '2026-01-15', 'reference': 'LN-1'}
        async with self.client() as c:
            h = self.headers('loan-operation-1')
            a = await c.post(url, json=body, headers=h)
            self.assertEqual(a.status_code, 201, a.text)
            b = await c.post(url, json=body, headers=h)
            rs = await asyncio.gather(*[c.post(url, json={**body, 'reference': 'LN-2'}, headers=self.headers('loan-operation-2')) for _ in range(5)])
        self.assertEqual((b.status_code, b.headers['idempotency-replayed']), (201, 'true'))
        self.assertTrue(all(r.status_code in (201, 409) for r in rs), [r.status_code for r in rs])
        self.assertEqual(await self.scalar('SELECT count(*) FROM policy_loans WHERE policy_id = :p', p=self.p.policy_id), 2)


if __name__ == '__main__':
    unittest.main()
