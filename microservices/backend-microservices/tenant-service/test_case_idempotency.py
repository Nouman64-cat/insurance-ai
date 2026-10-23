"""Underwriting case actions (comment, hold, assign) are idempotent on real PostgreSQL."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from idem_testkit import RouteCase
from routers import cases
from shared.models.core import (Case, CaseStatusEnum, CaseTypeEnum, Customer, Role, SourceChannelEnum, User)


class CaseActions(RouteCase):
    routers = (cases,)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        async with self.factory() as s:
            role = Role(name=f'Underwriter-{uuid4().hex[:6]}', tenant_id=self.tenant_id) if hasattr(Role, 'tenant_id') else Role(name=f'Underwriter-{uuid4().hex[:6]}')
            s.add(role)
            await s.flush()
            self.user = User(tenant_id=self.tenant_id, role_id=role.id, email=f'{uuid4().hex}@test.invalid', username=uuid4().hex,
                             hashed_password='x', full_name='Test UW')
            s.add(self.user)
            customer = Customer(tenant_id=self.tenant_id, cnic=f'35202-{uuid4().int % 10**7:07d}-1', name='Test only', gender='Male')
            s.add(customer)
            await s.flush()
            case = Case(tenant_id=self.tenant_id, customer_id=customer.id, caseNumber=f'CASE-IDEM-{uuid4().hex[:6]}', caseType=CaseTypeEnum.UNDERWRITING,
                        caseStatus=CaseStatusEnum.NEW, sourceChannel=SourceChannelEnum.AGENT)
            s.add(case)
            await s.commit()
            self.case_id = case.caseld
        p = patch.object(cases, '_hold_actor', new=AsyncMock(return_value=SimpleNamespace(id=self.user.id, email='uw@example.test')))
        p.start()
        self.addCleanup(p.stop)
        self.url = f'/tenants/{self.tenant_id}/cases/{self.case_id}'

    async def comments(self):
        return await self.scalar('SELECT count(*) FROM case_comments WHERE "caseld" = :c', c=self.case_id)

    async def test_a_retried_comment_is_added_once_and_a_new_key_is_a_new_comment(self):
        body = {'commentText': 'Customer called, will send the lab report.', 'commentType': 'Internal', 'visibilityLevel': 'Team'}
        async with self.client() as c:
            h = self.headers('case-comment-operation-1')
            a = await c.post(self.url + '/comments', json=body, headers=h)
            self.assertEqual(a.status_code, 200, a.text)
            b = await c.post(self.url + '/comments', json=body, headers=h)
            self.assertEqual((b.json(), b.headers['idempotency-replayed']), ({'status': 'comment added'}, 'true'))
            self.assertEqual(await self.comments(), 1)
            again = await c.post(self.url + '/comments', json=body, headers=self.headers('case-comment-operation-2'))
            self.assertEqual(again.status_code, 200)
        self.assertEqual(await self.comments(), 2, 'saying the same thing twice on purpose is two comments')

    async def test_concurrent_identical_comments_post_once(self):
        body = {'commentText': 'Double click.', 'commentType': 'Internal', 'visibilityLevel': 'Team'}
        async with self.client() as c:
            rs = await asyncio.gather(*[c.post(self.url + '/comments', json=body, headers=self.headers('case-comment-operation-3')) for _ in range(6)])
        self.assertTrue(all(r.status_code in (200, 409) for r in rs), [r.status_code for r in rs])
        self.assertEqual(await self.comments(), 1)

    async def test_hold_replays_the_case_and_a_second_hold_is_refused(self):
        async with self.client() as c:
            h = self.headers('case-hold-operation-1')
            first = await c.post(self.url + '/hold', json={'reason': 'waiting for the lab'}, headers=h)
            self.assertEqual(first.status_code, 200, first.text)
            replay = await c.post(self.url + '/hold', json={'reason': 'waiting for the lab'}, headers=h)
            other = await c.post(self.url + '/hold', json={'reason': 'waiting for the lab'}, headers=self.headers('case-hold-operation-2'))
        self.assertEqual((replay.status_code, replay.headers['idempotency-replayed']), (200, 'true'))
        self.assertEqual(replay.json()['caseld'], first.json()['caseld'])
        self.assertTrue(replay.json()['on_hold'])
        self.assertEqual(other.status_code, 409)
        self.assertEqual(await self.scalar("SELECT count(*) FROM idempotency_records WHERE operation = 'tenant.case.hold' AND status = 'COMPLETED'"), 1)

    async def test_no_key_means_the_original_behaviour(self):
        async with self.client() as c:
            body = {'commentText': 'No key supplied.', 'commentType': 'Internal', 'visibilityLevel': 'Team'}
            await c.post(self.url + '/comments', json=body, headers=self.headers())
            await c.post(self.url + '/comments', json=body, headers=self.headers())
        self.assertEqual(await self.comments(), 2, 'optional enforcement: an unkeyed client is not deduplicated')
        self.assertEqual(await self.scalar('SELECT count(*) FROM idempotency_records'), 0)


if __name__ == '__main__':
    unittest.main()
