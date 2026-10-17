"""
Customer self-service portal — MOCK provisioning (Stage B onboarding, step 2).

There is no separate customer-facing app in this prototype; like the payment
gateway, the portal is simulated. This module mints the credentials the ops team
hands to a newly-onboarded policyholder:

  • a username (their policyholder ID, falling back to email / a generated code),
  • a one-time temporary password (returned to the caller ONCE, never stored),
  • a bcrypt hash of that password (the only thing persisted),
  • an invite token + expiry for a "set your password" link,
  • a mock portal URL.

A real integration would swap this for the actual IdP / portal registration call;
the router and DB shape would not change.
"""

from __future__ import annotations

import os
import secrets
import string
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

from passlib.context import CryptContext

_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

PORTAL_BASE_URL = os.environ.get("CUSTOMER_PORTAL_URL", "https://portal.insurance-ai.example/login")
INVITE_VALID_DAYS = int(os.environ.get("PORTAL_INVITE_VALID_DAYS", "7"))

_PW_ALPHABET = string.ascii_letters + string.digits


@dataclass
class PortalCredentials:
    username: str
    temp_password: str          # plaintext — surfaced ONCE to the caller, never stored
    password_hash: str
    invite_token: str
    invite_expires_at: datetime
    portal_url: str

    def public_dict(self) -> dict:
        """What the API returns once, right after provisioning/reset."""
        return {
            "username": self.username,
            "temp_password": self.temp_password,
            "portal_url": self.portal_url,
            "invite_expires_at": self.invite_expires_at.isoformat(),
        }


def credentials_block(creds: Optional[dict]) -> tuple[str, str]:
    """Plain-text and HTML text for the welcome email: how to sign in to the customer portal. `creds` is what the
    provisioning call returned; with no temporary password (the customer already chose their own) the block says so."""
    import html as _h
    if not creds:
        return "", ""
    url = creds.get("portal_url") or PORTAL_BASE_URL
    user = creds.get("username") or ""
    pwd = creds.get("temp_password")
    if pwd:
        text = (f"\n\nCustomer portal sign-in\n  Portal:   {url}\n  Username: {user}\n  Temporary password: {pwd}\n"
                "You will be asked to choose a new password the first time you sign in. Please do not share these details.\n")
        html = (
            '<div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:6px;padding:16px;margin:20px 0">'
            '<p style="margin:0 0 8px;font-size:13px;color:#64748b;text-transform:uppercase;font-weight:bold;letter-spacing:1px">'
            'Customer portal sign-in</p>'
            f'<p style="margin:4px 0"><strong>Portal:</strong> <a href="{_h.escape(url, quote=True)}">{_h.escape(url)}</a></p>'
            f'<p style="margin:4px 0"><strong>Username:</strong> <span style="font-family:monospace">{_h.escape(user)}</span></p>'
            f'<p style="margin:4px 0"><strong>Temporary password:</strong> <span style="font-family:monospace">{_h.escape(pwd)}</span></p>'
            '<p style="margin:10px 0 0;font-size:12px;color:#64748b">You will be asked to choose a new password the first time '
            'you sign in. Please do not share these details.</p></div>')
        return text, html
    text = (f"\n\nCustomer portal: {url}\nUsername: {user}\nSign in with the password you chose earlier.\n")
    html = (f'<p>Customer portal: <a href="{_h.escape(url, quote=True)}">{_h.escape(url)}</a><br>'
            f'Username: <span style="font-family:monospace">{_h.escape(user)}</span><br>Sign in with the password you chose earlier.</p>')
    return text, html


def hash_password(raw: str) -> str:
    return _pwd.hash(raw)


def generate_temp_password(length: int = 10) -> str:
    """A readable one-time password the ops user can dictate over the phone. In demo mode (ENV_VAR=demo) it is the fixed 12345678, the
    same as every other generated credential (provisioning.generate_password), so demo logins are easy to hand over."""
    from services.env_mode import is_demo
    if is_demo():
        return "12345678"
    return "".join(secrets.choice(_PW_ALPHABET) for _ in range(length))


def generate_username(policyholder_id: Optional[str], email: Optional[str], customer_id: str) -> str:
    if policyholder_id:
        return policyholder_id
    if email:
        return email
    return f"user-{customer_id[:8]}"


def provision(policyholder_id: Optional[str], email: Optional[str], customer_id: str) -> PortalCredentials:
    """Mint a fresh set of portal credentials (new account or password reset)."""
    temp = generate_temp_password()
    return PortalCredentials(
        username=generate_username(policyholder_id, email, customer_id),
        temp_password=temp,
        password_hash=hash_password(temp),
        invite_token=secrets.token_urlsafe(24),
        invite_expires_at=datetime.utcnow() + timedelta(days=INVITE_VALID_DAYS),
        portal_url=PORTAL_BASE_URL,
    )
