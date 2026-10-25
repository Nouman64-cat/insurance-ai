"""Ask a candidate model one question, the same way for every model: the direct side of a benchmark.

The call goes through this service because it is the one place in the evaluation stack that may reach a provider, and it applies the same
rules as scoring (the provider must be in EVAL_ALLOWED_PROVIDERS and have a key, otherwise `blocked_missing_credentials`; a scripted
`mock/...` model is answered by the stack's own stand-in). The answer is streamed so the time to the first token can be measured.

Nothing here invents a figure. A count the provider did not report is None (unknown), never 0; a failure is its own status
(`timeout`, `error`) so a benchmark can count errors and timeouts apart from wrong answers.
"""
from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

import httpx


class StreamState:
    """Reads an OpenAI-style event stream line by line and keeps what a benchmark needs: the text, when the first text arrived, why it
    ended and the token counts the provider reported."""

    def __init__(self, started: float) -> None:
        self.started = started
        self.parts: List[str] = []
        self.first_token_at: Optional[float] = None
        self.finish_reason: Optional[str] = None
        self.model: Optional[str] = None
        self.usage: Optional[Dict[str, Any]] = None
        self.done = False

    def feed(self, line: str, now: float) -> None:
        line = line.strip()
        if not line.startswith("data:"):
            return
        data = line[5:].strip()
        if data == "[DONE]":
            self.done = True
            return
        try:
            event = json.loads(data)
        except json.JSONDecodeError:
            return
        if not isinstance(event, dict):
            return
        self.model = event.get("model") or self.model
        if isinstance(event.get("usage"), dict):
            self.usage = event["usage"]
        for choice in event.get("choices") or []:
            text = (choice.get("delta") or {}).get("content")
            if text:
                if self.first_token_at is None:
                    self.first_token_at = now
                self.parts.append(text)
            if choice.get("finish_reason"):
                self.finish_reason = choice["finish_reason"]

    def result(self, ended: float) -> Dict[str, Any]:
        u = self.usage or {}
        details = u.get("prompt_tokens_details") or {}
        return {"text": "".join(self.parts), "finish_reason": self.finish_reason, "returned_model": self.model,
                "latency_ms": round((ended - self.started) * 1000),
                "ttft_ms": round((self.first_token_at - self.started) * 1000) if self.first_token_at is not None else None,
                "input_tokens": u.get("prompt_tokens"), "output_tokens": u.get("completion_tokens"),
                "cached_tokens": details.get("cached_tokens") if isinstance(details, dict) else None}


def build_body(model: str, messages: List[Dict[str, str]], settings: Dict[str, Any], *, mock_hint: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    body: Dict[str, Any] = {"model": model, "messages": messages, "stream": True, "stream_options": {"include_usage": True}}
    for key in ("temperature", "top_p", "max_tokens", "seed"):
        if settings.get(key) is not None:
            body[key] = settings[key]
    if mock_hint is not None:                                    # only the scripted stand-in is told anything beyond the prompt
        body["x_eval_direct"] = mock_hint
    return body


async def generate(cfg: Dict[str, str], messages: List[Dict[str, str]], settings: Dict[str, Any], *, timeout_s: float, mock: bool,
                   mock_hint: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    body = build_body(cfg["model"], messages, settings, mock_hint=mock_hint if mock else None)
    started = time.monotonic()
    state = StreamState(started)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_s, connect=min(10.0, timeout_s))) as client:
            async with client.stream("POST", f"{cfg['base_url']}/chat/completions", headers={"Authorization": f"Bearer {cfg['api_key']}"}, json=body) as response:
                if response.status_code != 200:
                    detail = (await response.aread()).decode("utf-8", "replace")[:300]
                    return {"status": "error", "http_status": response.status_code, "error": detail, "latency_ms": int((time.monotonic() - started) * 1000)}
                async for line in response.aiter_lines():
                    state.feed(line, time.monotonic())
    except httpx.TimeoutException:
        return {"status": "timeout", "error": f"no complete answer within {timeout_s:g} s", "latency_ms": int((time.monotonic() - started) * 1000)}
    except httpx.HTTPError as exc:
        return {"status": "error", "error": f"{type(exc).__name__}: {exc}"[:300], "latency_ms": int((time.monotonic() - started) * 1000)}
    result = state.result(time.monotonic())
    if not state.done and not result["text"]:
        return {"status": "error", "error": "the stream ended without an answer", "latency_ms": result["latency_ms"]}
    return {"status": "ok", **result}
