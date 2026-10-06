"""Group Life quote → acceptance → issuance → payment (GROUP_LIFE_PLAN.md Phase 2).

Picks up where routers/organizations.py's census confirm leaves a master
policy ("Proposed") and carries it to in-force cover:

    Proposed ──quote──▶ Quoted ──accept──▶ Accepted ──issue──▶ PendingPayment ──pay──▶ Active
                          │  ▲
                   decline│  │re-quote (supersedes the open quote)
                          ▼  │
                        Declined

The employer is the policyholder: one quote, one premium/contribution, one
master policy number. Each member's certificate (their Policy row) is numbered
under it and goes live with the scheme. Individual issuance
(routers/policies.py) is untouched — its applicant-level gates (E-App, IPP,
per-policy payment) don't apply to an employer-paid group contract.
"""

import asyncio
import os
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Tuple
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse
from sqlalchemy import func, text
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from group_benefits import completed_years_of_service
from group_pricing import PricedLife, price_group, takaful_quote_fields, takaful_split
from group_underwriting import MemberOutcome, member_underwriting_outcome, normalize_cnic
from routers.organizations import (
    _FALLBACK_GROUP_RATE,
    _benefit_classes,
    _get_master_policy,
    _get_organization,
    _master_policy_read,
)
from routers.pre_issuance import BeneficiariesReplace
from routers.policies import _publish_policy_event
from routers.users import verify_admin
from schemas import (
    GroupDependentCreate,
    GroupDependentRead,
    GroupIssueResponse,
    GroupMemberRead,
    GroupPaymentCreate,
    GroupQuoteDecision,
    GroupQuoteRead,
)
from services.group_claims import LIFE, coverage_schedule
from services.group_documents import generate_group_quote, generate_master_schedule
from shared.models.core import (
    Beneficiary,
    BeneficiaryVersion,
    Customer,
    GroupBenefitClass,
    GroupClassCoverage,
    GroupMember,
    GroupMemberDependent,
    GroupMemberStatus,
    GroupQuote,
    GroupQuoteStatus,
    InsurancePlan,
    MasterPolicy,
    Policy,
    PolicyEvent,
    PolicyStatusEnum,
    ProfileStatusEnum,
    RiskAssessment,
    Tenant,
)
from shared.services.policy_state_machine import IllegalStateTransition, apply_transition

router = APIRouter(prefix="/tenants", tags=["Group Policies"])

QUOTE_VALIDITY_DAYS = int(os.environ.get("GROUP_QUOTE_VALIDITY_DAYS", "30"))

# Master policy statuses (MasterPolicy.status is a plain string).
PROPOSED, QUOTED, ACCEPTED, DECLINED = "Proposed", "Quoted", "Accepted", "Declined"
PENDING_PAYMENT, ACTIVE = "PendingPayment", "Active"
_QUOTABLE = {PROPOSED, QUOTED, DECLINED}
# Dependents change the priced roster, so they're editable only until a quote is accepted.
_DEPENDENTS_EDITABLE = {"Pending", PROPOSED, QUOTED, DECLINED}
_DEPENDENT_RELATIONSHIPS = {"Spouse", "Child", "Parent"}

# Certificate status walk to PendingPayment at issuance, per starting status
# (state machine: Quoted can't jump to Approved; a Restricted member's
# Declined certificate is re-approved at the FCL amount).
_ISSUE_PATH: Dict[str, List[PolicyStatusEnum]] = {
    PolicyStatusEnum.QUOTED.value: [PolicyStatusEnum.PROPOSED, PolicyStatusEnum.APPROVED, PolicyStatusEnum.PENDING_PAYMENT],
    PolicyStatusEnum.PROPOSED.value: [PolicyStatusEnum.APPROVED, PolicyStatusEnum.PENDING_PAYMENT],
    PolicyStatusEnum.APPROVED.value: [PolicyStatusEnum.PENDING_PAYMENT],
    PolicyStatusEnum.ACCEPTED_WITH_LOADINGS.value: [PolicyStatusEnum.PENDING_PAYMENT],
    PolicyStatusEnum.DECLINED.value: [PolicyStatusEnum.APPROVED, PolicyStatusEnum.PENDING_PAYMENT],
}


def _st(policy: Policy) -> str:
    return policy.status.value if hasattr(policy.status, "value") else str(policy.status)


def _age_on(dob: Optional[date], on: date) -> int:
    if dob is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Every covered life needs a date of birth to be priced.")
    return completed_years_of_service(dob, on)


async def _plan_for(mp: MasterPolicy, session: AsyncSession) -> Optional[InsurancePlan]:
    return await session.get(InsurancePlan, mp.plan_id) if mp.plan_id else None


def _business_type(plan: Optional[InsurancePlan]) -> str:
    if plan is None:
        return "Conventional"
    return plan.product_category.value if hasattr(plan.product_category, "value") else str(plan.product_category)


async def _member_rows(mp: MasterPolicy, session: AsyncSession) -> List[Tuple[GroupMember, Customer, Optional[Policy]]]:
    rows = (await session.exec(
        select(GroupMember, Customer, Policy)
        .join(Customer, Customer.id == GroupMember.customer_id)
        .join(Policy, Policy.id == GroupMember.policy_id, isouter=True)
        .where(GroupMember.master_policy_id == mp.id, GroupMember.status != GroupMemberStatus.REMOVED.value)
        .order_by(GroupMember.created_at, Customer.name)
    )).all()
    return list(rows)


async def _latest_loading(policy_id: UUID, session: AsyncSession) -> Optional[float]:
    ra = (await session.exec(
        select(RiskAssessment).where(RiskAssessment.policy_id == policy_id).order_by(RiskAssessment.created_at.desc())
    )).first()
    return ra.suggested_loading if ra is not None else None


# Certificate statuses after issuance. The underwriting decision has already been
# applied to member.coverage_amount by then, so these read as "approved" (or
# "loaded" if the decision carried a loading) rather than "awaiting a decision".
_IN_FORCE = {PolicyStatusEnum.PENDING_PAYMENT.value, PolicyStatusEnum.ACTIVE.value}


async def _outcome(mp: MasterPolicy, member: GroupMember, policy: Optional[Policy], session: AsyncSession) -> MemberOutcome:
    certificate_status = _st(policy) if policy is not None else PolicyStatusEnum.QUOTED.value
    loading = None
    if policy is not None and certificate_status in _IN_FORCE | {"AcceptedWithLoadings"}:
        loading = await _latest_loading(policy.id, session)
    if certificate_status in _IN_FORCE:
        certificate_status = "AcceptedWithLoadings" if loading and loading > 0 else PolicyStatusEnum.APPROVED.value
    elif certificate_status != "AcceptedWithLoadings":
        loading = None
    return member_underwriting_outcome(member.coverage_amount, mp.free_cover_limit, certificate_status, loading)


async def _scheme_lives(mp: MasterPolicy, session: AsyncSession, as_of: Optional[date] = None):
    """(priced lives, per-member outcomes, pending members). Ages are taken at
    the scheme's effective date (or `as_of`, which a renewal sets to the start of
    the next period); restricted members are priced at the FCL."""
    as_of = as_of or mp.effective_date
    classes = {c.id: c.name for c in await _benefit_classes(mp.id, session)}
    coverages: Dict[UUID, list] = {}
    if classes:
        for row in (await session.exec(select(GroupClassCoverage).where(GroupClassCoverage.benefit_class_id.in_(list(classes))))).all():
            coverages.setdefault(row.benefit_class_id, []).append(row)
    lives: List[PricedLife] = []
    outcomes: List[dict] = []
    pending: List[str] = []
    for member, customer, policy in await _member_rows(mp, session):
        outcome = await _outcome(mp, member, policy, session)
        outcomes.append({"member_id": str(member.id), "name": customer.name, **outcome.model_dump()})
        if outcome.basis == "Pending":
            pending.append(customer.name)
            continue
        class_name = classes.get(member.benefit_class_id)
        lives.append(PricedLife(
            key=str(member.id), kind="member", benefit_class=class_name,
            age=_age_on(customer.dob, as_of), sum_assured=outcome.covered_amount,
            occupation=customer.occupation, loading_pct=outcome.loading_pct,
            # Benefits beyond Life, as a % of the cover this member actually carries (so a member
            # restricted to the Free Cover Limit has their riders scaled with it).
            riders={k: v for k, v in coverage_schedule(outcome.covered_amount, coverages.get(member.benefit_class_id, [])).items() if k != LIFE},
        ))
        dependents = (await session.exec(
            select(GroupMemberDependent).where(
                GroupMemberDependent.group_member_id == member.id,
                GroupMemberDependent.status != GroupMemberStatus.REMOVED.value,
            )
        )).all()
        for d in dependents:
            lives.append(PricedLife(
                key=str(d.id), kind="dependent", benefit_class=class_name,
                age=_age_on(d.dob, as_of), sum_assured=d.covered_amount,
            ))
    return lives, outcomes, pending


def _roster_fingerprint(lives: List[PricedLife]) -> Dict[str, float]:
    return {l.key: round(l.sum_assured, 2) for l in lives}


async def _assert_roster_unchanged(mp: MasterPolicy, quote: GroupQuote, session: AsyncSession) -> None:
    lives, _, pending = await _scheme_lives(mp, session)
    if pending or _roster_fingerprint(lives) != quote.breakdown.get("covered", {}):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "The roster or cover has changed since this quote was generated — generate a revised quote.",
        )


async def _get_quote(mp: MasterPolicy, quote_id: UUID, session: AsyncSession) -> GroupQuote:
    quote = await session.get(GroupQuote, quote_id)
    if not quote or quote.master_policy_id != mp.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Quote not found.")
    return quote


async def _tenant_name(tenant_id: UUID, session: AsyncSession) -> str:
    tenant = await session.get(Tenant, tenant_id)
    return tenant.name if tenant else "Insurer"


async def _next_master_policy_number(session: AsyncSession, tenant_id: UUID, business_type: str) -> str:
    """GL-YYYY-NNNN (GT- for Takaful), allocated under a per-tenant advisory
    lock from the highest suffix in use — same approach as
    routers/policies.py::_next_policy_number."""
    prefix = f"{'GT' if business_type == 'Takaful' else 'GL'}-{datetime.utcnow().year}-"
    lock_key = (tenant_id.int % (2 ** 62)) - (2 ** 61) + 1
    await session.exec(text("SELECT pg_advisory_xact_lock(:k)").bindparams(k=lock_key))
    used = (await session.exec(
        select(MasterPolicy.policy_number).where(
            MasterPolicy.tenant_id == tenant_id, MasterPolicy.policy_number.like(f"{prefix}%"),
        )
    )).all()
    highest = max((int(n[len(prefix):]) for n in used if n and n[len(prefix):].isdigit()), default=0)
    return f"{prefix}{highest + 1:04d}"


# Concurrent Kafka sends per request: a scheme can have hundreds of certificates.
_PUBLISH_CONCURRENCY = 20


async def _publish_certificate_events(request: Optional[Request], emitted: List[Tuple[Policy, PolicyEvent]]) -> None:
    """Mirror the certificate transitions of a committed issue/payment onto the
    policy lifecycle topic, as individual issuance does. Best-effort, after the
    commit: the PolicyEvent rows are the source of truth, so a broker outage
    never fails (or rolls back) the issuance."""
    if not emitted:
        return
    gate = asyncio.Semaphore(_PUBLISH_CONCURRENCY)

    async def _one(policy: Policy, event: PolicyEvent) -> None:
        async with gate:
            await _publish_policy_event(request, policy, event)

    await asyncio.gather(*(_one(p, e) for p, e in emitted))


def _add_years(d: date, years: int) -> date:
    try:
        return d.replace(year=d.year + years)
    except ValueError:  # 29 Feb
        return d.replace(year=d.year + years, day=28)


def _basis_text(cls: GroupBenefitClass) -> str:
    basis = cls.basis
    if basis == "Flat":
        text_ = f"Flat PKR {cls.flat_amount:,.0f}"
    elif basis == "SalaryMultiple":
        text_ = f"{cls.salary_multiple:g} × basic monthly salary"
    else:
        text_ = "By completed service: " + ", ".join(
            f"{b['min_years']}+ yrs PKR {float(b['amount']):,.0f}" for b in (cls.service_bands or []))
    caps = []
    if cls.min_cover is not None:
        caps.append(f"min PKR {cls.min_cover:,.0f}")
    if cls.max_cover is not None:
        caps.append(f"max PKR {cls.max_cover:,.0f}")
    return text_ + (f" ({', '.join(caps)})" if caps else "")


# ── Members & dependents ────────────────────────────────────────────────────────

@router.get(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/members",
    response_model=List[GroupMemberRead],
    dependencies=[Depends(verify_admin)],
)
async def list_group_members(tenant_id: UUID, org_id: UUID, mp_id: UUID, session: AsyncSession = Depends(get_session)):
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    classes = {c.id: c.name for c in await _benefit_classes(mp_id, session)}
    out = []
    rows = await _member_rows(mp, session)
    certificate_ids = [m.policy_id for m, _c, _p in rows if m.policy_id]
    nominations = dict((await session.exec(
        select(Beneficiary.policy_id, func.count()).where(Beneficiary.policy_id.in_(certificate_ids))
        .group_by(Beneficiary.policy_id)
    )).all()) if certificate_ids else {}
    for member, customer, policy in rows:
        outcome = await _outcome(mp, member, policy, session)
        dependents = (await session.exec(
            select(GroupMemberDependent.id).where(GroupMemberDependent.group_member_id == member.id)
        )).all()
        out.append(GroupMemberRead(
            id=member.id, customer_id=customer.id, name=customer.name, cnic=customer.cnic,
            policy_id=member.policy_id,
            certificate_number=policy.policy_number if policy else None,
            certificate_status=_st(policy) if policy else None,
            benefit_class=classes.get(member.benefit_class_id),
            employee_id=member.employee_id, designation=member.designation, grade=member.grade,
            basic_monthly_salary=member.basic_monthly_salary, coverage_amount=member.coverage_amount,
            status=member.status, annual_premium=member.annual_premium, cover_note=member.cover_note,
            underwriting_basis=outcome.basis, dependents=len(dependents),
            nominations=nominations.get(member.policy_id, 0),
        ))
    return out


async def _get_member(mp: MasterPolicy, member_id: UUID, session: AsyncSession) -> GroupMember:
    member = await session.get(GroupMember, member_id)
    if not member or member.master_policy_id != mp.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Member not found.")
    return member


def _assert_dependents_editable(mp: MasterPolicy) -> None:
    if mp.status not in _DEPENDENTS_EDITABLE:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Dependants can't change once the quote is accepted (master policy is {mp.status}) — use an endorsement.",
        )


@router.post(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/members/{member_id}/dependents",
    response_model=GroupDependentRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def add_group_dependent(
    tenant_id: UUID, org_id: UUID, mp_id: UUID, member_id: UUID,
    body: GroupDependentCreate,
    session: AsyncSession = Depends(get_session),
):
    """Covers a dependant under a member — this is what puts them on the
    schedule. A nominee/beneficiary is NOT a dependant and is never covered."""
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    _assert_dependents_editable(mp)
    member = await _get_member(mp, member_id, session)

    errors = []
    if body.relationship not in _DEPENDENT_RELATIONSHIPS:
        errors.append(f"relationship must be one of {sorted(_DEPENDENT_RELATIONSHIPS)}.")
    if body.dob > date.today():
        errors.append("dob cannot be in the future.")
    if body.covered_amount > member.coverage_amount:
        errors.append("A dependant's cover cannot exceed the member's own cover.")
    cnic = None
    if body.cnic:
        cnic = normalize_cnic(body.cnic)
        if cnic is None:
            errors.append("cnic must be 13 digits or XXXXX-XXXXXXX-X.")
    if errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, errors)

    dependent = GroupMemberDependent(
        tenant_id=tenant_id, group_member_id=member.id, name=body.name.strip(),
        cnic=cnic, relationship=body.relationship, dob=body.dob, gender=body.gender,
        covered_amount=body.covered_amount, status=GroupMemberStatus.PENDING.value,
    )
    session.add(dependent)
    await session.commit()
    await session.refresh(dependent)
    return dependent


@router.get(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/members/{member_id}/dependents",
    response_model=List[GroupDependentRead],
    dependencies=[Depends(verify_admin)],
)
async def list_group_dependents(tenant_id: UUID, org_id: UUID, mp_id: UUID, member_id: UUID, session: AsyncSession = Depends(get_session)):
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    member = await _get_member(mp, member_id, session)
    return list((await session.exec(
        select(GroupMemberDependent).where(GroupMemberDependent.group_member_id == member.id)
    )).all())


@router.delete(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/members/{member_id}/dependents/{dependent_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_admin)],
)
async def delete_group_dependent(tenant_id: UUID, org_id: UUID, mp_id: UUID, member_id: UUID, dependent_id: UUID,
                                 session: AsyncSession = Depends(get_session)):
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    _assert_dependents_editable(mp)
    member = await _get_member(mp, member_id, session)
    dependent = await session.get(GroupMemberDependent, dependent_id)
    if not dependent or dependent.group_member_id != member.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dependant not found.")
    await session.delete(dependent)
    await session.commit()
    return None


# ── Beneficiaries (nominees) ────────────────────────────────────────────────────
# Same Beneficiary / BeneficiaryVersion rows an individual policy uses, on the
# member's certificate. Unlike routers/pre_issuance.py's Stage-A-only endpoint,
# group nominations are collected at enrolment and can change while cover is in
# force (no re-pricing — a nominee isn't a covered life); every change is versioned.

_NOMINATION_CLOSED = {"Cancelled", "Lapsed", "NotTakenUp"}


@router.put(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/members/{member_id}/beneficiaries",
    dependencies=[Depends(verify_admin)],
)
async def replace_group_beneficiaries(tenant_id: UUID, org_id: UUID, mp_id: UUID, member_id: UUID,
                                      body: BeneficiariesReplace, session: AsyncSession = Depends(get_session)):
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    member = await _get_member(mp, member_id, session)
    policy = await session.get(Policy, member.policy_id) if member.policy_id else None
    if policy is None or member.status == GroupMemberStatus.REMOVED.value or _st(policy) in _NOMINATION_CLOSED:
        raise HTTPException(status.HTTP_409_CONFLICT, "This member has no live certificate to nominate on.")
    if not body.beneficiaries:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "At least one beneficiary is required.")
    total = round(sum(b.share_pct for b in body.beneficiaries), 2)
    if abs(total - 100.0) > 0.01:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Beneficiary shares must sum to 100% (got {total}%).")

    for old in (await session.exec(select(Beneficiary).where(Beneficiary.policy_id == policy.id))).all():
        await session.delete(old)
    snapshot = []
    for b in body.beneficiaries:
        session.add(Beneficiary(
            tenant_id=tenant_id, policy_id=policy.id, name=b.name, cnic=b.cnic, relationship=b.relationship,
            share_pct=b.share_pct, date_of_birth=b.date_of_birth, is_minor=b.is_minor, guardian_name=b.guardian_name,
        ))
        snapshot.append(b.model_dump(mode="json"))

    last_seq = (await session.exec(
        select(BeneficiaryVersion.version_sequence)
        .where(BeneficiaryVersion.policy_id == policy.id)
        .order_by(BeneficiaryVersion.version_sequence.desc())
    )).first()
    sequence = (last_seq or 0) + 1
    session.add(BeneficiaryVersion(
        tenant_id=tenant_id, policy_id=policy.id, version_sequence=sequence, beneficiaries_json=snapshot,
        total_share=total, changed_by=body.changed_by,
        change_reason=body.change_reason or ("Initial nomination" if sequence == 1 else "Nomination updated"),
    ))
    primary = max(body.beneficiaries, key=lambda x: x.share_pct)
    policy.nominee_name, policy.nominee_relationship = primary.name, primary.relationship
    session.add(policy)
    await session.commit()
    return {"beneficiaries": snapshot, "total_share": total, "version_sequence": sequence}


@router.get(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/members/{member_id}/beneficiaries",
    dependencies=[Depends(verify_admin)],
)
async def list_group_beneficiaries(tenant_id: UUID, org_id: UUID, mp_id: UUID, member_id: UUID,
                                   session: AsyncSession = Depends(get_session)):
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    member = await _get_member(mp, member_id, session)
    if not member.policy_id:
        return []
    rows = (await session.exec(select(Beneficiary).where(Beneficiary.policy_id == member.policy_id))).all()
    return [{"name": r.name, "cnic": r.cnic, "relationship": r.relationship, "share_pct": r.share_pct,
             "date_of_birth": r.date_of_birth, "is_minor": r.is_minor, "guardian_name": r.guardian_name} for r in rows]


# ── Quotes ──────────────────────────────────────────────────────────────────────

@router.post(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/quotes",
    response_model=GroupQuoteRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def generate_group_quote_endpoint(tenant_id: UUID, org_id: UUID, mp_id: UUID, session: AsyncSession = Depends(get_session)):
    """Price the scheme as one pool and issue a versioned quote. A revised
    quote supersedes the open one. Blocked while any above-FCL member still
    awaits an underwriting decision."""
    org = await _get_organization(tenant_id, org_id, session)
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    if mp.status not in _QUOTABLE:
        raise HTTPException(status.HTTP_409_CONFLICT, f"A {mp.status} master policy can't be quoted (needs a confirmed census).")

    lives, outcomes, pending = await _scheme_lives(mp, session)
    if pending:
        raise HTTPException(status.HTTP_409_CONFLICT, {
            "message": "Some members are above the Free Cover Limit and still need an underwriting decision.",
            "pending_members": pending,
        })
    if not lives:
        raise HTTPException(status.HTTP_409_CONFLICT, "No enrolled members to quote.")

    plan = await _plan_for(mp, session)
    business_type = _business_type(plan)
    pricing = price_group(lives, plan.base_premium_rate if plan is not None else _FALLBACK_GROUP_RATE)
    split = takaful_split(pricing.risk_premium, plan.wakala_fee_pct if plan is not None else None,
                          plan.retakaful_share_pct if plan is not None else None) if business_type == "Takaful" else None

    previous = (await session.exec(select(GroupQuote).where(GroupQuote.master_policy_id == mp.id))).all()
    for q in previous:
        if q.status == GroupQuoteStatus.OPEN.value:
            q.status = GroupQuoteStatus.SUPERSEDED.value
            session.add(q)

    breakdown = pricing.model_dump()
    breakdown["covered"] = _roster_fingerprint(lives)
    breakdown["adjusted_members"] = [o for o in outcomes if o["basis"] != "Guaranteed"]
    if split is not None:
        breakdown["takaful"] = split.model_dump()
    quote = GroupQuote(
        tenant_id=tenant_id, master_policy_id=mp.id,
        version=max((q.version for q in previous), default=0) + 1,
        status=GroupQuoteStatus.OPEN.value, business_type=business_type,
        valid_until=date.today() + timedelta(days=QUOTE_VALIDITY_DAYS),
        member_count=pricing.member_count, dependent_count=pricing.dependent_count,
        total_sum_assured=pricing.total_sum_assured, rate_per_mille=pricing.rate_per_mille,
        risk_premium=pricing.risk_premium, policy_fee=pricing.policy_fee,
        stamp_duty=pricing.stamp_duty, total_premium=pricing.total_premium,
        **takaful_quote_fields(split),
        breakdown=breakdown,
    )
    session.add(quote)
    await session.flush()

    quote.document_path = generate_group_quote({
        "tenant_name": await _tenant_name(tenant_id, session),
        "organization": org.name,
        "plan_label": plan.label if plan is not None else "Group Life",
        "business_type": business_type,
        "master_policy_id": str(mp.id),
        "effective_date": mp.effective_date,
        "quote": GroupQuoteRead.model_validate(quote).model_dump(mode="json"),
    })
    mp.status = QUOTED
    session.add_all([quote, mp])
    await session.commit()
    await session.refresh(quote)
    return quote


@router.get(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/quotes",
    response_model=List[GroupQuoteRead],
    dependencies=[Depends(verify_admin)],
)
async def list_group_quotes(tenant_id: UUID, org_id: UUID, mp_id: UUID, session: AsyncSession = Depends(get_session)):
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    return list((await session.exec(
        select(GroupQuote).where(GroupQuote.master_policy_id == mp.id).order_by(GroupQuote.version.desc())
    )).all())


@router.get(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/quotes/{quote_id}/document",
    dependencies=[Depends(verify_admin)],
)
async def download_group_quote(tenant_id: UUID, org_id: UUID, mp_id: UUID, quote_id: UUID, session: AsyncSession = Depends(get_session)):
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    quote = await _get_quote(mp, quote_id, session)
    if not quote.document_path or not os.path.exists(quote.document_path):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Quote document not available.")
    return FileResponse(quote.document_path, media_type="application/pdf", filename=f"group-quote-v{quote.version}.pdf")


async def _open_quote_for_decision(mp: MasterPolicy, quote_id: UUID, session: AsyncSession) -> GroupQuote:
    quote = await _get_quote(mp, quote_id, session)
    if quote.status != GroupQuoteStatus.OPEN.value:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Quote v{quote.version} is {quote.status}, not open.")
    if quote.valid_until < date.today():
        quote.status = GroupQuoteStatus.EXPIRED.value
        session.add(quote)
        await session.commit()
        raise HTTPException(status.HTTP_409_CONFLICT, f"Quote v{quote.version} expired on {quote.valid_until} — generate a revised quote.")
    return quote


@router.post(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/quotes/{quote_id}/accept",
    response_model=GroupQuoteRead,
    dependencies=[Depends(verify_admin)],
)
async def accept_group_quote(tenant_id: UUID, org_id: UUID, mp_id: UUID, quote_id: UUID,
                             body: GroupQuoteDecision, session: AsyncSession = Depends(get_session)):
    """The employer accepts — recorded by staff on their behalf."""
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    quote = await _open_quote_for_decision(mp, quote_id, session)
    await _assert_roster_unchanged(mp, quote, session)
    quote.status = GroupQuoteStatus.ACCEPTED.value
    quote.decided_at, quote.decided_by, quote.decision_notes = datetime.utcnow(), body.decided_by, body.notes
    mp.status = ACCEPTED
    session.add_all([quote, mp])
    await session.commit()
    await session.refresh(quote)
    return quote


@router.post(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/quotes/{quote_id}/decline",
    response_model=GroupQuoteRead,
    dependencies=[Depends(verify_admin)],
)
async def decline_group_quote(tenant_id: UUID, org_id: UUID, mp_id: UUID, quote_id: UUID,
                              body: GroupQuoteDecision, session: AsyncSession = Depends(get_session)):
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    quote = await _open_quote_for_decision(mp, quote_id, session)
    quote.status = GroupQuoteStatus.DECLINED.value
    quote.decided_at, quote.decided_by, quote.decision_notes = datetime.utcnow(), body.decided_by, body.notes
    mp.status = DECLINED
    session.add_all([quote, mp])
    await session.commit()
    await session.refresh(quote)
    return quote


# ── Issuance & payment ──────────────────────────────────────────────────────────

async def _accepted_quote(mp: MasterPolicy, session: AsyncSession) -> GroupQuote:
    quote = (await session.exec(
        select(GroupQuote).where(GroupQuote.master_policy_id == mp.id, GroupQuote.status == GroupQuoteStatus.ACCEPTED.value)
        .order_by(GroupQuote.version.desc())
    )).first()
    if quote is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "No accepted quote for this master policy.")
    return quote


@router.post(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/issue",
    response_model=GroupIssueResponse,
    dependencies=[Depends(verify_admin)],
)
async def issue_master_policy(tenant_id: UUID, org_id: UUID, mp_id: UUID,
                              session: AsyncSession = Depends(get_session), request: Request = None):  # type: ignore[assignment]
    """Issue the contract on the accepted quote's terms: master policy number,
    one numbered certificate per member, schedule document. Cover is not live
    until the employer's premium is recorded (PendingPayment)."""
    org = await _get_organization(tenant_id, org_id, session)
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    if mp.status != ACCEPTED:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Only an Accepted master policy can be issued (current: {mp.status}).")
    quote = await _accepted_quote(mp, session)
    await _assert_roster_unchanged(mp, quote, session)

    plan = await _plan_for(mp, session)
    business_type = _business_type(plan)
    expiry = _add_years(mp.effective_date, mp.term_years) - timedelta(days=1)
    covered: Dict[str, float] = quote.breakdown["covered"]
    by_life: Dict[str, float] = quote.breakdown["by_life"]
    adjusted = {m["member_id"]: m for m in quote.breakdown.get("adjusted_members", [])}
    classes = await _benefit_classes(mp.id, session)
    class_names = {c.id: c.name for c in classes}

    emitted: List[Tuple[Policy, PolicyEvent]] = []
    try:
        number = await _next_master_policy_number(session, tenant_id, business_type)
        members_doc, dependents_doc = [], []
        rows = await _member_rows(mp, session)
        for seq, (member, customer, policy) in enumerate(rows, start=1):
            key = str(member.id)
            cover = covered[key]
            certificate = f"{number}/{seq:04d}"
            for step in _ISSUE_PATH.get(_st(policy), []):
                emitted.append((policy, apply_transition(
                    session, policy, step, event_type="GroupCertificateIssued", actor="system",
                    detail={"master_policy_number": number, "certificate": certificate})))
            if _st(policy) != PolicyStatusEnum.PENDING_PAYMENT.value:
                raise IllegalStateTransition(f"Certificate for {customer.name} is {_st(policy)} and can't be issued.")
            policy.policy_number = certificate
            policy.coverage_amount = cover
            policy.effective_date = mp.effective_date
            policy.expiry_date = expiry
            policy.issued_at = datetime.utcnow()
            session.add(policy)

            dependents = (await session.exec(
                select(GroupMemberDependent).where(GroupMemberDependent.group_member_id == member.id)
            )).all()
            member.coverage_amount = cover
            member.cover_end_date = expiry
            member.cover_note = (adjusted.get(key) or {}).get("note")
            member.annual_premium = round(by_life[key] + sum(by_life.get(str(d.id), 0.0) for d in dependents), 2)
            session.add(member)

            members_doc.append({"certificate": certificate, "name": customer.name, "cnic": customer.cnic,
                                "class": class_names.get(member.benefit_class_id), "cover": cover,
                                "note": member.cover_note})
            dependents_doc += [{"member": customer.name, "name": d.name, "relationship": d.relationship,
                                "cover": d.covered_amount} for d in dependents]

        mp.policy_number = number
        mp.expiry_date = expiry
        mp.issued_at = datetime.utcnow()
        mp.status = PENDING_PAYMENT
        mp.schedule_document_path = generate_master_schedule({
            "tenant_name": await _tenant_name(tenant_id, session),
            "organization": org.name,
            "plan_label": plan.label if plan is not None else "Group Life",
            "business_type": business_type,
            "master_policy_id": str(mp.id),
            "policy_number": number,
            "effective_date": mp.effective_date,
            "expiry_date": expiry,
            "total_premium": quote.total_premium,
            "free_cover_limit": mp.free_cover_limit,
            "classes": [{"name": c.name, "basis_text": _basis_text(c)} for c in classes],
            "members": members_doc,
            "dependents": dependents_doc,
            "takaful": quote.breakdown.get("takaful"),
        })
        session.add(mp)
        await session.commit()
    except IllegalStateTransition as exc:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

    await _publish_certificate_events(request, emitted)
    await session.refresh(mp)
    return GroupIssueResponse(
        master_policy=await _master_policy_read(mp, session),
        certificates_issued=len(rows),
        total_premium=quote.total_premium,
        amount_due=quote.total_premium,
    )


@router.post(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/payments",
    response_model=GroupIssueResponse,
    dependencies=[Depends(verify_admin)],
)
async def record_group_payment(tenant_id: UUID, org_id: UUID, mp_id: UUID, body: GroupPaymentCreate,
                               session: AsyncSession = Depends(get_session), request: Request = None):  # type: ignore[assignment]
    """Record the employer's premium/contribution. Full payment binds cover
    for the whole scheme: master policy, every certificate, member and
    dependant go Active, and the organization becomes a policyholder."""
    org = await _get_organization(tenant_id, org_id, session)
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    if mp.status != PENDING_PAYMENT:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Master policy is not awaiting payment (current: {mp.status}).")
    quote = await _accepted_quote(mp, session)
    if body.amount + 0.01 < quote.total_premium:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Payment of PKR {body.amount:,.2f} is less than the annual amount due (PKR {quote.total_premium:,.2f}).",
        )

    emitted: List[Tuple[Policy, PolicyEvent]] = []
    try:
        rows = await _member_rows(mp, session)
        for member, _customer, policy in rows:
            emitted.append((policy, apply_transition(
                session, policy, PolicyStatusEnum.ACTIVE, event_type="GroupCoverBound", actor="system",
                detail={"master_policy_number": mp.policy_number, "payment_reference": body.reference})))
            member.status = GroupMemberStatus.ACTIVE.value
            session.add(member)
            for d in (await session.exec(
                select(GroupMemberDependent).where(GroupMemberDependent.group_member_id == member.id)
            )).all():
                d.status = GroupMemberStatus.ACTIVE.value
                session.add(d)
        mp.status = ACTIVE
        mp.premium_paid_at = datetime.utcnow()
        mp.payment_reference = body.reference
        org.profile_status = ProfileStatusEnum.POLICYHOLDER
        session.add_all([mp, org])
        await session.commit()
    except IllegalStateTransition as exc:
        await session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

    await _publish_certificate_events(request, emitted)
    await session.refresh(mp)
    return GroupIssueResponse(
        master_policy=await _master_policy_read(mp, session),
        certificates_issued=len(rows),
        total_premium=quote.total_premium,
        amount_due=0.0,
    )


@router.get(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/schedule/document",
    dependencies=[Depends(verify_admin)],
)
async def download_master_schedule(tenant_id: UUID, org_id: UUID, mp_id: UUID, session: AsyncSession = Depends(get_session)):
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    if not mp.schedule_document_path or not os.path.exists(mp.schedule_document_path):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "The schedule is generated at issuance.")
    return FileResponse(mp.schedule_document_path, media_type="application/pdf",
                        filename=f"schedule-{mp.policy_number}.pdf")
