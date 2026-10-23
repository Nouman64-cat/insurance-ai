"""Gemini access for layer 2: rate limiting, retries, typed failures and a call log.

Nothing in here swallows an error. Every failure is raised as a ``GeminiError``
subclass whose ``kind`` says what went wrong, so the caller can tell "the model
found nothing" apart from "the model never ran".

Settings come from the environment (or ``.env``):

    GEMINI_API_KEY              required
    GEMINI_MODEL                default gemini-2.5-flash
    GEMINI_MIN_INTERVAL_S       minimum seconds between request starts (default 13)
    GEMINI_MAX_RETRIES          retries for per-minute limits, timeouts, 5xx (default 3)
    GEMINI_BACKOFF_BASE_S       first retry delay when the server gives none (default 10)
    GEMINI_BACKOFF_CAP_S        longest single wait before a retry (default 120)
    GEMINI_TIMEOUT_S            per-request timeout (default 90)
    GEMINI_MAX_OUTPUT_TOKENS    default 16384
    GEMINI_THINKING_BUDGET      optional integer; 0 turns thinking off on 2.5 Flash
    GEMINI_CALL_LOG             optional path; one JSON line per attempt
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


# ---------------------------------------------------------------------------
# Typed failures
# ---------------------------------------------------------------------------

class GeminiError(Exception):
    kind = "error"
    retryable = False

    def __init__(self, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class ConfigError(GeminiError):
    kind = "config"


class AuthError(GeminiError):
    kind = "auth"


class QuotaExhausted(GeminiError):
    """A daily (or otherwise long) quota is spent. Retrying now is pointless."""
    kind = "quota_exhausted"


class RateLimited(GeminiError):
    """A per-minute limit. Waiting a short time helps."""
    kind = "rate_limited"
    retryable = True


class Timeout(GeminiError):
    kind = "timeout"
    retryable = True


class ServiceError(GeminiError):
    kind = "service_error"
    retryable = True


class BadRequest(GeminiError):
    kind = "bad_request"


class Blocked(GeminiError):
    """The model refused or a safety filter removed the reply."""
    kind = "blocked"


class BadResponse(GeminiError):
    """The reply was empty, cut off, or not the JSON that was asked for."""
    kind = "bad_response"


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def _load_dotenv() -> None:
    """Load variables from the nearest .env file into os.environ (best effort, never overrides)."""
    for candidate in (Path(__file__).parent.parent / ".env", Path(".env")):
        if candidate.is_file():
            try:
                for line in candidate.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line.startswith("export "):
                        line = line[7:]
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    key, value = key.strip(), value.strip().strip('"').strip("'")
                    if key and key not in os.environ:
                        os.environ[key] = value
            except OSError:
                pass
            break


_load_dotenv()


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


@dataclass
class Settings:
    model: str = "gemini-2.5-flash"
    min_interval_s: float = 13.0
    max_retries: int = 3
    backoff_base_s: float = 10.0
    backoff_cap_s: float = 120.0
    timeout_s: float = 90.0
    max_output_tokens: int = 16384
    thinking_budget: int | None = None
    call_log: str | None = None
    daily_quota_threshold_s: float = 300.0  # a server-suggested wait longer than this means a daily quota

    @classmethod
    def from_env(cls) -> "Settings":
        budget = os.environ.get("GEMINI_THINKING_BUDGET", "").strip()
        return cls(
            model=os.environ.get("GEMINI_MODEL", cls.model).strip() or cls.model,
            min_interval_s=_env_float("GEMINI_MIN_INTERVAL_S", cls.min_interval_s),
            max_retries=int(_env_float("GEMINI_MAX_RETRIES", cls.max_retries)),
            backoff_base_s=_env_float("GEMINI_BACKOFF_BASE_S", cls.backoff_base_s),
            backoff_cap_s=_env_float("GEMINI_BACKOFF_CAP_S", cls.backoff_cap_s),
            timeout_s=_env_float("GEMINI_TIMEOUT_S", cls.timeout_s),
            max_output_tokens=int(_env_float("GEMINI_MAX_OUTPUT_TOKENS", cls.max_output_tokens)),
            thinking_budget=int(budget) if budget.lstrip("-").isdigit() else None,
            call_log=os.environ.get("GEMINI_CALL_LOG") or None,
        )


# ---------------------------------------------------------------------------
# Request / reply
# ---------------------------------------------------------------------------

@dataclass
class Request:
    prompt: str
    images: list[tuple[bytes, str]] = field(default_factory=list)  # (bytes, mime)
    purpose: str = "generic"
    json_mode: bool = True


@dataclass
class Reply:
    text: str
    finish_reason: str = "STOP"
    block_reason: str | None = None
    tokens_in: int | None = None  # as reported by the provider
    tokens_out: int | None = None


Transport = Callable[[Request, Settings], Reply]


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------

_RETRY_DELAY_JSON = re.compile(r"retryDelay['\"]?\s*[:=]\s*['\"]?(\d+(?:\.\d+)?)s", re.IGNORECASE)
_RETRY_IN_TEXT = re.compile(r"retry in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(\d+(?:\.\d+)?)s", re.IGNORECASE)


def parse_retry_delay(message: str) -> float | None:
    m = _RETRY_DELAY_JSON.search(message)
    if m:
        return float(m.group(1))
    m = _RETRY_IN_TEXT.search(message)
    if m:
        return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + float(m.group(3))
    return None


def _scrub(message: str, limit: int = 400) -> str:
    """Collapse whitespace, cap the length and remove any API key held in the environment (any provider)."""
    for name, key in os.environ.items():
        if name.endswith("_API_KEY") and len(key) >= 8:
            message = message.replace(key, "***")
    return re.sub(r"\s+", " ", message).strip()[:limit]


def classify_exception(exc: BaseException, settings: Settings | None = None) -> GeminiError:
    """Map any exception raised while calling the API to a typed GeminiError."""
    if isinstance(exc, GeminiError):
        return exc
    settings = settings or Settings()
    message = str(exc)
    code = getattr(exc, "code", None)
    name = type(exc).__name__

    if isinstance(exc, TimeoutError) or "timeout" in name.lower() or "timed out" in message.lower():
        return Timeout(_scrub(message))
    if code == 429 or "RESOURCE_EXHAUSTED" in message:
        delay = parse_retry_delay(message)
        daily = "PerDay" in message or (delay is not None and delay > settings.daily_quota_threshold_s)
        if daily:
            return QuotaExhausted(_scrub(message), retry_after=delay)
        return RateLimited(_scrub(message), retry_after=delay)
    if code in (401, 403) or "API key not valid" in message or "API_KEY_INVALID" in message:
        return AuthError(_scrub(message))
    if isinstance(code, int) and 500 <= code < 600:
        return ServiceError(_scrub(message), retry_after=parse_retry_delay(message))
    if code == 400:
        return BadRequest(_scrub(message))
    if "connect" in name.lower() or "network" in name.lower() or "connection" in message.lower():
        return ServiceError(_scrub(message))
    return GeminiError(f"{name}: {_scrub(message)}")


# ---------------------------------------------------------------------------
# Rate limiter
# ---------------------------------------------------------------------------

class RateLimiter:
    """Keeps at least ``min_interval`` seconds between request starts (thread-safe)."""

    def __init__(self, min_interval: float, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep):
        self.min_interval, self._clock, self._sleep = min_interval, clock, sleep
        self._lock = threading.Lock()
        self._next_start = 0.0

    def wait(self) -> float:
        """Block until a request may start. Returns the seconds slept."""
        with self._lock:
            now = self._clock()
            start = max(now, self._next_start)
            delay = start - now
            if delay > 0:
                self._sleep(delay)
            self._next_start = start + self.min_interval
            return max(delay, 0.0)

    def push_back(self, seconds: float) -> None:
        """The server asked us to wait: do not start another request before then."""
        with self._lock:
            self._next_start = max(self._next_start, self._clock() + seconds)


# ---------------------------------------------------------------------------
# SDK transport
# ---------------------------------------------------------------------------

_sdk_clients: dict[tuple[str, float], Any] = {}


def _sdk_transport(request: Request, settings: Settings) -> Reply:
    try:
        from google import genai
        from google.genai import types
    except ImportError as exc:
        raise ConfigError("The 'google-genai' package is not installed. Run: pip install google-genai") from exc

    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise ConfigError("GEMINI_API_KEY is not set. Add it to your .env file or the environment.")
    cache_key = (key, settings.timeout_s)
    client = _sdk_clients.get(cache_key)
    if client is None:
        client = genai.Client(api_key=key, http_options=types.HttpOptions(timeout=int(settings.timeout_s * 1000)))
        _sdk_clients[cache_key] = client

    config: dict[str, Any] = {"temperature": 0, "seed": 0, "max_output_tokens": settings.max_output_tokens}
    if request.json_mode:
        config["response_mime_type"] = "application/json"
    if settings.thinking_budget is not None:
        config["thinking_config"] = types.ThinkingConfig(thinking_budget=settings.thinking_budget)

    parts: list[Any] = [types.Part.from_bytes(data=data, mime_type=mime) for data, mime in request.images]
    parts.append(request.prompt)
    response = client.models.generate_content(
        model=settings.model, contents=parts, config=types.GenerateContentConfig(**config))

    feedback = getattr(response, "prompt_feedback", None)
    block = getattr(feedback, "block_reason", None)
    candidates = getattr(response, "candidates", None) or []
    finish = getattr(candidates[0], "finish_reason", None) if candidates else None
    usage = getattr(response, "usage_metadata", None)
    out_tokens = (getattr(usage, "candidates_token_count", None) or 0) + (getattr(usage, "thoughts_token_count", None) or 0)
    return Reply(
        text=(getattr(response, "text", None) or "").strip(),
        finish_reason=getattr(finish, "name", str(finish)) if finish is not None else "UNKNOWN",
        block_reason=getattr(block, "name", str(block)) if block is not None else None,
        tokens_in=getattr(usage, "prompt_token_count", None), tokens_out=out_tokens or None,
    )


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

@dataclass
class CallRecord:
    purpose: str
    attempt: int
    status: str  # "ok" or a GeminiError.kind
    seconds: float
    waited_s: float
    error: str | None = None
    finish_reason: str | None = None
    model: str = ""
    tokens_in: int | None = None
    tokens_out: int | None = None
    started_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in self.__dict__.items()}


class GeminiClient:
    """Rate-limited, retrying client. Create one per process and share it."""

    def __init__(self, settings: Settings | None = None, transport: Transport | None = None,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep):
        self.settings = settings or Settings.from_env()
        self.transport = transport or _sdk_transport
        self._sleep = sleep
        self.limiter = RateLimiter(self.settings.min_interval_s, clock, sleep)
        self.calls: list[CallRecord] = []

    def _record(self, rec: CallRecord) -> None:
        self.calls.append(rec)
        if self.settings.call_log:
            try:
                Path(self.settings.call_log).parent.mkdir(parents=True, exist_ok=True)
                with open(self.settings.call_log, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec.to_dict()) + "\n")
            except OSError:
                pass

    def _retry_delay(self, err: GeminiError, attempt: int) -> float:
        s = self.settings
        if err.retry_after is not None:
            return min(err.retry_after + 1.0, s.backoff_cap_s)
        return min(s.backoff_base_s * (2 ** (attempt - 1)), s.backoff_cap_s)

    def generate(self, request: Request) -> str:
        """Return the model's text, or raise a typed GeminiError."""
        attempt = 0
        while True:
            attempt += 1
            waited = self.limiter.wait()
            started = time.monotonic()
            err: GeminiError | None = None
            reply: Reply | None = None
            try:
                reply = self.transport(request, self.settings)
            except Exception as exc:  # noqa: BLE001 - classified below, never swallowed
                err = classify_exception(exc, self.settings)
            if err is None and reply is not None:
                err = self._check_reply(reply)
            elapsed = time.monotonic() - started
            self._record(CallRecord(request.purpose, attempt, "ok" if err is None else err.kind, elapsed, waited,
                                    None if err is None else str(err)[:300],
                                    reply.finish_reason if reply else None, self.settings.model,
                                    reply.tokens_in if reply else None, reply.tokens_out if reply else None))
            if err is None:
                return reply.text  # type: ignore[union-attr]
            if err.retryable and attempt <= self.settings.max_retries:
                delay = self._retry_delay(err, attempt)
                self.limiter.push_back(delay)
                continue
            raise err

    @staticmethod
    def _check_reply(reply: Reply) -> GeminiError | None:
        if reply.block_reason:
            return Blocked(f"prompt blocked: {reply.block_reason}")
        if reply.finish_reason in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY", "RECITATION"):
            return Blocked(f"reply removed by the model: {reply.finish_reason}")
        if reply.finish_reason == "MAX_TOKENS":
            return BadResponse("reply cut off at the output token limit")
        if not reply.text:
            return BadResponse(f"empty reply (finish reason {reply.finish_reason})")
        return None

    def generate_json(self, request: Request) -> Any:
        """Like generate(), and parse the reply as JSON (raising BadResponse if it is not)."""
        return parse_json_reply(self.generate(request))


_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)


def parse_json_reply(text: str) -> Any:
    cleaned = _FENCE.sub("", text.strip())
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as first:
        m = re.search(r"(\{.*\}|\[.*\])", cleaned, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(1))
            except json.JSONDecodeError:
                pass
        raise BadResponse(f"reply is not valid JSON ({first.msg} at char {first.pos})") from first


# ---------------------------------------------------------------------------
# Process-wide default client (replaceable in tests)
# ---------------------------------------------------------------------------

_default: GeminiClient | None = None


def make_client(provider: str | None = None, **overrides: Any) -> GeminiClient:
    """A rate-limited client for ``provider`` ("gemini" or "groq"; default: LLM_PROVIDER, else gemini).

    ``overrides`` set Settings fields, e.g. ``min_interval_s=6``. The class name is historical: it is the
    provider-neutral client (limiter, retries, typed errors, call log); the provider is just its transport.
    """
    provider = (provider or os.environ.get("LLM_PROVIDER", "") or "gemini").strip().lower()
    if provider == "groq":
        from .groq_client import GroqTransport, settings_from_env

        return GeminiClient(settings_from_env(**overrides), transport=GroqTransport())
    if provider == "gemini":
        settings = Settings.from_env()
        for k, v in overrides.items():
            setattr(settings, k, v)
        return GeminiClient(settings)
    raise ConfigError(f"unknown LLM provider {provider!r}; use 'gemini' or 'groq'")


def get_client() -> GeminiClient:
    global _default
    if _default is None:
        _default = make_client()
    return _default


def set_client(client: GeminiClient | None) -> None:
    global _default
    _default = client


def ask(prompt: str, image_bytes: bytes | None = None, mime: str = "image/png") -> str:
    """Convenience wrapper. Raises a typed GeminiError on any failure."""
    images = [(image_bytes, mime)] if image_bytes is not None else []
    return get_client().generate(Request(prompt, images, purpose="ask", json_mode=False))


def ask_json(prompt: str, image_bytes: bytes | None = None, mime: str = "image/png") -> str:
    """Returns the raw JSON text; raises a typed GeminiError on any failure."""
    images = [(image_bytes, mime)] if image_bytes is not None else []
    return get_client().generate(Request(prompt, images, purpose="ask_json", json_mode=True))
