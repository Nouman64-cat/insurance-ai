"""Tenant-scoped CRUD for acquisition sources — the agents / brokers / banks /
etc. credited with bringing customers to the insurer. Admin-guarded, mirrors the
organizations router.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from schemas import (
    AcquisitionSourceCreate,
    AcquisitionSourceFull,
    AcquisitionSourceUpdate,
)
from shared.models.core import AcquisitionSource, Customer, Tenant
from routers.users import verify_admin   # reuse existing Admin guard

router = APIRouter(prefix="/tenants", tags=["Acquisition Sources"])


def _verify_tenant(tenant: Tenant | None, tenant_id: UUID) -> Tenant:
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Tenant '{tenant_id}' not found.")
    return tenant


async def _get_source(tenant_id: UUID, source_id: UUID, session: AsyncSession) -> AcquisitionSource:
    source = await session.get(AcquisitionSource, source_id)
    if not source or source.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Acquisition source not found.")
    return source


async def _customer_counts(tenant_id: UUID, session: AsyncSession) -> dict[UUID, int]:
    """How many customers each source has brought in, for the whole tenant."""
    rows = (await session.execute(
        select(Customer.acquisition_source_id, func.count())
        .where(Customer.tenant_id == tenant_id, Customer.acquisition_source_id.is_not(None))
        .group_by(Customer.acquisition_source_id)
    )).all()
    return {sid: cnt for sid, cnt in rows}


def _to_full(source: AcquisitionSource, customer_count: int = 0) -> AcquisitionSourceFull:
    dto = AcquisitionSourceFull.model_validate(source)
    dto.customer_count = customer_count
    return dto


@router.get(
    "/{tenant_id}/acquisition-sources",
    response_model=list[AcquisitionSourceFull],
    dependencies=[Depends(verify_admin)],
)
async def list_acquisition_sources(
    tenant_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    result = await session.exec(
        select(AcquisitionSource)
        .where(AcquisitionSource.tenant_id == tenant_id)
        .order_by(AcquisitionSource.source_type, AcquisitionSource.name)
    )
    sources = list(result.all())
    counts = await _customer_counts(tenant_id, session)
    return [_to_full(s, counts.get(s.id, 0)) for s in sources]


@router.post(
    "/{tenant_id}/acquisition-sources",
    response_model=AcquisitionSourceFull,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_acquisition_source(
    tenant_id: UUID,
    body: AcquisitionSourceCreate,
    session: AsyncSession = Depends(get_session),
):
    tenant = await session.get(Tenant, tenant_id)
    _verify_tenant(tenant, tenant_id)

    # Enforce the tenant-scoped unique code up front for a clean error message.
    existing = await session.exec(
        select(AcquisitionSource).where(
            AcquisitionSource.tenant_id == tenant_id,
            AcquisitionSource.code == body.code,
        )
    )
    if existing.first() is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Producer code '{body.code}' already exists for this tenant.")

    source = AcquisitionSource(tenant_id=tenant_id, **body.model_dump())
    session.add(source)
    await session.commit()
    await session.refresh(source)
    return _to_full(source, 0)


@router.put(
    "/{tenant_id}/acquisition-sources/{source_id}",
    response_model=AcquisitionSourceFull,
    dependencies=[Depends(verify_admin)],
)
async def update_acquisition_source(
    tenant_id: UUID,
    source_id: UUID,
    body: AcquisitionSourceUpdate,
    session: AsyncSession = Depends(get_session),
):
    source = await _get_source(tenant_id, source_id, session)

    updates = body.model_dump(exclude_unset=True)
    # Guard the unique code if it's being changed to one already taken.
    new_code = updates.get("code")
    if new_code is not None and new_code != source.code:
        clash = await session.exec(
            select(AcquisitionSource).where(
                AcquisitionSource.tenant_id == tenant_id,
                AcquisitionSource.code == new_code,
            )
        )
        if clash.first() is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Producer code '{new_code}' already exists for this tenant.")

    for field, value in updates.items():
        setattr(source, field, value)

    session.add(source)
    await session.commit()
    await session.refresh(source)
    counts = await _customer_counts(tenant_id, session)
    return _to_full(source, counts.get(source.id, 0))


@router.delete(
    "/{tenant_id}/acquisition-sources/{source_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_admin)],
)
async def delete_acquisition_source(
    tenant_id: UUID,
    source_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    source = await _get_source(tenant_id, source_id, session)

    # Don't orphan customer credits — block deletion while any customer still
    # references this source. Deactivate (is_active=false) instead to retire it.
    in_use = (await session.execute(
        select(func.count())
        .select_from(Customer)
        .where(Customer.acquisition_source_id == source_id)
    )).scalar_one()
    if in_use > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot delete — {in_use} customer(s) are credited to this source. Deactivate it instead.",
        )

    await session.delete(source)
    await session.commit()
    return None
