"""Request operations. Each action:

  1. does any slow lookups (other services, the user directory) before taking locks;
  2. in one transaction: locks the request row, checks the caller's expected version (optimistic concurrency), the
     status transition and the caller's right to act (app/workflow.py), applies the change, appends the audit
     event and queues the outbox event;
  3. honours an Idempotency-Key: a repeated call returns the first outcome instead of acting twice.

Two reviewers deciding at once: the row lock serialises them and the second sees a newer version (STALE_VERSION);
the unique index on final decisions per revision backs this up in the database.
"""
from datetime import timedelta
from typing import Any, Optional
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from app import db, records, routing, workflow
from app.config import settings
from app.errors import ApiError, forbidden, invalid_transition, stale_revision, stale_version, validation
from app.identity import Identity
from app.records import audit, j, now, outbox
from app.types.registry import RequestType, content_hash, get_type

PRIORITIES = ("LOW", "NORMAL", "HIGH", "URGENT")


def _title(value: Any) -> str:
    title = (value or "").strip() if isinstance(value, str) else ""
    if not 3 <= len(title) <= 200:
        raise validation("Give the request a title of 3 to 200 characters", field="title")
    return title


def _priority(value: Any) -> str:
    value = value or "NORMAL"
    if value not in PRIORITIES:
        raise validation(f"Priority must be one of {', '.join(PRIORITIES)}", field="priority")
    return value


def _reason(value: Any, minimum: int, label: str = "reason") -> str:
    text_ = (value or "").strip() if isinstance(value, str) else ""
    if len(text_) < minimum:
        raise validation(f"A {label} of at least {minimum} characters is required", field=label)
    if len(text_) > 5000:
        raise validation(f"The {label} is too long", field=label)
    return text_


def _check_version(req: dict, expected: Any) -> None:
    if not isinstance(expected, int):
        raise validation("expected_version is required", field="expected_version")
    if req["version"] != expected:
        raise stale_version(req["version"])


_UNCHECKED = object()


def _authorize(action: str, identity: Identity, req: dict, execution: Optional[dict] = None, expected_version: Any = _UNCHECKED) -> workflow.Relation:
    rel = workflow.relation(identity, req)
    if not rel.can_view:
        raise ApiError(404, "NOT_FOUND", "Request not found")
    if expected_version is not _UNCHECKED:
        # Before the transition rules: someone who acted on an older copy learns that it changed, not just "not allowed".
        _check_version(req, expected_version)
    if not workflow.status_allows(action, req["review_status"]):
        raise invalid_transition(action, req["review_status"])
    if action in ("approve", "reject", "request_information") and rel.is_requester:
        raise forbidden("You can't review your own request.", code="SELF_APPROVAL")
    if not workflow.may(action, identity, req, rel, execution):
        raise forbidden("You're not allowed to do this on this request.", code="ACTION_NOT_ALLOWED", action=action)
    return rel


async def _bump(conn: AsyncConnection, request_id: UUID, **fields: Any) -> None:
    sets = ", ".join(f"{k} = :{k}" for k in fields)
    await conn.execute(text(f"UPDATE requests SET {sets}{', ' if sets else ''}version = version + 1, updated_at = now() WHERE id = :id"),
                       {**fields, "id": request_id})


async def _replay(conn, identity, scope, key, body) -> Optional[dict]:
    return await records.idempotent_replay(conn, tenant_id=identity.tenant_id, actor_id=identity.user_id, scope=scope, key=key, body=body)


async def _done(conn, identity, scope, key, body, request_id: UUID) -> dict:
    result = {"request_id": str(request_id)}
    await records.remember(conn, tenant_id=identity.tenant_id, actor_id=identity.user_id, scope=scope, key=key, body=body, response=result)
    return result


# ── Drafts ───────────────────────────────────────────────────────────────────

async def create_draft(identity: Identity, body: dict, idem_key: Optional[str]) -> UUID:
    rtype = get_type(body.get("request_type") or "")
    if identity.role not in rtype.submit_roles:
        raise forbidden("Your role can't submit this type of request.", code="TYPE_NOT_ALLOWED")
    title, priority = _title(body.get("title")), _priority(body.get("priority"))
    payload = rtype.parse(body.get("payload") or {}, partial=True)
    request_id = uuid4()
    try:
        async with db.transaction() as conn:
            if idem_key:
                existing = (await conn.execute(text(
                    "SELECT id FROM requests WHERE tenant_id = :t AND requester_id = :u AND create_key = :k"
                ), {"t": identity.tenant_id, "u": identity.user_id, "k": idem_key})).scalar()
                if existing:
                    return existing
            reference = await records.next_reference(conn, identity.tenant_id)
            await conn.execute(text("""
                INSERT INTO requests (id, tenant_id, reference_no, request_type, title, priority, requester_id, requester_name,
                    requester_role, branch_id, create_key)
                VALUES (:id, :t, :ref, :type, :title, :prio, :u, :name, :role, :branch, :key)
            """), {"id": request_id, "t": identity.tenant_id, "ref": reference, "type": rtype.code, "title": title,
                   "prio": priority, "u": identity.user_id, "name": identity.name, "role": identity.role,
                   "branch": identity.branch_id, "key": idem_key})
            await conn.execute(text("""
                INSERT INTO request_revisions (id, request_id, tenant_id, revision_no, payload, created_by)
                VALUES (:id, :r, :t, 1, CAST(:p AS JSONB), :u)
            """), {"id": uuid4(), "r": request_id, "t": identity.tenant_id, "p": j(payload), "u": identity.user_id})
            await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="CREATED", actor_id=identity.user_id,
                        actor_name=identity.name, actor_role=identity.role, revision_no=1, to_review="DRAFT", to_execution="NOT_APPLICABLE")
    except IntegrityError:
        # The same Idempotency-Key raced in twice: the first one won.
        async with db.transaction() as conn:
            existing = (await conn.execute(text(
                "SELECT id FROM requests WHERE tenant_id = :t AND requester_id = :u AND create_key = :k"
            ), {"t": identity.tenant_id, "u": identity.user_id, "k": idem_key})).scalar()
        if existing:
            return existing
        raise
    return request_id


async def update_draft(identity: Identity, request_id: UUID, body: dict) -> None:
    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id, lock=True)
        _authorize("edit_draft", identity, req, expected_version=body.get("expected_version"))

        rtype = get_type(req["request_type"])
        fields: dict[str, Any] = {}
        if "title" in body:
            fields["title"] = _title(body["title"])
        if "priority" in body:
            fields["priority"] = _priority(body["priority"])
        revision_no = req["current_revision_no"]
        if "payload" in body:
            payload = rtype.parse(body["payload"] or {}, partial=True)
            current = await records.load_revision(conn, request_id, revision_no)
            if current["frozen_at"] is None:
                await conn.execute(text("UPDATE request_revisions SET payload = CAST(:p AS JSONB), updated_at = now() WHERE id = :id"),
                                   {"p": j(payload), "id": current["id"]})
                event = "DRAFT_EDITED"
            else:
                # The submitted revision is immutable: changing the proposal starts a new revision.
                revision_no += 1
                await conn.execute(text("""
                    INSERT INTO request_revisions (id, request_id, tenant_id, revision_no, payload, created_by)
                    VALUES (:id, :r, :t, :n, CAST(:p AS JSONB), :u)
                """), {"id": uuid4(), "r": request_id, "t": identity.tenant_id, "n": revision_no, "p": j(payload), "u": identity.user_id})
                fields["current_revision_no"] = revision_no
                event = "REVISION_CREATED"
            await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type=event, actor_id=identity.user_id,
                        actor_name=identity.name, actor_role=identity.role, revision_no=revision_no)
        await _bump(conn, request_id, **fields)


# ── Submission ───────────────────────────────────────────────────────────────

async def _prepare(identity: Identity, request_id: UUID, *, resubmitting: bool):
    """Validate the proposal fully and resolve its subject and route, outside any lock."""
    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id)
        rev = await records.load_revision(conn, request_id, req["current_revision_no"])
    rtype = get_type(req["request_type"])
    payload = rtype.parse(rev["payload"], partial=False)
    subject = await rtype.resolve_subject(identity, payload)
    route = None
    if not resubmitting or (not req.get("assignee_user_id") and not req.get("queue_role")):
        async with db.transaction() as conn:
            route = await routing.resolve(conn, identity.tenant_id, rtype, subject.branch_id, identity.user_id)
    return req, rtype, payload, subject, route


async def submit(identity: Identity, request_id: UUID, body: dict, idem_key: Optional[str]) -> dict:
    scope = f"submit:{request_id}"
    async with db.transaction() as conn:
        replay = await _replay(conn, identity, scope, idem_key, body)
        if replay:
            return replay
        req = await records.load_request(conn, request_id, identity.tenant_id)
        _authorize("submit", identity, req, expected_version=body.get("expected_version"))

    _, rtype, payload, subject, route = await _prepare(identity, request_id, resubmitting=False)

    async with db.transaction() as conn:
        replay = await _replay(conn, identity, scope, idem_key, body)
        if replay:
            return replay
        req = await records.load_request(conn, request_id, identity.tenant_id, lock=True)
        _authorize("submit", identity, req, expected_version=body.get("expected_version"))
   # nothing changed while we were validating
        revision_no = req["current_revision_no"]
        await _freeze(conn, request_id, revision_no, payload, subject)
        await _bump(conn, request_id, review_status="SUBMITTED", submitted_revision_no=revision_no,
                    subject_kind=subject.kind, subject_id=subject.id, subject_label=subject.label, branch_id=subject.branch_id,
                    assignee_user_id=route.assignee_user_id, assignee_name=route.assignee_name, queue_role=route.queue_role,
                    routing_rule_id=route.rule_id, routing_snapshot=j(route.snapshot), due_at=route.due_at, submitted_at=now())
        await _assignment(conn, identity.tenant_id, request_id, "ROUTED", route.assignee_user_id, route.assignee_name, route.queue_role, None, None)
        await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="SUBMITTED", actor_id=identity.user_id,
                    actor_name=identity.name, actor_role=identity.role, revision_no=revision_no, from_review="DRAFT", to_review="SUBMITTED",
                    data={"routing": route.snapshot})
        await outbox(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="request.submitted",
                     data=_event_data(req, assignee=route.assignee_user_id, queue_role=route.queue_role, revision_no=revision_no))
        return await _done(conn, identity, scope, idem_key, body, request_id)


async def _freeze(conn, request_id: UUID, revision_no: int, payload: dict, subject) -> None:
    await conn.execute(text("""
        UPDATE request_revisions SET payload = CAST(:p AS JSONB), subject_snapshot = CAST(:s AS JSONB), content_hash = :h,
            frozen_at = now(), updated_at = now()
        WHERE request_id = :r AND revision_no = :n AND frozen_at IS NULL
    """), {"p": j(payload), "s": j(subject.snapshot) if subject.snapshot is not None else "null", "h": content_hash(payload),
           "r": request_id, "n": revision_no})


async def _assignment(conn, tenant_id, request_id, kind, user_id, user_name, queue_role, by, reason) -> None:
    await conn.execute(text("""
        INSERT INTO assignments (id, request_id, tenant_id, kind, assignee_user_id, assignee_name, queue_role, assigned_by, reason)
        VALUES (:id, :r, :t, :k, :u, :n, :q, :by, :reason)
    """), {"id": uuid4(), "r": request_id, "t": tenant_id, "k": kind, "u": user_id, "n": user_name, "q": queue_role, "by": by, "reason": reason})


def _event_data(req: dict, **extra: Any) -> dict:
    return {"reference_no": req["reference_no"], "title": req["title"], "request_type": req["request_type"],
            "requester_id": str(req["requester_id"]), **{k: (str(v) if isinstance(v, UUID) else v) for k, v in extra.items()}}


async def resubmit(identity: Identity, request_id: UUID, body: dict, idem_key: Optional[str]) -> dict:
    scope = f"resubmit:{request_id}"
    message = _reason(body.get("response"), 3, "response")
    async with db.transaction() as conn:
        replay = await _replay(conn, identity, scope, idem_key, body)
        if replay:
            return replay
        req = await records.load_request(conn, request_id, identity.tenant_id)
        _authorize("resubmit", identity, req, expected_version=body.get("expected_version"))

    req, rtype, payload, subject, route = await _prepare(identity, request_id, resubmitting=True)

    # Keep the reviewer who asked, if they may still review; otherwise route again.
    if req.get("assignee_user_id"):
        still = await routing.eligible_reviewers(identity.tenant_id, rtype, user_ids=[req["assignee_user_id"]], exclude=identity.user_id)
        if not still:
            async with db.transaction() as conn:
                route = await routing.resolve(conn, identity.tenant_id, rtype, subject.branch_id, identity.user_id)

    async with db.transaction() as conn:
        replay = await _replay(conn, identity, scope, idem_key, body)
        if replay:
            return replay
        req = await records.load_request(conn, request_id, identity.tenant_id, lock=True)
        _authorize("resubmit", identity, req, expected_version=body.get("expected_version"))

        revision_no = req["current_revision_no"]
        current = await records.load_revision(conn, request_id, revision_no)
        if current["frozen_at"] is not None and rtype.executes:
            # Same proposal, but the record it changes may have moved on: review it against a fresh snapshot.
            revision_no += 1
            await conn.execute(text("""
                INSERT INTO request_revisions (id, request_id, tenant_id, revision_no, payload, created_by)
                VALUES (:id, :r, :t, :n, CAST(:p AS JSONB), :u)
            """), {"id": uuid4(), "r": request_id, "t": identity.tenant_id, "n": revision_no, "p": j(payload), "u": identity.user_id})
            await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="REVISION_CREATED",
                        actor_id=identity.user_id, actor_name=identity.name, actor_role=identity.role, revision_no=revision_no)
        if current["frozen_at"] is None or rtype.executes:
            await _freeze(conn, request_id, revision_no, payload, subject)
        fields: dict[str, Any] = dict(review_status="SUBMITTED", submitted_revision_no=revision_no, current_revision_no=revision_no,
                                      subject_kind=subject.kind, subject_id=subject.id, subject_label=subject.label)
        if route:
            fields.update(assignee_user_id=route.assignee_user_id, assignee_name=route.assignee_name, queue_role=route.queue_role,
                          routing_rule_id=route.rule_id, due_at=route.due_at)
            await _assignment(conn, identity.tenant_id, request_id, "ROUTED", route.assignee_user_id, route.assignee_name, route.queue_role, None, "Rerouted on resubmission")
        await _bump(conn, request_id, **fields)
        if route:
            await conn.execute(text("UPDATE requests SET routing_snapshot = CAST(:s AS JSONB) WHERE id = :id"), {"s": j(route.snapshot), "id": request_id})
        await _comment(conn, identity, request_id, message, "REQUESTER")
        await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="RESUBMITTED", actor_id=identity.user_id,
                    actor_name=identity.name, actor_role=identity.role, revision_no=revision_no,
                    from_review="NEEDS_INFORMATION", to_review="SUBMITTED")
        assignee = route.assignee_user_id if route else req.get("assignee_user_id")
        queue = route.queue_role if route else req.get("queue_role")
        await outbox(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="request.resubmitted",
                     data=_event_data(req, assignee=assignee, queue_role=queue, revision_no=revision_no))
        return await _done(conn, identity, scope, idem_key, body, request_id)


# ── Review ───────────────────────────────────────────────────────────────────

async def start_review(identity: Identity, request_id: UUID, body: dict) -> None:
    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id, lock=True)
        rel = _authorize("start_review", identity, req, expected_version=body.get("expected_version"))

        fields: dict[str, Any] = {"review_status": "IN_REVIEW"}
        if rel.in_queue:   # claiming from the team queue
            fields.update(assignee_user_id=identity.user_id, assignee_name=identity.name)
            await _assignment(conn, identity.tenant_id, request_id, "CLAIMED", identity.user_id, identity.name, req["queue_role"], identity.user_id, None)
        await _bump(conn, request_id, **fields)
        await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="REVIEW_STARTED", actor_id=identity.user_id,
                    actor_name=identity.name, actor_role=identity.role, revision_no=req["submitted_revision_no"],
                    from_review="SUBMITTED", to_review="IN_REVIEW")


async def release(identity: Identity, request_id: UUID, body: dict) -> None:
    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id, lock=True)
        _authorize("release", identity, req, expected_version=body.get("expected_version"))

        await _bump(conn, request_id, review_status="SUBMITTED", assignee_user_id=None, assignee_name=None)
        await _assignment(conn, identity.tenant_id, request_id, "RELEASED", None, None, req["queue_role"], identity.user_id, body.get("reason"))
        await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="RELEASED_TO_QUEUE", actor_id=identity.user_id,
                    actor_name=identity.name, actor_role=identity.role, from_review="IN_REVIEW", to_review="SUBMITTED", reason=body.get("reason"))


def _reviewed_revision(req: dict, body: dict) -> int:
    revision = body.get("revision_no")
    if not isinstance(revision, int):
        raise validation("revision_no (the revision you reviewed) is required", field="revision_no")
    if revision != req["submitted_revision_no"]:
        raise stale_revision(revision, req["submitted_revision_no"])
    return revision


async def request_information(identity: Identity, request_id: UUID, body: dict) -> None:
    message = _reason(body.get("message"), 10, "message")
    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id, lock=True)
        _authorize("request_information", identity, req, expected_version=body.get("expected_version"))

        revision = _reviewed_revision(req, body)
        await _decision(conn, identity, req, revision, "NEEDS_INFORMATION", message, None)
        await _bump(conn, request_id, review_status="NEEDS_INFORMATION")
        await _comment(conn, identity, request_id, message, "REQUESTER")
        await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="INFORMATION_REQUESTED", actor_id=identity.user_id,
                    actor_name=identity.name, actor_role=identity.role, revision_no=revision,
                    from_review=req["review_status"], to_review="NEEDS_INFORMATION", reason=message)
        await outbox(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="request.information_requested",
                     data=_event_data(req, message=message[:300]))


async def _decision(conn, identity: Identity, req: dict, revision: int, decision: str, reason: str, resolution: Optional[str]) -> None:
    await conn.execute(text("""
        INSERT INTO decisions (id, request_id, tenant_id, revision_no, decision, reason, resolution, decided_by, decided_by_name, decided_by_role)
        VALUES (:id, :r, :t, :n, :d, :reason, :res, :by, :name, :role)
    """), {"id": uuid4(), "r": req["id"], "t": identity.tenant_id, "n": revision, "d": decision, "reason": reason,
           "res": resolution, "by": identity.user_id, "name": identity.name, "role": identity.role})


async def decide(identity: Identity, request_id: UUID, decision: str, body: dict, idem_key: Optional[str]) -> dict:
    action = "approve" if decision == "APPROVED" else "reject"
    scope = f"{action}:{request_id}"
    async with db.transaction() as conn:
        replay = await _replay(conn, identity, scope, idem_key, body)
        if replay:
            return replay
        req = await records.load_request(conn, request_id, identity.tenant_id, lock=True)
        _authorize(action, identity, req, expected_version=body.get("expected_version"))
        if req["requester_id"] == identity.user_id:  # separation of duties, stated plainly
            raise forbidden("You can't decide your own request.", code="SELF_APPROVAL")
        revision = _reviewed_revision(req, body)
        rtype: RequestType = get_type(req["request_type"])
        reason = _reason(body.get("reason"), 3 if decision == "APPROVED" else 10)
        allowed = rtype.approve_resolutions if decision == "APPROVED" else rtype.reject_resolutions
        resolution = body.get("resolution") or None
        if allowed and resolution not in allowed:
            raise validation(f"Choose a resolution: {', '.join(allowed)}", field="resolution")
        if not allowed and resolution:
            raise validation("This request type has no resolution to choose", field="resolution")
        try:
            await _decision(conn, identity, req, revision, decision, reason, resolution)
        except IntegrityError:
            raise stale_version(req["version"] + 1)
        fields: dict[str, Any] = dict(review_status=decision, decided_at=now(), decided_by=identity.user_id, decision_reason=reason)
        to_execution = req["execution_status"]
        if decision == "APPROVED" and rtype.executes:
            execution_id = uuid4()
            await conn.execute(text("""
                INSERT INTO executions (id, request_id, tenant_id, revision_no, execution_key, operation, status, max_attempts)
                VALUES (:id, :r, :t, :n, :key, :op, 'PENDING', :max)
            """), {"id": execution_id, "r": request_id, "t": identity.tenant_id, "n": revision,
                   "key": f"rm:{request_id}:{revision}", "op": rtype.operation, "max": settings.max_execution_attempts})
            to_execution = "PENDING"
            fields["execution_status"] = "PENDING"
            # The approval and its execution intent commit together; the worker picks the event up after commit.
            await outbox(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="request.execution_requested",
                         data=_event_data(req, execution_id=execution_id, revision_no=revision))
        await _bump(conn, request_id, **fields)
        await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type=decision, actor_id=identity.user_id,
                    actor_name=identity.name, actor_role=identity.role, revision_no=revision, from_review="IN_REVIEW", to_review=decision,
                    from_execution=req["execution_status"], to_execution=to_execution, reason=reason, data={"resolution": resolution})
        await outbox(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="request.decided",
                     data=_event_data(req, decision=decision, resolution=resolution, revision_no=revision))
        return await _done(conn, identity, scope, idem_key, body, request_id)


# ── Requester and administrator actions ──────────────────────────────────────

async def cancel(identity: Identity, request_id: UUID, body: dict) -> None:
    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id, lock=True)
        _authorize("cancel", identity, req, expected_version=body.get("expected_version"))

        reason = body.get("reason") if req["review_status"] == "DRAFT" else _reason(body.get("reason"), 5)
        await _bump(conn, request_id, review_status="CANCELLED", closed_reason=reason)
        await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="CANCELLED", actor_id=identity.user_id,
                    actor_name=identity.name, actor_role=identity.role, from_review=req["review_status"], to_review="CANCELLED", reason=reason)
        if req["review_status"] != "DRAFT":
            await outbox(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="request.cancelled",
                         data=_event_data(req, assignee=req.get("assignee_user_id"), queue_role=req.get("queue_role")))


async def reassign(identity: Identity, request_id: UUID, body: dict) -> None:
    reason = _reason(body.get("reason"), 5)
    target_user, target_role = body.get("target_user_id"), body.get("target_role")
    if bool(target_user) == bool(target_role):
        raise validation("Choose either a reviewer or a team", field="target")
    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id)
        _authorize("reassign", identity, req, expected_version=body.get("expected_version"))

    rtype = get_type(req["request_type"])
    if target_user:
        try:
            target_uuid = UUID(str(target_user))
        except ValueError:
            raise validation("target_user_id must be a user id", field="target_user_id")
        if target_uuid == req["requester_id"]:
            raise forbidden("A request can't be assigned to its own requester.", code="SELF_APPROVAL")
        matches = await routing.eligible_reviewers(identity.tenant_id, rtype, user_ids=[target_uuid], exclude=req["requester_id"])
        if not matches:
            raise validation("That user isn't an active reviewer for this request type in your tenant", field="target_user_id")
        assignee_id, assignee_name, queue = target_uuid, matches[0]["full_name"], None
    else:
        if target_role not in rtype.review_roles:
            raise validation("That team can't review this request type", field="target_role")
        if not await routing.eligible_reviewers(identity.tenant_id, rtype, role=target_role, exclude=req["requester_id"]):
            raise validation("That team has no active reviewer other than the requester", field="target_role")
        assignee_id, assignee_name, queue = None, None, target_role

    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id, lock=True)
        _authorize("reassign", identity, req, expected_version=body.get("expected_version"))

        new_status = "SUBMITTED" if req["review_status"] == "IN_REVIEW" else req["review_status"]
        await _bump(conn, request_id, assignee_user_id=assignee_id, assignee_name=assignee_name, queue_role=queue, review_status=new_status)
        await _assignment(conn, identity.tenant_id, request_id, "REASSIGNED", assignee_id, assignee_name, queue, identity.user_id, reason)
        await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="REASSIGNED", actor_id=identity.user_id,
                    actor_name=identity.name, actor_role=identity.role, from_review=req["review_status"], to_review=new_status, reason=reason,
                    data={"from": {"user": str(req["assignee_user_id"]) if req["assignee_user_id"] else None, "queue": req["queue_role"]},
                          "to": {"user": str(assignee_id) if assignee_id else None, "queue": queue}})
        await outbox(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="request.assigned",
                     data=_event_data(req, assignee=assignee_id, queue_role=queue))


async def retry_execution(identity: Identity, request_id: UUID, body: dict, idem_key: Optional[str]) -> dict:
    scope = f"retry:{request_id}"
    async with db.transaction() as conn:
        replay = await _replay(conn, identity, scope, idem_key, body)
        if replay:
            return replay
        req = await records.load_request(conn, request_id, identity.tenant_id, lock=True)
        execution = await records.latest_execution(conn, request_id, lock=True)
        _authorize("retry_execution", identity, req, execution, expected_version=body.get("expected_version"))

        assert execution is not None
        await conn.execute(text("""
            UPDATE executions SET status = 'PENDING', max_attempts = attempts + :budget, next_attempt_at = NULL,
                last_error_code = NULL, last_error = NULL, updated_at = now()
            WHERE id = :id
        """), {"budget": settings.max_execution_attempts, "id": execution["id"]})
        await _bump(conn, request_id, execution_status="PENDING")
        await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="EXECUTION_RETRY_REQUESTED", actor_id=identity.user_id,
                    actor_name=identity.name, actor_role=identity.role, revision_no=execution["revision_no"],
                    from_execution="FAILED", to_execution="PENDING", reason=body.get("reason"))
        await outbox(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="request.execution_requested",
                     data=_event_data(req, execution_id=execution["id"], revision_no=execution["revision_no"], manual_retry=True))
        return await _done(conn, identity, scope, idem_key, body, request_id)


async def reopen_for_review(identity: Identity, request_id: UUID, body: dict) -> None:
    reason = _reason(body.get("reason"), 10)
    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id, lock=True)
        execution = await records.latest_execution(conn, request_id)
        _authorize("reopen_for_review", identity, req, execution, expected_version=body.get("expected_version"))

        await _bump(conn, request_id, review_status="NEEDS_INFORMATION", execution_status="NOT_APPLICABLE",
                    decided_at=None, decided_by=None, decision_reason=None,
                    assignee_user_id=req["assignee_user_id"] or identity.user_id,
                    assignee_name=req["assignee_name"] or identity.name)
        await _comment(conn, identity, request_id, reason, "REQUESTER")
        await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="REOPENED_AFTER_CONFLICT", actor_id=identity.user_id,
                    actor_name=identity.name, actor_role=identity.role, revision_no=req["submitted_revision_no"],
                    from_review="APPROVED", to_review="NEEDS_INFORMATION", from_execution="FAILED", to_execution="NOT_APPLICABLE", reason=reason)
        await outbox(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="request.information_requested",
                     data=_event_data(req, message=reason[:300]))


# ── Comments ─────────────────────────────────────────────────────────────────

async def _comment(conn, identity: Identity, request_id: UUID, body: str, visibility: str) -> UUID:
    comment_id = uuid4()
    await conn.execute(text("""
        INSERT INTO comments (id, request_id, tenant_id, author_id, author_name, visibility, body)
        VALUES (:id, :r, :t, :a, :n, :v, :b)
    """), {"id": comment_id, "r": request_id, "t": identity.tenant_id, "a": identity.user_id, "n": identity.name, "v": visibility, "b": body})
    return comment_id


async def add_comment(identity: Identity, request_id: UUID, body: dict) -> UUID:
    text_ = _reason(body.get("body"), 1, "comment")
    visibility = body.get("visibility") or "REQUESTER"
    if visibility not in ("REQUESTER", "INTERNAL"):
        raise validation("visibility must be REQUESTER or INTERNAL", field="visibility")
    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id, lock=True)
        rel = workflow.relation(identity, req)
        if not rel.can_view:
            raise ApiError(404, "NOT_FOUND", "Request not found")
        if visibility == "INTERNAL" and not rel.sees_internal:
            raise forbidden("Only reviewers can add internal notes.", code="INTERNAL_NOT_ALLOWED")
        if req["review_status"] == "DRAFT" and not rel.is_requester:
            raise ApiError(404, "NOT_FOUND", "Request not found")
        comment_id = await _comment(conn, identity, request_id, text_, visibility)
        await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="COMMENT_ADDED", actor_id=identity.user_id,
                    actor_name=identity.name, actor_role=identity.role, data={"comment_id": str(comment_id), "visibility": visibility})
        if visibility == "REQUESTER":
            await outbox(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="request.commented",
                         data=_event_data(req, author_id=identity.user_id, assignee=req.get("assignee_user_id")))
        await conn.execute(text("UPDATE requests SET updated_at = now() WHERE id = :id"), {"id": request_id})
    return comment_id


def overdue_cutoff(hours: int):
    return now() - timedelta(hours=hours)
