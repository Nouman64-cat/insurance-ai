"""Creating customers, users, producers and plans is idempotent on real PostgreSQL; no password is ever stored."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from idem_testkit import RouteCase
from routers import acquisition_sources, customers, insurance_plans, users
from shared.models.core import Role


class Provisioning(RouteCase):
    routers = (customers, users, acquisition_sources, insurance_plans)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.app.dependency_overrides[users.verify_admin] = lambda: None
        self.app.dependency_overrides[customers.verify_customer_acquisition] = lambda: None
        async with self.factory() as s:
            admin_role = Role(name=f'Admin-{uuid4().hex[:6]}')
            s.add(admin_role)
            s.add(Role(name='Agent'))
            await s.commit()
            admin_role_id = admin_role.id
        self.actor = SimpleNamespace(id=uuid4(), tenant_id=self.tenant_id, branch_id=None, email='admin@example.test', full_name='Admin', role_id=admin_role_id)
        patches = [
            patch.object(customers, '_get_current_user', new=AsyncMock(return_value=self.actor)),
            patch.object(customers, '_role_name', new=AsyncMock(return_value='Admin')),
            patch.object(customers, 'source_scope', new=AsyncMock(return_value=None)),
            patch.object(users, '_get_current_user', new=AsyncMock(return_value=self.actor)),
            patch.object(acquisition_sources, '_get_current_user', new=AsyncMock(return_value=self.actor)),
        ]
        self.mail_users, self.mail_sources = AsyncMock(return_value=True), AsyncMock(return_value=True)
        patches += [patch.object(users, 'send_credentials_email', new=self.mail_users), patch.object(acquisition_sources, 'send_credentials_email', new=self.mail_sources)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    async def test_a_retried_customer_is_created_once(self):
        url = f'/tenants/{self.tenant_id}/customers'
        body = {'first_name': 'Imran', 'last_name': 'Shah', 'cnic': '35202-7654321-9', 'date_of_birth': '1988-04-02', 'gender': 'Male'}
        async with self.client() as c:
            h = self.headers('customer-create-op-1')
            a = await c.post(url, json=body, headers=h)
            self.assertEqual(a.status_code, 201, a.text)
            b = await c.post(url, json=body, headers=h)
            conflict = await c.post(url, json={**body, 'first_name': 'Changed'}, headers=h)
            self.assertEqual(conflict.status_code, 409, conflict.text)
            self.assertEqual(await self.scalar('SELECT count(*) FROM customers'), 1)
            rs = await asyncio.gather(*[c.post(url, json={**body, 'cnic': '35202-1111111-1', 'first_name': 'Other'}, headers=self.headers('customer-create-op-2')) for _ in range(5)])
        self.assertEqual((b.status_code, b.headers['idempotency-replayed'], b.json()['id']), (201, 'true', a.json()['id']))
        self.assertTrue(all(r.status_code in (201, 409) for r in rs), [r.status_code for r in rs])
        self.assertEqual(await self.scalar('SELECT count(*) FROM customers'), 2)

    async def test_a_retried_user_is_created_and_e_mailed_once_without_keeping_the_password(self):
        async with self.factory() as s:
            role = Role(name=f'Agent-{uuid4().hex[:6]}')
            s.add(role)
            await s.commit()
            role_id = role.id
        url = f'/tenants/{self.tenant_id}/users/'
        body = {'email': 'new.agent@example.com', 'full_name': 'New Agent', 'role_id': str(role_id)}
        async with self.client() as c:
            h = self.headers('user-create-op-1')
            a = await c.post(url, json=body, headers=h)
            self.assertEqual(a.status_code, 201, a.text)
            b = await c.post(url, json=body, headers=h)
        self.assertEqual((b.status_code, b.headers['idempotency-replayed'], b.json()['id']), (201, 'true', a.json()['id']))
        self.assertEqual(self.mail_users.await_count, 1)
        self.assertEqual(await self.scalar("SELECT count(*) FROM users WHERE email = 'new.agent@example.com'"), 1)
        password = self.mail_users.await_args.kwargs['password']
        stored = str(await self.scalar("SELECT response_json FROM idempotency_records WHERE operation = 'tenant.user.create'"))
        self.assertNotIn(password, stored)
        self.assertNotIn('new.agent', stored)

    async def test_a_retried_producer_with_a_login_sends_credentials_once(self):
        url = f'/tenants/{self.tenant_id}/acquisition-sources'
        body = {'source_type': 'AGENT', 'name': 'Broker One', 'code': 'BRK-1', 'contact_email': 'broker@example.com', 'contact_person': 'Broker'}
        async with self.client() as c:
            h = self.headers('source-create-op-1')
            a = await c.post(url, json=body, headers=h)
            self.assertEqual(a.status_code, 201, a.text)
            b = await c.post(url, json=body, headers=h)
        self.assertEqual((b.status_code, b.headers['idempotency-replayed'], b.json()['id']), (201, 'true', a.json()['id']))
        self.assertEqual(self.mail_sources.await_count, 1)
        self.assertEqual(await self.scalar('SELECT count(*) FROM acquisition_sources'), 1)


if __name__ == '__main__':
    unittest.main()
