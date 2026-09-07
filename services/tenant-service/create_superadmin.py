"""
CLI to bootstrap a SuperAdmin account — the platform-level operator who
creates tenants and their first Admin (see routers/tenants.py and
routers/users.py:seed_admin, both gated on verify_superadmin).

SuperAdmin users are attached to a reserved "Platform" tenant so the
existing User.tenant_id NOT NULL constraint doesn't need to change.

Usage (inside the tenant-service container) — only --email is required,
everything else is derived or auto-generated:

    docker compose exec tenant-service python create_superadmin.py \\
        --email you@yourdomain.com

Neither the username nor the display name is taken from the email: the
display name is a random single word (e.g. "Riley") and the username is
that word plus random digits (e.g. "riley4821"). A random password is
generated. All three can still be overridden individually with
--username / --first-name / --last-name / --password.

The credentials are printed to stdout and emailed to the SuperAdmin via
AWS SES (best-effort — see email_utils.py).
"""

import argparse
import asyncio

from passlib.context import CryptContext
from sqlmodel import select

from database import _session_factory
from email_utils import send_credentials_email
from provisioning import (
    generate_display_name,
    generate_password,
    generate_random_username,
)
from shared.models.core import Role, Tenant, User, UserProfile, UserStatus

PLATFORM_TENANT_NAME = "Platform"
SUPERADMIN_ROLE = "SuperAdmin"

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


async def create_superadmin(
    email: str,
    username: str | None,
    first_name: str | None,
    last_name: str | None,
    password: str | None,
) -> None:
    first_name = first_name or generate_display_name()
    last_name = last_name or ""

    async with _session_factory() as session:
        tenant = (
            await session.exec(select(Tenant).where(Tenant.name == PLATFORM_TENANT_NAME))
        ).first()
        if tenant is None:
            tenant = Tenant(name=PLATFORM_TENANT_NAME, code="PLATFORM")
            session.add(tenant)
            await session.flush()

        role = (await session.exec(select(Role).where(Role.name == SUPERADMIN_ROLE))).first()
        if role is None:
            role = Role(
                name=SUPERADMIN_ROLE,
                description="Platform-level access — create tenants and bootstrap their first Admin.",
            )
            session.add(role)
            await session.flush()

        existing_email = (await session.exec(select(User).where(User.email == email))).first()
        if existing_email:
            raise SystemExit(f"A user with email '{email}' already exists.")

        if username:
            candidate = username
            if (await session.exec(select(User).where(User.username == candidate))).first():
                raise SystemExit(f"A user with username '{candidate}' already exists.")
        else:
            candidate = await generate_random_username(session, first_name)
        username = candidate

        plaintext_password = password or generate_password()

        user = User(
            tenant_id=tenant.id,
            role_id=role.id,
            email=email,
            username=username,
            hashed_password=_pwd.hash(plaintext_password),
            full_name=f"{first_name} {last_name}".strip(),
            status=UserStatus.ACTIVE,
            is_active=True,
        )
        session.add(user)
        await session.flush()

        profile = UserProfile(user_id=user.id, first_name=first_name, last_name=last_name)
        session.add(profile)
        await session.commit()

        print("SuperAdmin created:")
        print(f"  email:    {email}")
        print(f"  username: {username}")
        print(f"  name:     {f'{first_name} {last_name}'.strip()}")
        print(f"  password: {plaintext_password}")

        sent = await send_credentials_email(
            to_email=email,
            full_name=user.full_name,
            username=username,
            password=plaintext_password,
            role_label="SuperAdmin",
        )
        print(f"  emailed:  {'yes' if sent else 'no — see logs / check EMAIL_PROVIDER config'}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a SuperAdmin account.")
    parser.add_argument("--email", required=True)
    parser.add_argument("--username", default=None, help="Defaults to a random name + digits (e.g. riley4821).")
    parser.add_argument("--first-name", default=None, help="Defaults to a random single-word name.")
    parser.add_argument("--last-name", default=None, help="Defaults to empty (single-word display name).")
    parser.add_argument("--password", default=None, help="Omit to auto-generate a secure password.")
    args = parser.parse_args()

    asyncio.run(
        create_superadmin(
            email=args.email,
            username=args.username,
            first_name=args.first_name,
            last_name=args.last_name,
            password=args.password,
        )
    )


if __name__ == "__main__":
    main()
