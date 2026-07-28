import logging
import re
from datetime import date, timedelta
from datetime import date
from typing import Literal, Optional
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, or_, cast, String
from sqlalchemy.orm import selectinload
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from schemas import CustomerCreate, CustomerRead, CustomerStatsRead, CustomerUpdate, PolicyCreate, PolicyRead, PolicyUpdate
from shared.events.kafka_events import CUSTOMER_CREATED_TOPIC, CustomerCreatedEvent, CustomerCreatedPayload
from shared.models.core import (
    AcquisitionSource, Beneficiary, Case, ComplianceCheck, CounterOffer,
    Customer, Policy, PolicyDocument, PolicyEvent, PolicyRequirement,
    PolicyVersion, PremiumQuote, PremiumSchedule, Tenant,
    ProfileStatusEnum, PolicyStatusEnum, InsurancePlan,
)
from shared.pricing.calculator import calculate_premium
from routers.users import verify_admin   # reuse existing Admin guard

# A customer counts as a policyholder only once a policy is actually bound and in-force.
# APPROVED is intentionally excluded — it means "approved by underwriting but not yet issued",
# i.e. still sitting in the Policy Issuance queue. Including it caused customers to appear
# in the Policyholders page before they had any real coverage.
ACTIVE_POLICY_STATUSES = (PolicyStatusEnum.ISSUED, PolicyStatusEnum.ACTIVE)

CustomerCategory = Literal["active", "full_details", "quick_lead", "not_interested"]


def _active_policy_exists(tenant_id: UUID):
    return (
        select(Policy.id)
        .where(
            Policy.tenant_id == tenant_id,
            Policy.customer_id == Customer.id,
            func.upper(cast(Policy.status, String)).in_([status.value.upper() for status in ACTIVE_POLICY_STATUSES]),
        )
        .exists()
    )

logger = logging.getLogger("tenant-service.customers")

router = APIRouter(prefix="/tenants", tags=["Customers"])


async def _publish_customer_created(request: Request, tenant_id: UUID, customer: Customer) -> None:
    """Fire-and-forget: a failed publish must never fail customer creation
    itself — the quote worker is a background enhancement, not the source of
    truth for the customer record."""
    if not request or not hasattr(request, "app") or not hasattr(request.app, "state"):
        return

    gender_val = customer.gender.value if customer.gender and hasattr(customer.gender, "value") else (str(customer.gender) if customer.gender else None)
    marital_val = customer.marital_status.value if customer.marital_status and hasattr(customer.marital_status, "value") else (str(customer.marital_status) if customer.marital_status else None)

    event = CustomerCreatedEvent(
        tenant_id=tenant_id,
        payload=CustomerCreatedPayload(
            customer_id=customer.id,
            cnic=customer.cnic,
            name=customer.name,
            dob=str(customer.dob) if customer.dob else None,
            gender=gender_val,
            marital_status=marital_val,
            occupation=customer.occupation,
            declared_income=customer.declared_income,
            is_smoker=customer.is_smoker,
            height_cm=customer.height_cm,
            weight_kg=customer.weight_kg,
        ),
    )
    try:
        producer = getattr(request.app.state, "kafka_producer", None)
        if producer:
            await producer.send_and_wait(
                CUSTOMER_CREATED_TOPIC,
                value=event.model_dump_json(),
                key=str(tenant_id),
            )
    except Exception as err:
        logger.warning(f"Failed to publish customer created event: {err}")
        logger.exception("Failed to publish CustomerCreated event | customer_id=%s", customer.id)

@router.post(
    "/{tenant_id}/customers",
    response_model=CustomerRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_customer(
    tenant_id: UUID,
    body: CustomerCreate,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> Customer:
    # 1. Verify tenant exists and is active
    tenant = await session.get(Tenant, tenant_id)
    if not tenant or not tenant.is_active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tenant not found or inactive"
        )

    # 2. Duplicate CNIC guard (per-tenant unique constraint, only if CNIC provided)
    if body.cnic:
        existing = (
            await session.exec(
                select(Customer).where(
                    Customer.tenant_id == tenant_id,
                    Customer.cnic == body.cnic,
                )
            )
        ).first()
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"CNIC '{body.cnic}' already registered for this tenant"
            )

    # Determine initial profile status
    status_val = body.profile_status
    if not status_val:
        if body.cnic and body.date_of_birth and body.declared_income and body.occupation:
            status_val = ProfileStatusEnum.UNDERWRITING_READY
        elif body.date_of_birth or body.declared_income or body.occupation:
            status_val = ProfileStatusEnum.PROSPECT
        else:
            status_val = ProfileStatusEnum.LEAD

    # 3. Persist — tenant_id is always taken from the path (JWT-scoped)
    customer = Customer(
        tenant_id       = tenant_id,
        cnic            = body.cnic,
        name            = f"{body.first_name} {body.last_name or ''}".strip(),
        dob             = body.date_of_birth,
        gender          = body.gender,
        marital_status  = body.marital_status,
        occupation      = body.occupation,
        declared_income = body.declared_income,
        is_smoker       = body.is_smoker if body.is_smoker is not None else False,
        height_cm       = body.height_cm if body.height_cm is not None else 170.0,
        weight_kg       = body.weight_kg if body.weight_kg is not None else 70.0,
        profile_status  = status_val,
        acquisition_source_id = body.acquisition_source_id,
        branch_id       = body.branch_id,
        assigned_agent_id = body.assigned_agent_id,
        city            = body.city,
        province        = body.province,
        details         = body.details,
    )
    session.add(customer)
    await session.commit()
    await session.refresh(customer)
    if customer.acquisition_source_id:
        await session.refresh(customer, ["acquisition_source"])

    # Kick off background quotation generation (Kafka) — see quote_worker.py
    # in api-gateway. Runs after commit so the worker never races the read.
    await _publish_customer_created(request, tenant_id, customer)

    return customer

@router.get(
    "/{tenant_id}/customers",
    response_model=list[CustomerRead],
    dependencies=[Depends(verify_admin)],
)
async def list_customers(
    tenant_id: UUID,
    search: Optional[str] = Query(None, description="Matches name, CNIC, or acquisition source name"),
    category: Optional[CustomerCategory] = Query(None, description="active | full_details | quick_lead | not_interested"),
    acquisition_source_id: Optional[UUID] = None,
    branch_id: Optional[UUID] = None,
    assigned_agent_id: Optional[UUID] = None,
    city: Optional[str] = None,
    province: Optional[str] = None,
    created_from: Optional[date] = None,
    created_to: Optional[date] = None,
    session: AsyncSession = Depends(get_session),
):
    query = (
        select(Customer)
        .where(Customer.tenant_id == tenant_id)
        .options(selectinload(Customer.acquisition_source))
    )


    term = (search or "").strip()
    if term:
        digits = re.sub(r"\D", "", term)
        conditions = [Customer.name.ilike(f"%{term}%")]
        conditions.append(
            func.replace(Customer.cnic, "-", "").ilike(f"%{digits}%") if digits else Customer.cnic.ilike(f"%{term}%")
        )
        query = query.outerjoin(AcquisitionSource, Customer.acquisition_source_id == AcquisitionSource.id).where(
            or_(*conditions, AcquisitionSource.name.ilike(f"%{term}%"))
        )

    if acquisition_source_id:
        query = query.where(Customer.acquisition_source_id == acquisition_source_id)
    if branch_id:
        query = query.where(Customer.branch_id == branch_id)
    if assigned_agent_id:
        query = query.where(Customer.assigned_agent_id == assigned_agent_id)
    if city:
        query = query.where(Customer.city.ilike(f"%{city}%"))
    if province:
        query = query.where(Customer.province.ilike(f"%{province}%"))
    if created_from:
        query = query.where(Customer.created_at >= created_from)
    if created_to:
        query = query.where(Customer.created_at < created_to + timedelta(days=1))

    active_exists = _active_policy_exists(tenant_id)
    if category == "active":
        query = query.where(active_exists)
    elif category == "not_interested":
        # An active policyholder always wins the "active" bucket even if flagged
        # NOT_INTERESTED at some earlier point — keeps the four categories disjoint.
        query = query.where(cast(Customer.profile_status, String) == ProfileStatusEnum.NOT_INTERESTED.value, ~active_exists)
    elif category == "quick_lead":
        query = query.where(cast(Customer.profile_status, String) == ProfileStatusEnum.LEAD.value, ~active_exists)
    elif category == "full_details":
        query = query.where(
            cast(Customer.profile_status, String).in_([ProfileStatusEnum.PROSPECT.value, ProfileStatusEnum.UNDERWRITING_READY.value, ProfileStatusEnum.DRAFT.value]),
            ~active_exists,
        )

    query = query.order_by(Customer.created_at.desc())
    result = await session.exec(query)
    customers = list(result.all())

    if category == "active" and customers:
        from schemas import CustomerRead
        c_ids = [c.id for c in customers]
        policy_res = await session.exec(
            select(Policy)
            .where(Policy.customer_id.in_(c_ids))
            .where(func.upper(cast(Policy.status, String)).in_([s.value.upper() for s in ACTIVE_POLICY_STATUSES]))
            .order_by(Policy.created_at.desc())
        )
        policy_map = {}
        for p in policy_res.all():
            if p.policy_number and p.customer_id not in policy_map:
                policy_map[p.customer_id] = p.policy_number
                
        out = []
        for c in customers:
            dto = CustomerRead.model_validate(c)
            dto.active_policy_number = policy_map.get(c.id)
            out.append(dto)
        return out

    return customers


@router.get(
    "/{tenant_id}/customers/stats",
    response_model=CustomerStatsRead,
    dependencies=[Depends(verify_admin)],
)
async def get_customer_stats(
    tenant_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    active_exists = _active_policy_exists(tenant_id)

    async def _count(*conditions) -> int:
        result = await session.execute(
            select(func.count()).select_from(Customer).where(Customer.tenant_id == tenant_id, *conditions)
        )
        return result.scalar_one()

    total = await _count()
    active = await _count(active_exists)
    not_interested = await _count(cast(Customer.profile_status, String) == ProfileStatusEnum.NOT_INTERESTED.value, ~active_exists)
    quick_leads = await _count(cast(Customer.profile_status, String) == ProfileStatusEnum.LEAD.value, ~active_exists)
    full_details = await _count(
        cast(Customer.profile_status, String).in_([ProfileStatusEnum.PROSPECT.value, ProfileStatusEnum.UNDERWRITING_READY.value, ProfileStatusEnum.DRAFT.value]),
        ~active_exists,
    )

    return CustomerStatsRead(
        total_customers=total,
        active_policyholders=active,
        full_details=full_details,
        quick_leads=quick_leads,
        not_interested=not_interested,
    )

@router.get(
    "/{tenant_id}/customers/{customer_id}",
    response_model=CustomerRead,
    dependencies=[Depends(verify_admin)],
)
async def get_customer(
    tenant_id: UUID,
    customer_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    result = await session.exec(
        select(Customer)
        .where(Customer.id == customer_id)
        .options(selectinload(Customer.acquisition_source))
    )
    customer = result.first()
    if not customer or customer.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Customer not found"
        )
    return customer

@router.get(
    "/{tenant_id}/customers/{customer_id}/policies",
    response_model=list[PolicyRead],
    dependencies=[Depends(verify_admin)],
)
async def list_customer_policies(
    tenant_id: UUID,
    customer_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    customer = await session.get(Customer, customer_id)
    if not customer or customer.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Customer not found"
        )

    result = await session.exec(
        select(Policy)
        .where(Policy.tenant_id == tenant_id, Policy.customer_id == customer_id)
        .order_by(Policy.created_at.desc())
    )
    return list(result.all())


async def sync_policy_premium_quote(policy: Policy, customer: Customer, session: AsyncSession):
    if not customer.dob:
        return
    
    today = date.today()
    age = (today - customer.dob).days // 365
    
    plan_stmt = select(InsurancePlan).where(
        InsurancePlan.tenant_id == policy.tenant_id,
        InsurancePlan.label == policy.product_name
    )
    plan = (await session.exec(plan_stmt)).first()
    
    if not plan:
        plan_stmt = select(InsurancePlan).where(
            InsurancePlan.tenant_id == policy.tenant_id,
            InsurancePlan.insurance_type == policy.insurance_type
        )
        plan = (await session.exec(plan_stmt)).first()
        
    if not plan:
        base_premium = policy.coverage_amount * 0.01
        total_premium = base_premium
        loading_applied = 0.0
        rate_version = "v1"
    else:
        breakdown = calculate_premium(
            coverage_amount=policy.coverage_amount,
            base_premium_rate=plan.base_premium_rate,
            smoker_factor=plan.smoker_factor,
            age=age,
            is_smoker=customer.is_smoker or False,
            height_cm=customer.height_cm or 170.0,
            weight_kg=customer.weight_kg or 70.0,
        )
        base_premium = breakdown.base_premium
        total_premium = breakdown.total_premium
        loading_applied = breakdown.loading_applied
        rate_version = plan.rate_version

    quote_stmt = select(PremiumQuote).where(PremiumQuote.policy_id == policy.id)
    quote = (await session.exec(quote_stmt)).first()
    
    if quote:
        quote.base_premium = base_premium
        quote.total_premium = total_premium
        quote.loading_applied = loading_applied
        quote.rate_version = rate_version
        session.add(quote)
    else:
        quote = PremiumQuote(
            tenant_id=policy.tenant_id,
            policy_id=policy.id,
            base_premium=base_premium,
            total_premium=total_premium,
            loading_applied=loading_applied,
            rate_version=rate_version
        )
        session.add(quote)



@router.post(
    "/{tenant_id}/customers/{customer_id}/policies",
    response_model=PolicyRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_customer_policy(
    tenant_id: UUID,
    customer_id: UUID,
    body: PolicyCreate,
    session: AsyncSession = Depends(get_session),
):
    customer = await session.get(Customer, customer_id)
    if not customer or customer.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Customer not found"
        )

    policy = Policy(
        tenant_id=tenant_id,
        customer_id=customer_id,
        product_name=body.product_name,
        insurance_type=body.insurance_type,
        coverage_amount=body.coverage_amount,
        term_years=body.term_years,
        dependent_name=body.dependent_name,
        dependent_dob=body.dependent_dob,
        nominee_name=body.nominee_name,
        nominee_relationship=body.nominee_relationship,
        status=PolicyStatusEnum.QUOTED,
    )
    session.add(policy)
    await session.flush()
    await sync_policy_premium_quote(policy, customer, session)
    await session.commit()
    await session.refresh(policy)
    return policy



@router.delete(
    "/{tenant_id}/customers/{customer_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_admin)],
)
async def delete_customer(
    tenant_id: UUID,
    customer_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    customer = await session.get(Customer, customer_id)
    if not customer or customer.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Customer not found"
        )

    # Cascade-delete all child records manually in dependency order
    # so we don't hit FK violations on tables without ON DELETE CASCADE.
    policies = (await session.exec(select(Policy).where(Policy.customer_id == customer_id))).all()
    for policy in policies:
        pid = policy.id
        # Level-3 children (depend on policy)
        for model in (
            PolicyEvent, PolicyDocument, PolicyVersion, PremiumSchedule,
            PremiumQuote, PolicyRequirement, ComplianceCheck, CounterOffer,
            Beneficiary,
        ):
            for row in (await session.exec(select(model).where(model.policy_id == pid))).all():  # type: ignore[attr-defined]
                await session.delete(row)
        # Cases reference policy but may be shared; delete only this policy's cases
        for row in (await session.exec(select(Case).where(Case.policy_id == pid))).all():
            await session.delete(row)
        await session.delete(policy)

    await session.delete(customer)
    await session.commit()
    return None


@router.delete(
    "/{tenant_id}/customers/{customer_id}/policies/{policy_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_admin)],
)
async def delete_customer_policy(
    tenant_id: UUID,
    customer_id: UUID,
    policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    policy = await session.get(Policy, policy_id)
    if not policy or policy.tenant_id != tenant_id or policy.customer_id != customer_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Policy not found"
        )
    await session.delete(policy)
    await session.commit()
    return None


@router.put(
    "/{tenant_id}/customers/{customer_id}/policies/{policy_id}",
    response_model=PolicyRead,
    dependencies=[Depends(verify_admin)],
)
async def update_customer_policy(
    tenant_id: UUID,
    customer_id: UUID,
    policy_id: UUID,
    payload: PolicyUpdate,
    session: AsyncSession = Depends(get_session),
):
    policy = await session.get(Policy, policy_id)
    if not policy or policy.tenant_id != tenant_id or policy.customer_id != customer_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Policy not found"
        )
    
    update_data = payload.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(policy, key, value)
        
    session.add(policy)
    await session.flush()
    
    customer = await session.get(Customer, customer_id)
    if customer:
        await sync_policy_premium_quote(policy, customer, session)
        
    await session.commit()
    await session.refresh(policy)
    return policy



@router.put(
    "/{tenant_id}/customers/{customer_id}",
    response_model=CustomerRead,
    dependencies=[Depends(verify_admin)],
)
async def update_customer(
    tenant_id: UUID,
    customer_id: UUID,
    body: CustomerUpdate,
    session: AsyncSession = Depends(get_session),
) -> Customer:
    customer = await session.get(Customer, customer_id)
    if not customer or customer.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Customer not found"
        )

    # Update identity fields
    if body.cnic is not None:
        if body.cnic != customer.cnic:
            existing = (
                await session.exec(
                    select(Customer).where(
                        Customer.tenant_id == tenant_id,
                        Customer.cnic == body.cnic,
                        Customer.id != customer_id
                    )
                )
            ).first()
            if existing:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"CNIC '{body.cnic}' already registered for this tenant"
                )
        customer.cnic = body.cnic

    if body.first_name is not None or body.last_name is not None:
        parts = customer.name.split(" ", 1)
        existing_first = parts[0] if len(parts) > 0 else ""
        existing_last = parts[1] if len(parts) > 1 else ""
        
        fname = body.first_name if body.first_name is not None else existing_first
        lname = body.last_name if body.last_name is not None else existing_last
        customer.name = f"{fname} {lname}".strip()

    dob_val = body.date_of_birth if body.date_of_birth is not None else getattr(body, "dob", None)
    if dob_val is not None:
        customer.dob = dob_val
    if body.gender is not None:
        customer.gender = body.gender
    if body.marital_status is not None:
        customer.marital_status = body.marital_status
    if body.occupation is not None:
        customer.occupation = body.occupation
    if body.declared_income is not None:
        customer.declared_income = body.declared_income
    if body.is_smoker is not None:
        customer.is_smoker = body.is_smoker
    if body.height_cm is not None:
        customer.height_cm = body.height_cm
    if body.weight_kg is not None:
        customer.weight_kg = body.weight_kg
    if body.acquisition_source_id is not None:
        customer.acquisition_source_id = body.acquisition_source_id
    if body.branch_id is not None:
        customer.branch_id = body.branch_id
    if body.assigned_agent_id is not None:
        customer.assigned_agent_id = body.assigned_agent_id
    if body.city is not None:
        customer.city = body.city
    if body.province is not None:
        customer.province = body.province
    if body.details is not None:
        customer.details = body.details

    # Auto-promote profile status if all required underwriting attributes are present.
    # Skip auto-promotion once a customer has been explicitly marked NOT_INTERESTED —
    # that's a sticky terminal state an unrelated field edit shouldn't silently clear;
    # only an explicit profile_status in the request (a manual "Reactivate") can move it.
    if body.profile_status is not None:
        customer.profile_status = body.profile_status
    elif customer.profile_status != ProfileStatusEnum.NOT_INTERESTED:
        if customer.cnic and customer.dob and customer.declared_income and customer.occupation:
            customer.profile_status = ProfileStatusEnum.UNDERWRITING_READY
        elif customer.dob or customer.declared_income or customer.occupation or customer.cnic:
            if customer.profile_status == ProfileStatusEnum.LEAD:
                customer.profile_status = ProfileStatusEnum.PROSPECT

    session.add(customer)
    await session.commit()
    await session.refresh(customer)
    if customer.acquisition_source_id:
        await session.refresh(customer, ["acquisition_source"])
    return customer
