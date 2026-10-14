"""Lead counts must use all board lanes, not the customer registry."""
import httpx
import pytest

from test_record_lookup import FakeClient, _ctx, _run
from tool_executor import _HANDLERS
from tools import ListLeadsArgs


def test_count_includes_all_lanes_and_excludes_policyholders():
    result = _run(_HANDLERS['list_leads']({}, _ctx()))
    assert result['total'] == 6
    assert len(result['leads']) == 6
    assert {r['lead_type'] for r in result['leads']} == {'INDIVIDUAL', 'FAMILY', 'CORPORATE'}
    assert 'Old Policyholder' not in result['message']
    assert 'Bilal Ahmed' in result['message']


def test_pagination_preserves_total():
    result = _run(_HANDLERS['list_leads']({'limit': 2, 'offset': 2}, _ctx()))
    assert result['total'] == 6
    assert len(result['leads']) == 2
    assert result['has_more']


def test_search_and_lane_keep_board_ids():
    result = _run(_HANDLERS['list_leads']({'lead_type': 'INDIVIDUAL', 'search': 'Bilal'}, _ctx()))
    assert result['total'] == 1
    assert result['leads'][0]['display_id'] == 'IND-2610-002'


def test_empty_list():
    result = _run(_HANDLERS['list_leads']({}, _ctx(FakeClient({}))))
    assert result['total'] == 0
    assert result['leads'] == []
    assert not result['has_more']


def test_failure_is_not_reported_as_zero_leads():
    class FailingClient:
        async def get(self, url, **kwargs):
            return httpx.Response(403, request=httpx.Request('GET', url))
    with pytest.raises(httpx.HTTPStatusError):
        _run(_HANDLERS['list_leads']({}, _ctx(FailingClient())))


def test_negative_limit_rejected():
    with pytest.raises(ValueError):
        ListLeadsArgs(limit=-1)


def test_customer_scope_preserves_customer_lookup():
    result = _run(_HANDLERS['list_leads']({'record_scope': 'customers'}, _ctx()))
    assert len(result['customers']) == 5
    assert any(r['name'] == 'Old Policyholder' for r in result['customers'])


def test_lead_list_returns_a_table_with_escaped_cells():
    data = {('/customers', 'quick_lead'): [{
        'id': 'c-1', 'name': 'Sara | Hassan\nAccountant',
        'profile_status': 'UNDERWRITING_READY', 'created_at': '2026-10-01',
        'occupation': 'Accountant', 'declared_income': 2100000,
    }]}
    result = _run(_HANDLERS['list_leads']({}, _ctx(FakeClient(data))))
    assert '\n\n| Lead ID | Name | Type | Status | Occupation | Declared Income (PKR) |' in result['message']
    assert r'Sara \| Hassan Accountant' in result['message']
    assert '| 2,100,000 |' in result['message']

    assert '| Individual | Ready for Underwriting |' in result['message']
    assert 'UNDERWRITING_READY' not in result['message']
    assert result['leads'][0]['lead_status'] == 'UNDERWRITING_READY'
    assert result['leads'][0]['status_label'] == 'Ready for Underwriting'
