"""Synthetic routing, execution, permissions, resume and streaming checks."""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command, interrupt

import graph
import usage
from permission import get_tools_for_role
from routers.chat import _consume
from specialist_router import coordinator_node, route_coordinator
from test_commission_specialist import initial, call
from servicing_specialist import SERVICING_TOOLS, SERVICING_DOMAINS, servicing_prompt


@pytest.mark.parametrize('text,previous,expected', [
    ('Show premium schedule',None,'servicing'),
    ('Cancel the policy',None,'servicing'),
    ('Show overdue premiums',None,'servicing'),
    ('Check lapsed policy',None,'servicing'),
    ('Show payment receipt',None,'servicing'),
    ('Preview policy surrender',None,'servicing'),
    ('Show free-look terms',None,'servicing'),
    ('Renew the policy',None,'servicing'),
    ('Show reinstatement requirements',None,'servicing'),
    ('Preview policy endorsement',None,'servicing'),
    ('Check policy delivery status',None,'servicing'),
    ('Get portal access',None,'servicing'),
    ('get_premium_schedule',None,'servicing'),
    ('get_exit_status',None,'servicing'),
    ('پالیسی سرنڈر',None,'servicing'),
    ('Which documents are missing?','servicing','servicing'),
    ('Submit it','servicing','servicing'),
    ('PL-2026-001','servicing','servicing'),
    ('Sana Abbasi','servicing','servicing'),
    ('Show claims dashboard','servicing','claims'),
    ('Underwrite Ahmed','servicing','underwriting'),
    ('Show commission summary','servicing','commission'),
    ('What about renewal rates?','commission','commission'),
    ('Show premium schedule','underwriting','servicing'),
    ('Confirm first premium','underwriting','underwriting'),
    ('Renew policy and show claims',None,None),
    ('Surrender policy and calculate commission',None,None),
    ('Renew policy and create proposal',None,None),
    ('Create customer and renew policy',None,None),
    ('Renew group policy',None,'group'),
    ('Family policy surrender',None,None),
    ('List customers','servicing',None),
    ('Hello','servicing',None),
])
def test_routing(text,previous,expected):
    state={**initial(text),'active_specialist':previous}
    update=coordinator_node(state)
    assert update['active_specialist']==expected
    assert route_coordinator(update)=={'servicing':'servicing_agent','underwriting':'underwriting_agent','claims':'claims_agent','commission':'commission_agent','group':'group_agent'}.get(expected,'general_agent')


def test_flag_independent_and_blocks_mixed_content(monkeypatch):
    monkeypatch.setenv('SERVICING_SPECIALIST_ENABLED','false')
    assert coordinator_node(initial('Show premium schedule'))['active_specialist'] is None
    assert coordinator_node({**initial('Show premium schedule'), 'active_specialist':'underwriting'})['active_specialist'] is None
    assert coordinator_node(initial('Show claims dashboard'))['active_specialist']=='claims'
    monkeypatch.setenv('SERVICING_SPECIALIST_ENABLED','true')
    state=initial('');state['messages']=[HumanMessage(content=[{'type':'text','text':'Surrender and commission summary'}])]
    assert coordinator_node(state)['active_specialist'] is None


def test_role_scoped_bindings():
    class Bound:
        def bind_tools(self,tools,**kwargs):self.names={t.name for t in tools};return self
    for role in ['Admin','Underwriter','Agent','Viewer','ClaimsAdjuster']:
        allowed=frozenset(t.name for t in get_tools_for_role(role) if t.name in SERVICING_TOOLS)
        bound=Bound()
        with patch.dict(graph._LLM_CACHE,{},clear=True),patch('graph.providers.build_chat',return_value=bound):
            graph._llm({'version':'servicing-test','primary':{}},role,domains=SERVICING_DOMAINS,tool_scope=allowed)
        assert bound.names==allowed
        assert not {'add_customer','disburse_claim_settlement','approve_payout_run','deploy_rule_version'} & bound.names
        for name in ['submit_policy_exit_request','submit_policy_renewal','send_portal_invitation']:
            if name not in allowed:assert name+':' not in servicing_prompt(allowed,'en')
    assert 'Urdu' in servicing_prompt(SERVICING_TOOLS,'ur')


@pytest.mark.parametrize('prompt,tool,role,blocked',[
    ('Read-only: show premium schedule','get_premium_schedule','Admin',False),
    ('Read-only: show surrender terms','submit_policy_exit_request','Admin',True),
    ('Read-only: show renewal terms','submit_policy_renewal','Admin',True),
    ('Read-only: show policy delivery status','retry_failed_delivery','Admin',True),
    ('Read-only: show portal access','send_portal_invitation','Admin',True),
    ('Read-only: show portal access','provision_portal_access','Admin',True),
    ('Read-only: show premium schedule','send_premium_reminder','Admin',True),
    ('Review policy servicing','disburse_claim_settlement','Admin',True),
    ('Review policy servicing','approve_payout_run','Admin',True),
    ('Review policy servicing','add_customer','Admin',True),
    ('Review policy servicing','issue_policy','Admin',True),
    ('Review policy servicing','submit_policy_exit_request','Viewer',True),
])
def test_executor_scope_and_readonly(prompt,tool,role,blocked):
    async def run():
        llm=AsyncMock();llm.ainvoke.side_effect=[call(tool),AIMessage(content='Current readiness')]
        executor=AsyncMock(return_value={'success':True,'message':'Current readiness'})
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',executor),patch('usage.record') as meter:
            result=await graph.build_graph(MemorySaver()).ainvoke(initial(prompt,role),{'configurable':{'thread_id':'servicing-'+tool+role}})
        assert result['active_specialist']=='servicing'
        assert executor.await_count==(0 if blocked else 1)
        assert all(c.kwargs['service_name']==usage.SERVICE_SERVICING_SPECIALIST for c in meter.call_args_list)
        if not blocked:
            ctx=executor.call_args.args[2]
            assert (ctx.tenant_id,ctx.role,ctx.jwt_token)==('synthetic-tenant',role,'synthetic-token')
    asyncio.run(run())


def test_interrupt_resume_preserves_existing_journey_and_claim():
    async def run():
        performed=[]
        async def execute(name,args,ctx):
            value=interrupt({'kind':'clarify','question':'Which policy?','tool_call':{'name':name,'args':args}})
            performed.append(value);return {'success':True,'message':'Read completed'}
        llm=AsyncMock();llm.ainvoke.side_effect=[call('get_premium_schedule'),AIMessage(content='Done')]
        app=graph.build_graph(MemorySaver());config={'configurable':{'thread_id':'servicing-resume'}}
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',execute),patch('usage.record'):
            result=await app.ainvoke({**initial('Show premium schedule'),'journey_case_id':'application-A','claim_id':'unrelated-claim'},config)
            assert result['__interrupt__'] and not performed
            result=await app.ainvoke(Command(resume='policy-A'),config)
        assert performed==['policy-A']
        assert result['journey_case_id']=='application-A' and result['claim_id']=='unrelated-claim'
        assert result['active_specialist']=='servicing'
    asyncio.run(run())


def test_five_planners_one_checkpoint():
    async def run():
        llm=AsyncMock();llm.ainvoke.side_effect=[AIMessage(content=str(i)) for i in range(5)]
        app=graph.build_graph(MemorySaver());config={'configurable':{'thread_id':'five-planners'}}
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('usage.record') as meter:
            results=[]
            for i,text in enumerate(['Show premium schedule','Show underwriting status','Show claims dashboard','Show commission ledger','List customers']):
                results.append(await app.ainvoke(initial(text) if i==0 else {'messages':[HumanMessage(text)]},config))
        assert [r['active_specialist'] for r in results]==['servicing','underwriting','claims','commission',None]
        assert [c.kwargs['service_name'] for c in meter.call_args_list]==[usage.SERVICE_SERVICING_SPECIALIST,usage.SERVICE_UNDERWRITING_SPECIALIST,usage.SERVICE_CLAIMS_SPECIALIST,usage.SERVICE_COMMISSION_SPECIALIST,usage.SERVICE_CHAT_AGENT]
    asyncio.run(run())


def test_streamed_handoff():
    async def run():
        with patch('graph._llm',return_value=FakeListChatModel(responses=['Servicing answer'])),patch('providers.resolve',AsyncMock(return_value={})),patch('usage.record'):
            events=[e async for e in _consume(graph.build_graph(MemorySaver()),{'configurable':{'thread_id':'servicing-stream'}},initial('Show premium schedule'))]
        assert any('Policy servicing specialist selected' in e for e in events)
        assert any('"delta": true' in e for e in events)
        assert not any('"type": "error"' in e for e in events)
    asyncio.run(run())
