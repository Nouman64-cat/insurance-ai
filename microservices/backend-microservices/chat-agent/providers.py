"""Runtime LLM provider resolution for the chat agent.

The primary and fallback provider / model / API key come from the SuperAdmin
config in tenant-service (GET /internal/llm-config), cached here for ~60s.
When that config is absent, empty, or unreachable we fall back to the classic
env vars — so a deployment that never opens the SuperAdmin screen behaves
exactly as before.

    resolve()                 -> {"version", "primary": {...}, "fallback": {...}|None}
    build_chat(entry, **kw)   -> a LangChain chat model for one {provider,model,api_key}
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import re
import time
from typing import Any, Optional

import httpx
from langchain_google_genai import ChatGoogleGenerativeAI

try:
    from langchain_openai import ChatOpenAI
except ImportError:  # pragma: no cover
    ChatOpenAI = None  # type: ignore[assignment, misc]

try:
    from langchain_anthropic import ChatAnthropic
except ImportError:  # pragma: no cover
    ChatAnthropic = None  # type: ignore[assignment, misc]

log = logging.getLogger("chat-agent.providers")

TENANT_SERVICE_URL = os.environ.get("TENANT_SERVICE_URL", "http://tenant-service:8001")
INTERNAL_API_SECRET = os.environ.get("INTERNAL_API_SECRET", "").strip()

_TTL_SECONDS = 60
_cache: dict[str, Any] = {"at": 0.0, "value": None}

# ── Evaluation only ──────────────────────────────────────────────────────────────────────────────────────────────────
# The evaluation stack (EVAL_ENVIRONMENT=1) chooses the model of ONE request through a header (see routers/chat.py), so a benchmark
# can switch models per conversation without the 60 s config cache and without touching the platform's SuperAdmin configuration.
# Outside the evaluation stack the variable is unset, `eval_override` is never set, and nothing here changes anything.
_EVAL_KEYS = {"openai": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY", "anthropic": "ANTHROPIC_API_KEY"}
eval_override: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("eval_model_override", default=None)
# A prompt variant for ONE request, to compare prompt versions: {"version", "mode": append|prepend|replace, "text"}. Read from
# EVAL_PROMPT_DIR/<version>.json (mounted from evals/prompts in the evaluation stack); never set outside it.
eval_prompt: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("eval_prompt_variant", default=None)
EVAL_PROMPT_DIR = os.environ.get("EVAL_PROMPT_DIR", "/eval-prompts")
_PROMPT_MODES = ("append", "prepend", "replace")


def load_prompt_variant(version: str) -> dict:
    """The prompt variant named `version`. The name is a file name in EVAL_PROMPT_DIR (letters, digits, dot, dash, underscore only)."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,60}", version or ""):
        raise RuntimeError(f"{version!r} is not a valid prompt version name")
    path = os.path.join(EVAL_PROMPT_DIR, f"{version}.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"prompt version {version!r} cannot be read: {exc}") from exc
    if data.get("mode") not in _PROMPT_MODES or not isinstance(data.get("text"), str) or not data["text"].strip():
        raise RuntimeError(f"prompt version {version!r} needs a mode ({', '.join(_PROMPT_MODES)}) and a non-empty text")
    return {"version": version, "mode": data["mode"], "text": data["text"]}


_variant_classes: dict = {}


def _with_prompt_variant(model, variant: dict):
    """The same chat model, but every request it sends has its system prompt changed as the variant says. The model class is wrapped
    (not the call sites), so the base agent and every specialist are covered without touching their prompts."""
    from langchain_core.messages import SystemMessage

    def rewrite(messages):
        out = list(messages)
        for i, m in enumerate(out):
            if getattr(m, "type", None) == "system":
                text = m.content if isinstance(m.content, str) else str(m.content)
                new = variant["text"] if variant["mode"] == "replace" else (text + "\n\n" + variant["text"] if variant["mode"] == "append" else variant["text"] + "\n\n" + text)
                out[i] = SystemMessage(content=new)
                break
        else:
            out.insert(0, SystemMessage(content=variant["text"]))
        return out

    base = type(model)
    key = (base, variant["version"], variant["mode"], hash(variant["text"]))
    cls = _variant_classes.get(key)
    if cls is None:
        class Variant(base):                                                   # type: ignore[misc, valid-type]
            def _generate(self, messages, *a, **k):
                return super()._generate(rewrite(messages), *a, **k)

            async def _agenerate(self, messages, *a, **k):
                return await super()._agenerate(rewrite(messages), *a, **k)

            def _stream(self, messages, *a, **k):
                yield from super()._stream(rewrite(messages), *a, **k)

            async def _astream(self, messages, *a, **k):
                async for chunk in super()._astream(rewrite(messages), *a, **k):
                    yield chunk
        cls = _variant_classes[key] = Variant
    model.__class__ = cls
    return model


def eval_entry(spec: str) -> dict:
    """"openai/gpt-4o-mini" -> a provider entry. A model whose name starts with `mock-` is the scripted stand-in (never a real
    provider): it is reached through the OpenAI client at EVAL_MOCK_LLM_URL. Any other model needs its provider's key in the
    environment; without one the request fails here instead of reaching a provider."""
    provider, _, model = spec.partition("/")
    provider = provider.lower()
    if model.startswith("mock-"):
        url = os.environ.get("EVAL_MOCK_LLM_URL", "")
        if not url:
            raise RuntimeError("EVAL_MOCK_LLM_URL is not set: the scripted model is not available in this stack")
        return {"provider": "openai", "model": model, "api_key": "mock-key", "base_url": url}
    key = (os.environ.get(_EVAL_KEYS.get(provider, ""), "") or "").strip()
    if not key:
        raise RuntimeError(f"no {provider} key in this evaluation stack: the model {spec!r} cannot be called")
    return {"provider": provider, "model": model, "api_key": key}


# ── Model factory ─────────────────────────────────────────────────────────────

def build_chat(entry: dict, *, max_tokens: int = 2048, **kw):
    """One chat model from {"provider", "model", "api_key"}, with the evaluation prompt variant applied when a request sets one."""
    model = _build_chat(entry, max_tokens=max_tokens, **kw)
    variant = eval_prompt.get()
    return _with_prompt_variant(model, variant) if variant is not None else model


def _build_chat(entry: dict, *, max_tokens: int = 2048, **kw):
    """One chat model from {"provider", "model", "api_key"}.

    `max_tokens` is normalised to each SDK's own parameter name. `max_retries`
    is forced to 0 — agent_node owns the only retry loop.
    """
    kw.setdefault("streaming", True)
    if entry.get("base_url"):
        kw["base_url"] = entry["base_url"]                      # the evaluation stack's scripted model
    provider = (entry.get("provider") or "").lower()
    model = entry.get("model")
    api_key = entry.get("api_key")

    if provider == "gemini":
        return ChatGoogleGenerativeAI(
            model=model,
            google_api_key=api_key,
            temperature=0.1,
            max_output_tokens=max_tokens,
            max_retries=0,
            **kw,
        )
    if provider == "openai":
        if ChatOpenAI is None:
            raise RuntimeError("langchain-openai is not installed")
        return ChatOpenAI(
            model=model,
            api_key=api_key,
            max_tokens=max_tokens,
            max_retries=0,
            timeout=40,
            **kw,
        )
    if provider == "anthropic":
        if ChatAnthropic is None:
            raise RuntimeError("langchain-anthropic is not installed")
        return ChatAnthropic(
            model=model,
            api_key=api_key,
            max_tokens=max_tokens,
            max_retries=0,
            timeout=40,
            **kw,
        )
    raise RuntimeError(f"unknown LLM provider {provider!r}")


# ── Config resolution ─────────────────────────────────────────────────────────

def _env_config() -> dict:
    primary = {
        "provider": "gemini",
        "model": os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
        "api_key": os.getenv("GEMINI_API_KEY"),
    }
    fallback = None
    if os.getenv("OPENAI_API_KEY"):
        fallback = {
            "provider": "openai",
            "model": os.getenv("OPENAI_FALLBACK_MODEL", "gpt-4o-mini"),
            "api_key": os.getenv("OPENAI_API_KEY"),
        }
    elif os.getenv("ANTHROPIC_API_KEY"):
        fallback = {
            "provider": "anthropic",
            "model": os.getenv("ANTHROPIC_FALLBACK_MODEL", "claude-sonnet-4-5"),
            "api_key": os.getenv("ANTHROPIC_API_KEY"),
        }
    return {"version": "env", "primary": primary, "fallback": fallback}


async def _fetch_remote() -> Optional[dict]:
    headers = {"X-Internal-Secret": INTERNAL_API_SECRET} if INTERNAL_API_SECRET else {}
    try:
        async with httpx.AsyncClient(timeout=4.0) as c:
            r = await c.get(f"{TENANT_SERVICE_URL}/internal/llm-config", headers=headers)
            r.raise_for_status()
            data = r.json()
    except Exception as exc:  # noqa: BLE001 — any failure => use env
        log.warning("LLM config fetch failed (%s); using env vars", exc)
        return None
    if not data.get("primary") or not data["primary"].get("api_key"):
        # SuperAdmin hasn't set a primary yet — env is the source of truth for chat; a live voice choice still applies.
        return {**_env_config(), "live_voice": data["live_voice"]} if data.get("live_voice") else None
    return data


async def resolve() -> dict:
    """Current provider config. Cached ~60s; never raises."""
    override = eval_override.get()
    variant = eval_prompt.get()
    # The agent keeps tool-bound models per config version, so a prompt variant is part of the version: without it a cached model
    # built for another prompt would be reused.
    suffix = f"+prompt:{variant['version']}" if variant is not None else ""
    if override is not None:
        return {"version": f"eval:{override['spec']}{suffix}", "primary": eval_entry(override["spec"]), "fallback": None}
    value = await _resolve_platform()
    return {**value, "version": f"{value['version']}{suffix}"} if suffix else value


async def _resolve_platform() -> dict:
    now = time.time()
    cached = _cache["value"]
    if cached is not None and now - _cache["at"] < _TTL_SECONDS:
        return cached

    remote = await _fetch_remote()
    value = remote or _env_config()
    _cache["value"] = value
    _cache["at"] = now
    return value


def invalidate() -> None:
    _cache["at"] = 0.0
    _cache["value"] = None
