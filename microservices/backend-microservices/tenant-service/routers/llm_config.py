"""Platform LLM provider configuration — SuperAdmin only.

A SuperAdmin picks the primary and fallback chat models and supplies the API
keys here instead of baking them into `.env`. Keys are Fernet-encrypted at
rest (crypto_utils.py) and never sent back to the browser.

Endpoints
---------
GET   /platform/llm-config              list providers + status (no keys)
PUT   /platform/llm-config/{provider}   set model / role / api_key
POST  /platform/llm-config/{provider}/test   live key check (real generation)
PUT   /platform/llm-config/tasks/document-forgery   dedicated vision model and token rates
PUT   /platform/llm-config/tasks/ocr    choose the OCR engine's own primary/fallback model
PUT   /platform/llm-config/tasks/live-voice        realtime model, voice and transcription model
POST  /platform/llm-config/tasks/live-voice/test   live check that OpenAI accepts that choice
GET   /internal/llm-config              decrypted primary+fallback for services, plus the
                                        OCR and live-voice choices (not exposed through the api-gateway)

The OCR choice names a provider and a model only; it uses the key stored for
that provider above. Without one, OCR uses the platform primary/fallback.
"""

from __future__ import annotations

import hashlib
import os
import time
from datetime import datetime
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from crypto_utils import EncryptionUnavailable, decrypt_secret, encrypt_secret, is_available
from database import get_session
from routers.auth import verify_superadmin, require_roles
from routers.tokens import require_internal_service
from shared.models.core import LLMProviderConfig, LLMTaskModel

from services.internal_auth import check_internal_secret

router = APIRouter(tags=["Platform — LLM Config"])

PROVIDERS = ("gemini", "openai", "anthropic")
ROLES = ("primary", "fallback", "disabled")
TASK_ROLES = ("primary", "fallback")
# The live voice conversation (chat-agent/routers/voice.py) runs on OpenAI's Realtime API only. These are its
# built-in defaults, used until a SuperAdmin chooses otherwise; keep them in step with that file.
LIVE_VOICE_DEFAULTS = {"model_name": "gpt-realtime-2.1-mini", "voice": "cedar", "transcription_model": "gpt-transcribe"}
DEFAULT_MODELS = {
    "gemini": os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
    "openai": os.getenv("OPENAI_FALLBACK_MODEL", "gpt-4o-mini"),
    "anthropic": "claude-sonnet-4-5",
}

# Optional shared secret for the internal endpoint. When set (in .env, shared
# by all services), GET /internal/llm-config requires a matching header; with no secret configured it is closed (503), never open.
INTERNAL_API_SECRET = os.environ.get("INTERNAL_API_SECRET", "").strip()
# Internal reads require a nonempty shared secret, checked by require_internal_service.


# ── Schemas ───────────────────────────────────────────────────────────────────

class LLMProviderStatus(BaseModel):
    provider: str
    model_name: str
    role: str
    has_key: bool
    api_key_last4: Optional[str]
    updated_at: datetime


class TaskModelChoice(BaseModel):
    provider: str
    model_name: str


class TaskModelStatus(TaskModelChoice):
    has_key: bool  # False when the provider's key was removed after this was chosen


class TaskConfig(BaseModel):
    primary: Optional[TaskModelStatus] = None
    fallback: Optional[TaskModelStatus] = None


class ForgeryModelChoice(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    provider: str
    model_name: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9./_-]+$")
    input_per_million: float | None = Field(default=None, ge=0, le=10000)
    output_per_million: float | None = Field(default=None, ge=0, le=10000)


class ForgeryModelStatus(ForgeryModelChoice):
    has_key: bool


class ForgeryTaskConfig(BaseModel):
    primary: ForgeryModelStatus | None = None


class ForgeryTaskUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    primary: ForgeryModelChoice | None = None


class LiveVoiceStatus(BaseModel):
    configured: bool  # False: the built-in defaults below are in use
    model_name: str
    voice: str
    transcription_model: str
    has_key: bool  # an OpenAI key is stored on this page


class LiveVoiceUpdate(BaseModel):
    model_name: str
    voice: str
    transcription_model: str


class LLMConfigResponse(BaseModel):
    encryption_available: bool
    providers: list[LLMProviderStatus]
    ocr: TaskConfig = TaskConfig()
    live_voice: Optional[LiveVoiceStatus] = None
    document_forgery: ForgeryTaskConfig = Field(default_factory=ForgeryTaskConfig)


class TaskConfigUpdate(BaseModel):
    # primary None -> OCR goes back to the platform primary/fallback (fallback is cleared too)
    primary: Optional[TaskModelChoice] = None
    fallback: Optional[TaskModelChoice] = None


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


def _version(rows: list[LLMProviderConfig], task_rows: list[LLMTaskModel] = ()) -> str:
    """A short fingerprint that changes whenever any provider or task row changes —
    lets the services cheaply tell whether their cached config is stale."""
    basis = "|".join(
        f"{r.provider}:{r.role}:{r.model_name}:{r.updated_at.isoformat()}:{bool(r.api_key_encrypted)}"
        for r in sorted(rows, key=lambda r: r.provider)
    ) + "|" + "|".join(
        f"{t.task}:{t.role}:{t.provider}:{t.model_name}:{t.updated_at.isoformat()}"
        for t in sorted(task_rows, key=lambda t: (t.task, t.role))
    )
    return hashlib.sha256(basis.encode()).hexdigest()[:16]


async def _task_rows(session: AsyncSession, task: str) -> list[LLMTaskModel]:
    return list((await session.exec(select(LLMTaskModel).where(LLMTaskModel.task == task))).all())


def _live_voice_status(rows: list[LLMProviderConfig], task_rows: list[LLMTaskModel]) -> LiveVoiceStatus:
    row = next((t for t in task_rows if t.role == "primary"), None)
    has_key = any(r.provider == "openai" and r.api_key_encrypted for r in rows)
    if row is None:
        return LiveVoiceStatus(configured=False, has_key=has_key, **LIVE_VOICE_DEFAULTS)
    extra = row.settings or {}
    return LiveVoiceStatus(
        configured=True, has_key=has_key, model_name=row.model_name,
        voice=extra.get("voice") or LIVE_VOICE_DEFAULTS["voice"],
        transcription_model=extra.get("transcription_model") or LIVE_VOICE_DEFAULTS["transcription_model"],
    )


def _task_config(rows: list[LLMProviderConfig], task_rows: list[LLMTaskModel]) -> TaskConfig:
    keyed = {r.provider for r in rows if r.api_key_encrypted}
    by_role = {t.role: t for t in task_rows}
    return TaskConfig(**{
        role: TaskModelStatus(provider=t.provider, model_name=t.model_name, has_key=t.provider in keyed)
        for role, t in by_role.items() if role in TASK_ROLES
    })


def _forgery_status(rows, task_rows) -> ForgeryTaskConfig:
    task = next((t for t in task_rows if t.role == "primary"), None)
    if task is None:
        return ForgeryTaskConfig()
    rates = task.settings or {}
    return ForgeryTaskConfig(primary=ForgeryModelStatus(
        provider=task.provider, model_name=task.model_name,
        has_key=any(r.provider == task.provider and r.api_key_encrypted for r in rows),
        input_per_million=rates.get("input_per_million"), output_per_million=rates.get("output_per_million")))


async def resolved_document_forgery(session: AsyncSession) -> dict | None:
    """Explicit task only: never inherit chat/OCR models or environment credentials."""
    rows = list((await session.exec(select(LLMProviderConfig))).all())
    tasks = await _task_rows(session, "document_forgery")
    entry = _resolved_task(rows, tasks, "primary")
    if entry is None:
        return None
    task = next(t for t in tasks if t.role == "primary")
    rates = task.settings or {}
    return {**entry, "input_rate": rates.get("input_per_million"),
            "output_rate": rates.get("output_per_million"), "revision": _version(rows, tasks)}


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
        ocr=_task_config(rows, await _task_rows(session, "ocr")),
        live_voice=_live_voice_status(rows, await _task_rows(session, "live_voice")),
        document_forgery=_forgery_status(rows, await _task_rows(session, "document_forgery")),
    )


@router.put("/platform/llm-config/tasks/document-forgery", response_model=ForgeryTaskConfig)
async def update_document_forgery_model(body: ForgeryTaskUpdate, session: AsyncSession = Depends(get_session), user=Depends(require_roles("SuperAdmin"))):
    rows = await _all_rows(session)
    choice = body.primary
    if choice is not None:
        choice.provider = choice.provider.lower().strip()
        if choice.provider not in PROVIDERS:
            raise HTTPException(422, "Choose Gemini, OpenAI or Anthropic for Document Forgery Detection.")
        if not any(r.provider == choice.provider and r.api_key_encrypted for r in rows):
            raise HTTPException(400, "Save the provider API key in LLM Configuration first.")
    existing = await _task_rows(session, "document_forgery")
    row = next((t for t in existing if t.role == "primary"), None)
    if choice is None:
        if row is not None:
            await session.delete(row)
    else:
        row = row or LLMTaskModel(task="document_forgery", role="primary", provider=choice.provider, model_name=choice.model_name)
        row.provider, row.model_name = choice.provider, choice.model_name
        row.settings = {"input_per_million": choice.input_per_million, "output_per_million": choice.output_per_million}
        row.updated_at = datetime.utcnow()
        row.updated_by = user.id
        session.add(row)
    await session.commit()
    return _forgery_status(rows, await _task_rows(session, "document_forgery"))


@router.put(
    "/platform/llm-config/tasks/live-voice",
    response_model=LiveVoiceStatus,
    dependencies=[Depends(verify_superadmin)],
)
async def update_live_voice_config(body: Optional[LiveVoiceUpdate] = None, session: AsyncSession = Depends(get_session)):
    """Save the live voice choice. An empty body returns live voice to its built-in defaults."""
    rows = await _all_rows(session)
    existing = next((t for t in await _task_rows(session, "live_voice") if t.role == "primary"), None)
    if body is None:
        if existing is not None:
            await session.delete(existing)
            await session.commit()
        return _live_voice_status(rows, [])

    values = {"model_name": body.model_name.strip(), "voice": body.voice.strip(), "transcription_model": body.transcription_model.strip()}
    blank = [name for name, value in values.items() if not value]
    if blank:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Fill in: {', '.join(blank)}.")
    if not any(r.provider == "openai" and r.api_key_encrypted for r in rows):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Live voice runs on OpenAI: set an OpenAI API key above first.")

    row = existing or LLMTaskModel(task="live_voice", role="primary", provider="openai", model_name=values["model_name"])
    row.model_name = values["model_name"]
    row.settings = {"voice": values["voice"], "transcription_model": values["transcription_model"]}
    row.updated_at = datetime.utcnow()
    session.add(row)
    await session.commit()
    return _live_voice_status(rows, [row])


@router.post(
    "/platform/llm-config/tasks/live-voice/test",
    dependencies=[Depends(verify_superadmin)],
)
async def test_live_voice_config(body: LiveVoiceUpdate, session: AsyncSession = Depends(get_session)):
    """Ask OpenAI to open a realtime session with this model and voice (no audio, nothing billed) and check the
    transcription model exists, so a typo is caught here rather than when someone starts a call."""
    rows = await _all_rows(session)
    row = next((r for r in rows if r.provider == "openai"), None)
    if row is None or not row.api_key_encrypted:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No OpenAI API key is stored.")
    try:
        api_key = decrypt_secret(row.api_key_encrypted)
    except EncryptionUnavailable as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    started = time.monotonic()
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=20.0) as c:
            realtime = await c.post("https://api.openai.com/v1/realtime/client_secrets", headers=headers, json={
                "session": {"type": "realtime", "model": body.model_name.strip(),
                            "audio": {"output": {"voice": body.voice.strip()}}},
            })
            transcription = await c.get(f"https://api.openai.com/v1/models/{body.transcription_model.strip()}", headers=headers)
    except httpx.HTTPError as exc:
        return {"ok": False, "status": "error", "detail": f"Could not reach OpenAI: {exc}", "latency_ms": 0}
    latency = int((time.monotonic() - started) * 1000)

    if realtime.status_code in (401, 403):
        return {"ok": False, "status": "invalid_key", "detail": f"OpenAI rejected the key (HTTP {realtime.status_code}) — {_error_message(realtime)}", "latency_ms": latency}
    if realtime.status_code != 200:
        return {"ok": False, "status": "bad_model",
                "detail": f"OpenAI would not open a realtime session with {body.model_name} / voice {body.voice}: {_error_message(realtime)}",
                "latency_ms": latency}
    if transcription.status_code != 200:
        return {"ok": False, "status": "bad_model",
                "detail": f"Realtime model and voice work, but transcription model '{body.transcription_model}' was not found (HTTP {transcription.status_code}).",
                "latency_ms": latency}
    return {"ok": True, "status": "responding",
            "detail": f"OpenAI accepted {body.model_name} with voice {body.voice}; {body.transcription_model} is available.",
            "latency_ms": latency}


# Two path segments, so it never collides with the /platform/llm-config/{provider} routes.
@router.put(
    "/platform/llm-config/tasks/ocr",
    response_model=TaskConfig,
    dependencies=[Depends(verify_superadmin)],
)
async def update_ocr_config(body: TaskConfigUpdate, session: AsyncSession = Depends(get_session)):
    rows = await _all_rows(session)
    keyed = {r.provider for r in rows if r.api_key_encrypted}
    wanted = {"primary": body.primary, "fallback": body.fallback if body.primary else None}
    for role, choice in wanted.items():
        if choice is None:
            continue
        choice.provider = choice.provider.lower()
        choice.model_name = choice.model_name.strip()
        if choice.provider not in PROVIDERS:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown provider '{choice.provider}'.")
        if not choice.model_name:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Choose a model for the OCR {role}.")
        if choice.provider not in keyed:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Set an API key for {choice.provider} above before using it for OCR.",
            )
    if wanted["fallback"] and (wanted["fallback"].provider, wanted["fallback"].model_name) == (
        wanted["primary"].provider, wanted["primary"].model_name
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The OCR fallback must differ from the OCR primary.")

    existing = {t.role: t for t in await _task_rows(session, "ocr")}
    now = datetime.utcnow()
    for role, choice in wanted.items():
        row = existing.get(role)
        if choice is None:
            if row is not None:
                await session.delete(row)
            continue
        if row is None:
            row = LLMTaskModel(task="ocr", role=role, provider=choice.provider, model_name=choice.model_name)
        elif (row.provider, row.model_name) == (choice.provider, choice.model_name):
            continue
        row.provider, row.model_name, row.updated_at = choice.provider, choice.model_name, now
        session.add(row)
    await session.commit()
    return _task_config(rows, await _task_rows(session, "ocr"))


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
    check_internal_secret(INTERNAL_API_SECRET, x_internal_secret)          # fails closed: this endpoint returns decrypted provider keys
    require_internal_service(x_internal_secret)

    rows = await _all_rows(session)
    ocr_rows = await _task_rows(session, "ocr")
    voice_rows = await _task_rows(session, "live_voice")
    forgery_rows = await _task_rows(session, "document_forgery")
    return {
        "version": _version(rows, ocr_rows + voice_rows + forgery_rows),
        "primary": _resolved(rows, "primary"),
        "fallback": _resolved(rows, "fallback"),
        # The OCR engine's own models, each with its provider's key; null where none is chosen (or the key is gone).
        "ocr": {role: _resolved_task(rows, ocr_rows, role) for role in TASK_ROLES},
        # The live voice choice with the OpenAI key; null while the built-in defaults apply (or the key is gone).
        "live_voice": _resolved_live_voice(rows, voice_rows),
        "document_forgery": await resolved_document_forgery(session),
    }


def _resolved_live_voice(rows: list[LLMProviderConfig], voice_rows: list[LLMTaskModel]) -> Optional[dict]:
    entry = _resolved_task(rows, voice_rows, "primary")
    if entry is None:
        return None
    extra = next(t for t in voice_rows if t.role == "primary").settings or {}
    return {**entry,
            "voice": extra.get("voice") or LIVE_VOICE_DEFAULTS["voice"],
            "transcription_model": extra.get("transcription_model") or LIVE_VOICE_DEFAULTS["transcription_model"]}


def _resolved(rows: list[LLMProviderConfig], role: str) -> Optional[dict]:
    row = next((r for r in rows if r.role == role), None)
    if row is None or not row.api_key_encrypted:
        return None
    try:
        key = decrypt_secret(row.api_key_encrypted)
    except EncryptionUnavailable:
        return None
    return {"provider": row.provider, "model": row.model_name, "api_key": key}


def _resolved_task(rows: list[LLMProviderConfig], task_rows: list[LLMTaskModel], role: str) -> Optional[dict]:
    task_row = next((t for t in task_rows if t.role == role), None)
    provider_row = task_row and next((r for r in rows if r.provider == task_row.provider), None)
    if provider_row is None or not provider_row.api_key_encrypted:
        return None
    try:
        key = decrypt_secret(provider_row.api_key_encrypted)
    except EncryptionUnavailable:
        return None
    return {"provider": task_row.provider, "model": task_row.model_name, "api_key": key}


async def resolved_providers(session: AsyncSession) -> list[dict]:
    """Primary then fallback {provider, model, api_key}, for in-process callers."""
    rows = list((await session.exec(select(LLMProviderConfig))).all())
    return [entry for entry in (_resolved(rows, "primary"), _resolved(rows, "fallback")) if entry]


async def ocr_providers(session: AsyncSession) -> list[dict]:
    """Like resolved_providers, for in-process document reading (medical reports, document classification): the
    model chosen for OCR and its OCR fallback, or the platform primary/fallback when no OCR model is chosen. The
    same rule the OCR engine applies to /internal/llm-config."""
    rows = list((await session.exec(select(LLMProviderConfig))).all())
    task_rows = await _task_rows(session, "ocr")
    primary = _resolved_task(rows, task_rows, "primary")
    if primary is None:
        return [entry for entry in (_resolved(rows, "primary"), _resolved(rows, "fallback")) if entry]
    return [entry for entry in (primary, _resolved_task(rows, task_rows, "fallback")) if entry]
