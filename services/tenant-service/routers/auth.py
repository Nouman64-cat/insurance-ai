import os
from datetime import datetime, timedelta
from jose import JWTError, jwt
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from passlib.context import CryptContext
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from schemas import ChangePasswordRequest, ProfileUpdate
from shared.models.core import Role, User, UserProfile

SECRET_KEY  = os.environ.get("JWT_SECRET_KEY", "change-me-in-production")
ALGORITHM   = "HS256"
EXPIRE_MINS = int(os.environ.get("JWT_EXPIRE_MINUTES", 1440))

def create_access_token(payload: dict) -> str:
    data = payload.copy()
    data["exp"] = datetime.utcnow() + timedelta(minutes=EXPIRE_MINS)
    return jwt.encode(data, SECRET_KEY, algorithm=ALGORITHM)

def decode_access_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])

router = APIRouter(prefix="/auth", tags=["Authentication"])
_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/token")


async def _get_current_user(token: str, session: AsyncSession) -> User:
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
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


async def _role_name(user: User, session: AsyncSession) -> str:
    if not user.role_id:
        return "Viewer"
    role = await session.get(Role, user.role_id)
    return role.name if role else "Viewer"


def _me_payload(user: User, profile: UserProfile | None, role_name: str) -> dict:
    return {
        "id": str(user.id),
        "email": user.email,
        "username": user.username,
        "full_name": user.full_name,
        "tenant_id": str(user.tenant_id),
        "role_id": str(user.role_id),
        "role_name": role_name,
        "branch_id": str(user.branch_id) if user.branch_id else None,
        "is_active": user.is_active,
        "status": user.status,
        "first_name": profile.first_name if profile else None,
        "last_name": profile.last_name if profile else None,
        "phone": profile.phone if profile else None,
        "department": profile.department if profile else None,
        "employee_id": profile.employee_id if profile else None,
        "designation": profile.designation if profile else None,
        "date_of_joining": profile.date_of_joining if profile else None,
    }


@router.post("/token")
async def login_for_access_token(
    form_data: OAuth2PasswordRequestForm = Depends(),
    session: AsyncSession = Depends(get_session),
):
    # Retrieve user by email (username field in form_data maps to email)
    user = (await session.exec(select(User).where(User.email == form_data.username))).first()
    if not user or not _pwd.verify(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Generate payload
    payload = {
        "sub": str(user.id),
        "email": user.email,
        "tenant_id": str(user.tenant_id),
        "role_id": str(user.role_id)
    }

    token = create_access_token(payload)
    return {"access_token": token, "token_type": "bearer"}


@router.get("/me")
async def read_users_me(
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    user = await _get_current_user(token, session)
    role_name = await _role_name(user, session)
    profile = (await session.exec(select(UserProfile).where(UserProfile.user_id == user.id))).first()
    return _me_payload(user, profile, role_name)


@router.patch("/me")
async def update_own_profile(
    body: ProfileUpdate,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    user = await _get_current_user(token, session)

    profile = (await session.exec(select(UserProfile).where(UserProfile.user_id == user.id))).first()
    if profile is None:
        profile = UserProfile(user_id=user.id, first_name="", last_name="")
        session.add(profile)

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(profile, field, value)

    if "first_name" in update_data or "last_name" in update_data:
        user.full_name = f"{profile.first_name} {profile.last_name}".strip()

    user.updated_at = datetime.utcnow()
    profile.updated_at = datetime.utcnow()
    session.add(user)
    session.add(profile)
    await session.commit()
    await session.refresh(user)
    await session.refresh(profile)

    role_name = await _role_name(user, session)
    return _me_payload(user, profile, role_name)


@router.post("/change-password")
async def change_own_password(
    body: ChangePasswordRequest,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    user = await _get_current_user(token, session)

    if not _pwd.verify(body.current_password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect.",
        )

    user.hashed_password = _pwd.hash(body.new_password)
    user.updated_at = datetime.utcnow()
    session.add(user)
    await session.commit()

    return {"detail": "Password updated successfully."}


async def verify_superadmin(
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
) -> None:
    """FastAPI dependency — raises 401/403 unless the caller is a SuperAdmin."""
    user = await _get_current_user(token, session)
    role = await session.get(Role, user.role_id)
    if not role or role.name != "SuperAdmin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="SuperAdmin privileges required",
        )
