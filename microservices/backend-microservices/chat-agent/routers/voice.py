"""Authenticated OpenAI audio setup. Credentials never leave this service."""
import asyncio
import hashlib
import json
import logging
import os
from typing import Literal

import httpx
import websockets
from fastapi import APIRouter, File, Header, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field
from providers import resolve
import usage

log = logging.getLogger("chat-agent.voice")

router = APIRouter(prefix="/chat/voice", tags=["voice"])
# Built-in defaults; a SuperAdmin can choose others in Platform → LLM Configuration → Live voice
# (tenant-service routers/llm_config.py LIVE_VOICE_DEFAULTS mirrors these).
MODEL = "gpt-realtime-2.1-mini"
TENANT_SERVICE_URL = os.getenv("TENANT_SERVICE_URL", "http://tenant-service:8001")
OPENAI_URL = "https://api.openai.com/v1"

INSTRUCTIONS = """You are Insurance AI's live voice companion. Speak naturally and briefly,
one or two sentences at a time. Match the user's English or Urdu, including mixed speech.
Before a platform lookup that may take time, briefly acknowledge that you are checking,
then call the tool. Do not imply the action has already completed.
Never invent customer information, identifiers, money amounts, decisions, or completed actions.
For EVERY platform question, lookup, navigation, business action, or answer to a pending
platform question, call platform_request with the user's words. That tool delegates to the
same authorized chat workflow used by the text UI. It may ask for clarification, explicit
confirmation, or a form/upload. Read its actual question aloud and wait for the user;
never answer your own confirmation. When confirmation is ambiguous ask again. If it
says an action requires a screen, direct the user to that screen and wait. Never claim a
tool succeeded unless its output confirms success. Do not call platform_request again
just to summarize its output. Explain results concisely without reading markdown or
long lists. You may answer greetings or casual conversation directly. You cannot bypass
permissions or run business tools yourself. If interrupted, stop speaking and listen.
"""


class VoiceSessionRequest(BaseModel):
    sdp: str = Field(min_length=20, max_length=64000)
    locale: Literal["en", "ur"] = "en"


async def voice_user(authorization: str, tenant_id: str):
    if not authorization.startswith("Bearer ") or not authorization[7:].strip():
        raise HTTPException(401, "Sign in to start voice")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(f"{TENANT_SERVICE_URL}/auth/me", headers={"Authorization": authorization})
    except httpx.HTTPError:
        raise HTTPException(503, "Sign-in service is temporarily unavailable")
    if not response.is_success:
        raise HTTPException(401, "Your session expired. Sign in again")
    user = response.json()
    if not user.get("is_active", False) or user.get("status") != "ACTIVE":
        raise HTTPException(403, "Account is inactive")
    if user.get("role_name") != "SuperAdmin" and str(user.get("tenant_id") or "") != tenant_id:
        raise HTTPException(403, "Tenant access denied")
    return user


async def voice_settings() -> dict:
    """Key, realtime model, voice and transcription model for a call. A live voice choice saved on the LLM
    Configuration page wins, with the OpenAI key stored there; otherwise the env key and built-in defaults."""
    config = await resolve()
    chosen = config.get("live_voice") or {}
    if chosen.get("api_key") and chosen.get("model"):
        return {"key": chosen["api_key"], "model": chosen["model"],
                "voice": chosen.get("voice") or os.getenv("OPENAI_REALTIME_VOICE", "cedar"),
                "transcription_model": chosen.get("transcription_model") or os.getenv("OPENAI_VOICE_TRANSCRIBE_MODEL", "gpt-transcribe")}
    defaults = {"model": MODEL, "voice": os.getenv("OPENAI_REALTIME_VOICE", "cedar"),
                "transcription_model": os.getenv("OPENAI_VOICE_TRANSCRIBE_MODEL", "gpt-transcribe")}
    key = os.getenv("OPENAI_REALTIME_API_KEY") or os.getenv("OPENAI_API_KEY")
    if key:
        return {"key": key, **defaults}
    for role in ("primary", "fallback"):
        provider = config.get(role) or {}
        if provider.get("provider") == "openai" and provider.get("api_key"):
            return {"key": provider["api_key"], **defaults}
    raise HTTPException(503, "Configure an OpenAI provider in Platform → LLM Configuration, or set OPENAI_REALTIME_API_KEY on chat-agent")


def session_config(locale, settings):
    return {
        "type": "realtime", "model": settings["model"],
        "instructions": INSTRUCTIONS + ("\nStart in Urdu." if locale == "ur" else "\nStart in English."),
        "max_output_tokens": 512,
        "audio": {
            "input": {
                "noise_reduction": {"type": "near_field"},
                "transcription": {"model": settings["transcription_model"]},
                "turn_detection": {"type": "semantic_vad", "eagerness": "medium", "create_response": True, "interrupt_response": True},
            },
            "output": {"voice": settings["voice"]},
        },
        "tools": [{"type": "function", "name": "platform_request",
                   "description": "Delegate platform requests and answers to the existing authorized chat thread. Pass the user's actual words, not an invented tool result.",
                   "parameters": {"type": "object", "properties": {"request": {"type": "string"}}, "required": ["request"], "additionalProperties": False}}],
        "tool_choice": "auto",
    }


# The call's audio flows browser <-> OpenAI, so this service never sees it. To meter the call it joins as a
# server-side listener on the same call (OpenAI "sideband" connection) and records each response's usage; the
# connection closes when the call ends. Capped so a stuck socket cannot linger.
METER_MAX_SECONDS = 3 * 60 * 60
_meters: set = set()


def call_id_of(response) -> str:
    """The call id from POST /realtime/calls (Location: /v1/realtime/calls/<id>)."""
    return (response.headers.get("location") or "").rstrip("/").rsplit("/", 1)[-1]


async def meter_call(call_id: str, settings: dict, tenant_id: str) -> None:
    """Record the usage of one live voice call until it ends. Never raises."""
    url = f"wss://api.openai.com/v1/realtime?call_id={call_id}"
    try:
        async with asyncio.timeout(METER_MAX_SECONDS):
            async with websockets.connect(url, additional_headers={"Authorization": f"Bearer {settings['key']}"},
                                          open_timeout=15, max_size=None) as socket:
                async for raw in socket:
                    event = json.loads(raw)
                    kind = event.get("type")
                    if kind == "response.done":
                        usage.record_counts(usage.realtime_usage((event.get("response") or {}).get("usage") or {}),
                                            service_name=usage.SERVICE_LIVE_VOICE, model_name=settings["model"],
                                            tenant_id=tenant_id, thread_id=call_id)
                    elif kind == "conversation.item.input_audio_transcription.completed":
                        usage.record_counts(usage.transcription_usage(event.get("usage") or {}),
                                            service_name=usage.SERVICE_LIVE_VOICE_CAPTIONS,
                                            model_name=settings["transcription_model"], tenant_id=tenant_id, thread_id=call_id)
    except Exception as exc:  # noqa: BLE001 — metering must never affect the call
        log.warning("Live voice call %s not fully metered: %s", call_id, exc)


def start_meter(call_id: str, settings: dict, tenant_id: str) -> None:
    if not call_id:
        log.warning("Live voice call started without a call id; its usage is not metered")
        return
    task = asyncio.get_running_loop().create_task(meter_call(call_id, settings, tenant_id))
    _meters.add(task)
    task.add_done_callback(_meters.discard)


def provider_error(response, model=MODEL):
    if response.status_code == 429:
        raise HTTPException(429, "OpenAI voice usage limit reached. Please try again later")
    if response.status_code in (401, 403, 404):
        raise HTTPException(502, f"OpenAI rejected voice access. Check the API key and access to {model}")
    raise HTTPException(502, "OpenAI could not start audio. Please retry")


@router.post("/session")
async def voice_session(body: VoiceSessionRequest, authorization: str = Header(default=""), x_tenant_id: str = Header(default="")):
    user = await voice_user(authorization, x_tenant_id)
    if not body.sdp.startswith("v=0"):
        raise HTTPException(422, "Invalid WebRTC offer")
    settings = await voice_settings()
    safety_id = hashlib.sha256(str(user["id"]).encode()).hexdigest()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(25, connect=10)) as client:
            response = await client.post(f"{OPENAI_URL}/realtime/calls", headers={
                "Authorization": f"Bearer {settings['key']}", "OpenAI-Safety-Identifier": safety_id,
            }, files={"sdp": (None, body.sdp, "application/sdp"),
                      "session": (None, json.dumps(session_config(body.locale, settings)), "application/json")})
    except httpx.HTTPError:
        raise HTTPException(503, "Voice connection timed out. Check your connection and retry")
    if not response.is_success:
        provider_error(response, settings["model"])
    start_meter(call_id_of(response), settings, x_tenant_id)
    return Response(response.content, media_type="application/sdp", headers={"Cache-Control": "no-store"})


@router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), authorization: str = Header(default=""), x_tenant_id: str = Header(default="")):
    user = await voice_user(authorization, x_tenant_id)
    data = await audio.read(10 * 1024 * 1024 + 1)
    if not data or len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, "Record a shorter voice message (maximum 10 MB)")
    settings = await voice_settings()
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(f"{OPENAI_URL}/audio/transcriptions", headers={"Authorization": f"Bearer {settings['key']}"},
                data={"model": settings["transcription_model"]},
                files={"file": (audio.filename or "recording.webm", data, audio.content_type or "audio/webm")})
    except httpx.HTTPError:
        raise HTTPException(503, "Transcription is temporarily unavailable")
    if not response.is_success:
        provider_error(response, settings["transcription_model"])
    body = response.json()
    usage.record_counts(usage.transcription_usage(body.get("usage") or {}), service_name=usage.SERVICE_VOICE_MESSAGES,
                        model_name=settings["transcription_model"], tenant_id=x_tenant_id or str(user.get("tenant_id") or "") or None)
    return {"transcript": body.get("text", "")}
