"""Internal state -> customer-facing keys. The portal turns each key into English/Urdu wording."""
from typing import Optional

POLICY_STATUS_KEYS = {
    "Approved": "pending_issuance", "AcceptedWithLoadings": "pending_issuance", "PendingPayment": "pending_issuance",
    "Issued": "issued", "Active": "active", "GracePeriod": "grace_period", "Lapsed": "lapsed", "Cancelled": "cancelled",
    "Matured": "matured", "Surrendered": "surrendered", "Expired": "expired",
}


def policy_status_key(status: str, reinstated: bool = False) -> str:
    if status == "Active" and reinstated:
        return "reinstated"
    return POLICY_STATUS_KEYS.get(status, "unknown")


def decorate_policy(p: dict) -> dict:
    p["status_key"] = policy_status_key(p.get("status", ""), bool(p.get("reinstated")))
    return p
