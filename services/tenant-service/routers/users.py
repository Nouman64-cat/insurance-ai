from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from passlib.context import CryptContext
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession
from jose import JWTError

from database import get_session
from schemas import UserCreate, UserRead, UserUpdate
from shared.models.core import Role, Tenant, User
from routers.auth import decode_access_token, oauth2_scheme

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


async def verify_admin(
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
) -> None:
    try:
        payload = decode_access_token(token)
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Could not validate credentials",
            )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
        )
    
    user = await session.get(User, user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    
    role = await session.get(Role, user.role_id)
    if not role or role.name != "Admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrative privileges required",
        )


@router.post(
    "/{tenant_id}/users/",
    response_model=UserRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
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


@router.get("/{tenant_id}/users/", response_model=List[UserRead], dependencies=[Depends(verify_admin)])
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
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
) -> User:
    try:
        payload = decode_access_token(token)
        req_user_id = payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    if req_user_id != str(user_id):
        req_user = await session.get(User, req_user_id)
        if not req_user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Requesting user not found")
        role = await session.get(Role, req_user.role_id)
        if not role or role.name != "Admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    user = await session.get(User, user_id)
    if user is None or user.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    return user


@router.patch("/{tenant_id}/users/{user_id}", response_model=UserRead, dependencies=[Depends(verify_admin)])
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
        if field == "password" and value is not None:
            setattr(user, "hashed_password", _pwd.hash(value))
        else:
            setattr(user, field, value)

    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


@router.delete("/{tenant_id}/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(verify_admin)])
async def delete_user(
    tenant_id: UUID,
    user_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> None:
    user = await session.get(User, user_id)
    if user is None or user.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")

    await session.delete(user)
    await session.commit()
