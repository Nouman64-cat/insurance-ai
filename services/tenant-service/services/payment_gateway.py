"""
Mock payment gateway — realistic Pakistan first-premium collection stub.

Real life insurance cover legally begins only when the first premium is
*realized* (settled), not when the policy is drafted. This module models that
gap without a live PSP integration:

  * ``initiate_payment()`` creates a PaymentIntent with a channel-specific
    reference (e.g. "JC-1A2B3C4D" for JazzCash) in an INITIATED state.
  * ``confirm_payment()`` simulates the settlement webhook the PSP would call,
    returning a REALIZED intent.

Swapping in a real JazzCash / Easypaisa / 1LINK card integration means
replacing the two functions below — the router contract stays identical.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional


class PaymentMethodEnum(str, Enum):
    JAZZCASH = "JazzCash"
    EASYPAISA = "Easypaisa"
    CARD = "Card"                 # 1LINK / debit-credit card
    BANK_TRANSFER = "BankTransfer"  # IBFT / raast


class PaymentStatusEnum(str, Enum):
    INITIATED = "Initiated"       # intent created, awaiting settlement
    REALIZED = "Realized"         # funds settled — safe to bind cover
    FAILED = "Failed"
    REFUNDED = "Refunded"         # a previously-realized payment reversed to the payer


# Reference prefix per channel — mirrors the real PSP short-code conventions.
_METHOD_PREFIX: dict[PaymentMethodEnum, str] = {
    PaymentMethodEnum.JAZZCASH: "JC",
    PaymentMethodEnum.EASYPAISA: "EP",
    PaymentMethodEnum.CARD: "CARD",
    PaymentMethodEnum.BANK_TRANSFER: "IBFT",
}

# In a real gateway settlement is asynchronous; the webhook lands seconds to
# hours later. We expose the simulated lag so the UI/tests can reason about it,
# but confirm_payment() settles immediately (auto-realize) by default.
REALIZATION_DELAY_SECONDS: int = int(os.environ.get("MOCK_PAYMENT_DELAY_SECONDS", "0"))


@dataclass
class PaymentIntent:
    reference: str
    method: PaymentMethodEnum
    amount: float                     # PKR
    status: PaymentStatusEnum = PaymentStatusEnum.INITIATED
    initiated_at: datetime = field(default_factory=datetime.utcnow)
    realized_at: Optional[datetime] = None
    gateway: str = "mock-psp"

    def to_dict(self) -> dict:
        return {
            "reference": self.reference,
            "method": self.method.value,
            "amount": round(self.amount, 2),
            "status": self.status.value,
            "gateway": self.gateway,
            "initiated_at": self.initiated_at.isoformat(),
            "realized_at": self.realized_at.isoformat() if self.realized_at else None,
        }


def _coerce_method(method) -> PaymentMethodEnum:
    if isinstance(method, PaymentMethodEnum):
        return method
    if not method:
        return PaymentMethodEnum.JAZZCASH
    raw = method.value if hasattr(method, "value") else str(method)
    try:
        return PaymentMethodEnum(raw)
    except ValueError:
        # Accept case-insensitive names too ("jazzcash", "CARD", …)
        for m in PaymentMethodEnum:
            if m.value.lower() == raw.lower() or m.name.lower() == raw.lower():
                return m
        raise ValueError(f"Unsupported payment method: {method}")


def generate_reference(method: PaymentMethodEnum) -> str:
    prefix = _METHOD_PREFIX[method]
    return f"{prefix}-{secrets.token_hex(4).upper()}"


def available_methods() -> list[dict]:
    """Channels an agent/customer can pick at the payment step."""
    return [{"code": m.value, "label": m.value} for m in PaymentMethodEnum]


def initiate_payment(amount: float, method=None, reference: Optional[str] = None) -> PaymentIntent:
    """Create a payment intent for the first premium. Idempotent on `reference`
    when the caller supplies a previously-issued one (retry / resume)."""
    m = _coerce_method(method)
    return PaymentIntent(
        reference=reference or generate_reference(m),
        method=m,
        amount=float(amount),
    )


def confirm_payment(
    reference: str,
    amount: float,
    method=None,
    *,
    realize: bool = True,
) -> PaymentIntent:
    """
    Simulate the settlement webhook. Returns a REALIZED intent (the mock always
    succeeds unless ``realize=False``, which models a failed/abandoned payment).
    """
    m = _coerce_method(method)
    intent = PaymentIntent(reference=reference, method=m, amount=float(amount))
    if realize:
        intent.status = PaymentStatusEnum.REALIZED
        intent.realized_at = datetime.utcnow()
    else:
        intent.status = PaymentStatusEnum.FAILED
    return intent


def refund_payment(amount: float, method=None) -> PaymentIntent:
    """Simulate a reversal of a settled payment back to the original payer.

    Used by the free-look full-refund exit. The mock always succeeds and settles
    immediately; a real PSP would return a pending refund the webhook later
    confirms. The returned intent carries a fresh RFND-prefixed reference so it is
    traceable independently of the original charge (the router links it to the
    original payment in the PolicyEvent audit detail).
    """
    m = _coerce_method(method)
    intent = PaymentIntent(
        reference=f"RFND-{secrets.token_hex(4).upper()}",
        method=m,
        amount=float(amount),
    )
    intent.status = PaymentStatusEnum.REFUNDED
    intent.realized_at = datetime.utcnow()
    return intent
