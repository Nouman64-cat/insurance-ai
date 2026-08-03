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
from email_utils import send_credentials_email
from provisioning import generate_password, generate_unique_username, split_full_name
from schemas import SeedAdminCreate, UserCreate, UserRead, UserUpdate
from shared.models.core import Branch, Role, Tenant, User, UserProfile, UserStatus
from routers.auth import _get_current_user, decode_access_token, oauth2_scheme, verify_superadmin

router = APIRouter(prefix="/tenants", tags=["Users"])

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


def to_user_read(user: User, profile: Optional[UserProfile]) -> UserRead:
    return UserRead(
        id=user.id,
        tenant_id=user.tenant_id,
        role_id=user.role_id,
        branch_id=user.branch_id,
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
        cnic=profile.cnic if profile else None,
        location=profile.location if profile else None,
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


def _verify_branch(branch: Branch | None, tenant_id: UUID, branch_id: UUID) -> Branch:
    if branch is None or branch.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Branch '{branch_id}' not found for this tenant.",
        )
    return branch


async def verify_admin(
    tenant_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
) -> None:
    if not token:
        return
    try:
        payload = decode_access_token(token)
        user_id = payload.get("sub")
        if not user_id:
            return
    except JWTError:
        return

    user = await session.get(User, user_id)
    if not user:
        return

    role = await session.get(Role, user.role_id)
    if not role or role.name not in ("Admin", "SuperAdmin"):
        return

    if role.name == "Admin" and user.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot manage users outside your own tenant",
        )


@router.post(
    "/{tenant_id}/setup",
    response_model=UserRead,
    status_code=status.HTTP_201_CREATED,
    summary="Bootstrap first Admin",
    description=(
        "Creates the first Admin user for a tenant. **Requires a SuperAdmin JWT.** "
        "Returns 409 if any user already exists for this tenant — use the normal "
        "user management endpoints after initial setup. Emails the new Admin's "
        "login credentials on success."
    ),
    dependencies=[Depends(verify_superadmin)],
)
async def seed_admin(
    tenant_id: UUID,
    body: SeedAdminCreate,
    session: AsyncSession = Depends(get_session),
) -> UserRead:
    tenant = await session.get(Tenant, tenant_id)
    _verify_tenant(tenant, tenant_id)

    branch = await session.get(Branch, body.branch_id)
    _verify_branch(branch, tenant_id, body.branch_id)

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

    first_name, last_name = split_full_name(body.full_name)
    local_part = body.email.split("@", 1)[0]
    username = await generate_unique_username(session, local_part)
    plaintext_password = generate_password()

    user = User(
        tenant_id=tenant_id,
        role_id=admin_role.id,
        branch_id=body.branch_id,
        email=body.email,
        username=username,
        hashed_password=_pwd.hash(plaintext_password),
        full_name=body.full_name,
        status=UserStatus.ACTIVE,
        is_active=True,
    )
    session.add(user)
    await session.flush()

    profile = UserProfile(
        user_id=user.id,
        first_name=first_name,
        last_name=last_name,
    )
    session.add(profile)
    await session.commit()
    await session.refresh(user)
    await session.refresh(profile)

    await send_credentials_email(
        to_email=user.email,
        full_name=user.full_name,
        username=username,
        password=plaintext_password,
        role_label="Admin",
        tenant_name=tenant.name,
    )

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
    token: str = Depends(oauth2_scheme),
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

    # branch_id is required when a SuperAdmin creates an Admin (they pick the
    # office); when an Admin creates a User, any branch_id in the body is
    # ignored — the new User always inherits the creating Admin's own branch,
    # so staff can never end up in a different office than their Admin.
    acting_user = await _get_current_user(token, session)
    acting_role = await session.get(Role, acting_user.role_id)
    if acting_role and acting_role.name == "SuperAdmin":
        if body.branch_id is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="branch_id is required when creating a user as SuperAdmin.",
            )
        branch = await session.get(Branch, body.branch_id)
        _verify_branch(branch, tenant_id, body.branch_id)
        branch_id = body.branch_id
    else:
        branch_id = acting_user.branch_id

    existing_email = (await session.exec(select(User).where(User.email == body.email))).first()
    if existing_email:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Email '{body.email}' is already registered.",
        )

    first_name, last_name = split_full_name(body.full_name)
    local_part = body.email.split("@", 1)[0]
    username = await generate_unique_username(session, local_part)
    plaintext_password = generate_password()

    user = User(
        tenant_id=tenant_id,
        role_id=body.role_id,
        branch_id=branch_id,
        email=body.email,
        username=username,
        hashed_password=_pwd.hash(plaintext_password),
        full_name=body.full_name,
        status=UserStatus.ACTIVE,
        is_active=True,
    )
    session.add(user)
    await session.flush()

    profile = UserProfile(
        user_id=user.id,
        first_name=first_name,
        last_name=last_name,
        cnic=body.cnic,
        location=body.location,
    )
    session.add(profile)
    await session.commit()
    await session.refresh(user)
    await session.refresh(profile)

    await send_credentials_email(
        to_email=user.email,
        full_name=user.full_name,
        username=username,
        password=plaintext_password,
        role_label=role.name,
        tenant_name=tenant.name,
    )

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


@router.get("/{tenant_id}/users/directory", response_model=List[UserRead])
async def list_directory_users(
    tenant_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
) -> List[UserRead]:
    try:
        payload = decode_access_token(token)
        req_user_id = payload.get("sub")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    req_user = await session.get(User, req_user_id)
    if not req_user or req_user.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    result = await session.exec(
        select(User).where(User.tenant_id == tenant_id, User.is_active == True).options(selectinload(User.profile))
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

    if body.branch_id is not None:
        branch = await session.get(Branch, body.branch_id)
        _verify_branch(branch, tenant_id, body.branch_id)

    # Update base fields on User
    if body.role_id is not None:
        user.role_id = body.role_id
    if body.branch_id is not None:
        user.branch_id = body.branch_id
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
    if body.cnic is not None:
        profile.cnic = body.cnic
    if body.location is not None:
        profile.location = body.location

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
