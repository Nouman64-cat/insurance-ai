"""Groq backend for layer 2 (OpenAI-compatible chat completions with image input).

It plugs into the same ``GeminiClient`` (rate limiter, retries, typed errors, call log) as a transport, so the
checks, verification and test runner are identical whichever model reads the page.

Groq free-tier limits that shape this code (observed from response headers on this key, model qwen/qwen3.8-27b):
    1000 requests per day, 8000 TOKENS PER MINUTE.
The token limit is the binding one. A single request that needs more than the per-minute allowance can never succeed
(Groq answers 413), so output length is capped per call purpose, the caller should send few pages, and the transport
waits for the per-minute window to refill using the ``x-ratelimit-*`` headers instead of colliding with it.

Settings (environment or .env): GROQ_API_KEY, GROQ_MODEL (default qwen/qwen3.8-27b), GROQ_MIN_INTERVAL_S (4),
GROQ_MAX_RETRIES (4), GROQ_BACKOFF_BASE_S, GROQ_BACKOFF_CAP_S, GROQ_TIMEOUT_S (60), GROQ_MAX_OUTPUT_TOKENS (4096).
"""

from __future__ import annotations

import base64
import os
import re
import time
from typing import Any, Callable

import httpx

from .gemini_client import (
    AuthError, BadRequest, Blocked, GeminiError, QuotaExhausted, RateLimited, Reply, Request, ServiceError, Settings,
    Timeout, _scrub)

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = "qwen/qwen3.8-27b"
MAX_IMAGES = 5  # per request, per Groq's vision docs
MAX_B64_BYTES = 3_800_000  # Groq limits base64 image payloads to about 4 MB
# Output cap per purpose. On the free tier this model allows only ~1,000 OUTPUT tokens per minute (seen in a 429), and
# Groq rejects a request whose expected output exceeds that. The small calls stay under it; extraction needs room for
# tables, so it keeps a larger cap and relies on retries and the token-window wait.
MAX_OUTPUT = {"extract": 4096, "confirm": 600, "visual": 700}
IMAGE_TOKENS = 1100  # up to ~1,026 per image per Groq's docs, plus margin
PROMPT_CHARS_PER_TOKEN = 3.2

_DUR = re.compile(r"(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$")
_TRY_AGAIN = re.compile(r"try again in\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)", re.IGNORECASE)


def parse_duration(text: str | None) -> float | None:
    """'16.74s', '1m26.4s', '250ms', '2h3m' -> seconds."""
    if not text:
        return None
    m = _DUR.match(text.strip())
    if not m or not any(m.groups()):
        try:
            return float(text)
        except ValueError:
            return None
    h, mi, s, ms = (float(g) if g else 0.0 for g in m.groups())
    return h * 3600 + mi * 60 + s + ms / 1000


def settings_from_env(**overrides: Any) -> Settings:
    """Groq defaults, overridden by GROQ_* variables."""
    def num(name: str, default: float) -> float:
        try:
            return float(os.environ[name])
        except (KeyError, ValueError):
            return default

    s = Settings(
        model=os.environ.get("GROQ_MODEL", "").strip() or DEFAULT_MODEL,
        min_interval_s=num("GROQ_MIN_INTERVAL_S", 4.0), max_retries=int(num("GROQ_MAX_RETRIES", 4)),
        backoff_base_s=num("GROQ_BACKOFF_BASE_S", 6.0), backoff_cap_s=num("GROQ_BACKOFF_CAP_S", 90.0),
        timeout_s=num("GROQ_TIMEOUT_S", 60.0), max_output_tokens=int(num("GROQ_MAX_OUTPUT_TOKENS", 4096)),
        call_log=os.environ.get("GROQ_CALL_LOG") or None)
    for k, v in overrides.items():
        setattr(s, k, v)
    return s


def estimate_tokens(request: Request, max_output: int) -> int:
    """Rough tokens this request will count against the per-minute allowance (prompt + images + output reserved)."""
    return int(len(request.prompt) / PROMPT_CHARS_PER_TOKEN) + IMAGE_TOKENS * len(request.images) + max_output


def classify_http(status: int, body: Any, headers: httpx.Headers) -> GeminiError:
    """Map a Groq HTTP error to a typed error."""
    err = body.get("error", {}) if isinstance(body, dict) else {}
    message = _scrub(str(err.get("message") or body))
    retry_after = parse_duration(headers.get("retry-after"))
    if retry_after is None:
        m = _TRY_AGAIN.search(message)
        retry_after = parse_duration(m.group(1)) if m else None
    if status == 429:
        daily = bool(re.search(r"per day|\(RPD\)|\(TPD\)", message, re.IGNORECASE)) or (retry_after or 0) > 300
        return (QuotaExhausted if daily else RateLimited)(message, retry_after=retry_after)
    if status == 413:
        return BadRequest("request too large for this model's per-minute token limit; send fewer or smaller pages: " + message)
    if status in (401, 403):
        return AuthError(message)
    if status == 400:
        return BadRequest(message)
    if status >= 500:
        return ServiceError(message, retry_after=retry_after)
    return GeminiError(f"HTTP {status}: {message}")


class GroqTransport:
    """Callable transport: ``transport(request, settings) -> Reply``. One instance per process (it tracks the token window)."""

    def __init__(self, http: httpx.Client | None = None, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep):
        self.http, self._clock, self._sleep = http, clock, sleep
        self.remaining_tokens: float | None = None
        self.window_resets_at = 0.0
        self.last_headers: dict[str, str] = {}

    def _client(self, settings: Settings) -> httpx.Client:
        if self.http is None:
            self.http = httpx.Client(timeout=settings.timeout_s)
        return self.http

    def _wait_for_token_window(self, needed: int) -> None:
        """If the last response said the per-minute allowance is nearly spent, wait for it to refill."""
        if self.remaining_tokens is None:
            return
        now = self._clock()
        if self.remaining_tokens < needed and self.window_resets_at > now:
            self._sleep(self.window_resets_at - now + 0.5)
        self.remaining_tokens = None

    def _learn_limits(self, headers: httpx.Headers) -> None:
        remaining = headers.get("x-ratelimit-remaining-tokens")
        reset = parse_duration(headers.get("x-ratelimit-reset-tokens"))
        self.last_headers = {k: v for k, v in headers.items() if k.lower().startswith(("x-ratelimit", "retry-after"))}
        if remaining is not None and reset is not None:
            try:
                self.remaining_tokens = float(remaining)
                self.window_resets_at = self._clock() + reset
            except ValueError:
                pass

    def __call__(self, request: Request, settings: Settings) -> Reply:
        key = os.environ.get("GROQ_API_KEY", "").strip()
        if not key:
            from .gemini_client import ConfigError

            raise ConfigError("GROQ_API_KEY is not set. Add it to your .env file or the environment.")
        if len(request.images) > MAX_IMAGES:
            raise BadRequest(f"Groq accepts at most {MAX_IMAGES} images per request; got {len(request.images)}")
        encoded = [(base64.b64encode(data).decode("ascii"), mime) for data, mime in request.images]
        if sum(len(b) for b, _ in encoded) > MAX_B64_BYTES:
            raise BadRequest("the page images are too large for one Groq request (about 4 MB of base64)")

        max_out = min(settings.max_output_tokens, MAX_OUTPUT.get(request.purpose, settings.max_output_tokens))
        content: list[dict[str, Any]] = [{"type": "text", "text": request.prompt}]
        content += [{"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}} for b64, mime in encoded]
        body: dict[str, Any] = {"model": settings.model, "messages": [{"role": "user", "content": content}],
                                "temperature": 0, "max_completion_tokens": max_out}
        if request.json_mode:
            body["response_format"] = {"type": "json_object"}

        self._wait_for_token_window(estimate_tokens(request, max_out))
        try:
            response = self._client(settings).post(GROQ_URL, json=body, headers={"Authorization": f"Bearer {key}"},
                                                   timeout=settings.timeout_s)
        except httpx.TimeoutException as exc:
            raise Timeout(_scrub(f"{type(exc).__name__}: {exc}")) from exc
        except httpx.TransportError as exc:
            raise ServiceError(_scrub(f"{type(exc).__name__}: {exc}")) from exc
        self._learn_limits(response.headers)

        try:
            data = response.json()
        except ValueError:
            data = response.text
        if response.status_code != 200:
            raise classify_http(response.status_code, data, response.headers)
        try:
            choice = data["choices"][0]
            text = choice["message"].get("content") or ""
        except (KeyError, IndexError, TypeError, AttributeError) as exc:
            raise Blocked("the reply had no message content") from exc
        finish = {"stop": "STOP", "length": "MAX_TOKENS", "content_filter": "SAFETY"}.get(
            str(choice.get("finish_reason")), str(choice.get("finish_reason")).upper())
        usage = data.get("usage") if isinstance(data, dict) else None
        usage = usage if isinstance(usage, dict) else {}
        return Reply(text=text.strip(), finish_reason=finish, tokens_in=usage.get("prompt_tokens"),
                     tokens_out=usage.get("completion_tokens"))
