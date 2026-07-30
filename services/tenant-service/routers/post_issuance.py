"""
Stage B — Post-Issuance router.

Everything that happens AFTER cover binds lives here. Stage A (pre_issuance.py)
ends when the first premium is realized and the policy flips to ACTIVE; from that
moment this router owns the policy's in-force life.

Implemented so far:

  1. Deliver Policy & Free-Look Period
       • GET  /free-look        — window status the UI counts down against.
       • POST /free-look/cancel — full-refund exit while the window is open.

  (Onboarding, recurring collection, endorsements, reinstatement, renewals,
   claims and policy exit are the remaining Stage B steps — added here next.)

Delivery itself is captured at binding (policies.confirm_payment sets
Policy.delivery_date + free_look_end_date), so the statutory clock is anchored on
delivery, not the effective date. Every status change routes through
policy_state_machine.apply_transition so the PolicyEvent audit trail stays whole.
"""

import logging
import os
from datetime import date, datetime, timedelta
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
import email_utils
from services import payment_gateway, portal_service, document_generator, insurer_config
from services.onboarding_gate import ONBOARDING_STATUSES, compute_onboarding
from services.billing_gate import IN_FORCE_STATUSES, compute_billing, surcharge_for, _row_state
from services.pricing_engine import GRACE_PERIOD_DAYS as _GRACE_DAYS
from services.policy_documents import render_welcome_kit
from routers.policies import _get_policy, _publish_policy_event, _st
from shared.services.policy_state_machine import IllegalStateTransition, apply_transition, record_event
from shared.models.core import (
    BillingFrequencyEnum,
    Customer,
    CustomerPortalAccount,
    Policy,
    PolicyEvent,
    PolicyOnboarding,
    PolicyStatusEnum,
    PolicyVersion,
    PremiumReceipt,
    PremiumReminder,
    PremiumSchedule,
    PremiumScheduleStatusEnum,
    Tenant,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["Stage B — Post-Issuance"])


# ── Request bodies ────────────────────────────────────────────────────────────

class FreeLookCancelBody(BaseModel):
    reason: Optional[str] = None          # customer's stated reason (optional)
    requested_by: Optional[str] = None    # who lodged the cancellation


# ── helpers ───────────────────────────────────────────────────────────────────

def _v(x) -> str:
    return x.value if hasattr(x, "value") else str(x)


async def _premium_paid_total(session: AsyncSession, policy_id: UUID) -> float:
    """Total premium realized on a policy so far — the free-look refund base."""
    rows = (await session.exec(
        select(PremiumSchedule).where(PremiumSchedule.policy_id == policy_id)
    )).all()
    return round(sum(
        s.amount_paid for s in rows
        if s.status == PremiumScheduleStatusEnum.PAID
    ), 2)


def _free_look_view(policy: Policy, premium_paid: float, cancelled_evt: Optional[PolicyEvent]) -> dict:
    """Serialise the free-look window state for the UI countdown."""
    end = policy.free_look_end_date
    today = date.today()
    is_active = _st(policy) == PolicyStatusEnum.ACTIVE.value
    # Open only while cover is in force AND the window has a defined, future end.
    is_open = bool(is_active and end and today <= end)
    days_remaining = (end - today).days if (end and today <= end) else 0
    return {
        "policy_id": str(policy.id),
        "status": _st(policy),
        "delivery_date": policy.delivery_date.isoformat() if policy.delivery_date else None,
        "free_look_end_date": end.isoformat() if end else None,
        "is_open": is_open,
        "days_remaining": days_remaining,
        "premium_paid": premium_paid,
        "refund_amount": premium_paid,   # free-look = full refund of premium collected
        "cancelled": cancelled_evt is not None,
        "cancellation": ({
            "refund_amount": (cancelled_evt.detail_json or {}).get("refund_amount"),
            "refund_reference": (cancelled_evt.detail_json or {}).get("refund_reference"),
            "reason": (cancelled_evt.detail_json or {}).get("reason"),
            "at": cancelled_evt.created_at.isoformat(),
        } if cancelled_evt else None),
    }


async def _free_look_cancellation_event(session: AsyncSession, policy_id: UUID) -> Optional[PolicyEvent]:
    """The FreeLookCancellation audit row for a policy, if one exists."""
    return (await session.exec(
        select(PolicyEvent)
        .where(PolicyEvent.policy_id == policy_id,
               PolicyEvent.event_type == "FreeLookCancellation")
        .order_by(PolicyEvent.created_at.desc())  # type: ignore[arg-type]
    )).first()


# ══════════════════════════════════════════════════════════════════════════════
# STEP 1 — Deliver Policy & Free-Look Period
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/tenants/{tenant_id}/policies/{policy_id}/free-look")
async def free_look_status(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    premium_paid = await _premium_paid_total(session, policy_id)
    cancelled_evt = await _free_look_cancellation_event(session, policy_id)
    return _free_look_view(policy, premium_paid, cancelled_evt)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/free-look/cancel")
async def cancel_within_free_look(
    tenant_id: UUID, policy_id: UUID,
    body: FreeLookCancelBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Cancel an in-force policy inside its free-look window for a full refund.

    Guards: the policy must be ACTIVE and the window must still be open (today on
    or before free_look_end_date). The realized premium is refunded and the policy
    is moved ACTIVE → CANCELLED, with the refund captured in the audit event.
    """
    policy = await _get_policy(session, tenant_id, policy_id)

    if _st(policy) != PolicyStatusEnum.ACTIVE.value:
        raise HTTPException(400, f"Free-look cancellation needs an in-force policy (current: {_st(policy)})")
    if policy.free_look_end_date is None:
        raise HTTPException(400, "This policy has no free-look window on record")
    if date.today() > policy.free_look_end_date:
        raise HTTPException(400, f"Free-look window closed on {policy.free_look_end_date.isoformat()}")

    refund_amount = await _premium_paid_total(session, policy_id)
    refund = payment_gateway.refund_payment(refund_amount)

    try:
        # Reverse the collected installments so the ledger reflects the refund.
        for s in (await session.exec(
            select(PremiumSchedule).where(PremiumSchedule.policy_id == policy_id)
        )).all():
            if s.status == PremiumScheduleStatusEnum.PAID:
                s.amount_paid = 0.0
                s.status = PremiumScheduleStatusEnum.WAIVED
                s.payment_reference = refund.reference
                session.add(s)

        event = apply_transition(
            session, policy, PolicyStatusEnum.CANCELLED,
            event_type="FreeLookCancellation",
            actor=body.requested_by or "customer",
            detail={
                "reason": body.reason or "free_look",
                "refund_amount": refund_amount,
                "refund_reference": refund.reference,
                "refunded_at": (refund.realized_at or datetime.utcnow()).isoformat(),
                "free_look_end_date": policy.free_look_end_date.isoformat(),
            },
        )
        await session.commit()
    except IllegalStateTransition as exc:
        await session.rollback()
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        await session.rollback()
        log.exception("Free-look cancellation failed for policy %s — rolled back", policy_id)
        raise HTTPException(500, f"Free-look cancellation failed and was rolled back: {exc}") from exc

    await _publish_policy_event(request, policy, event)
    log.info("Free-look cancellation: %s (%s) — refunded PKR %.0f (ref=%s)",
             policy.policy_number, policy_id, refund_amount, refund.reference)
    return {
        "policy_id": str(policy_id),
        "status": _st(policy),
        "refund": refund.to_dict(),
        "refund_amount": refund_amount,
    }


# ══════════════════════════════════════════════════════════════════════════════
# STEP 2 — Customer Welcome & Onboarding
#   Policyholder ID + portal account are customer-level (reused across policies);
#   welcome kit + delivery + acknowledgment are per-policy. Onboarding actions are
#   only legal while cover is in force.
# ══════════════════════════════════════════════════════════════════════════════

class WelcomeSendBody(BaseModel):
    channel: Optional[str] = None      # Email | SMS | Both | Manual (defaults to what's on file)
    sent_by: Optional[str] = None


class AcknowledgeBody(BaseModel):
    method: Optional[str] = None       # Call | Email | Portal | InPerson
    acknowledged_by: Optional[str] = None


def _assert_onboardable(policy: Policy) -> None:
    """Onboarding actions require an in-force policy (ACTIVE / GracePeriod)."""
    if _st(policy) not in ONBOARDING_STATUSES:
        raise HTTPException(
            409,
            f"Onboarding is only available while cover is in force. "
            f"Policy is '{_st(policy)}'.",
        )


async def _get_or_create_onboarding(session: AsyncSession, policy: Policy) -> PolicyOnboarding:
    row = (await session.exec(
        select(PolicyOnboarding).where(PolicyOnboarding.policy_id == policy.id)
    )).first()
    if row is None:
        row = PolicyOnboarding(tenant_id=policy.tenant_id, policy_id=policy.id, status="InProgress")
        session.add(row)
    return row


async def _next_policyholder_id(session: AsyncSession, tenant_id: UUID) -> str:
    """Mint the next PH-{year}-{seq} for a tenant (mirrors _next_policy_number)."""
    year = datetime.utcnow().year
    existing = (await session.exec(
        select(Customer).where(
            Customer.tenant_id == tenant_id,
            Customer.policyholder_id.is_not(None),  # type: ignore[union-attr]
        )
    )).all()
    return f"PH-{year}-{len(existing) + 1:06d}"


@router.get("/tenants/{tenant_id}/policies/{policy_id}/onboarding")
async def onboarding_status(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    return await compute_onboarding(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/onboarding/reset")
async def reset_onboarding(
    tenant_id: UUID, policy_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """DEV/TEST utility: Reset all onboarding steps for a policy.
    Clears policyholder_id, deletes the portal account, and drops the onboarding tracker."""
    policy = await _get_policy(session, tenant_id, policy_id)
    customer = await session.get(Customer, policy.customer_id)
    
    if customer:
        customer.policyholder_id = None
        
        details = dict(customer.details or {})
        details.pop("contact_email", None)
        details.pop("contact_phone", None)
        details.pop("email", None)
        details.pop("phone", None)
        details.pop("mobile_number", None)
        if "contact" in details and isinstance(details["contact"], dict):
            details["contact"]["email"] = ""
            details["contact"]["mobile_number"] = ""
            details["contact"]["emergency_contact_name"] = ""
        customer.details = details
        
        session.add(customer)
        
        portal = (await session.exec(
            select(CustomerPortalAccount).where(CustomerPortalAccount.customer_id == customer.id)
        )).first()
        if portal:
            await session.delete(portal)

    onboarding = (await session.exec(
        select(PolicyOnboarding).where(PolicyOnboarding.policy_id == policy.id)
    )).first()
    if onboarding:
        await session.delete(onboarding)

    event = record_event(
        session, policy, event_type="OnboardingReset", actor="system", detail={"reason": "manual_reset"}
    )
    await session.commit()
    await _publish_policy_event(request, policy, event)
    return await compute_onboarding(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/onboarding/policyholder-id")
async def assign_policyholder_id(
    tenant_id: UUID, policy_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Assign the customer's permanent policyholder ID. Idempotent — if the
    customer already has one (from a prior policy) it is reused, not regenerated."""
    policy = await _get_policy(session, tenant_id, policy_id)
    _assert_onboardable(policy)
    customer = await session.get(Customer, policy.customer_id)
    if customer is None:
        raise HTTPException(404, "Customer not found")

    if customer.policyholder_id:
        return {"policyholder_id": customer.policyholder_id, "reused": True}

    customer.policyholder_id = await _next_policyholder_id(session, tenant_id)
    session.add(customer)
    await _get_or_create_onboarding(session, policy)
    event = record_event(
        session, policy, event_type="PolicyholderIdAssigned", actor="system",
        detail={"policyholder_id": customer.policyholder_id},
    )
    await session.commit()
    await _publish_policy_event(request, policy, event)
    return {"policyholder_id": customer.policyholder_id, "reused": False}


@router.post("/tenants/{tenant_id}/policies/{policy_id}/onboarding/welcome-kit")
async def generate_welcome_kit(
    tenant_id: UUID, policy_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Generate (or regenerate) the welcome-kit PDF for this policy."""
    policy = await _get_policy(session, tenant_id, policy_id)
    _assert_onboardable(policy)
    customer = await session.get(Customer, policy.customer_id)
    portal = None
    if customer is not None:
        portal = (await session.exec(
            select(CustomerPortalAccount).where(CustomerPortalAccount.customer_id == customer.id)
        )).first()

    extra = {
        "policyholder_id": customer.policyholder_id if customer else None,
        "portal_url": portal_service.PORTAL_BASE_URL,
        "portal_username": portal.username if portal else None,
    }
    kit = await render_welcome_kit(session, policy, extra)

    row = await _get_or_create_onboarding(session, policy)
    row.welcome_kit_name = kit["document_name"]
    row.welcome_kit_path = kit["file_path"]
    row.welcome_kit_generated_at = datetime.utcnow()
    row.updated_at = datetime.utcnow()
    session.add(row)
    event = record_event(
        session, policy, event_type="WelcomeKitGenerated", actor="system",
        detail={"document_name": kit["document_name"]},
    )
    await session.commit()
    await _publish_policy_event(request, policy, event)
    return {"document_name": kit["document_name"], "generated_at": row.welcome_kit_generated_at.isoformat()}


@router.get("/tenants/{tenant_id}/policies/{policy_id}/onboarding/welcome-kit/download")
async def download_welcome_kit(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    row = (await session.exec(
        select(PolicyOnboarding).where(PolicyOnboarding.policy_id == policy.id)
    )).first()
    if not row or not row.welcome_kit_path or not os.path.exists(row.welcome_kit_path):
        raise HTTPException(404, "Welcome kit not available (generate it first)")
    filename = f"{row.welcome_kit_name or 'welcome_kit'}.pdf".replace("/", "-")
    return FileResponse(row.welcome_kit_path, media_type="application/pdf", filename=filename)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/onboarding/portal")
async def provision_portal(
    tenant_id: UUID, policy_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Provision (or reset) the customer's mock portal account. Returns the
    one-time temporary password — surfaced ONCE and never stored in plaintext."""
    policy = await _get_policy(session, tenant_id, policy_id)
    _assert_onboardable(policy)
    customer = await session.get(Customer, policy.customer_id)
    if customer is None:
        raise HTTPException(404, "Customer not found")

    details = customer.details or {}
    email = details.get("contact_email") or details.get("email")
    creds = portal_service.provision(customer.policyholder_id, email, str(customer.id))

    portal = (await session.exec(
        select(CustomerPortalAccount).where(CustomerPortalAccount.customer_id == customer.id)
    )).first()
    reset = portal is not None
    if portal is None:
        portal = CustomerPortalAccount(tenant_id=tenant_id, customer_id=customer.id, username=creds.username,
                                       password_hash=creds.password_hash)
    else:
        portal.username = creds.username
        portal.password_hash = creds.password_hash
    portal.status = "Active"
    portal.must_reset = True
    portal.invite_token = creds.invite_token
    portal.invite_expires_at = creds.invite_expires_at
    portal.updated_at = datetime.utcnow()
    session.add(portal)

    await _get_or_create_onboarding(session, policy)
    event = record_event(
        session, policy,
        event_type="PortalCredentialsReset" if reset else "PortalProvisioned",
        actor="system", detail={"username": creds.username},
    )
    await session.commit()
    await _publish_policy_event(request, policy, event)
    return {"reset": reset, **creds.public_dict()}


class ContactBody(BaseModel):
    email: Optional[str] = None
    phone: Optional[str] = None


@router.post("/tenants/{tenant_id}/policies/{policy_id}/onboarding/contact")
async def set_onboarding_contact(
    tenant_id: UUID, policy_id: UUID,
    body: ContactBody,
    session: AsyncSession = Depends(get_session),
):
    """Capture the customer's email / phone inline so the welcome pack can be
    delivered digitally — the primary fix for a "no contact on record" policy.
    Merges into Customer.details (the same place the rest of the app reads it)."""
    policy = await _get_policy(session, tenant_id, policy_id)
    _assert_onboardable(policy)
    if not (body.email or body.phone):
        raise HTTPException(400, "Provide an email or a phone number")
    customer = await session.get(Customer, policy.customer_id)
    if customer is None:
        raise HTTPException(404, "Customer not found")

    # Reassign a new dict so SQLAlchemy detects the JSON column change.
    details = dict(customer.details or {})
    if body.email:
        details["contact_email"] = body.email
    if body.phone:
        details["contact_phone"] = body.phone
    customer.details = details
    session.add(customer)
    await session.commit()
    return await compute_onboarding(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/onboarding/send-welcome")
async def send_welcome(
    tenant_id: UUID, policy_id: UUID,
    body: WelcomeSendBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Deliver the welcome pack + portal invite. Requires a contact channel and a
    generated welcome kit. Email is best-effort (mocked when no SMTP)."""
    policy = await _get_policy(session, tenant_id, policy_id)
    _assert_onboardable(policy)
    customer = await session.get(Customer, policy.customer_id)
    if customer is None:
        raise HTTPException(404, "Customer not found")

    row = await _get_or_create_onboarding(session, policy)
    if not row.welcome_kit_path:
        raise HTTPException(400, "Generate the welcome kit before sending it")

    details = customer.details or {}
    email = details.get("contact_email") or details.get("email")
    phone = details.get("contact_phone") or details.get("phone") or details.get("mobile_number")

    # "Manual" records a physical / handed-over delivery — the fallback when the
    # customer has no digital contact, so onboarding is never stuck. Digital
    # channels still require an email/phone on record.
    manual = (body.channel or "").strip().lower() == "manual"
    if not manual and not (email or phone):
        raise HTTPException(400, "No email or phone on record — add a contact or record manual delivery")

    tenant = await session.get(Tenant, policy.tenant_id)
    tenant_name = tenant.name if tenant else "Our Insurance"

    channel = "Manual" if manual else (body.channel or ("Email" if email else "SMS"))
    if not manual and email:
        html_body = f"""
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #334155; line-height: 1.6;">
            <div style="background-color: #0f766e; padding: 25px; text-align: center; border-radius: 8px 8px 0 0;">
                <h1 style="color: #ffffff; margin: 0; font-size: 24px; letter-spacing: 0.5px;">Welcome to {tenant_name}</h1>
            </div>
            <div style="padding: 30px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px; background-color: #ffffff;">
                <p style="font-size: 16px; margin-top: 0;">Dear <strong>{customer.name}</strong>,</p>
                <p style="font-size: 16px;">Thank you for choosing us for your insurance needs. Your policy <strong>{policy.policy_number or ''}</strong> is now officially active, and your protection has begun.</p>
                
                <div style="background-color: #f8fafc; padding: 20px; border-radius: 6px; margin: 25px 0; border: 1px solid #cbd5e1; text-align: center;">
                    <p style="margin: 0; font-size: 13px; color: #64748b; text-transform: uppercase; font-weight: bold; letter-spacing: 1px;">Your Policyholder ID</p>
                    <p style="margin: 8px 0 0; font-size: 24px; font-weight: bold; color: #0f766e;">{customer.policyholder_id or 'Being Assigned'}</p>
                </div>

                <p style="font-size: 16px;">Please find your comprehensive <strong>Welcome Kit</strong> attached to this email as a PDF. It contains vital details about your coverage and instructions on how to access our customer portal.</p>
                
                <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 30px 0;">
                <p style="font-size: 14px; color: #64748b; margin-bottom: 0;">Warm regards,<br><strong style="color: #334155;">The {tenant_name} Team</strong></p>
            </div>
        </div>
        """

        await email_utils.send_email(
            to_email=email,
            subject=f"Welcome to your policy {policy.policy_number or ''}".strip(),
            text_body=f"Dear {customer.name},\n\nYour policy {policy.policy_number or ''} is now active. Your policyholder ID is "
                      f"{customer.policyholder_id or 'being assigned'}. Please find your welcome kit attached and "
                      f"sign in to the customer portal to manage your policy.\n\nThank you.",
            html_body=html_body,
            attachments=[row.welcome_kit_path]
        )

    row.welcome_sent_at = datetime.utcnow()
    row.welcome_channel = channel
    if row.status != "Completed":
        row.status = "InProgress"
    row.updated_at = datetime.utcnow()
    session.add(row)
    event = record_event(
        session, policy, event_type="WelcomeSent", actor=body.sent_by or "system",
        detail={"channel": channel, "to": email or phone},
    )
    await session.commit()
    await _publish_policy_event(request, policy, event)

    # Reflect completion if this was the last hard step.
    readiness = await compute_onboarding(session, policy)
    if readiness["completed"] and row.status != "Completed":
        row.status = "Completed"
        session.add(row)
        done = record_event(session, policy, event_type="OnboardingCompleted", actor="system")
        await session.commit()
        await _publish_policy_event(request, policy, done)
        readiness = await compute_onboarding(session, policy)
    return {"channel": channel, "sent_at": row.welcome_sent_at.isoformat(), "onboarding": readiness}


@router.post("/tenants/{tenant_id}/policies/{policy_id}/onboarding/acknowledge")
async def acknowledge_onboarding(
    tenant_id: UUID, policy_id: UUID,
    body: AcknowledgeBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Record that the customer confirmed receipt of the welcome pack."""
    policy = await _get_policy(session, tenant_id, policy_id)
    _assert_onboardable(policy)
    row = await _get_or_create_onboarding(session, policy)
    row.acknowledged_at = datetime.utcnow()
    row.acknowledgment_method = body.method or "Manual"
    row.updated_at = datetime.utcnow()
    session.add(row)
    event = record_event(
        session, policy, event_type="OnboardingAcknowledged",
        actor=body.acknowledged_by or "ops", detail={"method": row.acknowledgment_method},
    )
    await session.commit()
    await _publish_policy_event(request, policy, event)
    return await compute_onboarding(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# STEP 3 — Recurring Premium Collection
#   Collect the installment ledger, send reminders, and monitor the grace period
#   (ACTIVE → GRACE_PERIOD → LAPSED, and GRACE_PERIOD → ACTIVE when arrears clear).
#   All actions require an in-force policy (ACTIVE / GracePeriod).
# ══════════════════════════════════════════════════════════════════════════════

class CollectBody(BaseModel):
    method: Optional[str] = None       # JazzCash | Easypaisa | Card | BankTransfer
    reference: Optional[str] = None
    manual: bool = False               # record an over-the-counter / offline payment
    realize: bool = True               # False simulates a failed gateway settlement
    collected_by: Optional[str] = None


class RemindBody(BaseModel):
    channel: Optional[str] = None      # Email | SMS | WhatsApp | Letter
    template: Optional[str] = None     # Friendly | Standard | FinalNotice
    kind: Optional[str] = None         # Upcoming | Due | Overdue | GraceWarning | FinalNotice
    sent_by: Optional[str] = None


class RestructureBody(BaseModel):
    frequency: str                     # Annual | SemiAnnual | Quarterly | Monthly
    actor: Optional[str] = None


class WaiveBody(BaseModel):
    note: Optional[str] = None
    actor: Optional[str] = None


class AutopayBody(BaseModel):
    enabled: bool


def _assert_in_force(policy: Policy) -> None:
    if _st(policy) not in IN_FORCE_STATUSES:
        raise HTTPException(409, f"Premium collection needs an in-force policy (current: {_st(policy)}).")


async def _get_schedule(session: AsyncSession, policy_id: UUID, schedule_id: UUID) -> PremiumSchedule:
    s = await session.get(PremiumSchedule, schedule_id)
    if not s or s.policy_id != policy_id:
        raise HTTPException(404, "Installment not found")
    return s


async def _next_receipt_no(session: AsyncSession, tenant_id: UUID) -> str:
    year = datetime.utcnow().year
    existing = (await session.exec(
        select(PremiumReceipt).where(PremiumReceipt.tenant_id == tenant_id)
    )).all()
    return f"RCPT-{year}-{len(existing) + 1:05d}"


async def _open_arrears(session: AsyncSession, policy_id: UUID, exclude_id: Optional[UUID] = None) -> list[PremiumSchedule]:
    """Unpaid installments already past their due date (excluding one, optionally)."""
    today = date.today()
    rows = (await session.exec(
        select(PremiumSchedule).where(PremiumSchedule.policy_id == policy_id)
    )).all()
    return [
        s for s in rows
        if s.id != exclude_id
        and s.status in (PremiumScheduleStatusEnum.PENDING, PremiumScheduleStatusEnum.OVERDUE)
        and s.due_date < today
    ]


@router.get("/tenants/{tenant_id}/policies/{policy_id}/premiums")
async def premium_ledger(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    return await compute_billing(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/premiums/{schedule_id}/collect")
async def collect_installment(
    tenant_id: UUID, policy_id: UUID, schedule_id: UUID,
    body: CollectBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Collect one installment (gateway or manual). Marks it PAID and, if this
    clears the arrears on a grace-period policy, revives it (GRACE_PERIOD → ACTIVE)."""
    policy = await _get_policy(session, tenant_id, policy_id)
    _assert_in_force(policy)
    schedule = await _get_schedule(session, policy_id, schedule_id)
    if schedule.status not in (PremiumScheduleStatusEnum.PENDING, PremiumScheduleStatusEnum.OVERDUE):
        raise HTTPException(400, f"Installment is not collectable (status: {_v(schedule.status)})")

    base = round(schedule.amount_due - schedule.amount_paid, 2)
    # Late-payment surcharge applies once the installment is overdue (grace/past grace).
    surcharge = surcharge_for(schedule.amount_due, _row_state(schedule, date.today()))
    total = round(base + surcharge, 2)

    if body.manual:
        reference = body.reference or f"MANUAL-{schedule_id.hex[:8].upper()}"
        method = body.method or "Manual"
    else:
        reference = body.reference or schedule.payment_reference or payment_gateway.generate_reference(
            payment_gateway.PaymentMethodEnum.JAZZCASH
        )
        try:
            intent = payment_gateway.confirm_payment(reference, total, body.method, realize=body.realize)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if intent.status != payment_gateway.PaymentStatusEnum.REALIZED:
            record_event(session, policy, event_type="PremiumPaymentFailed", actor="gateway",
                         detail={"schedule_id": str(schedule_id), "amount": total, "reference": reference})
            await session.commit()
            raise HTTPException(402, "Payment was not realized — installment remains outstanding")
        reference = intent.reference
        method = intent.method.value

    schedule.amount_paid = schedule.amount_due
    schedule.status = PremiumScheduleStatusEnum.PAID
    schedule.paid_at = datetime.utcnow()
    schedule.payment_reference = reference
    session.add(schedule)

    # ── Receipt (with any surcharge) + agent commission on this collection ─────
    customer = await session.get(Customer, policy.customer_id)
    tenant = await session.get(Tenant, policy.tenant_id)
    commission_pct = insurer_config.AGENT_COMMISSION_PCT
    commission_amount = round(base * commission_pct / 100.0, 2)
    agent_id = str(customer.assigned_agent_id) if (customer and customer.assigned_agent_id) else "unassigned"
    receipt_no = await _next_receipt_no(session, tenant_id)

    kit = document_generator.generate_receipt({
        "policy_id": policy.id, "tenant_name": tenant.name if tenant else "Insurer",
        "customer_name": customer.name if customer else "—",
        "policy_number": policy.policy_number, "installment_no": schedule.installment_no,
        "paid_date": date.today().isoformat(), "method": method, "payment_reference": reference,
        "base_amount": base, "surcharge_amount": surcharge, "total_amount": total,
    })
    receipt = PremiumReceipt(
        tenant_id=tenant_id, policy_id=policy_id, schedule_id=schedule_id,
        receipt_no=receipt_no, base_amount=base, surcharge_amount=surcharge, total_amount=total,
        method=method, payment_reference=reference,
        commission_agent_id=agent_id, commission_pct=commission_pct, commission_amount=commission_amount,
        document_path=kit["file_path"],
    )
    session.add(receipt)

    events = [record_event(
        session, policy, event_type="PremiumCollected",
        actor=body.collected_by or ("manual" if body.manual else "gateway"),
        detail={"schedule_id": str(schedule_id), "installment_no": schedule.installment_no,
                "base": base, "surcharge": surcharge, "total": total, "reference": reference,
                "receipt_no": receipt_no, "commission": commission_amount},
    )]

    # Revive a grace-period policy once the last arrear is cleared.
    if _st(policy) == PolicyStatusEnum.GRACE_PERIOD.value and not await _open_arrears(session, policy_id, exclude_id=schedule_id):
        try:
            events.append(apply_transition(
                session, policy, PolicyStatusEnum.ACTIVE,
                event_type="PolicyRevived", actor="system",
                detail={"reason": "arrears_cleared", "schedule_id": str(schedule_id)},
            ))
        except IllegalStateTransition:
            pass

    await session.commit()
    for ev in events:
        await _publish_policy_event(request, policy, ev)
    return await compute_billing(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/premiums/{schedule_id}/remind")
async def remind_installment(
    tenant_id: UUID, policy_id: UUID, schedule_id: UUID,
    body: RemindBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Send a payment reminder over a chosen channel (Email / SMS / WhatsApp /
    Letter) with a chosen template (Friendly / Standard / FinalNotice). Every send
    is logged to PremiumReminder for the history. Email is best-effort; other
    channels are simulated (logged) like the payment gateway."""
    policy = await _get_policy(session, tenant_id, policy_id)
    _assert_in_force(policy)
    schedule = await _get_schedule(session, policy_id, schedule_id)
    if schedule.status in (PremiumScheduleStatusEnum.PAID, PremiumScheduleStatusEnum.WAIVED):
        raise HTTPException(400, "Installment already settled — nothing to remind about")

    customer = await session.get(Customer, policy.customer_id)
    details = (customer.details if customer else None) or {}
    email = details.get("contact_email") or details.get("email")
    phone = details.get("contact_phone") or details.get("phone") or details.get("mobile_number")

    channel = body.channel if body.channel in insurer_config.REMINDER_CHANNELS else "Email"
    template = body.template if body.template in insurer_config.REMINDER_TEMPLATES else "Standard"
    kind = body.kind or "Overdue"
    to_address = email if channel == "Email" else (phone if channel in ("SMS", "WhatsApp") else "postal")
    if channel in ("Email", "SMS", "WhatsApp") and not (email or phone):
        raise HTTPException(400, "No email or phone on record — add a contact or use the Letter channel")

    message = insurer_config.REMINDER_BODIES.get(template, insurer_config.REMINDER_BODIES["Standard"]).format(
        name=customer.name if customer else "Policyholder",
        amount=f"{schedule.amount_due:,.0f}",
        due=schedule.due_date.isoformat(),
        policy=policy.policy_number or "—",
    )
    if channel == "Email" and email:
        await email_utils.send_email(email, f"Premium reminder — policy {policy.policy_number or ''}".strip(), message)

    schedule.reminder_count = (schedule.reminder_count or 0) + 1
    schedule.last_reminder_at = datetime.utcnow()
    session.add(schedule)
    session.add(PremiumReminder(
        tenant_id=tenant_id, policy_id=policy_id, schedule_id=schedule_id,
        kind=kind, channel=channel, template=template, to_address=to_address,
        message=message, sent_by=body.sent_by or "ops",
    ))
    event = record_event(
        session, policy, event_type="PremiumReminderSent", actor=body.sent_by or "system",
        detail={"schedule_id": str(schedule_id), "channel": channel, "template": template, "kind": kind},
    )
    await session.commit()
    await _publish_policy_event(request, policy, event)
    return await compute_billing(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/premiums/{schedule_id}/waive")
async def waive_installment(
    tenant_id: UUID, policy_id: UUID, schedule_id: UUID,
    body: WaiveBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Ops-waive an installment (e.g. goodwill / correction). A waived row no
    longer counts as arrears and cannot trigger a lapse."""
    policy = await _get_policy(session, tenant_id, policy_id)
    _assert_in_force(policy)
    schedule = await _get_schedule(session, policy_id, schedule_id)
    if schedule.status in (PremiumScheduleStatusEnum.PAID, PremiumScheduleStatusEnum.WAIVED):
        raise HTTPException(400, f"Installment is already {_v(schedule.status)}")

    schedule.status = PremiumScheduleStatusEnum.WAIVED
    session.add(schedule)
    events = [record_event(
        session, policy, event_type="PremiumWaived", actor=body.actor or "ops",
        detail={"schedule_id": str(schedule_id), "note": body.note},
    )]
    if _st(policy) == PolicyStatusEnum.GRACE_PERIOD.value and not await _open_arrears(session, policy_id, exclude_id=schedule_id):
        try:
            events.append(apply_transition(
                session, policy, PolicyStatusEnum.ACTIVE,
                event_type="PolicyRevived", actor="system",
                detail={"reason": "arrears_waived", "schedule_id": str(schedule_id)},
            ))
        except IllegalStateTransition:
            pass
    await session.commit()
    for ev in events:
        await _publish_policy_event(request, policy, ev)
    return await compute_billing(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/premiums/monitor")
async def monitor_premiums(
    tenant_id: UUID, policy_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Evaluate the schedule against today: flag overdue installments and drive the
    grace/lapse transitions (ACTIVE → GRACE_PERIOD → LAPSED, GRACE_PERIOD → ACTIVE).
    The on-demand equivalent of the daily billing sweep."""
    policy = await _get_policy(session, tenant_id, policy_id)
    if _st(policy) not in IN_FORCE_STATUSES:
        return await compute_billing(session, policy)

    today = date.today()
    rows = (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy_id))).all()
    for s in rows:
        if s.status == PremiumScheduleStatusEnum.PENDING and s.due_date < today:
            s.status = PremiumScheduleStatusEnum.OVERDUE
            session.add(s)

    arrears = [s for s in rows if s.status in (PremiumScheduleStatusEnum.PENDING, PremiumScheduleStatusEnum.OVERDUE)
               and s.due_date < today]
    earliest = min(arrears, key=lambda s: s.due_date) if arrears else None
    grace_until = (earliest.due_date + timedelta(days=_GRACE_DAYS)) if earliest else None
    cur = _st(policy)

    target = None
    ev_type = None
    if earliest and grace_until and today > grace_until:
        target, ev_type = PolicyStatusEnum.LAPSED, "PolicyLapsed"
    elif earliest and cur == PolicyStatusEnum.ACTIVE.value:
        target, ev_type = PolicyStatusEnum.GRACE_PERIOD, "PolicyEnteredGrace"
    elif not arrears and cur == PolicyStatusEnum.GRACE_PERIOD.value:
        target, ev_type = PolicyStatusEnum.ACTIVE, "PolicyRevived"

    event = None
    if target is not None and target.value != cur:
        try:
            event = apply_transition(session, policy, target, event_type=ev_type, actor="system",
                                     detail={"as_of": today.isoformat()})
        except IllegalStateTransition:
            event = None
    await session.commit()
    if event is not None:
        await _publish_policy_event(request, policy, event)
    return await compute_billing(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/premiums/autopay")
async def set_autopay(
    tenant_id: UUID, policy_id: UUID,
    body: AutopayBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Toggle the mock standing-instruction / auto-debit mandate for the policy."""
    policy = await _get_policy(session, tenant_id, policy_id)
    _assert_in_force(policy)
    policy.autopay_enabled = body.enabled
    session.add(policy)
    event = record_event(session, policy, event_type="AutopayUpdated", actor="ops",
                         detail={"enabled": body.enabled})
    await session.commit()
    await _publish_policy_event(request, policy, event)
    return await compute_billing(session, policy)


# ── Demo helper ───────────────────────────────────────────────────────────────
# Issuance seeds a single ANNUAL installment (paid at binding), which leaves
# nothing to collect and nothing to age overdue. This DEMO-ONLY endpoint rebuilds
# a multi-installment schedule anchored around today so the whole recurring-
# collection flow (collect, remind, grace, revive, lapse) can be exercised live.

class DemoSeedBody(BaseModel):
    scenario: Optional[str] = "grace"   # healthy | grace | lapse


# (day_offset_from_today, is_paid) — installment #1 is always the paid first premium.
_DEMO_SCENARIOS: dict[str, list[tuple[int, bool]]] = {
    "healthy": [(-90, True), (30, False), (60, False), (90, False)],
    "grace":   [(-90, True), (-10, False), (20, False), (50, False)],
    "lapse":   [(-120, True), (-45, False), (-15, False)],
}


@router.post("/tenants/{tenant_id}/policies/{policy_id}/premiums/demo-seed")
async def demo_seed_premiums(
    tenant_id: UUID, policy_id: UUID,
    body: DemoSeedBody,
    session: AsyncSession = Depends(get_session),
):
    """DEMO ONLY — rebuild the installment ledger for a quick end-to-end test.

    scenario: 'healthy' (first premium paid, rest upcoming), 'grace' (one overdue
    within the grace window → 'Run monitor' moves to GracePeriod), or 'lapse'
    (arrears past grace → 'Run monitor' lapses the policy).
    """
    policy = await _get_policy(session, tenant_id, policy_id)
    # Demo reset works from any in-force OR lapsed policy so the flow can be
    # re-run repeatedly (a lapsed policy is otherwise a dead end until Step 5).
    if _st(policy) not in IN_FORCE_STATUSES and _st(policy) != PolicyStatusEnum.LAPSED.value:
        raise HTTPException(409, f"Demo seed needs an in-force or lapsed policy (current: {_st(policy)}).")
    plan = _DEMO_SCENARIOS.get((body.scenario or "grace").lower(), _DEMO_SCENARIOS["grace"])

    version = (await session.exec(
        select(PolicyVersion).where(PolicyVersion.policy_id == policy_id)
        .order_by(PolicyVersion.created_at.desc())  # type: ignore[arg-type]
    )).first()
    annual = version.total_premium if version else 0.0
    per = round(annual / max(len(plan), 1), 2) or 25000.0

    # Clear the current schedule and rebuild.
    for old in (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy_id))).all():
        await session.delete(old)

    today = date.today()
    version_id = policy.current_version_id or (version.id if version else None)
    for i, (offset, paid) in enumerate(plan, start=1):
        session.add(PremiumSchedule(
            policy_id=policy_id,
            policy_version_id=version_id,
            billing_frequency=BillingFrequencyEnum.QUARTERLY,
            due_date=today + timedelta(days=offset),
            amount_due=per,
            amount_paid=per if paid else 0.0,
            status=PremiumScheduleStatusEnum.PAID if paid else PremiumScheduleStatusEnum.PENDING,
            paid_at=datetime.utcnow() if paid else None,
            payment_reference=f"DEMO-{i}" if paid else None,
            installment_no=i,
        ))

    # Reset the policy to ACTIVE so the scenario starts from a clean in-force state
    # (revives a GracePeriod or Lapsed policy so the demo can be re-run).
    if _st(policy) in (PolicyStatusEnum.GRACE_PERIOD.value, PolicyStatusEnum.LAPSED.value):
        try:
            apply_transition(session, policy, PolicyStatusEnum.ACTIVE,
                             event_type="DemoReset", actor="demo")
        except IllegalStateTransition:
            pass
    await session.commit()
    return await compute_billing(session, policy)


# ── Receipts, reminder history, restructuring & lapse-warning letter ──────────

_PER_YEAR = {"Annual": 1, "SemiAnnual": 2, "Quarterly": 4, "Monthly": 12}


@router.get("/tenants/{tenant_id}/policies/{policy_id}/premiums/reminders")
async def reminder_history(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    """Full reminder log for a policy, newest first."""
    await _get_policy(session, tenant_id, policy_id)
    rows = (await session.exec(
        select(PremiumReminder).where(PremiumReminder.policy_id == policy_id)
        .order_by(PremiumReminder.created_at.desc())  # type: ignore[arg-type]
    )).all()
    return [{
        "id": str(r.id), "schedule_id": str(r.schedule_id) if r.schedule_id else None,
        "kind": r.kind, "channel": r.channel, "template": r.template,
        "to_address": r.to_address, "message": r.message,
        "sent_by": r.sent_by, "created_at": r.created_at.isoformat(),
    } for r in rows]


@router.get("/tenants/{tenant_id}/policies/{policy_id}/premiums/receipts")
async def receipt_list(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    """All payment receipts for a policy, newest first."""
    await _get_policy(session, tenant_id, policy_id)
    rows = (await session.exec(
        select(PremiumReceipt).where(PremiumReceipt.policy_id == policy_id)
        .order_by(PremiumReceipt.created_at.desc())  # type: ignore[arg-type]
    )).all()
    return [{
        "id": str(r.id), "receipt_no": r.receipt_no, "schedule_id": str(r.schedule_id) if r.schedule_id else None,
        "base_amount": r.base_amount, "surcharge_amount": r.surcharge_amount, "total_amount": r.total_amount,
        "method": r.method, "payment_reference": r.payment_reference,
        "commission_agent_id": r.commission_agent_id, "commission_pct": r.commission_pct,
        "commission_amount": r.commission_amount, "created_at": r.created_at.isoformat(),
    } for r in rows]


@router.get("/tenants/{tenant_id}/policies/{policy_id}/premiums/receipts/{receipt_id}/download")
async def download_receipt(
    tenant_id: UUID, policy_id: UUID, receipt_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    await _get_policy(session, tenant_id, policy_id)
    receipt = await session.get(PremiumReceipt, receipt_id)
    if not receipt or receipt.policy_id != policy_id:
        raise HTTPException(404, "Receipt not found")
    if not receipt.document_path or not os.path.exists(receipt.document_path):
        raise HTTPException(404, "Receipt PDF not available")
    return FileResponse(receipt.document_path, media_type="application/pdf",
                        filename=f"{receipt.receipt_no}.pdf")


@router.post("/tenants/{tenant_id}/policies/{policy_id}/premiums/restructure")
async def restructure_plan(
    tenant_id: UUID, policy_id: UUID,
    body: RestructureBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Change the billing frequency mid-term. Keeps collected installments and
    rebuilds the outstanding amount into the new cadence."""
    policy = await _get_policy(session, tenant_id, policy_id)
    _assert_in_force(policy)
    if body.frequency not in _PER_YEAR:
        raise HTTPException(400, f"Unknown frequency '{body.frequency}'")

    rows = (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy_id))).all()
    version = (await session.exec(
        select(PolicyVersion).where(PolicyVersion.policy_id == policy_id)
        .order_by(PolicyVersion.created_at.desc())  # type: ignore[arg-type]
    )).first()
    annual = version.total_premium if version else sum(s.amount_due for s in rows)

    paid = [s for s in rows if s.status == PremiumScheduleStatusEnum.PAID]
    collected = round(sum(s.amount_paid for s in paid), 2)
    remaining = round(max(annual - collected, 0.0), 2)

    for s in rows:
        if s.status != PremiumScheduleStatusEnum.PAID:
            await session.delete(s)

    n = _PER_YEAR[body.frequency]
    per = round(remaining / n, 2) if n else remaining
    step = 365 // n if n else 365
    today = date.today()
    start_no = (max((s.installment_no for s in paid), default=0)) + 1
    for i in range(n):
        amount = round(remaining - per * (n - 1), 2) if i == 0 else per
        session.add(PremiumSchedule(
            policy_id=policy_id, policy_version_id=policy.current_version_id,
            billing_frequency=BillingFrequencyEnum(body.frequency),
            due_date=today + timedelta(days=step * i),
            amount_due=amount, amount_paid=0.0,
            status=PremiumScheduleStatusEnum.PENDING, installment_no=start_no + i,
        ))

    event = record_event(session, policy, event_type="PaymentPlanRestructured",
                         actor=body.actor or "ops",
                         detail={"frequency": body.frequency, "remaining": remaining, "installments": n})
    await session.commit()
    await _publish_policy_event(request, policy, event)
    return await compute_billing(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/premiums/lapse-warning")
async def lapse_warning_letter(
    tenant_id: UUID, policy_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Generate the formal lapse-warning letter (and log a Letter reminder). Returns
    the PDF for download. Use when a policy is in grace with unpaid arrears."""
    policy = await _get_policy(session, tenant_id, policy_id)
    customer = await session.get(Customer, policy.customer_id)
    tenant = await session.get(Tenant, policy.tenant_id)

    billing = await compute_billing(session, policy)
    letter = document_generator.generate_lapse_warning({
        "policy_id": policy.id, "tenant_name": tenant.name if tenant else "Insurer",
        "customer_name": customer.name if customer else "Policyholder",
        "policy_number": policy.policy_number,
        "amount_due": billing["summary"]["total_outstanding"],
        "grace_until": billing["summary"]["grace_until"] or "—",
    })
    session.add(PremiumReminder(
        tenant_id=tenant_id, policy_id=policy_id, schedule_id=None,
        kind="FinalNotice", channel="Letter", template="FinalNotice",
        to_address="postal", message="Lapse warning letter issued", sent_by="ops",
    ))
    event = record_event(session, policy, event_type="LapseWarningIssued", actor="ops",
                         detail={"grace_until": billing["summary"]["grace_until"]})
    await session.commit()
    await _publish_policy_event(request, policy, event)
    return FileResponse(letter["file_path"], media_type="application/pdf", filename="lapse_warning.pdf")
