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
