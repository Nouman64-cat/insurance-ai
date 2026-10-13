"""Routing configuration, managed by tenant administrators for their own tenant only.

A rule names one reviewer or a team (role) for a request type, optionally for one branch. Targets are validated when
the rule is saved (active, same tenant, allowed to review the type) and again at every submission. Editing a rule
bumps its version; requests keep the snapshot of the version they were routed with. Every change is audited.
"""
from typing import Any, Optional
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app import db, routing
from app.errors import ApiError, forbidden, not_found, validation
from app.identity import Identity
from app.permissions import is_tenant_admin
from app.queries import _row
from app.records import audit
from app.types.registry import get_type


def _require_admin(identity: Identity) -> None:
    if not is_tenant_admin(identity.role):
        raise forbidden("Only tenant administrators can manage routing.", code="ADMIN_ONLY")


async def list_rules(identity: Identity) -> list[dict]:
    _require_admin(identity)
    async with db.transaction() as conn:
        rows = (await conn.execute(text(
            "SELECT * FROM routing_rules WHERE tenant_id = :t ORDER BY is_active DESC, request_type, branch_id NULLS FIRST, updated_at DESC"
        ), {"t": identity.tenant_id})).mappings().all()
    return [_row(dict(r)) for r in rows]


async def _target(identity: Identity, request_type: str, body: dict) -> dict[str, Any]:
    rtype = get_type(request_type)
    kind = body.get("target_kind")
    if kind == "USER":
        try:
            user_id = UUID(str(body.get("target_user_id")))
        except ValueError:
            raise validation("Choose a reviewer", field="target_user_id")
        matches = await routing.eligible_reviewers(identity.tenant_id, rtype, user_ids=[user_id])
        if not matches:
            raise validation("That user isn't an active reviewer for this request type in your tenant", field="target_user_id")
        return {"target_kind": "USER", "target_user_id": user_id, "target_role": None, "target_label": matches[0]["full_name"]}
    if kind == "ROLE":
        role = body.get("target_role")
        if role not in rtype.review_roles:
            raise validation(f"This request type can be reviewed by: {', '.join(sorted(rtype.review_roles))}", field="target_role")
        if not await routing.eligible_reviewers(identity.tenant_id, rtype, role=role):
            raise validation(f"There is no active {role} in your tenant", field="target_role")
        return {"target_kind": "ROLE", "target_user_id": None, "target_role": role, "target_label": f"{role} queue"}
    raise validation("target_kind must be USER or ROLE", field="target_kind")


def _sla(value: Any, default: int) -> int:
    if value is None:
        return default
    if not isinstance(value, int) or not 1 <= value <= 2160:
        raise validation("SLA must be between 1 and 2160 hours", field="sla_hours")
    return value


def _branch(value: Any) -> Optional[UUID]:
    if not value:
        return None
    try:
        return UUID(str(value))
    except ValueError:
        raise validation("branch_id must be an id", field="branch_id")


async def create_rule(identity: Identity, body: dict) -> dict:
    _require_admin(identity)
    rtype = get_type(body.get("request_type") or "")
    target = await _target(identity, rtype.code, body)
    rule_id = uuid4()
    values = {"id": rule_id, "t": identity.tenant_id, "type": rtype.code, "branch": _branch(body.get("branch_id")),
              "sla": _sla(body.get("sla_hours"), rtype.default_sla_hours), "desc": (body.get("description") or "")[:500],
              "u": identity.user_id, **target}
    try:
        async with db.transaction() as conn:
            await conn.execute(text("""
                INSERT INTO routing_rules (id, tenant_id, request_type, branch_id, target_kind, target_user_id, target_role, target_label,
                    sla_hours, description, created_by, updated_by)
                VALUES (:id, :t, :type, :branch, :target_kind, :target_user_id, :target_role, :target_label, :sla, :desc, :u, :u)
            """), values)
            await audit(conn, tenant_id=identity.tenant_id, request_id=None, event_type="ROUTING_RULE_CREATED", actor_id=identity.user_id,
                        actor_name=identity.name, actor_role=identity.role,
                        data={"rule_id": str(rule_id), "request_type": rtype.code, "target": target["target_label"],
                              "branch_id": str(values["branch"]) if values["branch"] else None, "sla_hours": values["sla"]})
    except IntegrityError:
        raise ApiError(409, "RULE_EXISTS", "There is already an active rule for this request type and branch. Edit it instead.")
    return await get_rule(identity, rule_id)


async def get_rule(identity: Identity, rule_id: UUID) -> dict:
    _require_admin(identity)
    async with db.transaction() as conn:
        row = (await conn.execute(text("SELECT * FROM routing_rules WHERE id = :id AND tenant_id = :t"),
                                  {"id": rule_id, "t": identity.tenant_id})).mappings().first()
    if not row:
        raise not_found("Routing rule")
    return _row(dict(row))


async def update_rule(identity: Identity, rule_id: UUID, body: dict) -> dict:
    _require_admin(identity)
    current = await get_rule(identity, rule_id)
    if not current["is_active"]:
        raise ApiError(409, "RULE_INACTIVE", "This rule was deactivated. Create a new one instead.")
    if body.get("expected_version") != current["version"]:
        raise ApiError(409, "STALE_VERSION", "The rule changed since you loaded it. Reload and try again.", {"current_version": current["version"]})
    target = await _target(identity, current["request_type"], {**current, **body})
    sla = _sla(body.get("sla_hours", current["sla_hours"]), current["sla_hours"])
    desc = (body.get("description", current["description"]) or "")[:500]
    async with db.transaction() as conn:
        updated = (await conn.execute(text("""
            UPDATE routing_rules SET target_kind = :target_kind, target_user_id = :target_user_id, target_role = :target_role,
                target_label = :target_label, sla_hours = :sla, description = :desc, version = version + 1, updated_by = :u, updated_at = now()
            WHERE id = :id AND tenant_id = :t AND version = :v
        """), {**target, "sla": sla, "desc": desc, "u": identity.user_id, "id": rule_id, "t": identity.tenant_id, "v": current["version"]})).rowcount
        if not updated:
            raise ApiError(409, "STALE_VERSION", "The rule changed since you loaded it. Reload and try again.")
        await audit(conn, tenant_id=identity.tenant_id, request_id=None, event_type="ROUTING_RULE_UPDATED", actor_id=identity.user_id,
                    actor_name=identity.name, actor_role=identity.role,
                    data={"rule_id": str(rule_id), "from": {"target": current["target_label"], "sla_hours": current["sla_hours"]},
                          "to": {"target": target["target_label"], "sla_hours": sla}, "version": current["version"] + 1})
    return await get_rule(identity, rule_id)


async def deactivate_rule(identity: Identity, rule_id: UUID, body: dict) -> dict:
    _require_admin(identity)
    current = await get_rule(identity, rule_id)
    async with db.transaction() as conn:
        await conn.execute(text("UPDATE routing_rules SET is_active = FALSE, version = version + 1, updated_by = :u, updated_at = now() WHERE id = :id AND tenant_id = :t"),
                           {"u": identity.user_id, "id": rule_id, "t": identity.tenant_id})
        await audit(conn, tenant_id=identity.tenant_id, request_id=None, event_type="ROUTING_RULE_DEACTIVATED", actor_id=identity.user_id,
                    actor_name=identity.name, actor_role=identity.role, reason=body.get("reason"),
                    data={"rule_id": str(rule_id), "target": current["target_label"], "request_type": current["request_type"]})
    return await get_rule(identity, rule_id)


async def reviewer_candidates(identity: Identity, request_type: str, exclude_requester: Optional[UUID] = None) -> list[dict]:
    """Active users who may review a type: for routing and reassignment pickers (administrators only)."""
    _require_admin(identity)
    rtype = get_type(request_type)
    users = await routing.eligible_reviewers(identity.tenant_id, rtype, exclude=exclude_requester)
    return [{"id": u["id"], "full_name": u["full_name"], "role_name": u["role_name"], "branch_id": u.get("branch_id")} for u in users]
