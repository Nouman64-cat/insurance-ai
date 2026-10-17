"""Token metering for the model calls tenant-service makes itself (document reading, rule assist).

The other services post their usage to POST /tokens/usage; this service owns that table, so it writes the row
directly. Like everywhere else, metering is fire-and-forget: a failed write is logged and never fails the call.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional
from uuid import UUID

log = logging.getLogger("tenant-service.usage")

SERVICE_DOCUMENT_READER = "Document Reader"  # OCR area: medical reports and document classification
SERVICE_RULE_ASSIST = "Rule Assist"  # base model area

_pending: set[asyncio.Task] = set()


def usage_from_response(provider: str, body: dict) -> Optional[dict]:
    """Token counts from a raw Gemini / OpenAI / Anthropic response body, or None when it reports none."""
    if provider == "gemini":
        u = body.get("usageMetadata") or {}
        # Thinking tokens are billed as output.
        counts = {"input_tokens": u.get("promptTokenCount") or 0,
                  "output_tokens": (u.get("candidatesTokenCount") or 0) + (u.get("thoughtsTokenCount") or 0),
                  "cached_tokens": u.get("cachedContentTokenCount") or 0}
    elif provider == "openai":
        u = body.get("usage") or {}
        counts = {"input_tokens": u.get("prompt_tokens") or 0, "output_tokens": u.get("completion_tokens") or 0,
                  "cached_tokens": (u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0}
    elif provider == "anthropic":
        u = body.get("usage") or {}
        read = u.get("cache_read_input_tokens") or 0
        counts = {"input_tokens": (u.get("input_tokens") or 0) + read + (u.get("cache_creation_input_tokens") or 0),
                  "output_tokens": u.get("output_tokens") or 0, "cached_tokens": read}
    else:
        return None
    if not counts["input_tokens"] and not counts["output_tokens"]:
        return None
    return {**counts, "total_tokens": counts["input_tokens"] + counts["output_tokens"]}


def model_of(provider: str, body: dict, requested: str) -> str:
    """The model that served the call: OpenAI and Anthropic echo it, Gemini reports modelVersion."""
    return body.get("model") or body.get("modelVersion") or requested


async def _write(row: dict) -> None:
    from database import _session_factory
    from shared.models.core import TokenUsage
    try:
        async with _session_factory() as session:
            session.add(TokenUsage(**row))
            await session.commit()
    except Exception as exc:  # noqa: BLE001 — metering must never break the call it measures
        log.warning("Token usage not recorded: %s", exc)


def record(service_name: str, provider: str, requested_model: str, body: Any,
           tenant_id: Optional[UUID | str] = None) -> None:
    """Schedule a usage row for one provider response. Never awaits, never raises."""
    try:
        counts = usage_from_response(provider, body) if isinstance(body, dict) else None
        if counts is None:
            return
        row = {"service_name": service_name, "model_name": model_of(provider, body, requested_model)[:100],
               "tenant_id": UUID(str(tenant_id)) if tenant_id else None, **counts}
        task = asyncio.get_running_loop().create_task(_write(row))
        _pending.add(task)  # keep a reference until it finishes
        task.add_done_callback(_pending.discard)
    except Exception as exc:  # noqa: BLE001
        log.warning("Token usage not recorded: %s", exc)
