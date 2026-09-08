"""Shared LLM factory for the risk engine.

The primary and fallback provider / model / API key come from the SuperAdmin
config in tenant-service (GET /internal/llm-config), cached here for ~60s.
When that config is absent or unreachable we fall back to the env vars
(GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY), so behaviour is
unchanged for a deployment that never opens the SuperAdmin screen.

    structured_llm(schema)  -> a structured-output runnable that fails over
                               primary -> fallback on any error.

The risk-engine graph nodes run synchronously, so config resolution here uses
a blocking httpx client (not async).
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

log = logging.getLogger("risk-engine.llm")

TENANT_SERVICE_URL = os.environ.get("TENANT_SERVICE_URL", "http://tenant-service:8001")
INTERNAL_API_SECRET = os.environ.get("INTERNAL_API_SECRET", "").strip()

_TTL_SECONDS = 60
_cache: dict[str, Any] = {"at": 0.0, "value": None}


def _build(entry: dict):
    provider = (entry.get("provider") or "").lower()
    model = entry.get("model")
    api_key = entry.get("api_key")
    if provider == "gemini":
        return ChatGoogleGenerativeAI(model=model, google_api_key=api_key, temperature=0.1)
    if provider == "openai":
        if ChatOpenAI is None:
            raise RuntimeError("langchain-openai is not installed")
        return ChatOpenAI(model=model, api_key=api_key, temperature=0.1, timeout=40)
    if provider == "anthropic":
        if ChatAnthropic is None:
            raise RuntimeError("langchain-anthropic is not installed")
        return ChatAnthropic(model=model, api_key=api_key, temperature=0.1, timeout=40, max_tokens=4096)
    raise RuntimeError(f"unknown LLM provider {provider!r}")


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


def _fetch_remote() -> Optional[dict]:
    headers = {"X-Internal-Secret": INTERNAL_API_SECRET} if INTERNAL_API_SECRET else {}
    try:
        r = httpx.get(f"{TENANT_SERVICE_URL}/internal/llm-config", headers=headers, timeout=4.0)
        r.raise_for_status()
        data = r.json()
    except Exception as exc:  # noqa: BLE001 — any failure => env
        log.warning("LLM config fetch failed (%s); using env vars", exc)
        return None
    if not data.get("primary") or not data["primary"].get("api_key"):
        return None
    return data


def _resolve() -> dict:
    now = time.time()
    cached = _cache["value"]
    if cached is not None and now - _cache["at"] < _TTL_SECONDS:
        return cached
    value = _fetch_remote() or _env_config()
    _cache["value"] = value
    _cache["at"] = now
    return value


def structured_llm(schema: Any):
    """Structured-output runnable, primary + fallback.

    Uses include_raw=True so callers get {"raw", "parsed", "parsing_error"} —
    `parsed` is the pydantic object, `raw` is the AIMessage carrying
    usage_metadata for token metering (see usage.record).
    """
    cfg = _resolve()
    primary = _build(cfg["primary"]).with_structured_output(schema, include_raw=True)
    if cfg.get("fallback"):
        fb = _build(cfg["fallback"]).with_structured_output(schema, include_raw=True)
        return primary.with_fallbacks([fb])
    return primary
