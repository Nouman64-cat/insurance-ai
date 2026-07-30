from datetime import datetime
from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from schemas import InsurancePlanCreate, InsurancePlanRead, InsurancePlanUpdate
from seeds.insurance_plans_seed import seed_insurance_plans
from shared.models.core import InsurancePlan, Tenant
from routers.users import verify_admin   # tenant-scoped Admin / cross-tenant SuperAdmin guard
from routers.auth import oauth2_scheme, _get_current_user

router = APIRouter(prefix="/tenants", tags=["Insurance Plans"])


def _verify_tenant(tenant: Tenant | None, tenant_id: UUID) -> Tenant:
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Tenant '{tenant_id}' not found.")
    return tenant


async def _get_plan(tenant_id: UUID, plan_id: UUID, session: AsyncSession) -> InsurancePlan:
    plan = await session.get(InsurancePlan, plan_id)
    if not plan or plan.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Insurance plan not found.")
    return plan


async def _code_taken(tenant_id: UUID, code: str, session: AsyncSession) -> bool:
    existing = await session.exec(
        select(InsurancePlan).where(InsurancePlan.tenant_id == tenant_id, InsurancePlan.code == code)
    )
    return existing.first() is not None


@router.post(
    "/{tenant_id}/insurance-plans",
    response_model=InsurancePlanRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_insurance_plan(
    tenant_id: UUID,
    body: InsurancePlanCreate,
    session: AsyncSession = Depends(get_session),
) -> InsurancePlan:
    tenant = await session.get(Tenant, tenant_id)
    _verify_tenant(tenant, tenant_id)

    if await _code_taken(tenant_id, body.code, session):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A plan with code '{body.code}' already exists for this tenant.",
        )

    data = body.model_dump()
    data["medical_exam_tiers"] = [t.model_dump() for t in body.medical_exam_tiers]
    plan = InsurancePlan(tenant_id=tenant_id, **data)
    session.add(plan)
    await session.commit()
    await session.refresh(plan)
    return plan


@router.get(
    "/{tenant_id}/insurance-plans",
    response_model=List[InsurancePlanRead],
)
async def list_insurance_plans(tenant_id: UUID, session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme)):
    user = await _get_current_user(token, session)
    if user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Access denied")
    result = await session.exec(
        select(InsurancePlan).where(InsurancePlan.tenant_id == tenant_id).order_by(InsurancePlan.created_at)
    )
    return list(result.all())


@router.get(
    "/{tenant_id}/insurance-plans/{plan_id}",
    response_model=InsurancePlanRead,
)
async def get_insurance_plan(tenant_id: UUID, plan_id: UUID, session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme)):
    user = await _get_current_user(token, session)
    if user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Access denied")
    return await _get_plan(tenant_id, plan_id, session)


@router.patch(
    "/{tenant_id}/insurance-plans/{plan_id}",
    response_model=InsurancePlanRead,
    dependencies=[Depends(verify_admin)],
)
async def update_insurance_plan(
    tenant_id: UUID,
    plan_id: UUID,
    body: InsurancePlanUpdate,
    session: AsyncSession = Depends(get_session),
) -> InsurancePlan:
    plan = await _get_plan(tenant_id, plan_id, session)

    updates = body.model_dump(exclude_unset=True)
    if "medical_exam_tiers" in updates and body.medical_exam_tiers is not None:
        updates["medical_exam_tiers"] = [t.model_dump() for t in body.medical_exam_tiers]

    for field, value in updates.items():
        setattr(plan, field, value)
    plan.updated_at = datetime.utcnow()

    # Re-validate band coherence after partial update.
    if plan.entry_age_max < plan.entry_age_min or plan.term_max_years < plan.term_min_years:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid range: max values must be >= min values.",
        )

    session.add(plan)
    await session.commit()
    await session.refresh(plan)
    return plan


@router.delete(
    "/{tenant_id}/insurance-plans/{plan_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_admin)],
)
async def delete_insurance_plan(tenant_id: UUID, plan_id: UUID, session: AsyncSession = Depends(get_session)):
    plan = await _get_plan(tenant_id, plan_id, session)
    await session.delete(plan)
    await session.commit()


@router.post(
    "/{tenant_id}/insurance-plans/seed-defaults",
    response_model=List[InsurancePlanRead],
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def seed_default_plans(tenant_id: UUID, session: AsyncSession = Depends(get_session)):
    """Insert the standard plan catalog for a tenant, skipping any codes that
    already exist. Lets an Admin start from the defaults and then edit.

    Shares its data and logic with seeds/insurance_plans_seed.py (the CLI seed)."""
    tenant = await session.get(Tenant, tenant_id)
    _verify_tenant(tenant, tenant_id)
    return await seed_insurance_plans(session, tenant_id)
