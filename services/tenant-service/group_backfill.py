"""Backfill for master policies that went Active before group issuance existed
(GROUP_LIFE_PLAN.md Phase 2).

Seed/dev schemes marked Active under the old census-only flow have no master
policy number, expiry date or quote, so none of the issuance-era endpoints can
read them. For each such scheme this:

  * allocates the master policy number (GL-/GT-YYYY-NNNN) and sets expiry_date;
  * numbers any certificate that has no number yet — existing numbers are kept;
  * records a reconstructed Accepted quote (version 1, flagged
    breakdown["legacy_backfill"]) priced from the current roster, so the quote,
    schedule and renewal paths have terms to read — and fills each member's
    annual_premium from it when empty.

Nothing about cover, status or money changes. Schemes with an above-FCL member
still awaiting a decision can't be priced and are reported and skipped; an empty
roster is numbered but gets no quote.
Idempotent: a scheme that already has a number is left alone.

Dry run by default:
    docker compose exec tenant-service python group_backfill.py            # report only
    docker compose exec tenant-service python group_backfill.py --apply    # write
"""

import asyncio
import sys
from datetime import timedelta
from typing import Any, Dict, List, Optional
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from group_pricing import price_group, takaful_quote_fields, takaful_split
from routers.group_policies import (
    _add_years,
    _business_type,
    _member_rows,
    _next_master_policy_number,
    _plan_for,
    _roster_fingerprint,
    _scheme_lives,
)
from routers.organizations import _FALLBACK_GROUP_RATE
from shared.models.core import GroupMemberDependent, GroupQuote, GroupQuoteStatus, MasterPolicy, Organization

LEGACY_DECIDER = "legacy-backfill"


async def backfill_legacy_master_policies(
    session: AsyncSession, *, apply: bool = False, tenant_id: Optional[UUID] = None,
) -> List[Dict[str, Any]]:
    """Returns one report row per Active master policy that has no policy number
    (all tenants, or just `tenant_id`)."""
    stmt = (
        select(MasterPolicy)
        .where(MasterPolicy.status == "Active", MasterPolicy.policy_number.is_(None))  # type: ignore[union-attr]
        .order_by(MasterPolicy.created_at)
    )
    if tenant_id is not None:
        stmt = stmt.where(MasterPolicy.tenant_id == tenant_id)
    legacy = (await session.exec(stmt)).all()

    report: List[Dict[str, Any]] = []
    for mp in legacy:
        org = await session.get(Organization, mp.organization_id)
        row: Dict[str, Any] = {"master_policy_id": str(mp.id), "organization": org.name if org else None}

        has_quote = (await session.exec(select(GroupQuote.id).where(GroupQuote.master_policy_id == mp.id))).first()
        lives, _outcomes, pending = await _scheme_lives(mp, session)
        if pending:
            report.append({**row, "action": "skipped", "reason": "members awaiting an underwriting decision"})
            continue

        plan = await _plan_for(mp, session)
        business_type = _business_type(plan)
        # An empty roster (a scheme created but never enrolled) still gets its number and
        # expiry; there is nothing to price, so no quote is reconstructed for it.
        priceable = bool(lives) and sum(l.sum_assured for l in lives) > 0
        pricing = price_group(lives, plan.base_premium_rate if plan is not None else _FALLBACK_GROUP_RATE) if priceable else None
        split = takaful_split(pricing.risk_premium, plan.wakala_fee_pct if plan is not None else None,
                              plan.retakaful_share_pct if plan is not None else None) \
            if pricing is not None and business_type == "Takaful" else None

        number = await _next_master_policy_number(session, mp.tenant_id, business_type)
        expiry = mp.expiry_date or (_add_years(mp.effective_date, mp.term_years) - timedelta(days=1))
        rows = await _member_rows(mp, session)
        numbered = 0
        for seq, (member, _customer, policy) in enumerate(rows, start=1):
            if policy is not None and not policy.policy_number:
                policy.policy_number = f"{number}/{seq:04d}"
                session.add(policy)
                numbered += 1
            if pricing is not None and member.annual_premium is None and str(member.id) in pricing.by_life:
                dependents = (await session.exec(
                    select(GroupMemberDependent).where(GroupMemberDependent.group_member_id == member.id)
                )).all()
                member.annual_premium = round(
                    pricing.by_life[str(member.id)] + sum(pricing.by_life.get(str(d.id), 0.0) for d in dependents), 2)
                session.add(member)

        mp.policy_number = number
        mp.expiry_date = expiry
        session.add(mp)

        if pricing is not None and not has_quote:
            breakdown = pricing.model_dump()
            breakdown["covered"] = _roster_fingerprint(lives)
            breakdown["adjusted_members"] = []
            breakdown["legacy_backfill"] = True
            if split is not None:
                breakdown["takaful"] = split.model_dump()
            session.add(GroupQuote(
                tenant_id=mp.tenant_id, master_policy_id=mp.id, version=1,
                status=GroupQuoteStatus.ACCEPTED.value, business_type=business_type,
                valid_until=mp.effective_date,
                member_count=pricing.member_count, dependent_count=pricing.dependent_count,
                total_sum_assured=pricing.total_sum_assured, rate_per_mille=pricing.rate_per_mille,
                risk_premium=pricing.risk_premium, policy_fee=pricing.policy_fee, stamp_duty=pricing.stamp_duty,
                total_premium=pricing.total_premium,
                **takaful_quote_fields(split),
                breakdown=breakdown, decided_at=mp.issued_at or mp.created_at, decided_by=LEGACY_DECIDER,
                decision_notes="Reconstructed from the roster when the scheme was backfilled.",
            ))

        await session.flush()  # so the next scheme's number allocation sees this one
        report.append({**row, "action": "backfilled" if apply else "would backfill", "policy_number": number,
                       "expiry_date": str(expiry), "certificates_numbered": numbered,
                       "quote_created": pricing is not None and not has_quote,
                       "annual_total": pricing.total_premium if pricing is not None else None})

    if apply:
        await session.commit()
    else:
        await session.rollback()
    return report


async def _main(apply: bool) -> None:
    from database import _session_factory

    async with _session_factory() as session:
        report = await backfill_legacy_master_policies(session, apply=apply)
    if not report:
        print("No legacy Active master policies without a policy number.")
    for r in report:
        print(r)
    print(f"\n{'Applied' if apply else 'Dry run — nothing written (use --apply)'}: {len(report)} scheme(s).")


if __name__ == "__main__":
    asyncio.run(_main("--apply" in sys.argv))
