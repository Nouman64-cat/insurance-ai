"""Who may do what on a claim: roles, and the delegated authority matrix.

One place for the claims permission rules, so the register (routers/claims.py) and the workflow
(routers/claim_workflow.py) cannot drift apart.

Separation of duties:
  * ClaimsAdjuster  works a claim and decides it within their limit.
  * ClaimsManager   registers and assigns claims, decides and authorises settlements within delegated authority,
                    and handles referrals. Does NOT execute payments.
  * Finance         verifies payment details and executes payments. Cannot approve claims.
  * Admin           configures the platform (including the limits below) and oversees. No claim decisions,
                    registrations, settlements or payments.
The rules are enforced here on the server; the portals only mirror them.

Limits: the platform default keeps today's behaviour (an adjuster may approve up to the manager limit, a manager
without a ceiling) until an Admin sets a different matrix.
"""

from typing import Optional, Tuple
from uuid import UUID

from fastapi import HTTPException
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from services import insurer_config as cfg
from shared.models.core import ClaimAuthorityLimit

# Roles that work on a claim (documents, investigation, assessment, referrals, reading). Admin is deliberately absent.
PROCESS_ROLES = ("ClaimsAdjuster", "ClaimsManager", "Underwriter")
# Roles that register a claim.
REGISTER_ROLES = ("ClaimsAdjuster", "ClaimsManager")
# Roles that may make the approve / decline decision (within their limit).
DECIDE_ROLES = ("ClaimsAdjuster", "ClaimsManager")
# Roles with manager authority: overrides, waivers, claims referred up to a manager, authorising settlements.
MANAGER_ROLES = ("ClaimsManager",)
# Roles that authorise a settlement for payment (within their limit).
AUTHORIZE_ROLES = ("ClaimsManager",)
# Roles that execute a payment.
DISBURSE_ROLES = ("Finance",)
# Roles that reconcile a payment.
RECONCILE_ROLES = ("Finance", "ClaimsManager")
# Roles that may read the delegated authority matrix; only ADMIN_ROLES change it.
VIEW_AUTHORITY_ROLES = ("Admin", "SuperAdmin", "ClaimsManager", "ClaimsAdjuster", "Finance")
ADMIN_ROLES = ("Admin", "SuperAdmin")

ROLES_WITH_LIMITS = ("ClaimsAdjuster", "ClaimsManager")

# No row in the matrix: today's behaviour. (approve_limit, authorize_limit); None = no ceiling.
_DEFAULTS = {
    "ClaimsAdjuster": (cfg.CLAIM_MANAGER_LIMIT, 0.0),   # decides up to the manager limit; authorises nothing
    "ClaimsManager": (None, None),
}


async def limits_for(session: AsyncSession, tenant_id: UUID, role: str) -> Tuple[Optional[float], Optional[float]]:
    """(approve_limit, authorize_limit) for a role in this tenant."""
    row = (await session.exec(select(ClaimAuthorityLimit).where(
        ClaimAuthorityLimit.tenant_id == tenant_id, ClaimAuthorityLimit.role_name == role))).first()
    if row is not None:
        return row.approve_limit, row.authorize_limit
    return _DEFAULTS.get(role, (0.0, 0.0))


def _fmt(n: float) -> str:
    return f"PKR {n:,.0f}"


async def assert_can_decide(session: AsyncSession, tenant_id: UUID, role: str, amount: float, *, referred_up: bool) -> None:
    """403 unless this role may approve or decline a claim of this size. A claim referred to a manager is the
    manager's to decide, whatever its size."""
    if role not in DECIDE_ROLES:
        raise HTTPException(403, f"Deciding a claim is for claims staff with decision authority (you are {role}).")
    if referred_up and role not in MANAGER_ROLES:
        raise HTTPException(403, "This claim was referred to a claims manager: only a claims manager decides it.")
    approve_limit, _ = await limits_for(session, tenant_id, role)
    if approve_limit is not None and amount > approve_limit:
        raise HTTPException(
            403, f"This claim ({_fmt(amount)}) is above your delegated approval limit of {_fmt(approve_limit)}. "
                 f"Refer it to a claims manager.")


async def assert_can_authorize(session: AsyncSession, tenant_id: UUID, role: str, amount: float) -> None:
    """403 unless this role may authorise a settlement of this size."""
    if role not in AUTHORIZE_ROLES:
        raise HTTPException(403, f"Authorising a settlement is for a claims manager (you are {role}).")
    _, authorize_limit = await limits_for(session, tenant_id, role)
    if authorize_limit is not None and amount > authorize_limit:
        raise HTTPException(
            403, f"This settlement ({_fmt(amount)}) is above your delegated authorisation limit of {_fmt(authorize_limit)}. "
                 f"A senior approver must authorise it.")
