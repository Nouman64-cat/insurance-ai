"""Agent commission rates — the RS-COM-002 rule set.

The matched rule's `commission_pct` is paid on the first premium after policy issuance. Later premiums earn only when the
rule is `commission_recurring`, at `recurring_commission_pct` (or `commission_pct` when unset), and only for policy years up
to `recurring_years` (no limit when unset). No rule set, or no matching rule, is a configuration exception: no rate is
guessed. Edited by admins in the Rule Engine.
"""
from decimal import Decimal
from typing import Any, Optional

from rule_evaluator import evaluate_rule_set

AGENT_COMMISSION_RULE_SET_CODE = "RS-COM-002"

AGENT_COMMISSION_RULE_SET: dict = {
    "code": AGENT_COMMISSION_RULE_SET_CODE,
    "name": "Agent Commission",
    "description": ("Commission paid to the producer on an individual policy's premiums. 'Commission rate (%)' is paid on the "
                    "first premium after issuance. Tick 'Recurring' to also pay on later premiums, at 'Recurring rate (%)' if set, "
                    "for up to 'Recurring for (policy years)'. With no matching rule the premium is held as a commission exception."),
    "category_code": "COMMISSION", "category_name": "Agent Commission",
    "sub_code": "AGENT_COMMISSION", "sub_name": "Agent Commission Rates",
    "scope_type": "GLOBAL", "channel_code": None,
    "rules": [
        {
            "code": "COM-AGT-IND", "name": "Individual policy — first premium", "priority": 1, "operator": "ALL",
            "conditions": [{"field": "category", "operator": "eq", "value": "Individual"}],
            "action_outcome": "AUTO_APPROVE",
            "outcome_payload": {
                "terminal": True, "commission_pct": 35.0, "withholding_tax_pct": 10.0, "commission_recurring": False,
                "reason": "35% of the first premium after issuance (SECP Rule 24 first-year maximum). Not recurring.",
            },
        },
    ],
}


def _value(v: Any) -> Any:
    return v.value if hasattr(v, "value") else v


def commission_context(policy, source, *, premium: Decimal, policy_year: int, installment: int) -> dict[str, Any]:
    """Fields a commission rule can test. JSON-safe: it is stored in the rule evaluation log."""
    channel = _value(source.source_type)
    if channel == "BANCASSURANCE" and source.partner_name:
        channel = "BANCASSURANCE_" + "".join(ch for ch in source.partner_name.upper() if ch.isalnum())
    return {
        "category": "Individual",
        "insurance_type": _value(policy.insurance_type),
        "product_name": policy.product_name,
        "coverage_amount": policy.coverage_amount,
        "term_years": policy.term_years,
        "policy_year": policy_year,
        "premium_type": "FIRST_YEAR" if policy_year == 1 else "RENEWAL",
        "installment_number": installment,
        "is_first_premium": installment == 1,
        "premium_amount": float(premium),
        "source_type": _value(source.source_type),
        "source_code": source.code,
        "channel_code": channel,
    }


async def commission_rate(session, tenant_id, context: dict[str, Any]) -> dict[str, Optional[Any]]:
    """{rate, rule_code, rule_version, reason, recurring, withholding_tax_pct}. rate is None when the matched rule
    pays nothing on this premium (not recurring, or past its recurring years). Raises ValueError on missing configuration."""
    result = await evaluate_rule_set(session, AGENT_COMMISSION_RULE_SET_CODE, context, tenant_id=tenant_id,
                                     actor="Agent commission", commit=False)
    if result["status"] in ("RULE_SET_NOT_FOUND", "NO_ACTIVE_VERSION"):
        raise ValueError(result["reasons"][0])
    rule = next((i for i in result.get("matched_impacts") or [] if i.get("commission_pct") is not None), None)
    if rule is None:
        raise ValueError(f"No {AGENT_COMMISSION_RULE_SET_CODE} commission rule matches this premium")
    decision = {"rule_code": rule["rule_code"], "rule_version": result.get("version_number"), "reason": rule.get("reason"),
                "recurring": rule["commission_recurring"], "withholding_tax_pct": rule.get("withholding_tax_pct")}
    if context["is_first_premium"]:
        return {**decision, "rate": Decimal(str(rule["commission_pct"]))}
    if not rule["commission_recurring"]:
        return {**decision, "rate": None, "reason": f"Rule {rule['rule_code']} pays commission on the first premium only"}
    years = rule.get("recurring_years")
    if years and context["policy_year"] > int(years):
        return {**decision, "rate": None, "reason": f"Rule {rule['rule_code']} recurs for {int(years)} policy year(s) only"}
    pct = rule.get("recurring_commission_pct")
    return {**decision, "rate": Decimal(str(rule["commission_pct"] if pct is None else pct))}
