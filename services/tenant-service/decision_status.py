"""AI decision band -> Policy/Case lifecycle status, shared by every router
that routes a batch member through risk-engine (routers/organizations.py's
above-FCL group members, routers/families.py's family members).

Duplicated (not imported) from api-gateway's routers/evaluate.py — these are
separate deployable services, and group_underwriting.py already establishes
the precedent of not sharing risk-engine's rule modules across the service
boundary. Hoisted here (rather than left in organizations.py, where it
originated) once a second router needed the same two dicts — a second copy
was tolerable, a third wasn't.
"""

from typing import Dict

from shared.models.core import CaseStatusEnum, PolicyStatusEnum

DECISION_POLICY_STATUS: Dict[str, PolicyStatusEnum] = {
    "Auto Approve":         PolicyStatusEnum.APPROVED,
    "Approve with Loading": PolicyStatusEnum.APPROVED,
    "Human Review":         PolicyStatusEnum.UNDER_REVIEW,
    "Decline":              PolicyStatusEnum.DECLINED,
}
DECISION_CASE_STATUS: Dict[str, CaseStatusEnum] = {
    "Auto Approve":         CaseStatusEnum.APPROVED,
    "Approve with Loading": CaseStatusEnum.APPROVED,
    "Human Review":         CaseStatusEnum.UNDER_REVIEW,
    "Decline":              CaseStatusEnum.REJECTED,
}

# Conservativeness ranking used when multiple family members' independent AI
# decisions must collapse onto a single shared floater Policy.status (a
# floater has one Policy for N insured lives) — see routers/families.py's
# confirm_floater_members. Lower index = more conservative = wins.
_DECISION_PRECEDENCE = ["Decline", "Human Review", "Approve with Loading", "Auto Approve"]


def most_conservative_decision(decisions: list) -> str:
    """Given every family member's ai_decision string for a floater, return
    the single most conservative one — Decline > Human Review > Approve with
    Loading > Auto Approve — mirroring how a real floater is underwritten:
    any one member's adverse risk affects the whole pool's issuability."""
    return min(decisions, key=_DECISION_PRECEDENCE.index)
