"""Customer-side payment of the initial premium: the secure link, the emails, and the staff notification.

Staff ask the customer to pay (routers/initial_premium_payment.py). The customer gets an email and sees the request in
the walk-in portal, pays through their own channel and uploads a screenshot (routers/customer_portal_walkin.py). Staff
are told, review the screenshot and confirm the payment.

The link token is `<payment id>.<signature>`, signed with the server secret from the payment id and its
`request_version`. Nothing secret is stored, so staff can always copy the same link, and asking again (which bumps the
version) retires the old one. It only ever lets the holder see this one payment and add proof to it.
"""

import hashlib
import hmac
import logging
import os
from datetime import datetime, timedelta
from typing import Any, Optional
from urllib.parse import urlparse
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import Customer, InitialPremiumPayment, Policy, Tenant, User

log = logging.getLogger(__name__)

LINK_VALID_DAYS = 7
_SECRET = os.environ.get("JWT_SECRET_KEY", "change-me-in-production")


def _signature(payment_id: UUID, version: int) -> str:
    return hmac.new(_SECRET.encode(), f"ipp-pay:{payment_id}:{version}".encode(), hashlib.sha256).hexdigest()[:40]


def make_token(ipp: InitialPremiumPayment) -> str:
    return f"{ipp.id.hex}.{_signature(ipp.id, ipp.request_version)}"


async def find_by_token(session: AsyncSession, token: str) -> Optional[InitialPremiumPayment]:
    try:
        id_hex, signature = token.split(".", 1)
        payment_id = UUID(hex=id_hex)
    except (ValueError, AttributeError):
        return None
    ipp = await session.get(InitialPremiumPayment, payment_id)
    if ipp is None or ipp.request_version < 1 or not hmac.compare_digest(signature, _signature(ipp.id, ipp.request_version)):
        return None
    return ipp


def portal_origin() -> str:
    """Where customers open the walk-in portal (the origin of CUSTOMER_PORTAL_URL, which points at its sign-in page)."""
    url = urlparse(os.environ.get("CUSTOMER_PORTAL_URL", "http://localhost:3009/login"))
    return f"{url.scheme}://{url.netloc}"


def pay_link(ipp: InitialPremiumPayment) -> str:
    return f"{portal_origin()}/walk-in/pay/{make_token(ipp)}"


def customer_email(customer: Optional[Customer]) -> Optional[str]:
    d = (customer.details or {}) if customer else {}
    contact = d.get("contact") if isinstance(d.get("contact"), dict) else {}
    return d.get("contact_email") or d.get("email") or contact.get("email") or None


def start_request(ipp: InitialPremiumPayment, requested_by: str) -> None:
    """A fresh link and a fresh expiry; any previous link stops working. The proof state restarts only if none was accepted."""
    now = datetime.utcnow()
    ipp.request_version += 1
    ipp.request_expires_at = now + timedelta(days=LINK_VALID_DAYS)
    ipp.requested_at, ipp.requested_by = now, requested_by
    if ipp.proof_status != "Accepted":
        ipp.proof_status = "None"
    ipp.updated_at = now


def is_open(ipp: InitialPremiumPayment) -> bool:
    return ipp.request_expires_at is not None and ipp.request_expires_at >= datetime.utcnow()


async def _send(to: str, subject: str, body: str) -> bool:
    from services import lead_routing
    return await lead_routing._send(to, subject, body)


async def email_customer_request(session: AsyncSession, ipp: InitialPremiumPayment, policy: Policy, customer: Customer, reminder: bool = False) -> bool:
    to = customer_email(customer)
    if not to:
        return False
    tenant = await session.get(Tenant, ipp.tenant_id)
    name = tenant.name if tenant else "Your insurer"
    subject = (f"Reminder — {name}: initial premium for {policy.product_name} is still due" if reminder
               else f"{name}: please pay the initial premium for {policy.product_name}")
    return await _send(
        to, subject,
        f"Dear {customer.name},\n\n"
        + ("This is a friendly reminder that your initial premium is still due. " if reminder
           else f"Your application for {policy.product_name} has been reviewed and is ready for the next step. ")
        + f"To continue, please pay the initial premium of PKR {round(ipp.amount):,}.\n\n"
        f"Open this secure link to see the payment details, then upload your receipt or tell us you have paid:\n{pay_link(ipp)}\n\n"
        f"The link is valid until {ipp.request_expires_at:%d %b %Y}. Once we have checked your payment, your application "
        f"moves on to underwriting.\n\nIf you did not apply for this plan, you can ignore this message.")


async def email_customer_confirmed(session: AsyncSession, ipp: InitialPremiumPayment, policy: Policy, customer: Customer) -> bool:
    to = customer_email(customer)
    if not to:
        return False
    return await _send(to, "We received your payment",
                       f"Dear {customer.name},\n\nThank you. We have received your initial premium of PKR {round(ipp.amount):,} for {policy.product_name}. "
                       "Your application now moves on to underwriting and your advisor will keep you updated.")


async def email_customer_rejection(session: AsyncSession, ipp: InitialPremiumPayment, customer: Customer) -> bool:
    to = customer_email(customer)
    if not to:
        return False
    return await _send(
        to, "We could not confirm your payment",
        f"Dear {customer.name},\n\nWe could not confirm the payment you uploaded."
        + (f" Reason: {ipp.proof_review_note}\n" if ipp.proof_review_note else "\n")
        + f"\nPlease check it and upload a clear screenshot again using your secure link:\n{pay_link(ipp)}")


async def notify_staff_proof(session: AsyncSession, ipp: InitialPremiumPayment, policy: Policy, customer: Customer) -> int:
    """Tell whoever handles this application that the customer says they have paid (with or without a receipt)."""
    from services import lead_routing
    people: dict[UUID, User] = {u.id: u for u in await lead_routing.staff_recipients(session, ipp.tenant_id, customer.branch_id)}
    if customer.assigned_agent_id:
        agent = await session.get(User, customer.assigned_agent_id)
        if agent is not None and agent.is_active and not agent.is_deleted:
            people[agent.id] = agent
    detail = ", ".join(x for x in (ipp.proof_method, f"ref {ipp.proof_reference}" if ipp.proof_reference else None) if x)
    what = "uploaded a receipt for" if ipp.proof_artifact_id else "told us they have paid"
    sent = 0
    for person in people.values():
        if await _send(person.email, f"Payment proof received: {customer.name}",
                       f"{customer.name} has {what} the initial premium (PKR {round(ipp.amount):,}) for {policy.product_name}"
                       + (f" ({detail})" if detail else "") + ".\n\n"
                       "Open the application in Proposals to check it and confirm the payment. Once it is confirmed, the application can go to underwriting."):
            sent += 1
    return sent


async def build_receipt(session: AsyncSession, ipp: InitialPremiumPayment) -> dict:
    """A plain receipt for a cleared initial premium: what was received, from whom, how, and who confirmed it."""
    policy = await session.get(Policy, ipp.policy_id)
    customer = await session.get(Customer, policy.customer_id) if policy else None
    tenant = await session.get(Tenant, ipp.tenant_id)
    received = ipp.realized_at or ipp.updated_at
    return {
        "receipt_no": f"RCT-{received.year}-{ipp.id.hex[:6].upper()}", "received_at": received.isoformat(), "amount": round(ipp.amount or 0, 2),
        "method": ipp.method, "reference": ipp.reference or ipp.proof_reference, "confirmed_by": ipp.proof_reviewed_by,
        "customer_name": customer.name if customer else None, "plan_label": policy.product_name if policy else None,
        "insurer": {"name": tenant.name if tenant else None, "phone": getattr(tenant, "contact_phone", None), "email": getattr(tenant, "contact_email", None)},
    }


async def publish_change(tenant_id: UUID) -> None:
    """Live screens (Proposals, Leads) refresh themselves; never raises."""
    try:
        from main import app
        from services.case_events import publish_data_changed
        producer = getattr(app.state, "kafka_producer", None)
        if producer is not None:
            for resource in ("policies", "customers"):
                await publish_data_changed(producer, tenant_id=tenant_id, resource=resource, method="PUT")
    except Exception:
        log.debug("could not publish the change event", exc_info=True)
