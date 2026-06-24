from datetime import datetime
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from passlib.context import CryptContext
from sqlalchemy.orm import selectinload
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession
from jose import JWTError

from database import get_session
from schemas import SeedAdminCreate, UserCreate, UserRead, UserUpdate
from shared.models.core import Role, Tenant, User, UserProfile, UserStatus
from routers.auth import decode_access_token, oauth2_scheme

router = APIRouter(prefix="/tenants", tags=["Users"])

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


def to_user_read(user: User, profile: Optional[UserProfile]) -> UserRead:
    return UserRead(
        id=user.id,
        tenant_id=user.tenant_id,
        role_id=user.role_id,
        email=user.email,
        username=user.username,
        full_name=user.full_name,
        is_active=user.is_active,
        status=user.status,
        created_at=user.created_at,
        first_name=profile.first_name if profile else None,
        last_name=profile.last_name if profile else None,
        phone=profile.phone if profile else None,
        avatar_url=profile.avatar_url if profile else None,
        department=profile.department if profile else None,
        employee_id=profile.employee_id if profile else None,
        designation=profile.designation if profile else None,
        date_of_joining=profile.date_of_joining if profile else None,
    )


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
    "/{tenant_id}/setup",
    response_model=UserRead,
    status_code=status.HTTP_201_CREATED,
    summary="Bootstrap first Admin",
    description=(
        "Creates the first Admin user for a tenant. **No authentication required.** "
        "Returns 409 if any user already exists for this tenant — use the normal "
        "user management endpoints after initial setup."
    ),
)
async def seed_admin(
    tenant_id: UUID,
    body: SeedAdminCreate,
    session: AsyncSession = Depends(get_session),
) -> UserRead:
    tenant = await session.get(Tenant, tenant_id)
    _verify_tenant(tenant, tenant_id)

    existing_users = (
        await session.exec(select(User).where(User.tenant_id == tenant_id))
    ).first()
    if existing_users:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This tenant already has users. Use POST /auth/token to log in, then manage users via the users endpoints.",
        )

    admin_role = (await session.exec(select(Role).where(Role.name == "Admin"))).first()
    if admin_role is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Admin role not found — ensure the tenant service seeded roles on startup.",
        )

    existing_email = (await session.exec(select(User).where(User.email == body.email))).first()
    if existing_email:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Email '{body.email}' is already registered.",
        )

    existing_username = (await session.exec(select(User).where(User.username == body.username))).first()
    if existing_username:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Username '{body.username}' is already registered.",
        )

    user = User(
        tenant_id=tenant_id,
        role_id=admin_role.id,
        email=body.email,
        username=body.username,
        hashed_password=_pwd.hash(body.password),
        full_name=f"{body.first_name} {body.last_name}".strip(),
        status=UserStatus.ACTIVE,
        is_active=True,
    )
    session.add(user)
    await session.flush()

    profile = UserProfile(
        user_id=user.id,
        first_name=body.first_name,
        last_name=body.last_name,
    )
    session.add(profile)
    await session.commit()
    await session.refresh(user)
    await session.refresh(profile)
    return to_user_read(user, profile)


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
) -> UserRead:
    tenant = await session.get(Tenant, tenant_id)
    _verify_tenant(tenant, tenant_id)

    role = await session.get(Role, body.role_id)
    if role is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Role '{body.role_id}' not found.",
        )

    existing_email = (await session.exec(select(User).where(User.email == body.email))).first()
    if existing_email:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Email '{body.email}' is already registered.",
        )

    existing_username = (await session.exec(select(User).where(User.username == body.username))).first()
    if existing_username:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Username '{body.username}' is already registered.",
        )

    user = User(
        tenant_id=tenant_id,
        role_id=body.role_id,
        email=body.email,
        username=body.username,
        hashed_password=_pwd.hash(body.password),
        full_name=f"{body.first_name} {body.last_name}".strip(),
        status=UserStatus.ACTIVE,
        is_active=True,
    )
    session.add(user)
    await session.flush()

    profile = UserProfile(
        user_id=user.id,
        first_name=body.first_name,
        last_name=body.last_name,
        phone=body.phone,
        department=body.department,
        employee_id=body.employee_id,
        designation=body.designation,
        date_of_joining=body.date_of_joining,
    )
    session.add(profile)
    await session.commit()
    await session.refresh(user)
    await session.refresh(profile)
    return to_user_read(user, profile)


@router.get("/{tenant_id}/users/", response_model=List[UserRead], dependencies=[Depends(verify_admin)])
async def list_users(
    tenant_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> List[UserRead]:
    tenant = await session.get(Tenant, tenant_id)
    _verify_tenant(tenant, tenant_id)

    result = await session.exec(
        select(User).where(User.tenant_id == tenant_id).options(selectinload(User.profile))
    )
    users = result.all()
    return [to_user_read(u, u.profile) for u in users]


@router.get("/{tenant_id}/users/{user_id}", response_model=UserRead)
async def get_user(
    tenant_id: UUID,
    user_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
) -> UserRead:
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

    result = await session.exec(
        select(User).where(User.id == user_id).options(selectinload(User.profile))
    )
    user = result.first()
    if user is None or user.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    return to_user_read(user, user.profile)


@router.patch("/{tenant_id}/users/{user_id}", response_model=UserRead, dependencies=[Depends(verify_admin)])
async def update_user(
    tenant_id: UUID,
    user_id: UUID,
    body: UserUpdate,
    session: AsyncSession = Depends(get_session),
) -> UserRead:
    result = await session.exec(
        select(User).where(User.id == user_id).options(selectinload(User.profile))
    )
    user = result.first()
    if user is None or user.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")

    if body.role_id is not None:
        role = await session.get(Role, body.role_id)
        if role is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Role '{body.role_id}' not found.")

    # Update base fields on User
    if body.role_id is not None:
        user.role_id = body.role_id
    if body.status is not None:
        user.status = body.status
        user.is_active = (body.status == UserStatus.ACTIVE)
    if body.is_active is not None:
        user.is_active = body.is_active
        if not body.is_active and user.status == UserStatus.ACTIVE:
            user.status = UserStatus.INACTIVE
        elif body.is_active and user.status != UserStatus.ACTIVE:
            user.status = UserStatus.ACTIVE
    if body.password is not None:
        user.hashed_password = _pwd.hash(body.password)

    # Get or create UserProfile
    profile = user.profile
    if not profile:
        profile = UserProfile(user_id=user.id, first_name="", last_name="")
        session.add(profile)

    # Update profile fields
    if body.first_name is not None:
        profile.first_name = body.first_name
    if body.last_name is not None:
        profile.last_name = body.last_name
    if body.phone is not None:
        profile.phone = body.phone
    if body.department is not None:
        profile.department = body.department
    if body.employee_id is not None:
        profile.employee_id = body.employee_id
    if body.designation is not None:
        profile.designation = body.designation
    if body.date_of_joining is not None:
        profile.date_of_joining = body.date_of_joining

    # Update full name if either first_name or last_name changed
    first_name = profile.first_name
    last_name = profile.last_name
    user.full_name = f"{first_name} {last_name}".strip()

    user.updated_at = datetime.utcnow()
    profile.updated_at = datetime.utcnow()

    session.add(user)
    session.add(profile)
    await session.commit()
    await session.refresh(user)
    await session.refresh(profile)
    return to_user_read(user, profile)


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
