"""
Persisting an AI underwriting result — shared by both evaluation paths.

Two paths produce a risk result and both must write it down identically:

  • ``POST /evaluate/stream`` (routers/evaluate.py) — synchronous SSE, what the
    Case Detail screen calls.
  • ``risk_result_worker.py`` — the Kafka consumer for
    ``insurance.risk.evaluated.v1``, which is where the fire-and-forget
    ``POST /evaluate`` path lands.

Before this module existed only the streaming path persisted anything at all:
the async path published a RiskEvaluatedEvent that no service subscribed to, so
every result submitted through ``POST /evaluate`` was computed and dropped.
Keeping the write in one place is what stops the two paths drifting again.
"""

from __future__ import annotations

import logging
from typing import Any, Optional
from uuid import UUID

from sqlmodel import select

from shared.models.core import (
    ActionTypeEnum,
    AIDecision,
    Case,
    CaseHistory,
    CaseStatusEnum,
    Customer,
    Policy,
    PolicyStatusEnum,
    RiskAssessment,
    User,
)
from shared.services.policy_state_machine import IllegalStateTransition, apply_transition

log = logging.getLogger(__name__)


# AI decision band -> Policy/Case lifecycle status. The AI's decision is only
# ever a recommendation surfaced to the underwriter (via RiskAssessment.ai_decision
# and the case's reasons) — it never finalizes Approved/Declined itself. Every
# band parks the case/policy at Under Review so a human always makes the actual
# Approve/Decline call via the case's Override buttons (tenant-service
# routers/cases.py::update_case_status), which is what drives it into the
# Policy Issuance queue.
DECISION_POLICY_STATUS: dict[str, PolicyStatusEnum] = {
    "Auto Approve":         PolicyStatusEnum.UNDER_REVIEW,
    "Approve with Loading": PolicyStatusEnum.UNDER_REVIEW,
    "Human Review":         PolicyStatusEnum.UNDER_REVIEW,
    "Decline":              PolicyStatusEnum.UNDER_REVIEW,
}
DECISION_CASE_STATUS: dict[str, CaseStatusEnum] = {
    "Auto Approve":         CaseStatusEnum.UNDER_REVIEW,
    "Approve with Loading": CaseStatusEnum.UNDER_REVIEW,
    "Human Review":         CaseStatusEnum.UNDER_REVIEW,
    "Decline":              CaseStatusEnum.UNDER_REVIEW,
}


def _status_value(policy: Policy) -> str:
    return policy.status.value if hasattr(policy.status, "value") else str(policy.status)


async def apply_ai_policy_status(db, policy: Policy, ai_decision: str, actor: str = "risk-engine") -> None:
    """Park the policy at the status this AI decision implies.

    A policy that has never been formally proposed is still ``Quoted``, and
    ``Quoted → UnderReview`` is not a legal move (see
    shared/services/policy_state_machine.py) — a quote has to be *proposed*
    first. That step is taken here rather than letting the illegal jump fail
    silently, which used to leave Live Evaluation policies sitting at Quoted
    with a completed RiskAssessment attached to them.
    """
    target = DECISION_POLICY_STATUS.get(ai_decision)
    if target is None:
        return

    if _status_value(policy) == PolicyStatusEnum.QUOTED.value:
        try:
            apply_transition(
                db, policy, PolicyStatusEnum.PROPOSED,
                event_type="proposal_opened", actor=actor,
                detail={"reason": "AI evaluation run against an indicative quote"},
            )
        except IllegalStateTransition as exc:
            log.warning("Could not promote quote %s to Proposed: %s", policy.id, exc)
            return

    if _status_value(policy) == target.value:
        return      # already there — re-asserting is not a real transition

    try:
        apply_transition(
            db, policy, target,
            event_type="ai_decision", actor=actor,
            detail={"ai_decision": ai_decision},
        )
    except IllegalStateTransition as exc:
        # Policy already moved on (e.g. re-evaluated after issuance) — keep the
        # assessment, but don't force an illegal jump.
        log.warning("Skipped AI auto-transition for policy %s: %s", policy.id, exc)


async def apply_ai_case_status(db, tenant_id: UUID, case: Case, ai_decision: str) -> None:
    """Move the case to the status this AI decision implies, with history."""
    new_case_status = DECISION_CASE_STATUS.get(ai_decision)
    if new_case_status is None or new_case_status == case.caseStatus:
        return

    system_user = (await db.exec(select(User).where(User.tenant_id == tenant_id))).first()
    if system_user is not None:
        db.add(CaseHistory(
            caseld=case.caseld,
            actionType=ActionTypeEnum.DECISION,
            fromStatus=case.caseStatus.value,
            toStatus=new_case_status.value,
            changedBy=system_user.id,
            systemGeneratedFlag=True,
        ))
    case.caseStatus = new_case_status
    db.add(case)


async def persist_assessment(
    db,
    tenant_id: UUID,
    *,
    customer: Customer,
    policy: Policy,
    case: Optional[Case],
    final_risk: dict[str, Any],
    ai_summary: Optional[str] = None,
    actor: str = "risk-engine",
) -> RiskAssessment:
    """Write the RiskAssessment and advance the policy/case. Does NOT commit —
    the caller owns the transaction boundary.

    NOTE: the customer is deliberately NOT promoted to POLICYHOLDER here. That
    only happens once cover actually binds — see tenant-service
    routers/policies.py::_bind_cover, reached from payment confirmation.
    """
    assessment = RiskAssessment(
        tenant_id=tenant_id,
        customer_id=customer.id,
        policy_id=policy.id,
        case_id=case.caseld if case else None,
        medical_score=final_risk["medical_score"],
        financial_score=final_risk["financial_score"],
        fraud_probability=final_risk["fraud_probability"],
        composite_risk_score=final_risk.get("composite_risk_score"),
        ai_decision=AIDecision(final_risk["ai_decision"]),
        suggested_loading=final_risk.get("suggested_loading"),
        reasons=final_risk.get("reasons"),
        medical_reasons=final_risk.get("medical_reasons"),
        financial_reasons=final_risk.get("financial_reasons"),
        fraud_reasons=final_risk.get("fraud_reasons"),
        ai_summary=ai_summary,
    )
    db.add(assessment)

    await apply_ai_policy_status(db, policy, final_risk["ai_decision"], actor=actor)
    if case is not None:
        await apply_ai_case_status(db, tenant_id, case, final_risk["ai_decision"])

    return assessment
