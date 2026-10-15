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
from group_specialist import GROUP_TOOLS, GROUP_DOMAINS, group_prompt


@pytest.mark.parametrize('text,previous,expected', [
    ('Show group scheme status',None,'group'),
    ('Create group life scheme',None,'group'),
    ('Group family takaful quote',None,'group'),
    ('Show master policy claims',None,'group'),
    ('List group members',None,'group'),
    ('Upload census',None,'group'),
    ('Show PTF report',None,'group'),
    ('Add benefit class',None,'group'),
    ('Renew group policy',None,'group'),
    ('Preview group endorsement',None,'group'),
    ('Show group underwriting status',None,'group'),
    ('continue_group_journey',None,'group'),
    ('get_group_scheme_status',None,'group'),
    ('گروپ انشورنس',None,'group'),
    ('Continue','group','group'),
    ('Pay it','group','group'),
    ('Show the quote','group','group'),
    ('List claims','group','group'),
    ('Add employees','group','group'),
    ('Acme Corporation','group','group'),
    ('Show the renewal','group','group'),
    ('Show claims dashboard','group','claims'),
    ('Show underwriting status','group','underwriting'),
    ('Show premium schedule','group','servicing'),
    ('Show commission summary','group','commission'),
    ('Show individual policy renewal','group','servicing'),
    ('Group policy and individual policy renewal',None,None),
    ('Group claims and commission summary',None,None),
    ('Create customer and group scheme',None,None),
    ('Group scheme and deploy rule set',None,None),
    ('Show group scheme and create proposal',None,None),
    ('Show group scheme and claims dashboard',None,None),
    ('Underwrite this family',None,None),
    ('List customers','group',None),
    ('Hello','group',None),
])
def test_routing(text,previous,expected):
    state={**initial(text),'active_specialist':previous}
    update=coordinator_node(state)
    assert update['active_specialist']==expected
    assert route_coordinator(update)=={'servicing':'servicing_agent','underwriting':'underwriting_agent','claims':'claims_agent','commission':'commission_agent','group':'group_agent'}.get(expected,'general_agent')


def test_flag_independent_and_blocks_mixed_content(monkeypatch):
    monkeypatch.setenv('GROUP_SPECIALIST_ENABLED','false')
    assert coordinator_node(initial('Show group scheme status'))['active_specialist'] is None
    assert coordinator_node({**initial('Show group scheme status'), 'active_specialist':'claims'})['active_specialist'] is None
    assert coordinator_node(initial('Show claims dashboard'))['active_specialist']=='claims'
    monkeypatch.setenv('GROUP_SPECIALIST_ENABLED','true')
    state=initial('');state['messages']=[HumanMessage(content=[{'type':'text','text':'Group scheme and commission summary'}])]
    assert coordinator_node(state)['active_specialist'] is None


def test_role_scoped_bindings():
    class Bound:
        def bind_tools(self,tools,**kwargs):self.names={t.name for t in tools};return self
    for role in ['Admin','Underwriter','Agent','Viewer','ClaimsAdjuster']:
        allowed=frozenset(t.name for t in get_tools_for_role(role) if t.name in GROUP_TOOLS)
        bound=Bound()
        with patch.dict(graph._LLM_CACHE,{},clear=True),patch('graph.providers.build_chat',return_value=bound):
            graph._llm({'version':'group-test','primary':{}},role,domains=GROUP_DOMAINS,tool_scope=allowed)
        assert bound.names==allowed
        assert not {'add_customer','disburse_claim_settlement','approve_payout_run','deploy_rule_version'} & bound.names
        for name in ['pay_group_claim','issue_group_policy','record_group_payment']:
            if name not in allowed:assert name+':' not in group_prompt(allowed,'en')
    assert 'Urdu' in group_prompt(GROUP_TOOLS,'ur')


@pytest.mark.parametrize('prompt,tool,role,blocked',[
    ('Read-only: show group scheme status','get_group_scheme_status','Admin',False),
    ('Read-only: show group scheme status','generate_group_quote','Admin',True),
    ('Read-only: show group scheme status','continue_group_journey','Admin',True),
    ('Read-only: show group scheme status','resume_member_workflow','Admin',True),
    ('Read-only: show group scheme status','record_group_payment','Admin',True),
    ('Read-only: show group scheme status','pay_group_claim','Admin',True),
    ('Read-only: show group scheme status','issue_group_policy','Admin',True),
    ('Review group scheme','disburse_claim_settlement','Admin',True),
    ('Review group scheme','approve_payout_run','Admin',True),
    ('Review group scheme','add_customer','Admin',True),
    ('Review group scheme','issue_policy','Admin',True),
    ('Review group scheme','pay_group_claim','Viewer',True),
])
def test_executor_scope_and_readonly(prompt,tool,role,blocked):
    async def run():
        llm=AsyncMock();llm.ainvoke.side_effect=[call(tool),AIMessage(content='Current readiness')]
        executor=AsyncMock(return_value={'success':True,'message':'Current readiness'})
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',executor),patch('usage.record') as meter:
            result=await graph.build_graph(MemorySaver()).ainvoke(initial(prompt,role),{'configurable':{'thread_id':'group-'+tool+role}})
        assert result['active_specialist']=='group'
        assert executor.await_count==(0 if blocked else 1)
        assert all(c.kwargs['service_name']==usage.SERVICE_GROUP_SPECIALIST for c in meter.call_args_list)
        if not blocked:
            ctx=executor.call_args.args[2]
            assert (ctx.tenant_id,ctx.role,ctx.jwt_token)==('synthetic-tenant',role,'synthetic-token')
    asyncio.run(run())


def test_interrupt_resume_preserves_existing_journey_and_claim():
    async def run():
        performed=[]
        async def execute(name,args,ctx):
            value=interrupt({'kind':'clarify','question':'Which scheme?','tool_call':{'name':name,'args':args}})
            performed.append(value);return {'success':True,'message':'Read completed'}
        llm=AsyncMock();llm.ainvoke.side_effect=[call('get_group_scheme_status'),AIMessage(content='Done')]
        app=graph.build_graph(MemorySaver());config={'configurable':{'thread_id':'group-resume'}}
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',execute),patch('usage.record'):
            result=await app.ainvoke({**initial('Show group scheme status'),'journey_case_id':'application-A','claim_id':'unrelated-claim'},config)
            assert result['__interrupt__'] and not performed
            result=await app.ainvoke(Command(resume='scheme-A'),config)
        assert performed==['scheme-A']
        assert result['journey_case_id']=='application-A' and result['claim_id']=='unrelated-claim'
        assert result['active_specialist']=='group'
    asyncio.run(run())


def test_six_planners_one_checkpoint():
    async def run():
        llm=AsyncMock();llm.ainvoke.side_effect=[AIMessage(content=str(i)) for i in range(6)]
        app=graph.build_graph(MemorySaver());config={'configurable':{'thread_id':'six-planners'}}
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('usage.record') as meter:
            results=[]
            for i,text in enumerate(['Show group scheme status','Show premium schedule','Show underwriting status','Show claims dashboard','Show commission ledger','List customers']):
                results.append(await app.ainvoke(initial(text) if i==0 else {'messages':[HumanMessage(text)]},config))
        assert [r['active_specialist'] for r in results]==['group','servicing','underwriting','claims','commission',None]
        assert [c.kwargs['service_name'] for c in meter.call_args_list]==[usage.SERVICE_GROUP_SPECIALIST,usage.SERVICE_SERVICING_SPECIALIST,usage.SERVICE_UNDERWRITING_SPECIALIST,usage.SERVICE_CLAIMS_SPECIALIST,usage.SERVICE_COMMISSION_SPECIALIST,usage.SERVICE_CHAT_AGENT]
    asyncio.run(run())


def test_streamed_handoff():
    async def run():
        with patch('graph._llm',return_value=FakeListChatModel(responses=['Group answer'])),patch('providers.resolve',AsyncMock(return_value={})),patch('usage.record'):
            events=[e async for e in _consume(graph.build_graph(MemorySaver()),{'configurable':{'thread_id':'group-stream'}},initial('Show group scheme status'))]
        assert any('Group insurance specialist selected' in e for e in events)
        assert any('"delta": true' in e for e in events)
        assert not any('"type": "error"' in e for e in events)
    asyncio.run(run())
