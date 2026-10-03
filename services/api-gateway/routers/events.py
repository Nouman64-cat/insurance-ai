"""Live case events for the signed-in user's tenant, as Server-Sent Events.

The browser keeps one GET /events/stream open; case_event_hub pushes events
(e.g. the customer submitting their e-application) into it as they happen.
A comment line every 15 s keeps proxies from closing an idle connection.
"""

import asyncio
import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from case_event_hub import subscribe, unsubscribe
from dependencies import get_current_user
from shared.models.core import User

router = APIRouter(prefix="/events", tags=["Events"])

_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}
_HEARTBEAT_SECONDS = 15


@router.get("/stream", summary="Live case events for your tenant (SSE)")
async def event_stream(request: Request, user: User = Depends(get_current_user)):
    tenant_id = user.tenant_id
    queue = subscribe(tenant_id)

    async def generate():
        try:
            yield f"data: {json.dumps({'type': 'ready'})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=_HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                yield f"data: {json.dumps(message)}\n\n"
        finally:
            unsubscribe(tenant_id, queue)

    return StreamingResponse(generate(), media_type="text/event-stream", headers=_SSE_HEADERS)
