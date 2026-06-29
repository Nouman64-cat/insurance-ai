from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from schemas import TenantCreate, TenantRead, TenantUpdate
from shared.models.core import Tenant

router = APIRouter(prefix="/tenants", tags=["Tenants"])


@router.post("/", response_model=TenantRead, status_code=status.HTTP_201_CREATED)
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
    tenant = Tenant(name=body.name)
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
