"""Synthetic Finance model/API tests; never pay a real claim."""
import asyncio
from unittest.mock import AsyncMock, patch
import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langchain_core.language_models.fake_chat_models import FakeListChatModel
import graph
from finance_specialist import FINANCE_TOOLS, FINANCE_DOMAINS, finance_prompt
from permission import is_role_allowed, MUTATING_TOOLS
from specialist_router import coordinator_node, route_coordinator
from skills.selector import select
from skills.registry import schema
from test_claims_commission_tools import FakeClient, _call
from test_commission_specialist import initial, call
from tool_executor import ChoiceNeeded

CLAIM={'id':'claim-a','claim_number':'CLM-2026-TEST','policy_id':'policy-a','status':'Approved','approved_amount':1000}
PATH='/policies/policy-a/claims-management/claim-a'
WS={'claim':CLAIM,'settlement':{'authorized_at':'2026-10-18','payees':[{'id':'payee-a','name':'Verified payee','amount':1000,'verified':True}],'methods':['Bank Transfer'],'payouts':[]},'can':{'disburse':True,'reconcile':False},'investigation':{'medical':'private'}}
def service(ws=WS,extra=None):return FakeClient({('GET','/claims'):[CLAIM],('GET',PATH):ws,**(extra or {})})

@pytest.mark.parametrize('text',['hello','Show payments awaiting reconciliation','approve this claim','create a customer','yes'])
def test_finance_is_always_pinned_to_its_own_specialist(text):
    update=coordinator_node(initial(text,'Finance'))
    assert update['active_specialist']=='finance'
    assert route_coordinator(update)=='finance_agent'

@pytest.mark.parametrize('name',['get_finance_dashboard','get_claim_payment_details','pay_authorized_claim','reconcile_finance_claim'])
def test_capabilities_are_discoverable_only_by_finance(name):
    assert schema(name,'Finance')['success']
    for role in ('Admin','SuperAdmin','ClaimsManager','ClaimsAdjuster','Financial Underwriter','Underwriter','Agent','Viewer'):
        assert not is_role_allowed(name,role)
    assert name in FINANCE_TOOLS
    if name in ('pay_authorized_claim','reconcile_finance_claim'):assert name in MUTATING_TOOLS

def test_skills_are_selected_with_finance_scope():
    assert 'finance-payments' in select('show finance dashboard and awaiting payout','Finance',specialist='finance')
    assert 'finance-reconciliation' in select('reconcile payment mismatch','Finance',specialist='finance')
    assert 'claims-management' not in select('approve claim','Finance',specialist='finance')

def test_payment_read_excludes_medical_data_and_staff_actions():
    client=service();r=_call('get_claim_payment_details',{'claim_number':CLAIM['claim_number']},client,'Finance')
    assert r['success'] and 'investigation' not in r and not client.writes()
    assert all(c['payload'].startswith('claims/') for c in r['quick_actions'])
    for args in ({},{'claim_number':'CLM-WRONG'}):
        with pytest.raises((ChoiceNeeded,LookupError)):_call('get_claim_payment_details',args,client,'Finance')

def test_dashboard_classifies_live_queues_without_mutation():
    rows=[CLAIM,{**CLAIM,'id':'b','status':'Settled','settlement_amount':1000},
          {**CLAIM,'id':'c','status':'Closed','settlement_amount':1000},
          {**CLAIM,'id':'d','status':'Settled','settlement_amount':1000,'finance_summary':{'reconciled_at':'2026-10-18'}}]
    client=service(extra={('GET','/claims'):rows})
    r=_call('get_finance_dashboard',{'queue':'reconciliation'},client,'Finance')
    assert [c['id'] for c in r['claims']]==['b']
    assert r['totals']['approved_pending']==1000 and not client.writes()

@pytest.mark.parametrize('ws',[{**WS,'can':{'disburse':False}}, {**WS,'settlement':{'methods':['Bank Transfer']}}, {**WS,'claim':{**CLAIM,'status':'Closed'}}, {**WS,'settlement':{**WS['settlement'],'payouts':[{'id':'paid'}]}}])
def test_unready_closed_or_paid_claim_is_never_paid(ws):
    client=service(ws);_call('pay_authorized_claim',{'claim_number':CLAIM['claim_number'],'method':'Bank Transfer'},client,'Finance')
    assert not client.writes()

def test_payment_uses_exact_authorised_workflow_and_verifies_completion():
    saved={**WS,'claim':{**CLAIM,'status':'Settled'},'settlement':{**WS['settlement'],'disbursed_at':'2026-10-18','payouts':[{'reference_number':'PAY-TEST'}]}}
    client=service(extra={('POST',PATH+'/settlement/disburse'):saved})
    r=_call('pay_authorized_claim',{'claim_number':CLAIM['claim_number'],'method':'Bank Transfer','reference_number':'BANK-TEST'},client,'Finance')
    assert r['success'] and r['claim']['status']=='Settled'
    assert client.writes()[0]['path']==PATH+'/settlement/disburse'
    assert client.writes()[0]['body']=={'method':'Bank Transfer','reference_number':'BANK-TEST'}
    failed=service(extra={('POST',PATH+'/settlement/disburse'):{}})
    assert not _call('pay_authorized_claim',{'claim_number':CLAIM['claim_number'],'method':'Bank Transfer','reference_number':'BANK-TEST'},failed,'Finance')['success']

def test_reconciliation_requires_human_exception_rationale_and_does_not_invent_completion():
    ws={**WS,'can':{'reconcile':True},'settlement':{**WS['settlement'],'reconciliation':{'status':'Exception'}}}
    client=service(ws)
    assert not _call('reconcile_finance_claim',{'claim_number':CLAIM['claim_number']},client,'Finance')['success']
    assert not client.writes()
    client=service(ws,{('POST',PATH+'/settlement/reconcile'):ws})
    r=_call('reconcile_finance_claim',{'claim_number':CLAIM['claim_number'],'note':'Reviewed bank evidence.'},client,'Finance')
    assert 'not yet reconciled' in r['message']
    assert client.writes()[0]['body']=={'note':'Reviewed bank evidence.'}

def test_model_node_binds_only_finance_scope_and_streams_final_answer():
    async def run():
        from routers.chat import _consume
        model=FakeListChatModel(responses=['Finance payment summary'],sleep=0.001)
        with patch('graph._llm',return_value=model) as binding, patch('providers.resolve',AsyncMock(return_value={})),patch('usage.record'):
            events=[e async for e in _consume(graph.build_graph(MemorySaver()),{'configurable':{'thread_id':'finance-test'}},initial('hello','Finance'))]
        assert binding.call_args.kwargs['tool_scope'] <= FINANCE_TOOLS
        assert any('Finance specialist selected' in e for e in events)
        assert any('Finance payment summary' in e for e in events)
        assert not any('"type": "error"' in e for e in events)
    asyncio.run(run())
    prompt=finance_prompt(FINANCE_TOOLS,'ur')
    assert 'Finance Copilot' in prompt and 'Urdu' in prompt and 'never invent a note' in prompt


def test_ambiguous_claim_choices_stay_in_finance_payment_scope():
    client=service(extra={('GET','/claims'):[{**CLAIM,'claimant_name':'Synthetic name'},
        {**CLAIM,'id':'claim-b','claim_number':'CLM-OTHER','claimant_name':'Synthetic name'}]})
    with pytest.raises(ChoiceNeeded) as error:
        _call('get_claim_payment_details',{'claimant_name':'Synthetic name'},client,'Finance')
    assert len(error.value.quick_actions)==2
    assert all('payment details' in c['payload'] and 'underwriting' not in c['payload'] for c in error.value.quick_actions)
    assert not client.writes()


def test_finance_prompted_read_calls_shared_executor_without_paying():
    async def run():
        model=AsyncMock()
        model.ainvoke.side_effect=[call('get_finance_dashboard'),AIMessage(content='One approved claim awaits manager authorisation.')]
        executor=AsyncMock(return_value={'success':True,'claims':[CLAIM]})
        with patch('graph._llm',return_value=model),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',executor),patch('usage.record'):
            result=await graph.build_graph(MemorySaver()).ainvoke(initial('Show payment queue','Finance'),{'configurable':{'thread_id':'finance-read'}})
        assert result['messages'][-1].content.startswith('One approved')
        assert executor.call_count==1 and executor.call_args.args[0]=='get_finance_dashboard'
    asyncio.run(run())


def test_provider_binding_uses_finance_tools_without_claim_approval_or_legacy_payout():
    class Bound:
        def bind_tools(self, tools, **kwargs):
            self.names={t.name for t in tools}
            return self
    bound=Bound()
    with patch.dict(graph._LLM_CACHE,{},clear=True),patch('graph.providers.build_chat',return_value=bound):
        graph._llm({'version':'finance-scope-test','primary':{}},'Finance',domains=FINANCE_DOMAINS,tool_scope=FINANCE_TOOLS)
    assert bound.names==FINANCE_TOOLS
    assert not {'issue_claim_payout','authorize_claim_disbursement','decide_claim','add_customer'} & bound.names
