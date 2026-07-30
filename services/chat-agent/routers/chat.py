"""SSE endpoints for the conversational agent.

Event vocabulary (data: {json}\\n\\n, mirrors api-gateway's evaluate.py buffering
pattern): `token` (assistant text), `interrupt` (paused — needs a clarifying
answer, a yes/no confirmation, or a client-side upload result), `action_completed`
(a mutating tool finished — drives the frontend's toast + navigate + highlight),
`done`, `error`.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Header, Request
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command

from permission import is_role_allowed, step_label
from schemas import ChatResumeRequest, ChatStreamRequest, ExecuteToolRequest
from tool_executor import ExecCtx, execute_tool

router = APIRouter(prefix="/chat", tags=["chat"])

_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}


def _event(payload: dict) -> str:
    return f"data: {json.dumps(payload, default=str)}\n\n"


def _as_text(content: Any) -> str:
    """Gemini's newer content-block format returns a list of
    {"type": "text", "text": "...", "extras": {...}} objects instead of a
    plain string — flatten it the same way route.ts used to before this was
    a Python service, so a stray content block never gets handed to the
    frontend (and rendered as a React child) as a raw object."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                parts.append(block.get("text", ""))
        return "".join(parts)
    return str(content) if content else ""


async def _consume(graph, config, input_):
    """Re-emit graph updates as SSE.

    Besides the original vocabulary (token/interrupt/action_completed/
    quick_actions/done/error) this now narrates the run as a process graph:
    a `step` event fires when a node of work starts (status "active") and
    again when it settles ("done"/"error"), keyed by a stable id so the
    frontend can animate the same node through its lifecycle. A `navigate`
    event carries an explicit "open this page and highlight this row"
    instruction from tools like show_record.
    """
    seq = 0  # monotonically increasing suffix so repeated tools get distinct step ids

    def step(step_id: str, label: str, status: str) -> str:
        return _event({"type": "step", "id": step_id, "label": label, "status": status})

    try:
        thinking_open = True
        yield step("think", "Understanding request", "active")

        async for update in graph.astream(input_, config=config, stream_mode="updates"):
            if "__interrupt__" in update:
                intr = update["__interrupt__"][0]
                if thinking_open:
                    yield step("think", "Understanding request", "done")
                # The pending tool becomes a "waiting on you" node until resume.
                pending_tool = (intr.value.get("tool_call") or {}).get("name", "")
                if pending_tool:
                    yield step(f"wait:{pending_tool}", f"Waiting for you — {step_label(pending_tool)}", "active")
                yield _event({"type": "interrupt", "thread_id": config["configurable"]["thread_id"], **intr.value})
                return

            for node_data in update.values():
                if not isinstance(node_data, dict):
                    continue

                # Autonomous journey stages narrate themselves: each pipeline
                # node reports its own completion (journey_done) and what runs
                # next (journey_next) — rendered as the animated state graph.
                if node_data.get("journey_done"):
                    jd = node_data["journey_done"]
                    yield step(jd["id"], jd["label"], jd.get("status", "done"))
                if node_data.get("journey_next"):
                    jn = node_data["journey_next"]
                    yield step(jn["id"], jn["label"], "active")

                messages = node_data.get("messages")
                if not messages:
                    continue
                for m in messages:
                    if isinstance(m, AIMessage):
                        if thinking_open:
                            thinking_open = False
                            yield step("think", "Understanding request", "done")
                        for tc in (m.tool_calls or []):
                            seq += 1
                            yield step(f"tool:{tc['name']}:{seq}", step_label(tc["name"]), "active")
                        text = _as_text(m.content) if m.content else ""
                        if text:
                            yield _event({"type": "token", "content": text})
                    if isinstance(m, ToolMessage):
                        try:
                            result = json.loads(m.content)
                        except Exception:
                            result = {}
                        status = "done" if result.get("success", True) else "error"
                        yield step(f"tool:{m.name}:{seq}", step_label(m.name or ""), status)
                        if result.get("navigate"):
                            yield _event({"type": "navigate", **result["navigate"]})
                        if result.get("last_action"):
                            yield _event({"type": "action_completed", **result["last_action"]})
                        if result.get("assessment"):
                            yield _event({"type": "assessment", "assessment": result["assessment"]})
                        if result.get("quick_actions"):
                            yield _event({"type": "quick_actions", "actions": result["quick_actions"]})
    except Exception as exc:
        # RuntimeError carries a deliberately user-facing message (e.g. the
        # LLM-overloaded retry exhaustion); anything else gets a calm generic
        # line instead of a raw traceback string in the chat.
        friendly = str(exc) if isinstance(exc, RuntimeError) else \
            "Something hiccuped on my side — please send that again."
        yield _event({"type": "error", "message": friendly})
        return
    yield _event({"type": "done", "thread_id": config["configurable"]["thread_id"]})


def _pending_interrupt_event(state, thread_id: str) -> str | None:
    """If the thread is currently paused at an interrupt (e.g. after a page
    reload), return its SSE event so the frontend can redisplay the same
    question instead of the checkpoint silently vanishing."""
    if not state.next:
        return None
    for task in state.tasks:
        if task.interrupts:
            return _event({"type": "interrupt", "thread_id": thread_id, **task.interrupts[0].value})
    return None


@router.post("/stream")
async def chat_stream(body: ChatStreamRequest, request: Request, x_tenant_id: str = Header(default=""), authorization: str = Header(default="")):
    graph = request.app.state.graph
    config = {"configurable": {"thread_id": body.thread_id}}

    existing = await graph.aget_state(config)
    pending = _pending_interrupt_event(existing, body.thread_id)
    if pending is not None:
        async def _regen():
            yield pending
        return StreamingResponse(_regen(), media_type="text/event-stream", headers=_SSE_HEADERS)

    if not body.message and not body.attachments:
        # Mount-time "is this thread paused?" check with nothing pending —
        # a genuine no-op, not an error (e.g. a fresh thread after "New Chat").
        async def _noop():
            yield _event({"type": "done", "thread_id": body.thread_id})
        return StreamingResponse(_noop(), media_type="text/event-stream", headers=_SSE_HEADERS)

    jwt_token = authorization.replace("Bearer ", "") if authorization else ""
    
    if body.attachments:
        content = []
        if body.message:
            content.append({"type": "text", "text": body.message})
        for att in body.attachments:
            if "url" in att:
                content.append({
                    "type": "image_url",
                    "image_url": {"url": att["url"]}
                })
        message_content = content
    else:
        message_content = body.message
    
    input_ = {
        "messages": [HumanMessage(content=message_content)],
        "tenant_id": x_tenant_id,
        "user_role": body.role,
        "jwt_token": jwt_token,
        "last_action": None,
    }
    return StreamingResponse(_consume(graph, config, input_), media_type="text/event-stream", headers=_SSE_HEADERS)


@router.post("/resume")
async def chat_resume(body: ChatResumeRequest, request: Request):
    graph = request.app.state.graph
    config = {"configurable": {"thread_id": body.thread_id}}
    return StreamingResponse(
        _consume(graph, config, Command(resume=body.resume_value)),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


@router.post("/execute-tool")
async def chat_execute_tool(body: ExecuteToolRequest, x_tenant_id: str = Header(default=""), authorization: str = Header(default="")):
    """Non-streaming, non-graph tool execution — used by VoiceOverlay, which is
    driven by Deepgram's own hosted agent and can't participate in the
    interrupt/resume protocol, but still shares this one execution path
    instead of re-implementing the REST calls a third time.

    Voice never goes through permission_gate's clarify/confirm interrupts
    (Deepgram's own model decides when to call a function, with no pause), but
    the role-based hard block still applies here — it must not become a way to
    bypass RBAC just because it skips the graph."""
    if not is_role_allowed(body.name, body.role):
        return {"success": False, "error": "You do not have permission to perform this action."}
    jwt_token = authorization.replace("Bearer ", "") if authorization else ""
    ctx = ExecCtx(tenant_id=x_tenant_id, jwt_token=jwt_token)
    return await execute_tool(body.name, body.args, ctx)
