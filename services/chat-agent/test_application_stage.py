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
