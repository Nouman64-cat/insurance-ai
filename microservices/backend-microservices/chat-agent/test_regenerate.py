"""Edit-and-regenerate: the thread is rewound to just before a user message and the turn runs again from there.

A toy graph on an in-memory checkpointer stands in for the real one — the rewind logic only depends on LangGraph's
checkpoint history, not on what the nodes do.

Run with:  python -m pytest services/chat-agent/test_regenerate.py -q
"""

import asyncio

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

from routers.chat import _checkpoint_before

CALLS = {"n": 0}


def _graph():
    def agent(state):
        CALLS["n"] += 1
        return {"messages": [AIMessage(content=f"reply #{CALLS['n']} to: {state['messages'][-1].content}")]}

    b = StateGraph(MessagesState)
    b.add_node("agent", agent)
    b.add_edge(START, "agent")
    b.add_edge("agent", END)
    return b.compile(checkpointer=MemorySaver())


async def _texts(graph, config):
    return [(type(m).__name__[0], m.content) for m in (await graph.aget_state(config)).values["messages"]]


async def _scenario():
    graph = _graph()
    cfg = {"configurable": {"thread_id": "t"}}
    for q in ("first", "second", "third"):
        await graph.ainvoke({"messages": [HumanMessage(content=q)]}, cfg)
    before = await _texts(graph, cfg)
    assert [t for _, t in before if _ == "H"] == ["first", "second", "third"] and len(before) == 6

    fork = await _checkpoint_before(graph, "t", "second", 0)
    assert fork is not None
    await graph.ainvoke({"messages": [HumanMessage(content="second")]}, fork)       # ask it again from there
    after = await _texts(graph, cfg)
    # "third" and everything the agent said after "second" are gone; the first exchange is untouched.
    assert [t for k, t in after if k == "H"] == ["first", "second"]
    assert len(after) == 4 and after[0] == ("H", "first") and after[2] == ("H", "second")
    assert after[3][1].startswith("reply #4"), "the second answer is freshly generated"

    # The very first message can be re-asked too (the thread is rewound to empty).
    first_fork = await _checkpoint_before(graph, "t", "first", 0)
    await graph.ainvoke({"messages": [HumanMessage(content="first")]}, first_fork)
    assert [t for k, t in await _texts(graph, cfg) if k == "H"] == ["first"]

    # The same text asked twice: the occurrence picks which one.
    graph2 = _graph()
    cfg2 = {"configurable": {"thread_id": "u"}}
    for q in ("same", "other", "same"):
        await graph2.ainvoke({"messages": [HumanMessage(content=q)]}, cfg2)
    fork2 = await _checkpoint_before(graph2, "u", "same", 1)
    await graph2.ainvoke({"messages": [HumanMessage(content="same")]}, fork2)
    assert [t for k, t in await _texts(graph2, cfg2) if k == "H"] == ["same", "other", "same"]
    assert len(await _texts(graph2, cfg2)) == 6

    # Text that was never asked: nothing to rewind to.
    assert await _checkpoint_before(graph, "t", "never asked", 0) is None
    assert await _checkpoint_before(graph2, "u", "same", 5) is None


def test_the_thread_forks_at_the_message_that_is_asked_again():
    asyncio.run(_scenario())


async def _branches():
    """Regenerating twice: the second rewind must stay on the branch just created, not land on the abandoned one."""
    graph = _graph()
    cfg = {"configurable": {"thread_id": "b"}}
    for q in ("one", "two", "three"):
        await graph.ainvoke({"messages": [HumanMessage(content=q)]}, cfg)

    fork = await _checkpoint_before(graph, "b", "two", 0)
    await graph.ainvoke({"messages": [HumanMessage(content="two")]}, fork)           # branch 2: one, two'
    assert [t for k, t in await _texts(graph, cfg) if k == "H"] == ["one", "two"]

    await graph.ainvoke({"messages": [HumanMessage(content="four")]}, cfg)           # carry on from the new branch
    assert [t for k, t in await _texts(graph, cfg) if k == "H"] == ["one", "two", "four"]

    # Re-ask "two" AGAIN. The abandoned branch still holds "three"; none of it may leak back in.
    fork2 = await _checkpoint_before(graph, "b", "two", 0)
    await graph.ainvoke({"messages": [HumanMessage(content="two")]}, fork2)
    after = await _texts(graph, cfg)
    assert [t for k, t in after if k == "H"] == ["one", "two"], after
    assert len(after) == 4 and not any("three" in t for _, t in after)

    # And "four" is gone from what the agent remembers, so asking it afresh starts clean.
    await graph.ainvoke({"messages": [HumanMessage(content="five")]}, cfg)
    assert [t for k, t in await _texts(graph, cfg) if k == "H"] == ["one", "two", "five"]


def test_a_second_regenerate_stays_on_the_current_branch():
    asyncio.run(_branches())
