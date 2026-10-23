"""Placeholders in a golden case, filled in when it runs (never in the stored case):

    $customer.<ref>.id            the id the sandbox seeded for that fixture customer
    $plan.<CODE>.id               the id of that plan in the acting user's tenant
    $policy.<ref>.id / .policy_number   the seeded policy's id / number
    {{date:today-4d}}  {{date:today+0d}}   a date relative to the day of the run (ISO, YYYY-MM-DD)

Substitution is applied to messages, payloads and expected values alike, so a case that says "the customer id is $customer.x.id" is
judged against the real id of THIS run. A placeholder that cannot be resolved raises PlaceholderError: the case cannot be judged,
which is reported as an infrastructure error, never as a pass or a fail of the system.
"""
from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any, Dict, Optional

_REF = re.compile(r"\$(customer|plan|policy|claim)\.([A-Za-z0-9_-]+)\.(id|policy_number)")
_DATE = re.compile(r"\{\{date:today([+-]\d+)d\}\}")


class PlaceholderError(Exception):
    """A placeholder names something the sandbox did not seed."""


def substitute(value: Any, ids: Dict[str, Dict[str, Any]], *, tenant_ref: Optional[str] = None, today: Optional[date] = None) -> Any:
    """A copy of `value` (any JSON structure) with every placeholder replaced. `ids` is the seeding report's mapping:
    {"customer": {ref: id}, "plan": {"<tenant>/<CODE>": id}, "policy": {ref: id}, "policy_number": {ref: number}, "claim": {ref: id}}."""
    today = today or date.today()

    def one(text: str) -> Any:
        def ref(m: "re.Match[str]") -> str:
            kind, name, field = m.groups()
            if kind == "plan":
                table, key = ids.get("plan", {}), f"{tenant_ref}/{name}" if tenant_ref else name
                if key not in table and name in table:
                    key = name
            elif field == "policy_number":
                table, key = ids.get("policy_number", {}), name
            else:
                table, key = ids.get(kind, {}), name
            if key not in table:
                raise PlaceholderError(f"${kind}.{name}.{field}: nothing named {key!r} was seeded")
            return str(table[key])
        text = _REF.sub(ref, text)
        return _DATE.sub(lambda m: (today + timedelta(days=int(m.group(1)))).isoformat(), text)

    if isinstance(value, str):
        return one(value)
    if isinstance(value, list):
        return [substitute(v, ids, tenant_ref=tenant_ref, today=today) for v in value]
    if isinstance(value, dict):
        return {k: substitute(v, ids, tenant_ref=tenant_ref, today=today) for k, v in value.items()}
    return value


def has_placeholders(value: Any) -> bool:
    if isinstance(value, str):
        return bool(_REF.search(value) or _DATE.search(value))
    if isinstance(value, list):
        return any(has_placeholders(v) for v in value)
    if isinstance(value, dict):
        return any(has_placeholders(v) for v in value.values())
    return False
