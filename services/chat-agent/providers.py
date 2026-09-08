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

import logging
import os
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


# ── Model factory ─────────────────────────────────────────────────────────────

def build_chat(entry: dict, *, max_tokens: int = 2048, **kw):
    """One chat model from {"provider", "model", "api_key"}.

    `max_tokens` is normalised to each SDK's own parameter name. `max_retries`
    is forced to 0 — agent_node owns the only retry loop.
    """
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
            temperature=0.1,
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
            temperature=0.1,
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
        # SuperAdmin hasn't set a primary yet — env is the source of truth.
        return None
    return data


async def resolve() -> dict:
    """Current provider config. Cached ~60s; never raises."""
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
