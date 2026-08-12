"""
POST /quote — instant, deterministic premium quotation.

Deliberately separate from POST /evaluate (routers/evaluate.py): that endpoint
runs the LangGraph AI underwriting pipeline (medical/financial/fraud scoring
via Gemini, over Kafka) and can take seconds to minutes. A quotation is pure
actuarial math — coverage, term, age, smoker/BMI factors against the tenant's
InsurancePlan rate table — and returns in one synchronous round-trip, the same
way a real insurer shows an indicative premium the moment you fill in the
onboarding form, before formal underwriting ever runs.

No Kafka, no LLM. Eligibility and rates are read straight from the tenant's
own InsurancePlan row (entry age band, term band, max_maturity_age,
max_income_multiple, base_premium_rate, smoker_factor) so a tenant admin's
edits via the Insurance Plans UI take effect immediately.
"""

from datetime import date, datetime, timezone
from typing import Optional, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from dependencies import get_current_user, get_tenant_id
from schemas import QuoteDetail, QuoteListItem, QuoteRequest, QuoteResponse, QuoteUpdate
from shared.models.core import (
    AcquisitionSource,
    AcquisitionSourceType,
    Customer,
    FamilyGroup,
    FamilyPlanTypeEnum,
    FamilyPolicy,
    InsurancePlan,
    InsuranceTypeEnum,
    MasterPolicy,
    Organization,
    Policy,
    PolicyStatusEnum,
    PremiumQuote,
    Role,
    Tenant,
    User,
)
from shared.pricing.calculator import calculate_premium
from shared.services.policy_state_machine import IllegalStateTransition, apply_transition

router = APIRouter(tags=["Quotation"])

# Statuses that represent an underwriting *decision* (accept/decline/refer) —
# only an Underwriter (or Admin/SuperAdmin) may set these. Everything else in
# PolicyStatusEnum reachable from the proposal stage (Proposed, UnderReview,
# InformationRequested) is submission-side and an Agent may set it too.
_DECISION_STATUSES = {
    PolicyStatusEnum.APPROVED,
    PolicyStatusEnum.ACCEPTED_WITH_LOADINGS,
    PolicyStatusEnum.DECLINED,
    PolicyStatusEnum.POSTPONED,
    PolicyStatusEnum.REINSURER_REFERRED,
}
_DECISION_ROLES = {"Underwriter", "Admin", "SuperAdmin"}
_SUBMISSION_ROLES = {"Agent", "Underwriter", "Admin", "SuperAdmin"}

SLA_TARGET_DAYS = {
    PolicyStatusEnum.PROPOSED: 2,
    PolicyStatusEnum.UNDER_REVIEW: 5,
    PolicyStatusEnum.INFORMATION_REQUESTED: 7,
}

def _sla_status(status: PolicyStatusEnum, updated_at: datetime) -> tuple[str | None, float | None]:
    target_days = SLA_TARGET_DAYS.get(status)
    if not target_days:
        return None, None
    days_elapsed = (datetime.now(timezone.utc) - updated_at).total_seconds() / 86400.0
    days_remaining = target_days - days_elapsed
    if days_remaining < 0:
        return "breached", round(days_remaining, 1)
    if days_remaining <= 1.0:
        return "approaching_breach", round(days_remaining, 1)
    return "within_sla", round(days_remaining, 1)

def _row_to_detail(quote, policy, customer, source, master_policy, org, family_policy, family_group, underwriter) -> QuoteDetail:
    bmi = None
    if customer.height_cm > 0:
        height_m = customer.height_cm / 100
        bmi = round(customer.weight_kg / (height_m * height_m), 1)
    
    sla_stat, sla_days = _sla_status(policy.status, policy.updated_at)
    
    return QuoteDetail(
        quote_id=quote.id,
        customer_id=customer.id,
        customer_name=customer.name,
        customer_cnic=customer.cnic,
        policy_id=policy.id,
        plan_label=policy.product_name,
        insurance_type=policy.insurance_type,
        coverage_amount=policy.coverage_amount,
        term_years=policy.term_years,
        base_premium=quote.base_premium,
        loading_applied=quote.loading_applied,
        total_premium=quote.total_premium,
        rate_version=quote.rate_version,
        created_at=quote.created_at,
        status=policy.status,
        effective_date=policy.effective_date,
        updated_at=policy.updated_at,
        assigned_underwriter_id=underwriter.id if underwriter else None,
        assigned_underwriter_name=underwriter.full_name if underwriter else None,
        sla_status=sla_stat,
        sla_days_remaining=sla_days,
        acquisition_source_id=source.id if source else None,
        acquisition_source_name=source.name if source else None,
        acquisition_source_type=source.source_type.value if source else None,
        acquisition_source_partner=source.partner_name if source else None,
        organization_id=org.id if org else None,
        organization_name=org.name if org else None,
        master_policy_id=master_policy.id if master_policy else None,
        master_policy_label=_master_policy_label(master_policy) if master_policy else None,
        family_group_id=family_group.id if family_group else None,
        family_group_name=family_group.name if family_group else None,
        family_policy_id=family_policy.id if family_policy else None,
        family_policy_label=_family_policy_label(family_policy) if family_policy else None,
        customer_dob=customer.dob,
        customer_age=_age_from_dob(customer.dob),
        customer_gender=customer.gender,
        customer_occupation=customer.occupation,
        customer_declared_income=customer.declared_income,
        customer_is_smoker=customer.is_smoker,
        customer_height_cm=customer.height_cm,
        customer_weight_kg=customer.weight_kg,
        customer_bmi=bmi,
        nominee_name=policy.nominee_name,
        nominee_relationship=policy.nominee_relationship,
        dependent_name=policy.dependent_name,
        dependent_dob=policy.dependent_dob,
    )


@router.get(
    "/quotes",
    response_model=list[QuoteListItem],
    summary="List all generated quotations for this tenant (manual + auto-generated)",
)
async def list_quotes(
    search: Optional[str] = Query(None),
    status_filter: Optional[PolicyStatusEnum] = Query(None, alias="status"),
    insurance_type: Optional[InsuranceTypeEnum] = Query(None),
    product_name: Optional[str] = Query(None),
    premium_min: Optional[float] = Query(None),
    premium_max: Optional[float] = Query(None),
    coverage_min: Optional[float] = Query(None),
    coverage_max: Optional[float] = Query(None),
    assigned_underwriter_id: Optional[UUID] = Query(None),
    assigned_agent_id: Optional[UUID] = Query(None),
    acquisition_source_id: Optional[UUID] = Query(None),
    channel: Optional[AcquisitionSourceType] = Query(None),
    effective_date_from: Optional[date] = Query(None),
    effective_date_to: Optional[date] = Query(None),
    created_from: Optional[datetime] = Query(None),
    created_to: Optional[datetime] = Query(None),
    last_modified_from: Optional[datetime] = Query(None),
    last_modified_to: Optional[datetime] = Query(None),
    tenant_id: UUID = Depends(get_tenant_id),
    session: AsyncSession = Depends(get_session),
) -> list[QuoteListItem]:
    stmt = (
        select(PremiumQuote, Policy, Customer, AcquisitionSource, MasterPolicy, Organization, FamilyPolicy, FamilyGroup, User)
        .join(Policy, PremiumQuote.policy_id == Policy.id)
        .join(Customer, Policy.customer_id == Customer.id)
        .outerjoin(AcquisitionSource, Customer.acquisition_source_id == AcquisitionSource.id)
        .outerjoin(MasterPolicy, Policy.master_policy_id == MasterPolicy.id)
        .outerjoin(Organization, MasterPolicy.organization_id == Organization.id)
        .outerjoin(FamilyPolicy, Policy.family_policy_id == FamilyPolicy.id)
        .outerjoin(FamilyGroup, FamilyPolicy.family_group_id == FamilyGroup.id)
        .outerjoin(User, Policy.assigned_underwriter_id == User.id)
        .where(PremiumQuote.tenant_id == tenant_id)
    )

    if search:
        search_term = f"%{search}%"
        stmt = stmt.where(
            (Customer.name.ilike(search_term)) |
            (Customer.cnic.ilike(search_term)) |
            (Policy.product_name.ilike(search_term)) |
            (PremiumQuote.id.cast(str).ilike(search_term))
        )
    if status_filter:
        stmt = stmt.where(Policy.status == status_filter)
    if insurance_type:
        stmt = stmt.where(Policy.insurance_type == insurance_type)
    if product_name:
        stmt = stmt.where(Policy.product_name.ilike(f"%{product_name}%"))
    if premium_min is not None:
        stmt = stmt.where(PremiumQuote.total_premium >= premium_min)
    if premium_max is not None:
        stmt = stmt.where(PremiumQuote.total_premium <= premium_max)
    if coverage_min is not None:
        stmt = stmt.where(Policy.coverage_amount >= coverage_min)
    if coverage_max is not None:
        stmt = stmt.where(Policy.coverage_amount <= coverage_max)
    if assigned_underwriter_id:
        stmt = stmt.where(Policy.assigned_underwriter_id == assigned_underwriter_id)
    if assigned_agent_id:
        stmt = stmt.where(Customer.assigned_agent_id == assigned_agent_id)
    if acquisition_source_id:
        stmt = stmt.where(Customer.acquisition_source_id == acquisition_source_id)
    if channel:
        stmt = stmt.where(AcquisitionSource.source_type == channel)
    if effective_date_from:
        stmt = stmt.where(Policy.effective_date >= effective_date_from)
    if effective_date_to:
        stmt = stmt.where(Policy.effective_date <= effective_date_to)
    if created_from:
        stmt = stmt.where(PremiumQuote.created_at >= created_from)
    if created_to:
        stmt = stmt.where(PremiumQuote.created_at <= created_to)
    if last_modified_from:
        stmt = stmt.where(Policy.updated_at >= last_modified_from)
    if last_modified_to:
        stmt = stmt.where(Policy.updated_at <= last_modified_to)

    stmt = stmt.order_by(PremiumQuote.created_at.desc())
    rows = (await session.exec(stmt)).all()

    items = []
    for quote, policy, customer, source, master_policy, org, family_policy, family_group, underwriter in rows:
        sla_stat, sla_days = _sla_status(policy.status, policy.updated_at)
        items.append(
            QuoteListItem(
                quote_id=quote.id,
                customer_id=customer.id,
                customer_name=customer.name,
                customer_cnic=customer.cnic,
                policy_id=policy.id,
                plan_label=policy.product_name,
                insurance_type=policy.insurance_type,
                coverage_amount=policy.coverage_amount,
                term_years=policy.term_years,
                base_premium=quote.base_premium,
                loading_applied=quote.loading_applied,
                total_premium=quote.total_premium,
                rate_version=quote.rate_version,
                created_at=quote.created_at,
                status=policy.status,
                effective_date=policy.effective_date,
                updated_at=policy.updated_at,
                assigned_underwriter_id=underwriter.id if underwriter else None,
                assigned_underwriter_name=underwriter.full_name if underwriter else None,
                sla_status=sla_stat,
                sla_days_remaining=sla_days,
                acquisition_source_id=source.id if source else None,
                acquisition_source_name=source.name if source else None,
                acquisition_source_type=source.source_type.value if source else None,
                acquisition_source_partner=source.partner_name if source else None,
                organization_id=org.id if org else None,
                organization_name=org.name if org else None,
                master_policy_id=master_policy.id if master_policy else None,
                master_policy_label=_master_policy_label(master_policy) if master_policy else None,
                family_group_id=family_group.id if family_group else None,
                family_group_name=family_group.name if family_group else None,
                family_policy_id=family_policy.id if family_policy else None,
                family_policy_label=_family_policy_label(family_policy) if family_policy else None,
            )
        )
    return items


@router.get(
    "/quotes/{quote_id}",
    response_model=QuoteDetail,
    summary="Get full detail (customer + policy + premium breakdown) for a single quotation",
)
async def get_quote_detail(
    quote_id: UUID,
    tenant_id: UUID = Depends(get_tenant_id),
    session: AsyncSession = Depends(get_session),
) -> QuoteDetail:
    stmt = (
        select(PremiumQuote, Policy, Customer, AcquisitionSource, MasterPolicy, Organization, FamilyPolicy, FamilyGroup, User)
        .join(Policy, PremiumQuote.policy_id == Policy.id)
        .join(Customer, Policy.customer_id == Customer.id)
        .outerjoin(AcquisitionSource, Customer.acquisition_source_id == AcquisitionSource.id)
        .outerjoin(MasterPolicy, Policy.master_policy_id == MasterPolicy.id)
        .outerjoin(Organization, MasterPolicy.organization_id == Organization.id)
        .outerjoin(FamilyPolicy, Policy.family_policy_id == FamilyPolicy.id)
        .outerjoin(FamilyGroup, FamilyPolicy.family_group_id == FamilyGroup.id)
        .outerjoin(User, Policy.assigned_underwriter_id == User.id)
        .where(PremiumQuote.id == quote_id, PremiumQuote.tenant_id == tenant_id)
    )
    row = (await session.exec(stmt)).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Quote '{quote_id}' not found for this tenant.",
        )
    quote, policy, customer, source, master_policy, org, family_policy, family_group, underwriter = row
    return _row_to_detail(quote, policy, customer, source, master_policy, org, family_policy, family_group, underwriter)

@router.patch(
    "/quotes/{quote_id}",
    response_model=QuoteDetail,
    summary="Update a quotation's policy details (status, underwriter, effective date)",
)
async def update_quote(
    quote_id: UUID,
    body: QuoteUpdate,
    tenant_id: UUID = Depends(get_tenant_id),
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> QuoteDetail:
    stmt = (
        select(PremiumQuote, Policy, Customer, AcquisitionSource, MasterPolicy, Organization, FamilyPolicy, FamilyGroup, User)
        .join(Policy, PremiumQuote.policy_id == Policy.id)
        .join(Customer, Policy.customer_id == Customer.id)
        .outerjoin(AcquisitionSource, Customer.acquisition_source_id == AcquisitionSource.id)
        .outerjoin(MasterPolicy, Policy.master_policy_id == MasterPolicy.id)
        .outerjoin(Organization, MasterPolicy.organization_id == Organization.id)
        .outerjoin(FamilyPolicy, Policy.family_policy_id == FamilyPolicy.id)
        .outerjoin(FamilyGroup, FamilyPolicy.family_group_id == FamilyGroup.id)
        .outerjoin(User, Policy.assigned_underwriter_id == User.id)
        .where(PremiumQuote.id == quote_id, PremiumQuote.tenant_id == tenant_id)
    )
    row = (await session.exec(stmt)).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Quote '{quote_id}' not found for this tenant.",
        )
    quote, policy, customer, source, master_policy, org, family_policy, family_group, underwriter = row

    updated = False
    if body.status is not None:
        actor_role = await session.get(Role, current_user.role_id)
        actor_role_name = actor_role.name if actor_role else "Viewer"
        required_roles = _DECISION_ROLES if body.status in _DECISION_STATUSES else _SUBMISSION_ROLES
        if actor_role_name not in required_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Setting status to '{body.status.value}' requires one of: {', '.join(sorted(required_roles))} (you are {actor_role_name}).",
            )
        try:
            apply_transition(
                session, policy, body.status,
                event_type="proposal_status_change",
                actor=str(current_user.id),
            )
        except IllegalStateTransition as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
        updated = True
    if body.assigned_underwriter_id is not None:
        policy.assigned_underwriter_id = body.assigned_underwriter_id
        updated = True
        
        # Refetch underwriter so response is accurate
        underwriter_stmt = select(User).where(User.id == body.assigned_underwriter_id)
        underwriter = (await session.exec(underwriter_stmt)).first()
    if body.effective_date is not None:
        policy.effective_date = body.effective_date
        updated = True
        
    if updated:
        policy.updated_at = datetime.utcnow()
        session.add(policy)
        await session.commit()
        await session.refresh(policy)
        
    return _row_to_detail(quote, policy, customer, source, master_policy, org, family_policy, family_group, underwriter)


def _age_from_dob(dob: date) -> int:
    return (date.today() - dob).days // 365


def _master_policy_label(master_policy: MasterPolicy) -> str:
    return f"{master_policy.sum_assured_multiple:g}× · effective {master_policy.effective_date.isoformat()}"


def _family_policy_label(family_policy: FamilyPolicy) -> str:
    if family_policy.plan_type == FamilyPlanTypeEnum.FLOATER:
        pool = family_policy.total_sum_insured or 0
        return f"Floater · {pool:,.0f} pool"
    return f"Life Bundle · {family_policy.discount_percentage or 0:g}% discount"


@router.post(
    "/quote",
    response_model=QuoteResponse,
    summary="Get an instant premium quote (no AI, no Kafka — synchronous)",
)
async def get_quote(
    request: QuoteRequest,
    tenant_id: UUID = Depends(get_tenant_id),
    session: AsyncSession = Depends(get_session),
) -> QuoteResponse:
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tenant '{tenant_id}' not found. Create it first via POST /tenants.",
        )

    # ── 1. Plan lookup ────────────────────────────────────────────────────────
    plan_stmt = select(InsurancePlan).where(
        InsurancePlan.tenant_id == tenant_id,
        InsurancePlan.code == request.policy.plan_code,
    )
    plan = (await session.exec(plan_stmt)).first()
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No plan with code '{request.policy.plan_code}' found for this tenant.",
        )
    if plan.insurance_type == InsuranceTypeEnum.GROUP_LIFE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="GROUP_LIFE plans are priced per-MasterPolicy, not via /quote.",
        )

    # ── 2. Eligibility — against the plan's own DB-stored bands ───────────────
    customer_in = request.customer
    policy_in = request.policy
    age = _age_from_dob(customer_in.dob)
    annual_income = customer_in.monthly_income * 12

    errors: list[str] = []
    if age < plan.entry_age_min or age > plan.entry_age_max:
        errors.append(
            f"[{plan.label}] Customer age {age} is outside the eligible entry band "
            f"({plan.entry_age_min}-{plan.entry_age_max})."
        )
    if policy_in.term_years < plan.term_min_years or policy_in.term_years > plan.term_max_years:
        errors.append(
            f"[{plan.label}] Policy term must be between {plan.term_min_years} and "
            f"{plan.term_max_years} years (got {policy_in.term_years})."
        )
    if age + policy_in.term_years > plan.max_maturity_age:
        errors.append(
            f"[{plan.label}] Maturity age ({age + policy_in.term_years}) exceeds "
            f"maximum of {plan.max_maturity_age}."
        )
    if policy_in.coverage_amount > annual_income * plan.max_income_multiple:
        errors.append(
            f"[{plan.label}] Coverage amount ({policy_in.coverage_amount:,.0f}) exceeds "
            f"{plan.max_income_multiple:g}x annual income "
            f"({annual_income * plan.max_income_multiple:,.0f})."
        )

    if errors:
        return QuoteResponse(eligible=False, eligibility_errors=errors)

    # ── 3. Premium calculation ─────────────────────────────────────────────────
    breakdown = calculate_premium(
        coverage_amount=policy_in.coverage_amount,
        base_premium_rate=plan.base_premium_rate,
        smoker_factor=plan.smoker_factor,
        age=age,
        is_smoker=customer_in.is_smoker,
        height_cm=customer_in.height_cm,
        weight_kg=customer_in.weight_kg,
    )

    # ── 4. Persist — find-or-create Customer, create Policy + PremiumQuote ──
    customer_stmt = select(Customer).where(
        Customer.tenant_id == tenant_id,
        Customer.cnic == customer_in.cnic,
    )
    customer = (await session.exec(customer_stmt)).first()
    if customer is None:
        customer = Customer(
            tenant_id=tenant_id,
            cnic=customer_in.cnic,
            name=customer_in.name,
            dob=customer_in.dob,
            gender=customer_in.gender,
            occupation=customer_in.occupation,
            declared_income=annual_income,
            is_smoker=customer_in.is_smoker,
            height_cm=customer_in.height_cm,
            weight_kg=customer_in.weight_kg,
            assigned_agent_id=customer_in.assigned_agent_id,
        )
        session.add(customer)
        await session.flush()

    policy = Policy(
        tenant_id=tenant_id,
        customer_id=customer.id,
        product_name=plan.label,
        insurance_type=plan.insurance_type,
        coverage_amount=policy_in.coverage_amount,
        term_years=policy_in.term_years,
        nominee_name=policy_in.nominee_name,
        nominee_relationship=policy_in.nominee_relationship,
    )
    session.add(policy)
    await session.flush()

    quote = PremiumQuote(
        tenant_id=tenant_id,
        policy_id=policy.id,
        base_premium=breakdown.base_premium,
        loading_applied=breakdown.loading_applied,
        total_premium=breakdown.total_premium,
        rate_version=plan.rate_version,
    )
    session.add(quote)
    await session.commit()
    await session.refresh(quote)

    return QuoteResponse(
        eligible=True,
        quote_id=quote.id,
        customer_id=customer.id,
        policy_id=policy.id,
        annual_income=annual_income,
        plan_code=plan.code,
        plan_label=plan.label,
        coverage_amount=policy_in.coverage_amount,
        term_years=policy_in.term_years,
        base_premium=breakdown.base_premium,
        loading_applied=breakdown.loading_applied,
        total_premium=breakdown.total_premium,
        rate_version=plan.rate_version,
        reasons=breakdown.reasons,
        created_at=quote.created_at,
    )
