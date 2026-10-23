"""The direct LLM benchmark: the same question and the same reference information put to each model, with no agent, no tools and no
database around it. It measures what the model itself does with the material (does it answer correctly, stay with the reference, avoid
claiming things it did not do) and how fast and how dearly, and leaves out everything that needs the agent (routing, tool calls, state).
That is what the end-to-end agent benchmark is for.

A case takes part when it is a chat case with one user message and something this mode can judge: a response text check or a judged
criterion. Everything else is left out and the report says how many and why. For a case that takes part, only the response checks and the
judged criteria count (layers L1 inputs, L2 output quality and L6 performance); the case itself is never changed.

The prompt is identical for every model and carries a version (DIRECT_PROMPT_VERSION): a run records it, so two benchmarks are only
compared when they asked the same thing in the same way.
"""
from __future__ import annotations

import copy
import json
import re
from typing import Any, Dict, List, Optional, Tuple

import httpx

DIRECT_PROMPT_VERSION = "direct-v1"
SYSTEM_PROMPT = (
    "You are an assistant for the staff of a life insurance company. You have no tools and cannot look anything up or change any record. "
    "Answer the user's message using only the reference information below. If the reference information does not cover it, say so plainly "
    "instead of guessing. Never say that you have done something you cannot do. Be brief and accurate.")
DIRECT_LAYERS = ("L1", "L2", "L6")
NOT_APPLICABLE = "not_applicable_in_direct_mode"


class DirectError(Exception):
    """The call itself failed (provider error, timeout): an infrastructure matter, not a verdict on the model's answer."""

    def __init__(self, kind: str, message: str, *, latency_ms: Optional[int] = None) -> None:
        super().__init__(message)
        self.kind, self.latency_ms = kind, latency_ms


class DirectBlocked(Exception):
    """The provider may not be called from this stack (not allowed, or no key)."""


def user_texts(case: Dict[str, Any]) -> List[str]:
    inp = case.get("input") or {}
    texts = [m["content"] for m in inp.get("messages", []) if m.get("role") == "user" and m.get("content")]
    if not texts and (inp.get("payload") or {}).get("message"):
        texts = [inp["payload"]["message"]]
    return texts


def is_response_check(assertion: Dict[str, Any]) -> bool:
    return str(assertion.get("target", "")).startswith("response.")


def applicable(case: Dict[str, Any]) -> Optional[str]:
    """None when the case can be put to a bare model; otherwise why not."""
    if len(user_texts(case)) != 1:
        return "needs a single user message" if user_texts(case) else "has no user message"
    if not case.get("semantic_criteria") and not any(is_response_check(a) for a in case.get("assertions", [])):
        return "nothing in it can be judged from the answer alone"
    return None


def direct_view(case: Dict[str, Any]) -> Dict[str, Any]:
    """The case as this mode judges it: response checks and judged criteria only, layers L1, L2 and L6 only."""
    view = copy.deepcopy(case)
    view["assertions"] = [a for a in view.get("assertions", []) if is_response_check(a)]
    layers = (view.get("evaluation") or {}).get("layers") or [{"layer": n, "enabled": True, "threshold": None} for n in ("L1", "L2", "L3", "L4", "L5", "L6")]
    view.setdefault("evaluation", {})["layers"] = [{**l, "enabled": l["layer"] in DIRECT_LAYERS and l.get("enabled", True)} for l in layers]
    return view


_REFS = re.compile(r"\$(customer|plan|policy|claim)\.([A-Za-z0-9_-]+)\.(id|policy_number)")


def resolve_standalone(case: Dict[str, Any]) -> Dict[str, Any]:
    """Fill the case's placeholders without seeding a database: a bare model cannot use a real identifier anyway, so each reference becomes
    a readable stand-in ("customer-zara"). The same stand-in is used in the question and in the expected values."""
    from shared.evaluation.placeholders import substitute
    found = set(_REFS.findall(json.dumps(case, default=str)))
    ids: Dict[str, Dict[str, str]] = {}
    for kind, name, field in found:
        table = "policy_number" if field == "policy_number" else kind
        ids.setdefault(table, {})[name] = f"{kind}-{name}"
    return substitute(case, ids)


def build_messages(case: Dict[str, Any]) -> Tuple[List[Dict[str, str]], Dict[str, Any]]:
    """(chat messages, hint for the scripted stand-in). The reference information is the case's own `reference_context`."""
    context = [c["text"] for c in case.get("reference_context", []) if c.get("text")]
    role = ((case.get("input") or {}).get("actor") or {}).get("role")
    system = SYSTEM_PROMPT + (f"\n\nThe user is a {role}." if role else "")
    if context:
        system += "\n\nReference information:\n" + "\n".join(f"- {c}" for c in context)
    return [{"role": "system", "content": system}, {"role": "user", "content": user_texts(case)[0]}], {"context": context}


async def execute_direct_case(case: Dict[str, Any], *, client: httpx.AsyncClient, judge_url: str, model: str, settings: Dict[str, Any],
                              timeout_s: float) -> Dict[str, Any]:
    """Put the case to `model` (provider/model) and return an observation shaped like the agent's, so the same assertions, judge and
    layers apply: response.text, usage, latency_ms, ttft_ms."""
    messages, hint = build_messages(case)
    try:
        response = await client.post(f"{judge_url}/generate", json={"model": model, "messages": messages, "settings": settings, "timeout_s": timeout_s, "mock_hint": hint},
                                     timeout=timeout_s + 15)
        body = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise DirectError("generate_unreachable", f"the generation service could not be reached: {type(exc).__name__}") from exc
    status = body.get("status")
    if status == "blocked_missing_credentials":
        raise DirectBlocked(body.get("error") or "no credentials")
    if status == "timeout":
        raise DirectError("timeout", body.get("error") or "timeout", latency_ms=body.get("latency_ms"))
    if status != "ok":
        raise DirectError("provider_error", f"{body.get('http_status', '')} {body.get('error') or 'unknown error'}".strip()[:300], latency_ms=body.get("latency_ms"))
    returned = body.get("returned_model") or model.split("/", 1)[1]
    have = body.get("input_tokens") is not None and body.get("output_tokens") is not None
    usage = {"status": "attributed" if have else "unknown", "calls": 1, "input_tokens": body.get("input_tokens"), "output_tokens": body.get("output_tokens"),
             "cached_tokens": body.get("cached_tokens") or 0, "cached_reported": body.get("cached_tokens") is not None,
             "by_model": {returned: {"calls": 1, "input_tokens": body.get("input_tokens") or 0, "output_tokens": body.get("output_tokens") or 0,
                                     "cached_tokens": body.get("cached_tokens") or 0}} if have else {},
             "note": None if have else "the provider reported no token counts: the cost is unknown"}
    return {"response": {"text": body["text"]}, "usage": usage, "latency_ms": body.get("latency_ms"), "ttft_ms": body.get("ttft_ms"),
            "finish_reason": body.get("finish_reason"), "synthetic_model": model.startswith("mock/"), "direct": True,
            "transcript": {"mode": "direct", "prompt_version": DIRECT_PROMPT_VERSION, "model": model, "returned_model": returned, "messages": messages,
                           "reply": body["text"], "finish_reason": body.get("finish_reason"), "latency_ms": body.get("latency_ms"), "ttft_ms": body.get("ttft_ms")}}
