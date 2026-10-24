"""Private tenant-service integration. Never forwards keys or accepts public policy writes."""
import logging
import os
import threading
import time
from uuid import uuid4

import httpx
from fastapi import HTTPException

log = logging.getLogger(__name__)
_lock = threading.Lock()
_cache = None
_expires = 0.0


def headers():
    return {"X-Internal-Secret": os.getenv("INTERNAL_API_SECRET", "").strip()}


def configuration():
    global _cache, _expires
    url = os.getenv("TENANT_SERVICE_URL", "").rstrip("/")
    if not url:
        return None  # Standalone CLI/test deployment retains the packaged reference policy.
    with _lock:
        if _cache is not None and time.monotonic() < _expires:
            return _cache
        try:
            response = httpx.get(url + "/internal/document-forgery/config", headers=headers(), timeout=3)
            response.raise_for_status()
            value = response.json()
            settings = value["settings"]
            if not 0 <= settings["t95"] <= settings["tmax"] <= 1 or not 1 <= settings["max_pages"] <= 40:
                raise ValueError("invalid platform configuration")
            _cache, _expires = value, time.monotonic() + 5
            return value
        except Exception as exc:
            log.warning("Forgery policy unavailable: %s", type(exc).__name__)
            # Never silently bypass a platform disable/page limit with a stale policy.
            raise HTTPException(503, "Document Forgery Detection configuration is unavailable. Try again shortly.") from exc


def record_usage(analysis, client, config, tenant_id=None):
    url = os.getenv("TENANT_SERVICE_URL", "").rstrip("/")
    if not url or config is None:
        return
    settings = config["settings"]
    provider = settings["provider"]
    calls = getattr(client, "calls", []) if client else []
    perf = analysis.performance or {}
    body = {"id": str(uuid4()), "tenant_id": tenant_id, "models": [
        {"model": c.model, "input_tokens": c.tokens_in, "output_tokens": c.tokens_out,
         "input_rate": settings.get(provider + "_input_per_million"),
         "output_rate": settings.get(provider + "_output_per_million")}
        for c in calls if c.status == "ok" or c.tokens_in is not None or c.tokens_out is not None],
        "pixel_pages": perf.get("pixel_pages_scored", 0),
        "pixel_seconds": perf.get("pixel_inference_seconds", 0),
        "pixel_rate": settings.get("pixel_per_hour"), "complete": perf.get("complete", False),
        "config_revision": config.get("updated_at")}
    for attempt in range(2):
        try:
            response = httpx.post(url + "/internal/document-forgery/usage", headers=headers(), json=body, timeout=3)
            response.raise_for_status()
            return
        except Exception as exc:
            if attempt:
                log.error("Forgery usage not recorded (analysis %s): %s", body["id"], type(exc).__name__)
