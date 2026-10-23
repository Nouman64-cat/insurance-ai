"""Token metering for the chat agent.

The Token Economy page used to see only the OCR engine and the summarizer,
which meant the platform's single largest LLM consumer — this service — was
invisible to it. Every model call now reports here.

Recording is deliberately fire-and-forget: a metering outage must never take
down a live conversation, and the write must never sit on the critical path of
a turn the user is waiting for.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Optional

import httpx

log = logging.getLogger("chat-agent.usage")

TENANT_SERVICE_URL = os.environ.get("TENANT_SERVICE_URL", "http://tenant-service:8001")

# Keep these stable — they are the series names on the Token Economy chart.
SERVICE_CHAT_AGENT = "Chat Agent"
SERVICE_COMMISSION_SPECIALIST = "Chat Agent — Commission Specialist"
SERVICE_GROUP_SPECIALIST = "Chat Agent — Group Insurance Specialist"
SERVICE_SERVICING_SPECIALIST = "Chat Agent — Policy Servicing Specialist"
SERVICE_UNDERWRITING_SPECIALIST = "Chat Agent — Underwriting Specialist"
SERVICE_FINANCE_SPECIALIST = "Chat Agent — Finance Specialist"
SERVICE_CLAIMS_SPECIALIST = "Chat Agent — Claims Specialist"
SERVICE_MEDICAL_UNDERWRITING_SPECIALIST = "Chat Agent — Medical Underwriting Specialist"
SERVICE_FINANCIAL_UNDERWRITING_SPECIALIST = "Chat Agent — Financial Underwriting Specialist"
SERVICE_FINAL_UNDERWRITING_SPECIALIST = "Chat Agent — Final Underwriting Specialist"
SERVICE_PLAN_ADVISOR = "Chat Agent — Plan Advisor"
SERVICE_CHAT_TITLE = "Chat Agent — Title Generator"
# Live conversation area (tenant-service routers/tokens.py LIVE_VOICE_SERVICES lists the same names).
SERVICE_LIVE_VOICE = "Live Voice"  # the realtime model: listening, thinking, speaking
SERVICE_LIVE_VOICE_CAPTIONS = "Live Voice — Captions"  # transcription of what the user says during a call
SERVICE_VOICE_MESSAGES = "Voice Messages"  # recorded voice messages turned into chat text


def model_from_response(response: Any) -> Optional[str]:
    """The model id a provider actually served this call with.

    Providers hang it in different places: Gemini/OpenAI use
    response_metadata["model_name"] (OpenAI's is date-suffixed, e.g.
    "gpt-4o-mini-2024-07-18"), Anthropic uses response_metadata["model"].
    """
    md = getattr(response, "response_metadata", None) or {}
    return md.get("model_name") or md.get("model") or md.get("model_id")


def extract_usage(response: Any) -> Optional[dict[str, int]]:
    """Pull token counts off a LangChain AIMessage.

    Providers disagree on where they hang this and on what they call the
    fields, so check the normalised place first and fall back to the raw
    provider metadata. Returns None when nothing usable is present, which is
    the signal not to record a row at all — a zero row would understate real
    spend rather than flag the gap.
    """
    meta = getattr(response, "usage_metadata", None) or {}
    if not meta:
        raw = getattr(response, "response_metadata", None) or {}
        meta = raw.get("usage_metadata") or raw.get("token_usage") or {}
    if not meta:
        return None

    input_tokens = int(
        meta.get("input_tokens")
        or meta.get("prompt_tokens")
        or meta.get("prompt_token_count")
        or 0
    )
    output_tokens = int(
        meta.get("output_tokens")
        or meta.get("completion_tokens")
        or meta.get("candidates_token_count")
        or 0
    )
    if not input_tokens and not output_tokens:
        return None

    # Gemini reports implicit cache hits nested under input_token_details.
    details = meta.get("input_token_details") or {}
    cached = int(
        details.get("cache_read")
        or meta.get("cached_content_token_count")
        or meta.get("cached_tokens")
        or 0
    )

    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": int(meta.get("total_tokens") or (input_tokens + output_tokens)),
        "cached_tokens": cached,
    }


async def _post(payload: dict) -> None:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(f"{TENANT_SERVICE_URL}/tokens/usage", json=payload,
                              headers={"X-Internal-Secret": os.environ.get("INTERNAL_API_SECRET", "")})   # the ledger accepts only internal callers
    except Exception as exc:  # noqa: BLE001 — metering must never break a turn
        log.warning("Token usage not recorded: %s", exc)


def record(
    response: Any,
    *,
    service_name: str = SERVICE_CHAT_AGENT,
    tenant_id: Optional[str] = None,
    thread_id: Optional[str] = None,
    model_name: Optional[str] = None,
) -> None:
    """Schedule a usage row for one model call. Never awaits, never raises."""
    usage = extract_usage(response)
    if usage is None:
        log.debug("No usage metadata on response from %s — nothing recorded", service_name)
        return

    payload = {
        "service_name": service_name,
        "model_name": model_name or model_from_response(response) or "unknown",
        "tenant_id": tenant_id or None,
        "thread_id": thread_id,
        **usage,
    }
    try:
        asyncio.get_running_loop().create_task(_post(payload))
    except RuntimeError:
        # No loop (sync context) — drop rather than block.
        log.debug("No running loop; usage row dropped")


def realtime_usage(usage: dict) -> Optional[dict]:
    """Counts from a Realtime `response.done` usage block, with the audio share split out (audio is billed at
    several times the text rate)."""
    if not usage:
        return None
    inp = usage.get("input_token_details") or {}
    out = usage.get("output_token_details") or {}
    cached = inp.get("cached_tokens_details") or {}
    counts = {
        "input_tokens": int(usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
        "cached_tokens": int(inp.get("cached_tokens") or 0),
        "audio_input_tokens": int(inp.get("audio_tokens") or 0),
        "audio_output_tokens": int(out.get("audio_tokens") or 0),
        "audio_cached_tokens": int(cached.get("audio_tokens") or 0),
    }
    if not counts["input_tokens"] and not counts["output_tokens"]:
        return None
    return {**counts, "total_tokens": int(usage.get("total_tokens") or counts["input_tokens"] + counts["output_tokens"])}


def transcription_usage(usage: dict) -> Optional[dict]:
    """Counts from a transcription usage block: token-billed models report tokens, per-minute ones report seconds."""
    if not usage:
        return None
    if usage.get("type") == "duration":
        seconds = float(usage.get("seconds") or 0)
        return {"audio_seconds": seconds} if seconds else None
    inp = usage.get("input_token_details") or {}
    counts = {
        "input_tokens": int(usage.get("input_tokens") or 0),
        "output_tokens": int(usage.get("output_tokens") or 0),
        "audio_input_tokens": int(inp.get("audio_tokens") or 0),
    }
    if not counts["input_tokens"] and not counts["output_tokens"]:
        return None
    return {**counts, "total_tokens": int(usage.get("total_tokens") or counts["input_tokens"] + counts["output_tokens"])}


def record_counts(counts: Optional[dict], *, service_name: str, model_name: str,
                  tenant_id: Optional[str] = None, thread_id: Optional[str] = None) -> None:
    """Schedule a usage row from already-extracted counts (live voice). Never awaits, never raises."""
    if not counts:
        return
    payload = {"service_name": service_name, "model_name": model_name or "unknown", "tenant_id": tenant_id or None,
               "thread_id": thread_id, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0, **counts}
    try:
        task = asyncio.get_running_loop().create_task(_post(payload))
        _pending.add(task)
        task.add_done_callback(_pending.discard)
    except RuntimeError:
        log.debug("No running loop; usage row dropped")


_pending: set = set()
