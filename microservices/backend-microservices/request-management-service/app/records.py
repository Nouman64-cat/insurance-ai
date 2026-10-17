"""Small persistence helpers shared by the request operations and the workers. All take the caller's connection, so
they join the caller's transaction: an action, its audit event and its outbox event commit or roll back together."""
import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.errors import ApiError, not_found


def now() -> datetime:
    return datetime.now(timezone.utc)


def j(value: Any) -> str:
    return json.dumps(value, default=str)


async def load_request(conn: AsyncConnection, request_id: UUID, tenant_id: UUID, *, lock: bool = False) -> dict:
    """The request, only if it belongs to the caller's tenant (otherwise: not found)."""
    row = (await conn.execute(text(
        "SELECT * FROM requests WHERE id = :id AND tenant_id = :tenant" + (" FOR UPDATE" if lock else "")
    ), {"id": request_id, "tenant": tenant_id})).mappings().first()
    if not row:
        raise not_found()
    return dict(row)


async def load_revision(conn: AsyncConnection, request_id: UUID, revision_no: int) -> dict:
    row = (await conn.execute(text("SELECT * FROM request_revisions WHERE request_id = :r AND revision_no = :n"),
                              {"r": request_id, "n": revision_no})).mappings().first()
    if not row:
        raise not_found("Revision")
    return dict(row)


async def latest_execution(conn: AsyncConnection, request_id: UUID, *, lock: bool = False) -> Optional[dict]:
    row = (await conn.execute(text(
        "SELECT * FROM executions WHERE request_id = :r ORDER BY created_at DESC LIMIT 1" + (" FOR UPDATE" if lock else "")
    ), {"r": request_id})).mappings().first()
    return dict(row) if row else None


async def audit(conn: AsyncConnection, *, tenant_id: UUID, request_id: Optional[UUID], event_type: str,
                actor_id: Optional[UUID], actor_name: str, actor_role: Optional[str] = None,
                revision_no: Optional[int] = None, from_review: Optional[str] = None, to_review: Optional[str] = None,
                from_execution: Optional[str] = None, to_execution: Optional[str] = None,
                reason: Optional[str] = None, data: Optional[dict] = None) -> None:
    await conn.execute(text("""
        INSERT INTO audit_events (id, tenant_id, request_id, event_type, actor_id, actor_name, actor_role, revision_no,
            from_review_status, to_review_status, from_execution_status, to_execution_status, reason, data)
        VALUES (:id, :tenant, :request, :type, :actor, :actor_name, :actor_role, :rev, :fr, :tr, :fe, :te, :reason, CAST(:data AS JSONB))
    """), {"id": uuid4(), "tenant": tenant_id, "request": request_id, "type": event_type, "actor": actor_id,
           "actor_name": actor_name, "actor_role": actor_role, "rev": revision_no, "fr": from_review, "tr": to_review,
           "fe": from_execution, "te": to_execution, "reason": reason, "data": j(data or {})})


async def outbox(conn: AsyncConnection, *, tenant_id: UUID, request_id: Optional[UUID], event_type: str, data: dict) -> UUID:
    """Queue an event for Kafka in the caller's transaction (published by app/outbox.py after commit)."""
    event_id = uuid4()
    await conn.execute(text("""
        INSERT INTO outbox_events (id, tenant_id, request_id, event_type, payload)
        VALUES (:id, :tenant, :request, :type, CAST(:payload AS JSONB))
    """), {"id": event_id, "tenant": tenant_id, "request": request_id, "type": event_type, "payload": j(data)})
    return event_id


async def next_reference(conn: AsyncConnection, tenant_id: UUID) -> str:
    year = now().year
    n = (await conn.execute(text("""
        INSERT INTO request_counters (tenant_id, year, last_no) VALUES (:t, :y, 1)
        ON CONFLICT (tenant_id, year) DO UPDATE SET last_no = request_counters.last_no + 1
        RETURNING last_no
    """), {"t": tenant_id, "y": year})).scalar_one()
    return f"RQ-{year}-{n:06d}"


def request_hash(data: Any) -> str:
    return hashlib.sha256(j(data).encode()).hexdigest()


async def idempotent_replay(conn: AsyncConnection, *, tenant_id: UUID, actor_id: UUID, scope: str, key: Optional[str], body: Any) -> Optional[dict]:
    """The stored outcome of an earlier call with the same Idempotency-Key, or None. A reused key with a different
    body is an error (the client is confused), never a second action."""
    if not key:
        return None
    row = (await conn.execute(text("""
        SELECT request_hash, response_status, response_body FROM idempotency_keys
        WHERE tenant_id = :t AND actor_id = :a AND scope = :s AND key = :k
    """), {"t": tenant_id, "a": actor_id, "s": scope, "k": key})).mappings().first()
    if not row:
        return None
    if row["request_hash"] != request_hash(body):
        raise ApiError(409, "IDEMPOTENCY_CONFLICT", "This Idempotency-Key was already used for a different request.")
    return dict(row["response_body"])


async def remember(conn: AsyncConnection, *, tenant_id: UUID, actor_id: UUID, scope: str, key: Optional[str], body: Any, response: dict) -> None:
    if not key:
        return
    await conn.execute(text("""
        INSERT INTO idempotency_keys (tenant_id, actor_id, scope, key, request_hash, response_status, response_body)
        VALUES (:t, :a, :s, :k, :h, 200, CAST(:r AS JSONB))
    """), {"t": tenant_id, "a": actor_id, "s": scope, "k": key, "h": request_hash(body), "r": j(response)})
