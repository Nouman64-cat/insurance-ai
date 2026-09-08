"""Config-driven, multi-provider vision LLM for the OCR engine.

Primary + fallback provider / model / API key come from the SuperAdmin config
in tenant-service (GET /internal/llm-config), cached ~60s, with an env-var
fallback (GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY). Mirrors
services/chat-agent/providers.py.

OCR needs a vision-capable model. Images work on all three providers; **PDFs
work only on Gemini and Anthropic** — OpenAI chat models can't ingest a PDF.
When a PDF is submitted and no PDF-capable provider is configured, we raise
`PdfProviderUnavailable` with a message pointing at the LLM Configuration page
rather than letting a provider fail cryptically.
"""

from __future__ import annotations

import base64
import logging
import os
import time
from typing import Any, Optional

import httpx
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_google_genai import ChatGoogleGenerativeAI

try:
    from langchain_openai import ChatOpenAI
except ImportError:  # pragma: no cover
    ChatOpenAI = None  # type: ignore[assignment, misc]

try:
    from langchain_anthropic import ChatAnthropic
except ImportError:  # pragma: no cover
    ChatAnthropic = None  # type: ignore[assignment, misc]

log = logging.getLogger("ocr-engine.llm")

TENANT_SERVICE_URL = os.environ.get("TENANT_SERVICE_URL", "http://tenant-service:8001")
INTERNAL_API_SECRET = os.environ.get("INTERNAL_API_SECRET", "").strip()

PDF_MIME = "application/pdf"
PDF_CAPABLE = {"gemini", "anthropic"}

_TTL_SECONDS = 60
_cache: dict[str, Any] = {"at": 0.0, "value": None}


class PdfProviderUnavailable(RuntimeError):
    """No configured provider can OCR a PDF (fallback is OpenAI-only)."""


class NoProviderConfigured(RuntimeError):
    """Neither the DB config nor the env vars supply a usable API key."""


# ── Model factory ─────────────────────────────────────────────────────────────

def build_model(entry: dict, *, streaming: bool = False):
    provider = (entry.get("provider") or "").lower()
    model = entry.get("model")
    api_key = entry.get("api_key")
    if not api_key:
        raise NoProviderConfigured(
            f"No API key for the OCR {provider or 'primary'} model — set one in "
            "Platform → LLM Configuration."
        )
    if provider == "gemini":
        return ChatGoogleGenerativeAI(
            model=model, google_api_key=api_key, temperature=0,
            max_retries=0, disable_streaming=not streaming,
        )
    if provider == "openai":
        if ChatOpenAI is None:
            raise RuntimeError("langchain-openai is not installed")
        return ChatOpenAI(
            model=model, api_key=api_key, temperature=0, max_retries=0,
            timeout=60, stream_usage=True,
        )
    if provider == "anthropic":
        if ChatAnthropic is None:
            raise RuntimeError("langchain-anthropic is not installed")
        return ChatAnthropic(
            model=model, api_key=api_key, temperature=0, max_retries=0,
            timeout=60, max_tokens=8000,
        )
    raise RuntimeError(f"unknown LLM provider {provider!r}")


def _content_block(provider: str, file_bytes: bytes, mime_type: str) -> dict:
    """The multimodal content block for one provider."""
    b64 = base64.b64encode(file_bytes).decode()
    if mime_type == PDF_MIME:
        if provider == "gemini":
            return {"type": "media", "mime_type": PDF_MIME, "data": b64}
        if provider == "anthropic":
            return {
                "type": "document",
                "source": {"type": "base64", "media_type": PDF_MIME, "data": b64},
            }
        raise PdfProviderUnavailable(provider)
    # images — the OpenAI-style data URI is accepted by all three providers
    return {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{b64}"}}


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


def provider_chain(cfg: dict, mime_type: str) -> tuple[list[dict], bool]:
    """Ordered [primary, fallback] entries that can handle `mime_type`.

    Returns (chain, dropped_for_pdf) — dropped_for_pdf is True when a
    configured provider was excluded because it can't read PDFs, so a
    downstream failure can be reported as a config problem, not an outage.
    """
    configured = [e for e in (cfg.get("primary"), cfg.get("fallback")) if e and e.get("api_key")]
    if not configured:
        raise NoProviderConfigured(
            "No OCR model is configured. Set a primary provider in "
            "Platform → LLM Configuration."
        )
    if mime_type != PDF_MIME:
        return configured, False

    chain = [e for e in configured if (e.get("provider") or "").lower() in PDF_CAPABLE]
    dropped_for_pdf = len(chain) < len(configured)
    if not chain:
        raise PdfProviderUnavailable(
            "PDF OCR needs a PDF-capable model (Gemini or Anthropic). The "
            "configured OCR provider(s) can't read PDFs — set a Gemini or "
            "Anthropic primary/fallback in Platform → LLM Configuration, "
            "or submit an image instead."
        )
    return chain, dropped_for_pdf


def messages_for(entry: dict, prompt: str, file_bytes: bytes, mime_type: str):
    provider = (entry.get("provider") or "").lower()
    return [
        SystemMessage(content=prompt),
        HumanMessage(content=[_content_block(provider, file_bytes, mime_type)]),
    ]


def usage_of(response: Any) -> dict:
    md = getattr(response, "usage_metadata", None) or {}
    return {
        "input": int(md.get("input_tokens") or 0),
        "output": int(md.get("output_tokens") or 0),
        "total": int(md.get("total_tokens") or 0)
        or int((md.get("input_tokens") or 0) + (md.get("output_tokens") or 0)),
    }


def model_of(response: Any) -> str:
    md = getattr(response, "response_metadata", None) or {}
    return md.get("model_name") or md.get("model") or md.get("model_id") or "unknown"
