"""Case workflow steps (ACR waiver, e-application invitations, panel clinics, reinsurers) are idempotent on real PostgreSQL."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from idem_testkit import RouteCase
from routers import agent_confidential_report, e_application, medical_exam, reinsurance
from shared.models.core import Case, CaseStatusEnum, CaseTypeEnum, Customer, Role, SourceChannelEnum, User


class CaseSteps(RouteCase):
    routers = (agent_confidential_report, e_application, medical_exam, reinsurance)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        async with self.factory() as s:
            role = Role(name=f'Underwriter-{uuid4().hex[:6]}', tenant_id=self.tenant_id) if hasattr(Role, 'tenant_id') else Role(name=f'Underwriter-{uuid4().hex[:6]}')
            s.add(role)
            await s.flush()
            user = User(tenant_id=self.tenant_id, role_id=role.id, email=f'{uuid4().hex}@test.invalid', username=uuid4().hex, hashed_password='x', full_name='Test UW')
            s.add(user)
            await s.flush()
            self.user_id = user.id
            customer = Customer(tenant_id=self.tenant_id, cnic=f'35202-{uuid4().int % 10**7:07d}-1', name='Test only', gender='Male')
            s.add(customer)
            await s.flush()
            case = Case(tenant_id=self.tenant_id, customer_id=customer.id, caseNumber=f'CASE-STEP-{uuid4().hex[:6]}', caseType=CaseTypeEnum.UNDERWRITING,
                        caseStatus=CaseStatusEnum.NEW, sourceChannel=SourceChannelEnum.AGENT)
            s.add(case)
            await s.commit()
            self.case_id = case.caseld
        self.url = f'/tenants/{self.tenant_id}/cases/{self.case_id}'
        for target, new in (
            (agent_confidential_report, ('_require_waiver_role', AsyncMock(return_value=SimpleNamespace(email='uw@example.test', id=uuid4())))),
            (e_application, ('_get_current_user_id', AsyncMock(return_value=self.user_id))),
            (medical_exam, ('_get_current_user', AsyncMock(return_value=SimpleNamespace(id=uuid4())))),
            (reinsurance, ('_assert_role', AsyncMock(return_value=SimpleNamespace(id=uuid4(), email='uw@example.test', full_name='UW')))),
        ):
            p = patch.object(target, new[0], new=new[1])
            p.start()
            self.addCleanup(p.stop)

    async def test_acr_waiver_is_recorded_once_and_replayed(self):
        async with self.client() as c:
            h = self.headers('acr-waive-operation-1')
            a = await c.post(self.url + '/acr/waive', json={'reason': 'Agent unreachable for two weeks'}, headers=h)
            self.assertEqual(a.status_code, 200, a.text)
            b = await c.post(self.url + '/acr/waive', json={'reason': 'Agent unreachable for two weeks'}, headers=h)
            conflict = await c.post(self.url + '/acr/waive', json={'reason': 'A different reason entirely'}, headers=h)
        self.assertEqual((b.status_code, b.headers['idempotency-replayed']), (200, 'true'))
        self.assertEqual(b.json()['waiver_reason'], a.json()['waiver_reason'])
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(await self.scalar('SELECT count(*) FROM agent_confidential_reports WHERE case_id = :c', c=self.case_id), 1)

    async def test_application_invitation_is_emailed_once_and_the_link_is_never_kept(self):
        delivery = AsyncMock(return_value={'emailed_to': 'customer.name@example.com', 'email_status': 'sent'})
        with patch('services.customer_links.email_customer_link', delivery):
            async with self.client() as c:
                h = self.headers('eapp-invite-operation-1')
                a = await c.post(self.url + '/e-application/medical/invite', headers=h)
                self.assertEqual(a.status_code, 200, a.text)
                self.assertTrue(a.json()['token'])
                b = await c.post(self.url + '/e-application/medical/invite', headers=h)
        self.assertEqual((b.headers['idempotency-replayed'], b.json()['token'], b.json()['emailed_to']), ('true', None, 'c***@example.com'))
        self.assertEqual(delivery.await_count, 1)
        stored = str(await self.scalar("SELECT response_json FROM idempotency_records WHERE operation = 'tenant.eapp.invite_part'"))
        self.assertNotIn(a.json()['token'], stored)
        self.assertNotIn('customer.name', stored)

    async def test_panel_clinic_and_reinsurer_creation_are_once_only(self):
        async with self.client() as c:
            clinic = {'code': 'LAB-1', 'name': 'City Lab', 'city': 'Lahore'}
            rs = await asyncio.gather(*[c.post(f'/tenants/{self.tenant_id}/panel-clinics', json=clinic, headers=self.headers('clinic-operation-1')) for _ in range(5)])
            self.assertTrue(all(r.status_code in (201, 409) for r in rs), [r.status_code for r in rs])
            self.assertEqual(await self.scalar('SELECT count(*) FROM panel_clinics'), 1)
            re_body = {'code': 'RE-1', 'name': 'Re Co', 'country': 'PK'}
            a = await c.post(f'/tenants/{self.tenant_id}/reinsurers', json=re_body, headers=self.headers('reinsurer-operation-1'))
            b = await c.post(f'/tenants/{self.tenant_id}/reinsurers', json=re_body, headers=self.headers('reinsurer-operation-1'))
        self.assertEqual(a.status_code, 201, a.text)
        self.assertEqual((b.status_code, b.headers['idempotency-replayed'], b.json()), (201, 'true', a.json()))
        self.assertEqual(await self.scalar('SELECT count(*) FROM reinsurers'), 1)


if __name__ == '__main__':
    unittest.main()
