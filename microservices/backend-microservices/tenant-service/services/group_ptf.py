"""Participants' Takaful Fund (PTF) surplus / deficit report for a Group Family Takaful
scheme (GROUP_LIFE_PLAN.md Phase 6).

Under Takaful the employer's contribution is not insurer revenue: after the operator's
Wakala fee, the rest is allocated to a fund owned by the participants, from which a
share is ceded to the retakaful operator and claims are paid. Whatever is left at the
end of a period is the fund's surplus — or, if claims outran it, a deficit that the
operator would cover with a Qard Hassan (interest-free loan). This reports that, per
cover period:

    Wakala fee                            operator income, never part of the fund
    PTF allocation (gross)                contribution − Wakala fee
    − retakaful contribution              ceded to the retakaful operator
    = PTF retained
    − claims incurred                     approved/settled, plus open claims reserved at their face value
    = surplus (+) / deficit (−)

Contributions come from the accepted quote for each period plus the endorsements
effective within it; claims by incident date. Claims are NOT netted against
retakaful recoveries (the platform doesn't model a recovery yet), so a deficit here is
the gross position. Pure arithmetic first; the database read below it.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Optional
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import (
    Claim,
    ClaimStatusEnum,
    GroupEndorsement,
    GroupQuote,
    GroupQuoteStatus,
    GroupRenewal,
    GroupRenewalStatus,
    MasterPolicy,
    Policy,
)

_NO_COST = {ClaimStatusEnum.DECLINED, ClaimStatusEnum.CLOSED}
_APPROVED = {ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL, ClaimStatusEnum.SETTLED}


def fund_position(wakala_fee: float, ptf_gross: float, retakaful: float, claims_incurred: float) -> Dict[str, Any]:
    retained = round(ptf_gross - retakaful, 2)
    result = round(retained - claims_incurred, 2)
    return {
        "wakala_fee": round(wakala_fee, 2), "ptf_gross": round(ptf_gross, 2), "retakaful_contribution": round(retakaful, 2),
        "ptf_retained": retained, "claims_incurred": round(claims_incurred, 2), "result": result,
        "position": "Surplus" if result >= 0 else "Deficit",
        "claims_to_ptf": round(claims_incurred / retained, 4) if retained > 0 else 0.0,
    }


def classify_claim(status: Any, submitted: float, approved: float, settled: Optional[float]) -> Dict[str, float]:
    """(incurred, paid, reserved) for one claim."""
    st = status if isinstance(status, ClaimStatusEnum) else ClaimStatusEnum(str(status))
    if st in _NO_COST:
        return {"incurred": 0.0, "paid": 0.0, "reserved": 0.0}
    if st in _APPROVED:
        return {"incurred": float(approved or submitted), "paid": float(settled or 0), "reserved": 0.0}
    return {"incurred": float(submitted), "paid": 0.0, "reserved": float(submitted)}


async def ptf_report(session: AsyncSession, tenant_id: UUID, mp: MasterPolicy) -> Dict[str, Any]:
    quotes = (await session.exec(select(GroupQuote).where(
        GroupQuote.master_policy_id == mp.id, GroupQuote.status == GroupQuoteStatus.ACCEPTED.value).order_by(GroupQuote.version))).all()
    renewals = (await session.exec(select(GroupRenewal).where(
        GroupRenewal.master_policy_id == mp.id, GroupRenewal.status == GroupRenewalStatus.RENEWED.value).order_by(GroupRenewal.period_no))).all()
    endorsements = (await session.exec(select(GroupEndorsement).where(GroupEndorsement.master_policy_id == mp.id))).all()
    claims = (await session.exec(select(Claim).join(Policy, Policy.id == Claim.policy_id).where(
        Policy.master_policy_id == mp.id, Claim.tenant_id == tenant_id))).all()

    # Period list: the original term, then one per paid renewal.
    periods: List[Dict[str, Any]] = []
    initial = next((q for q in quotes if q.renewal_id is None), None)
    if initial is not None:
        start = renewals[0].current_period_start if renewals else mp.effective_date
        end = renewals[0].current_period_end if renewals else (mp.expiry_date or mp.effective_date)
        periods.append({"label": "Initial term", "start": start, "end": end, "quote": initial})
    by_renewal = {q.renewal_id: q for q in quotes if q.renewal_id is not None}
    for r in renewals:
        q = by_renewal.get(r.id)
        if q is not None:
            periods.append({"label": f"Renewal {r.period_no}", "start": r.new_period_start, "end": r.new_period_end, "quote": q})

    out: List[Dict[str, Any]] = []
    for p in periods:
        q: GroupQuote = p["quote"]
        wakala, ptf, retak = float(q.wakala_fee or 0), float(q.ptf_allocation or 0), float(q.retakaful_contribution or 0)
        for e in endorsements:
            if p["start"] <= e.effective_date <= p["end"]:
                wakala += float(e.wakala_fee_delta or 0)
                ptf += float(e.ptf_delta or 0)
                retak += float(e.retakaful_delta or 0)
        incurred = paid = reserved = 0.0
        count = 0
        for c in claims:
            if c.incident_date and p["start"] <= c.incident_date <= p["end"]:
                k = classify_claim(c.status, c.submitted_amount, c.approved_amount, c.settlement_amount)
                if k["incurred"] or k["paid"]:
                    count += 1
                incurred, paid, reserved = incurred + k["incurred"], paid + k["paid"], reserved + k["reserved"]
        out.append({
            "label": p["label"], "period_start": p["start"].isoformat(), "period_end": p["end"].isoformat(),
            "current": p["start"] <= date.today() <= p["end"], "quote_version": q.version,
            **fund_position(wakala, ptf, retak, incurred),
            "claims_paid": round(paid, 2), "open_reserve": round(reserved, 2), "claim_count": count,
        })
    totals = fund_position(sum(x["wakala_fee"] for x in out), sum(x["ptf_gross"] for x in out),
                           sum(x["retakaful_contribution"] for x in out), sum(x["claims_incurred"] for x in out))
    return {"business_type": "Takaful", "periods": out, "totals": totals,
            "note": "Claims are shown gross — retakaful recoveries aren't modelled. A deficit would be covered by the operator as an interest-free Qard Hassan."}
