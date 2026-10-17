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


def _sourced_data():
    sana = {'id': 'src-sana', 'name': 'Sana Abbasi', 'code': 'AGT-007', 'source_type': 'AGENT', 'is_active': True}
    other = {'id': 'src-x', 'name': 'Habib Bank Desk', 'code': 'BNK-1', 'source_type': 'BANCASSURANCE', 'is_active': True}
    customers = [
        {'id': f'c-{i}', 'name': f'Lead {i}', 'profile_status': 'LEAD', 'created_at': f'2026-10-{i + 1:02d}',
         'acquisition_source_id': 'src-sana', 'acquisition_source': {'id': 'src-sana', 'name': 'Sana Abbasi'}}
        for i in range(18)
    ] + [{'id': 'c-x', 'name': 'Sana Abbasi Junior', 'profile_status': 'LEAD', 'created_at': '2026-10-25',
          'acquisition_source_id': 'src-x', 'acquisition_source': {'id': 'src-x', 'name': 'Habib Bank Desk'}}]
    return {
        ('/customers', 'quick_lead'): customers,
        ('/families', 'new'): [{'id': 'f-1', 'name': 'Agent Family', 'profile_status': 'LEAD',
                                'created_at': '2026-10-02', 'assigned_agent_id': 'u-bilal'}],
        ('/organizations', 'new'): [{'id': 'o-1', 'name': 'Acme', 'profile_status': 'LEAD',
                                     'created_at': '2026-10-03', 'acquisition_source_id': 'src-sana'}],
        ('/acquisition-sources', None): [sana, other],
        ('/roles', None): [{'id': 'r-agent', 'name': 'Agent'}],
        ('/users/directory', None): [{'id': 'u-bilal', 'full_name': 'Bilal Agent', 'email': 'bilal@x.pk', 'role_id': 'r-agent'}],
    }


def test_brought_by_filters_on_acquisition_source_not_lead_name():
    result = _run(_HANDLERS['list_leads']({'brought_by': 'sana abbasi', 'limit': 100}, _ctx(FakeClient(_sourced_data()))))
    assert result['total'] == 19  # 18 individuals + the organization, all lanes
    assert 'Sana Abbasi Junior' not in result['message']  # her name, someone else's lead
    assert result['message'].startswith('19 lead(s) brought in by Sana Abbasi match.')


def test_brought_by_accepts_source_code_and_assigned_agent():
    client = FakeClient(_sourced_data())
    assert _run(_HANDLERS['list_leads']({'brought_by': 'AGT-007'}, _ctx(client)))['total'] == 19
    by_agent = _run(_HANDLERS['list_leads']({'brought_by': 'Bilal'}, _ctx(client)))
    assert [l['name'] for l in by_agent['leads']] == ['Agent Family']


def test_unknown_brought_by_is_not_reported_as_zero_leads():
    result = _run(_HANDLERS['list_leads']({'brought_by': 'Nobody'}, _ctx(FakeClient(_sourced_data()))))
    assert result['success'] is False
    assert result['total'] is None
    assert 'No acquisition source or agent matches' in result['message']


def test_brought_by_works_without_sources_endpoint_access():
    data = _sourced_data()
    del data[('/acquisition-sources', None)]

    class NoSources(FakeClient):
        async def get(self, url, params=None, **kw):
            if url.endswith('/acquisition-sources'):
                return httpx.Response(403, request=httpx.Request('GET', url))
            return await super().get(url, params=params, **kw)

    result = _run(_HANDLERS['list_leads']({'brought_by': 'Sana Abbasi'}, _ctx(NoSources(data))))
    assert result['total'] == 19


def test_leads_come_newest_first_with_board_ids_intact():
    result = _run(_HANDLERS['list_leads']({'brought_by': 'Sana Abbasi', 'limit': 1}, _ctx(FakeClient(_sourced_data()))))
    newest = result['leads'][0]
    assert newest['name'] == 'Lead 17'           # created 2026-10-18, the latest of hers
    assert newest['display_id'] == 'IND-2610-018'  # IDs still follow creation order
    assert '| 2026-10-18 |' in result['message']


def test_oldest_sort():
    result = _run(_HANDLERS['list_leads']({'brought_by': 'Sana Abbasi', 'sort': 'oldest', 'limit': 1},
                                          _ctx(FakeClient(_sourced_data()))))
    assert result['leads'][0]['name'] == 'Lead 0'
