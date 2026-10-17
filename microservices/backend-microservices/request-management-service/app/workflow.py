"""The request lifecycle: which action may move a request from which status, and who may take it.

Review and execution are tracked separately:

  review_status     DRAFT → SUBMITTED → IN_REVIEW → APPROVED | REJECTED
                    SUBMITTED/IN_REVIEW → NEEDS_INFORMATION → SUBMITTED (resubmitted as a new revision)
                    any open status → CANCELLED (by the requester, before a final decision)
  execution_status  NOT_APPLICABLE (nothing to execute, or not approved yet)
                    APPROVED + executing type → PENDING → RUNNING → SUCCEEDED | FAILED (FAILED → PENDING on retry)

One deliberate exception to "approved is final": when execution failed because the record changed after review
(CONFLICT), a reviewer may reopen the request (APPROVED → NEEDS_INFORMATION) so the requester resubmits against the
current record and it is reviewed again. The first approval stays in the history; the new one references the new
revision.

Every action is checked here and again inside its database transaction, with the row locked.
"""
from dataclasses import dataclass
from typing import Optional

from app.identity import Identity
from app.permissions import is_tenant_admin
from app.types.registry import RequestType, get_type

OPEN = frozenset({"SUBMITTED", "IN_REVIEW", "NEEDS_INFORMATION"})
FINAL = frozenset({"APPROVED", "REJECTED", "CANCELLED"})

# action: (allowed review statuses, resulting review status or None to keep)
TRANSITIONS: dict[str, tuple[frozenset[str], Optional[str]]] = {
    "edit_draft":           (frozenset({"DRAFT", "NEEDS_INFORMATION"}), None),  # after NEEDS_INFORMATION: a new revision
    "submit":               (frozenset({"DRAFT"}), "SUBMITTED"),
    "resubmit":             (frozenset({"NEEDS_INFORMATION"}), "SUBMITTED"),
    "start_review":         (frozenset({"SUBMITTED"}), "IN_REVIEW"),
    "release":              (frozenset({"IN_REVIEW"}), "SUBMITTED"),
    "request_information":  (frozenset({"SUBMITTED", "IN_REVIEW"}), "NEEDS_INFORMATION"),
    "approve":              (frozenset({"IN_REVIEW"}), "APPROVED"),
    "reject":               (frozenset({"IN_REVIEW"}), "REJECTED"),
    "cancel":               (frozenset({"DRAFT", "SUBMITTED", "IN_REVIEW", "NEEDS_INFORMATION"}), "CANCELLED"),
    "reassign":             (OPEN, None),
    "retry_execution":      (frozenset({"APPROVED"}), None),
    "reopen_for_review":    (frozenset({"APPROVED"}), "NEEDS_INFORMATION"),
}

EXECUTION_TRANSITIONS: dict[str, frozenset[str]] = {
    # target: allowed sources
    "PENDING": frozenset({"NOT_APPLICABLE", "RUNNING", "FAILED"}),
    "RUNNING": frozenset({"PENDING"}),
    "SUCCEEDED": frozenset({"RUNNING"}),
    "FAILED": frozenset({"RUNNING", "PENDING"}),
    "NOT_APPLICABLE": frozenset({"FAILED"}),
}


def status_allows(action: str, review_status: str) -> bool:
    allowed, _ = TRANSITIONS[action]
    return review_status in allowed


def next_status(action: str, current: str) -> str:
    _, target = TRANSITIONS[action]
    return target or current


def execution_can_move(source: str, target: str) -> bool:
    return source in EXECUTION_TRANSITIONS.get(target, frozenset())


@dataclass(frozen=True)
class Relation:
    """How the caller relates to one request."""
    is_requester: bool
    is_assignee: bool
    in_queue: bool          # their role owns the request's unclaimed queue and may review this type
    is_admin: bool          # tenant administrator (of this tenant: requests are only ever loaded within it)
    can_review_type: bool

    @property
    def can_view(self) -> bool:
        return self.is_requester or self.is_assignee or self.in_queue or self.is_admin

    @property
    def sees_internal(self) -> bool:
        # A requester never sees internal reviewer notes on their own request, whatever else their role allows.
        return not self.is_requester and (self.is_assignee or self.in_queue or self.is_admin)


def relation(identity: Identity, req: dict, decided_by_me: bool = False) -> Relation:
    rtype: RequestType = get_type(req["request_type"])
    can_review_type = identity.role in rtype.review_roles
    is_requester = req["requester_id"] == identity.user_id
    is_assignee = req.get("assignee_user_id") == identity.user_id and not is_requester
    in_queue = (not is_requester and can_review_type and req.get("queue_role") == identity.role
                and req.get("assignee_user_id") is None and req["review_status"] in OPEN)
    return Relation(
        is_requester=is_requester,
        is_assignee=is_assignee or (decided_by_me and not is_requester),
        in_queue=in_queue,
        is_admin=is_tenant_admin(identity.role),
        can_review_type=can_review_type,
    )


def may(action: str, identity: Identity, req: dict, rel: Relation, execution: Optional[dict] = None) -> bool:
    """Whether this caller may take `action` now. Status, role, assignment and separation of duties."""
    status = req["review_status"]
    if not status_allows(action, status):
        return False
    rtype = get_type(req["request_type"])
    reviewer_here = rel.can_review_type and not rel.is_requester
    if action == "submit":
        return rel.is_requester and identity.role in rtype.submit_roles
    if action == "edit_draft":
        return rel.is_requester and (status == "NEEDS_INFORMATION" or identity.role in rtype.submit_roles)
    if action in ("resubmit", "cancel"):
        return rel.is_requester
    if action == "start_review":
        # The routed reviewer, or anyone in the owning queue (claiming it).
        return reviewer_here and (req.get("assignee_user_id") == identity.user_id or rel.in_queue)
    if action == "release":
        return reviewer_here and req.get("assignee_user_id") == identity.user_id and req.get("queue_role") is not None
    if action in ("request_information", "approve", "reject"):
        if not reviewer_here or req.get("assignee_user_id") != identity.user_id:
            return False
        return action == "request_information" or status == "IN_REVIEW"
    if action == "reassign":
        return rel.is_admin and not rel.is_requester
    if action == "retry_execution":
        return (execution is not None and execution["status"] == "FAILED" and execution.get("last_error_code") != "CONFLICT"
                and not rel.is_requester and (rel.is_admin or (reviewer_here and req.get("decided_by") == identity.user_id)))
    if action == "reopen_for_review":
        return (execution is not None and execution["status"] == "FAILED" and execution.get("last_error_code") == "CONFLICT"
                and not rel.is_requester and (rel.is_admin or (reviewer_here and req.get("decided_by") == identity.user_id)))
    return False


ACTIONS_FOR_UI = ("edit_draft", "submit", "resubmit", "start_review", "release", "request_information",
                  "approve", "reject", "cancel", "reassign", "retry_execution", "reopen_for_review")


def allowed_actions(identity: Identity, req: dict, rel: Relation, execution: Optional[dict]) -> list[str]:
    return [a for a in ACTIONS_FOR_UI if may(a, identity, req, rel, execution)]
