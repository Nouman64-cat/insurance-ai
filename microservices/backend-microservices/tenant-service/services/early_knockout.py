"""Early knockout — the RS-ELG-002 rule set applied at lead capture / plan selection, before any E-Application,
medical or underwriting step. Shared by the rules endpoint and the customer/policy routes."""
from datetime import date
from typing import Any, Dict, Optional
from uuid import UUID

from sqlmodel.ext.asyncio.session import AsyncSession

from rule_evaluator import evaluate_rule_set
from services.underwriting_limits import age_from_dob

KNOCKOUT_RULE_SET_CODE = "RS-ELG-002"


async def early_check(
    session: AsyncSession, tenant_id: UUID, *, occupation: Optional[str] = None, dob: Optional[date] = None,
    age: Optional[int] = None, proposal_id: Optional[str] = None, actor: str = "Early Check",
) -> Dict[str, Any]:
    """{"decision": "DECLINE" | "REFER" | "PROCEED", "reasons": [...], "rule_codes": [...]}.
    A missing rule set or no matching rule is PROCEED."""
    if age is None and dob is not None:
        age = age_from_dob(dob)
    result = await evaluate_rule_set(
        session=session, rule_set_code=KNOCKOUT_RULE_SET_CODE,
        context={"occupation": occupation, "age": age, "entry_age": age},
        tenant_id=tenant_id, proposal_id=proposal_id, actor=actor,
    )
    impacts = result.get("matched_impacts") or []
    declines = [i for i in impacts if i["impact_type"] == "DECLINE"]
    refers = [i for i in impacts if i["impact_type"] == "REFER_TO_UNDERWRITER"]
    chosen = declines or refers
    return {
        "decision": "DECLINE" if declines else "REFER" if refers else "PROCEED",
        "reasons": [i["reason"] or i["name"] for i in chosen],
        "rule_codes": [i["rule_code"] for i in chosen],
    }
