"""Pilot boundaries, real graph handoffs, shared permissions and resumability.

No provider calls or business writes. Planner and API replies are controlled.
"""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command, interrupt

import graph
import usage
from commission_specialist import COMMISSION_TOOLS, coordinator_node, select_specialist, specialist_prompt
from permission import get_tools_for_role
from routers.chat import _consume


@pytest.mark.parametrize('text,previous,expected', [
    ('Show commission earnings', None, 'commission'),
    ('Show my earnings', None, 'commission'),
    ('Show the agent statement', None, 'commission'),
    ('list_commission_agreements', None, 'commission'),
    ('Check commission setup for QA customer', None, 'commission'),
    ('Approve commission agreement for policy PL-1', None, 'commission'),
    ('میرا کمیشن کتنا ہے', None, 'commission'),
    ('Create a customer and calculate their commission', None, None),
    ('Add an agent and create a commission agreement', None, None),
    ('Register a claim and check the commission', None, None),
    ('Issue the policy and calculate commission', None, None),
    ('Settle the claim', 'commission', None),
    ('List customers', 'commission', None),
    ('Show underwriting case APP-1', 'commission', None),
    ('What is the claim payout?', None, None),
    ('Hello', None, None),
    ('Football', 'commission', None),
    ('12.5%', 'commission', 'commission'),
    ('Use producer AG-001', 'commission', 'commission'),
    ('Sana Abbasi', 'commission', 'commission'),
    ('Approve this', 'commission', 'commission'),
    ('AGENCY-STD v2', 'commission', 'commission'),
    ('What about renewal rates?', 'commission', 'commission'),
])
def test_handoff_routes_current_request_not_stale_domain_history(text, previous, expected, monkeypatch):
    monkeypatch.setenv('COMMISSION_SPECIALIST_ENABLED', 'true')
    assert select_specialist({'messages': [HumanMessage(text)], 'active_specialist': previous}) == expected


def test_rollout_switch_and_tool_followup(monkeypatch):
    state = {'messages': [ToolMessage(content='{}', name='get_commission_summary', tool_call_id='x')], 'active_specialist': 'commission'}
    monkeypatch.setenv('COMMISSION_SPECIALIST_ENABLED', 'true')
    assert select_specialist(state) == 'commission'
    monkeypatch.setenv('COMMISSION_SPECIALIST_ENABLED', 'false')
    assert select_specialist(state) is None
    with patch('providers.resolve', AsyncMock()) as provider:
        assert coordinator_node(state)['active_specialist'] is None
        provider.assert_not_called()


def call(name, id='one', **args):
    return AIMessage(content='', tool_calls=[{'name': name, 'args': args, 'id': id, 'type': 'tool_call'}])


def initial(text, role='Admin'):
    return {'messages': [HumanMessage(text)], 'tenant_id': 'synthetic-tenant', 'user_role': role,
            'jwt_token': 'synthetic-token', 'platform': 'web', 'locale': 'en'}


def test_specialist_uses_shared_executor_and_returns_to_main_on_topic_change():
    async def run():
        llm = AsyncMock()
        llm.ainvoke.side_effect = [call('get_commission_summary'), AIMessage(content='Gross PKR 100'), AIMessage(content='Main assistant reply')]
        executor = AsyncMock(return_value={'success': True, 'accrued_gross': '100.00'})
        app = graph.build_graph(MemorySaver()); config = {'configurable': {'thread_id': 'specialist'}}
        with patch('graph._llm', return_value=llm) as binding, patch('providers.resolve', AsyncMock(return_value={})), patch('graph.execute_tool', executor), patch('usage.record') as meter:
            result = await app.ainvoke(initial('Show commission earnings'), config)
            assert result['active_specialist'] == 'commission'
            assert result['messages'][-1].content == 'Gross PKR 100'
            assert executor.await_count == 1
            context = executor.call_args.args[2]
            assert (context.tenant_id, context.jwt_token, context.role) == ('synthetic-tenant','synthetic-token','Admin')
            assert binding.call_args.kwargs['tool_scope'] <= COMMISSION_TOOLS
            assert all(c.kwargs['service_name'] == usage.SERVICE_COMMISSION_SPECIALIST for c in meter.call_args_list)
            assert all(c.kwargs['thread_id'] == 'specialist' for c in meter.call_args_list)
            switched = await app.ainvoke({'messages': [HumanMessage('List customers')]}, config)
            assert switched['active_specialist'] is None
            assert 'tool_scope' not in binding.call_args.kwargs  # broad planner with bounded authorized skill tools
            assert len(binding.call_args.kwargs['capability_names']) <= 24
            assert switched['messages'][-1].content == 'Main assistant reply'
    asyncio.run(run())


@pytest.mark.parametrize('tool,role', [('create_case','Admin'), ('approve_commission_agreement','Agent')])
def test_hallucinated_out_of_scope_or_privileged_tool_never_executes(tool, role):
    async def run():
        llm = AsyncMock(); llm.ainvoke.return_value = call(tool)
        with patch('graph._llm', return_value=llm), patch('providers.resolve', AsyncMock(return_value={})), patch('graph.execute_tool', AsyncMock()) as execute, patch('usage.record'):
            result = await graph.build_graph(MemorySaver()).ainvoke(initial('Show commission earnings',role), {'configurable': {'thread_id': tool}})
            execute.assert_not_awaited()
            assert not result['messages'][-1].tool_calls
            assert 'cannot perform' in result['messages'][-1].content
    asyncio.run(run())


def test_specialist_clarification_resume_keeps_identity_and_executes_once():
    async def run():
        executed = []
        async def executor(name, args, ctx):
            answer = interrupt({'kind':'clarify','question':'Which receipt?','tool_call':{'name':name,'args':args}})
            executed.append((answer,ctx.tenant_id,ctx.role))
            return {'success':True, 'message':'Receipt checked'}
        llm = AsyncMock(); llm.ainvoke.side_effect = [call('list_commission_exceptions'), AIMessage(content='Done')]
        app = graph.build_graph(MemorySaver()); config={'configurable':{'thread_id':'resume'}}
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',executor),patch('usage.record'):
            paused=await app.ainvoke(initial('Show commission exceptions'),config)
            assert paused['__interrupt__'] and not executed
            resumed=await app.ainvoke(Command(resume='synthetic-receipt'),config)
            assert resumed['active_specialist']=='commission'
            assert executed == [('synthetic-receipt','synthetic-tenant','Admin')]
            assert resumed['messages'][-1].content=='Done'
    asyncio.run(run())


def test_specialist_binds_thirty_tools_at_most_with_no_underwriting_mutations():
    class Bound:
        def bind_tools(self, tools, **kwargs):
            self.names = {t.name for t in tools}; return self
    for role in ['Admin','Agent','Viewer']:
        bound=Bound()
        allowed=frozenset(t.name for t in get_tools_for_role(role) if t.name in COMMISSION_TOOLS)
        with patch.dict(graph._LLM_CACHE,{},clear=True),patch('graph.providers.build_chat',return_value=bound):
            graph._llm({'version':'pilot','primary':{}},role,domains=frozenset({'commission','commission_admin'}),tool_scope=allowed)
        assert bound.names == allowed and len(bound.names) <= 30
        assert not {'create_case','issue_policy','add_customer','approve_case'} & bound.names
        if role != 'Admin':
            assert 'approve_commission_agreement' not in bound.names
    assert 'Urdu' in specialist_prompt('Agent','mobile','ur')
    assert 'get_customer_commission_setup' not in specialist_prompt('Agent','web','en')


def test_specialist_streams_and_emits_handoff_without_internal_text():
    async def run():
        model=FakeListChatModel(responses=['Commission answer'],sleep=0.001)
        with patch('graph._llm',return_value=model),patch('providers.resolve',AsyncMock(return_value={})),patch('usage.record'):
            events=[e async for e in _consume(graph.build_graph(MemorySaver()),{'configurable':{'thread_id':'sse'}},initial('Show commission earnings'))]
        assert any('Commission specialist selected' in e for e in events)
        assert any('"delta": true' in e for e in events)
        assert any('Commission answer' in e for e in events)
        assert not any('"type": "error"' in e for e in events)
    asyncio.run(run())


def test_provider_failure_does_not_fallback_to_broader_executor():
    async def run():
        llm=AsyncMock();llm.ainvoke.side_effect=RuntimeError('invalid_request_error')
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',AsyncMock()) as executor:
            with pytest.raises(RuntimeError,match='rejected'):
                await graph.build_graph(MemorySaver()).ainvoke(initial('Show commission earnings'),{'configurable':{'thread_id':'failure'}})
            executor.assert_not_awaited()
    asyncio.run(run())


def test_specialist_selection_is_isolated_between_threads():
    async def run():
        llm=AsyncMock();llm.ainvoke.side_effect=[AIMessage(content='Commission'),AIMessage(content='General')]
        app=graph.build_graph(MemorySaver())
        a={'configurable':{'thread_id':'a'}};b={'configurable':{'thread_id':'b'}}
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('usage.record'):
            await app.ainvoke(initial('Show commission earnings'),a)
            await app.ainvoke(initial('Hello'),b)
        assert (await app.aget_state(a)).values['active_specialist']=='commission'
        assert (await app.aget_state(b)).values['active_specialist'] is None
    asyncio.run(run())
