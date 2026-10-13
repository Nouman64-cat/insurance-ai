"""Live status updates for the frontend, over Server-Sent Events (GET /v1/events).

Source: a database trigger (migrations/0002_live_status.sql) sends a notice on every committed change to a request's
status, assignment or version, from whichever instance or worker made it. Each instance keeps one LISTEN connection
and fans notices out to its open streams for the same tenant.

The notice itself is never forwarded. For every subscriber the request is loaded and checked with the same rules as
the detail page (app/workflow.py): someone who may see it gets its new status; a reviewer whose team queue it
belongs to, but who may no longer open it (someone claimed it), only learns that the queue changed; everyone else
gets nothing. The session is re-verified every minute, so a revoked user's stream ends.

If notices may have been missed (the listener reconnected, or a slow client's buffer overflowed), the stream sends
"resync" and the client reloads what it shows. Clients also reload after reconnecting.
"""
import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional
from uuid import UUID

import asyncpg
from fastapi import Request

from app import db, identity as identities, records, workflow
from app.errors import ApiError
from app.identity import Identity

log = logging.getLogger("request-management.live")

CHANNEL = "request_management_changes"
HEARTBEAT_SECONDS = 20
REVERIFY_SECONDS = 60
QUEUE_SIZE = 200
RESYNC = {"resync": True}


class Hub:
    def __init__(self) -> None:
        self._subscribers: dict[UUID, set[asyncio.Queue]] = {}
        self._task: Optional[asyncio.Task] = None

    def _deliver(self, queue: asyncio.Queue, item: dict) -> None:
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:
            # The client is far behind: drop what's queued and tell it to reload instead.
            while not queue.empty():
                queue.get_nowait()
            queue.put_nowait(RESYNC)

    def publish(self, notice: dict) -> None:
        try:
            tenant = UUID(notice["tenant_id"])
        except (KeyError, ValueError, TypeError):
            return
        for queue in list(self._subscribers.get(tenant, ())):
            self._deliver(queue, notice)

    def _resync_all(self) -> None:
        for queues in list(self._subscribers.values()):
            for queue in list(queues):
                self._deliver(queue, RESYNC)

    def _on_notify(self, _conn, _pid, _channel, payload: str) -> None:
        try:
            self.publish(json.loads(payload))
        except ValueError:
            log.warning("ignored a malformed change notice")

    async def _listen(self) -> None:
        dsn = db.engine().url.set(drivername="postgresql").render_as_string(hide_password=False)
        delay = 1.0
        first = True
        while True:
            conn = None
            try:
                conn = await asyncpg.connect(dsn)
                closed = asyncio.Event()
                conn.add_termination_listener(lambda _c: closed.set())
                await conn.add_listener(CHANNEL, self._on_notify)
                if not first:
                    self._resync_all()   # changes made while we weren't listening were missed
                first, delay = False, 1.0
                log.info("listening for request changes")
                await closed.wait()
                log.warning("change listener connection closed; reconnecting")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - keep listening whatever happened
                log.warning("change listener failed (%s); retrying in %.0fs", exc, delay)
            finally:
                if conn is not None and not conn.is_closed():
                    await conn.close()
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)
            first = False

    def ensure_started(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self._listen())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    @asynccontextmanager
    async def subscribe(self, tenant_id: UUID) -> AsyncIterator[asyncio.Queue]:
        self.ensure_started()
        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_SIZE)
        self._subscribers.setdefault(tenant_id, set()).add(queue)
        try:
            yield queue
        finally:
            queues = self._subscribers.get(tenant_id)
            if queues is not None:
                queues.discard(queue)
                if not queues:
                    self._subscribers.pop(tenant_id, None)


hub = Hub()


def _event(name: str, data: dict) -> str:
    return f"event: {name}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


async def view(identity: Identity, notice: dict) -> Optional[tuple[str, dict]]:
    """What this subscriber may learn about one change, or None."""
    try:
        request_id = UUID(notice["request_id"])
    except (KeyError, ValueError, TypeError):
        return None
    async with db.transaction() as conn:
        try:
            req = await records.load_request(conn, request_id, identity.tenant_id)
        except ApiError:
            return None
    rel = workflow.relation(identity, req, decided_by_me=req.get("decided_by") == identity.user_id)
    if rel.can_view:
        return "request", {
            "request_id": str(req["id"]), "reference_no": req["reference_no"], "version": req["version"],
            "review_status": req["review_status"], "execution_status": req["execution_status"],
        }
    if rel.can_review_type and not rel.is_requester and req.get("queue_role") == identity.role:
        return "queue", {}
    return None


async def stream(request: Request, identity: Identity) -> AsyncIterator[str]:
    yield f"retry: 5000\n{_event('ready', {})}"
    verified = time.monotonic()
    async with hub.subscribe(identity.tenant_id) as queue:
        while True:
            if await request.is_disconnected():
                return
            try:
                notice = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                notice = None
            if time.monotonic() - verified > REVERIFY_SECONDS:
                try:
                    current = await identities.resolve(identity.token)
                except ApiError as exc:
                    if exc.status in (401, 403):
                        yield _event("end", {"code": exc.code})
                        return
                    current = identity   # sign-in service briefly unreachable: keep going, check again later
                if current.tenant_id != identity.tenant_id:
                    yield _event("end", {"code": "TENANT_MISMATCH"})
                    return
                identity, verified = current, time.monotonic()
            if notice is None:
                yield ": ping\n\n"
            elif notice is RESYNC:
                yield _event("resync", {})
            else:
                out = await view(identity, notice)
                if out:
                    yield _event(*out)
