"""
Post-Underwriting — Facultative Reinsurance Referral.

This runs *after* the underwriter has formed a view and *before* final approval
is issued — deliberately not a pre-underwriting gate. A reinsurer is not being
asked to underwrite the case from scratch; it is being asked to take the slice
of a risk that exceeds this insurer's own retention, on the strength of the
decision and evidence we have already assembled. That is why the slip carries
our AI assessment, our medical results and our financial justification, and why
the answer comes back as *terms that modify ours*.

    assess    → split the sum assured into retained / treaty / facultative
    refer     → build and submit the slip; policy parks at ReinsurerReferred
    response  → record the reinsurer's decision and terms as received
    apply     → write those terms onto the contract and release the policy:
                clean acceptance → Approved
                extra mortality / exclusions → CounterOffer (revised terms the
                    customer must accept — you cannot bind terms nobody agreed to)
                reinsurer declines → Declined; postpones → Postponed
    withdraw  → pull the referral, returning the case to the underwriter

Cession arithmetic lives in services/underwriting_limits.py so the medical and
history screens read the same retention numbers. Slip assembly and the terms →
revised-offer translation live in services/reinsurance_engine.py.

There is no live reinsurer API to call: Munich Re / Swiss Re / Hannover Re
facultative traffic is email- and portal-based, so submission marks the slip as
sent and the terms are keyed in when the reinsurer answers. The engine's
``expected_terms`` gives the underwriter a costed expectation to check the real
answer against — labelled as an expectation, never presented as the reinsurer's
reply.
"""

from datetime import date, datetime, timedelta
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, _role_name, oauth2_scheme
from routers.policies import _get_policy, _publish_policy_event, _st
from services import reinsurance_engine
from shared.models.core import (
    AgentConfidentialReport,
    Case,
    CounterOffer,
    CounterOfferStatusEnum,
    CounterOfferTypeEnum,
    Customer,
    InsuranceHistoryCheck,
    MedicalExamOrder,
    Policy,
    PolicyStatusEnum,
    PremiumQuote,
    Reinsurer,
    ReinsuranceReferral,
    ReinsuranceReferralStatusEnum,
    ReinsuranceReferralTypeEnum,
    ReinsurerDecisionEnum,
    RiskAssessment,
    Tenant,
)
from shared.services.policy_state_machine import IllegalStateTransition, apply_transition

router = APIRouter(tags=["Post-Underwriting — Reinsurance"])

# Ceding a risk commits the insurer's treaty relationships and changes the terms
# offered to the customer — an underwriting authority, not a clerical one.
_REINSURANCE_ROLES = {"Underwriter", "Admin", "SuperAdmin"}

# Statuses from which a case can legitimately be referred: the underwriter has
# the file open, or has already reached a decision that now needs capacity
# behind it.
_REFERABLE_STATUSES = {"UnderReview", "Approved", "AcceptedWithLoadings", "InformationRequested"}

# The standard life-reinsurance panel a Pakistani insurer places business with.
# Capacities are illustrative treaty terms, per life, in PKR.
_DEFAULT_PANEL: list[dict] = [
    {"code": "MUNICH-RE", "name": "Munich Re", "country": "Germany", "am_best_rating": "A+",
     "contact_email": "facultative.life@munichre.example", "is_lead": True,
     "treaty_capacity": 20_000_000, "facultative_capacity": 250_000_000, "typical_response_days": 5},
    {"code": "SWISS-RE", "name": "Swiss Re", "country": "Switzerland", "am_best_rating": "A+",
     "contact_email": "life.fac@swissre.example", "is_lead": False,
     "treaty_capacity": 20_000_000, "facultative_capacity": 250_000_000, "typical_response_days": 5},
    {"code": "HANNOVER-RE", "name": "Hannover Re", "country": "Germany", "am_best_rating": "A+",
     "contact_email": "life.fac@hannover-re.example", "is_lead": False,
     "treaty_capacity": 15_000_000, "facultative_capacity": 200_000_000, "typical_response_days": 7},
    {"code": "RGA", "name": "RGA Reinsurance Company", "country": "United States", "am_best_rating": "A+",
     "contact_email": "fac@rgare.example", "is_lead": False,
     "treaty_capacity": 15_000_000, "facultative_capacity": 150_000_000, "typical_response_days": 7},
    {"code": "SCOR", "name": "SCOR SE", "country": "France", "am_best_rating": "A",
     "contact_email": "life.fac@scor.example", "is_lead": False,
     "treaty_capacity": 12_000_000, "facultative_capacity": 120_000_000, "typical_response_days": 10},
    {"code": "PAK-RE", "name": "Pakistan Reinsurance Company Limited", "country": "Pakistan",
     "am_best_rating": "A-", "contact_email": "underwriting@pakre.example", "is_lead": False,
     "treaty_capacity": 8_000_000, "facultative_capacity": 60_000_000, "typical_response_days": 10},
]


def _v(x):
    return x.value if hasattr(x, "value") else (str(x) if x is not None else None)


async def _assert_role(token: str, session: AsyncSession) -> str:
    user = await _get_current_user(token, session)
    role = await _role_name(user, session)
    if role not in _REINSURANCE_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Reinsurance actions require one of: "
                   f"{', '.join(sorted(_REINSURANCE_ROLES))} (you are {role}).",
        )
    return user.email or str(user.id)


# ── Reinsurer panel ──────────────────────────────────────────────────────────

async def ensure_reinsurers(session: AsyncSession, tenant_id: UUID) -> list[Reinsurer]:
    """Return the tenant's reinsurance panel, seeding the standard one on first
    use so a new tenant can place business immediately."""
    stmt = select(Reinsurer).where(Reinsurer.tenant_id == tenant_id)
    panel = list((await session.exec(stmt)).all())
    if panel:
        return panel

    for spec in _DEFAULT_PANEL:
        session.add(Reinsurer(tenant_id=tenant_id, **spec))
    await session.commit()
    return list((await session.exec(stmt)).all())


def _reinsurer_dict(r: Reinsurer) -> dict:
    return {
        "id": str(r.id),
        "code": r.code,
        "name": r.name,
        "country": r.country,
        "am_best_rating": r.am_best_rating,
        "contact_email": r.contact_email,
        "is_lead": r.is_lead,
        "treaty_capacity": r.treaty_capacity,
        "facultative_capacity": r.facultative_capacity,
        "typical_response_days": r.typical_response_days,
        "is_active": r.is_active,
    }


@router.get("/tenants/{tenant_id}/reinsurers")
async def list_reinsurers(
    tenant_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user(token, session)
    panel = await ensure_reinsurers(session, tenant_id)
    rows = [r for r in panel if r.is_active]
    rows.sort(key=lambda r: (not r.is_lead, r.name))
    return [_reinsurer_dict(r) for r in rows]


class ReinsurerCreate(BaseModel):
    code: str
    name: str
    country: Optional[str] = None
    am_best_rating: Optional[str] = None
    contact_email: Optional[str] = None
    is_lead: bool = False
    treaty_capacity: float = 0.0
    facultative_capacity: float = 0.0
    typical_response_days: int = 5


@router.post("/tenants/{tenant_id}/reinsurers", status_code=201)
async def create_reinsurer(
    tenant_id: UUID,
    body: ReinsurerCreate,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _assert_role(token, session)
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None or not tenant.is_active:
        raise HTTPException(status_code=404, detail="Tenant not found or inactive")

    existing = (await session.exec(
        select(Reinsurer).where(Reinsurer.tenant_id == tenant_id, Reinsurer.code == body.code)
    )).first()
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"A reinsurer with code '{body.code}' already exists.")

    reinsurer = Reinsurer(tenant_id=tenant_id, **body.model_dump())
    session.add(reinsurer)
    await session.commit()
    await session.refresh(reinsurer)
    return _reinsurer_dict(reinsurer)


# ── Referral state ───────────────────────────────────────────────────────────

async def _load_referral(session: AsyncSession, policy_id: UUID) -> Optional[ReinsuranceReferral]:
    stmt = (
        select(ReinsuranceReferral)
        .where(ReinsuranceReferral.policy_id == policy_id)
        .order_by(ReinsuranceReferral.created_at.desc())  # type: ignore[arg-type]
    )
    return (await session.exec(stmt)).first()


async def _referral_dict(session: AsyncSession, ref: Optional[ReinsuranceReferral]) -> Optional[dict]:
    if ref is None:
        return None
    reinsurer = await session.get(Reinsurer, ref.reinsurer_id) if ref.reinsurer_id else None
    return {
        "id": str(ref.id),
        "status": _v(ref.status),
        "referral_type": _v(ref.referral_type),
        "total_sum_assured": ref.total_sum_assured,
        "retention_limit": ref.retention_limit,
        "retained_amount": ref.retained_amount,
        "treaty_ceded_amount": ref.treaty_ceded_amount,
        "facultative_ceded_amount": ref.facultative_ceded_amount,
        "cession_pct": ref.cession_pct,
        "reinsurance_premium": ref.reinsurance_premium,
        "reinsurer": _reinsurer_dict(reinsurer) if reinsurer else None,
        "slip": ref.slip_json,
        "submitted_at": ref.submitted_at.isoformat() if ref.submitted_at else None,
        "submitted_by": ref.submitted_by,
        "response_due_at": ref.response_due_at.isoformat() if ref.response_due_at else None,
        "reinsurer_decision": _v(ref.reinsurer_decision),
        "reinsurer_reference": ref.reinsurer_reference,
        "extra_mortality_pct": ref.extra_mortality_pct,
        "extra_premium_per_mille": ref.extra_premium_per_mille,
        "imposed_exclusions": ref.imposed_exclusions or [],
        "reinsurer_conditions": ref.reinsurer_conditions,
        "responded_at": ref.responded_at.isoformat() if ref.responded_at else None,
        "terms_applied": ref.terms_applied,
        "terms_applied_at": ref.terms_applied_at.isoformat() if ref.terms_applied_at else None,
        "applied_counter_offer_id": str(ref.applied_counter_offer_id) if ref.applied_counter_offer_id else None,
        "created_at": ref.created_at.isoformat(),
    }


async def _case_context(session: AsyncSession, policy: Policy) -> dict:
    """Everything the slip needs, gathered from the rest of the case file."""
    customer = await session.get(Customer, policy.customer_id)

    assessment = (await session.exec(
        select(RiskAssessment)
        .where(RiskAssessment.policy_id == policy.id)
        .order_by(RiskAssessment.created_at.desc())  # type: ignore[arg-type]
    )).first()
    if assessment is None:
        assessment = (await session.exec(
            select(RiskAssessment)
            .where(RiskAssessment.customer_id == policy.customer_id)
            .order_by(RiskAssessment.created_at.desc())  # type: ignore[arg-type]
        )).first()

    case = (await session.exec(
        select(Case)
        .where(Case.policy_id == policy.id)
        .order_by(Case.createdAt.desc())  # type: ignore[arg-type]
    )).first()

    medical = acr = history_row = None
    if case is not None:
        medical = (await session.exec(
            select(MedicalExamOrder).where(MedicalExamOrder.case_id == case.caseld)
        )).first()
        acr = (await session.exec(
            select(AgentConfidentialReport).where(AgentConfidentialReport.case_id == case.caseld)
        )).first()
        history_row = (await session.exec(
            select(InsuranceHistoryCheck).where(InsuranceHistoryCheck.case_id == case.caseld)
        )).first()

    history = None
    if history_row is not None:
        history = {
            "status": _v(history_row.status),
            "aggregate_sum_assured": history_row.aggregate_sum_assured,
            "hlv_limit": history_row.hlv_limit,
            "hlv_ratio": history_row.hlv_ratio,
            "internal_inforce_sum_assured": history_row.internal_inforce_sum_assured,
            "external_declared_sum_assured": history_row.external_declared_sum_assured,
            "has_prior_decline": history_row.has_prior_decline,
            "findings": history_row.findings_json or [],
        }

    return {
        "customer": customer,
        "assessment": assessment,
        "case": case,
        "medical": medical,
        "acr": acr,
        "history": history,
    }


@router.get("/tenants/{tenant_id}/policies/{policy_id}/reinsurance")
async def get_reinsurance(
    tenant_id: UUID,
    policy_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """The cession position for this policy: what we keep, what the treaty
    absorbs, what needs a facultative placement — plus any live referral."""
    await _get_current_user(token, session)
    policy = await _get_policy(session, tenant_id, policy_id)

    ctx = await _case_context(session, policy)
    customer = ctx["customer"]
    if customer is None:
        raise HTTPException(status_code=404, detail="Customer not found for this policy")

    cession = reinsurance_engine.assess(policy, customer)
    referral = await _load_referral(session, policy_id)

    return {
        "policy_id": str(policy_id),
        "policy_status": _st(policy),
        "cession": cession,
        "referral_required": cession["referral_required"],
        "can_refer": _st(policy) in _REFERABLE_STATUSES,
        "referral": await _referral_dict(session, referral),
        "expected_terms": reinsurance_engine.expected_terms(
            assessment=ctx["assessment"], medical=ctx["medical"], history=ctx["history"]
        ),
        "panel": [_reinsurer_dict(r) for r in await ensure_reinsurers(session, tenant_id)],
    }


# ── Refer ────────────────────────────────────────────────────────────────────

class ReferRequest(BaseModel):
    reinsurer_id: UUID
    underwriter_note: Optional[str] = None


@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinsurance/refer")
async def refer_to_reinsurer(
    tenant_id: UUID,
    policy_id: UUID,
    body: ReferRequest,
    request: Request,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """Build the facultative slip, send it, and park the policy at
    ReinsurerReferred until terms come back."""
    actor = await _assert_role(token, session)
    policy = await _get_policy(session, tenant_id, policy_id)

    if _st(policy) not in _REFERABLE_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"A case cannot be referred to a reinsurer from status {_st(policy)} — "
                   "refer it once underwriting has formed a view.",
        )

    ctx = await _case_context(session, policy)
    customer = ctx["customer"]
    if customer is None:
        raise HTTPException(status_code=404, detail="Customer not found for this policy")

    cession = reinsurance_engine.assess(policy, customer)
    if not cession["referral_required"]:
        raise HTTPException(
            status_code=409,
            detail=f"No facultative referral is needed: PKR {cession['total_sum_assured']:,.0f} sits within "
                   f"the automatic capacity of PKR {cession['automatic_capacity']:,.0f} "
                   f"(retention {cession['retention_limit']:,.0f} + treaty {cession['treaty_capacity']:,.0f}).",
        )

    reinsurer = await session.get(Reinsurer, body.reinsurer_id)
    if reinsurer is None or reinsurer.tenant_id != tenant_id or not reinsurer.is_active:
        raise HTTPException(status_code=404, detail="Reinsurer not found on this tenant's panel.")
    if reinsurer.facultative_capacity and cession["facultative_ceded_amount"] > reinsurer.facultative_capacity:
        raise HTTPException(
            status_code=400,
            detail=f"{reinsurer.name}'s facultative capacity is PKR {reinsurer.facultative_capacity:,.0f}; "
                   f"this cession needs PKR {cession['facultative_ceded_amount']:,.0f}. "
                   "Split the placement or choose another reinsurer.",
        )

    existing = await _load_referral(session, policy_id)
    if existing is not None and existing.status in (
        ReinsuranceReferralStatusEnum.SUBMITTED, ReinsuranceReferralStatusEnum.QUOTED
    ):
        raise HTTPException(
            status_code=409,
            detail="A referral for this policy is already open — record the reinsurer's response "
                   "or withdraw it before referring again.",
        )

    slip = reinsurance_engine.build_slip(
        customer=customer,
        policy=policy,
        cession=cession,
        assessment=ctx["assessment"],
        medical=ctx["medical"],
        acr=ctx["acr"],
        history=ctx["history"],
        underwriter_note=body.underwriter_note,
    )

    now = datetime.utcnow()
    referral = ReinsuranceReferral(
        tenant_id=tenant_id,
        policy_id=policy_id,
        customer_id=customer.id,
        case_id=ctx["case"].caseld if ctx["case"] else None,
        referral_type=ReinsuranceReferralTypeEnum.FACULTATIVE,
        status=ReinsuranceReferralStatusEnum.SUBMITTED,
        total_sum_assured=cession["total_sum_assured"],
        retention_limit=cession["retention_limit"],
        retained_amount=cession["retained_amount"],
        treaty_ceded_amount=cession["treaty_ceded_amount"],
        facultative_ceded_amount=cession["facultative_ceded_amount"],
        cession_pct=cession["cession_pct"],
        reinsurance_premium=cession["reinsurance_premium"],
        reinsurer_id=reinsurer.id,
        slip_json=slip,
        submitted_at=now,
        submitted_by=actor,
        response_due_at=now + timedelta(days=reinsurer.typical_response_days),
    )
    session.add(referral)

    event = None
    if _st(policy) != PolicyStatusEnum.REINSURER_REFERRED.value:
        try:
            event = apply_transition(
                session, policy, PolicyStatusEnum.REINSURER_REFERRED,
                event_type="ReinsurerReferred", actor=actor,
                detail={
                    "reinsurer": reinsurer.name,
                    "facultative_ceded_amount": cession["facultative_ceded_amount"],
                    "retention_limit": cession["retention_limit"],
                },
            )
        except IllegalStateTransition as exc:
            await session.rollback()
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    await session.commit()
    await session.refresh(referral)
    if event is not None:
        await _publish_policy_event(request, policy, event)

    return {
        "policy_id": str(policy_id),
        "policy_status": _st(policy),
        "referral": await _referral_dict(session, referral),
    }


# ── Response ─────────────────────────────────────────────────────────────────

class ReinsurerResponseRequest(BaseModel):
    decision: ReinsurerDecisionEnum
    reinsurer_reference: Optional[str] = None
    # Extra mortality rating over 100% standard — 150 means "half again".
    extra_mortality_pct: Optional[float] = None
    extra_premium_per_mille: Optional[float] = None
    exclusions: Optional[list[str]] = None
    conditions: Optional[str] = None


@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinsurance/response")
async def record_reinsurer_response(
    tenant_id: UUID,
    policy_id: UUID,
    body: ReinsurerResponseRequest,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """Key in the terms the reinsurer returned. Recording is separate from
    applying them: an underwriter may want to challenge an EMR or shop the risk
    to another panel member before committing the customer to revised terms."""
    await _assert_role(token, session)
    await _get_policy(session, tenant_id, policy_id)

    referral = await _load_referral(session, policy_id)
    if referral is None:
        raise HTTPException(status_code=404, detail="No reinsurance referral exists for this policy.")
    if referral.status not in (
        ReinsuranceReferralStatusEnum.SUBMITTED, ReinsuranceReferralStatusEnum.QUOTED
    ):
        raise HTTPException(
            status_code=409,
            detail=f"This referral is {_v(referral.status)} — no response can be recorded against it.",
        )

    if body.decision in (
        ReinsurerDecisionEnum.ACCEPT_WITH_LOADING, ReinsurerDecisionEnum.ACCEPT_WITH_EXCLUSION
    ) and not (body.extra_mortality_pct or body.exclusions):
        raise HTTPException(
            status_code=422,
            detail="A conditional acceptance needs the condition: supply an extra mortality "
                   "percentage, an exclusion list, or both.",
        )

    now = datetime.utcnow()
    referral.reinsurer_decision = body.decision
    referral.reinsurer_reference = body.reinsurer_reference
    referral.extra_mortality_pct = body.extra_mortality_pct
    referral.extra_premium_per_mille = body.extra_premium_per_mille
    referral.imposed_exclusions = body.exclusions or None
    referral.reinsurer_conditions = body.conditions
    referral.responded_at = now
    referral.status = (
        ReinsuranceReferralStatusEnum.DECLINED
        if body.decision == ReinsurerDecisionEnum.DECLINE
        else ReinsuranceReferralStatusEnum.QUOTED
    )
    referral.updated_at = now

    session.add(referral)
    await session.commit()
    await session.refresh(referral)
    return await _referral_dict(session, referral)


# ── Apply ────────────────────────────────────────────────────────────────────

class ApplyTermsRequest(BaseModel):
    # How long the customer has to accept revised terms, when terms are imposed.
    valid_days: int = 21
    note: Optional[str] = None


@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinsurance/apply")
async def apply_reinsurer_terms(
    tenant_id: UUID,
    policy_id: UUID,
    body: ApplyTermsRequest,
    request: Request,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """Write the reinsurer's terms onto the contract and release the policy.

    Where the reinsurer imposed an extra mortality or an exclusion, the customer
    is offered revised terms rather than being bound silently — the loading is
    blended down to the ceded share of the risk, since the retained portion is
    still on our own standard rates.
    """
    actor = await _assert_role(token, session)
    policy = await _get_policy(session, tenant_id, policy_id)

    referral = await _load_referral(session, policy_id)
    if referral is None:
        raise HTTPException(status_code=404, detail="No reinsurance referral exists for this policy.")
    if referral.terms_applied:
        raise HTTPException(status_code=409, detail="These reinsurer terms have already been applied.")
    if referral.reinsurer_decision is None:
        raise HTTPException(
            status_code=409,
            detail="Record the reinsurer's response before applying its terms.",
        )

    decision = _v(referral.reinsurer_decision)
    now = datetime.utcnow()
    offer: Optional[CounterOffer] = None
    event = None

    try:
        if decision == ReinsurerDecisionEnum.DECLINE.value:
            # The excess cannot be placed, so the cover cannot be written as
            # proposed. Reducing the sum assured to within retention is a
            # separate, deliberate counter-offer an underwriter makes by hand.
            event = apply_transition(
                session, policy, PolicyStatusEnum.DECLINED,
                event_type="ReinsurerDeclined", actor=actor,
                detail={"reinsurer_reference": referral.reinsurer_reference,
                        "conditions": referral.reinsurer_conditions},
            )
            referral.status = ReinsuranceReferralStatusEnum.DECLINED

        elif decision == ReinsurerDecisionEnum.POSTPONE.value:
            event = apply_transition(
                session, policy, PolicyStatusEnum.POSTPONED,
                event_type="ReinsurerPostponed", actor=actor,
                detail={"conditions": referral.reinsurer_conditions},
            )
            referral.status = ReinsuranceReferralStatusEnum.ACCEPTED

        else:
            terms = reinsurance_engine.terms_to_counter_offer(referral)
            if terms is None:
                # Standard terms — nothing changes for the customer.
                event = apply_transition(
                    session, policy, PolicyStatusEnum.APPROVED,
                    event_type="ReinsurerAcceptedStandardTerms", actor=actor,
                    detail={"reinsurer_reference": referral.reinsurer_reference,
                            "ceded_amount": referral.facultative_ceded_amount},
                )
            else:
                offer = await _build_counter_offer(
                    session, tenant_id, policy, terms, actor, body.valid_days
                )
                session.add(offer)
                event = apply_transition(
                    session, policy, PolicyStatusEnum.COUNTER_OFFER,
                    event_type="ReinsurerTermsImposed", actor=actor,
                    detail={
                        "reinsurer_reference": referral.reinsurer_reference,
                        "extra_mortality_pct": referral.extra_mortality_pct,
                        "exclusions": referral.imposed_exclusions or [],
                        "blended_loading_pct": terms.get("revised_loading_pct"),
                    },
                )
            referral.status = ReinsuranceReferralStatusEnum.ACCEPTED

        referral.terms_applied = True
        referral.terms_applied_at = now
        referral.updated_at = now
        session.add(referral)
        await session.commit()
    except IllegalStateTransition as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    if offer is not None:
        await session.refresh(offer)
        referral.applied_counter_offer_id = offer.id
        session.add(referral)
        await session.commit()

    await session.refresh(referral)
    if event is not None:
        await _publish_policy_event(request, policy, event)

    return {
        "policy_id": str(policy_id),
        "policy_status": _st(policy),
        "counter_offer_id": str(offer.id) if offer else None,
        "referral": await _referral_dict(session, referral),
    }


async def _build_counter_offer(
    session: AsyncSession,
    tenant_id: UUID,
    policy: Policy,
    terms: dict,
    actor: str,
    valid_days: int,
) -> CounterOffer:
    """Turn reinsurer terms into revised terms for the customer, superseding any
    offer already on the table (mirrors pre_issuance.create_counter_offer)."""
    for prev in (await session.exec(
        select(CounterOffer).where(
            CounterOffer.policy_id == policy.id,
            CounterOffer.status == CounterOfferStatusEnum.PENDING,
        )
    )).all():
        prev.status = CounterOfferStatusEnum.EXPIRED
        prev.responded_at = datetime.utcnow()
        session.add(prev)

    quote = (await session.exec(
        select(PremiumQuote)
        .where(PremiumQuote.policy_id == policy.id)
        .order_by(PremiumQuote.created_at.desc())  # type: ignore[arg-type]
    )).first()
    original_premium = quote.total_premium if quote else None
    base_premium = quote.base_premium if quote else None

    loading = terms.get("revised_loading_pct")
    revised_premium = original_premium
    if loading and base_premium is not None:
        revised_premium = round(
            base_premium * (1 + loading / 100.0)
            + ((original_premium - base_premium) if original_premium else 0),
            0,
        )

    exclusions = terms.get("exclusions")
    return CounterOffer(
        tenant_id=tenant_id,
        policy_id=policy.id,
        offer_type=CounterOfferTypeEnum(terms["offer_type"]),
        status=CounterOfferStatusEnum.PENDING,
        original_coverage_amount=policy.coverage_amount,
        original_premium=original_premium,
        original_product_name=policy.product_name,
        revised_loading_pct=loading,
        revised_premium=revised_premium,
        exclusions_json={"items": exclusions} if exclusions else None,
        reason=terms.get("reason"),
        valid_until=date.today() + timedelta(days=max(1, valid_days)),
        created_by=actor,
    )


# ── Withdraw ─────────────────────────────────────────────────────────────────

class WithdrawRequest(BaseModel):
    reason: Optional[str] = None


@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinsurance/withdraw")
async def withdraw_referral(
    tenant_id: UUID,
    policy_id: UUID,
    body: WithdrawRequest,
    request: Request,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """Pull an open referral — e.g. the risk is being placed with another panel
    member, or the sum assured has been reduced within retention. The case
    returns to the underwriter."""
    actor = await _assert_role(token, session)
    policy = await _get_policy(session, tenant_id, policy_id)

    referral = await _load_referral(session, policy_id)
    if referral is None:
        raise HTTPException(status_code=404, detail="No reinsurance referral exists for this policy.")
    if referral.status not in (
        ReinsuranceReferralStatusEnum.SUBMITTED, ReinsuranceReferralStatusEnum.QUOTED,
        ReinsuranceReferralStatusEnum.REQUIRED,
    ):
        raise HTTPException(
            status_code=409,
            detail=f"A {_v(referral.status)} referral cannot be withdrawn.",
        )

    now = datetime.utcnow()
    referral.status = ReinsuranceReferralStatusEnum.WITHDRAWN
    referral.reinsurer_conditions = body.reason or referral.reinsurer_conditions
    referral.updated_at = now
    session.add(referral)

    event = None
    if _st(policy) == PolicyStatusEnum.REINSURER_REFERRED.value:
        try:
            event = apply_transition(
                session, policy, PolicyStatusEnum.UNDER_REVIEW,
                event_type="ReinsurerReferralWithdrawn", actor=actor,
                detail={"reason": body.reason},
            )
        except IllegalStateTransition as exc:
            await session.rollback()
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    await session.commit()
    await session.refresh(referral)
    if event is not None:
        await _publish_policy_event(request, policy, event)

    return {
        "policy_id": str(policy_id),
        "policy_status": _st(policy),
        "referral": await _referral_dict(session, referral),
    }
