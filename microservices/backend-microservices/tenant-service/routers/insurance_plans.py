from datetime import datetime
from typing import List
from uuid import UUID

import os

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
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


_WORDING_ROOT = os.getenv("POLICY_DOC_MEDIA_ROOT", "/app/media/policy_documents").rsplit("/", 1)[0] + "/plan_wording"
_WORDING_MAX_BYTES = 25 * 1024 * 1024


@router.post(
    "/{tenant_id}/insurance-plans/{plan_id}/policy-wording",
    response_model=InsurancePlanRead,
    dependencies=[Depends(verify_admin)],
)
async def upload_policy_wording(
    tenant_id: UUID, plan_id: UUID, file: UploadFile = File(...), session: AsyncSession = Depends(get_session),
):
    """Attach (or replace) the plan's policy wording. PDF only; it is added to every policy's application dossier."""
    plan = await _get_plan(tenant_id, plan_id, session)
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="That file is empty.")
    if len(data) > _WORDING_MAX_BYTES:
        raise HTTPException(status_code=413, detail="That file is too large (25 MB maximum).")
    if data[:4] != b"%PDF":
        raise HTTPException(status_code=400, detail="The policy wording must be a PDF file.")
    os.makedirs(_WORDING_ROOT, exist_ok=True)
    path = os.path.join(_WORDING_ROOT, f"{plan.id}.pdf")
    with open(path, "wb") as f:
        f.write(data)
    plan.policy_wording_path = path
    plan.policy_wording_filename = (file.filename or "policy-wording.pdf")[:255]
    plan.policy_wording_uploaded_at = datetime.utcnow()
    plan.updated_at = datetime.utcnow()
    session.add(plan)
    await session.commit()
    await session.refresh(plan)
    return plan


@router.get("/{tenant_id}/insurance-plans/{plan_id}/policy-wording", dependencies=[Depends(verify_admin)])
async def download_policy_wording(tenant_id: UUID, plan_id: UUID, session: AsyncSession = Depends(get_session)):
    plan = await _get_plan(tenant_id, plan_id, session)
    if not plan.policy_wording_path or not os.path.isfile(plan.policy_wording_path):
        raise HTTPException(status_code=404, detail="No policy wording has been uploaded for this plan.")
    return FileResponse(plan.policy_wording_path, media_type="application/pdf",
                        filename=f"{plan.label} - Policy Wording.pdf")


@router.delete(
    "/{tenant_id}/insurance-plans/{plan_id}/policy-wording",
    response_model=InsurancePlanRead,
    dependencies=[Depends(verify_admin)],
)
async def remove_policy_wording(tenant_id: UUID, plan_id: UUID, session: AsyncSession = Depends(get_session)):
    plan = await _get_plan(tenant_id, plan_id, session)
    if plan.policy_wording_path and os.path.isfile(plan.policy_wording_path):
        os.remove(plan.policy_wording_path)
    plan.policy_wording_path = plan.policy_wording_filename = plan.policy_wording_uploaded_at = None
    plan.updated_at = datetime.utcnow()
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
