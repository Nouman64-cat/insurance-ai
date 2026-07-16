import logging
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from schemas import CustomerCreate, CustomerRead, CustomerUpdate, PolicyRead
from shared.events.kafka_events import CUSTOMER_CREATED_TOPIC, CustomerCreatedEvent, CustomerCreatedPayload
from shared.models.core import Customer, Policy, Tenant
from routers.users import verify_admin   # reuse existing Admin guard

logger = logging.getLogger("tenant-service.customers")

router = APIRouter(prefix="/tenants", tags=["Customers"])


async def _publish_customer_created(request: Request, tenant_id: UUID, customer: Customer) -> None:
    """Fire-and-forget: a failed publish must never fail customer creation
    itself — the quote worker is a background enhancement, not the source of
    truth for the customer record."""
    event = CustomerCreatedEvent(
        tenant_id=tenant_id,
        payload=CustomerCreatedPayload(
            customer_id=customer.id,
            cnic=customer.cnic,
            name=customer.name,
            dob=str(customer.dob),
            gender=customer.gender.value,
            occupation=customer.occupation,
            declared_income=customer.declared_income,
            is_smoker=customer.is_smoker,
            height_cm=customer.height_cm,
            weight_kg=customer.weight_kg,
        ),
    )
    try:
        producer = request.app.state.kafka_producer
        await producer.send_and_wait(
            CUSTOMER_CREATED_TOPIC,
            value=event.model_dump_json(),
            key=str(tenant_id),
        )
    except Exception:
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

    # 2. Duplicate CNIC guard (per-tenant unique constraint)
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

    # 3. Persist — tenant_id is always taken from the path (JWT-scoped)
    customer = Customer(
        tenant_id       = tenant_id,
        cnic            = body.cnic,
        name            = f"{body.first_name} {body.last_name}".strip(),
        dob             = body.date_of_birth,
        gender          = body.gender,
        marital_status  = body.marital_status,
        occupation      = body.occupation,
        declared_income = body.declared_income,
        is_smoker       = body.is_smoker,
        height_cm       = body.height_cm,
        weight_kg       = body.weight_kg,
        details         = body.details,
    )
    session.add(customer)
    await session.commit()
    await session.refresh(customer)

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
    session: AsyncSession = Depends(get_session),
):
    result = await session.exec(
        select(Customer).where(Customer.tenant_id == tenant_id)
    )
    return list(result.all())

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
    customer = await session.get(Customer, customer_id)
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

    if body.date_of_birth is not None:
        customer.dob = body.date_of_birth
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
    if body.details is not None:
        customer.details = body.details

    session.add(customer)
    await session.commit()
    await session.refresh(customer)
    return customer
