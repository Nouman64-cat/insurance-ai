"""Agent sync reads must work without granting user administration or other agents' leads."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException
from database import get_session
from routers import auth, customers, families, organizations, users


class Session:
    def __init__(self):
        self.source_ids = []
        self.queries = []

    async def get(self, model, key):
        return SimpleNamespace(name=key)  # Role.name for the test actor

    async def execute(self, query):
        return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: self.source_ids), all=lambda: [])

    async def exec(self, query):
        self.queries.append(query)
        return SimpleNamespace(all=lambda: [])


class AgentLeadSyncTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tenant, self.agent_id, self.other_id = uuid4(), uuid4(), uuid4()
        self.session = Session()
        self.actors = {
            'agent': SimpleNamespace(id=self.agent_id, tenant_id=self.tenant, role_id='Agent', is_active=True),
            'admin': SimpleNamespace(id=uuid4(), tenant_id=self.tenant, role_id='Admin', is_active=True),
            'foreign': SimpleNamespace(id=uuid4(), tenant_id=uuid4(), role_id='Agent', is_active=True),
            'inactive': SimpleNamespace(id=self.agent_id, tenant_id=self.tenant, role_id='Agent', is_active=False),
        }

        async def current_user(token, session):
            if token not in self.actors:
                raise HTTPException(401, 'Invalid token')
            return self.actors[token]

        self.patches = [patch.object(auth, '_get_current_user', current_user),
                        patch.object(users, '_get_current_user', current_user),
                        patch.object(customers, '_get_current_user', current_user)]
        for p in self.patches:
            p.start()
        self.app = FastAPI()
        for module in (customers, families, organizations, users):
            self.app.include_router(module.router)

        async def session_dependency():
            yield self.session
        self.app.dependency_overrides[get_session] = session_dependency
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')

    async def asyncTearDown(self):
        await self.client.aclose()
        for p in self.patches:
            p.stop()

    def path(self, entity):
        return f'/tenants/{self.tenant}/{entity}'

    async def test_agent_sync_reads_force_own_assignments_even_if_client_requests_another_agent(self):
        for entity in ('customers', 'families', 'organizations'):
            for params in ({}, {'assigned_agent_id': str(self.other_id)}):
                with self.subTest(entity=entity, params=params):
                    self.session.queries.clear()
                    response = await self.client.get(self.path(entity), params=params,
                                                     headers={'Authorization': 'Bearer agent'})
                    self.assertEqual(response.status_code, 200, response.text)
                    compiled = self.session.queries[0].compile()
                    values = list(compiled.params.values())
                    self.assertIn(self.agent_id, values)
                    self.assertNotIn(self.other_id, values)
                    self.assertIn(self.tenant, values)

    async def test_source_linked_agent_keeps_source_scope_instead_of_an_agent_filter(self):
        source_id = uuid4()
        self.session.source_ids = [source_id]
        for entity in ('customers', 'families', 'organizations'):
            with self.subTest(entity=entity):
                self.session.queries.clear()
                response = await self.client.get(self.path(entity), params={'assigned_agent_id': str(self.other_id)},
                                                 headers={'Authorization': 'Bearer agent'})
                self.assertEqual(response.status_code, 200, response.text)
                query = self.session.queries[0].compile()
                self.assertIn([source_id], list(query.params.values()))
                self.assertNotIn('assigned_agent_id =', str(query))

    async def test_admin_keeps_optional_agent_filter(self):
        for entity in ('customers', 'families', 'organizations'):
            self.session.queries.clear()
            response = await self.client.get(self.path(entity), params={'assigned_agent_id': str(self.other_id)},
                                             headers={'Authorization': 'Bearer admin'})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIn(self.other_id, list(self.session.queries[0].compile().params.values()))

    async def test_unauthenticated_invalid_inactive_and_other_tenant_users_are_rejected(self):
        for entity in ('customers', 'families', 'organizations'):
            for token, status in ((None, 401), ('invalid', 401), ('inactive', 403), ('foreign', 403)):
                with self.subTest(entity=entity, token=token):
                    self.session.queries.clear()
                    headers = {'Authorization': f'Bearer {token}'} if token else {}
                    response = await self.client.get(self.path(entity), headers=headers)
                    self.assertEqual(response.status_code, status, response.text)
                    self.assertEqual(self.session.queries, [])

    async def test_agents_still_cannot_access_user_management(self):
        response = await self.client.get(self.path('users/'), headers={'Authorization': 'Bearer agent'})
        self.assertEqual(response.status_code, 403, response.text)
        self.assertIn('Only an Admin', response.text)

    async def test_agent_record_access_is_scoped_for_edits_and_risk(self):
        mine = SimpleNamespace(tenant_id=self.tenant, assigned_agent_id=self.agent_id, acquisition_source_id=None)
        other = SimpleNamespace(tenant_id=self.tenant, assigned_agent_id=self.other_id, acquisition_source_id=None)
        await customers._check_acquisition_access(mine, self.tenant, 'agent', self.session)
        with self.assertRaises(HTTPException) as error:
            await customers._check_acquisition_access(other, self.tenant, 'agent', self.session)
        self.assertEqual(error.exception.status_code, 404)
        source_id = uuid4()
        self.session.source_ids = [source_id]
        other.acquisition_source_id = source_id
        await customers._check_acquisition_access(other, self.tenant, 'agent', self.session)
        other.acquisition_source_id = uuid4()
        with self.assertRaises(HTTPException):
            await customers._check_acquisition_access(other, self.tenant, 'agent', self.session)

    async def test_acquisition_guard_accepts_agents_but_not_viewers(self):
        await users.verify_customer_acquisition(self.tenant, 'agent', self.session)
        self.actors['viewer'] = SimpleNamespace(id=uuid4(), tenant_id=self.tenant, role_id='Viewer', is_active=True)
        with self.assertRaises(HTTPException) as error:
            await users.verify_customer_acquisition(self.tenant, 'viewer', self.session)
        self.assertEqual(error.exception.status_code, 403)

    async def test_agent_edit_cannot_move_lead_into_proposal_or_reassign_it(self):
        from schemas import CustomerUpdate
        from shared.models.core import Customer, ProfileStatusEnum
        customer = Customer(id=uuid4(), tenant_id=self.tenant, name='Ali', assigned_agent_id=self.agent_id,
                            profile_status=ProfileStatusEnum.LEAD)
        original_get = self.session.get
        async def get(model, key):
            return customer if model is Customer else await original_get(model, key)
        self.session.get = get
        for body in (CustomerUpdate(profile_status='DRAFT'), CustomerUpdate(assigned_agent_id=self.other_id)):
            with self.assertRaises(HTTPException) as error:
                await customers.update_customer(self.tenant, customer.id, body, SimpleNamespace(),
                                                override_knockout_reason=None, session=self.session, token='agent')
            self.assertEqual(error.exception.status_code, 403)

    async def test_quick_capture_forces_agent_ownership_and_leaves_unknown_facts_empty(self):
        from schemas import CustomerCreate
        from shared.models.core import Tenant
        original_get = self.session.get
        async def get(model, key):
            return SimpleNamespace(is_active=True) if model is Tenant else await original_get(model, key)
        self.session.get = get
        self.session.add = lambda value: None
        async def noop(*args): pass
        self.session.commit = noop
        self.session.refresh = noop
        customer = await customers.create_customer(self.tenant,
            CustomerCreate(first_name='Ali', assigned_agent_id=self.other_id, details={'contact': {'mobile_number': '+923001234567'}}),
            SimpleNamespace(), self.session, 'agent')
        self.assertEqual(customer.assigned_agent_id, self.agent_id)
        self.assertIsNone(customer.dob)
        self.assertIsNone(customer.height_cm)
        self.assertIsNone(customer.weight_kg)
        self.assertIsNone(customer.is_smoker)


if __name__ == '__main__':
    unittest.main()
