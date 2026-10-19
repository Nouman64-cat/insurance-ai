"""The agent copilot acquires leads; it never advances underwriting or proposals."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import pytest

import graph
import permission
import tool_executor
from acquisition_tools import record_lead, select_customer_plan


class Response:
    def __init__(self, data): self.data = data
    def json(self): return self.data
    def raise_for_status(self): pass


class Client:
    def __init__(self, customer=None, plans=None):
        self.customer = customer or {'id': 'c1', 'name': 'Ali', 'dob': '1995-01-01', 'declared_income': 1000000,
                                    'profile_status': 'LEAD', 'details': {'contact': {'email': 'ali@example.com'}, 'risk_assessment': {'saved': True}}}
        self.plans = plans or [dict(id='plan1', label='Life Cover', category='Individual', status='Active', entry_age_min=18,
                                   entry_age_max=60, term_min_years=5, term_max_years=20, max_maturity_age=70,
                                   max_income_multiple=10, insurance_type='TERM_LIFE')]
        self.writes = []
    async def get(self, url, **kwargs):
        return Response(self.plans if url.endswith('/insurance-plans') else [self.customer] if url.endswith('/customers') else self.customer)
    async def post(self, url, **kwargs):
        self.writes.append(('POST', url, kwargs.get('json')))
        return Response({'id': 'new-lead', 'name': kwargs['json']['first_name']})
    async def put(self, url, **kwargs):
        self.writes.append(('PUT', url, kwargs.get('json')))
        return Response({**self.customer, **kwargs['json']})


def context(client):
    return tool_executor.Ctx(client=client, tenant_id='test', exec_ctx=tool_executor.ExecCtx(tenant_id='test', jwt_token='', role='Agent', platform='mobile'))


@pytest.mark.parametrize('platform', ['web', 'mobile'])
def test_agent_permissions_are_acquisition_only(platform):
    for name in ('record_lead', 'update_customer', 'list_customers', 'run_customer_risk_assessment', 'get_customer_risk_assessment', 'select_customer_plan'):
        assert permission.is_role_allowed(name, 'Agent', platform)
    for name in ('create_case', 'create_proposal', 'submit_agent_confidential_report', 'run_risk_assessment',
                 'run_ai_medical_underwriting', 'approve_case', 'issue_policy', 'issue_claim_payout', 'get_agent_statement', 'transition_proposal'):
        assert not permission.is_role_allowed(name, 'Agent', platform)


def test_agent_prompt_is_pinned_to_acquisition():
    prompt = graph._build_prompt('Agent', 'mobile')
    assert graph.coordinator_node({'user_role': 'Agent', 'messages': []})['selected_skills'] == ['lead-customer-acquisition']
    assert 'Lead & Customer Acquisition Copilot' in prompt
    assert 'run_customer_risk_assessment' in prompt
    assert 'coming soon' in prompt
    assert 'all 5 pre-underwriting gates' not in prompt


def test_quick_lead_preserves_unknown_facts_and_does_not_create_a_case():
    client = Client()
    with patch('acquisition_tools._current_user', AsyncMock(return_value={'id': 'agent1'})):
        result = asyncio.run(record_lead({'first_name': 'Ali', 'phone': '+92 300 1234567'}, context(client)))
    assert result['success']
    assert len(client.writes) == 1
    method, url, body = client.writes[0]
    assert method == 'POST' and url.endswith('/customers')
    assert body['assigned_agent_id'] == 'agent1'
    assert body['details']['contact']['mobile_number'] == '+92 300 1234567'
    assert not any(k in body for k in ('date_of_birth', 'cnic', 'declared_income', 'height_cm', 'weight_kg', 'is_smoker'))


def test_plan_selection_only_updates_pending_plan_and_preserves_details():
    client = Client()
    result = asyncio.run(select_customer_plan({'customer_id': 'c1', 'plan_id': 'plan1', 'coverage_amount': 5000000, 'term_years': 10}, context(client)))
    assert result['success']
    assert len(client.writes) == 1
    method, url, body = client.writes[0]
    assert method == 'PUT' and url.endswith('/customers/c1')
    assert set(body) == {'details'}
    assert body['details']['risk_assessment'] == {'saved': True}
    assert body['details']['contact']['email'] == 'ali@example.com'
    assert body['details']['pending_plan']['product_name'] == 'Life Cover'


@pytest.mark.parametrize('change', [dict(plan_id='not-a-plan'), dict(coverage_amount=999999999), dict(term_years=100), dict(coverage_amount=None), dict(term_years=None)])
def test_invalid_or_incomplete_selection_never_writes(change):
    client = Client()
    args = dict(customer_id='c1', plan_id='plan1', coverage_amount=5000000, term_years=10, **{})
    args.update(change)
    result = asyncio.run(select_customer_plan(args, context(client)))
    assert not result['success'] and not client.writes


def test_age_comparison_does_not_save_or_offer_inactive_or_group_plans():
    client = Client()
    client.plans += [{**client.plans[0], 'id': 'archived', 'status': 'Archived'}, {**client.plans[0], 'id': 'family', 'category': 'Family'}, {**client.plans[0], 'id': 'too-young', 'entry_age_min': 60}]
    result = asyncio.run(select_customer_plan({'customer_id': 'c1'}, context(client)))
    assert [p['id'] for p in result['plans']] == ['plan1']
    assert not client.writes


def test_agent_cannot_send_lead_to_draft_using_update_tool():
    client = Client()
    result = asyncio.run(tool_executor._update_customer({'customer_id': 'c1', 'send_to_draft': True}, context(client)))
    assert not result['success'] and not client.writes


def test_contact_edit_preserves_assessment_and_does_not_overwrite_demographics():
    client = Client()
    result = asyncio.run(tool_executor._update_customer({'customer_id': 'c1', 'phone': '+92 300 7654321'}, context(client)))
    assert result['success']
    body = client.writes[0][2]
    assert set(body) == {'details'}
    assert body['details']['risk_assessment'] == {'saved': True}
    assert body['details']['contact']['email'] == 'ali@example.com'


def test_required_quick_capture_fields():
    assert permission.missing_args('record_lead', {}) == ['first_name', 'phone']


def test_cnic_correction_changes_only_the_identified_record():
    client = Client()
    result = asyncio.run(tool_executor._update_customer({'customer_id': 'c1', 'new_cnic': '35202-7314890-1'}, context(client)))
    assert result['success']
    assert client.writes == [('PUT', 'http://tenant-service:8001/tenants/test/customers/c1', {'cnic': '35202-7314890-1'})]
