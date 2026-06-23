from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from schemas import ApplicantCreate, ApplicantRead, ApplicantUpdate
from shared.models.core import Applicant, Tenant
from routers.users import verify_admin   # reuse existing Admin guard

router = APIRouter(prefix="/tenants", tags=["Applicants"])

@router.post(
    "/{tenant_id}/applicants",
    response_model=ApplicantRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_applicant(
    tenant_id: UUID,
    body: ApplicantCreate,
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
        details         = body.details,
    )
    session.add(applicant)
    await session.commit()
    await session.refresh(applicant)
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
    if body.details is not None:
        applicant.details = body.details

    session.add(applicant)
    await session.commit()
    await session.refresh(applicant)
    return applicant
