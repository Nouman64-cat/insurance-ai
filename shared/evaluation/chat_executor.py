"""Running one chat case against the real chat agent of the isolated evaluation stack and returning the observation the assertion
engine judges (`response`, `trace`, `routing`, `state`, plus `usage` and a full `transcript` for the artifact).

What one execution does, in order
  1. logs in as the case's actor (a real login, the real role) and fills the case's placeholders from what the sandbox seeded;
  2. for a scripted (`mock/...`) model, loads the plan built from the case and tells the mock which case and turn is running;
  3. snapshots the tenant's data, drives the conversation (shared/evaluation/chat.py), and snapshots again after every turn;
  4. reads the thread back from the agent's own checkpoint (the guarded trace endpoint) and the model calls from the token ledger;
  5. builds the observation. Nothing here judges: the assertion engine does.

The model of a conversation is chosen per request (`X-Eval-Model`), skills per request (`X-Eval-Skills`) and the prompt variant per
request (`X-Eval-Prompt`); the agent honours those headers only inside the evaluation stack, so the platform's own configuration is
never touched. A model whose name starts with `mock/` is the scripted stand-in: its runs are SYNTHETIC and say nothing about model
quality (see mock_scripts.py).
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from shared.evaluation.chat import build_observation, run_conversation
from shared.evaluation.mock_scripts import build_plan
from shared.evaluation.placeholders import PlaceholderError, has_placeholders, substitute
from shared.evaluation.state_observer import build_state, snapshot


class ChatExecutionError(Exception):
    """The harness could not carry out the conversation (not a verdict on the agent)."""


@dataclass
class ChatTarget:
    """What a chat run drives: the model, whether skills are on, and which prompt variant."""
    model: str                               # "mock/mock-oracle", "openai/gpt-4o-mini", ...
    skills: Optional[bool] = None            # None: the agent's own setting
    prompt_version: Optional[str] = None     # None: the agent's production prompts

    @property
    def synthetic(self) -> bool:
        return self.model.startswith("mock/")

    @property
    def mock_name(self) -> str:
        return self.model.split("/", 1)[1]

    @property
    def provider(self) -> str:
        return self.model.split("/", 1)[0]

    def headers(self) -> Dict[str, str]:
        h = {"X-Eval-Model": self.model}
        if self.skills is not None:
            h["X-Eval-Skills"] = "on" if self.skills else "off"
        if self.prompt_version:
            h["X-Eval-Prompt"] = self.prompt_version
        return h


@dataclass
class ChatRuntime:
    """Everything an execution needs from the runner."""
    client: Any                              # an async HTTP client (httpx.AsyncClient)
    chat_url: str
    mock_url: Optional[str]
    api_url: str
    env: Any                                 # evals.tools.http_runner.Environment: .engine, .ids
    login: Any                               # async (user_ref) -> bearer token
    target: ChatTarget
    meter: Any = None                        # shared.evaluation.usage.UsageMeter
    timeout: float = 120.0
    turn_guard: Any = None                   # (turn number) -> a reason to stop the conversation before that turn, or None (the runner stops a conversation whose budget ran out)
    extra: Dict[str, Any] = field(default_factory=dict)


def user_messages(case: Dict[str, Any]) -> List[str]:
    """The scripted user turns: the case's user messages, or, for an API-style chat case, its payload message."""
    inp = case.get("input") or {}
    texts = [m["content"] for m in inp.get("messages", []) if m.get("role") == "user"]
    if not texts and (inp.get("payload") or {}).get("message"):
        texts = [inp["payload"]["message"]]
    return texts


def resolve_case(case: Dict[str, Any], ids: Dict[str, Dict[str, str]]) -> Dict[str, Any]:
    """The case with every placeholder replaced by this run's value. The stored case is never changed."""
    actor = (case.get("input") or {}).get("actor") or {}
    try:
        return substitute(case, ids, tenant_ref=actor.get("tenant_ref"))
    except PlaceholderError as exc:
        raise ChatExecutionError(str(exc)) from exc


def wrong_models(target_model: str, by_model: Dict[str, Any]) -> List[str]:
    """The models in the token ledger that are not the one this run asked for. A provider names the model it served with a date suffix
    (gpt-4o-mini-2024-07-18), so a ledger name starting with the requested name is the right one. An empty list means the intended model
    answered (or the ledger said nothing). A case whose answers came from another model says nothing about the model under test."""
    wanted = target_model.split("/", 1)[1].lower()
    return sorted(m for m in by_model if not str(m).lower().startswith(wanted))


async def _mock(rt: ChatRuntime, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if not rt.mock_url:
        raise ChatExecutionError("the scripted model is not reachable: EVAL_MOCK_LLM_URL is not set")
    response = await rt.client.post(f"{rt.mock_url}/__eval/{path}", json=body or {})
    if response.status_code != 200:
        raise ChatExecutionError(f"the scripted model refused /__eval/{path}: HTTP {response.status_code}")
    return response.json()


async def _mock_calls(rt: ChatRuntime, case_id: str) -> int:
    response = await rt.client.get(f"{rt.mock_url}/__eval/log")
    rows = response.json().get("requests", []) if response.status_code == 200 else []
    return sum(1 for r in rows if r.get("case") == case_id and not str(r.get("model", "")).startswith("mock-judge"))


async def execute_chat_case(case: Dict[str, Any], rt: ChatRuntime, *, execution_id: str) -> Dict[str, Any]:
    """Drive the conversation of `case` and return its observation. Raises ChatExecutionError when it cannot be carried out."""
    if (case.get("input") or {}).get("payload", {}).get("operation") == "chat.stream":
        return await execute_thread_case(case, rt, execution_id=execution_id)
    actor = (case.get("input") or {}).get("actor") or {}
    ids = rt.env.ids
    resolved = resolve_case(case, ids)
    texts = user_messages(resolved)
    if not texts:
        raise ChatExecutionError("the case has no user message to send")
    tenant_id = ids.get("tenant", {}).get(actor.get("tenant_ref") or "")
    token = await rt.login(actor["user_ref"])
    headers = {"Authorization": f"Bearer {token}", **({"X-Tenant-Id": tenant_id} if tenant_id else {}), **rt.target.headers()}
    thread_id = f"eval-{execution_id.replace('/', '-')}-{uuid.uuid4().hex[:8]}"
    actor_id = ids.get("user", {}).get(actor.get("user_ref") or "")

    mock_calls: Optional[int] = None
    if rt.target.synthetic:
        await _mock(rt, "reset")
        plan = build_plan(resolved, rt.target.mock_name)
        await _mock(rt, "load", {"plans": {f"{case['case_id']}|{rt.target.mock_name}": plan}})
        await _mock(rt, "start", {"case_id": case["case_id"]})

    snaps: List[Dict[str, Any]] = []
    async with rt.env.engine.connect() as conn:
        before = await snapshot(conn, tenant_id) if tenant_id else None

    async def on_turn(i: int) -> None:
        if rt.target.synthetic:
            await _mock(rt, "turn", {"turn": i})
        if i > 1 and tenant_id:                       # the state after the previous turn
            async with rt.env.engine.connect() as c:
                snaps.append(await snapshot(c, tenant_id))

    mark = await rt.meter.begin(execution_id, match=lambda r: str(r.get("thread_id")) == thread_id) if rt.meter else None
    started = time.monotonic()
    try:
        convo = await run_conversation(rt.client, chat_url=rt.chat_url, headers=headers, thread_id=thread_id, messages=texts,
                                       confirmations=(case.get("metadata") or {}).get("confirmations", "auto_approve"), on_turn=on_turn,
                                       timeout=rt.timeout, locale_for_turn=(case.get("metadata") or {}).get("locale"), stop_before_turn=rt.turn_guard)
    except BaseException:                          # a timeout cancels this task: the runner reads what the ledger shows (UsageMeter.settle_abandoned)
        if rt.meter:
            rt.meter.abandon()
        raise
    latency_ms = int((time.monotonic() - started) * 1000)
    if tenant_id:
        async with rt.env.engine.connect() as c:
            snaps.append(await snapshot(c, tenant_id))
    if rt.target.synthetic:
        mock_calls = await _mock_calls(rt, case["case_id"])

    usage = None
    if rt.meter and mark is not None:
        usage = await rt.meter.end(mark, expected_min_calls=mock_calls or 0, match=lambda r: str(r.get("thread_id")) == thread_id)

    state = None
    if before is not None and snaps:
        ref_ids = ids.get("customer", {})
        state = build_state(before, snaps[-1], texts=texts, ref_ids=ref_ids, actor_id=actor_id, per_turn=snaps)
    observation = build_observation(convo, llm_calls=usage.calls if usage is not None and usage.known else mock_calls, state=state)
    observation["transcript"] = {"thread_id": thread_id, "model": rt.target.model, "synthetic": rt.target.synthetic, "latency_ms": latency_ms,
                                 "turns": [{"index": t.index, "message": t.message, "delivered_as": t.delivered_as, "reply": t.text, "error": t.error,
                                            "interrupt": t.interrupt, "latency_ms": t.latency_ms, "ttft_ms": t.ttft_ms} for t in convo.turns],
                                 "messages": (convo.trace or {}).get("messages", [])}
    observation["latency_ms"] = latency_ms
    observation["ttft_ms"] = next((t.ttft_ms for t in convo.turns if t.ttft_ms is not None), None)
    errors = [t.error for t in convo.turns if t.error]
    if errors:
        observation["agent_error"] = errors[0]
    if usage is not None:
        observation["usage"] = usage.as_dict()
    observation["synthetic_model"] = rt.target.synthetic
    if convo.stopped:
        observation["stopped"] = convo.stopped
    return observation


async def execute_thread_case(case: Dict[str, Any], rt: ChatRuntime, *, execution_id: str) -> Dict[str, Any]:
    """A `chat.stream` API case about someone else's conversation (IND-SEC-006): the user named in `thread_of` starts a conversation
    that stops on a question; the case's actor then tries to continue it. The agent must refuse (403), and the first user's thread
    must be exactly as it was."""
    actor = (case.get("input") or {}).get("actor") or {}
    payload = case["input"]["payload"]
    owner_ref = payload.get("thread_of")
    if not owner_ref:
        raise ChatExecutionError("a chat.stream case needs payload.thread_of")
    ids = rt.env.ids
    tenant_id = ids.get("tenant", {}).get(actor.get("tenant_ref") or "")
    owner_token, intruder_token = await rt.login(owner_ref), await rt.login(actor["user_ref"])
    base = {"X-Tenant-Id": tenant_id} if tenant_id else {}
    owner_headers = {"Authorization": f"Bearer {owner_token}", **base, **rt.target.headers()}
    intruder_headers = {"Authorization": f"Bearer {intruder_token}", **base, **rt.target.headers()}
    thread_id = f"eval-{execution_id.replace('/', '-')}-{uuid.uuid4().hex[:8]}"

    # The owner's thread must stop on a question. With the scripted model that is its first scripted call (the customer-type
    # question); a real model gets the same vague opening and decides for itself.
    opening = "I want to register a new customer."
    if rt.target.synthetic:
        await _mock(rt, "reset")
        await _mock(rt, "load", {"plans": {f"{case['case_id']}|{rt.target.mock_name}": {
            "behaviour": rt.target.mock_name, "case_id": case["case_id"], "user_texts": [opening],
            "turns": [{"calls": [{"name": "resolve_customer_type", "args": {}}], "reply": "Which kind of customer is this?"}]}}})
        await _mock(rt, "start", {"case_id": case["case_id"]})
        await _mock(rt, "turn", {"turn": 1})
    from shared.evaluation.chat import fetch_trace, _consume
    mark = await rt.meter.begin(execution_id, match=lambda r: str(r.get("thread_id")) == thread_id) if rt.meter else None
    try:
        events, status, _, _ = await _consume(rt.client, "POST", f"{rt.chat_url}/chat/stream", owner_headers,
                                              {"thread_id": thread_id, "message": opening, "platform": "web", "locale": "en"}, rt.timeout)
    except BaseException:
        if rt.meter:
            rt.meter.abandon()
        raise
    before = await fetch_trace(rt.client, rt.chat_url, owner_headers, thread_id)
    if not before.get("waiting"):
        if rt.meter:
            rt.meter.abandon()
        raise ChatExecutionError("the owner's conversation did not stop on a question, so there is nothing for the other user to continue")

    response = await rt.client.post(f"{rt.chat_url}/chat/resume", headers=intruder_headers, json={"thread_id": thread_id, "resume_value": payload["message"]})
    try:
        body = response.json()
    except Exception:
        body = {}
    after = await fetch_trace(rt.client, rt.chat_url, owner_headers, thread_id)
    usage = None
    if rt.meter and mark is not None:                     # the owner's opening is the only message that reaches a model; the refused resume reaches none
        usage = await rt.meter.end(mark, expected_min_calls=1 if rt.target.synthetic else 0, match=lambda r: str(r.get("thread_id")) == thread_id)
    reading = await rt.client.get(f"{rt.chat_url}/chat/eval/trace/{thread_id}", headers=intruder_headers)      # the trace is no side door into the thread
    unchanged = bool(after) and len(after.get("messages", [])) == len(before.get("messages", [])) and bool(after.get("waiting")) and after.get("interrupt") == before.get("interrupt")
    result = {"status_code": response.status_code, **({"detail": body.get("detail")} if isinstance(body, dict) else {}), "body": body}
    return {"result": result, "state": {"thread": {owner_ref: {"paused_step_executed": not unchanged}}},
            **({"usage": usage.as_dict()} if usage is not None else {}), "synthetic_model": rt.target.synthetic, "transcript": {"thread_id": thread_id, "owner": owner_ref, "before": before, "after": after,
                                                                                                    "intruder_trace_status": reading.status_code}}
