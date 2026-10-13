"""Who is responsible for a request. Decided by the server at submission; the requester never chooses.

A tenant administrator configures routing rules per request type, optionally per branch. A rule sends requests to
one named reviewer (USER) or to a team queue (ROLE, any eligible user with that role may claim it). The most
specific active rule wins: the request's branch first, then the tenant-wide rule.

At submission the rule's target is checked against the live user directory: a named reviewer must be active, in the
same tenant, hold a role allowed to review the type, and not be the requester; a queue must have at least one such
user other than the requester. If nothing qualifies, submission fails with ROUTING_FAILED and the request stays a
draft: an open request always has someone accountable. The rule (and its version) used is stored on the request.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app import tenant_client
from app.errors import ApiError, routing_failed
from app.types.registry import RequestType


@dataclass
class Route:
    rule_id: UUID
    rule_version: int
    target_kind: str
    assignee_user_id: Optional[UUID]
    assignee_name: Optional[str]
    queue_role: Optional[str]
    due_at: datetime
    snapshot: dict


async def eligible_reviewers(tenant_id: UUID, rtype: RequestType, *, role: Optional[str] = None,
                             user_ids: Optional[list[UUID]] = None, exclude: Optional[UUID] = None) -> list[dict]:
    roles = [role] if role else sorted(rtype.review_roles)
    try:
        users = await tenant_client.get_client().users(tenant_id, ids=user_ids, roles=roles)
    except tenant_client.TenantServiceUnavailable:
        raise ApiError(503, "DIRECTORY_UNAVAILABLE", "The user directory can't be reached. Try again shortly.")
    return [u for u in users
            if u.get("is_active") and u.get("tenant_id") == str(tenant_id)
            and u.get("role_name") in rtype.review_roles and (exclude is None or u["id"] != str(exclude))]


async def find_rule(conn: AsyncConnection, tenant_id: UUID, request_type: str, branch_id: Optional[UUID]) -> Optional[dict]:
    row = (await conn.execute(text("""
        SELECT * FROM routing_rules
        WHERE tenant_id = :tenant AND request_type = :type AND is_active
          AND (branch_id IS NULL OR branch_id = :branch)
        ORDER BY (branch_id IS NULL) ASC
        LIMIT 1
    """), {"tenant": tenant_id, "type": request_type, "branch": branch_id})).mappings().first()
    return dict(row) if row else None


async def tenant_admin_names(tenant_id: UUID) -> list[str]:
    """Who can fix routing, so a requester knows whom to ask. Best effort: an unreachable directory just means no names."""
    try:
        users = await tenant_client.get_client().users(tenant_id, roles=["Admin"])
    except tenant_client.TenantServiceUnavailable:
        return []
    return sorted(u["full_name"] for u in users if u.get("is_active"))[:5]


async def resolve(conn: AsyncConnection, tenant_id: UUID, rtype: RequestType, branch_id: Optional[UUID], requester_id: UUID) -> Route:
    rule = await find_rule(conn, tenant_id, rtype.code, branch_id)
    if not rule:
        admins = await tenant_admin_names(tenant_id)
        who = f"Ask {' or '.join(admins)} (tenant administrator) to set up routing for it." if admins else "Ask your administrator to configure routing."
        raise routing_failed(f"No reviewer is set up for “{rtype.label}” requests yet. {who}",
                             request_type=rtype.code, branch_id=str(branch_id) if branch_id else None, administrators=admins)
    now = datetime.now(timezone.utc)
    if rule["target_kind"] == "USER":
        if rule["target_user_id"] == requester_id:
            raise routing_failed("This request would be routed to you, and nobody may review their own request. Ask your administrator to adjust routing.")
        matches = await eligible_reviewers(tenant_id, rtype, user_ids=[rule["target_user_id"]], exclude=requester_id)
        if not matches:
            raise routing_failed("The reviewer configured for this request type is no longer active or eligible. Ask your administrator to update routing.",
                                 rule_id=str(rule["id"]))
        reviewer = matches[0]
        assignee_id, assignee_name, queue_role, candidates = UUID(reviewer["id"]), reviewer["full_name"], None, 1
    else:
        if rule["target_role"] not in rtype.review_roles:
            raise routing_failed("The team configured for this request type may not review it. Ask your administrator to update routing.")
        members = await eligible_reviewers(tenant_id, rtype, role=rule["target_role"], exclude=requester_id)
        if not members:
            raise routing_failed(f"No active {rule['target_role']} other than you can review this request. Ask your administrator to update routing.",
                                 rule_id=str(rule["id"]))
        assignee_id, assignee_name, queue_role, candidates = None, None, rule["target_role"], len(members)
    snapshot = {
        "rule_id": str(rule["id"]), "rule_version": rule["version"], "target_kind": rule["target_kind"],
        "target_label": rule["target_label"], "target_user_id": str(rule["target_user_id"]) if rule["target_user_id"] else None,
        "target_role": rule["target_role"], "rule_branch_id": str(rule["branch_id"]) if rule["branch_id"] else None,
        "request_branch_id": str(branch_id) if branch_id else None, "sla_hours": rule["sla_hours"],
        "eligible_reviewers": candidates, "resolved_at": now.isoformat(),
    }
    return Route(rule["id"], rule["version"], rule["target_kind"], assignee_id, assignee_name, queue_role,
                 now + timedelta(hours=rule["sla_hours"]), snapshot)
