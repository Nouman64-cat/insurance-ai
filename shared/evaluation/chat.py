"""Driving a conversation with the real chat agent and turning what happened into an observation the assertion engine can judge.

Pure parts (SSE parsing, the observation builder) have no I/O and are unit-tested; `run_conversation` is the only part that talks to
the chat agent (any async client with .stream(method, url, headers=, json=) and .get / .post).

How a conversation is driven
  * One thread per execution (a new thread id each repetition), so no conversation state survives into the next.
  * The scripted user messages are delivered in order. When the agent stops on a question (a `clarify` interrupt: "which kind of
    customer?"), the next scripted message is the ANSWER and is sent to /chat/resume, exactly as the portal sends a clicked choice.
    A `confirm` interrupt (not produced by today's agent) is approved when the case says `confirmations: auto_approve`.
  * Turns are numbered by scripted message: turn N is what the agent did in answer to message N, whether that arrived as a new
    message or as the answer to a question. This is what `trace.turn.N.*` in a case means.
  * A conversation ends when the messages are used up. If the agent is still waiting on a question then, the question is the
    final interrupt (`trace.interrupt.kind`).

Tool vocabulary (README of the dataset): `proposed` = every tool the model asked for; `executed` = a call that reached the tool
after the permission gate. A call the gate refused (error_code "forbidden") is proposed but not executed.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable, Dict, List, Optional

GATE_REFUSED = {"forbidden"}


# ── server-sent events ──────────────────────────────────────────────────────────────────────────────────────────────────

def parse_sse_line(line: str) -> Optional[Dict[str, Any]]:
    """The JSON of one `data: {...}` line, or None for anything else (comments, blank lines, a line that is not JSON)."""
    if not line.startswith("data:"):
        return None
    try:
        value = json.loads(line[5:].strip())
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


@dataclass
class TurnResult:
    index: int
    message: str
    delivered_as: str                      # message | answer | approval
    text: str = ""                         # what the agent said (its complete messages, in order)
    events: List[Dict[str, Any]] = field(default_factory=list)
    interrupt: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    done: bool = False
    latency_ms: Optional[int] = None
    ttft_ms: Optional[int] = None
    trace_messages: int = 0                # how many messages the thread held at the end of this turn


@dataclass
class Conversation:
    thread_id: str
    turns: List[TurnResult] = field(default_factory=list)
    trace: Dict[str, Any] = field(default_factory=dict)
    final_interrupt: Optional[Dict[str, Any]] = None


def summarise_events(events: List[Dict[str, Any]]) -> Dict[str, Any]:
    """From the SSE events of one turn: the agent's complete messages (the non-delta `token` events), the last interrupt and error."""
    texts: List[str] = []
    interrupt = error = None
    for e in events:
        if e.get("type") == "token" and e.get("delta") is False and (e.get("content") or "").strip():
            texts.append(e["content"])
        elif e.get("type") == "interrupt":
            interrupt = {k: v for k, v in e.items() if k != "type"}
        elif e.get("type") == "error":
            error = e.get("message") or "error"
    return {"text": "\n".join(texts), "interrupt": interrupt, "error": error, "done": any(e.get("type") == "done" for e in events)}


# ── the conversation ────────────────────────────────────────────────────────────────────────────────────────────────────

async def _consume(client, method: str, url: str, headers: Dict[str, str], body: Dict[str, Any], timeout: float) -> tuple[List[Dict[str, Any]], Optional[int], Optional[int], Optional[int]]:
    """POST and read the stream to its end. Returns (events, status, first_token_ms, total_ms)."""
    started = time.monotonic()
    first: Optional[int] = None
    events: List[Dict[str, Any]] = []
    async with client.stream(method, url, headers=headers, json=body, timeout=timeout) as response:
        if response.status_code != 200:
            text = (await response.aread()).decode("utf-8", "replace")[:300]
            return [{"type": "error", "message": f"HTTP {response.status_code}: {text}"}], response.status_code, None, int((time.monotonic() - started) * 1000)
        async for line in response.aiter_lines():
            event = parse_sse_line(line)
            if event is None:
                continue
            if first is None and event.get("type") == "token":
                first = int((time.monotonic() - started) * 1000)
            events.append(event)
    return events, 200, first, int((time.monotonic() - started) * 1000)


async def run_conversation(client, *, chat_url: str, headers: Dict[str, str], thread_id: str, messages: List[str], confirmations: str = "auto_approve",
                           on_turn: Optional[Callable[[int], Any]] = None, platform: str = "web", locale: str = "en", timeout: float = 120.0,
                           locale_for_turn: Optional[str] = None) -> Conversation:
    """Deliver `messages` in order and return what happened. `on_turn(i)` is awaited before turn i is delivered (the runner uses it to
    tell the scripted model which turn it is on, and to snapshot the database)."""
    convo = Conversation(thread_id=thread_id)
    paused: Optional[Dict[str, Any]] = None
    for i, text in enumerate(messages, start=1):
        if on_turn:
            result = on_turn(i)
            if hasattr(result, "__await__"):
                await result
        if paused is not None and paused.get("kind") in ("confirm",) and confirmations == "auto_approve":
            # approve the proposed action first; the scripted message then continues as a normal message
            approved, _, _, _ = await _consume(client, "POST", f"{chat_url}/chat/resume", headers, {"thread_id": thread_id, "resume_value": True}, timeout)
            paused = summarise_events(approved)["interrupt"]
        if paused is not None:
            events, status, first, total = await _consume(client, "POST", f"{chat_url}/chat/resume", headers, {"thread_id": thread_id, "resume_value": text}, timeout)
            how = "answer"
        else:
            body = {"thread_id": thread_id, "message": text, "platform": platform, "locale": locale_for_turn or locale}
            events, status, first, total = await _consume(client, "POST", f"{chat_url}/chat/stream", headers, body, timeout)
            how = "message"
        summary = summarise_events(events)
        turn = TurnResult(index=i, message=text, delivered_as=how, text=summary["text"], events=events, interrupt=summary["interrupt"], error=summary["error"],
                          done=summary["done"], latency_ms=total, ttft_ms=first)
        trace = await fetch_trace(client, chat_url, headers, thread_id)
        turn.trace_messages = len(trace.get("messages", [])) if trace else 0
        convo.turns.append(turn)
        convo.trace = trace or convo.trace
        paused = turn.interrupt
        if turn.error and status != 200:
            break
    convo.final_interrupt = paused
    return convo


async def fetch_trace(client, chat_url: str, headers: Dict[str, str], thread_id: str) -> Dict[str, Any]:
    response = await client.get(f"{chat_url}/chat/eval/trace/{thread_id}", headers=headers)
    if response.status_code != 200:
        return {}
    return response.json()


# ── from the trace to an observation ────────────────────────────────────────────────────────────────────────────────────

def _executed(result: Any) -> bool:
    return not (isinstance(result, dict) and result.get("error_code") in GATE_REFUSED) and not (isinstance(result, dict) and result.get("cancelled"))


def slice_tools(messages: List[Dict[str, Any]]) -> Dict[str, Any]:
    """From a run of thread messages: the tools proposed (every call the model made), the tools executed (reached the tool after the
    gate), and the last successful call's arguments per tool."""
    proposed: List[str] = []
    executed: List[str] = []
    calls: Dict[str, Dict[str, Any]] = {}
    args_by_id: Dict[str, Dict[str, Any]] = {}
    for m in messages:
        if m.get("type") == "ai":
            for tc in m.get("tool_calls") or []:
                proposed.append(tc["name"])
                args_by_id[tc.get("id")] = tc.get("args") or {}
        elif m.get("type") == "tool":
            result = m.get("result")
            if _executed(result):
                executed.append(m.get("name"))
                if not (isinstance(result, dict) and result.get("success") is False):
                    calls[m.get("name")] = {"arguments": args_by_id.get(m.get("tool_call_id"), {})}
    return {"proposed_tools": proposed, "executed_tools": executed, "tool_calls": calls}


def build_observation(convo: Conversation, *, llm_calls: Optional[int] = None, state: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The observation of one conversation: response.text, trace.*, routing.* (and state.* when given)."""
    messages = convo.trace.get("messages", []) if convo.trace else []
    turns: List[Dict[str, Any]] = []
    start = 0
    for t in convo.turns:
        end = t.trace_messages or len(messages)
        piece = slice_tools(messages[start:end])
        turns.append({"executed_tools": piece["executed_tools"], "proposed_tools": piece["proposed_tools"], "response": {"text": t.text},
                      "latency_ms": t.latency_ms, "ttft_ms": t.ttft_ms, "delivered_as": t.delivered_as, "error": t.error})
        start = max(start, end)
    whole = slice_tools(messages)
    interrupt = convo.final_interrupt or {}
    trace: Dict[str, Any] = {"executed_tools": whole["executed_tools"], "proposed_tools": whole["proposed_tools"], "tool_calls": whole["tool_calls"],
                             "turn": turns, "interrupt": {"kind": interrupt.get("kind")} if convo.turns else {"kind": None},
                             "thread_id": convo.thread_id}
    if llm_calls is not None:
        trace["llm_calls"] = llm_calls
    observation: Dict[str, Any] = {
        "response": {"text": convo.turns[-1].text if convo.turns else ""},
        "trace": trace,
        "routing": {"specialist": (convo.trace or {}).get("active_specialist"), "skills": list((convo.trace or {}).get("selected_skills") or [])},
    }
    if state is not None:
        observation["state"] = state
    return observation
