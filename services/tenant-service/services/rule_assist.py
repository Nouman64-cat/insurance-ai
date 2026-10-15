"""AI help for rule authors: turn a plain-language prompt into a keyword list.

Used by the rule editor's "Generate with AI" box, e.g. "occupations with a high
accidental-death risk in Pakistan" → ["miner", "pilot", "security guard", …].
The list is only a suggestion: the author reviews it and it is saved into a
rule version, which still has to be published. Providers come from Platform →
LLM Configuration (primary, then fallback), called over plain HTTP like
services/report_llm.py.
"""
import json
import logging
import os
import re

import httpx
from sqlmodel.ext.asyncio.session import AsyncSession

log = logging.getLogger("tenant-service.rule-assist")

TIMEOUT_SECONDS = float(os.getenv("RULE_ASSIST_LLM_TIMEOUT_SECONDS", "45"))
MAX_VALUES = 80


def _request(provider: str, model: str, api_key: str, prompt: str) -> dict:
    if provider == "gemini":
        return {"url": f"https://generativelanguage.googleapis.com/v1beta/models/{model.removeprefix('models/')}:generateContent",
                "params": {"key": api_key},
                "json": {"contents": [{"parts": [{"text": prompt}]}],
                         "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"}}}
    if provider == "openai":
        return {"url": "https://api.openai.com/v1/chat/completions", "headers": {"Authorization": f"Bearer {api_key}"},
                "json": {"model": model, "temperature": 0.2, "response_format": {"type": "json_object"},
                         "messages": [{"role": "user", "content": prompt}]}}
    if provider == "anthropic":
        return {"url": "https://api.anthropic.com/v1/messages",
                "headers": {"x-api-key": api_key, "anthropic-version": "2023-06-01"},
                "json": {"model": model, "max_tokens": 2048, "messages": [{"role": "user", "content": prompt}]}}
    raise ValueError(f"unknown provider {provider!r}")


def _instructions(field_label: str, request: str, existing: list[str]) -> str:
    return (
        "You help an insurance underwriter configure a rule in a life-insurance rule engine (Pakistan market).\n"
        f"The rule checks whether the applicant's free-text '{field_label}' CONTAINS any keyword from a list "
        "(case-insensitive substring match).\n"
        f"The underwriter's request: {request}\n\n"
        "Return ONLY a JSON object: {\"values\": [\"keyword\", ...], \"note\": \"one short sentence\"}.\n"
        "Rules for the keywords:\n"
        "- lowercase, 1–3 words, the words people actually type (e.g. 'miner', 'security guard', 'pilot');\n"
        "- include common Pakistani / Roman-Urdu terms where relevant (e.g. 'fauji', 'chowkidar');\n"
        "- avoid very short or generic words that would match unrelated text (no 'man', 'work', 'officer');\n"
        f"- no duplicates, at most {MAX_VALUES} keywords.\n"
        + (f"Keywords already on the list (do not repeat them): {', '.join(existing[:100])}\n" if existing else "")
    )


def _clean(values) -> list[str]:
    out: list[str] = []
    for v in values if isinstance(values, list) else []:
        word = re.sub(r"\s+", " ", str(v)).strip().lower()
        if 2 < len(word) <= 40 and word not in out:
            out.append(word)
    return out[:MAX_VALUES]


async def suggest_values(session: AsyncSession, field_label: str, request: str, existing: list[str]) -> dict:
    """{"values": [...], "note": str, "provider": str}; raises RuntimeError when no provider answers."""
    from routers.llm_config import _extract_reply, resolved_providers

    providers = await resolved_providers(session)
    if not providers:
        raise RuntimeError("No AI provider is configured. Add one under Platform → LLM Configuration.")
    prompt = _instructions(field_label, request, existing)
    last_error = "no provider answered"
    for entry in providers:
        provider = entry["provider"]
        try:
            req = _request(provider, entry["model"], entry["api_key"], prompt)
            async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
                response = await client.post(req["url"], params=req.get("params"), headers=req.get("headers"), json=req["json"])
            response.raise_for_status()
            reply = _extract_reply(provider, response.json())
            match = re.search(r"\{.*\}", reply, re.S)
            data = json.loads(match.group(0)) if match else {}
            known = {e.lower() for e in existing}
            values = [v for v in _clean(data.get("values")) if v not in known]
            return {"values": values, "note": str(data.get("note") or "")[:300], "provider": provider}
        except Exception as err:  # try the fallback provider
            last_error = f"{provider}: {err}"
            log.warning("rule-assist provider failed (%s)", last_error)
    raise RuntimeError(f"The AI could not generate a list ({last_error}).")
