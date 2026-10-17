"""Calls from tenant-service to the Customer Management service (services/customer-management).

Customer Management is the AUTHORITY for customer sign-in once an account exists there. tenant-service keeps minting
the temporary credentials for the ops "Provision portal access" step (so the staff workflow does not change) and hands
the account to Customer Management over a signed internal call. Only the bcrypt HASH travels — the plaintext temporary
password is shown to ops once and is never sent between services.

Provisioning is idempotent and never silently resets a customer: if the customer has already changed their password,
Customer Management answers "already_active" and leaves the credentials alone unless the caller explicitly asks for a
staff reset.

Signed with TENANT_TO_CM_KEY (caller "tenant-service"). Off when CUSTOMER_MANAGEMENT_URL / the key are unset, which
keeps the original single-service behaviour.
"""
import json
import logging
import os
from typing import Any, Optional

import httpx

from shared.security.service_auth import sign

log = logging.getLogger(__name__)


class CustomerManagementUnavailable(Exception):
    pass


def enabled() -> bool:
    mode = os.environ.get("PORTAL_PROVISIONING_MODE", "dual").lower()
    return mode != "legacy" and bool(os.environ.get("TENANT_TO_CM_KEY")) and bool(_base())


def _base() -> str:
    return os.environ.get("CUSTOMER_MANAGEMENT_URL", "http://customer-management:8009").rstrip("/")


async def _signed(method: str, path: str, payload: Optional[dict] = None) -> tuple[int, Any]:
    body = json.dumps(payload, default=str).encode() if payload is not None else b""
    headers = sign(os.environ["TENANT_TO_CM_KEY"], method, path, body, caller="tenant-service")
    if payload is not None:
        headers["Content-Type"] = "application/json"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=3.0)) as client:
            resp = await client.request(method, _base() + path, content=body, headers=headers)
    except httpx.HTTPError as exc:
        raise CustomerManagementUnavailable(str(exc)) from exc
    try:
        data = resp.json()
    except ValueError:
        data = None
    return resp.status_code, data


async def ensure_account(*, tenant_id, tenant_code: str, customer_id, username: str, password_hash: str, display_name: str,
                         credential_expires_at, reset: bool, reason: Optional[str] = None) -> dict:
    status, data = await _signed("PUT", "/internal/v1/accounts", {
        "tenant_id": str(tenant_id), "tenant_code": tenant_code, "customer_id": str(customer_id), "username": username,
        "password_hash": password_hash, "display_name": display_name,
        "credential_expires_at": credential_expires_at.isoformat() if credential_expires_at else None,
        "mode": "reset" if reset else "ensure", "reason": reason,
    })
    if status != 200 or not isinstance(data, dict):
        log.error("customer-management provisioning failed: HTTP %s", status)
        raise CustomerManagementUnavailable(f"HTTP {status}")
    return data


async def account_summary(tenant_id, customer_id) -> Optional[dict]:
    status, data = await _signed("GET", f"/internal/v1/accounts/by-customer/{customer_id}?tenant_id={tenant_id}")
    return data if status == 200 and isinstance(data, dict) else None
