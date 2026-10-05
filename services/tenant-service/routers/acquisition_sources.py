"""Tenant-scoped CRUD for acquisition sources — the agents / brokers / banks /
etc. credited with bringing customers to the insurer. Admin-guarded, mirrors the
organizations router.
"""

import re
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from passlib.context import CryptContext
from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from email_utils import send_credentials_email
from provisioning import generate_password, generate_unique_username, split_full_name
from schemas import (
    AcquisitionSourceCreate,
    AcquisitionSourceFull,
    AcquisitionSourceUpdate,
)
from shared.models.core import AcquisitionSource, Customer, Role, Tenant, User, UserProfile, UserStatus
from routers.auth import _get_current_user, oauth2_scheme
from routers.users import remove_user, verify_admin   # reuse the Admin guard and the shared user removal

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

# A source's login account gets the role named after the source's type — a Broker
# source's login holds the "Broker" role, a Bancassurance source's the
# "Bancassurance" role, and so on (roles are managed under Role Management). When no
# role matches the type (e.g. Direct, Digital before a role is created for them) the
# account falls back to the Agent role, which is what an external producer is.
SOURCE_LOGIN_ROLE = "Agent"


# Where the UI's label differs from the stored value.
_SOURCE_TYPE_DISPLAY = {"DIRECT": "Walk-in"}


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


async def _role_for_source_type(source_type, session: AsyncSession) -> Role:
    """The role matching a source type: "CORPORATE_AGENT" ↔ "Corporate Agent" ↔
    "CorporateAgent". Falls back to Agent when no role carries that name."""
    value = getattr(source_type, "value", source_type)
    # The enum value ("DIRECT") and what the UI calls it ("Walk-in") both identify the
    # type, so a role created under either name is found.
    keys = {_norm(value), _norm(_SOURCE_TYPE_DISPLAY.get(value, value))}
    roles = list((await session.exec(select(Role))).all())
    match = next((r for r in roles if _norm(r.name) in keys), None) or next(
        (r for r in roles if r.name == SOURCE_LOGIN_ROLE), None
    )
    if match is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"No role matches the source type and the '{SOURCE_LOGIN_ROLE}' fallback role was not found.",
        )
    return match

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


def _to_full(
    source: AcquisitionSource,
    customer_count: int = 0,
    login: tuple[str, str] | None = None,
    credentials_email_sent: bool | None = None,
) -> AcquisitionSourceFull:
    """`login` is (status, role name) of the source's login account, if it has one."""
    dto = AcquisitionSourceFull.model_validate(source)
    dto.customer_count = customer_count
    dto.login_status, dto.login_role = login if login else (None, None)
    dto.credentials_email_sent = credentials_email_sent
    return dto


async def _logins(sources: list[AcquisitionSource], session: AsyncSession) -> dict[UUID, tuple[str, str]]:
    """source id -> ("invited" | "active", role name). "invited" = credentials sent,
    never signed in."""
    user_ids = [s.user_id for s in sources if s.user_id]
    if not user_ids:
        return {}
    users = {u.id: u for u in (await session.exec(select(User).where(User.id.in_(user_ids)))).all()}
    role_names = {r.id: r.name for r in (await session.exec(select(Role))).all()}
    return {
        s.id: (
            "active" if users[s.user_id].last_login else "invited",
            role_names.get(users[s.user_id].role_id, ""),
        )
        for s in sources
        if s.user_id and s.user_id in users
    }


async def _sync_invite_role(source: AcquisitionSource, session: AsyncSession) -> None:
    """Keep a not-yet-acknowledged invite's role in step with the source's type.
    An account that has already signed in is left alone — changing a live user's
    role because a label was edited would be a silent privilege change."""
    if not source.user_id:
        return
    user = await session.get(User, source.user_id)
    if user is None or user.last_login is not None:
        return
    role = await _role_for_source_type(source.source_type, session)
    if user.role_id != role.id:
        user.role_id = role.id
        session.add(user)


_EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")


def _assert_valid_email(email: str) -> None:
    if not _EMAIL_RE.fullmatch(email):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"'{email}' isn't a valid email address, so login credentials can't be sent to it.",
        )


async def _assert_email_free(email: str, session: AsyncSession, *, except_user: UUID | None = None) -> None:
    clash = (await session.exec(select(User).where(func.lower(User.email) == email.lower()))).first()
    if clash is not None and clash.id != except_user:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A user with the email '{email}' already exists, so a login can't be issued to this contact.",
        )


async def _issue_login(
    source: AcquisitionSource, tenant: Tenant, acting_user: User, session: AsyncSession
) -> tuple[User, str]:
    """Create the login account for a source (not yet committed) and return it with
    its one-time password, which exists only in plaintext here and in the email."""
    role = await _role_for_source_type(source.source_type, session)
    email = source.contact_email.strip()
    # The source's own name ("Hi Bilal Traders"), not the contact person's: that is
    # who the account — and the greeting in the credentials email — belongs to.
    full_name = source.name.strip()
    first_name, last_name = split_full_name(full_name)
    username = await generate_unique_username(session, email.split("@", 1)[0])
    password = generate_password()

    user = User(
        tenant_id=tenant.id,
        role_id=role.id,
        branch_id=acting_user.branch_id,
        email=email,
        username=username,
        hashed_password=_pwd.hash(password),
        full_name=full_name,
        status=UserStatus.ACTIVE,
        is_active=True,
    )
    session.add(user)
    await session.flush()
    session.add(UserProfile(
        user_id=user.id,
        first_name=first_name,
        last_name=last_name,
        phone=source.contact_phone,
        cnic=source.cnic,
        location=source.location,
    ))
    source.user_id = user.id
    session.add(source)
    return user, password


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
        .order_by(AcquisitionSource.created_at.desc(), AcquisitionSource.name)   # newest first
    )
    sources = list(result.all())
    counts = await _customer_counts(tenant_id, session)
    logins = await _logins(sources, session)
    return [_to_full(s, counts.get(s.id, 0), logins.get(s.id)) for s in sources]


@router.post(
    "/{tenant_id}/acquisition-sources",
    response_model=AcquisitionSourceFull,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_acquisition_source(
    tenant_id: UUID,
    body: AcquisitionSourceCreate,
    token: str = Depends(oauth2_scheme),
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

    # A source with a contact email is given a login: the credentials are emailed
    # and the account joins User Management once the entity signs in. Check the
    # email up front so a clash fails before anything is created.
    contact_email = (body.contact_email or "").strip() or None
    if contact_email:
        _assert_valid_email(contact_email)
        await _assert_email_free(contact_email, session)

    source = AcquisitionSource(tenant_id=tenant_id, **body.model_dump())
    session.add(source)
    await session.flush()

    issued: tuple[User, str] | None = None
    if contact_email:
        acting_user = await _get_current_user(token, session)
        issued = await _issue_login(source, tenant, acting_user, session)

    await session.commit()
    await session.refresh(source)

    email_sent: bool | None = None
    login = None
    if issued:
        user, password = issued
        role_name = (await session.get(Role, user.role_id)).name
        email_sent = await send_credentials_email(
            to_email=user.email,
            full_name=user.full_name,
            username=user.username,
            password=password,
            role_label=role_name,
            tenant_name=tenant.name,
        )
        login = ("invited", role_name)
    return _to_full(source, 0, login, email_sent)


@router.post(
    "/{tenant_id}/acquisition-sources/{source_id}/send-credentials",
    response_model=AcquisitionSourceFull,
    dependencies=[Depends(verify_admin)],
)
async def send_source_credentials(
    tenant_id: UUID,
    source_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """(Re)send login credentials to a source's contact email. The password only
    ever exists in the email, so this issues a fresh one — which is why it is
    refused once the entity has signed in (that would silently lock them out)."""
    tenant = await session.get(Tenant, tenant_id)
    _verify_tenant(tenant, tenant_id)
    source = await _get_source(tenant_id, source_id, session)

    contact_email = (source.contact_email or "").strip()
    if not contact_email:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="This source has no contact email — add one first.",
        )

    _assert_valid_email(contact_email)
    user = await session.get(User, source.user_id) if source.user_id else None
    if user is not None and user.last_login is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This contact has already signed in, so credentials can't be re-sent.",
        )

    if user is None:
        await _assert_email_free(contact_email, session)
        acting_user = await _get_current_user(token, session)
        user, password = await _issue_login(source, tenant, acting_user, session)
    else:
        # Still an unacknowledged invite — the contact email may have been corrected
        # since, so keep the account in step with it before re-sending.
        if user.email.lower() != contact_email.lower():
            await _assert_email_free(contact_email, session, except_user=user.id)
            user.email = contact_email
        password = generate_password()
        user.hashed_password = _pwd.hash(password)
        await _sync_invite_role(source, session)   # the type may have changed since it was issued
        # Invites created before the greeting used the source name carry the
        # contact person's name — bring them in line so the re-sent email matches.
        source_name = source.name.strip()
        if user.full_name != source_name:
            user.full_name = source_name
            profile = (await session.exec(select(UserProfile).where(UserProfile.user_id == user.id))).first()
            if profile is not None:
                profile.first_name, profile.last_name = split_full_name(source_name)
                session.add(profile)
        session.add(user)

    await session.commit()
    await session.refresh(source)

    role_name = (await session.get(Role, user.role_id)).name
    sent = await send_credentials_email(
        to_email=user.email,
        full_name=user.full_name,
        username=user.username,
        password=password,
        role_label=role_name,
        tenant_name=tenant.name,
    )
    counts = await _customer_counts(tenant_id, session)
    return _to_full(source, counts.get(source.id, 0), ("invited", role_name), sent)


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

    # Changing the type of a source whose invite hasn't been accepted yet changes the
    # role that invite carries.
    if "source_type" in updates:
        await _sync_invite_role(source, session)

    session.add(source)
    await session.commit()
    await session.refresh(source)
    counts = await _customer_counts(tenant_id, session)
    logins = await _logins([source], session)
    return _to_full(source, counts.get(source.id, 0), logins.get(source.id))


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

    # The login issued to this source goes with it — it must not linger in User
    # Management once the source it belonged to is gone.
    linked_user_id = source.user_id
    await session.delete(source)
    await session.flush()
    if linked_user_id:
        await remove_user(linked_user_id, session)
    await session.commit()
    return None
