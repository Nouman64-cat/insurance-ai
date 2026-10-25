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
SERVICE_AGENT_COPILOT_EMBEDDINGS = "Agent Copilot (embeddings)"  # the assistant embedding a question to search its knowledge base
SERVICE_KNOWLEDGE_BASE_EMBEDDINGS = "Knowledge Base (embeddings)"  # a form template embedded when it is published

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


def _count_embedding_tokens(model: str, contents: Any) -> Optional[int]:
    """How many tokens an embedding request was billed for. The embedding response carries no usage on the Gemini API, so the count comes from the provider's own
    (free) token counter for the same model and text. None when it cannot be counted: the call is then simply not recorded, never recorded as zero."""
    import os
    from google import genai
    name = model if model.startswith("models/") else f"models/{model}"
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))            # kept in a name: a client used inline is closed before its request is sent
    n = client.models.count_tokens(model=name, contents=contents).total_tokens
    return int(n) if n else None


def record_embedding(service_name: str, model: str, contents: Any, tenant_id: Optional[UUID | str] = None, *, counter: Any = None) -> None:
    """Schedule a usage row for one embedding call (an embedding is an input-only call: its tokens are input tokens). Never awaits, never raises, and never blocks the
    caller: the tokens are counted in a worker thread. A call whose tokens cannot be counted is not recorded."""
    async def _run() -> None:
        try:
            tokens = await asyncio.to_thread(counter or _count_embedding_tokens, model, contents)
            if not tokens:
                return
            await _write({"service_name": service_name, "model_name": model.replace("models/", "")[:100], "tenant_id": UUID(str(tenant_id)) if tenant_id else None,
                          "input_tokens": tokens, "output_tokens": 0, "cached_tokens": 0, "total_tokens": tokens})
        except Exception as exc:  # noqa: BLE001
            log.warning("Embedding usage not recorded: %s", exc)
    try:
        task = asyncio.get_running_loop().create_task(_run())
        _pending.add(task)
        task.add_done_callback(_pending.discard)
    except Exception as exc:  # noqa: BLE001
        log.warning("Embedding usage not recorded: %s", exc)
