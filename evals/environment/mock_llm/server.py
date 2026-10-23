"""The scripted stand-in model of the evaluation stack: an OpenAI-compatible /v1/chat/completions, plus a small control API.

SYNTHETIC. Nothing it answers says anything about a real model (see shared/evaluation/mock_scripts.py). It exists so the harness can be
exercised end to end, repeatably, without a provider key and without spending money.

The runner loads one plan per case and behaviour (POST /__eval/load), says which case is running (POST /__eval/start) and which scripted
user turn is being delivered (POST /__eval/turn). A model call then answers from the plan: the next scripted tool call of the turn, or
the turn's words once its calls are done. The behaviour is chosen by the model name in the request (mock-oracle, mock-lazy,
mock-reckless). With no case active, or an unknown model name, it answers "Okay." Model names starting with `mock-judge` answer as a
judge (see judge_reply).

    python evals/environment/mock_llm/server.py     # normally started by docker-compose.eval.yml on port 8080
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
import uuid
from typing import Any, Dict, List

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="Scripted model (synthetic)")
LATENCY = {"mock-oracle": 0.05, "mock-lazy": 0.02, "mock-reckless": 0.04}
state: Dict[str, Any] = {"plans": {}, "active": None, "turn": 1, "calls_done": 0, "log": []}


@app.post("/__eval/load")
async def load(request: Request):
    body = await request.json()
    state["plans"].update(body.get("plans") or {})
    return {"plans": len(state["plans"])}


@app.post("/__eval/start")
async def start(request: Request):
    body = await request.json()
    state.update(active=body.get("case_id"), turn=1, calls_done=0)
    return {"active": state["active"]}


@app.post("/__eval/turn")
async def turn(request: Request):
    body = await request.json()
    state.update(turn=int(body.get("turn", 1)), calls_done=0)
    return {"turn": state["turn"]}


@app.post("/__eval/reset")
async def reset():
    state.update(plans={}, active=None, turn=1, calls_done=0, log=[])
    return {"ok": True}


@app.get("/__eval/log")
async def log():
    return {"requests": state["log"][-500:], "models": sorted({r["model"] for r in state["log"]})}


@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": m, "object": "model"} for m in ("mock-oracle", "mock-lazy", "mock-reckless", "mock-judge", "mock-judge-strict")]}


# ── a judge ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

def _deref(schema: Dict[str, Any], defs: Dict[str, Any]) -> Dict[str, Any]:
    while "$ref" in schema:
        schema = defs[schema["$ref"].split("/")[-1]]
    return schema


def synthesize(schema: Dict[str, Any], defs: Dict[str, Any], ok: bool, key: str = "") -> Any:
    """An instance of a JSON schema, as a scripted judge would answer it: favourable when `ok`, unfavourable otherwise. Driven by the
    schema DeepEval sends (response_format), so it answers every metric's prompts without knowing their wording."""
    schema = _deref(schema, defs)
    if "anyOf" in schema:
        options = [o for o in schema["anyOf"] if o.get("type") != "null"]
        return synthesize(options[0], defs, ok, key) if options else None
    if "enum" in schema:
        values = schema["enum"]
        return ("yes" if ok else "no") if "yes" in values and "no" in values else values[0]
    kind = schema.get("type")
    if kind == "object":
        return {k: synthesize(v, defs, ok, k) for k, v in (schema.get("properties") or {}).items()}
    if kind == "array":
        return [synthesize(schema.get("items") or {"type": "string"}, defs, ok, key)]
    if kind == "string":
        if "reason" in key:
            return "scripted judge: " + ("the answer meets the criterion" if ok else "the answer does not meet the criterion")
        return "The reply addresses the request." if ok else "Okay."
    if kind in ("number", "integer"):
        return (9 if ok else 1) if "score" in key else (1 if ok else 0)
    if kind == "boolean":
        return ok
    return None


def judge_ok(model: str, messages: List[Dict[str, Any]]) -> bool:
    """`mock-judge` accepts an answer that is not obviously empty and rejects one that only says "Okay."; `mock-judge-strict` rejects all."""
    low = " ".join(" ".join(str(m.get("content")) for m in messages).lower().split())
    return not (re.search(r"(^|[\s\"'\(\[:])okay\.($|[\s\"'\)\]])", low) or "(no reply)" in low) and model != "mock-judge-strict"


def judge_reply(model: str, messages: List[Dict[str, Any]], response_format: Any = None) -> str:
    ok = judge_ok(model, messages)
    schema = ((response_format or {}).get("json_schema") or {}).get("schema") if isinstance(response_format, dict) else None
    if schema:
        return json.dumps(synthesize(schema, schema.get("$defs") or {}, ok))
    return json.dumps({"score": 9 if ok else 1, "reason": "scripted judge: " + ("meets the criterion" if ok else "does not meet the criterion")})


# ── chat completions ────────────────────────────────────────────────────────────────────────────────────────────────────

def _plan_for(model: str):
    key = f"{state['active']}|{model}"
    return state["plans"].get(key)


def next_action(model: str) -> Dict[str, Any]:
    plan = _plan_for(model)
    if state["active"] is None or plan is None:
        return {"text": "Okay."}
    turns = plan["turns"]
    t = turns[min(max(state["turn"], 1), len(turns)) - 1]
    if state["calls_done"] < len(t["calls"]):
        call = t["calls"][state["calls_done"]]
        state["calls_done"] += 1
        return {"call": call}
    return {"text": t["reply"]}


def _tokens(obj: Any) -> int:
    return max(1, len(json.dumps(obj, default=str)) // 4)


@app.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    model, messages, stream = body.get("model", "mock-oracle"), body.get("messages") or [], bool(body.get("stream"))
    await asyncio.sleep(LATENCY.get(model, 0.03))
    if model.startswith("mock-judge"):
        action = {"text": judge_reply(model, messages, body.get("response_format"))}
    else:
        action = next_action(model)
    system = next((str(m.get("content")) for m in messages if m.get("role") == "system"), "")
    state["log"].append({"at": time.time(), "model": model, "case": state["active"], "turn": state["turn"], "tools_bound": len(body.get("tools") or []),
                         "system_sha": hashlib.sha256(system.encode("utf-8")).hexdigest()[:12], "system_chars": len(system),
                         "action": "call:" + action["call"]["name"] if "call" in action else "text"})
    cid, created = "chatcmpl-" + uuid.uuid4().hex[:20], int(time.time())
    prompt_tokens = _tokens(messages) + _tokens(body.get("tools") or [])
    if "call" in action:
        call = {"id": "call_" + uuid.uuid4().hex[:16], "type": "function", "function": {"name": action["call"]["name"], "arguments": json.dumps(action["call"]["args"])}}
        completion_tokens, finish = _tokens(call), "tool_calls"
        message: Dict[str, Any] = {"role": "assistant", "content": None, "tool_calls": [call]}
    else:
        completion_tokens, finish = _tokens(action["text"]), "stop"
        message = {"role": "assistant", "content": action["text"]}
    usage = {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens, "total_tokens": prompt_tokens + completion_tokens}
    if not stream:
        return JSONResponse({"id": cid, "object": "chat.completion", "created": created, "model": model,
                             "choices": [{"index": 0, "message": message, "finish_reason": finish}], "usage": usage})

    def chunk(delta: Dict[str, Any], finish_reason=None, with_usage=False) -> str:
        payload: Dict[str, Any] = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                                   "choices": [] if with_usage else [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}
        if with_usage:
            payload["usage"] = usage
        return f"data: {json.dumps(payload)}\n\n"

    async def gen():
        yield chunk({"role": "assistant", "content": ""})
        if "call" in action:
            c = message["tool_calls"][0]
            yield chunk({"tool_calls": [{"index": 0, "id": c["id"], "type": "function", "function": {"name": c["function"]["name"], "arguments": ""}}]})
            yield chunk({"tool_calls": [{"index": 0, "function": {"arguments": c["function"]["arguments"]}}]})
        else:
            for part in re.findall(r"\S+\s*", action["text"]) or [action["text"]]:
                yield chunk({"content": part})
        yield chunk({}, finish)
        yield chunk({}, with_usage=True)
        yield "data: [DONE]\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/health")
async def health():
    return {"status": "ok", "synthetic": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
