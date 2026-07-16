from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import verify_superadmin
from schemas import BranchCreate, BranchRead, BranchUpdate
from shared.models.core import Branch, Tenant

router = APIRouter(tags=["Branches"])


@router.post(
    "/tenants/{tenant_id}/branches",
    response_model=BranchRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_superadmin)],
)
async def create_branch(
    tenant_id: UUID,
    body: BranchCreate,
    session: AsyncSession = Depends(get_session),
) -> Branch:
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found.")

    existing = (
        await session.exec(
            select(Branch).where(
                Branch.tenant_id == tenant_id,
                Branch.branch_code == body.branch_code,
            )
        )
    ).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Branch with code '{body.branch_code}' already exists for this tenant.",
        )

    branch = Branch(tenant_id=tenant_id, **body.model_dump())
    session.add(branch)
    await session.commit()
    await session.refresh(branch)
    return branch


@router.get("/tenants/{tenant_id}/branches", response_model=List[BranchRead])
async def list_branches(
    tenant_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> List[Branch]:
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tenant not found.")
    return list(await session.exec(select(Branch).where(Branch.tenant_id == tenant_id)))


@router.get("/branches/{branch_id}", response_model=BranchRead)
async def get_branch(
    branch_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> Branch:
    branch = await session.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Branch not found.")
    return branch


@router.patch(
    "/branches/{branch_id}",
    response_model=BranchRead,
    dependencies=[Depends(verify_superadmin)],
)
async def update_branch(
    branch_id: UUID,
    body: BranchUpdate,
    session: AsyncSession = Depends(get_session),
) -> Branch:
    branch = await session.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Branch not found.")

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(branch, field, value)

    session.add(branch)
    await session.commit()
    await session.refresh(branch)
    return branch


@router.delete(
    "/branches/{branch_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_superadmin)],
)
async def delete_branch(
    branch_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> None:
    branch = await session.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Branch not found.")

    await session.delete(branch)
    await session.commit()
