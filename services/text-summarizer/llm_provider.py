"""Config-driven, multi-provider text LLM for the summarizer.

Primary + fallback provider / model / API key come from the SuperAdmin config
in tenant-service (GET /internal/llm-config), cached ~60s, with an env-var
fallback. Text-only — mirrors services/chat-agent/providers.py without the
vision/PDF handling that services/ocr-engine/llm_provider.py adds.

    await run(prompt)            -> {"text", "usage": {input,output,total}, "model_name"}
    async for ev in stream(p):   -> {"type": "chunk"|"done"|"error", ...}
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Optional

import httpx
from langchain_core.messages import HumanMessage
from langchain_google_genai import ChatGoogleGenerativeAI

try:
    from langchain_openai import ChatOpenAI
except ImportError:  # pragma: no cover
    ChatOpenAI = None  # type: ignore[assignment, misc]

try:
    from langchain_anthropic import ChatAnthropic
except ImportError:  # pragma: no cover
    ChatAnthropic = None  # type: ignore[assignment, misc]

log = logging.getLogger("text-summarizer.llm")

TENANT_SERVICE_URL = os.environ.get("TENANT_SERVICE_URL", "http://tenant-service:8001")
INTERNAL_API_SECRET = os.environ.get("INTERNAL_API_SECRET", "").strip()

_TTL_SECONDS = 60
_cache: dict[str, Any] = {"at": 0.0, "value": None}


class NoProviderConfigured(RuntimeError):
    """Neither the DB config nor the env vars supply a usable API key."""


def build_model(entry: dict, *, streaming: bool = False):
    provider = (entry.get("provider") or "").lower()
    model = entry.get("model")
    api_key = entry.get("api_key")
    if not api_key:
        raise NoProviderConfigured(
            f"No API key for the {provider or 'primary'} model — set one in "
            "Platform → LLM Configuration."
        )
    if provider == "gemini":
        return ChatGoogleGenerativeAI(
            model=model, google_api_key=api_key, temperature=0.2,
            max_retries=0, disable_streaming=not streaming,
        )
    if provider == "openai":
        if ChatOpenAI is None:
            raise RuntimeError("langchain-openai is not installed")
        return ChatOpenAI(
            model=model, api_key=api_key, temperature=0.2, max_retries=0,
            timeout=60, stream_usage=True,
        )
    if provider == "anthropic":
        if ChatAnthropic is None:
            raise RuntimeError("langchain-anthropic is not installed")
        return ChatAnthropic(
            model=model, api_key=api_key, temperature=0.2, max_retries=0,
            timeout=60, max_tokens=8000,
        )
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


async def _fetch_remote() -> Optional[dict]:
    headers = {"X-Internal-Secret": INTERNAL_API_SECRET} if INTERNAL_API_SECRET else {}
    try:
        async with httpx.AsyncClient(timeout=4.0) as c:
            r = await c.get(f"{TENANT_SERVICE_URL}/internal/llm-config", headers=headers)
            r.raise_for_status()
            data = r.json()
    except Exception as exc:  # noqa: BLE001
        log.warning("LLM config fetch failed (%s); using env vars", exc)
        return None
    if not data.get("primary") or not data["primary"].get("api_key"):
        return None
    return data


async def resolve() -> dict:
    now = time.time()
    cached = _cache["value"]
    if cached is not None and now - _cache["at"] < _TTL_SECONDS:
        return cached
    value = (await _fetch_remote()) or _env_config()
    _cache["value"] = value
    _cache["at"] = now
    return value


def _chain(cfg: dict) -> list[dict]:
    chain = [e for e in (cfg.get("primary"), cfg.get("fallback")) if e and e.get("api_key")]
    if not chain:
        raise NoProviderConfigured(
            "No summarizer model is configured. Set a primary provider in "
            "Platform → LLM Configuration."
        )
    return chain


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if isinstance(b, dict))
    return str(content or "")


def _usage_of(response: Any) -> dict:
    md = getattr(response, "usage_metadata", None) or {}
    i, o = int(md.get("input_tokens") or 0), int(md.get("output_tokens") or 0)
    return {"input": i, "output": o, "total": int(md.get("total_tokens") or 0) or (i + o)}


def _model_of(response: Any) -> str:
    md = getattr(response, "response_metadata", None) or {}
    return md.get("model_name") or md.get("model") or md.get("model_id") or "unknown"


async def run(prompt: str) -> dict:
    """Primary → fallback. Raises on total failure."""
    cfg = await resolve()
    last_exc: Exception | None = None
    for entry in _chain(cfg):
        try:
            model = build_model(entry)
            resp = await model.ainvoke([HumanMessage(content=prompt)])
            text = _text_of(resp.content)
            if not text.strip():
                raise ValueError("empty response")
            return {"text": text, "usage": _usage_of(resp), "model_name": _model_of(resp)}
        except NoProviderConfigured:
            raise
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            log.warning("summarize via %s failed: %s", entry.get("provider"), exc)
    raise RuntimeError(f"All summarizer providers failed. Last error: {last_exc}")


async def stream(prompt: str):
    """Yields {'type': 'chunk'|'done'|'error', ...} SSE payload dicts."""
    try:
        cfg = await resolve()
        chain = _chain(cfg)
    except NoProviderConfigured as exc:
        yield {"type": "error", "message": str(exc)}
        return

    last_exc: Exception | None = None
    for idx, entry in enumerate(chain):
        try:
            model = build_model(entry, streaming=True)
            final = None
            async for chunk in model.astream([HumanMessage(content=prompt)]):
                t = _text_of(chunk.content)
                if t:
                    yield {"type": "chunk", "text": t}
                final = chunk if final is None else (final + chunk)
            usage = _usage_of(final)
            yield {"type": "done", "token_usage": usage, "model_name": _model_of(final)}
            return
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            log.warning("summarize stream via %s failed: %s", entry.get("provider"), exc)
            if idx == len(chain) - 1:
                yield {"type": "error", "message": str(last_exc)}
