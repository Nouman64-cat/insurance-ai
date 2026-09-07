"""
Outbound email — used to send generated login credentials to tenant admins
(created by a SuperAdmin) and to users (created by a tenant Admin).

Sends over the AWS SES SMTP interface using stdlib smtplib, so no extra
dependency is required. Any failure is logged and swallowed: a mail outage
must never block account creation, since the credentials are also returned
in the API response body.
"""

import asyncio
import logging
import os
import smtplib
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from services.email_templates import credentials_email

log = logging.getLogger(__name__)

EMAIL_PROVIDER = os.environ.get("EMAIL_PROVIDER", "")
# Where the credentials email's "Sign in" button points.
APP_LOGIN_URL = os.environ.get("APP_LOGIN_URL", "http://localhost:3000/login")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
SES_FROM_EMAIL = os.environ.get("AWS_SES_FROM_EMAIL", "")
SES_USERNAME = os.environ.get("AWS_SES_USERNAME", "")
SES_PASSWORD = os.environ.get("AWS_SES_PASSWORD", "")
SES_SMTP_HOST = f"email-smtp.{AWS_REGION}.amazonaws.com"
SES_SMTP_PORT = 587


def _send_sync(
    to_email: str,
    subject: str,
    text_body: str,
    html_body: str | None = None,
    attachments: list[str] | None = None
) -> None:
    msg = MIMEMultipart("mixed")
    msg["Subject"] = subject
    msg["From"] = SES_FROM_EMAIL
    msg["To"] = to_email

    body_msg = MIMEMultipart("alternative")
    body_msg.attach(MIMEText(text_body, "plain"))
    if html_body:
        body_msg.attach(MIMEText(html_body, "html"))
    msg.attach(body_msg)

    if attachments:
        for filepath in attachments:
            if not os.path.isfile(filepath):
                continue
            with open(filepath, "rb") as f:
                part = MIMEApplication(f.read(), Name=os.path.basename(filepath))
            part["Content-Disposition"] = f'attachment; filename="{os.path.basename(filepath)}"'
            msg.attach(part)

    with smtplib.SMTP(SES_SMTP_HOST, SES_SMTP_PORT, timeout=15) as server:
        server.starttls()
        server.login(SES_USERNAME, SES_PASSWORD)
        server.sendmail(SES_FROM_EMAIL, [to_email], msg.as_string())


async def send_email(
    to_email: str,
    subject: str,
    text_body: str,
    html_body: str | None = None,
    attachments: list[str] | None = None
) -> bool:
    """Best-effort send. Returns True on success, False otherwise — never raises."""
    if EMAIL_PROVIDER != "ses" or not (SES_FROM_EMAIL and SES_USERNAME and SES_PASSWORD):
        log.warning("Email not sent to %s — EMAIL_PROVIDER/SES credentials not configured.", to_email)
        return False
    try:
        await asyncio.to_thread(_send_sync, to_email, subject, text_body, html_body, attachments)
        log.info("Email sent to %s: %s (with %d attachments)", to_email, subject, len(attachments or []))
        return True
    except Exception:
        log.exception("Failed to send email to %s", to_email)
        return False


async def send_credentials_email(
    *,
    to_email: str,
    full_name: str,
    username: str,
    password: str,
    role_label: str,
    tenant_name: str | None = None,
) -> bool:
    """Emails a newly created account's login credentials."""
    subject, text_body, html_body = credentials_email(
        full_name=full_name,
        email=to_email,
        username=username,
        password=password,
        role_label=role_label,
        tenant_name=tenant_name,
        login_url=APP_LOGIN_URL,
    )
    return await send_email(to_email, subject, text_body, html_body)
