"""Annual renewal of an in-force group scheme (GROUP_LIFE_PLAN.md Phase 5).

    scheduler / admin ──▶ OPEN ──census refresh──▶ ──quote──▶ QUOTED ──accept──▶ ACCEPTED ──payment──▶ RENEWED
                                                              │ decline                         (next period starts)
                                                              ▼
                                                           DECLINED          LAPSED if the period ends unrenewed

What a renewal does that a new quote doesn't:

  Experience. The expiring period's claims are set against the premium earned. A
  loss ratio above target loads the renewal rate, below it discounts it, in
  proportion to how much the group's own experience can be trusted (credibility
  grows with size). See experience_factor() — the bands are v1 placeholders in the
  spirit of group_pricing.py, not an actuarial filing.

  Census refresh. The employer's updated workforce list is diffed against the
  roster; joiners, leavers (only if asked) and salary/grade/class changes become
  ordinary endorsements through services/group_endorsement_engine.py, so the
  roster is current before it is re-priced.

  Re-quote. The refreshed roster is priced for the next period — ages at its start,
  the experience factor on the rate — as a GroupQuote tied to the renewal. Accepting
  it never touches the master policy's status; the scheme stays Active throughout.

  Payment. Recording the renewal premium starts the next period: master policy and
  certificate dates move, member premium shares are re-based on the renewal quote,
  and each certificate gets a GroupRenewed event.

The period arithmetic and rating are pure and first; the database work follows.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from group_pricing import PricedLife, price_group, takaful_quote_fields, takaful_split
from group_underwriting import normalize_cnic
from routers.group_policies import (
    _FALLBACK_GROUP_RATE,
    _add_years,
    _business_type,
    _member_rows,
    _plan_for,
    _roster_fingerprint,
    _scheme_lives,
    _st,
    _tenant_name,
)
from routers.organizations import _benefit_classes, _get_organization
from services.group_documents import generate_group_quote, generate_master_schedule
from services.group_endorsement_engine import (
    EndorsementError,
    create_endorsement,
    load_scheme as load_endorsement_scheme,
    preview_endorsement,
)
from shared.models.core import (
    Claim,
    ClaimStatusEnum,
    Customer,
    GroupBenefitClass,
    GroupEndorsement,
    GroupMember,
    GroupMemberDependent,
    GroupMemberStatus,
    GroupQuote,
    GroupQuoteStatus,
    GroupRenewal,
    GroupRenewalStatus,
    MasterPolicy,
    Policy,
    PolicyEvent,
    PolicyStatusEnum,
)
from shared.services.policy_state_machine import apply_transition

log = logging.getLogger("tenant-service.group-renewal")

RENEWAL_LEAD_DAYS = int(os.environ.get("GROUP_RENEWAL_LEAD_DAYS", "60"))        # the scheduler opens renewals this early
RENEWAL_WINDOW_DAYS = int(os.environ.get("GROUP_RENEWAL_WINDOW_DAYS", "120"))   # an admin may start one this early
RENEWAL_GRACE_DAYS = int(os.environ.get("GROUP_RENEWAL_GRACE_DAYS", "30"))      # after expiry, before a renewal lapses
TARGET_LOSS_RATIO = float(os.environ.get("GROUP_TARGET_LOSS_RATIO", "0.60"))
QUOTE_VALIDITY_DAYS = int(os.environ.get("GROUP_QUOTE_VALIDITY_DAYS", "30"))

_OPEN_STATES = {GroupRenewalStatus.OPEN.value, GroupRenewalStatus.QUOTED.value, GroupRenewalStatus.ACCEPTED.value}
_FACTOR_FLOOR, _FACTOR_CAP = 0.85, 1.50
_CREDIBILITY_FULL_AT = 250          # members at which a group's own experience is fully trusted
_MIN_ELAPSED = 0.25                 # never judge a year on less than a quarter of it


class RenewalError(Exception):
    def __init__(self, message: str, status: int = 409, detail: Any = None):
        super().__init__(message)
        self.status, self.detail = status, detail if detail is not None else message


# ═══════════════════════════════════════════════════════════════════════════
# Pure rules
# ═══════════════════════════════════════════════════════════════════════════

def next_period(expiry: date) -> Tuple[date, date]:
    """The year that follows a period ending `expiry`."""
    start = expiry + timedelta(days=1)
    return start, _add_years(start, 1) - timedelta(days=1)


def credibility(member_count: int) -> float:
    """How far a group's own claims can be trusted: square-root rule, full at 250 members."""
    return round(min(1.0, math.sqrt(max(member_count, 0) / _CREDIBILITY_FULL_AT)), 4)


def experience_factor(loss_ratio: float, member_count: int, target: float = TARGET_LOSS_RATIO) -> Dict[str, float]:
    """Rate adjustment from the expiring year's experience.

        raw    = loss ratio ÷ target, held between 0.85 and 1.50
        factor = 1 + credibility × (raw − 1)

    A small group barely moves (its year says little); a large one moves most of the way."""
    raw = min(_FACTOR_CAP, max(_FACTOR_FLOOR, loss_ratio / target)) if target > 0 else 1.0
    z = credibility(member_count)
    return {"raw_factor": round(raw, 4), "credibility": z, "factor": round(1 + z * (raw - 1), 4)}


def elapsed_fraction(start: date, end: date, today: date) -> float:
    period = (end - start).days + 1
    done = (min(today, end) - start).days + 1
    return round(min(1.0, max(_MIN_ELAPSED, done / period)), 4)


# ═══════════════════════════════════════════════════════════════════════════
# Experience
# ═══════════════════════════════════════════════════════════════════════════

_NO_COST = {ClaimStatusEnum.DECLINED, ClaimStatusEnum.CLOSED}
_PAID_OR_APPROVED = {ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL, ClaimStatusEnum.SETTLED}


async def compute_experience(session: AsyncSession, mp: MasterPolicy, today: date) -> Dict[str, Any]:
    """The expiring period's premium earned against its claims. Open claims are reserved
    at their submitted amount; declined ones cost nothing."""
    start, end = mp.effective_date, mp.expiry_date or mp.effective_date
    quote = (await session.exec(select(GroupQuote).where(
        GroupQuote.master_policy_id == mp.id, GroupQuote.status == GroupQuoteStatus.ACCEPTED.value)
        .order_by(GroupQuote.version.desc()))).first()
    endorsements = (await session.exec(select(GroupEndorsement).where(
        GroupEndorsement.master_policy_id == mp.id, GroupEndorsement.effective_date >= start, GroupEndorsement.effective_date <= end))).all()
    annual_risk = float(quote.risk_premium) if quote else 0.0
    endorsed = sum(float(e.risk_delta) for e in endorsements)
    fraction = elapsed_fraction(start, end, today)
    earned = round(annual_risk * fraction + endorsed, 2)

    claims = (await session.exec(
        select(Claim).join(Policy, Policy.id == Claim.policy_id).where(
            Policy.master_policy_id == mp.id, Claim.tenant_id == mp.tenant_id,
            Claim.incident_date >= start, Claim.incident_date <= max(today, end)))).all()
    incurred = paid = reserve = 0.0
    for c in claims:
        status = c.status if isinstance(c.status, ClaimStatusEnum) else ClaimStatusEnum(str(c.status))
        if status in _NO_COST:
            continue
        if status in _PAID_OR_APPROVED:
            amount = float(c.approved_amount or c.submitted_amount)
            incurred += amount
            paid += float(c.settlement_amount or 0)
        else:
            reserve += float(c.submitted_amount)
            incurred += float(c.submitted_amount)
    members = (await session.exec(select(GroupMember.id).where(
        GroupMember.master_policy_id == mp.id, GroupMember.status == GroupMemberStatus.ACTIVE.value))).all()
    ratio = round(incurred / earned, 4) if earned > 0 else 0.0
    rating = experience_factor(ratio, len(members))
    return {
        "premium_earned": earned, "elapsed_fraction": fraction, "claims_incurred": round(incurred, 2), "claims_paid": round(paid, 2),
        "open_reserve": round(reserve, 2), "claim_count": sum(1 for c in claims if c.status not in _NO_COST),
        "claims_ratio": ratio, "target_loss_ratio": TARGET_LOSS_RATIO, "member_count": len(members), **rating,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Starting and refreshing
# ═══════════════════════════════════════════════════════════════════════════

async def _scheme(session: AsyncSession, tenant_id: UUID, org_id: UUID, mp_id: UUID) -> MasterPolicy:
    mp = await session.get(MasterPolicy, mp_id)
    if mp is None or mp.tenant_id != tenant_id or mp.organization_id != org_id:
        raise RenewalError("Master policy not found.", 404)
    return mp


async def get_renewal(session: AsyncSession, tenant_id: UUID, mp_id: UUID, renewal_id: UUID) -> GroupRenewal:
    r = await session.get(GroupRenewal, renewal_id)
    if r is None or r.tenant_id != tenant_id or r.master_policy_id != mp_id:
        raise RenewalError("Renewal not found.", 404)
    return r


async def open_renewal(session: AsyncSession, mp: MasterPolicy, *, today: Optional[date] = None, source: str = "Manual",
                       notes: Optional[str] = None, enforce_window: bool = True) -> GroupRenewal:
    """Start a renewal for the period that is about to end. One open renewal per period."""
    today = today or date.today()
    if mp.status != "Active" or not mp.expiry_date:
        raise RenewalError(f"Only an in-force scheme with an expiry date renews (this one is {mp.status}).")
    if enforce_window and (mp.expiry_date - today).days > RENEWAL_WINDOW_DAYS:
        raise RenewalError(f"Renewal opens {RENEWAL_WINDOW_DAYS} days before expiry — this scheme expires on {mp.expiry_date}.")
    existing = (await session.exec(select(GroupRenewal).where(
        GroupRenewal.master_policy_id == mp.id, GroupRenewal.current_period_end == mp.expiry_date))).all()
    live = next((r for r in existing if r.status in _OPEN_STATES or r.status == GroupRenewalStatus.RENEWED.value), None)
    if live is not None:
        raise RenewalError(f"There is already a renewal for this period ({live.status}).", 409, {"renewal_id": str(live.id), "status": live.status})
    count = (await session.exec(select(GroupRenewal.id).where(
        GroupRenewal.master_policy_id == mp.id, GroupRenewal.status == GroupRenewalStatus.RENEWED.value))).all()
    experience = await compute_experience(session, mp, today)
    new_start, new_end = next_period(mp.expiry_date)
    renewal = GroupRenewal(
        tenant_id=mp.tenant_id, master_policy_id=mp.id, period_no=len(count) + 1, source=source,
        current_period_start=mp.effective_date, current_period_end=mp.expiry_date, new_period_start=new_start, new_period_end=new_end,
        experience=experience, experience_factor=experience["factor"], notes=notes,
    )
    session.add(renewal)
    await session.commit()
    await session.refresh(renewal)
    return renewal


async def _refresh_diff(session: AsyncSession, scheme, rows: List[dict], remove_missing: bool) -> Dict[str, Any]:
    roster = (await session.exec(
        select(GroupMember, Customer).join(Customer, Customer.id == GroupMember.customer_id)
        .where(GroupMember.master_policy_id == scheme.mp.id, GroupMember.status == GroupMemberStatus.ACTIVE.value))).all()
    all_cnics = {c.cnic for _m, c in (await session.exec(
        select(GroupMember, Customer).join(Customer, Customer.id == GroupMember.customer_id).where(GroupMember.master_policy_id == scheme.mp.id))).all()}
    by_cnic = {c.cnic: (m, c) for m, c in roster}
    add, change, seen = [], [], set()
    for row in rows:
        cnic = normalize_cnic(str(row.get("cnic") or ""))
        if not cnic:
            raise RenewalError(f"Row for “{row.get('name', '?')}” has no valid CNIC.", 422)
        seen.add(cnic)
        if cnic in by_cnic:
            member, customer = by_cnic[cnic]
            diff: Dict[str, Any] = {}
            if row.get("basic_monthly_salary") not in (None, "") and float(row["basic_monthly_salary"]) != float(member.basic_monthly_salary or 0):
                diff["basic_monthly_salary"] = float(row["basic_monthly_salary"])
            for k in ("grade", "designation"):
                if row.get(k) not in (None, "") and str(row[k]) != str(getattr(member, k) or ""):
                    diff[k] = row[k]
            if row.get("benefit_class") not in (None, ""):
                current = next((c.name for c in scheme.classes if c.id == member.benefit_class_id), None)
                if str(row["benefit_class"]).lower() != (current or "").lower():
                    diff["benefit_class"] = row["benefit_class"]
            if diff:
                change.append({"member_id": str(member.id), **diff})
        elif cnic in all_cnics:
            raise RenewalError(f"{row.get('name', cnic)} was removed from this scheme earlier; rejoining isn't supported — contact support.", 422)
        else:
            add.append(row)
    absent = [(m, c) for cnic, (m, c) in by_cnic.items() if cnic not in seen]
    return {"add": add, "change": change, "unchanged": len(by_cnic) - len(change) - len(absent) if len(absent) <= len(by_cnic) else 0,
            "remove": [{"member_id": str(m.id)} for m, _c in absent] if remove_missing else [],
            "not_in_file": [c.name for _m, c in absent]}


async def refresh_census(session: AsyncSession, renewal: GroupRenewal, tenant_id: UUID, org_id: UUID, rows: List[dict], *,
                         effective_date: Optional[date] = None, remove_missing: bool = False, preview: bool = False,
                         requested_by: Optional[str] = None) -> Dict[str, Any]:
    """Bring the roster up to the employer's refreshed list through ordinary endorsements."""
    if renewal.status not in (GroupRenewalStatus.OPEN.value, GroupRenewalStatus.QUOTED.value):
        raise RenewalError(f"The census can't be refreshed once the renewal is {renewal.status}.")
    if not rows:
        raise RenewalError("The refreshed census has no employees.", 422)
    try:
        scheme = await load_endorsement_scheme(session, tenant_id, org_id, renewal.master_policy_id)
    except EndorsementError as exc:
        raise RenewalError(str(exc), exc.status, exc.detail) from exc
    diff = await _refresh_diff(session, scheme, rows, remove_missing)
    eff = effective_date or min(max(date.today(), scheme.start), scheme.expiry)
    plan = [("ADD", diff["add"]), ("CHANGE", diff["change"]), ("DELETE", diff["remove"])]
    plan = [(k, m) for k, m in plan if m]

    previews = {}
    try:
        for kind, members in plan:                         # check every step before writing any
            previews[kind] = await preview_endorsement(session, scheme, kind, eff, members)
    except EndorsementError as exc:
        raise RenewalError(str(exc), exc.status, exc.detail) from exc
    summary = {"added": len(diff["add"]), "changed": len(diff["change"]), "removed": len(diff["remove"]),
               "unchanged": max(diff["unchanged"], 0), "not_in_file": diff["not_in_file"], "effective_date": eff.isoformat(),
               "premium_delta": round(sum(p["premium_delta"] for p in previews.values()), 2)}
    if preview or not plan:
        return {**summary, "applied": False, "endorsements": []}

    numbers: List[str] = []
    emitted: List[Tuple[Policy, PolicyEvent]] = []
    try:
        for kind, members in plan:
            e = await create_endorsement(session, scheme, kind, eff, members, "Renewal census refresh", requested_by)
            numbers.append(e.number)
        emitted = scheme.emitted
    except EndorsementError as exc:
        await session.rollback()
        raise RenewalError(f"{exc} (endorsements already applied: {', '.join(numbers) or 'none'}).", exc.status, exc.detail) from exc
    renewal.census_refresh = {**summary, "endorsements": numbers}
    # The roster changed, so any open renewal quote no longer prices it.
    for q in (await session.exec(select(GroupQuote).where(GroupQuote.renewal_id == renewal.id, GroupQuote.status == GroupQuoteStatus.OPEN.value))).all():
        q.status = GroupQuoteStatus.SUPERSEDED.value
        session.add(q)
    if renewal.status == GroupRenewalStatus.QUOTED.value:
        renewal.status = GroupRenewalStatus.OPEN.value
    session.add(renewal)
    await session.commit()
    await session.refresh(renewal)
    return {**summary, "applied": True, "endorsements": numbers, "_emitted": emitted}


# ═══════════════════════════════════════════════════════════════════════════
# Quote, decision, payment
# ═══════════════════════════════════════════════════════════════════════════

async def generate_renewal_quote(session: AsyncSession, renewal: GroupRenewal, tenant_id: UUID, org_id: UUID) -> GroupQuote:
    if renewal.status not in (GroupRenewalStatus.OPEN.value, GroupRenewalStatus.QUOTED.value, GroupRenewalStatus.DECLINED.value):
        raise RenewalError(f"A {renewal.status} renewal can't be re-quoted.")
    mp = await session.get(MasterPolicy, renewal.master_policy_id)
    org = await _get_organization(tenant_id, org_id, session)
    lives, outcomes, pending = await _scheme_lives(mp, session, as_of=renewal.new_period_start)
    if pending:
        raise RenewalError("Some members still need an underwriting decision.", 409, {"message": "Some members are above the Free Cover Limit and still need an underwriting decision.", "pending_members": pending})
    if not lives:
        raise RenewalError("There are no members to renew.")
    # Price on the experience of the period as it stands now, not as it stood when the renewal opened.
    renewal.experience = await compute_experience(session, mp, date.today())
    renewal.experience_factor = renewal.experience["factor"]

    plan = await _plan_for(mp, session)
    business_type = _business_type(plan)
    pricing = price_group(lives, plan.base_premium_rate if plan is not None else _FALLBACK_GROUP_RATE, renewal.experience_factor)
    split = takaful_split(pricing.risk_premium, plan.wakala_fee_pct if plan is not None else None,
                          plan.retakaful_share_pct if plan is not None else None) if business_type == "Takaful" else None

    for q in (await session.exec(select(GroupQuote).where(GroupQuote.master_policy_id == mp.id, GroupQuote.status == GroupQuoteStatus.OPEN.value))).all():
        q.status = GroupQuoteStatus.SUPERSEDED.value
        session.add(q)
    version = max((q.version for q in (await session.exec(select(GroupQuote).where(GroupQuote.master_policy_id == mp.id))).all()), default=0) + 1

    breakdown = pricing.model_dump()
    breakdown["covered"] = _roster_fingerprint(lives)
    breakdown["adjusted_members"] = [o for o in outcomes if o["basis"] != "Guaranteed"]
    breakdown["experience"] = renewal.experience
    breakdown["renewal"] = {"period_no": renewal.period_no, "new_period_start": renewal.new_period_start.isoformat(),
                            "new_period_end": renewal.new_period_end.isoformat()}
    if split is not None:
        breakdown["takaful"] = split.model_dump()
    quote = GroupQuote(
        tenant_id=tenant_id, master_policy_id=mp.id, version=version, status=GroupQuoteStatus.OPEN.value, business_type=business_type,
        valid_until=date.today() + timedelta(days=QUOTE_VALIDITY_DAYS), member_count=pricing.member_count, dependent_count=pricing.dependent_count,
        total_sum_assured=pricing.total_sum_assured, rate_per_mille=pricing.rate_per_mille, risk_premium=pricing.risk_premium,
        policy_fee=pricing.policy_fee, stamp_duty=pricing.stamp_duty, total_premium=pricing.total_premium,
        **takaful_quote_fields(split), renewal_id=renewal.id, breakdown=breakdown,
    )
    session.add(quote)
    await session.flush()
    from schemas import GroupQuoteRead
    quote.document_path = generate_group_quote({
        "tenant_name": await _tenant_name(tenant_id, session), "organization": org.name,
        "plan_label": plan.label if plan is not None else "Group Life", "business_type": business_type,
        "master_policy_id": str(mp.id), "effective_date": renewal.new_period_start,
        "quote": GroupQuoteRead.model_validate(quote).model_dump(mode="json"),
        "renewal": {"period_no": renewal.period_no, "new_period_start": renewal.new_period_start, "new_period_end": renewal.new_period_end,
                    "experience": renewal.experience, "experience_factor": renewal.experience_factor},
    })
    renewal.status = GroupRenewalStatus.QUOTED.value
    session.add_all([quote, renewal])
    await session.commit()
    await session.refresh(quote)
    return quote


async def _renewal_quote(session: AsyncSession, renewal: GroupRenewal, status: str) -> Optional[GroupQuote]:
    return (await session.exec(select(GroupQuote).where(GroupQuote.renewal_id == renewal.id, GroupQuote.status == status)
                               .order_by(GroupQuote.version.desc()))).first()


async def decide_renewal(session: AsyncSession, renewal: GroupRenewal, accept: bool, decided_by: Optional[str], notes: Optional[str]) -> GroupRenewal:
    if renewal.status != GroupRenewalStatus.QUOTED.value:
        raise RenewalError(f"Only a quoted renewal can be {'accepted' if accept else 'declined'} (this one is {renewal.status}).")
    quote = await _renewal_quote(session, renewal, GroupQuoteStatus.OPEN.value)
    if quote is None:
        raise RenewalError("There is no open renewal quote — generate one.")
    if quote.valid_until < date.today():
        quote.status = GroupQuoteStatus.EXPIRED.value
        session.add(quote)
        await session.commit()
        raise RenewalError("That quote has expired — generate a revised one.")
    if accept:
        mp = await session.get(MasterPolicy, renewal.master_policy_id)
        lives, _o, pending = await _scheme_lives(mp, session, as_of=renewal.new_period_start)
        if pending or _roster_fingerprint(lives) != quote.breakdown.get("covered", {}):
            raise RenewalError("The roster or cover has changed since this quote — generate a revised quote.")
    quote.status = GroupQuoteStatus.ACCEPTED.value if accept else GroupQuoteStatus.DECLINED.value
    quote.decided_at, quote.decided_by, quote.decision_notes = datetime.utcnow(), decided_by, notes
    renewal.status = GroupRenewalStatus.ACCEPTED.value if accept else GroupRenewalStatus.DECLINED.value
    renewal.decided_by, renewal.decided_at = decided_by, quote.decided_at
    session.add_all([quote, renewal])
    await session.commit()
    await session.refresh(renewal)
    return renewal


async def record_renewal_payment(session: AsyncSession, renewal: GroupRenewal, tenant_id: UUID, org_id: UUID,
                                 reference: str, amount: float) -> Tuple[GroupRenewal, List[Tuple[Policy, PolicyEvent]]]:
    """Take the renewal premium and start the next period."""
    if renewal.status != GroupRenewalStatus.ACCEPTED.value:
        raise RenewalError(f"A renewal is paid once it is accepted (this one is {renewal.status}).")
    quote = await _renewal_quote(session, renewal, GroupQuoteStatus.ACCEPTED.value)
    if quote is None:
        raise RenewalError("There is no accepted renewal quote.")
    if amount + 0.01 < quote.total_premium:
        raise RenewalError(f"Payment of PKR {amount:,.2f} is less than the renewal amount due (PKR {quote.total_premium:,.2f}).", 422)

    mp = await session.get(MasterPolicy, renewal.master_policy_id)
    org = await _get_organization(tenant_id, org_id, session)
    by_life: Dict[str, float] = quote.breakdown["by_life"]
    emitted: List[Tuple[Policy, PolicyEvent]] = []
    rows = await _member_rows(mp, session)
    for member, _customer, policy in rows:
        if member.status != GroupMemberStatus.ACTIVE.value:
            continue
        deps = (await session.exec(select(GroupMemberDependent).where(
            GroupMemberDependent.group_member_id == member.id, GroupMemberDependent.status != GroupMemberStatus.REMOVED.value))).all()
        member.cover_start_date, member.cover_end_date = renewal.new_period_start, renewal.new_period_end
        member.annual_premium = round(by_life.get(str(member.id), 0.0) + sum(by_life.get(str(d.id), 0.0) for d in deps), 2)
        session.add(member)
        if policy is not None and _st(policy) == PolicyStatusEnum.ACTIVE.value:
            policy.effective_date, policy.expiry_date = renewal.new_period_start, renewal.new_period_end
            emitted.append((policy, apply_transition(
                session, policy, PolicyStatusEnum.ACTIVE, event_type="GroupRenewed", actor="system",
                detail={"master_policy_number": mp.policy_number, "period": renewal.period_no, "payment_reference": reference,
                        "new_period_start": renewal.new_period_start.isoformat(), "new_period_end": renewal.new_period_end.isoformat()})))
            session.add(policy)

    mp.effective_date, mp.expiry_date = renewal.new_period_start, renewal.new_period_end
    mp.premium_paid_at, mp.payment_reference = datetime.utcnow(), reference
    plan = await _plan_for(mp, session)
    classes = await _benefit_classes(mp.id, session)
    class_names = {c.id: c.name for c in classes}
    members_doc = []
    for member, customer, policy in rows:
        if member.status == GroupMemberStatus.ACTIVE.value:
            members_doc.append({"certificate": policy.policy_number if policy else "—", "name": customer.name, "cnic": customer.cnic,
                                "class": class_names.get(member.benefit_class_id), "cover": member.coverage_amount, "note": member.cover_note})
    from routers.group_policies import _basis_text
    mp.schedule_document_path = generate_master_schedule({
        "tenant_name": await _tenant_name(tenant_id, session), "organization": org.name,
        "plan_label": plan.label if plan is not None else "Group Life", "business_type": _business_type(plan),
        "master_policy_id": str(mp.id), "policy_number": mp.policy_number, "effective_date": mp.effective_date,
        "expiry_date": mp.expiry_date, "total_premium": quote.total_premium, "free_cover_limit": mp.free_cover_limit,
        "classes": [{"name": c.name, "basis_text": _basis_text(c)} for c in classes], "members": members_doc, "dependents": [],
        "takaful": quote.breakdown.get("takaful"),
    })
    session.add(mp)
    renewal.status = GroupRenewalStatus.RENEWED.value
    renewal.payment_reference, renewal.amount_paid, renewal.paid_at, renewal.completed_at = reference, amount, datetime.utcnow(), datetime.utcnow()
    session.add(renewal)
    await session.commit()
    await session.refresh(renewal)
    return renewal, emitted


# ═══════════════════════════════════════════════════════════════════════════
# Scheduler
# ═══════════════════════════════════════════════════════════════════════════

async def run_renewal_cycle(session_factory, today: Optional[date] = None, tenant_id: Optional[UUID] = None) -> Dict[str, List[str]]:
    """One pass of the daily job: open a renewal for every in-force scheme expiring within
    RENEWAL_LEAD_DAYS that doesn't have one, and lapse renewals that were never completed
    RENEWAL_GRACE_DAYS after the period ended. Returns what it did, by scheme and renewal id."""
    today = today or date.today()
    opened: List[str] = []
    lapsed: List[str] = []
    async with session_factory() as session:
        stmt = select(MasterPolicy).where(MasterPolicy.status == "Active", MasterPolicy.expiry_date.is_not(None),  # type: ignore[union-attr]
                                          MasterPolicy.expiry_date <= today + timedelta(days=RENEWAL_LEAD_DAYS))
        if tenant_id is not None:
            stmt = stmt.where(MasterPolicy.tenant_id == tenant_id)
        for mp in (await session.exec(stmt)).all():
            if mp.expiry_date < today - timedelta(days=RENEWAL_GRACE_DAYS):
                continue                                           # long gone — handled by the lapse pass below
            try:
                r = await open_renewal(session, mp, today=today, source="Scheduler", enforce_window=False)
                opened.append(str(r.id))
                log.info("Group renewal opened: %s (expires %s)", mp.policy_number, mp.expiry_date)
            except RenewalError:
                await session.rollback()                           # already has one, or not renewable: nothing to do

        cutoff = today - timedelta(days=RENEWAL_GRACE_DAYS)
        stale = select(GroupRenewal).where(GroupRenewal.status.in_(list(_OPEN_STATES)), GroupRenewal.current_period_end < cutoff)  # type: ignore[union-attr]
        if tenant_id is not None:
            stale = stale.where(GroupRenewal.tenant_id == tenant_id)
        for r in (await session.exec(stale)).all():
            r.status, r.completed_at = GroupRenewalStatus.LAPSED.value, datetime.utcnow()
            session.add(r)
            lapsed.append(str(r.id))
        await session.commit()
    return {"opened": opened, "lapsed": lapsed}


def start_group_renewal_scheduler(stop_event: asyncio.Event, session_factory) -> Optional[asyncio.Task]:
    """Daily background job. Off unless GROUP_RENEWAL_SCHEDULER=true — like the individual
    renewal scheduler it creates records on its own, so it is opt-in."""
    if os.environ.get("GROUP_RENEWAL_SCHEDULER", "false").lower() not in ("true", "1", "yes"):
        return None

    async def _loop() -> None:
        while not stop_event.is_set():
            try:
                result = await run_renewal_cycle(session_factory)
                log.info("Group renewal cycle: %s", result)
            except Exception:  # noqa: BLE001 — a failed pass must not stop the daily job
                log.exception("Group renewal cycle failed")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=24 * 3600)
            except asyncio.TimeoutError:
                continue

    return asyncio.create_task(_loop())
