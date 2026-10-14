"""Ask the platform's configured vision LLM a JSON question about document files.

Providers come from Platform → LLM Configuration (primary, then fallback) and
are called over plain HTTP — the same endpoints the configuration page's live
key check uses — so no provider SDK has to be installed in this service.
"""
import base64
import json
import logging
import os
import re

import httpx
from sqlmodel.ext.asyncio.session import AsyncSession

log = logging.getLogger("tenant-service.report-llm")

LLM_TIMEOUT_SECONDS = float(os.getenv("MEDICAL_REPORT_LLM_TIMEOUT_SECONDS", "60"))
# Formats every supported vision provider accepts.
MODEL_READABLE = {"application/pdf", "image/jpeg", "image/png"}


def _parts(provider: str, files: list[tuple[bytes, str]]) -> list[dict]:
    parts = []
    for index, (data, mime) in enumerate(files):
        b64 = base64.b64encode(data).decode()
        if provider == "gemini":
            parts.append({"inline_data": {"mime_type": mime, "data": b64}})
        elif provider == "openai":
            parts.append({"type": "file", "file": {"filename": f"report-{index + 1}.pdf", "file_data": f"data:{mime};base64,{b64}"}}
                         if mime == "application/pdf" else {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
        else:
            parts.append({"type": "document" if mime == "application/pdf" else "image",
                          "source": {"type": "base64", "media_type": mime, "data": b64}})
    return parts


def _request(provider: str, model: str, api_key: str, files: list[tuple[bytes, str]], prompt: str) -> dict:
    parts = _parts(provider, files)
    if provider == "gemini":
        return {"url": f"https://generativelanguage.googleapis.com/v1beta/models/{model.removeprefix('models/')}:generateContent",
                "params": {"key": api_key},
                "json": {"contents": [{"parts": [*parts, {"text": prompt}]}],
                         "generationConfig": {"temperature": 0, "responseMimeType": "application/json"}}}
    if provider == "openai":
        return {"url": "https://api.openai.com/v1/chat/completions", "headers": {"Authorization": f"Bearer {api_key}"},
                "json": {"model": model, "temperature": 0, "response_format": {"type": "json_object"},
                         "messages": [{"role": "user", "content": [*parts, {"type": "text", "text": prompt}]}]}}
    if provider == "anthropic":
        return {"url": "https://api.anthropic.com/v1/messages",
                "headers": {"x-api-key": api_key, "anthropic-version": "2023-06-01"},
                "json": {"model": model, "max_tokens": 1024,
                         "messages": [{"role": "user", "content": [*parts, {"type": "text", "text": prompt}]}]}}
    raise ValueError(f"unknown provider {provider!r}")


def _json(reply: str) -> dict:
    match = re.search(r"\{.*\}", reply, re.S)  # tolerate prose or code fences around the JSON
    if not match:
        raise ValueError("model reply had no JSON object")
    return json.loads(match.group(0))


async def ask_json(session: AsyncSession | None, files: list[tuple[bytes, str]], prompt: str, label: str,
                   providers: list[dict] | None = None) -> dict | None:
    """The model's JSON answer, or None when no provider could read the files
    (unsupported format, no key configured, every provider failing). Pass
    `providers` (from resolved_providers) when calling concurrently, so the
    shared session is not used from several tasks at once."""
    from routers.llm_config import _extract_reply, resolved_providers
    if not files or any(mime not in MODEL_READABLE for _, mime in files):
        return None
    for entry in providers if providers is not None else await resolved_providers(session):
        provider = entry["provider"]
        try:
            req = _request(provider, entry["model"], entry["api_key"], files, prompt)
            async with httpx.AsyncClient(timeout=LLM_TIMEOUT_SECONDS) as client:
                response = await client.post(req["url"], params=req.get("params"), headers=req.get("headers"), json=req["json"])
            response.raise_for_status()
            return _json(_extract_reply(provider, response.json()))
        except Exception as exc:
            log.warning("LLM request via %s failed for %s: %s", provider, label, exc)
    return None
