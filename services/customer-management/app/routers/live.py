"""Live updates for the signed-in customer, as Server-Sent Events.

The customer's own claims (from tenant-service) and support tickets (from Customer Service) are checked every few seconds; when one
changes, an event is sent so the page can update its row and tell the customer, without a refresh. The first check only sets the
baseline: nothing is announced for what was already there. Only this customer's records are ever read, exactly as on the normal pages.

  event: claim   data: {id, claim_number, status_key, kind: "status"|"update", previous, approved_amount, settled_amount}
  event: ticket  data: {id, title, status, kind: "status"|"update", previous}
  event: ready   sent once, when the stream is open;  ": ping" comments keep proxies from closing an idle stream.
"""
import asyncio
import json
import logging
import time
from typing import Any, AsyncIterator, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from app import tenant_client
from app.accounts import Principal
from app.config import settings
from app.deps import current_customer
from app.errors import ApiError
from app.routers import support

log = logging.getLogger("customer-management.live")
router = APIRouter(prefix="/v1/stream", tags=["Live"])


async def _claims(p: Principal) -> dict[str, dict]:
    c = tenant_client.get_client()
    scope = c.scope(p.tenant_id, p.customer_id)
    out: dict[str, dict] = {}
    for segment in ("individual", "family"):
        try:
            for row in await c.get(f"{scope}/claims", segment=segment):
                out[str(row["id"])] = row
        except ApiError:                       # a customer without family policies has nothing under "family"; a hiccup is retried next round
            continue
    return out


async def _tickets(p: Principal) -> dict[str, dict]:
    return {str(t["id"]): t for t in (await support._call(p, "GET", support.BASE)).get("items", [])}


def _changes(kind: str, before: dict[str, dict], after: dict[str, dict]) -> list[dict]:
    """What differs between two snapshots, as events. A brand-new record is announced too (a claim or ticket created elsewhere)."""
    out = []
    for key, row in after.items():
        old = before.get(key)
        status = row.get("status_key") if kind == "claim" else row.get("status")
        if old is None:
            out.append({"event": kind, "data": {**_view(kind, row), "kind": "new", "previous": None}})
            continue
        was = old.get("status_key") if kind == "claim" else old.get("status")
        stamp = "last_update" if kind == "claim" else "updated_at"
        if status != was:
            out.append({"event": kind, "data": {**_view(kind, row), "kind": "status", "previous": was}})
        elif row.get(stamp) != old.get(stamp) or row.get("approved_amount") != old.get("approved_amount") or row.get("settled_amount") != old.get("settled_amount"):
            out.append({"event": kind, "data": {**_view(kind, row), "kind": "update", "previous": was}})
    return out


def _view(kind: str, row: dict) -> dict:
    if kind == "claim":
        return {k: row.get(k) for k in ("id", "claim_number", "status_key", "approved_amount", "settled_amount")}
    return {k: row.get(k) for k in ("id", "title", "status")}


def _sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


async def events(p: Principal, request: Optional[Request] = None, *, claims=_claims, tickets=_tickets,
                 poll: Optional[float] = None, max_seconds: Optional[float] = None) -> AsyncIterator[str]:
    poll = settings.stream_poll_seconds if poll is None else poll
    max_seconds = settings.stream_max_seconds if max_seconds is None else max_seconds
    started = last_ping = time.monotonic()
    yield "retry: 4000\n\n" + _sse("ready", {"poll_seconds": poll})
    snap_c: Optional[dict] = None
    snap_t: Optional[dict] = None
    while time.monotonic() - started < max_seconds:
        if request is not None and await request.is_disconnected():
            return
        try:
            new_c, new_t = await claims(p), await tickets(p)
        except Exception as exc:               # an upstream blip must not end the stream: the next round tries again
            log.warning("live check failed: %s", type(exc).__name__)
            new_c, new_t = snap_c, snap_t
        if new_c is not None and snap_c is not None:
            for ev in _changes("claim", snap_c, new_c):
                yield _sse(ev["event"], ev["data"])
        if new_t is not None and snap_t is not None:
            for ev in _changes("ticket", snap_t, new_t):
                yield _sse(ev["event"], ev["data"])
        snap_c, snap_t = new_c if new_c is not None else snap_c, new_t if new_t is not None else snap_t
        if time.monotonic() - last_ping >= 15:
            last_ping = time.monotonic()
            yield ": ping\n\n"
        await asyncio.sleep(poll)


@router.get("/events")
async def stream(request: Request, p: Principal = Depends(current_customer)):
    return StreamingResponse(events(p, request), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"})
