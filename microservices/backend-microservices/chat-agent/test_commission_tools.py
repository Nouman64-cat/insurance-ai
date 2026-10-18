"""Live commission tool contracts: no provider calls, money movement or business writes."""
import asyncio
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from langchain_core.messages import HumanMessage

import commission_tools as tools
from commission_specialist import COMMISSION_TOOLS, select_specialist
from permission import is_role_allowed, MUTATING_TOOLS
from skills.loader import metadata
from tool_executor import Ctx, ExecCtx, _HANDLERS


class Client:
    def __init__(self, routes=None):
        self.routes = routes or {}
        self.calls = []

    async def request(self, method, url, **kw):
        path = httpx.URL(url).path.removeprefix('/tenants/t1')
        self.calls.append((method, path, kw))
        result = self.routes[(method, path)]
        if isinstance(result, Exception):
            raise result
        status, body = result
        return httpx.Response(status, json=body, request=httpx.Request(method, url))

    async def get(self, url, **kw): return await self.request('GET', url, **kw)
    async def post(self, url, **kw): return await self.request('POST', url, **kw)
    async def put(self, url, **kw): return await self.request('PUT', url, **kw)
    async def patch(self, url, **kw): return await self.request('PATCH', url, **kw)
    async def delete(self, url, **kw): return await self.request('DELETE', url, **kw)


def call(name, args, client):
    ctx = Ctx(client=client, tenant_id='t1', exec_ctx=ExecCtx(tenant_id='t1', jwt_token='token', role='Admin'))
    return asyncio.run(_HANDLERS[name](args, ctx))


def decision(**kw):
    return dict(matched=True, payable=True, rule_code='COM-AGT-IND', rule_version=2,
                rate_pct='5', gross_amount='50.00', recurring=True, reason='Recurring',
                withholding_tax_pct=None, **kw)


def test_later_year_rate_uses_recurring_premium_not_first_premium_rate():
    client = Client({('POST', '/commissions/rate-preview'): (200, decision())})
    out = call('get_commission_rate_card', {'policy_year': 2, 'premium_amount': 1000, 'channel': 'DIRECT_AGENCY'}, client)
    body = client.calls[0][2]['json']
    assert body['policy_year'] == 2 and body['installment_number'] == 2
    assert body['source_type'] == 'AGENT'
    assert '5%' in out['message'] and '50.00' in out['message']
    assert all(path.endswith('/rate-preview') for _, path, _ in client.calls)


@pytest.mark.parametrize('data,expected', [
    ({'matched': False, 'reason': 'No active version'}, 'exception'),
    ({'matched': True, 'payable': False, 'rule_code': 'COM', 'rule_version': 1,
      'reason': 'First premium only', 'recurring': False}, 'No commission'),
])
def test_missing_or_nonrecurring_rule_is_not_a_fabricated_commission(data, expected):
    client = Client({('POST', '/commissions/rate-preview'): (200, data)})
    out = call('get_commission_rate_card', {'premium_number': 2}, client)
    assert expected in out['message']


def test_policy_preview_resolves_policy_and_passes_actual_installment_without_writes():
    client = Client({('GET', '/policies'): (200, [{'id': 'p1', 'policy_number': 'PL-1'}]),
                     ('GET', '/commissions/policies/p1/preview'): (200, {'ready': False, 'reason': 'Unassigned agent'})})
    out = call('calculate_commission', {'policy_number': 'PL-1', 'premium_number': 3, 'collected_premium': 1200}, client)
    assert client.calls[-1][2]['params'] == {'amount': '1200', 'installment': 3}
    assert 'Unassigned agent' in out['message']
    assert all(method == 'GET' for method, _, _ in client.calls)


RULE = {'id': 'rule', 'rule_code': 'COM', 'name': 'First premium', 'priority': 1, 'criteria': [],
        'impact_data': {'commission_pct': 20, 'commission_recurring': True, 'recurring_commission_pct': 5,
                        'withholding_tax_pct': 10, 'recurring_years': 3}}
DRAFT = {'id': 'draft', 'version_number': 2, 'rules': [RULE]}


def test_updating_recurring_keeps_other_terms_and_only_writes_the_draft():
    client = Client({('PUT', '/rules/versions/draft/rules/rule'): (200, {})})
    with patch.object(tools, '_draft_rule', AsyncMock(return_value=({'id': 'rs'}, DRAFT, RULE))):
        out = call('update_commission_rule', {'rule_code': 'COM', 'commission_recurring': False, 'recurring_years': 0}, client)
    data = client.calls[0][2]['json']['impact_data']
    assert data['commission_pct'] == 20 and data['withholding_tax_pct'] == 10
    assert data['recurring_commission_pct'] == 5 and data['commission_recurring'] is False
    assert data['recurring_years'] is None
    assert 'not live yet' in out['message']


@pytest.mark.parametrize('conditions', ['["invalid"]', '[{"field":"email","value":"x"}]', '[{"field":"policy_year"}]'])
def test_invalid_conditions_never_create_or_modify_a_draft(conditions):
    client = Client()
    with patch('tool_executor._draft_for', AsyncMock()) as draft:
        with pytest.raises(ValueError):
            call('create_commission_rule', {'rule_code': 'NEW', 'name': 'New', 'commission_pct': 10, 'conditions_json': conditions}, client)
        draft.assert_not_called()
    assert client.calls == []


def test_noop_rule_update_does_not_open_a_draft():
    with patch.object(tools, '_draft_rule', AsyncMock()) as draft:
        out = call('update_commission_rule', {'rule_code': 'COM'}, Client())
    assert out['needs_user_input']
    draft.assert_not_called()


def test_new_rule_keeps_zero_rate_and_priority_and_is_not_deployed():
    client = Client({('POST', '/rules/versions/draft/rules'): (201, {'rule_code': 'ZERO'})})
    with patch('tool_executor._draft_for', AsyncMock(return_value=({'id': 'rs'}, {**DRAFT, 'rules': []}, 'RS-COM-002'))):
        out = call('create_commission_rule', {'rule_code': 'ZERO', 'name': 'No commission', 'commission_pct': 0, 'priority': 0}, client)
    body = client.calls[0][2]['json']
    assert body['priority'] == 0 and body['impact_data']['commission_pct'] == 0
    assert 'not live yet' in out['message']
    assert len(client.calls) == 1


def test_deploy_updates_only_the_commission_version():
    client = Client({('PATCH', '/rules/versions/draft/status'): (200, {'status': 'ACTIVE'})})
    with patch.object(tools, '_commission_rule_set', AsyncMock(return_value=({'id': 'rs'}, {}, {'version_number': 1}, DRAFT))):
        out = call('deploy_commission_rules', {}, client)
    assert client.calls[0][2]['json']['status'] == 'ACTIVE'
    assert 'already posted keep their original rate' in out['message']


def earning(i=1):
    return {'id': f'e{i}', 'source_id': 's1', 'gross_amount': '100.00', 'created_at': '2026-10-19',
            'policy_id': 'p1', 'disburse_date': '2026-11-15', 'snapshot': {'payee_name': 'Agent'}}


BATCH = {'id': 'batch-123456789', 'status': 'DRAFT', 'gross_amount': '100.00', 'created_at': '2026-10-19'}


def payout_routes(rows=None, submit=None):
    return {('GET', '/commissions/disbursements/eligible'): (200, {'items': rows or [{'earning': earning(), 'hold_reason': None}], 'has_more': False}),
            ('POST', '/commissions/disbursements'): (201, BATCH),
            ('POST', '/commissions/disbursements/batch-123456789/submit'): submit or (200, {**BATCH, 'status': 'SUBMITTED'})}


def test_payout_creation_excludes_held_earnings_and_returns_submitted_state():
    rows = [{'earning': earning(), 'hold_reason': None}, {'earning': earning(2), 'hold_reason': 'Free-look'}]
    client = Client(payout_routes(rows))
    out = call('create_payout_run', {}, client)
    assert client.calls[1][2]['json']['earning_ids'] == ['e1']
    assert out['batch']['status'] == 'SUBMITTED'
    assert 'No money has moved' in out['message']


@pytest.mark.parametrize('failure', [httpx.ReadTimeout('unknown outcome'), (409, {'detail': 'Held'})])
def test_submit_failure_preserves_existing_batch_reference_without_recreating(failure):
    client = Client(payout_routes(submit=failure))
    out = call('create_payout_run', {}, client)
    assert out['batch']['id'] == BATCH['id']
    assert out['last_action']['entity_id'] == BATCH['id']
    assert 'Commission earnings' in out['message']
    assert len([c for c in client.calls if c[1] == '/commissions/disbursements' and c[0] == 'POST']) == 1


def test_payout_limit_is_reported_instead_of_silently_dropping_earnings():
    client = Client(payout_routes([{'earning': earning(i), 'hold_reason': None} for i in range(101)]))
    out = call('create_payout_run', {}, client)
    assert len(client.calls[1][2]['json']['earning_ids']) == 100
    assert 'first 100 of 101' in out['message']


def test_held_only_creates_no_batch():
    client = Client(payout_routes([{'earning': earning(), 'hold_reason': 'Not yet payable'}]))
    out = call('create_payout_run', {}, client)
    assert not out['success']
    assert all(method == 'GET' for method, _, _ in client.calls)


def test_maker_cannot_approve_own_batch_and_refusal_is_preserved():
    client = Client({('GET', '/commissions/disbursements'): (200, [{**BATCH, 'status': 'SUBMITTED'}]),
                     ('POST', '/commissions/disbursements/batch-123456789/approve'): (403, {'detail': 'Maker cannot approve own batch'})})
    out = call('approve_payout_run', {'run_id': 'batch-12'}, client)
    assert not out['success'] and out['error_code'] == 'forbidden'
    assert 'Maker cannot approve' in out['message']
    assert not any(path.endswith('/record-payment') for _, path, _ in client.calls)


def test_new_capabilities_are_discoverable_scoped_and_mutations_classified():
    skill = next(s for s in metadata() if s.id == 'commissions')
    for name in ('deploy_commission_rules', 'set_producer_start_date', 'list_payable_commissions', 'list_payout_runs'):
        assert name in skill.capabilities and name in COMMISSION_TOOLS
        assert is_role_allowed(name, 'Admin') and is_role_allowed(name, 'SuperAdmin')
        for role in ('Agent', 'Viewer', 'Underwriter', 'Finance', 'ClaimsManager'):
            assert not is_role_allowed(name, role)
    for name in ('create_payout_run', 'approve_payout_run', 'deploy_commission_rules'):
        assert name in MUTATING_TOOLS


@pytest.mark.parametrize('text,previous', [('List payout runs', None), ('Set producer start date', None), ('Make it recurring', 'commission'), ('Deploy that draft', 'commission')])
def test_new_workflows_reach_commission_specialist(text, previous):
    assert select_specialist({'messages': [HumanMessage(content=text)], 'active_specialist': previous}) == 'commission'


def test_source_start_date_sets_the_actual_day_without_reposting_earnings():
    client = Client({('GET', '/commissions/payees'): (200, [{'id': 's1', 'name': 'Agent', 'code': 'AG1', 'active': True}]),
                     ('PUT', '/acquisition-sources/s1'): (200, {})})
    out = call('set_producer_start_date', {'payee_name': 'AG1', 'start_date': '2024-03-15'}, client)
    assert client.calls[-1][2]['json'] == {'start_date': '2024-03-15'}
    assert 'day 15' in out['message'] and 'already posted keep their payout date' in out['message']
    assert len(client.calls) == 2


def test_zero_producer_split_is_not_silently_changed_to_one_hundred_percent():
    client = Client({('GET', '/policies'): (200, [{'id': 'p1', 'policy_number': 'PL-1'}]),
                     ('GET', '/commissions/payees'): (200, [{'id': 's1', 'name': 'Agent', 'code': 'AG1', 'active': True}])})
    out = call('assign_policy_producers', {'policy_number': 'PL-1', 'producers_json': '[{"payee":"AG1","split_pct":0}]'}, client)
    assert out['error_code'] == 'validation'
    assert all(method == 'GET' for method, _, _ in client.calls)
