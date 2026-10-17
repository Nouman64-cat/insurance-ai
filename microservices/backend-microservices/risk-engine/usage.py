"""Token metering for the risk engine.

The LangGraph scoring nodes run synchronously, so this posts to
tenant-service's /tokens/usage with a blocking httpx call wrapped in
try/except (a metering outage must never fail a risk assessment).
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

import httpx

log = logging.getLogger("risk-engine.usage")

TENANT_SERVICE_URL = os.environ.get("TENANT_SERVICE_URL", "http://tenant-service:8001")

SERVICE_NAME = "Risk Engine"


def _extract_usage(response: Any) -> Optional[dict[str, int]]:
    """Token counts off a LangChain AIMessage, across providers."""
    meta = getattr(response, "usage_metadata", None) or {}
    if not meta:
        raw = getattr(response, "response_metadata", None) or {}
        meta = raw.get("usage_metadata") or raw.get("token_usage") or {}
    if not meta:
        return None
    inp = int(meta.get("input_tokens") or meta.get("prompt_tokens") or meta.get("prompt_token_count") or 0)
    out = int(meta.get("output_tokens") or meta.get("completion_tokens") or meta.get("candidates_token_count") or 0)
    if not inp and not out:
        return None
    return {
        "input_tokens": inp,
        "output_tokens": out,
        "total_tokens": int(meta.get("total_tokens") or (inp + out)),
    }


def _model_name(response: Any) -> str:
    md = getattr(response, "response_metadata", None) or {}
    return md.get("model_name") or md.get("model") or md.get("model_id") or "unknown"


def record(response: Any, *, tenant_id: Optional[str] = None) -> None:
    """One structured-LLM call's usage. Never raises."""
    usage = _extract_usage(response)
    if usage is None:
        return
    payload = {
        "service_name": SERVICE_NAME,
        "model_name": _model_name(response),
        "tenant_id": tenant_id or None,
        **usage,
    }
    try:
        httpx.post(f"{TENANT_SERVICE_URL}/tokens/usage", json=payload, timeout=3.0)
    except Exception as exc:  # noqa: BLE001 — metering must never break a turn
        log.warning("Token usage not recorded: %s", exc)
