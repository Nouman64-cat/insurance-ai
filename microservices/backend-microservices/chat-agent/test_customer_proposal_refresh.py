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

# ── Usman Khan × 2: a CNIC never lands on a namesake, and a proposal always has its case ──

class CaseClient:
    """Two customers called Usman Khan; only the teacher (33333) has a case."""
    def __init__(self, policies=None):
        self.customers=[{'id':'doc','name':'Usman Khan','first_name':'Usman','last_name':'Khan','cnic':'36302-0072138-8'},
                        {'id':'tea','name':'Usman Khan','first_name':'Usman','last_name':'Khan','cnic':'33100-2094014-7'}]
        self.cases=[{'id':'case-teacher','caseNumber':'APP-T','customer_cnic':'33100-2094014-7','customer_name':'Usman Khan','caseStatus':'New'}]
        self.policies=policies or []
        self.posts=[]
        self.puts=[]
    async def get(self,url,**kw):
        if url.endswith('/customers'): data=self.customers
        elif url.endswith('/cases'): data=self.cases
        elif url.endswith('/policies'): data=self.policies
        elif url.endswith('/underwriting-tracks'): data=getattr(self,'tracks',{})
        elif url.endswith('/ipp'): data=getattr(self,'ipp',{'status':'NotStarted'})
        else: data=next((c for c in self.customers if url.endswith('/'+c['id'])),{})
        return httpx.Response(200,json=data,request=httpx.Request('GET',url))
    async def post(self,url,json=None,**kw):
        self.posts.append((url,json))
        if url.endswith('/cases'):
            case={'id':'case-new','caseNumber':'APP-NEW','customer_cnic':'36302-0072138-8','caseStatus':'New'}
            self.cases.append(case); data=case
        else: data={'id':'pol-new'}
        return httpx.Response(201,json=data,request=httpx.Request('POST',url))
    async def put(self,url,json=None,**kw):
        self.puts.append((url,json))
        return httpx.Response(200,json={},request=httpx.Request('PUT',url))

def test_cnic_without_a_case_never_falls_back_to_a_namesakes_case():
    from tool_executor import _find_case, _find_customer
    client=CaseClient()
    assert _find_case(client.cases, cnic='36302-0072138-8', applicant_name='Usman Khan') is None
    assert _find_case(client.cases, cnic='3310020940147')['id']=='case-teacher'  # dashes optional
    assert _find_customer(client.customers, '99999-9999999-9', 'Usman Khan') is None

def test_proposal_stays_draft_until_submission_and_initial_premium():
    client=CaseClient()
    result=asyncio.run(_HANDLERS['create_proposal']({'cnic':'36302-0072138-8','product_name':'Apna Savings'},_ctx(client)))
    assert [u.rsplit('/',1)[-1] for u,_ in client.posts]==['policies']
    assert result['policy_id']=='pol-new' and 'case_id' not in result and 'navigate' not in result
    assert result['proposal_journey']['customer_id']=='doc'
    assert 'initial premium' in result['message']

def test_proposal_replaces_the_leads_form_plan_so_it_is_not_created_twice():
    # Zainab Khan: Sehat Zamanat picked on the form, then "change it to Salary Protection" in the chat.
    client=CaseClient()
    client.customers[0]['details']={'phone':'123','pending_plan':{'product_name':'Sehat Zamanat','coverage_amount':12900000,'term_years':5}}
    result=asyncio.run(_HANDLERS['create_proposal']({'cnic':'36302-0072138-8','product_name':'Salary Protection Plan'},_ctx(client)))
    assert client.puts==[(client.puts[0][0],{'details':{'phone':'123'}})]  # form plan cleared, other details kept
    assert 'replaces the previously selected **Sehat Zamanat**' in result['message']

def test_switching_plan_never_opens_a_second_open_proposal():
    client=CaseClient(policies=[{'id':'pol-old','status':'Quoted','product_name':'Sehat Zamanat'}])
    result=asyncio.run(_HANDLERS['create_proposal']({'cnic':'36302-0072138-8','product_name':'Salary Protection Plan'},_ctx(client)))
    assert result['skipped'] and not client.posts
    assert 'open **Sehat Zamanat** proposal' in result['message'] and 'Change Plan' in result['message']
    result=asyncio.run(_HANDLERS['create_proposal']({'cnic':'36302-0072138-8','product_name':'Salary Protection Plan','additional_proposal':True},_ctx(client)))
    assert not result.get('skipped') and client.posts[0][1]['product_name']=='Salary Protection Plan'

def test_draft_proposal_offers_proposal_ui_instead_of_underwriting_gates():
    client=CaseClient()
    result=asyncio.run(_HANDLERS['create_proposal']({'cnic':'36302-0072138-8','product_name':'Apna Savings'},_ctx(client)))
    labels=[q['label'] for q in result['quick_actions']]
    assert 'Open Proposals' in labels
    assert not any('E-App' in label or 'Underwriter' in label for label in labels)

def test_e_application_requires_submitted_proposal_and_received_initial_premium():
    import pytest
    from tool_executor import _case_for_open_proposal, PrerequisiteMissing
    client=CaseClient(policies=[{'id':'pol-old','status':'Proposed','product_name':'Apna Savings'}])
    with pytest.raises(PrerequisiteMissing, match='initial premium'):
        asyncio.run(_case_for_open_proposal({'cnic':'36302-0072138-8'},_ctx(client)))
    assert not client.posts
    client.ipp={'status':'Realized'}
    case=asyncio.run(_case_for_open_proposal({'cnic':'36302-0072138-8'},_ctx(client)))
    assert case['id']=='case-new'
    assert client.posts[0][1]['policy_id']=='pol-old'
    assert asyncio.run(_case_for_open_proposal({'cnic':'36302-0072138-8'},_ctx(CaseClient()))) is None

def test_create_case_reuses_the_open_case_and_offers_gate_one():
    client=CaseClient(policies=[{'status':'Proposed'}])
    result=asyncio.run(_HANDLERS['create_case']({'cnic':'33100-2094014-7'},_ctx(client)))
    assert result['skipped'] and result['case_id']=='case-teacher' and not client.posts
    assert result['quick_actions'][0]['label'].startswith('1. Generate E-App Link')

def test_model_invented_plan_and_figures_are_dropped():
    args={'cnic':'36302-0072138-8','product_name':'COVID-19 Protection Plan','insurance_type':'HEALTH_CASH','coverage_amount':19200000,'term_years':5}
    graph._drop_invented_plan_terms(args,'no, the doctor one')
    assert args=={'cnic':'36302-0072138-8'}
    args={'product_name':'Apna Savings','coverage_amount':2000000,'term_years':15}
    graph._drop_invented_plan_terms(args,'create apna savings proposal for 20 lakh over 15 years')
    assert args['product_name']=='Apna Savings' and args['coverage_amount']==2000000
    args={'product_name':'Apna Savings','coverage_amount':2000000}
    graph._drop_invented_plan_terms(args,'Create proposal with Apna Savings for CNIC 36302-0072138-8')
    assert 'coverage_amount' not in args  # a CNIC is not a figure

def test_chosen_plan_sets_its_type_and_term_range():
    plans=[{'label':'Roshan Aaj Aur Kal','insurance_type':'CHILD_EDUCATION_MARRIAGE','term_min_years':10,'term_max_years':24}]
    args={'product_name':'Roshan Aaj Aur Kal'}; graph._apply_catalog_plan(args,plans)
    assert args=={'product_name':'Roshan Aaj Aur Kal','insurance_type':'CHILD_EDUCATION_MARRIAGE','term_years':10}
    args={'product_name':'Roshan Aaj Aur Kal','term_years':30}; graph._apply_catalog_plan(args,plans)
    assert args['term_years']==24

def test_bare_create_proposal_asks_for_the_plan_instead_of_guessing():
    from langchain_core.messages import AIMessage
    context={'success':True,'customer':{'id':'u1','cnic':'36302-0072138-8','details':{}},'policies':[]}
    async def execute(name,args,ctx):
        if name=='get_proposal_customer_context':return context
        if name=='list_insurance_plans':return {'items':[{'label':'COVID-19 Protection Plan'},{'label':'Apna Savings'}]}
        if name=='list_customers':return {'customers':[]}
        raise AssertionError(f'{name} ran before a plan was chosen')
    class Asked(Exception):pass
    def ask(payload):
        assert payload['question'].startswith('Which insurance plan'); raise Asked
    state={'tenant_id':'t','jwt_token':'','user_role':'Admin',
           'messages':[HumanMessage('okay create proposal'),AIMessage(content='',tool_calls=[{'name':'create_proposal','args':{'cnic':'36302-0072138-8','product_name':'COVID-19 Protection Plan','coverage_amount':19200000},'id':'p1','type':'tool_call'}])]}
    with patch('graph.execute_tool',execute), patch('graph.interrupt',side_effect=ask):
        try:
            asyncio.run(graph._permission_gate(state)); raise AssertionError('no plan question')
        except Asked: pass

if __name__=='__main__':
    for name,fn in sorted(list(globals().items())):
        if name.startswith('test_'):
            fn();print('PASS',name)
