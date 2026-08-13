"""
Rule Evaluator Engine

Evaluates versioned decision tables and business rules against input contexts.
Supports 9 core taxonomy domains, operator evaluations, and audit logging.
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import (
    BusinessRule,
    RuleEvaluationLog,
    RuleSet,
    RuleVersion,
    RuleVersionStatusEnum,
)

logger = logging.getLogger("rule_evaluator")


def _evaluate_single_condition(field_value: Any, operator: str, target_value: Any) -> bool:
    """Evaluates one condition condition ({field, operator, value}) against actual field_value."""
    if field_value is None:
        # Special null checks
        if operator in ("is_null", "empty"):
            return True
        if operator in ("is_not_null", "not_empty"):
            return False
        return False

    op = str(operator).lower().strip()

    try:
        if op in ("eq", "==", "equals"):
            if isinstance(field_value, str) and isinstance(target_value, str):
                return field_value.lower().strip() == target_value.lower().strip()
            return str(field_value) == str(target_value)

        elif op in ("ne", "!=", "not_equals"):
            if isinstance(field_value, str) and isinstance(target_value, str):
                return field_value.lower().strip() != target_value.lower().strip()
            return str(field_value) != str(target_value)

        elif op in ("gt", ">"):
            return float(field_value) > float(target_value)

        elif op in ("gte", ">="):
            return float(field_value) >= float(target_value)

        elif op in ("lt", "<"):
            return float(field_value) < float(target_value)

        elif op in ("lte", "<="):
            return float(field_value) <= float(target_value)

        elif op in ("in", "is_one_of"):
            if isinstance(target_value, list):
                str_items = [str(x).lower().strip() for x in target_value]
                return str(field_value).lower().strip() in str_items
            return str(field_value).lower() in str(target_value).lower()

        elif op in ("not_in", "is_not_one_of"):
            if isinstance(target_value, list):
                str_items = [str(x).lower().strip() for x in target_value]
                return str(field_value).lower().strip() not in str_items
            return str(field_value).lower() not in str(target_value).lower()

        elif op in ("contains", "has"):
            return str(target_value).lower() in str(field_value).lower()

        elif op in ("between", "range"):
            if isinstance(target_value, (list, tuple)) and len(target_value) == 2:
                val = float(field_value)
                return float(target_value[0]) <= val <= float(target_value[1])
            return False

        elif op in ("boolean", "is"):
            def _to_bool(v):
                if isinstance(v, bool):
                    return v
                return str(v).lower() in ("true", "1", "yes")
            return _to_bool(field_value) == _to_bool(target_value)

    except Exception as e:
        logger.warning(f"Error evaluating condition ({field_value} {operator} {target_value}): {e}")
        return False

    return False


async def evaluate_rule_set(
    session: AsyncSession,
    rule_set_code: str,
    context: Dict[str, Any],
    tenant_id: Optional[UUID] = None,
    case_id: Optional[str] = None,
    actor: Optional[str] = "System",
) -> Dict[str, Any]:
    """
    Evaluates an active RuleSet version against the provided context payload.

    Returns:
        {
            "rule_set_code": str,
            "version_no": int,
            "domain": str,
            "evaluated_at": str,
            "triggered_rules": [...],
            "final_outcome": str,
            "outcome_payload": {...},
            "reasons": [...],
            "status": "SUCCESS" | "NO_MATCH" | "RULE_SET_NOT_FOUND"
        }
    """
    # 1. Fetch RuleSet
    query = select(RuleSet).where(RuleSet.code == rule_set_code)
    if tenant_id:
        # Tenant specific or global fallback
        query = select(RuleSet).where(
            (RuleSet.code == rule_set_code) & ((RuleSet.tenant_id == tenant_id) | (RuleSet.tenant_id == None))
        )
    
    result = await session.exec(query)
    rule_set = result.first()

    if not rule_set or not rule_set.is_active:
        return {
            "rule_set_code": rule_set_code,
            "status": "RULE_SET_NOT_FOUND",
            "final_outcome": "NO_EVALUATION",
            "outcome_payload": {},
            "reasons": [f"Rule set '{rule_set_code}' not found or inactive."],
            "triggered_rules": [],
            "evaluated_at": datetime.utcnow().isoformat(),
        }

    # 2. Fetch Active RuleVersion
    ver_query = (
        select(RuleVersion)
        .where(RuleVersion.rule_set_id == rule_set.id)
        .where(RuleVersion.status == RuleVersionStatusEnum.ACTIVE)
        .order_by(RuleVersion.version_no.desc())
    )
    ver_result = await session.exec(ver_query)
    active_version = ver_result.first()

    if not active_version:
        return {
            "rule_set_code": rule_set_code,
            "domain": rule_set.domain,
            "status": "NO_ACTIVE_VERSION",
            "final_outcome": "NO_EVALUATION",
            "outcome_payload": {},
            "reasons": [f"Rule set '{rule_set_code}' has no ACTIVE version deployed."],
            "triggered_rules": [],
            "evaluated_at": datetime.utcnow().isoformat(),
        }

    # 3. Fetch Enabled BusinessRules for this Version
    rules_query = (
        select(BusinessRule)
        .where(BusinessRule.rule_version_id == active_version.id)
        .where(BusinessRule.is_enabled == True)
        .order_by(BusinessRule.priority.asc())
    )
    rules_result = await session.exec(rules_query)
    rules: List[BusinessRule] = list(rules_result.all())

    triggered_rules = []
    reasons = []
    combined_payload: Dict[str, Any] = {}
    primary_outcome = "NO_MATCH"

    # 4. Evaluate each rule in priority order
    for rule in rules:
        conditions: List[Dict[str, Any]] = rule.conditions or []
        operator = (rule.condition_operator or "ALL").upper()

        if not conditions:
            # Empty condition array matches unconditionally
            matched = True
        else:
            cond_results = []
            for cond in conditions:
                field = cond.get("field")
                op = cond.get("operator", "eq")
                target = cond.get("value")
                actual_val = context.get(field)
                cond_results.append(_evaluate_single_condition(actual_val, op, target))

            if operator == "ALL":
                matched = all(cond_results)
            else: # ANY
                matched = any(cond_results)

        if matched:
            primary_outcome = rule.action_outcome
            combined_payload.update(rule.outcome_payload or {})
            rule_reason = rule.outcome_payload.get("reason") or f"Rule '{rule.name}' triggered ({rule.action_outcome})"
            reasons.append(rule_reason)

            triggered_rules.append({
                "rule_id": str(rule.id),
                "name": rule.name,
                "priority": rule.priority,
                "action_outcome": rule.action_outcome,
                "outcome_payload": rule.outcome_payload,
            })

            # If rule specifies terminal execution, break early
            if rule.outcome_payload.get("terminal") is True:
                break

    output_result = {
        "rule_set_code": rule_set_code,
        "version_no": active_version.version_no,
        "domain": rule_set.domain,
        "status": "SUCCESS" if triggered_rules else "NO_MATCH",
        "final_outcome": primary_outcome,
        "outcome_payload": combined_payload,
        "reasons": reasons,
        "triggered_rules": triggered_rules,
        "evaluated_at": datetime.utcnow().isoformat(),
    }

    # 5. Log evaluation for audit compliance
    try:
        audit_log = RuleEvaluationLog(
            tenant_id=tenant_id,
            rule_set_code=rule_set_code,
            rule_version_no=active_version.version_no,
            case_id=case_id,
            actor=actor,
            input_context=context,
            outcome=output_result,
            reasons=reasons,
            evaluated_at=datetime.utcnow(),
        )
        session.add(audit_log)
        await session.commit()
    except Exception as err:
        logger.error(f"Failed to record RuleEvaluationLog: {err}")

    return output_result
