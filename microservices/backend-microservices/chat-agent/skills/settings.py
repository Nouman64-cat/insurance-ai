"""Short-lived cache of database-backed SuperAdmin settings; no env toggle."""
import asyncio
import logging
import os
import time

import httpx

TTL_SECONDS = 5
_value = True  # Same default as a platform that has not saved its settings yet.
_has_remote = False
_at = 0.0
_lock = asyncio.Lock()


def enabled() -> bool:
    return _value


async def _fetch() -> bool:
    url = os.getenv("TENANT_SERVICE_URL", "http://tenant-service:8001")
    secret = os.getenv("INTERNAL_API_SECRET", "").strip()
    async with httpx.AsyncClient(timeout=2.0) as client:
        response = await client.get(url + "/internal/agent-config",
                                    headers={"X-Internal-Secret": secret} if secret else {})
        response.raise_for_status()
        value = response.json()["skill_agent_enabled"]
        if not isinstance(value, bool):
            raise ValueError("Invalid persisted agent setting")
        return value


async def refresh(force: bool = False) -> None:
    global _value, _at, _has_remote
    if not force and time.monotonic() - _at < TTL_SECONDS:
        return
    async with _lock:
        if not force and time.monotonic() - _at < TTL_SECONDS:
            return
        try:
            _value = await _fetch()
            _has_remote = True
        except (httpx.HTTPError, ValueError, KeyError):
            # Keep a saved disabled state during outages. On a cold start with
            # no verified configuration, don't re-enable a disabled platform.
            if not _has_remote:
                _value = False
            logging.getLogger(__name__).warning("Agent settings unavailable; retaining the last verified setting or disabling progressive skills")
        _at = time.monotonic()
