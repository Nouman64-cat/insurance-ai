"""Email a customer the secure link they need for their application — the
e-application questionnaire or their medical examination page.

Best-effort, like every other customer email: the link is also returned to
staff, so a missing address or a mail outage never blocks issuing it.
"""
import os
from datetime import datetime
from typing import Optional

import email_utils
from services.email_templates import customer_action_link_email
from shared.models.core import Case, Customer, Tenant

# Where the customer-facing pages (/e-application/<token>, /medical-exam/<token>) are served.
PORTAL_PUBLIC_URL = os.environ.get("PORTAL_PUBLIC_URL", "http://localhost:3000").rstrip("/")


def customer_email(customer: Optional[Customer]) -> Optional[str]:
    details = (customer.details if customer else None) or {}
    email = (details.get("contact_email") or details.get("email") or "").strip()
    return email or None


async def email_customer_link(
    session, *, kind: str, tenant_id, case: Case, link_path: str, expires_at: datetime,
    tests: Optional[list[str]] = None,
) -> dict:
    """Send the link; returns {"emailed_to", "email_status"} where status is
    "sent", "failed" or "no_email"."""
    customer = await session.get(Customer, case.customer_id)
    to = customer_email(customer)
    if not to:
        return {"emailed_to": None, "email_status": "no_email"}
    tenant = await session.get(Tenant, tenant_id)
    subject, text, html = customer_action_link_email(
        kind=kind,
        customer_name=customer.name if customer else "",
        tenant_name=(tenant.name if tenant else None) or "Your insurer",
        url=f"{PORTAL_PUBLIC_URL}{link_path}",
        expires_on=expires_at.strftime("%d %b %Y"),
        case_number=case.caseNumber,
        tests=tests,
        tenant_phone=getattr(tenant, "contact_phone", None),
        tenant_email=getattr(tenant, "contact_email", None),
    )
    ok = await email_utils.send_email(to, subject, text, html)
    return {"emailed_to": to, "email_status": "sent" if ok else "failed"}
