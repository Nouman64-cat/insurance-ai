import logging
import re
from typing import Literal, Optional
from typing import Optional
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, or_
from sqlalchemy.orm import selectinload
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from schemas import CustomerCreate, CustomerRead, CustomerStatsRead, CustomerUpdate, PolicyCreate, PolicyRead
from shared.events.kafka_events import CUSTOMER_CREATED_TOPIC, CustomerCreatedEvent, CustomerCreatedPayload
from shared.models.core import AcquisitionSource, Customer, Policy, Tenant, ProfileStatusEnum, PolicyStatusEnum
from routers.users import verify_admin   # reuse existing Admin guard

# A customer counts as "taking insurance" once a policy has cleared underwriting.
ACTIVE_POLICY_STATUSES = (PolicyStatusEnum.APPROVED, PolicyStatusEnum.ISSUED)

CustomerCategory = Literal["active", "full_details", "quick_lead", "not_interested"]


def _active_policy_exists(tenant_id: UUID):
    return (
        select(Policy.id)
        .where(
            Policy.tenant_id == tenant_id,
            Policy.customer_id == Customer.id,
            Policy.status.in_(ACTIVE_POLICY_STATUSES),
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
    session: AsyncSession = Depends(get_session),
):
    query = (
        select(Customer)
        .where(Customer.tenant_id == tenant_id)
        .options(selectinload(Customer.acquisition_source))
    cnic: Optional[str] = None,
    name: Optional[str] = None,
    session: AsyncSession = Depends(get_session),
):
    query = select(Customer).where(Customer.tenant_id == tenant_id)
    if cnic:
        query = query.where(Customer.cnic == cnic)
    if name:
        query = query.where(Customer.name.ilike(f"%{name}%"))
        
    result = await session.exec(
        query.options(selectinload(Customer.acquisition_source))
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

    active_exists = _active_policy_exists(tenant_id)
    if category == "active":
        query = query.where(active_exists)
    elif category == "not_interested":
        # An active policyholder always wins the "active" bucket even if flagged
        # NOT_INTERESTED at some earlier point — keeps the four categories disjoint.
        query = query.where(Customer.profile_status == ProfileStatusEnum.NOT_INTERESTED, ~active_exists)
    elif category == "quick_lead":
        query = query.where(Customer.profile_status == ProfileStatusEnum.LEAD, ~active_exists)
    elif category == "full_details":
        query = query.where(
            Customer.profile_status.in_([ProfileStatusEnum.PROSPECT, ProfileStatusEnum.UNDERWRITING_READY]),
            ~active_exists,
        )

    query = query.order_by(Customer.created_at.desc())
    result = await session.exec(query)
    return list(result.all())


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
    not_interested = await _count(Customer.profile_status == ProfileStatusEnum.NOT_INTERESTED, ~active_exists)
    quick_leads = await _count(Customer.profile_status == ProfileStatusEnum.LEAD, ~active_exists)
    full_details = await _count(
        Customer.profile_status.in_([ProfileStatusEnum.PROSPECT, ProfileStatusEnum.UNDERWRITING_READY]),
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
    await session.delete(customer)
    await session.commit()
    return None

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
