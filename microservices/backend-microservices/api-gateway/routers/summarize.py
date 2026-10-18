"""Authenticated public entry points for the Docker-internal text summarizer."""
import json
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse

from dependencies import require_roles
from shared.models.core import User, UserStatus

router = APIRouter(prefix="/summarize", tags=["Summarizer"])
TEXT_SUMMARIZER_URL = os.environ.get("TEXT_SUMMARIZER_URL", "http://text-summarizer:8005").rstrip("/")
underwriting_user = require_roles(
    "SuperAdmin", "Admin", "Underwriter", "Medical Underwriter",
    "Financial Underwriter", "ClaimsManager",
)


async def authorized_user(user: User = Depends(underwriting_user)) -> User:
    if not user.is_active or user.is_deleted or user.status != UserStatus.ACTIVE:
        raise HTTPException(403, "This account is inactive.")
    return user


async def _proxy(request: Request, path: str) -> Response:
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            response = await client.post(
                f"{TEXT_SUMMARIZER_URL}{path}", content=await request.body(),
                headers={"Content-Type": "application/json"},
            )
        return Response(response.content, status_code=response.status_code,
                        media_type=response.headers.get("content-type", "application/json"))
    except httpx.TimeoutException:
        raise HTTPException(504, "Text summarizer timed out.")
    except httpx.HTTPError:
        raise HTTPException(502, "Text summarizer is unreachable.")


@router.post("/underwriter-note")
async def underwriter_note(request: Request, user: User = Depends(authorized_user)):
    return await _proxy(request, "/summarize/underwriter-note")


@router.post("/underwriting")
async def underwriting(request: Request, user: User = Depends(authorized_user)):
    return await _proxy(request, "/summarize/underwriting")


@router.post("")
async def summarize(request: Request, user: User = Depends(authorized_user)):
    return await _proxy(request, "/summarize")


@router.post("/stream")
async def summarize_stream(request: Request, user: User = Depends(authorized_user)):
    client = httpx.AsyncClient(timeout=300.0)
    try:
        upstream = await client.send(client.build_request(
            "POST", f"{TEXT_SUMMARIZER_URL}/summarize/stream",
            content=await request.body(), headers={"Content-Type": "application/json"},
        ), stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(504 if isinstance(exc, httpx.TimeoutException) else 502,
                            "Text summarizer is unavailable.")
    if upstream.status_code >= 400:
        try:
            return Response(await upstream.aread(), status_code=upstream.status_code,
                            media_type=upstream.headers.get("content-type", "application/json"))
        finally:
            await upstream.aclose()
            await client.aclose()

    async def generate():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        except httpx.HTTPError:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Text summarizer stream interrupted'})}\n\n"
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(generate(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive",
    })
