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
from underwriting_specialist import UNDERWRITING_TOOLS, UNDERWRITING_DOMAINS, underwriting_prompt


@pytest.mark.parametrize('text,previous,expected', [
    ('Underwrite Ahmed',None,'underwriting'),
    ('Create a proposal for Ahmed',None,'underwriting'),
    ('Show pre-underwriting status',None,'underwriting'),
    ('Review medical evidence',None,'underwriting'),
    ('Issue the policy',None,'underwriting'),
    ('continue_underwriting_journey',None,'underwriting'),
    ('انڈررائٹنگ کی صورتحال',None,'underwriting'),
    ('Continue','underwriting','underwriting'),
    ('Which documents are missing?','underwriting','underwriting'),
    ('Salary Protection Plan','underwriting','underwriting'),
    ('Sana Abbasi','underwriting','underwriting'),
    ('Approve it','underwriting','underwriting'),
    ('Show claims dashboard','underwriting','claims'),
    ('Refer claim CLM-1 to underwriting',None,'claims'),
    ('Show commission summary','underwriting','commission'),
    ('Underwrite Ahmed and calculate commission',None,None),
    ('Underwrite Ahmed and show my earnings',None,None),
    ('Underwrite Ahmed and show claims',None,None),
    ('Create customer and proposal',None,None),
    ('Underwrite this family',None,None),
    ('Group underwriting status',None,'group'),
    ('Deploy underwriting rule set',None,None),
    ('Surrender the policy','underwriting','servicing'),
    ('List customers','underwriting',None),
    ('Hello','underwriting',None),
])
def test_routing(text,previous,expected):
    state={**initial(text),'active_specialist':previous}
    update=coordinator_node(state)
    assert update['active_specialist']==expected
    assert route_coordinator(update)=={'underwriting':'underwriting_agent','claims':'claims_agent','commission':'commission_agent','servicing':'servicing_agent','group':'group_agent'}.get(expected,'general_agent')


def test_flag_independent_and_blocks_mixed_content(monkeypatch):
    monkeypatch.setenv('UNDERWRITING_SPECIALIST_ENABLED','false')
    assert coordinator_node(initial('Underwrite Ahmed'))['active_specialist'] is None
    assert coordinator_node(initial('Show claims dashboard'))['active_specialist']=='claims'
    monkeypatch.setenv('UNDERWRITING_SPECIALIST_ENABLED','true')
    state=initial('');state['messages']=[HumanMessage(content=[{'type':'text','text':'Underwriting and commission summary'}])]
    assert coordinator_node(state)['active_specialist'] is None


def test_role_scoped_bindings():
    class Bound:
        def bind_tools(self,tools,**kwargs):self.names={t.name for t in tools};return self
    for role in ['Admin','Underwriter','Agent','Viewer','ClaimsAdjuster']:
        allowed=frozenset(t.name for t in get_tools_for_role(role) if t.name in UNDERWRITING_TOOLS)
        bound=Bound()
        with patch.dict(graph._LLM_CACHE,{},clear=True),patch('graph.providers.build_chat',return_value=bound):
            graph._llm({'version':'uw-test','primary':{}},role,domains=UNDERWRITING_DOMAINS,tool_scope=allowed)
        assert bound.names==allowed
        assert not {'add_customer','disburse_claim_settlement','approve_payout_run','deploy_rule_version'} & bound.names
        for name in ['approve_case','issue_policy','confirm_policy_payment']:
            if name not in allowed:assert name+':' not in underwriting_prompt(allowed,'en')
    assert 'Urdu' in underwriting_prompt(UNDERWRITING_TOOLS,'ur')


@pytest.mark.parametrize('prompt,tool,role,blocked',[
    ('Read-only: show underwriting status','get_pre_underwriting_status','Admin',False),
    ('Read-only: show underwriting status','approve_case','Admin',True),
    ('Read-only: show underwriting status','continue_underwriting_journey','Admin',True),
    ('Review underwriting status','disburse_claim_settlement','Admin',True),
    ('Review underwriting status','approve_payout_run','Admin',True),
    ('Review underwriting status','add_customer','Admin',True),
    ('Review underwriting status','issue_policy','Viewer',True),
])
def test_executor_scope_and_readonly(prompt,tool,role,blocked):
    async def run():
        llm=AsyncMock();llm.ainvoke.side_effect=[call(tool),AIMessage(content='Current readiness')]
        executor=AsyncMock(return_value={'success':True,'message':'Current readiness'})
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',executor),patch('usage.record') as meter:
            result=await graph.build_graph(MemorySaver()).ainvoke(initial(prompt,role),{'configurable':{'thread_id':'uw-'+tool+role}})
        assert result['active_specialist']=='underwriting'
        assert executor.await_count==(0 if blocked else 1)
        assert all(c.kwargs['service_name']==usage.SERVICE_UNDERWRITING_SPECIALIST for c in meter.call_args_list)
        if not blocked:
            ctx=executor.call_args.args[2]
            assert (ctx.tenant_id,ctx.role,ctx.jwt_token)==('synthetic-tenant',role,'synthetic-token')
    asyncio.run(run())


def test_interrupt_resume_preserves_existing_journey_and_claim():
    async def run():
        performed=[]
        async def execute(name,args,ctx):
            value=interrupt({'kind':'clarify','question':'Which application?','tool_call':{'name':name,'args':args}})
            performed.append(value);return {'success':True,'message':'Read completed'}
        llm=AsyncMock();llm.ainvoke.side_effect=[call('get_pre_underwriting_status'),AIMessage(content='Done')]
        app=graph.build_graph(MemorySaver());config={'configurable':{'thread_id':'uw-resume'}}
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',execute),patch('usage.record'):
            result=await app.ainvoke({**initial('Show underwriting status'),'journey_case_id':'application-A','claim_id':'unrelated-claim'},config)
            assert result['__interrupt__'] and not performed
            result=await app.ainvoke(Command(resume='application-A'),config)
        assert performed==['application-A']
        assert result['journey_case_id']=='application-A' and result['claim_id']=='unrelated-claim'
        assert result['active_specialist']=='underwriting'
    asyncio.run(run())


def test_four_planners_one_checkpoint():
    async def run():
        llm=AsyncMock();llm.ainvoke.side_effect=[AIMessage(content=str(i)) for i in range(4)]
        app=graph.build_graph(MemorySaver());config={'configurable':{'thread_id':'four-planners'}}
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('usage.record') as meter:
            results=[]
            for i,text in enumerate(['Show underwriting status','Show claims dashboard','Show commission ledger','List customers']):
                results.append(await app.ainvoke(initial(text) if i==0 else {'messages':[HumanMessage(text)]},config))
        assert [r['active_specialist'] for r in results]==['underwriting','claims','commission',None]
        assert [c.kwargs['service_name'] for c in meter.call_args_list]==[usage.SERVICE_UNDERWRITING_SPECIALIST,usage.SERVICE_CLAIMS_SPECIALIST,usage.SERVICE_COMMISSION_SPECIALIST,usage.SERVICE_CHAT_AGENT]
    asyncio.run(run())


def test_streamed_handoff():
    async def run():
        with patch('graph._llm',return_value=FakeListChatModel(responses=['Underwriting answer'])),patch('providers.resolve',AsyncMock(return_value={})),patch('usage.record'):
            events=[e async for e in _consume(graph.build_graph(MemorySaver()),{'configurable':{'thread_id':'uw-stream'}},initial('Show underwriting status'))]
        assert any('Underwriting specialist selected' in e for e in events)
        assert any('"delta": true' in e for e in events)
        assert not any('"type": "error"' in e for e in events)
    asyncio.run(run())
