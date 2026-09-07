"""Shared helpers for auto-provisioning user credentials.

Used by create_superadmin.py and routers/users.py:seed_admin — both flows
generate a username/password on the caller's behalf and email them rather
than accepting them as input.
"""

import secrets
import string

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import User


def generate_password(length: int = 16) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*"
    while True:
        pwd = "".join(secrets.choice(alphabet) for _ in range(length))
        if (
            any(c.islower() for c in pwd)
            and any(c.isupper() for c in pwd)
            and any(c.isdigit() for c in pwd)
            and any(c in "!@#$%^&*" for c in pwd)
        ):
            return pwd


# Gender-neutral single-word names — used when an account is provisioned
# without a real name (e.g. the SuperAdmin bootstrap CLI). Deliberately not
# derived from the email so the display name doesn't leak the local part.
_DISPLAY_NAMES = (
    "Alex", "Jordan", "Morgan", "Riley", "Casey", "Taylor", "Jamie", "Avery",
    "Quinn", "Skyler", "Rowan", "Sage", "Reese", "Emerson", "Finley", "Hayden",
    "Kai", "Lennox", "Marlowe", "Nova", "Oakley", "Parker", "Remy", "Sasha",
    "Blake", "Charlie", "Dakota", "Ellis", "Frankie", "Harley", "Indigo", "Phoenix",
)


def generate_display_name() -> str:
    """Return a random single-word name for an auto-provisioned account."""
    return secrets.choice(_DISPLAY_NAMES)


async def generate_random_username(session: AsyncSession, base: str | None = None) -> str:
    """Return a unique random username, e.g. 'finley4821'.

    Not derived from the account's email — used by the SuperAdmin bootstrap
    so the username doesn't expose the email's local part.
    """
    stem = (base or generate_display_name()).lower()
    while True:
        candidate = f"{stem}{secrets.randbelow(9000) + 1000}"
        if not (await session.exec(select(User).where(User.username == candidate))).first():
            return candidate


def split_full_name(full_name: str) -> tuple[str, str]:
    parts = full_name.strip().split(None, 1)
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], parts[1]


async def generate_unique_username(session: AsyncSession, local_part: str) -> str:
    candidate = local_part
    suffix = 0
    while (await session.exec(select(User).where(User.username == candidate))).first():
        suffix += 1
        candidate = f"{local_part}{suffix}"
    return candidate
