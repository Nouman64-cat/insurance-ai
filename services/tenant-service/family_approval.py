"""A family floater is ONE policy for several insured lives — the head and, if the family chose it, a
fully insured spouse. Every insured life goes through its own underwriting case, so the policy can only
be approved (and issued) once all of those cases are approved. This is what makes "the spouse follows the
full underwriting procedure" more than a button: approving the head alone leaves the policy waiting.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import Case, CaseStatusEnum, Customer, Policy

# A case counts as done once it is approved (or closed after issuance).
_DONE = (CaseStatusEnum.APPROVED, CaseStatusEnum.CLOSED)


async def pending_insured_members(
    session: AsyncSession, policy: Policy, exclude_case_id: Optional[UUID] = None,
) -> List[Dict[str, Any]]:
    """The insured lives on this family policy whose underwriting case isn't approved yet."""
    if policy is None or getattr(policy, "family_policy_id", None) is None:
        return []
    rows = (await session.exec(
        select(Case, Customer).join(Customer, Customer.id == Case.customer_id).where(Case.policy_id == policy.id)
    )).all()
    return [
        {
            "name": customer.name, "relationship": getattr(customer.family_relationship, "value", customer.family_relationship),
            "case_id": str(case.caseld), "case_number": case.caseNumber, "case_status": case.caseStatus.value,
        }
        for case, customer in rows
        if case.caseld != exclude_case_id and case.caseStatus not in _DONE
    ]


def waiting_message(pending: List[Dict[str, Any]]) -> str:
    names = ", ".join(f"{p['name']} ({p['case_number']}, {p['case_status']})" for p in pending)
    return f"The family policy is still waiting for the underwriting of: {names}."


# ── Requirements the head's case covers for everyone on the family floater ───────────────────────────
# One proposal, one proposer, one premium: the Agent's Confidential Report is about the proposer (KYC, their
# signature) and the initial premium is a single payment for the shared policy, so an insured spouse's case
# reads both from the head's case instead of asking for them again. PEP screening is already keyed to the
# policy. Everything about the individual life — documents, the health e-application, the insurance-history
# screen and the medical — stays per case. Change this tuple to move a requirement between the two groups.
SHARED_WITH_HEAD = ("acr", "ipp")


async def head_case_ids(session: AsyncSession, cases: List[Case]) -> Dict[UUID, UUID]:
    """case_id -> the head's case id, for each case that is NOT the head's on a shared (floater) family policy."""
    policy_ids = {c.policy_id for c in cases if c.policy_id}
    if not policy_ids:
        return {}
    policies = {p.id: p for p in (await session.exec(
        select(Policy).where(Policy.id.in_(policy_ids), Policy.family_policy_id.is_not(None))
    )).all()}
    others = [c for c in cases if c.policy_id in policies and c.customer_id != policies[c.policy_id].customer_id]
    if not others:
        return {}
    heads = {}
    for case in (await session.exec(
        select(Case).where(Case.policy_id.in_({c.policy_id for c in others}))
        .order_by(Case.createdAt)
    )).all():
        pol = policies.get(case.policy_id)
        if pol is not None and case.customer_id == pol.customer_id:
            heads.setdefault(case.policy_id, case.caseld)
    return {c.caseld: heads[c.policy_id] for c in others if c.policy_id in heads}


async def owner_case_id(session: AsyncSession, case: Case, requirement: str) -> UUID:
    """The case that holds this requirement for `case`: the head's, if the head's case covers it, else its own."""
    if requirement not in SHARED_WITH_HEAD:
        return case.caseld
    return (await head_case_ids(session, [case])).get(case.caseld, case.caseld)
