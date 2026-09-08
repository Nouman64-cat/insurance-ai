"""Platform LLM provider configuration — SuperAdmin only.

A SuperAdmin picks the primary and fallback chat models and supplies the API
keys here instead of baking them into `.env`. Keys are Fernet-encrypted at
rest (crypto_utils.py) and never sent back to the browser.

Endpoints
---------
GET   /platform/llm-config              list providers + status (no keys)
PUT   /platform/llm-config/{provider}   set model / role / api_key
POST  /platform/llm-config/{provider}/test   live key check
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


async def _live_key_check(provider: str, api_key: str, model: str) -> tuple[bool, str]:
    """Cheap authenticated call per provider — returns (ok, detail)."""
    try:
        async with httpx.AsyncClient(timeout=12.0) as c:
            if provider == "gemini":
                r = await c.get(
                    "https://generativelanguage.googleapis.com/v1beta/models",
                    params={"key": api_key},
                )
            elif provider == "openai":
                r = await c.get(
                    "https://api.openai.com/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
            elif provider == "anthropic":
                r = await c.get(
                    "https://api.anthropic.com/v1/models",
                    headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
                )
            else:
                return False, f"unknown provider {provider!r}"
        if r.status_code == 200:
            return True, "Key accepted."
        if r.status_code in (401, 403):
            return False, "Key rejected (401/403) — check the value and its permissions."
        return False, f"Provider returned HTTP {r.status_code}: {r.text[:200]}"
    except httpx.HTTPError as exc:
        return False, f"Could not reach {provider}: {exc}"


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
    ok, detail = await _live_key_check(provider, api_key, body.model_name or row.model_name)
    return {"ok": ok, "detail": detail, "latency_ms": int((time.monotonic() - started) * 1000)}


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
