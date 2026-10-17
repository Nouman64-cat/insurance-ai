import asyncio
import json
from unittest.mock import AsyncMock, patch
import httpx
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from test_record_lookup import _ctx
from tool_executor import _HANDLERS
import graph


def test_send_draft_matches_leads_page_and_never_calls_cases():
    class Client:
        def __init__(self): self.calls = []
        async def get(self, url, **kwargs):
            row = {'id': 'u-1', 'name': 'Usman Raza', 'cnic': '33100-3053529-9',
                   'details': {'pending_plan': {'product_name': 'Term Life'}, 'phone': '123'}}
            return httpx.Response(200, json=[row] if url.endswith('/customers') else row, request=httpx.Request('GET', url))
        async def post(self, url, json):
            self.calls.append(('post', url, json))
            return httpx.Response(200, json={}, request=httpx.Request('POST', url))
        async def put(self, url, json):
            self.calls.append(('put', url, json))
            return httpx.Response(200, json={}, request=httpx.Request('PUT', url))
    client = Client()
    result = asyncio.run(_HANDLERS['update_customer']({'cnic': '33100-3053529-9', 'send_to_draft': True}, _ctx(client)))
    assert result['sent_to_draft']
    assert result['navigate']['route'] == 'proposal'
    assert len(client.calls) == 2
    assert client.calls[0][1].endswith('/customers/u-1/policies')
    assert client.calls[1][2] == {'profile_status': 'DRAFT', 'details': {'phone': '123'}}
    assert not any('/cases' in url for _, url, _ in client.calls)


def test_successful_draft_stops_without_another_model_or_underwriting_call():
    state = {'messages': [HumanMessage('send draft for this customer please'),
                          ToolMessage(content=json.dumps({'success':True, 'sent_to_draft':True, 'message':'Sent to Proposals'}), tool_call_id='draft')]}
    with patch('graph.providers.resolve', AsyncMock()) as resolve:
        result = asyncio.run(graph.agent_node(state))
        resolve.assert_not_awaited()
    assert result['messages'][0].content == 'Sent to Proposals'
    assert not result['messages'][0].tool_calls
