"""
Policy state machine — the single authority on legal status transitions.

Before this module, /issue, /lapse, /cancel and /renew each mutated
``Policy.status`` freely. Every lifecycle endpoint now routes through
``apply_transition()`` here, which:

  1. Validates the transition against the ``_TRANSITIONS`` map (raising
     ``IllegalStateTransition`` if the move is not legal).
  2. Updates ``policy.status`` and ``policy.updated_at``.
  3. Appends an immutable ``PolicyEvent`` row (the SECP audit trail).

Kafka emission is intentionally NOT done here: publishing is a fire-and-forget
side effect that must happen *after* the DB commit, so the router owns it (see
``routers/policies._publish_policy_event``). Keeping this module free of the
Kafka producer also lets the renewal scheduler reuse it without a Request.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional
from uuid import UUID

from shared.models.core import PolicyEvent, PolicyStatusEnum

log = logging.getLogger(__name__)


# ── Legal transition map ──────────────────────────────────────────────────────
# Keys are the *from* status; values are the set of statuses reachable in one
# step. Terminal states (Declined, Lapsed, Cancelled) map to an empty set here;
# note that Lapsed → Active (reinstatement) and the exit states arrive in later
# lifecycle phases and will be added to this single map — nowhere else.

_TRANSITIONS: dict[PolicyStatusEnum, set[PolicyStatusEnum]] = {
    PolicyStatusEnum.QUOTED: {
        PolicyStatusEnum.PROPOSED,
        PolicyStatusEnum.DECLINED,
    },
    PolicyStatusEnum.PROPOSED: {
        PolicyStatusEnum.UNDER_REVIEW,
        PolicyStatusEnum.INFORMATION_REQUESTED,
        PolicyStatusEnum.COUNTER_OFFER,
        PolicyStatusEnum.APPROVED,
        PolicyStatusEnum.ACCEPTED_WITH_LOADINGS,
        PolicyStatusEnum.DECLINED,
    },
    PolicyStatusEnum.UNDER_REVIEW: {
        PolicyStatusEnum.INFORMATION_REQUESTED,
        PolicyStatusEnum.COUNTER_OFFER,
        PolicyStatusEnum.APPROVED,
        PolicyStatusEnum.ACCEPTED_WITH_LOADINGS,
        PolicyStatusEnum.DECLINED,
        PolicyStatusEnum.POSTPONED,
        PolicyStatusEnum.REINSURER_REFERRED,
    },
    PolicyStatusEnum.REINSURER_REFERRED: {
        PolicyStatusEnum.APPROVED,
        PolicyStatusEnum.ACCEPTED_WITH_LOADINGS,
        PolicyStatusEnum.DECLINED,
    },
    PolicyStatusEnum.POSTPONED: {
        PolicyStatusEnum.UNDER_REVIEW,
        PolicyStatusEnum.DECLINED,
    },
    PolicyStatusEnum.INFORMATION_REQUESTED: {
        PolicyStatusEnum.UNDER_REVIEW,
        PolicyStatusEnum.COUNTER_OFFER,
        PolicyStatusEnum.APPROVED,
        PolicyStatusEnum.ACCEPTED_WITH_LOADINGS,
        PolicyStatusEnum.DECLINED,
    },
    # Stage A step 1 — revised terms issued; awaiting the customer's explicit
    # accept/decline. Accept bakes the revised terms and moves to an issuable
    # state; decline / expiry ends the application (NotTakenUp).
    PolicyStatusEnum.COUNTER_OFFER: {
        PolicyStatusEnum.APPROVED,
        PolicyStatusEnum.ACCEPTED_WITH_LOADINGS,
        PolicyStatusEnum.NOT_TAKEN_UP,
        PolicyStatusEnum.DECLINED,
    },
    PolicyStatusEnum.APPROVED: {
        PolicyStatusEnum.PENDING_PAYMENT,
        PolicyStatusEnum.ISSUED,
        PolicyStatusEnum.COUNTER_OFFER,
        PolicyStatusEnum.DECLINED,
        PolicyStatusEnum.CANCELLED,
    },
    # Phase 2 wires the customer accept/decline of a loaded offer; for now the
    # accepted offer is directly issuable, mirroring APPROVED.
    PolicyStatusEnum.ACCEPTED_WITH_LOADINGS: {
        PolicyStatusEnum.PENDING_PAYMENT,
        PolicyStatusEnum.APPROVED,
        PolicyStatusEnum.ISSUED,
        PolicyStatusEnum.COUNTER_OFFER,
        PolicyStatusEnum.DECLINED,
        PolicyStatusEnum.CANCELLED,
    },
    # Legacy transitional state — treat as issuable/bindable.
    PolicyStatusEnum.ISSUED: {
        PolicyStatusEnum.PENDING_PAYMENT,
        PolicyStatusEnum.ACTIVE,
        PolicyStatusEnum.CANCELLED,
    },
    # The heart of Phase 1: cover only goes live once payment is confirmed.
    PolicyStatusEnum.PENDING_PAYMENT: {
        PolicyStatusEnum.ACTIVE,
        PolicyStatusEnum.CANCELLED,
        PolicyStatusEnum.NOT_TAKEN_UP,
    },
    PolicyStatusEnum.ACTIVE: {
        PolicyStatusEnum.ACTIVE,          # renewal rebinds in place
        PolicyStatusEnum.GRACE_PERIOD,
        PolicyStatusEnum.LAPSED,
        PolicyStatusEnum.CANCELLED,
    },
    PolicyStatusEnum.GRACE_PERIOD: {
        PolicyStatusEnum.ACTIVE,          # renewal / arrears paid
        PolicyStatusEnum.LAPSED,
        PolicyStatusEnum.CANCELLED,
    },
    # Terminal (for now) — Phase 4c adds LAPSED → ACTIVE (reinstatement).
    PolicyStatusEnum.LAPSED: set(),
    PolicyStatusEnum.CANCELLED: set(),
    PolicyStatusEnum.DECLINED: set(),
    PolicyStatusEnum.NOT_TAKEN_UP: set(),
}


class IllegalStateTransition(Exception):
    """Raised when a caller attempts a status change the machine forbids."""

    def __init__(self, from_status: PolicyStatusEnum, to_status: PolicyStatusEnum):
        self.from_status = from_status
        self.to_status = to_status
        super().__init__(
            f"Illegal policy transition: {from_status.value} → {to_status.value}"
        )


def _norm(status) -> PolicyStatusEnum:
    """Coerce a str / enum status into a PolicyStatusEnum member."""
    if isinstance(status, PolicyStatusEnum):
        return status
    raw = status.value if hasattr(status, "value") else str(status)
    return PolicyStatusEnum(raw)


def can_transition(from_status, to_status) -> bool:
    frm = _norm(from_status)
    to = _norm(to_status)
    return to in _TRANSITIONS.get(frm, set())


def assert_transition(from_status, to_status) -> None:
    """Raise IllegalStateTransition unless the move is in the legal map."""
    frm = _norm(from_status)
    to = _norm(to_status)
    if to not in _TRANSITIONS.get(frm, set()):
        raise IllegalStateTransition(frm, to)


def record_event(
    session,
    policy,
    *,
    event_type: str,
    from_status: Optional[PolicyStatusEnum] = None,
    to_status: Optional[PolicyStatusEnum] = None,
    actor: str = "system",
    detail: Optional[dict] = None,
) -> PolicyEvent:
    """Append a PolicyEvent to the session (not committed here)."""
    event = PolicyEvent(
        tenant_id=policy.tenant_id,
        policy_id=policy.id,
        event_type=event_type,
        from_status=from_status.value if from_status else None,
        to_status=to_status.value if to_status else None,
        actor=actor,
        detail_json=detail,
    )
    session.add(event)
    return event


def apply_transition(
    session,
    policy,
    to_status: PolicyStatusEnum,
    *,
    event_type: str,
    actor: str = "system",
    detail: Optional[dict] = None,
) -> PolicyEvent:
    """
    Validate + apply a status change and record the audit event in one call.

    Returns the created PolicyEvent. The caller is responsible for the commit
    and for any post-commit Kafka emission.
    """
    from_status = _norm(policy.status)
    to = _norm(to_status)
    assert_transition(from_status, to)

    policy.status = to
    policy.updated_at = datetime.utcnow()
    session.add(policy)

    log.info(
        "Policy %s transition %s → %s (event=%s, actor=%s)",
        getattr(policy, "policy_number", None) or policy.id,
        from_status.value, to.value, event_type, actor,
    )
    return record_event(
        session, policy,
        event_type=event_type,
        from_status=from_status,
        to_status=to,
        actor=actor,
        detail=detail,
    )
