from datetime import date
from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from group_underwriting import normalize_cnic, validate_census, validate_sum_assured_multiple
from schemas import (
    ApplicantRead,
    CensusConfirmResponse,
    CensusRequest,
    CensusValidationResponse,
    MasterPolicyCreate,
    MasterPolicyRead,
    OrganizationCreate,
    OrganizationRead,
    OrganizationUpdate,
)
from shared.models.core import Applicant, InsuranceTypeEnum, MasterPolicy, Organization, Policy, Tenant
from routers.users import verify_admin   # reuse existing Admin guard — tenant-scoped for Admin, cross-tenant for SuperAdmin

router = APIRouter(prefix="/tenants", tags=["Organizations"])


def _verify_tenant(tenant: Tenant | None, tenant_id: UUID) -> Tenant:
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Tenant '{tenant_id}' not found.")
    return tenant


async def _get_organization(tenant_id: UUID, org_id: UUID, session: AsyncSession) -> Organization:
    org = await session.get(Organization, org_id)
    if not org or org.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found.")
    return org


async def _get_master_policy(tenant_id: UUID, org_id: UUID, mp_id: UUID, session: AsyncSession) -> MasterPolicy:
    mp = await session.get(MasterPolicy, mp_id)
    if not mp or mp.tenant_id != tenant_id or mp.organization_id != org_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Master policy not found.")
    return mp


# ── Organizations ───────────────────────────────────────────────────────────────

@router.post(
    "/{tenant_id}/organizations",
    response_model=OrganizationRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_organization(
    tenant_id: UUID,
    body: OrganizationCreate,
    session: AsyncSession = Depends(get_session),
) -> Organization:
    tenant = await session.get(Tenant, tenant_id)
    _verify_tenant(tenant, tenant_id)

    org = Organization(tenant_id=tenant_id, **body.model_dump())
    session.add(org)
    await session.commit()
    await session.refresh(org)
    return org


@router.get(
    "/{tenant_id}/organizations",
    response_model=List[OrganizationRead],
    dependencies=[Depends(verify_admin)],
)
async def list_organizations(tenant_id: UUID, session: AsyncSession = Depends(get_session)):
    result = await session.exec(select(Organization).where(Organization.tenant_id == tenant_id))
    return list(result.all())


@router.get(
    "/{tenant_id}/organizations/{org_id}",
    response_model=OrganizationRead,
    dependencies=[Depends(verify_admin)],
)
async def get_organization(tenant_id: UUID, org_id: UUID, session: AsyncSession = Depends(get_session)):
    return await _get_organization(tenant_id, org_id, session)


@router.patch(
    "/{tenant_id}/organizations/{org_id}",
    response_model=OrganizationRead,
    dependencies=[Depends(verify_admin)],
)
async def update_organization(
    tenant_id: UUID,
    org_id: UUID,
    body: OrganizationUpdate,
    session: AsyncSession = Depends(get_session),
):
    org = await _get_organization(tenant_id, org_id, session)
    update_data = body.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(org, key, value)
    
    session.add(org)
    await session.commit()
    await session.refresh(org)
    return org


@router.delete(
    "/{tenant_id}/organizations/{org_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_admin)],
)
async def delete_organization(
    tenant_id: UUID,
    org_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    org = await _get_organization(tenant_id, org_id, session)
    await session.delete(org)
    await session.commit()


@router.get(
    "/{tenant_id}/organizations/{org_id}/employees",
    response_model=List[ApplicantRead],
    dependencies=[Depends(verify_admin)],
)
async def list_organization_employees(tenant_id: UUID, org_id: UUID, session: AsyncSession = Depends(get_session)):
    await _get_organization(tenant_id, org_id, session)
    result = await session.exec(
        select(Applicant).where(Applicant.tenant_id == tenant_id, Applicant.organization_id == org_id)
    )
    return list(result.all())


# ── Master policies ─────────────────────────────────────────────────────────────

@router.post(
    "/{tenant_id}/organizations/{org_id}/master-policies",
    response_model=MasterPolicyRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_master_policy(
    tenant_id: UUID,
    org_id: UUID,
    body: MasterPolicyCreate,
    session: AsyncSession = Depends(get_session),
) -> MasterPolicy:
    await _get_organization(tenant_id, org_id, session)

    errors = validate_sum_assured_multiple(body.sum_assured_multiple)
    if errors:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=errors)

    mp = MasterPolicy(
        tenant_id=tenant_id,
        organization_id=org_id,
        insurance_type=InsuranceTypeEnum.GROUP_LIFE,
        sum_assured_multiple=body.sum_assured_multiple,
        term_years=body.term_years,
        effective_date=body.effective_date,
        status="Pending",
    )
    session.add(mp)
    await session.commit()
    await session.refresh(mp)
    return mp


@router.get(
    "/{tenant_id}/organizations/{org_id}/master-policies",
    response_model=List[MasterPolicyRead],
    dependencies=[Depends(verify_admin)],
)
async def list_master_policies(tenant_id: UUID, org_id: UUID, session: AsyncSession = Depends(get_session)):
    await _get_organization(tenant_id, org_id, session)
    result = await session.exec(
        select(MasterPolicy).where(MasterPolicy.tenant_id == tenant_id, MasterPolicy.organization_id == org_id)
    )
    return list(result.all())


# ── Employee census ──────────────────────────────────────────────────────────────

@router.post(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/census/validate",
    response_model=CensusValidationResponse,
    dependencies=[Depends(verify_admin)],
)
async def validate_employee_census(
    tenant_id: UUID,
    org_id: UUID,
    mp_id: UUID,
    body: CensusRequest,
    session: AsyncSession = Depends(get_session),
):
    await _get_master_policy(tenant_id, org_id, mp_id, session)

    existing = await session.exec(select(Applicant.cnic).where(Applicant.organization_id == org_id))
    existing_cnics = set(existing.all())

    return validate_census(existing_cnics, body.employees)


@router.post(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/census/confirm",
    response_model=CensusConfirmResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def confirm_employee_census(
    tenant_id: UUID,
    org_id: UUID,
    mp_id: UUID,
    body: CensusRequest,
    session: AsyncSession = Depends(get_session),
):
    master_policy = await _get_master_policy(tenant_id, org_id, mp_id, session)

    existing = await session.exec(select(Applicant.cnic).where(Applicant.organization_id == org_id))
    existing_cnics = set(existing.all())

    result = validate_census(existing_cnics, body.employees)
    if not result.is_valid:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=result.model_dump())

    created_ids: List[UUID] = []
    for row in body.employees:
        try:
            dob = row["dob"] if isinstance(row["dob"], date) else date.fromisoformat(str(row["dob"]))
            declared_income = float(row["declared_income"])
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid employee row for CNIC '{row.get('cnic', '?')}': {exc}",
            )

        applicant = Applicant(
            tenant_id=tenant_id,
            organization_id=org_id,
            cnic=normalize_cnic(row["cnic"]) or row["cnic"],
            name=row["name"],
            dob=dob,
            gender=row["gender"],
            occupation=row["occupation"],
            declared_income=declared_income,
            # Group/census enrollment is guaranteed-issue — no individual medical
            # data is collected, so these pricing-relevant fields are unknown.
            is_smoker=bool(row.get("is_smoker", False)),
            height_cm=float(row.get("height_cm", 170)),
            weight_kg=float(row.get("weight_kg", 70)),
        )
        session.add(applicant)
        await session.flush()

        coverage_amount = (declared_income / 12) * master_policy.sum_assured_multiple
        policy = Policy(
            tenant_id=tenant_id,
            applicant_id=applicant.id,
            master_policy_id=master_policy.id,
            product_name="Group Life",
            insurance_type=master_policy.insurance_type,
            coverage_amount=coverage_amount,
            term_years=master_policy.term_years,
        )
        session.add(policy)
        created_ids.append(applicant.id)

    master_policy.status = "Active"
    session.add(master_policy)

    await session.commit()

    return CensusConfirmResponse(created_count=len(created_ids), applicant_ids=created_ids)
