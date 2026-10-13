"""Reads: lists, details, timeline, summary counts. Every query is scoped to the caller's tenant, and the detail view
only shows what the caller's relation to the request allows (internal notes never reach the requester)."""
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import text

from app import db, records, workflow
from app.errors import ApiError, forbidden, not_found, validation
from app.identity import Identity
from app.permissions import is_tenant_admin
from app.types.registry import TYPES, get_type
from shared.requests.customer_corrections import FIELDS as CORRECTABLE_FIELDS

OPEN_SQL = "('SUBMITTED', 'IN_REVIEW', 'NEEDS_INFORMATION')"
ACTIVE_REVIEW_SQL = "('SUBMITTED', 'IN_REVIEW')"
STATUSES = ("DRAFT", "SUBMITTED", "IN_REVIEW", "NEEDS_INFORMATION", "APPROVED", "REJECTED", "CANCELLED")
EXEC_STATUSES = ("NOT_APPLICABLE", "PENDING", "RUNNING", "SUCCEEDED", "FAILED")


def reviewable_types(role: str) -> list[str]:
    return [code for code, t in TYPES.items() if role in t.review_roles]


def _iso(v: Any) -> Any:
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, UUID):
        return str(v)
    return v


def _row(d: dict) -> dict:
    return {k: _iso(v) for k, v in d.items()}


def _parse_date(value: Optional[str], field: str) -> Optional[date]:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise validation(f"{field} must be a date (YYYY-MM-DD)", field=field)


def _uuid(value: Optional[str], field: str) -> Optional[UUID]:
    if not value:
        return None
    try:
        return UUID(value)
    except ValueError:
        raise validation(f"{field} must be an id", field=field)


async def list_requests(identity: Identity, scope: str, filters: dict, page: int, page_size: int) -> dict:
    where = ["r.tenant_id = :tenant"]
    params: dict[str, Any] = {"tenant": identity.tenant_id, "me": identity.user_id, "role": identity.role}
    if scope == "mine":
        where.append("r.requester_id = :me")
    elif scope == "review":
        types = reviewable_types(identity.role)
        if not types:
            return {"items": [], "total": 0, "page": page, "page_size": page_size}
        params["types"] = types
        where.append("r.requester_id <> :me")
        where.append(f"""(r.assignee_user_id = :me OR (r.queue_role = :role AND r.assignee_user_id IS NULL
                          AND r.request_type = ANY(:types) AND r.review_status IN {OPEN_SQL}))""")
        if not filters.get("status"):
            where.append(f"r.review_status IN {OPEN_SQL}")
    elif scope == "tenant":
        if not is_tenant_admin(identity.role):
            raise forbidden("The tenant queue is for administrators.", code="ADMIN_ONLY")
        where.append("r.review_status <> 'DRAFT'")
    else:
        raise validation("scope must be mine, review or tenant", field="scope")

    if filters.get("status"):
        statuses = [s for s in filters["status"].split(",") if s]
        if any(s not in STATUSES for s in statuses):
            raise validation("Unknown status", field="status")
        params["statuses"] = statuses
        where.append("r.review_status = ANY(:statuses)")
    if filters.get("execution_status"):
        if filters["execution_status"] not in EXEC_STATUSES:
            raise validation("Unknown execution status", field="execution_status")
        params["exec"] = filters["execution_status"]
        where.append("r.execution_status = :exec")
    if filters.get("type"):
        get_type(filters["type"])
        params["type"] = filters["type"]
        where.append("r.request_type = :type")
    if filters.get("priority"):
        params["priority"] = filters["priority"]
        where.append("r.priority = :priority")
    if filters.get("assignee") == "unassigned":
        where.append("r.assignee_user_id IS NULL")
    elif filters.get("assignee"):
        params["assignee"] = _uuid(filters["assignee"], "assignee")
        where.append("r.assignee_user_id = :assignee")
    if filters.get("branch"):
        params["branch"] = _uuid(filters["branch"], "branch")
        where.append("r.branch_id = :branch")
    created_from = _parse_date(filters.get("created_from"), "created_from")
    created_to = _parse_date(filters.get("created_to"), "created_to")
    if created_from:
        params["from"] = datetime.combine(created_from, time.min, tzinfo=timezone.utc)
        where.append("r.created_at >= :from")
    if created_to:
        params["to"] = datetime.combine(created_to + timedelta(days=1), time.min, tzinfo=timezone.utc)
        where.append("r.created_at < :to")
    if filters.get("overdue") in ("1", "true"):
        where.append(f"r.due_at < now() AND r.review_status IN {ACTIVE_REVIEW_SQL}")
    if filters.get("q"):
        params["q"] = f"%{filters['q'].strip()[:100]}%"
        where.append("(r.reference_no ILIKE :q OR r.title ILIKE :q OR r.subject_label ILIKE :q OR r.requester_name ILIKE :q)")

    sort = {"updated": "r.updated_at DESC", "due": "r.due_at ASC NULLS LAST", "created": "r.created_at DESC"}.get(filters.get("sort") or "", "r.updated_at DESC")
    clause = " AND ".join(where)
    params.update(limit=page_size, offset=(page - 1) * page_size)
    async with db.transaction() as conn:
        total = (await conn.execute(text(f"SELECT count(*) FROM requests r WHERE {clause}"), params)).scalar_one()
        rows = (await conn.execute(text(f"""
            SELECT r.id, r.reference_no, r.request_type, r.title, r.priority, r.review_status, r.execution_status,
                   r.requester_id, r.requester_name, r.assignee_user_id, r.assignee_name, r.queue_role, r.subject_kind,
                   r.subject_label, r.branch_id, r.due_at, r.submitted_at, r.decided_at, r.created_at, r.updated_at,
                   (r.due_at < now() AND r.review_status IN {ACTIVE_REVIEW_SQL}) AS overdue
            FROM requests r WHERE {clause} ORDER BY {sort}, r.id LIMIT :limit OFFSET :offset
        """), params)).mappings().all()
    return {"items": [_row(dict(r)) for r in rows], "total": total, "page": page, "page_size": page_size}


def _correction_diff(revision: dict) -> list[dict]:
    payload, snapshot = revision.get("payload") or {}, revision.get("subject_snapshot") or {}
    before = snapshot.get("before") or {}
    return [{"field": key, "label": CORRECTABLE_FIELDS[key].label if key in CORRECTABLE_FIELDS else key,
             "before": before.get(key), "after": value} for key, value in (payload.get("changes") or {}).items()]


async def detail(identity: Identity, request_id: UUID) -> dict:
    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id)
        rel = workflow.relation(identity, req, decided_by_me=req.get("decided_by") == identity.user_id)
        if not rel.can_view or (req["review_status"] == "DRAFT" and not rel.is_requester):
            raise not_found()
        revisions = [dict(r) for r in (await conn.execute(text(
            "SELECT revision_no, payload, subject_snapshot, content_hash, created_at, frozen_at FROM request_revisions WHERE request_id = :r ORDER BY revision_no"
        ), {"r": request_id})).mappings().all()]
        decisions = [dict(r) for r in (await conn.execute(text(
            "SELECT revision_no, decision, reason, resolution, decided_by_name, decided_by_role, created_at FROM decisions WHERE request_id = :r ORDER BY created_at"
        ), {"r": request_id})).mappings().all()]
        execution = await records.latest_execution(conn, request_id)
        attempts = []
        if execution:
            attempts = [dict(r) for r in (await conn.execute(text(
                "SELECT attempt_no, started_at, finished_at, outcome, error_code, error_message FROM execution_attempts WHERE execution_id = :e ORDER BY attempt_no"
            ), {"e": execution["id"]})).mappings().all()]
        comments = [dict(r) for r in (await conn.execute(text(
            "SELECT id, author_id, author_name, visibility, body, created_at FROM comments WHERE request_id = :r "
            + ("" if rel.sees_internal else "AND visibility = 'REQUESTER' ") + "ORDER BY created_at"
        ), {"r": request_id})).mappings().all()]
        attachments = [dict(r) for r in (await conn.execute(text(
            "SELECT id, file_name, content_type, size_bytes, visibility, uploaded_by_name, revision_no, created_at FROM attachments "
            "WHERE request_id = :r AND deleted_at IS NULL " + ("" if rel.sees_internal else "AND visibility = 'REQUESTER' ") + "ORDER BY created_at"
        ), {"r": request_id})).mappings().all()]

    rtype = get_type(req["request_type"])
    if not rel.is_requester:  # reviewers see what was submitted, not the requester's unsent edits
        revisions = [r for r in revisions if r["frozen_at"] is not None]
    reviewed_no = req["submitted_revision_no"]
    reviewed = next((r for r in revisions if r["revision_no"] == reviewed_no), None)
    current = next((r for r in revisions if r["revision_no"] == req["current_revision_no"]), None)
    final_decision = next((d for d in reversed(decisions) if d["decision"] in ("APPROVED", "REJECTED")), None)
    overdue = bool(req["due_at"] and req["due_at"] < datetime.now(timezone.utc) and req["review_status"] in ("SUBMITTED", "IN_REVIEW"))
    execution_view = None
    if execution:
        execution_view = _row({k: execution[k] for k in ("status", "attempts", "max_attempts", "last_error_code", "last_error",
                                                        "revision_no", "updated_at", "completed_at", "next_attempt_at")})
        execution_view["result"] = execution["result"]
        execution_view["attempt_log"] = [_row(a) for a in attempts]
    routing_view = req["routing_snapshot"] if (rel.sees_internal and req["routing_snapshot"]) else (
        {"target_label": (req["routing_snapshot"] or {}).get("target_label")} if req["routing_snapshot"] else None)

    return {
        **_row({k: req[k] for k in ("id", "reference_no", "request_type", "title", "priority", "review_status", "execution_status",
                                     "requester_id", "requester_name", "requester_role", "assignee_user_id", "assignee_name", "queue_role",
                                     "branch_id", "subject_kind", "subject_id", "subject_label", "current_revision_no",
                                     "submitted_revision_no", "due_at", "submitted_at", "decided_at", "closed_reason", "version",
                                     "created_at", "updated_at")}),
        "type": {"code": rtype.code, "label": rtype.label, "executes": rtype.executes,
                 "approve_resolutions": list(rtype.approve_resolutions), "reject_resolutions": list(rtype.reject_resolutions)},
        "overdue": overdue,
        "viewer": {"is_requester": rel.is_requester, "is_assignee": rel.is_assignee, "in_queue": rel.in_queue,
                   "is_admin": rel.is_admin, "sees_internal": rel.sees_internal},
        "allowed_actions": workflow.allowed_actions(identity, req, rel, execution),
        "reviewed_revision": _row(reviewed) | {"payload": reviewed["payload"], "subject_snapshot": reviewed["subject_snapshot"]} if reviewed else None,
        "current_revision": _row(current) | {"payload": current["payload"], "subject_snapshot": current["subject_snapshot"]} if current else None,
        "revisions": [{"revision_no": r["revision_no"], "frozen_at": _iso(r["frozen_at"]), "created_at": _iso(r["created_at"])} for r in revisions],
        "changes": _correction_diff(reviewed or current or {}) if rtype.code == "customer_profile_correction" else None,
        "decision": _row(final_decision) if final_decision else None,
        "decisions": [_row(d) for d in decisions],
        "execution": execution_view,
        "routing": routing_view,
        "comments": [_row(c) for c in comments],
        "attachments": [_row(a) for a in attachments],
    }


# Events whose reason is between reviewers and administrators.
_INTERNAL_REASON_EVENTS = {"REASSIGNED", "RELEASED_TO_QUEUE"}


async def timeline(identity: Identity, request_id: UUID) -> list[dict]:
    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id)
        rel = workflow.relation(identity, req, decided_by_me=req.get("decided_by") == identity.user_id)
        if not rel.can_view or (req["review_status"] == "DRAFT" and not rel.is_requester):
            raise not_found()
        rows = [dict(r) for r in (await conn.execute(text(
            "SELECT event_type, actor_name, actor_role, revision_no, from_review_status, to_review_status, from_execution_status, "
            "to_execution_status, reason, data, created_at FROM audit_events WHERE request_id = :r ORDER BY created_at, id"
        ), {"r": request_id})).mappings().all()]
    out = []
    for row in rows:
        data = row.pop("data") or {}
        if not rel.sees_internal:
            if row["event_type"] == "COMMENT_ADDED" and data.get("visibility") == "INTERNAL":
                continue
            if row["event_type"] == "ATTACHMENT_ADDED" and data.get("visibility") == "INTERNAL":
                continue
            if row["event_type"] in _INTERNAL_REASON_EVENTS:
                row["reason"] = None
            data = {k: v for k, v in data.items() if k in ("resolution", "visibility")}
        out.append(_row(row) | {"data": data})
    return out


async def summary(identity: Identity) -> dict:
    types = reviewable_types(identity.role)
    params = {"t": identity.tenant_id, "me": identity.user_id, "role": identity.role, "types": types or ["-"]}
    async with db.transaction() as conn:
        row = (await conn.execute(text(f"""
            SELECT
              count(*) FILTER (WHERE requester_id = :me AND review_status = 'DRAFT') AS my_drafts,
              count(*) FILTER (WHERE requester_id = :me AND review_status IN {OPEN_SQL}) AS my_open,
              count(*) FILTER (WHERE requester_id = :me AND review_status = 'NEEDS_INFORMATION') AS my_needs_information,
              count(*) FILTER (WHERE requester_id <> :me AND assignee_user_id = :me AND review_status IN {OPEN_SQL}) AS assigned_to_me,
              count(*) FILTER (WHERE requester_id <> :me AND assignee_user_id IS NULL AND queue_role = :role
                               AND request_type = ANY(:types) AND review_status IN {OPEN_SQL}) AS queue_unclaimed,
              count(*) FILTER (WHERE requester_id <> :me AND due_at < now() AND review_status IN {ACTIVE_REVIEW_SQL}
                               AND (assignee_user_id = :me OR (assignee_user_id IS NULL AND queue_role = :role AND request_type = ANY(:types)))) AS overdue_for_me,
              count(*) FILTER (WHERE review_status IN {OPEN_SQL}) AS tenant_open,
              count(*) FILTER (WHERE due_at < now() AND review_status IN {ACTIVE_REVIEW_SQL}) AS tenant_overdue,
              count(*) FILTER (WHERE execution_status = 'FAILED') AS tenant_failed_executions
            FROM requests WHERE tenant_id = :t
        """), params)).mappings().one()
        unread = (await conn.execute(text(
            "SELECT count(*) FROM notifications WHERE tenant_id = :t AND recipient_user_id = :me AND read_at IS NULL"
        ), params)).scalar_one()
    out = {k: row[k] for k in ("my_drafts", "my_open", "my_needs_information", "assigned_to_me", "queue_unclaimed", "overdue_for_me")}
    if is_tenant_admin(identity.role):
        out.update(tenant_open=row["tenant_open"], tenant_overdue=row["tenant_overdue"], tenant_failed_executions=row["tenant_failed_executions"])
    out["unread_notifications"] = unread
    out["can_review"] = bool(types)
    out["is_admin"] = is_tenant_admin(identity.role)
    return out


async def types_for(identity: Identity) -> list[dict]:
    from app.types.registry import describe
    return [describe(t) | {"can_submit": identity.role in t.submit_roles} for t in TYPES.values()]


def ensure(condition: bool, error: ApiError) -> None:
    if not condition:
        raise error
