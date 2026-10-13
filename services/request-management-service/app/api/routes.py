"""HTTP API, version 1. Reached through the API gateway as /request-management/v1/... (the gateway forwards the
caller's Authorization header; this service verifies it).

There is no "update status" endpoint: every change is an explicit action with its own rules (app/workflow.py).
Actions that must not happen twice accept an Idempotency-Key header.
"""
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Header, Query, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy import text

from app import attachments, db, queries, routing_admin, service
from app.errors import validation
from app.identity import Identity, current_identity

router = APIRouter(prefix="/v1")
Me = Depends(current_identity)


async def _json(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise validation("The body must be JSON")
    if not isinstance(body, dict):
        raise validation("The body must be a JSON object")
    return body


def _key(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    value = value.strip()
    if not 8 <= len(value) <= 120:
        raise validation("Idempotency-Key must be 8 to 120 characters", field="Idempotency-Key")
    return value


@router.get("/healthz")
async def health() -> dict:
    async with db.transaction() as conn:
        await conn.execute(text("SELECT 1"))
    return {"status": "ok"}


@router.get("/me")
async def me(identity: Identity = Me) -> dict:
    return {"user_id": str(identity.user_id), "tenant_id": str(identity.tenant_id), "name": identity.name, "role": identity.role,
            "branch_id": str(identity.branch_id) if identity.branch_id else None}


@router.get("/request-types")
async def request_types(identity: Identity = Me) -> list[dict]:
    return await queries.types_for(identity)


@router.get("/summary")
async def summary(identity: Identity = Me) -> dict:
    return await queries.summary(identity)


# ── Requests ─────────────────────────────────────────────────────────────────

@router.get("/requests")
async def list_requests(
    identity: Identity = Me,
    scope: str = Query("mine"),
    status: Optional[str] = None, execution_status: Optional[str] = None, type: Optional[str] = None,
    priority: Optional[str] = None, assignee: Optional[str] = None, branch: Optional[str] = None,
    created_from: Optional[str] = None, created_to: Optional[str] = None, overdue: Optional[str] = None,
    q: Optional[str] = Query(None, max_length=100), sort: Optional[str] = None,
    page: int = Query(1, ge=1, le=10_000), page_size: int = Query(20, ge=1, le=100),
) -> dict:
    filters = {"status": status, "execution_status": execution_status, "type": type, "priority": priority, "assignee": assignee,
               "branch": branch, "created_from": created_from, "created_to": created_to, "overdue": overdue, "q": q, "sort": sort}
    return await queries.list_requests(identity, scope, filters, page, page_size)


@router.post("/requests", status_code=201)
async def create(request: Request, identity: Identity = Me, idempotency_key: Optional[str] = Header(None)) -> dict:
    request_id = await service.create_draft(identity, await _json(request), _key(idempotency_key))
    return await queries.detail(identity, request_id)


@router.get("/requests/{request_id}")
async def get(request_id: UUID, identity: Identity = Me) -> dict:
    return await queries.detail(identity, request_id)


@router.get("/requests/{request_id}/timeline")
async def get_timeline(request_id: UUID, identity: Identity = Me) -> list[dict]:
    return await queries.timeline(identity, request_id)


@router.put("/requests/{request_id}/draft")
async def update_draft(request_id: UUID, request: Request, identity: Identity = Me) -> dict:
    await service.update_draft(identity, request_id, await _json(request))
    return await queries.detail(identity, request_id)


def _action(name: str, fn: Any, idempotent: bool = False):
    async def endpoint(request_id: UUID, request: Request, identity: Identity = Me, idempotency_key: Optional[str] = Header(None)) -> dict:
        body = await _json(request)
        if idempotent:
            await fn(identity, request_id, body, _key(idempotency_key))
        else:
            await fn(identity, request_id, body)
        return await queries.detail(identity, request_id)
    endpoint.__name__ = name.replace("-", "_")
    router.add_api_route(f"/requests/{{request_id}}/{name}", endpoint, methods=["POST"], name=name)


_action("submit", service.submit, idempotent=True)
_action("resubmit", service.resubmit, idempotent=True)
_action("start-review", service.start_review)
_action("release", service.release)
_action("request-information", service.request_information)
_action("approve", lambda i, r, b, k: service.decide(i, r, "APPROVED", b, k), idempotent=True)
_action("reject", lambda i, r, b, k: service.decide(i, r, "REJECTED", b, k), idempotent=True)
_action("cancel", service.cancel)
_action("reassign", service.reassign)
_action("retry-execution", service.retry_execution, idempotent=True)
_action("reopen-for-review", service.reopen_for_review)


@router.post("/requests/{request_id}/comments", status_code=201)
async def add_comment(request_id: UUID, request: Request, identity: Identity = Me) -> dict:
    await service.add_comment(identity, request_id, await _json(request))
    return await queries.detail(identity, request_id)


@router.post("/requests/{request_id}/attachments", status_code=201)
async def upload(request_id: UUID, identity: Identity = Me, file: UploadFile = File(...), visibility: str = Form("REQUESTER")) -> dict:
    from app.config import settings
    data = await file.read(settings.max_attachment_bytes + 1)
    await attachments.upload(identity, request_id, file.filename or "file", data, visibility)
    return await queries.detail(identity, request_id)


@router.get("/requests/{request_id}/attachments/{attachment_id}/content")
async def download(request_id: UUID, attachment_id: UUID, identity: Identity = Me) -> Response:
    data, content_type, name = await attachments.download(identity, request_id, attachment_id)
    safe = name.replace('"', "")
    return Response(content=data, media_type=content_type, headers={
        "Content-Disposition": f'attachment; filename="{safe}"', "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store"})


# ── Notifications ────────────────────────────────────────────────────────────

@router.get("/notifications")
async def notifications(identity: Identity = Me, unread: bool = False, limit: int = Query(30, ge=1, le=100)) -> dict:
    async with db.transaction() as conn:
        rows = (await conn.execute(text(
            "SELECT id, request_id, kind, title, body, read_at, created_at FROM notifications WHERE tenant_id = :t AND recipient_user_id = :u "
            + ("AND read_at IS NULL " if unread else "") + "ORDER BY created_at DESC LIMIT :n"
        ), {"t": identity.tenant_id, "u": identity.user_id, "n": limit})).mappings().all()
        count = (await conn.execute(text(
            "SELECT count(*) FROM notifications WHERE tenant_id = :t AND recipient_user_id = :u AND read_at IS NULL"
        ), {"t": identity.tenant_id, "u": identity.user_id})).scalar_one()
    return {"items": [queries._row(dict(r)) for r in rows], "unread": count}


@router.post("/notifications/{notification_id}/read")
async def mark_read(notification_id: UUID, identity: Identity = Me) -> dict:
    async with db.transaction() as conn:
        await conn.execute(text("UPDATE notifications SET read_at = now() WHERE id = :id AND tenant_id = :t AND recipient_user_id = :u AND read_at IS NULL"),
                           {"id": notification_id, "t": identity.tenant_id, "u": identity.user_id})
    return {"ok": True}


@router.post("/notifications/read-all")
async def mark_all_read(identity: Identity = Me) -> dict:
    async with db.transaction() as conn:
        await conn.execute(text("UPDATE notifications SET read_at = now() WHERE tenant_id = :t AND recipient_user_id = :u AND read_at IS NULL"),
                           {"t": identity.tenant_id, "u": identity.user_id})
    return {"ok": True}


# ── Routing administration (tenant administrators) ───────────────────────────

@router.get("/routing-rules")
async def rules(identity: Identity = Me) -> list[dict]:
    return await routing_admin.list_rules(identity)


@router.post("/routing-rules", status_code=201)
async def create_rule(request: Request, identity: Identity = Me) -> dict:
    return await routing_admin.create_rule(identity, await _json(request))


@router.put("/routing-rules/{rule_id}")
async def update_rule(rule_id: UUID, request: Request, identity: Identity = Me) -> dict:
    return await routing_admin.update_rule(identity, rule_id, await _json(request))


@router.post("/routing-rules/{rule_id}/deactivate")
async def deactivate_rule(rule_id: UUID, request: Request, identity: Identity = Me) -> dict:
    return await routing_admin.deactivate_rule(identity, rule_id, await _json(request))


@router.get("/reviewers")
async def reviewers(identity: Identity = Me, request_type: str = Query(...), exclude_requester: Optional[UUID] = None) -> list[dict]:
    return await routing_admin.reviewer_candidates(identity, request_type, exclude_requester)
