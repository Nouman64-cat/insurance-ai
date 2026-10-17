"""Durable welcome-kit and customer-email work, queued in the binding transaction.

Workers lock one policy at a time with SKIP LOCKED. Successful steps are persisted
independently so an email outage never rolls back cover or re-sends other mail.
SMTP cannot guarantee exactly-once delivery across a crash after acceptance.
"""
import asyncio
import logging
import os
from datetime import datetime, timedelta
from html import escape

from sqlmodel import select
import email_utils
from shared.models.core import (Customer, CustomerPortalAccount, Policy, PolicyDeliveryJob,
                                PolicyEvent, PolicyOnboarding, PolicyVersion, PremiumSchedule, Tenant)
from shared.services.policy_state_machine import record_event
from services.customer_links import customer_email
from services.email_templates import issuance_email
from services.onboarding_gate import ONBOARDING_STATUSES
from services.policy_documents import render_welcome_kit
from services import portal_service

log = logging.getLogger(__name__)
# One email goes out when a policy is issued (WelcomeEmail: policy summary, documents and portal sign-in). The old separate
# IssuanceEmail job is no longer queued; any still waiting from before is completed without sending a second email.
KINDS = ("WelcomeKit", "WelcomeEmail")


def value(v):
    return v.value if hasattr(v, "value") else str(v)


async def enqueue_delivery(session, policy):
    if value(policy.status) not in ONBOARDING_STATUSES:
        return
    # Serializes enqueue calls from binding and existing-policy page requests.
    await session.exec(select(Policy).where(Policy.id == policy.id).with_for_update())
    existing = (await session.exec(select(PolicyDeliveryJob).where(PolicyDeliveryJob.policy_id == policy.id))).all()
    kinds = {job.kind for job in existing}
    for kind in KINDS:
        if kind not in kinds:
            session.add(PolicyDeliveryJob(tenant_id=policy.tenant_id, policy_id=policy.id, kind=kind))


async def delivery_status(session, policy_id):
    jobs = (await session.exec(select(PolicyDeliveryJob).where(PolicyDeliveryJob.policy_id == policy_id))).all()
    return {job.kind: {"status": job.status, "attempts": job.attempts,
                      "error": job.last_error,
                      "completed_at": job.completed_at.isoformat() if job.completed_at else None}
            for job in jobs}


async def retry_delivery_after_contact(session, policy):
    await enqueue_delivery(session, policy)
    jobs = (await session.exec(select(PolicyDeliveryJob).where(
        PolicyDeliveryJob.policy_id == policy.id, PolicyDeliveryJob.status == "Retry"
    ).with_for_update())).all()
    for job in jobs:
        job.next_attempt_at = datetime.utcnow()
        job.last_error = None
        session.add(job)


async def _onboarding(session, policy):
    row = (await session.exec(select(PolicyOnboarding).where(PolicyOnboarding.policy_id == policy.id))).first()
    if row is None:
        row = PolicyOnboarding(tenant_id=policy.tenant_id, policy_id=policy.id, status="InProgress")
        session.add(row)
    return row


async def _ensure_kit(session, policy, customer):
    row = await _onboarding(session, policy)
    if row.welcome_kit_path and os.path.isfile(row.welcome_kit_path):
        return row
    # Same customer may have several policies. Lock it before assigning an ID.
    customer = (await session.exec(select(Customer).where(Customer.id == customer.id).with_for_update())).one()
    if not customer.policyholder_id:
        await session.exec(select(Tenant).where(Tenant.id == policy.tenant_id).with_for_update())
        from routers.post_issuance import _next_policyholder_id
        customer.policyholder_id = await _next_policyholder_id(session, policy.tenant_id)
        session.add(customer)
        record_event(session, policy, event_type="PolicyholderIdAssigned", actor="system",
                     detail={"policyholder_id": customer.policyholder_id})
    portal = (await session.exec(select(CustomerPortalAccount).where(CustomerPortalAccount.customer_id == customer.id))).first()
    kit = await render_welcome_kit(session, policy, {"policyholder_id": customer.policyholder_id,
            "portal_url": portal_service.PORTAL_BASE_URL, "portal_username": portal.username if portal else None})
    row.welcome_kit_name, row.welcome_kit_path = kit["document_name"], kit["file_path"]
    row.welcome_kit_generated_at = row.updated_at = datetime.utcnow()
    session.add(row)
    record_event(session, policy, event_type="WelcomeKitGenerated", actor="system", detail={"document_name": kit["document_name"], "automatic": True})
    return row


async def summary_rows_for_email(session, policy) -> list:
    """The policy summary shown in the issuance email: product, sum assured, premium, dates, free-look."""
    from services.email_templates import _pkr
    version = await session.get(PolicyVersion, policy.current_version_id) if policy.current_version_id else None
    schedule = (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy.id)
                                   .order_by(PremiumSchedule.installment_no))).first()
    premium = version.total_premium if version else (schedule.amount_due if schedule else None)
    freq = value(schedule.billing_frequency) if schedule else "Annual"
    iso = lambda d: d.isoformat() if d else None
    return [
        ("Product", policy.product_name),
        ("Sum assured", _pkr(policy.coverage_amount)),
        ("Premium", f"{_pkr(premium)} ({freq})" if premium is not None else None),
        ("Commencement date", iso(policy.effective_date)),
        ("Maturity date", iso(policy.maturity_date)),
        ("Free-look until", iso(policy.free_look_end_date)),
    ]


async def execute_job(session, job, policy):
    """Returns an actionable retry reason, or None when work is complete."""
    if job.kind == "IssuanceEmail":
        return None
    customer = await session.get(Customer, policy.customer_id)
    if customer is None:
        return "Customer record is missing."
    if job.kind == "WelcomeKit":
        await _ensure_kit(session, policy, customer)
        return None
    row = await _onboarding(session, policy)
    if job.kind == "WelcomeEmail" and row.welcome_sent_at:
        return None
    if job.kind == "IssuanceEmail":
        events = (await session.exec(select(PolicyEvent).where(PolicyEvent.policy_id == policy.id,
                                        PolicyEvent.event_type == "IssuanceEmailSent"))).all()
        if any((e.detail_json or {}).get("delivered") is True for e in events):
            return None
    address = customer_email(customer)
    if not address:
        return "No customer email on record. Add an email to send automatically."
    tenant = await session.get(Tenant, policy.tenant_id)
    if job.kind == "WelcomeEmail":
        if not row.welcome_kit_path or not os.path.isfile(row.welcome_kit_path):
            return "Waiting for welcome-kit generation."
        name = tenant.name if tenant else "Your Insurer"
        from services.policy_documents import email_attachments
        from services.email_templates import welcome_email
        from routers.post_issuance import portal_credentials_for_email
        creds = await portal_credentials_for_email(session, policy.tenant_id, policy, commit=False)
        cred_text, cred_html = portal_service.credentials_block(creds)
        attachments, left_out = await email_attachments(session, policy, row.welcome_kit_path)
        subject, text, html = welcome_email(
            customer_name=customer.name, tenant_name=name, policy_number=policy.policy_number or "",
            policyholder_id=customer.policyholder_id, attached=[n for _, n in attachments], left_out=left_out,
            creds_html=cred_html, creds_text=cred_text, portal_url=portal_service.PORTAL_BASE_URL,
            tenant_phone=tenant.contact_phone if tenant else None, tenant_email=tenant.contact_email if tenant else None,
            summary_rows=await summary_rows_for_email(session, policy))
        ok = await email_utils.send_email(address, subject, text, html, attachments=attachments)
        event_type = "WelcomeSent"
    else:
        version = await session.get(PolicyVersion, policy.current_version_id) if policy.current_version_id else None
        schedule = (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy.id).order_by(PremiumSchedule.installment_no))).first()
        subject, text, html = issuance_email(customer_name=customer.name,
            tenant_name=tenant.name if tenant else "Your Insurer", policy_number=policy.policy_number,
            product_name=policy.product_name, sum_assured=policy.coverage_amount,
            premium=version.total_premium if version else (schedule.amount_due if schedule else None),
            billing_frequency=value(schedule.billing_frequency) if schedule else "Annual",
            effective_date=policy.effective_date.isoformat() if policy.effective_date else None,
            maturity_date=policy.maturity_date.isoformat() if policy.maturity_date else None,
            free_look_end_date=policy.free_look_end_date.isoformat() if policy.free_look_end_date else None,
            policyholder_id=customer.policyholder_id, portal_url=portal_service.PORTAL_BASE_URL,
            tenant_phone=tenant.contact_phone if tenant else None, tenant_email=tenant.contact_email if tenant else None)
        # The policy documents travel with the issuance email: receipt, schedule, certificate, wording, dossier.
        from services.policy_documents import email_attachments
        attachments, left_out = await email_attachments(session, policy, None)
        if attachments:
            names = ", ".join(n for _, n in attachments)
            text += f"\n\nAttached: {names}." + (f" Too large to attach, available in the customer portal: {', '.join(left_out)}." if left_out else "")
            html += (f"<p style='font-size:13px;color:#475569'>Attached to this email: {escape(names)}."
                     + (f" Too large to attach, available in the customer portal: {escape(', '.join(left_out))}." if left_out else "") + "</p>")
        ok = await email_utils.send_email(address, subject, text, html, attachments=attachments)
        event_type = "IssuanceEmailSent"
    if not ok:
        record_event(session, policy, event_type="WelcomeEmailFailed" if job.kind == "WelcomeEmail" else "IssuanceEmailFailed",
                     actor="system", detail={"to": address, "delivered": False, "automatic": True})
        return "Email delivery failed. Check email-provider configuration; delivery will retry."
    if job.kind == "WelcomeEmail":
        row.welcome_sent_at = row.updated_at = datetime.utcnow()
        row.welcome_channel = "Email"
        session.add(row)
    record_event(session, policy, event_type=event_type, actor="system",
                 detail={"to": address, "subject": subject, "channel": "Email", "delivered": True, "automatic": True})
    return None


async def run_delivery_cycle(session_factory, limit=20):
    processed = 0
    for _ in range(limit):
        async with session_factory() as session:
            now = datetime.utcnow()
            job = (await session.exec(select(PolicyDeliveryJob).join(Policy, Policy.id == PolicyDeliveryJob.policy_id).where(
                PolicyDeliveryJob.status.in_(["Pending", "Retry"]), PolicyDeliveryJob.next_attempt_at <= now)
                .order_by(PolicyDeliveryJob.next_attempt_at, PolicyDeliveryJob.created_at)
                .limit(1).with_for_update(of=Policy, skip_locked=True))).first()
            if job is None:
                break
            policy = (await session.exec(select(Policy).where(Policy.id == job.policy_id).with_for_update())).first()
            if policy is None or value(policy.status) not in ONBOARDING_STATUSES:
                job.status, job.last_error = "Skipped", "Policy is no longer in force."
                session.add(job)
                await session.commit()
                continue
            job.attempts += 1
            try:
                # A generation exception must not leave a partially assigned ID / kit.
                async with session.begin_nested():
                    reason = await execute_job(session, job, policy)
            except Exception:
                log.exception("Post-issuance %s failed for %s", job.kind, job.policy_id)
                reason = "Automatic delivery failed; it will retry."
            if reason:
                job.status, job.last_error = "Retry", reason
                job.next_attempt_at = now + timedelta(seconds=min(3600, 30 * 2 ** min(job.attempts, 7)))
            else:
                job.status, job.last_error, job.completed_at = "Completed", None, datetime.utcnow()
            session.add(job)
            await session.commit()
            processed += 1
    return processed


def start_delivery_worker(stop_event, session_factory):
    async def loop():
        while not stop_event.is_set():
            try:
                await run_delivery_cycle(session_factory)
            except Exception:
                log.exception("Post-issuance delivery cycle failed")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=5)
            except asyncio.TimeoutError:
                pass
    return asyncio.create_task(loop())
