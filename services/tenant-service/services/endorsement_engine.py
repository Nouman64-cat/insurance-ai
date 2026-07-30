"""
Endorsement engine — turns a mid-term change into a new PolicyVersion (1.x) plus
a PolicyEndorsement record.

Router-free so post_issuance.py can call it. The router owns committing, the
PolicyEvent audit row and the Kafka publish; this module only builds the version
+ endorsement rows on the session (mirrors the rest of the codebase).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import Policy, PolicyEndorsement, PolicyVersion


async def _current_version(session: AsyncSession, policy: Policy) -> Optional[PolicyVersion]:
    if policy.current_version_id:
        v = await session.get(PolicyVersion, policy.current_version_id)
        if v:
            return v
    return (await session.exec(
        select(PolicyVersion).where(PolicyVersion.policy_id == policy.id)
        .order_by(PolicyVersion.created_at.desc())  # type: ignore[arg-type]
    )).first()


def _next_version_number(current: Optional[PolicyVersion]) -> str:
    """Bump the minor (endorsement) component: 1.0 -> 1.1 -> 1.2 ..."""
    if not current or not current.version_number:
        return "1.1"
    try:
        major, minor = current.version_number.split(".")
        return f"{int(major)}.{int(minor) + 1}"
    except (ValueError, AttributeError):
        return "1.1"


async def _next_endorsement_no(session: AsyncSession, policy: Policy) -> str:
    rows = (await session.exec(
        select(PolicyEndorsement).where(PolicyEndorsement.policy_id == policy.id)
    )).all()
    return f"E{len(rows) + 1}"


async def create_endorsement(
    session: AsyncSession,
    policy: Policy,
    *,
    etype: str,                 # Nominee | Address | SumAssured | Rider
    summary: str,
    actor: Optional[str] = None,
    breakdown=None,             # PricingBreakdown for financial changes; None keeps current premium
    premium_delta: float = 0.0,
    detail: Optional[dict] = None,
) -> PolicyEndorsement:
    """Create the endorsement version + record. Caller commits and audits."""
    current = await _current_version(session, policy)
    today = date.today()

    # Close the currently-active version.
    if current is not None and current.effective_to is None:
        current.effective_to = today
        session.add(current)

    # Premium for the new version: re-priced (financial) or carried over.
    if breakdown is not None:
        prem = dict(base_premium=breakdown.base_premium, loading_amount=breakdown.loading_amount,
                    policy_fee=breakdown.policy_fee, tax_amount=breakdown.tax_amount,
                    total_premium=breakdown.total_premium)
        loadings_json = {"rating_basis": getattr(breakdown, "rating_basis", "")}
    elif current is not None:
        prem = dict(base_premium=current.base_premium, loading_amount=current.loading_amount,
                    policy_fee=current.policy_fee, tax_amount=current.tax_amount,
                    total_premium=current.total_premium)
        loadings_json = current.loadings_json
    else:
        prem = dict(base_premium=0.0, loading_amount=0.0, policy_fee=0.0, tax_amount=0.0, total_premium=0.0)
        loadings_json = None

    version = PolicyVersion(
        policy_id=policy.id,
        version_number=_next_version_number(current),
        effective_from=today,
        effective_to=None,
        loadings_json=loadings_json,
        exclusions_json=current.exclusions_json if current else None,
        created_by=actor or "servicing-officer",
        event_type="Endorsement",
        **prem,
    )
    session.add(version)
    await session.flush()  # need version.id for the endorsement FK

    policy.current_version_id = version.id
    session.add(policy)

    endorsement = PolicyEndorsement(
        tenant_id=policy.tenant_id,
        policy_id=policy.id,
        endorsement_no=await _next_endorsement_no(session, policy),
        endorsement_type=etype,
        summary=summary,
        effective_date=today,
        old_version_id=current.id if current else None,
        new_version_id=version.id,
        premium_delta=round(premium_delta, 2),
        detail_json=detail,
        actor=actor or "servicing-officer",
    )
    session.add(endorsement)
    return endorsement
