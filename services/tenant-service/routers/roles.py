"""Role management (CRUD) — SuperAdmin only.

Roles are global (not tenant-scoped). The platform's built-in roles are
recognised by *name* throughout the codebase, so they can't be renamed or deleted
here (their description can be edited). Any other role can be created, renamed and
deleted — deletion is refused while users still hold the role.

The public, read-only ``GET /roles`` (used by pickers everywhere) lives in main.py
and is unchanged; this router adds the management endpoints beside it.
"""

import re
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from role_seed import SYSTEM_ROLE_NAMES
from routers.auth import verify_superadmin
from schemas import RoleCreate, RoleManageRead, RoleUpdate
from shared.models.core import Role, User

router = APIRouter(prefix="/roles", tags=["Roles"], dependencies=[Depends(verify_superadmin)])

_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _\-]{1,49}")


def _clean_name(raw: str) -> str:
    name = re.sub(r"\s+", " ", (raw or "").strip())
    if not _NAME_RE.fullmatch(name):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Role name must be 2–50 characters: letters, numbers, spaces, hyphens or underscores, "
                   "starting with a letter or number.",
        )
    return name


async def _name_taken(session: AsyncSession, name: str, *, except_id: UUID | None = None) -> bool:
    clash = (await session.exec(select(Role).where(func.lower(Role.name) == name.lower()))).first()
    return clash is not None and clash.id != except_id


async def _user_counts(session: AsyncSession) -> dict[UUID, int]:
    rows = (await session.execute(
        select(User.role_id, func.count()).where(User.is_deleted.is_(False)).group_by(User.role_id)
    )).all()
    return {rid: n for rid, n in rows}


def _to_read(role: Role, user_count: int = 0) -> RoleManageRead:
    return RoleManageRead(
        id=role.id,
        name=role.name,
        description=role.description,
        is_system=role.name in SYSTEM_ROLE_NAMES,
        user_count=user_count,
    )


async def _get_role(session: AsyncSession, role_id: UUID) -> Role:
    role = await session.get(Role, role_id)
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Role not found.")
    return role


@router.get("/management", response_model=list[RoleManageRead], summary="List roles with user counts")
async def list_roles_for_management(session: AsyncSession = Depends(get_session)):
    roles = list((await session.exec(select(Role))).all())
    counts = await _user_counts(session)
    # Built-in roles first (in their canonical order), then custom roles A–Z.
    order = {n: i for i, n in enumerate(n for n in ("SuperAdmin", "Admin", "Underwriter", "ClaimsAdjuster", "ClaimsManager", "Agent", "Viewer"))}
    roles.sort(key=lambda r: (0, order.get(r.name, 99)) if r.name in SYSTEM_ROLE_NAMES else (1, r.name.lower()))
    return [_to_read(r, counts.get(r.id, 0)) for r in roles]


@router.post("", response_model=RoleManageRead, status_code=status.HTTP_201_CREATED, summary="Create a role")
async def create_role(body: RoleCreate, session: AsyncSession = Depends(get_session)):
    name = _clean_name(body.name)
    if await _name_taken(session, name):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"A role named '{name}' already exists.")
    role = Role(name=name, description=(body.description or "").strip())
    session.add(role)
    await session.commit()
    await session.refresh(role)
    return _to_read(role, 0)


@router.put("/{role_id}", response_model=RoleManageRead, summary="Update a role")
async def update_role(role_id: UUID, body: RoleUpdate, session: AsyncSession = Depends(get_session)):
    role = await _get_role(session, role_id)
    updates = body.model_dump(exclude_unset=True)

    if "name" in updates and updates["name"] is not None:
        new_name = _clean_name(updates["name"])
        if new_name != role.name:
            if role.name in SYSTEM_ROLE_NAMES:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=f"'{role.name}' is a built-in role and can't be renamed — the platform recognises it by name.",
                )
            if await _name_taken(session, new_name, except_id=role.id):
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"A role named '{new_name}' already exists.")
            role.name = new_name
    if "description" in updates and updates["description"] is not None:
        role.description = updates["description"].strip()

    session.add(role)
    await session.commit()
    await session.refresh(role)
    counts = await _user_counts(session)
    return _to_read(role, counts.get(role.id, 0))


@router.delete("/{role_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a role")
async def delete_role(role_id: UUID, session: AsyncSession = Depends(get_session)):
    role = await _get_role(session, role_id)
    if role.name in SYSTEM_ROLE_NAMES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"'{role.name}' is a built-in role and can't be deleted.",
        )
    holders = (await session.execute(
        select(func.count()).select_from(User).where(User.role_id == role.id)
    )).scalar_one()
    if holders:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{holders} user(s) still have the '{role.name}' role — move them to another role first.",
        )
    await session.delete(role)
    await session.commit()
    return None
