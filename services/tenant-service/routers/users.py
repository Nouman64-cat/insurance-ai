from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from passlib.context import CryptContext
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from schemas import UserCreate, UserRead, UserUpdate
from shared.models.core import Role, Tenant, User

router = APIRouter(prefix="/tenants", tags=["Users"])

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _verify_tenant(tenant: Tenant | None, tenant_id: UUID) -> Tenant:
    if tenant is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tenant '{tenant_id}' not found.",
        )
    if not tenant.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tenant is inactive.",
        )
    return tenant


@router.post(
    "/{tenant_id}/users/",
    response_model=UserRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_user(
    tenant_id: UUID,
    body: UserCreate,
    session: AsyncSession = Depends(get_session),
) -> User:
    tenant = await session.get(Tenant, tenant_id)
    _verify_tenant(tenant, tenant_id)

    role = await session.get(Role, body.role_id)
    if role is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Role '{body.role_id}' not found.",
        )

    existing = (await session.exec(select(User).where(User.email == body.email))).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Email '{body.email}' is already registered.",
        )

    user = User(
        tenant_id=tenant_id,
        role_id=body.role_id,
        email=body.email,
        hashed_password=_pwd.hash(body.password),
        full_name=body.full_name,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


@router.get("/{tenant_id}/users/", response_model=List[UserRead])
async def list_users(
    tenant_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> List[User]:
    tenant = await session.get(Tenant, tenant_id)
    _verify_tenant(tenant, tenant_id)

    return list(await session.exec(select(User).where(User.tenant_id == tenant_id)))


@router.get("/{tenant_id}/users/{user_id}", response_model=UserRead)
async def get_user(
    tenant_id: UUID,
    user_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> User:
    user = await session.get(User, user_id)
    if user is None or user.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    return user


@router.patch("/{tenant_id}/users/{user_id}", response_model=UserRead)
async def update_user(
    tenant_id: UUID,
    user_id: UUID,
    body: UserUpdate,
    session: AsyncSession = Depends(get_session),
) -> User:
    user = await session.get(User, user_id)
    if user is None or user.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")

    if body.role_id is not None:
        role = await session.get(Role, body.role_id)
        if role is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Role '{body.role_id}' not found.")

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(user, field, value)

    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user
