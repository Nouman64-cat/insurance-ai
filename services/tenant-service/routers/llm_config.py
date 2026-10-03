"""Platform LLM provider configuration — SuperAdmin only.

A SuperAdmin picks the primary and fallback chat models and supplies the API
keys here instead of baking them into `.env`. Keys are Fernet-encrypted at
rest (crypto_utils.py) and never sent back to the browser.

Endpoints
---------
GET   /platform/llm-config              list providers + status (no keys)
PUT   /platform/llm-config/{provider}   set model / role / api_key
POST  /platform/llm-config/{provider}/test   live key check (real generation)
GET   /internal/llm-config              decrypted primary+fallback for services
                                        (not exposed through the api-gateway)
"""

from __future__ import annotations

import hashlib
import os
import time
from datetime import datetime
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from crypto_utils import EncryptionUnavailable, decrypt_secret, encrypt_secret, is_available
from database import get_session
from routers.auth import verify_superadmin
from shared.models.core import LLMProviderConfig

router = APIRouter(tags=["Platform — LLM Config"])

PROVIDERS = ("gemini", "openai", "anthropic")
ROLES = ("primary", "fallback", "disabled")
DEFAULT_MODELS = {
    "gemini": os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
    "openai": os.getenv("OPENAI_FALLBACK_MODEL", "gpt-4o-mini"),
    "anthropic": "claude-sonnet-4-5",
}

# Optional shared secret for the internal endpoint. When set (in .env, shared
# by all services), GET /internal/llm-config requires a matching header.
INTERNAL_API_SECRET = os.environ.get("INTERNAL_API_SECRET", "").strip()


# ── Schemas ───────────────────────────────────────────────────────────────────

class LLMProviderStatus(BaseModel):
    provider: str
    model_name: str
    role: str
    has_key: bool
    api_key_last4: Optional[str]
    updated_at: datetime


class LLMConfigResponse(BaseModel):
    encryption_available: bool
    providers: list[LLMProviderStatus]


class LLMConfigUpdate(BaseModel):
    model_name: Optional[str] = None
    role: Optional[str] = None
    # None  -> leave the stored key untouched
    # ""    -> clear the stored key
    # value -> encrypt and store it
    api_key: Optional[str] = None


class LLMTestRequest(BaseModel):
    api_key: Optional[str] = None   # test this key instead of the stored one
    model_name: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _all_rows(session: AsyncSession) -> list[LLMProviderConfig]:
    rows = list((await session.exec(select(LLMProviderConfig))).all())
    have = {r.provider for r in rows}
    for provider in PROVIDERS:
        if provider not in have:
            row = LLMProviderConfig(
                provider=provider,
                model_name=DEFAULT_MODELS[provider],
                role="disabled",
            )
            session.add(row)
            rows.append(row)
    if len(have) < len(PROVIDERS):
        await session.commit()
        for r in rows:
            await session.refresh(r)
    return sorted(rows, key=lambda r: PROVIDERS.index(r.provider) if r.provider in PROVIDERS else 99)


def _status(row: LLMProviderConfig) -> LLMProviderStatus:
    return LLMProviderStatus(
        provider=row.provider,
        model_name=row.model_name,
        role=row.role,
        has_key=bool(row.api_key_encrypted),
        api_key_last4=row.api_key_last4,
        updated_at=row.updated_at,
    )


def _version(rows: list[LLMProviderConfig]) -> str:
    """A short fingerprint that changes whenever any provider row changes —
    lets the services cheaply tell whether their cached config is stale."""
    basis = "|".join(
        f"{r.provider}:{r.role}:{r.model_name}:{r.updated_at.isoformat()}:{bool(r.api_key_encrypted)}"
        for r in sorted(rows, key=lambda r: r.provider)
    )
    return hashlib.sha256(basis.encode()).hexdigest()[:16]


def _error_message(r: httpx.Response) -> str:
    """Pull the provider's human-readable error message out of a response."""
    try:
        body = r.json()
    except ValueError:
        return r.text[:200]
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        return str(err.get("message") or err)[:200]
    if isinstance(err, str):
        return err[:200]
    return r.text[:200]


def _extract_reply(provider: str, body: dict) -> str:
    """Text of the generated reply, for each provider's response shape."""
    try:
        if provider == "gemini":
            parts = body["candidates"][0]["content"].get("parts", [])
            return "".join(p.get("text", "") for p in parts).strip()
        if provider == "openai":
            return (body["choices"][0]["message"].get("content") or "").strip()
        if provider == "anthropic":
            return "".join(
                b.get("text", "") for b in body.get("content", []) if b.get("type") == "text"
            ).strip()
    except (KeyError, IndexError, TypeError, AttributeError):
        pass
    return ""


async def _live_key_check(provider: str, api_key: str, model: str) -> tuple[bool, str, str]:
    """Send a tiny real generation request so the check also catches keys that
    authenticate but have no credits/quota left (listing models doesn't).

    Returns (ok, status, detail) where status is one of:
      "responding"   — the model returned a reply
      "no_credits"   — 429 / quota exhausted / billing problem
      "rate_limited" — 429 that looks like a transient rate limit
      "invalid_key"  — 401/403
      "bad_model"    — model name not found for this key
      "error"        — anything else (network, 5xx, unexpected 4xx)
    """
    prompt = "Reply with the single word: OK"
    try:
        async with httpx.AsyncClient(timeout=20.0) as c:
            if provider == "gemini":
                r = await c.post(
                    f"https://generativelanguage.googleapis.com/v1beta/models/{model.removeprefix('models/')}:generateContent",
                    params={"key": api_key},
                    json={
                        "contents": [{"parts": [{"text": prompt}]}],
                        "generationConfig": {"maxOutputTokens": 16},
                    },
                )
            elif provider == "openai":
                r = await c.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json={
                        "model": model,
                        "messages": [{"role": "user", "content": prompt}],
                        "max_completion_tokens": 16,
                    },
                )
            elif provider == "anthropic":
                r = await c.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
                    json={
                        "model": model,
                        "max_tokens": 16,
                        "messages": [{"role": "user", "content": prompt}],
                    },
                )
            else:
                return False, "error", f"unknown provider {provider!r}"
    except httpx.HTTPError as exc:
        return False, "error", f"Could not reach {provider}: {exc}"

    code = r.status_code
    if code == 200:
        try:
            reply = _extract_reply(provider, r.json())
        except ValueError:
            reply = ""
        shown = f' "{reply[:60]}"' if reply else " (empty reply)"
        return True, "responding", f"Key works — {model} responded:{shown}"

    msg = _error_message(r)
    low = r.text.lower()  # whole body — error codes/status live outside `message`

    if code in (401, 403):
        return False, "invalid_key", f"Key rejected (HTTP {code}) — {msg}"

    # Out of credits: OpenAI → 429 insufficient_quota, Gemini → 429
    # RESOURCE_EXHAUSTED, Anthropic → 400 "credit balance is too low".
    credit_markers = ("quota", "credit", "billing", "resource_exhausted", "exceeded your current")
    if code == 429 or (code in (400, 402) and any(m in low for m in credit_markers)):
        if code == 429 and not any(m in low for m in credit_markers):
            return False, "rate_limited", f"HTTP 429 — rate limited, try again shortly. {msg}"
        return False, "no_credits", f"HTTP {code} — no credits / quota exhausted. {msg}"

    if code == 404 or ("model" in low and ("not found" in low or "does not exist" in low)):
        return False, "bad_model", f"Key is valid but model '{model}' was not found (HTTP {code}) — {msg}"

    return False, "error", f"Provider returned HTTP {code}: {msg}"


# ── SuperAdmin endpoints ──────────────────────────────────────────────────────

@router.get(
    "/platform/llm-config",
    response_model=LLMConfigResponse,
    dependencies=[Depends(verify_superadmin)],
)
async def list_llm_config(session: AsyncSession = Depends(get_session)):
    rows = await _all_rows(session)
    return LLMConfigResponse(
        encryption_available=is_available(),
        providers=[_status(r) for r in rows],
    )


@router.put(
    "/platform/llm-config/{provider}",
    response_model=LLMProviderStatus,
    dependencies=[Depends(verify_superadmin)],
)
async def update_llm_config(
    provider: str,
    body: LLMConfigUpdate,
    session: AsyncSession = Depends(get_session),
):
    provider = provider.lower()
    if provider not in PROVIDERS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown provider '{provider}'.")

    rows = await _all_rows(session)
    row = next(r for r in rows if r.provider == provider)

    if body.model_name is not None:
        model = body.model_name.strip()
        if not model:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "model_name must not be blank.")
        row.model_name = model

    if body.api_key is not None:
        key = body.api_key.strip()
        if key == "":
            row.api_key_encrypted = None
            row.api_key_last4 = None
        else:
            if not is_available():
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "CONFIG_ENCRYPTION_KEY is not configured — cannot store an API key.",
                )
            row.api_key_encrypted = encrypt_secret(key)
            row.api_key_last4 = key[-4:]

    if body.role is not None:
        role = body.role.lower()
        if role not in ROLES:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"role must be one of {ROLES}.")
        if role in ("primary", "fallback") and not row.api_key_encrypted:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Set an API key for {provider} before making it the {role} model.",
            )
        if role in ("primary", "fallback"):
            # at most one provider per role — demote whoever currently holds it
            for other in rows:
                if other.provider != provider and other.role == role:
                    other.role = "disabled"
                    other.updated_at = datetime.utcnow()
                    session.add(other)
        row.role = role

    row.updated_at = datetime.utcnow()
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _status(row)


@router.post(
    "/platform/llm-config/{provider}/test",
    dependencies=[Depends(verify_superadmin)],
)
async def test_llm_config(
    provider: str,
    body: LLMTestRequest,
    session: AsyncSession = Depends(get_session),
):
    provider = provider.lower()
    if provider not in PROVIDERS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown provider '{provider}'.")

    rows = await _all_rows(session)
    row = next(r for r in rows if r.provider == provider)

    api_key = (body.api_key or "").strip()
    if not api_key:
        if not row.api_key_encrypted:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"No API key stored for {provider}.")
        try:
            api_key = decrypt_secret(row.api_key_encrypted)
        except EncryptionUnavailable as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    started = time.monotonic()
    ok, check_status, detail = await _live_key_check(
        provider, api_key, body.model_name or row.model_name
    )
    return {
        "ok": ok,
        "status": check_status,
        "detail": detail,
        "latency_ms": int((time.monotonic() - started) * 1000),
    }


# ── Internal endpoint — consumed by chat-agent / risk-engine ──────────────────

@router.get("/internal/llm-config", include_in_schema=False)
async def internal_llm_config(
    session: AsyncSession = Depends(get_session),
    x_internal_secret: str = Header(default=""),
):
    if INTERNAL_API_SECRET and x_internal_secret != INTERNAL_API_SECRET:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad internal secret")

    rows = await _all_rows(session)

    def _resolved(role: str) -> Optional[dict]:
        row = next((r for r in rows if r.role == role), None)
        if row is None or not row.api_key_encrypted:
            return None
        try:
            key = decrypt_secret(row.api_key_encrypted)
        except EncryptionUnavailable:
            return None
        return {"provider": row.provider, "model": row.model_name, "api_key": key}

    return {
        "version": _version(rows),
        "primary": _resolved("primary"),
        "fallback": _resolved("fallback"),
    }
