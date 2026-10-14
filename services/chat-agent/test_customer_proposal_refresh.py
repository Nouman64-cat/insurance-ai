import asyncio
from unittest.mock import AsyncMock, patch
import httpx
from langchain_core.messages import HumanMessage
from test_record_lookup import _ctx
from tool_executor import proposal_customer_context, _HANDLERS
import graph

class Client:
    def __init__(self):
        self.rows=[{'id':'u1','name':'Usman Khan','cnic':'11111-1111111-1'}, {'id':'u2','name':'Usman Butt','cnic':'22222-2222222-2'}]
    async def get(self,url,**kw):
        if url.endswith('/customers'): data=self.rows
        elif url.endswith('/policies'): data=[]
        else: data={**self.rows[0], 'details': {'pending_plan': {'product_name':'Apna Savings','insurance_type':'SAVINGS','coverage_amount':900000,'term_years':12}}}
        return httpx.Response(200,json=data,request=httpx.Request('GET',url))

def test_newly_added_same_name_lead_is_present_on_repeat_read():
    client=Client()
    first=asyncio.run(_HANDLERS['list_customers']({'search':'Usman'},_ctx(client)))
    client.rows.append({'id':'u3','name':'Usman Khan','cnic':'33333-3333333-3'})
    second=asyncio.run(_HANDLERS['list_customers']({'search':'Usman'},_ctx(client)))
    assert len(first['customers'])==2 and len(second['customers'])==3

def test_same_name_never_silently_selects_first_customer():
    client=Client();client.rows.append({'id':'u3','name':'Usman Khan','cnic':'33333-3333333-3'})
    result=asyncio.run(proposal_customer_context({'applicant_name':'Usman Khan'},_ctx(client)))
    assert not result['success'] and len(result['quick_actions'])==2
    result=asyncio.run(proposal_customer_context({'cnic':'99999-9999999-9','applicant_name':'Usman Khan'},_ctx(client)))
    assert not result['success']

def test_saved_plan_is_available_from_customer_detail():
    result=asyncio.run(proposal_customer_context({'cnic':'11111-1111111-1'},_ctx(Client())))
    assert result['customer']['details']['pending_plan']['product_name']=='Apna Savings'

def test_list_request_forces_fresh_tool_instead_of_model_history():
    with patch('graph.providers.resolve',AsyncMock()) as model:
        result=asyncio.run(graph.agent_node({'messages':[HumanMessage('list usman customers')]}))
        model.assert_not_awaited()
    assert result['messages'][0].tool_calls[0]['name']=='list_customers'
    assert result['messages'][0].tool_calls[0]['args']['search']=='usman'

def test_proposal_uses_saved_plan_without_recommending_again():
    from langchain_core.messages import AIMessage
    context={'success':True,'customer':{'id':'u1','cnic':'11111-1111111-1','details':{'pending_plan':{'product_name':'Apna Savings','insurance_type':'SAVINGS','coverage_amount':900000,'term_years':12}}},'policies':[]}
    seen=[]
    async def execute(name,args,ctx):
        seen.append((name,dict(args)))
        if name=='get_proposal_customer_context':return context
        if name=='list_insurance_plans':return {'items':[{'label':'Apna Savings'}]}
        return {'success':True,'message':'Created'}
    state={'tenant_id':'tenant','jwt_token':'','user_role':'Admin','messages':[AIMessage(content='',tool_calls=[{'name':'create_proposal','args':{'cnic':'11111-1111111-1'},'id':'p1','type':'tool_call'}])]}
    with patch('graph.execute_tool',execute), patch('graph.interrupt',side_effect=AssertionError('Unexpected plan question')):
        asyncio.run(graph._permission_gate(state))
    created=next(args for name,args in seen if name=='create_proposal')
    assert created['product_name']=='Apna Savings' and created['coverage_amount']==900000 and created['term_years']==12

if __name__=='__main__':
    for name,fn in sorted(list(globals().items())):
        if name.startswith('test_'):
            fn();print('PASS',name)
