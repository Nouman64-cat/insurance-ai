from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import verify_superadmin
from schemas import TenantCreate, TenantRead, TenantUpdate
from shared.models.core import Tenant

router = APIRouter(prefix="/tenants", tags=["Tenants"])


@router.post(
    "/",
    response_model=TenantRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_superadmin)],
)
async def create_tenant(
    body: TenantCreate,
    session: AsyncSession = Depends(get_session),
) -> Tenant:
    existing = (await session.exec(select(Tenant).where(Tenant.name == body.name))).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Tenant with name '{body.name}' already exists.",
        )

    existing_code = (await session.exec(select(Tenant).where(Tenant.code == body.code))).first()
    if existing_code:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Tenant with code '{body.code}' already exists.",
        )

    tenant = Tenant(**body.model_dump())
    session.add(tenant)
    await session.commit()
    await session.refresh(tenant)
    return tenant


@router.get("/", response_model=List[TenantRead])
async def list_tenants(
    session: AsyncSession = Depends(get_session),
) -> List[Tenant]:
    return list(await session.exec(select(Tenant)))


@router.get("/{tenant_id}", response_model=TenantRead)
async def get_tenant(
    tenant_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> Tenant:
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found.")
    return tenant


@router.patch("/{tenant_id}", response_model=TenantRead)
async def update_tenant(
    tenant_id: UUID,
    body: TenantUpdate,
    session: AsyncSession = Depends(get_session),
) -> Tenant:
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found.")

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(tenant, field, value)

    session.add(tenant)
    await session.commit()
    await session.refresh(tenant)
    return tenant


from sqlalchemy import delete
from shared.models.core import (
    User, UserProfile, Organization, Customer, MasterPolicy, Policy,
    RiskAssessment, Claim, Artifact, Commission, PremiumQuote, InsurancePlan,
    Case, CaseWorkflow, CaseAssignment, CaseHistory, CaseEscalation, CaseComment,
    CaseAttachment, CaseAuditTrail, Branch
)

@router.delete(
    "/{tenant_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_superadmin)],
)
async def delete_tenant(
    tenant_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> None:
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found.")

    # 1. Fetch all case IDs for this tenant
    case_ids_result = await session.exec(select(Case.caseld).where(Case.tenant_id == tenant_id))
    case_ids = list(case_ids_result.all())

    # 2. Fetch all user IDs for this tenant
    user_ids_result = await session.exec(select(User.id).where(User.tenant_id == tenant_id))
    user_ids = list(user_ids_result.all())

    # 3. Delete from Case-related child tables
    if case_ids:
        await session.exec(delete(CaseWorkflow).where(CaseWorkflow.caseld.in_(case_ids)))
        await session.exec(delete(CaseAssignment).where(CaseAssignment.caseld.in_(case_ids)))
        await session.exec(delete(CaseHistory).where(CaseHistory.caseld.in_(case_ids)))
        await session.exec(delete(CaseEscalation).where(CaseEscalation.caseld.in_(case_ids)))
        await session.exec(delete(CaseComment).where(CaseComment.caseld.in_(case_ids)))
        await session.exec(delete(CaseAttachment).where(CaseAttachment.caseld.in_(case_ids)))
        await session.exec(delete(CaseAuditTrail).where(CaseAuditTrail.caseld.in_(case_ids)))

    # 4. Delete from UserProfile (child of User)
    if user_ids:
        await session.exec(delete(UserProfile).where(UserProfile.user_id.in_(user_ids)))

    # 5. Delete direct Tenant-level dependencies
    await session.exec(delete(Case).where(Case.tenant_id == tenant_id))
    await session.exec(delete(Commission).where(Commission.tenant_id == tenant_id))
    await session.exec(delete(PremiumQuote).where(PremiumQuote.tenant_id == tenant_id))
    await session.exec(delete(Claim).where(Claim.tenant_id == tenant_id))
    await session.exec(delete(Artifact).where(Artifact.tenant_id == tenant_id))
    await session.exec(delete(RiskAssessment).where(RiskAssessment.tenant_id == tenant_id))
    await session.exec(delete(Policy).where(Policy.tenant_id == tenant_id))
    await session.exec(delete(MasterPolicy).where(MasterPolicy.tenant_id == tenant_id))
    await session.exec(delete(Customer).where(Customer.tenant_id == tenant_id))
    await session.exec(delete(Organization).where(Organization.tenant_id == tenant_id))
    await session.exec(delete(User).where(User.tenant_id == tenant_id))
    await session.exec(delete(InsurancePlan).where(InsurancePlan.tenant_id == tenant_id))
    await session.exec(delete(Branch).where(Branch.tenant_id == tenant_id))

    # 6. Delete the tenant itself
    await session.delete(tenant)
    await session.commit()

