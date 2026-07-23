"""Proxies the conversational agent's SSE endpoints to the chat-agent service,
following the same streaming-with-re-parsing pattern as routers/evaluate.py's
/evaluate/stream — re-yielding each `data: {...}\\n\\n` line unchanged, since
chat-agent already emits the final event vocabulary the frontend expects.

Unlike OCR/text-summarizer (which bypass this gateway entirely), chat needs
the same Authorization/X-Tenant-Id scoping as every other tenant-scoped route,
so it's fronted here rather than exposed directly to the browser.
"""

import os

import httpx
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import StreamingResponse
from fastapi.security import OAuth2PasswordBearer

router = APIRouter(prefix="/chat", tags=["Chat"])

CHAT_AGENT_URL = os.environ.get("CHAT_AGENT_URL", "http://chat-agent:8006")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/token")

_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}


async def _proxy_sse(path: str, request: Request) -> StreamingResponse:
    body = await request.body()
    headers = {
        "Content-Type": "application/json",
        "Authorization": request.headers.get("authorization", ""),
        "X-Tenant-Id": request.headers.get("x-tenant-id", ""),
    }

    async def generate():
        try:
            # Generous: one SSE turn can legitimately include a full risk
            # assessment (3 sequential LLM calls in the risk engine).
            async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=10.0)) as client:
                async with client.stream("POST", f"{CHAT_AGENT_URL}{path}", content=body, headers=headers) as resp:
                    async for chunk in resp.aiter_bytes():
                        yield chunk
        except httpx.ConnectError:
            yield b'data: {"type": "error", "message": "Chat agent is unreachable"}\n\n'
        except httpx.TimeoutException:
            yield b'data: {"type": "error", "message": "Chat agent timed out"}\n\n'

    return StreamingResponse(generate(), media_type="text/event-stream", headers=_SSE_HEADERS)


@router.post("/stream", summary="Start or continue a conversation turn (SSE)")
async def chat_stream(request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_sse("/chat/stream", request)


@router.post("/resume", summary="Resume a paused conversation after a clarify/confirm interrupt (SSE)")
async def chat_resume(request: Request, token: str = Depends(oauth2_scheme)):
    return await _proxy_sse("/chat/resume", request)


@router.post("/execute-tool", summary="Non-streaming tool execution (used by the voice agent)")
async def chat_execute_tool(request: Request, token: str = Depends(oauth2_scheme)):
    body = await request.body()
    headers = {
        "Content-Type": "application/json",
        "Authorization": request.headers.get("authorization", ""),
        "X-Tenant-Id": request.headers.get("x-tenant-id", ""),
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(f"{CHAT_AGENT_URL}/chat/execute-tool", content=body, headers=headers)
        from fastapi import Response
        return Response(content=resp.content, status_code=resp.status_code, media_type="application/json")
