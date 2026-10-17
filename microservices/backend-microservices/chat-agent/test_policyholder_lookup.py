from test_record_lookup import FakeClient, _ctx, _run
from tool_executor import _HANDLERS


def test_policyholders_match_active_directory_not_all_customers():
    active = [{'id': str(i), 'name': name, 'active_policy_number': f'PL-2026-000{i}'}
              for i, name in enumerate(['Maryam Qureshi', 'Hamza Siddiqui', 'Hasan Baig'], 1)]
    client = FakeClient({('/customers', None): active + [{'name': 'Zainab Malik'}],
                         ('/customers', 'active'): active})
    result = _run(_HANDLERS['list_leads']({'record_scope': 'policyholders'}, _ctx(client)))
    assert result['total'] == 3
    assert 'Zainab Malik' not in result['message']
    assert 'Maryam Qureshi' in result['message']
    assert 'PL-2026-0001' in result['message']
    assert set(client.calls) == {('/customers', 'active'), ('/families', 'active'), ('/organizations', 'active')}


def test_active_families_and_corporates_are_included_and_paginated():
    client = FakeClient({('/families', 'active'): [{'name': 'Family', 'created_at': '2026-10-01'}],
                         ('/organizations', 'active'): [{'name': 'Company', 'created_at': '2026-10-02'}]})
    result = _run(_HANDLERS['list_leads']({'record_scope': 'policyholders', 'limit': 1}, _ctx(client)))
    assert result['total'] == 2
    assert result['policyholders'][0]['name'] == 'Company'
    assert result['has_more']
