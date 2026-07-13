import logging
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from schemas import ApplicantCreate, ApplicantRead, ApplicantUpdate, PolicyRead
from shared.events.kafka_events import APPLICANT_CREATED_TOPIC, ApplicantCreatedEvent, ApplicantCreatedPayload
from shared.models.core import Applicant, Policy, RiskAssessment, Tenant
from routers.users import verify_admin   # reuse existing Admin guard

logger = logging.getLogger("tenant-service.applicants")

router = APIRouter(prefix="/tenants", tags=["Applicants"])


async def _publish_applicant_created(request: Request, tenant_id: UUID, applicant: Applicant) -> None:
    """Fire-and-forget: a failed publish must never fail applicant creation
    itself — the quote worker is a background enhancement, not the source of
    truth for the applicant record."""
    event = ApplicantCreatedEvent(
        tenant_id=tenant_id,
        payload=ApplicantCreatedPayload(
            applicant_id=applicant.id,
            cnic=applicant.cnic,
            name=applicant.name,
            dob=str(applicant.dob),
            gender=applicant.gender.value,
            occupation=applicant.occupation,
            declared_income=applicant.declared_income,
            is_smoker=applicant.is_smoker,
            height_cm=applicant.height_cm,
            weight_kg=applicant.weight_kg,
        ),
    )
    try:
        producer = request.app.state.kafka_producer
        await producer.send_and_wait(
            APPLICANT_CREATED_TOPIC,
            value=event.model_dump_json(),
            key=str(tenant_id),
        )
    except Exception:
        logger.exception("Failed to publish ApplicantCreated event | applicant_id=%s", applicant.id)

@router.post(
    "/{tenant_id}/applicants",
    response_model=ApplicantRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_applicant(
    tenant_id: UUID,
    body: ApplicantCreate,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> Applicant:
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
            select(Applicant).where(
                Applicant.tenant_id == tenant_id,
                Applicant.cnic == body.cnic,
            )
        )
    ).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"CNIC '{body.cnic}' already registered for this tenant"
        )

    # 3. Persist — tenant_id is always taken from the path (JWT-scoped)
    applicant = Applicant(
        tenant_id       = tenant_id,
        cnic            = body.cnic,
        name            = f"{body.first_name} {body.last_name}".strip(),
        dob             = body.date_of_birth,
        gender          = body.gender,
        occupation      = body.occupation,
        declared_income = body.declared_income,
        is_smoker       = body.is_smoker,
        height_cm       = body.height_cm,
        weight_kg       = body.weight_kg,
        details         = body.details,
    )
    session.add(applicant)
    await session.commit()
    await session.refresh(applicant)

    # Kick off background quotation generation (Kafka) — see quote_worker.py
    # in api-gateway. Runs after commit so the worker never races the read.
    await _publish_applicant_created(request, tenant_id, applicant)

    return applicant

@router.get(
    "/{tenant_id}/applicants",
    response_model=list[ApplicantRead],
    dependencies=[Depends(verify_admin)],
)
async def list_applicants(
    tenant_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    result = await session.exec(
        select(Applicant).where(Applicant.tenant_id == tenant_id)
    )
    return list(result.all())

@router.get(
    "/{tenant_id}/applicants/{applicant_id}",
    response_model=ApplicantRead,
    dependencies=[Depends(verify_admin)],
)
async def get_applicant(
    tenant_id: UUID,
    applicant_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    applicant = await session.get(Applicant, applicant_id)
    if not applicant or applicant.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Applicant not found"
        )
    return applicant

@router.get(
    "/{tenant_id}/applicants/{applicant_id}/policies",
    response_model=list[PolicyRead],
    dependencies=[Depends(verify_admin)],
)
async def list_applicant_policies(
    tenant_id: UUID,
    applicant_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    applicant = await session.get(Applicant, applicant_id)
    if not applicant or applicant.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Applicant not found"
        )

    result = await session.exec(
        select(Policy)
        .where(Policy.tenant_id == tenant_id, Policy.applicant_id == applicant_id)
        .order_by(Policy.created_at.desc())
    )
    return list(result.all())


@router.delete(
    "/{tenant_id}/applicants/{applicant_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_admin)],
)
async def delete_applicant(
    tenant_id: UUID,
    applicant_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    applicant = await session.get(Applicant, applicant_id)
    if not applicant or applicant.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Applicant not found"
        )
    # Delete related risk assessments first (FK → applicant_id)
    assessments = (await session.exec(
        select(RiskAssessment).where(RiskAssessment.applicant_id == applicant_id)
    )).all()
    for a in assessments:
        await session.delete(a)

    # Delete related policies (FK → applicant_id is NOT NULL — must go before applicant)
    policies = (await session.exec(
        select(Policy).where(Policy.applicant_id == applicant_id)
    )).all()
    for p in policies:
        await session.delete(p)

    await session.delete(applicant)
    await session.commit()
    return None

@router.put(
    "/{tenant_id}/applicants/{applicant_id}",
    response_model=ApplicantRead,
    dependencies=[Depends(verify_admin)],
)
async def update_applicant(
    tenant_id: UUID,
    applicant_id: UUID,
    body: ApplicantUpdate,
    session: AsyncSession = Depends(get_session),
) -> Applicant:
    applicant = await session.get(Applicant, applicant_id)
    if not applicant or applicant.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Applicant not found"
        )

    # Update identity fields
    if body.cnic is not None:
        if body.cnic != applicant.cnic:
            existing = (
                await session.exec(
                    select(Applicant).where(
                        Applicant.tenant_id == tenant_id,
                        Applicant.cnic == body.cnic,
                        Applicant.id != applicant_id
                    )
                )
            ).first()
            if existing:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"CNIC '{body.cnic}' already registered for this tenant"
                )
        applicant.cnic = body.cnic

    if body.first_name is not None or body.last_name is not None:
        parts = applicant.name.split(" ", 1)
        existing_first = parts[0] if len(parts) > 0 else ""
        existing_last = parts[1] if len(parts) > 1 else ""
        
        fname = body.first_name if body.first_name is not None else existing_first
        lname = body.last_name if body.last_name is not None else existing_last
        applicant.name = f"{fname} {lname}".strip()

    if body.date_of_birth is not None:
        applicant.dob = body.date_of_birth
    if body.gender is not None:
        applicant.gender = body.gender
    if body.occupation is not None:
        applicant.occupation = body.occupation
    if body.declared_income is not None:
        applicant.declared_income = body.declared_income
    if body.is_smoker is not None:
        applicant.is_smoker = body.is_smoker
    if body.height_cm is not None:
        applicant.height_cm = body.height_cm
    if body.weight_kg is not None:
        applicant.weight_kg = body.weight_kg
    if body.details is not None:
        applicant.details = body.details

    session.add(applicant)
    await session.commit()
    await session.refresh(applicant)
    return applicant
