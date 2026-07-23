import re

with open("services/api-gateway/routers/quote.py", "r") as f:
    code = f.read()

# 1. Update imports
imports = """
from datetime import date, datetime
from typing import Optional, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from dependencies import get_tenant_id
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
    Tenant,
    User,
)
from shared.pricing.calculator import calculate_premium
"""

code = re.sub(r'from datetime import date.*?from shared\.pricing\.calculator import calculate_premium', imports.strip(), code, flags=re.DOTALL)

# 2. SLA target helper
sla_code = """
router = APIRouter(tags=["Quotation"])

SLA_TARGET_DAYS = {
    PolicyStatusEnum.PROPOSED: 2,
    PolicyStatusEnum.UNDER_REVIEW: 5,
    PolicyStatusEnum.INFORMATION_REQUESTED: 7,
}

def _sla_status(status: PolicyStatusEnum, updated_at: datetime) -> tuple[str | None, float | None]:
    target_days = SLA_TARGET_DAYS.get(status)
    if not target_days:
        return None, None
    days_elapsed = (datetime.utcnow() - updated_at).total_seconds() / 86400.0
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
"""

code = code.replace('router = APIRouter(tags=["Quotation"])', sla_code.strip())

# 3. Update list_quotes
list_quotes_new = """
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
"""

code = re.sub(r'@router\.get\(\n    "/quotes",.*?return \[.*?\]', list_quotes_new.strip(), code, flags=re.DOTALL)

# 4. Update get_quote_detail and add update_quote
get_quote_detail_new = """
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
        policy.status = body.status
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
"""

code = re.sub(r'@router\.get\(\n    "/quotes/\{quote_id\}".*?dependent_dob=policy\.dependent_dob,\n    \)', get_quote_detail_new.strip(), code, flags=re.DOTALL)

with open("services/api-gateway/routers/quote.py", "w") as f:
    f.write(code)

print("success")
