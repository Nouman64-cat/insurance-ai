"""
Stage B onboarding readiness — the single source of truth for "is this policy's
welcome & onboarding complete?".

Both the onboarding UI (GET /onboarding) and the endpoints in post_issuance.py
call ``compute_onboarding`` so the checklist the user sees and the state the
server records never drift apart. Router-free to avoid an import cycle (mirrors
pre_issuance_gate.py).

The four hard steps that make onboarding "complete":
  • Policyholder ID assigned (Customer.policyholder_id),
  • Welcome kit generated (PolicyOnboarding.welcome_kit_*),
  • Portal account provisioned (CustomerPortalAccount),
  • Welcome delivered (PolicyOnboarding.welcome_sent_at).
Acknowledgment is tracked and surfaced but optional (a nicety, not a blocker).

Onboarding only applies while cover is in force — a Cancelled / Lapsed policy
reports can_onboard = False and the UI locks the actions.
"""

from __future__ import annotations

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import (
    Customer,
    CustomerPortalAccount,
    Policy,
    PolicyOnboarding,
    PolicyStatusEnum,
)

# Statuses during which onboarding actions are legal (cover is in force).
ONBOARDING_STATUSES = frozenset({
    PolicyStatusEnum.ACTIVE.value,
    PolicyStatusEnum.GRACE_PERIOD.value,
})


def _v(x) -> str:
    return x.value if hasattr(x, "value") else str(x)


def _contact(customer: Customer | None) -> dict:
    """Customer contact lives in Customer.details JSON (no dedicated columns)."""
    details = (customer.details if customer else None) or {}
    return {
        "email": details.get("contact_email") or details.get("email"),
        "phone": details.get("contact_phone") or details.get("phone") or details.get("mobile_number"),
    }


async def compute_onboarding(session: AsyncSession, policy: Policy) -> dict:
    customer = await session.get(Customer, policy.customer_id)
    onboarding = (await session.exec(
        select(PolicyOnboarding).where(PolicyOnboarding.policy_id == policy.id)
    )).first()
    portal = None
    if customer is not None:
        portal = (await session.exec(
            select(CustomerPortalAccount).where(CustomerPortalAccount.customer_id == customer.id)
        )).first()

    contact = _contact(customer)
    can_onboard = _v(policy.status) in ONBOARDING_STATUSES

    ph_assigned = bool(customer and customer.policyholder_id)
    kit_ready = bool(onboarding and onboarding.welcome_kit_path)
    portal_ready = portal is not None
    welcome_sent = bool(onboarding and onboarding.welcome_sent_at)
    acknowledged = bool(onboarding and onboarding.acknowledged_at)

    steps = {
        "policyholder_id": {
            "done": ph_assigned,
            "value": customer.policyholder_id if customer else None,
        },
        "welcome_kit": {
            "done": kit_ready,
            "name": onboarding.welcome_kit_name if onboarding else None,
            "generated_at": onboarding.welcome_kit_generated_at.isoformat()
            if (onboarding and onboarding.welcome_kit_generated_at) else None,
        },
        "portal": {
            "done": portal_ready,
            "username": portal.username if portal else None,
            "status": portal.status if portal else None,
            "must_reset": portal.must_reset if portal else None,
        },
        "welcome_sent": {
            "done": welcome_sent,
            "at": onboarding.welcome_sent_at.isoformat() if welcome_sent else None,
            "channel": onboarding.welcome_channel if onboarding else None,
        },
        "acknowledged": {
            "done": acknowledged,
            "at": onboarding.acknowledged_at.isoformat() if acknowledged else None,
            "method": onboarding.acknowledgment_method if onboarding else None,
        },
    }

    hard_steps = [kit_ready, portal_ready, welcome_sent]
    completed = all(hard_steps)
    done_count = sum(hard_steps)
    if completed:
        status = "Completed"
    elif done_count > 0:
        status = "InProgress"
    else:
        status = "Pending"

    warnings: list[str] = []
    if not (contact["email"] or contact["phone"]):
        warnings.append("No email or phone on record — the welcome pack cannot be delivered digitally.")

    return {
        "policy_id": str(policy.id),
        "status": status,
        "policy_status": _v(policy.status),
        "can_onboard": can_onboard,
        "completed": completed,
        "progress": {"done": done_count, "total": len(hard_steps)},
        "contact": contact,
        "steps": steps,
        "warnings": warnings,
    }
