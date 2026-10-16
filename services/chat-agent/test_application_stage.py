import asyncio
from unittest.mock import patch
import httpx
import pytest
from test_record_lookup import _ctx
from tool_executor import _HANDLERS

@pytest.mark.parametrize('status, expected', [('Quoted','Proposal Draft'), ('Proposed','Proposal Submitted'), ('UnderReview','Proposal Under Review')])
def test_proposal_is_an_application_without_underwriting_case(status, expected):
    class Client:
        async def get(self, url, **kwargs):
            if url.endswith('/ipp'):
                return httpx.Response(200, json={'status':'NotStarted'}, request=httpx.Request('GET', url))
            if url.endswith('/customers'):
                rows = [{'id':'u1','name':'Usman Farooq','cnic':'12345-1234567-1','profile_status':'DRAFT'}]
            else:
                rows = [{'id':'p1','status':status,'created_at':'2026-10-14'}]
            return httpx.Response(200, json=rows, request=httpx.Request('GET', url))
    from unittest.mock import AsyncMock
    with patch('tool_executor._resolve_case', AsyncMock(side_effect=LookupError('No case'))):
        result = asyncio.run(_HANDLERS['get_case_details']({'cnic':'12345-1234567-1'}, _ctx(Client())))
    assert result['success']
    assert result['application_stage'] == expected
    assert result['underwriting_case'] is None
    assert 'Create a case' not in result['message']
    assert 'Initial premium: **not yet requested**' in result['message']


def test_plan_is_the_one_the_proposals_page_shows():
    # Zainab Khan: two open proposals; the Proposals page shows only the newest, so the chat names only that one.
    class Client:
        async def get(self, url, **kwargs):
            if url.endswith('/ipp'):
                assert '/policies/p-new/ipp' in url  # the payment of the proposal she is shown with
                return httpx.Response(200, json={'status':'Realized','amount':52278.41,'method':'Cash','reference':'JC-F286106D',
                                                 'realized_at':'2026-10-16T15:19:51'}, request=httpx.Request('GET', url))
            if url.endswith('/customers'):
                rows = [{'id':'u1','name':'Zainab Khan','cnic':'17301-9104209-6','profile_status':'DRAFT'}]
            else:
                rows = [{'id':'p-new','status':'Quoted','product_name':'Sehat Zamanat','coverage_amount':12900000,'term_years':5,'created_at':'2026-10-16T14:48:00'},
                        {'id':'p-old','status':'Quoted','product_name':'Salary Protection Plan','coverage_amount':5000000,'term_years':5,'created_at':'2026-10-16T14:46:29'}]
            return httpx.Response(200, json=rows, request=httpx.Request('GET', url))
    from unittest.mock import AsyncMock
    with patch('tool_executor._resolve_case', AsyncMock(side_effect=LookupError('No case'))):
        result = asyncio.run(_HANDLERS['get_case_details']({'cnic':'17301-9104209-6'}, _ctx(Client())))
    assert result['plan']['id'] == 'p-new' and 'policies' not in result
    assert 'Plan: **Sehat Zamanat** — PKR 12,900,000 over 5 years' in result['message']
    assert 'Salary Protection' not in str(result)
    # The initial premium is paid on the proposal before a case exists; it must not read as "no payment recorded".
    assert result['initial_premium']['status'] == 'Realized'
    assert 'Initial premium **received**: PKR 52,278 on 2026-10-16 (Cash, ref JC-F286106D)' in result['message']
