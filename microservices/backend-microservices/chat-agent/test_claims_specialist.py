"""Claims routing, namespace, backend gates, resume and stream regressions.

Synthetic planner/API replies only; no live claims or payouts are changed.
"""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command, interrupt

import graph
import usage
from claims_specialist import CLAIMS_TOOLS, CLAIMS_DOMAINS, claims_prompt
from commission_specialist import COMMISSION_TOOLS
from permission import get_tools_for_role
from routers.chat import _consume
from specialist_router import coordinator_node, route_coordinator
from test_commission_specialist import call, initial


@pytest.mark.parametrize('text,previous,expected', [
    ('List claims',None,'claims'),
    ('Show the claims dashboard',None,'claims'),
    ('Register an FNOL for policy PL-1',None,'claims'),
    ('Verify eligibility for claim CLM-2026-001',None,'claims'),
    ('Refer claim CLM-1 to underwriting',None,'claims'),
    ('Authorize claim disbursement',None,'claims'),
    ('کلیم کی صورتحال بتائیں',None,'claims'),
    ('get_claim_workflow',None,'claims'),
    ('Which documents are missing?','claims','claims'),
    ('Show the payees','claims','claims'),
    ('Natural','claims','claims'),
    ('Sana Abbasi','claims','claims'),
    ('Pay it','claims','claims'),
    ('Pay it','commission','commission'),
    ('Show the payout','claims','claims'),
    ('Show the payout','commission','commission'),
    ('Show the payout',None,None),
    ('Show commission disbursements','claims','commission'),
    ('Show claim payouts','commission','claims'),
    ('Show claims and commissions',None,None),
    ('Create a customer and register a claim',None,None),
    ('Issue a policy and register a claim',None,None),
    ('List group claims',None,'group'),
    ('Show group claim CLM-1',None,'group'),
    ('Show master policy claims',None,'group'),
    ('List customers','claims',None),
    ('Run underwriting','claims','underwriting'),
    ('Hello','claims',None),
])
def test_coordinator_resolves_claims_vs_commission_context(text, previous, expected, monkeypatch):
    monkeypatch.setenv('CLAIMS_SPECIALIST_ENABLED','true')
    monkeypatch.setenv('COMMISSION_SPECIALIST_ENABLED','true')
    update=coordinator_node({'messages':[HumanMessage(text)],'active_specialist':previous})
    assert update['active_specialist']==expected
    assert route_coordinator(update)=={'claims':'claims_agent','commission':'commission_agent','underwriting':'underwriting_agent','group':'group_agent'}.get(expected,'general_agent')


def test_claims_rollout_flag_is_independent_and_mixed_image_text_stays_general(monkeypatch):
    monkeypatch.setenv('CLAIMS_SPECIALIST_ENABLED','false')
    monkeypatch.setenv('COMMISSION_SPECIALIST_ENABLED','true')
    assert coordinator_node(initial('Show claims dashboard'))['active_specialist'] is None
    assert coordinator_node(initial('Show commission ledger'))['active_specialist']=='commission'
    monkeypatch.setenv('CLAIMS_SPECIALIST_ENABLED','true')
    state={'messages':[HumanMessage(content=[{'type':'text','text':'Compare claims and commissions'}])],'active_specialist':'claims'}
    assert coordinator_node(state)['active_specialist'] is None


def test_claims_loop_uses_original_executor_identity_and_metering():
    async def run():
        llm=AsyncMock();llm.ainvoke.side_effect=[call('get_claims_dashboard'),AIMessage(content='Four open claims')]
        executor=AsyncMock(return_value={'success':True,'message':'Four open claims'})
        with patch('graph._llm',return_value=llm) as binding,patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',executor),patch('usage.record') as meter:
            result=await graph.build_graph(MemorySaver()).ainvoke(initial('Read-only: show claims dashboard','ClaimsAdjuster'),{'configurable':{'thread_id':'claim-read'}})
        assert result['active_specialist']=='claims'
        assert result['messages'][-1].content=='Four open claims'
        assert executor.await_count==1
        context=executor.call_args.args[2]
        assert (context.tenant_id,context.role,context.jwt_token)==('synthetic-tenant','ClaimsAdjuster','synthetic-token')
        assert binding.call_args.kwargs['tool_scope'] <= CLAIMS_TOOLS
        assert all(c.kwargs['service_name']==usage.SERVICE_CLAIMS_SPECIALIST and c.kwargs['thread_id']=='claim-read' for c in meter.call_args_list)
    asyncio.run(run())


@pytest.mark.parametrize('role,tool',[('ClaimsAdjuster','authorize_claim_disbursement'),('ClaimsAdjuster','disburse_claim_settlement'),('Admin','create_commission_agreement'),('Admin','issue_policy')])
def test_forbidden_manager_or_other_domain_tool_is_never_executed(role,tool):
    async def run():
        llm=AsyncMock();llm.ainvoke.return_value=call(tool)
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',AsyncMock()) as executor,patch('usage.record'):
            result=await graph.build_graph(MemorySaver()).ainvoke(initial('Review this claim',role),{'configurable':{'thread_id':role+tool}})
            executor.assert_not_awaited()
            assert 'claims workflow' in result['messages'][-1].content
    asyncio.run(run())


@pytest.mark.parametrize('prompt,tool',[('Read-only: show claim status','disburse_claim_settlement'),('Show commission setup; do not modify records','create_commission_agreement')])
def test_explicit_read_only_request_cannot_write_even_for_admin(prompt,tool):
    async def run():
        llm=AsyncMock();llm.ainvoke.return_value=call(tool)
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',AsyncMock()) as executor,patch('usage.record'):
            result=await graph.build_graph(MemorySaver()).ainvoke(initial(prompt),{'configurable':{'thread_id':tool}})
            executor.assert_not_awaited()
            assert 'read-only' in result['messages'][-1].content
    asyncio.run(run())


def test_claims_clarification_resume_retains_claim_and_other_journey_namespaces():
    async def run():
        performed=[]
        async def executor(name,args,ctx):
            answer=interrupt({'kind':'clarify','question':'Which claim?','tool_call':{'name':name,'args':args}})
            performed.append((answer,ctx.role));return {'success':True,'message':'Read completed'}
        llm=AsyncMock();llm.ainvoke.side_effect=[call('get_claims_dashboard'),AIMessage(content='Done')]
        app=graph.build_graph(MemorySaver());config={'configurable':{'thread_id':'claims-resume'}}
        state={**initial('Review the claims dashboard','ClaimsAdjuster'),'claim_id':'claim-A','journey_case_id':'unrelated-underwriting-case'}
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',executor),patch('usage.record'):
            paused=await app.ainvoke(state,config);assert paused['__interrupt__'] and not performed
            result=await app.ainvoke(Command(resume='claim-A'),config)
        assert performed==[('claim-A','ClaimsAdjuster')]
        assert result['active_specialist']=='claims' and result['claim_id']=='claim-A'
        assert result['journey_case_id']=='unrelated-underwriting-case'
    asyncio.run(run())


def test_three_planners_handoff_in_same_checkpoint():
    async def run():
        llm=AsyncMock();llm.ainvoke.side_effect=[AIMessage(content='Commission'),AIMessage(content='Claims'),AIMessage(content='Main')]
        app=graph.build_graph(MemorySaver());config={'configurable':{'thread_id':'three-planners'}}
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('usage.record') as meter:
            one=await app.ainvoke(initial('Show commission ledger'),config)
            two=await app.ainvoke({'messages':[HumanMessage('Show claims dashboard')]},config)
            three=await app.ainvoke({'messages':[HumanMessage('List customers')]},config)
        assert [one['active_specialist'],two['active_specialist'],three['active_specialist']]==['commission','claims',None]
        assert [c.kwargs['service_name'] for c in meter.call_args_list]==[usage.SERVICE_COMMISSION_SPECIALIST,usage.SERVICE_CLAIMS_SPECIALIST,usage.SERVICE_CHAT_AGENT]
        assert three['tenant_id']=='synthetic-tenant' and three['user_role']=='Admin'
    asyncio.run(run())


def test_claims_scope_binds_exact_role_filtered_tools_and_omits_hidden_instructions():
    class Bound:
        def bind_tools(self,tools,**kwargs):self.names={t.name for t in tools};return self
    for role in ['Admin','ClaimsManager','ClaimsAdjuster','Underwriter','Agent','Viewer']:
        allowed=frozenset(t.name for t in get_tools_for_role(role) if t.name in CLAIMS_TOOLS)
        bound=Bound()
        with patch.dict(graph._LLM_CACHE,{},clear=True),patch('graph.providers.build_chat',return_value=bound):
            graph._llm({'version':'claims-pilot','primary':{}},role,domains=CLAIMS_DOMAINS,tool_scope=allowed)
        # 37: the Claims Manager also works policy exit settlements and reads delegated authority.
        assert bound.names==allowed and len(allowed)<=37
        assert not {'create_commission_agreement','create_payout_run','issue_policy','add_customer'} & bound.names
        if role=='ClaimsAdjuster':
            assert 'authorize_claim_disbursement' not in allowed
            assert 'authorize_claim_disbursement' not in claims_prompt(allowed,'en')
    assert 'Urdu' in claims_prompt(CLAIMS_TOOLS,'ur')


def test_claims_tokens_stream_and_handoff_event_is_visible():
    async def run():
        model=FakeListChatModel(responses=['Claims answer'],sleep=0.001)
        with patch('graph._llm',return_value=model),patch('providers.resolve',AsyncMock(return_value={})),patch('usage.record'):
            events=[e async for e in _consume(graph.build_graph(MemorySaver()),{'configurable':{'thread_id':'claims-stream'}},initial('Show claims dashboard'))]
        assert any('Claims specialist selected' in e for e in events)
        assert any('"delta": true' in e for e in events)
        assert any('Claims answer' in e for e in events)
        assert not any('"type": "error"' in e for e in events)
    asyncio.run(run())
