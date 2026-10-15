"""How the first premium is split between the proposal and policy issuance — the RS-PAY-001 rule set.

A rule whose `upfront_payment_pct` is, say, 20 asks for 20% of the premium before underwriting (the payment collected on the
proposal) and leaves the other 80% to be paid at policy issuance. No rule set, or no matching rule, means the whole premium is
collected up front, which is how the platform behaved before the split existed. Edited by admins in the Rule Engine.
"""
from typing import Any, Optional
from uuid import UUID

from sqlmodel.ext.asyncio.session import AsyncSession

from rule_evaluator import evaluate_rule_set

PAYMENT_SPLIT_RULE_SET_CODE = "RS-PAY-001"

DEFAULT_MESSAGE = ("You paid {paid_pct}% (PKR {paid}) before underwriting. At policy issuance you pay the remaining {remaining_pct}% "
                   "(PKR {remaining}) plus the loading charged by underwriting, if any.")

PAYMENT_SPLIT_RULE_SET: dict = {
    "code": PAYMENT_SPLIT_RULE_SET_CODE,
    "name": "Initial Premium Payment Split",
    "description": ("How the first premium is shared between the proposal (collected before underwriting) and policy issuance. "
                    "Set 'Upfront payment (%)' on a rule; the rest is collected at issuance. With no matching rule the whole premium is paid up front."),
    "category_code": "PAYMENT", "category_name": "Premium Payment", "sub_code": "INITIAL_PREMIUM_SPLIT", "sub_name": "Initial Premium Split",
    "scope_type": "GLOBAL", "channel_code": None,
    "rules": [
        {
            "code": "PAY-SPLIT-01", "name": "20% before underwriting, 80% at issuance", "priority": 1, "operator": "ALL",
            "conditions": [],
            "action_outcome": "AUTO_APPROVE",
            "outcome_payload": {"upfront_payment_pct": 20.0, "reason": DEFAULT_MESSAGE},
        },
    ],
}


def _money(n: float) -> str:
    return f"{round(n):,}"


async def resolve_split(session: AsyncSession, tenant_id: UUID, *, total: float, insurance_type: Optional[str] = None,
                        product_name: Optional[str] = None, coverage_amount: Optional[float] = None) -> dict[str, Any]:
    """{upfront_pct, upfront_amount, remaining_pct, remaining_amount, total, message_paid, message_remaining, rule_code}"""
    pct, message, rule_code = 100.0, None, None
    try:
        res = await evaluate_rule_set(
            session=session, rule_set_code=PAYMENT_SPLIT_RULE_SET_CODE, tenant_id=tenant_id, actor="Payment split",
            context={"insurance_type": insurance_type, "product_name": product_name, "total_premium": total, "coverage_amount": coverage_amount})
        for imp in res.get("matched_impacts") or []:
            v = imp.get("upfront_payment_pct")
            if v is not None and 0 < float(v) <= 100:
                pct, message, rule_code = float(v), imp.get("reason"), imp.get("rule_code")
                break
    except Exception:
        pct = 100.0   # the rules could not be read: collect everything now, as before
    total = round(float(total), 2)
    upfront = total if pct >= 100 else round(total * pct / 100.0, 2)
    remaining = round(total - upfront, 2)
    paid_pct, rem_pct = round(pct, 2), round(100 - pct, 2)
    fmt = {"paid_pct": f"{paid_pct:g}", "remaining_pct": f"{rem_pct:g}", "paid": _money(upfront), "remaining": _money(remaining), "total": _money(total)}
    text = (message or DEFAULT_MESSAGE)
    try:
        text = text.format(**fmt)
    except (KeyError, IndexError, ValueError):
        pass   # an author's own braces: show the text as written
    upfront_text = (f"Pay {fmt['paid_pct']}% (PKR {fmt['paid']}) now to proceed to underwriting. At policy issuance you pay the remaining "
                    f"{fmt['remaining_pct']}% (PKR {fmt['remaining']}) plus any loading charged by underwriting. "
                    f"Loading is not part of this payment.") if remaining > 0 else None
    return {"message_upfront": upfront_text, "upfront_pct": paid_pct, "upfront_amount": upfront, "remaining_pct": rem_pct, "remaining_amount": remaining, "total": total,
            "message_remaining": text if remaining > 0 else None, "rule_code": rule_code}
