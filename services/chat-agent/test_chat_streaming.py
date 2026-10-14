"""Conversation tokens reach SSE before the model node finishes."""
import asyncio
import json

from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import MessagesState

from routers.chat import _consume


def payload(raw):
    return json.loads(raw.removeprefix('data: '))


def test_native_model_stream_arrives_before_node_completion():
    async def run():
        finished = False
        model = FakeListChatModel(responses=['Hello'], sleep=0.01)
        async def agent(state):
            nonlocal finished
            response = await model.ainvoke(state['messages'])
            finished = True
            return {'messages': [response]}
        builder = StateGraph(MessagesState)
        builder.add_node('agent', agent)
        builder.add_edge(START, 'agent')
        builder.add_edge('agent', END)
        events = []
        async for raw in _consume(builder.compile(), {'configurable': {'thread_id': 'test'}}, {'messages': [HumanMessage('Hi')]}):
            event = payload(raw)
            if event['type'] == 'token' and event.get('delta'):
                assert not finished
            events.append(event)
        deltas = [e for e in events if e['type'] == 'token' and e.get('delta')]
        snapshots = [e for e in events if e['type'] == 'token' and not e.get('delta')]
        assert ''.join(e['content'] for e in deltas) == 'Hello'
        assert len({e['message_id'] for e in deltas + snapshots}) == 1
        assert snapshots[0]['content'] == 'Hello'
        assert events[-1]['type'] == 'done'
    asyncio.run(run())


def test_internal_calls_stay_private_and_failed_partial_is_discarded():
    class Graph:
        async def astream(self, *args, **kwargs):
            assert kwargs['stream_mode'] == ['messages', 'updates']
            yield 'messages', (AIMessageChunk(content='private', id='internal'), {'langgraph_node': 'permission_gate'})
            yield 'messages', (AIMessageChunk(content='unfinished', id='failed'), {'langgraph_node': 'agent'})
            yield 'messages', (AIMessageChunk(content='Answer', id='ok'), {'langgraph_node': 'agent'})
            yield 'updates', {'agent': {'messages': [AIMessage(content='Answer', id='ok')]}}
            yield 'updates', {'permission_gate': {'messages': [ToolMessage(content='{"success":true,"quick_actions":[{"label":"Open Leads"}]}', tool_call_id='call', name='list_leads')]}}
    async def run():
        events = [payload(raw) async for raw in _consume(Graph(), {'configurable': {'thread_id': 'test'}}, {})]
        assert not any(e.get('content') == 'private' for e in events)
        assert {'type': 'message_discard', 'message_id': 'failed'} in events
        assert any(e['type'] == 'quick_actions' for e in events)
    asyncio.run(run())


def test_interrupt_still_pauses_the_stream():
    from types import SimpleNamespace
    class Graph:
        async def astream(self, *args, **kwargs):
            yield 'updates', {'__interrupt__': [SimpleNamespace(value={
                'kind': 'confirm', 'question': 'Proceed?',
                'tool_call': {'name': 'add_customer'},
            })]}
    async def run():
        events = [payload(raw) async for raw in _consume(Graph(), {'configurable': {'thread_id': 'test'}}, {})]
        assert events[-1]['type'] == 'interrupt'
        assert events[-1]['question'] == 'Proceed?'
        assert not any(e['type'] == 'done' for e in events)
    asyncio.run(run())


def test_reasoning_blocks_are_not_streamed_as_response_text():
    from routers.chat import _as_text
    assert _as_text([
        {'type': 'thinking', 'text': 'private'},
        {'type': 'text', 'text': 'also private', 'extras': {'thought': True}},
        {'type': 'text', 'text': 'Visible answer'},
    ]) == 'Visible answer'
