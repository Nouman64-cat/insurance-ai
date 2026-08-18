"""
Rule Evaluator Engine (v2.1)

Evaluates the 6-tier hierarchy (Category -> SubCategory -> EligibilityProfile
-> RuleSet -> RuleVersion -> ActualRule -> RuleCriteria) against input
contexts, with TSAR (Total Sum At Risk) accumulation, grouped boolean logic,
cross-field comparisons, and typed actuarial impact accumulation.

Pipeline (see Business Rule Engine Architecture Specification v2.1 section 3):
  1. ContextDerivationService — derive TSAR/HLV/channel context for a customer.
  2. Hierarchy scope match — evaluate_scope() resolves the EligibilityProfile
     and every RuleSet in scope (pinned to it, or GLOBAL).
  3. Active version lookup.
  4. Rule filtering & sort by priority.
  5. Grouped criteria evaluation (OR across group_id, AND within a group).
  6. Actuarial accumulation via ImpactAccumulator, with terminal short-circuit.
  7. Structured audit write to rule_evaluation_logs.
  8. Return the structured decision payload.
"""

import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from services.underwriting_limits import age_from_dob, hlv_limit
from services.insurance_history import list_internal_policies
from shared.models.core import (
    ActualRule,
    Customer,
    EligibilityProfile,
    RuleCriteria,
    RuleEvaluationLog,
    RuleSet,
    RuleVersion,
    RuleVersionStatusEnum,
    ScopeTypeEnum,
    SubCategory,
)

logger = logging.getLogger("rule_evaluator")


# ─────────────────────────────────────────────────────────────────────────────
# Step 1 — TSAR/HLV/channel context derivation
# ─────────────────────────────────────────────────────────────────────────────

class ContextDerivationService:
    """Derives customer/policy-shaped context fields so callers only need to
    pass what they actually know (customer_id or cnic, proposed_sum_assured).
    Wraps services.underwriting_limits + services.insurance_history's
    list_internal_policies() rather than re-querying/re-deriving HLV math."""

    def __init__(self, session: AsyncSession, tenant_id: UUID):
        self.session = session
        self.tenant_id = tenant_id

    async def derive(
        self,
        *,
        customer_id: Optional[UUID] = None,
        cnic: Optional[str] = None,
        proposed_sum_assured: float = 0.0,
        exclude_policy_id: Optional[UUID] = None,
        extra_context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        customer: Optional[Customer] = None
        if customer_id:
            customer = await self.session.get(Customer, customer_id)
        elif cnic:
            result = await self.session.exec(
                select(Customer).where(Customer.tenant_id == self.tenant_id, Customer.cnic == cnic)
            )
            customer = result.first()

        derived: Dict[str, Any] = {"proposed_sum_assured": proposed_sum_assured}

        if customer:
            age = age_from_dob(customer.dob)
            internal = await list_internal_policies(
                self.session, self.tenant_id, customer.id, exclude_policy_id
            )
            internal_inforce = sum(p["sum_assured"] for p in internal if p["bucket"] == "InForce")
            internal_pipeline = sum(p["sum_assured"] for p in internal if p["bucket"] == "Pipeline")
            tsar_accumulated = proposed_sum_assured + internal_inforce + internal_pipeline
            hlv_cap = hlv_limit(customer.declared_income, age)

            channel_code = await self._channel_code(customer)

            derived.update({
                "customer_id": str(customer.id),
                "customer_cnic": customer.cnic,
                "entry_age": age,
                "age": age,
                "gender": customer.gender.value if customer.gender else None,
                "is_smoker": customer.is_smoker,
                "bmi": _bmi(customer.height_cm, customer.weight_kg),
                "declared_income": customer.declared_income,
                "internal_inforce_sum_assured": internal_inforce,
                "internal_pipeline_sum_assured": internal_pipeline,
                "tsar_accumulated": tsar_accumulated,
                "total_sum_at_risk": tsar_accumulated,
                "hlv_cap": hlv_cap,
                "hlv_ratio": round(tsar_accumulated / hlv_cap, 2) if hlv_cap else None,
                "channel_code": channel_code,
            })
        else:
            derived["tsar_accumulated"] = proposed_sum_assured
            derived["total_sum_at_risk"] = proposed_sum_assured

        # Caller-supplied case-specific fields (e.g. sanctions_matched,
        # composite_score, occupation) always win over derived defaults.
        if extra_context:
            derived.update(extra_context)

        return derived

    async def _channel_code(self, customer: Customer) -> Optional[str]:
        if not customer.acquisition_source_id:
            return None
        from shared.models.core import AcquisitionSource, AcquisitionSourceType

        source = await self.session.get(AcquisitionSource, customer.acquisition_source_id)
        if not source:
            return None
        if source.source_type == AcquisitionSourceType.BANCASSURANCE and source.partner_name:
            slug = "".join(ch for ch in source.partner_name.upper() if ch.isalnum())
            return f"BANCASSURANCE_{slug}"
        return source.source_type.value if hasattr(source.source_type, "value") else str(source.source_type)


def _bmi(height_cm: Optional[float], weight_kg: Optional[float]) -> Optional[float]:
    if not height_cm or not weight_kg:
        return None
    height_m = height_cm / 100.0
    if height_m <= 0:
        return None
    return round(weight_kg / (height_m * height_m), 1)


# ─────────────────────────────────────────────────────────────────────────────
# Steps 5-6 — grouped criteria evaluation + typed impact accumulation
# ─────────────────────────────────────────────────────────────────────────────

def _to_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    return str(v).lower() in ("true", "1", "yes")


def _resolve_criterion_value(field_value: Any, criterion: RuleCriteria, context: Dict[str, Any]) -> bool:
    """Evaluates one RuleCriteria row against `field_value` (already looked up
    from context by field_name). field_gt/field_gte resolve target_field_name
    dynamically from `context`, not from a stored value."""
    op = criterion.operator.value if hasattr(criterion.operator, "value") else str(criterion.operator)

    try:
        if op in ("field_gt", "field_gte"):
            if field_value is None or criterion.target_field_name is None:
                return False
            target_value = context.get(criterion.target_field_name)
            if target_value is None:
                return False
            threshold = float(target_value) * (criterion.target_multiplier or 1.0)
            actual = float(field_value)
            return actual > threshold if op == "field_gt" else actual >= threshold

        if field_value is None:
            return False

        if op == "eq":
            if criterion.value_string is not None:
                if isinstance(field_value, bool) or criterion.value_string.lower() in ("true", "false"):
                    return _to_bool(field_value) == _to_bool(criterion.value_string)
                return str(field_value).lower().strip() == criterion.value_string.lower().strip()
            return float(field_value) == float(criterion.value_numeric)

        if op == "neq":
            if criterion.value_string is not None:
                if isinstance(field_value, bool) or criterion.value_string.lower() in ("true", "false"):
                    return _to_bool(field_value) != _to_bool(criterion.value_string)
                return str(field_value).lower().strip() != criterion.value_string.lower().strip()
            return float(field_value) != float(criterion.value_numeric)

        if op == "gt":
            return float(field_value) > float(criterion.value_numeric)
        if op == "gte":
            return float(field_value) >= float(criterion.value_numeric)
        if op == "lt":
            return float(field_value) < float(criterion.value_numeric)
        if op == "lte":
            return float(field_value) <= float(criterion.value_numeric)

        if op == "between":
            if criterion.value_range_min is None or criterion.value_range_max is None:
                return False
            val = float(field_value)
            return criterion.value_range_min <= val <= criterion.value_range_max

        if op == "in_set":
            items = criterion.value_list or []
            str_items = [str(x).lower().strip() for x in items]
            return str(field_value).lower().strip() in str_items

        if op == "contains":
            target = criterion.value_string or ""
            return target.lower() in str(field_value).lower()

    except (TypeError, ValueError) as e:
        logger.warning("Error evaluating criterion (%s %s): %s", field_value, op, e)
        return False

    return False


def _evaluate_rule(criteria: List[RuleCriteria], context: Dict[str, Any]) -> bool:
    """Groups criteria by group_id: AND within a group, OR across groups.
    A rule with zero criteria matches unconditionally."""
    if not criteria:
        return True

    by_group: Dict[int, List[RuleCriteria]] = {}
    for c in criteria:
        by_group.setdefault(c.group_id, []).append(c)

    return any(
        all(_resolve_criterion_value(context.get(c.field_name), c, context) for c in group)
        for group in by_group.values()
    )


class ImpactAccumulator:
    """Per-field accumulation semantics across all matched rules (the spec
    doesn't pin these down — decided here):
      extra_mortality_pct          -> SUM (loadings stack)
      flat_extra_per_thousand      -> MAX (worst case, doesn't stack)
      medical_profile_codes        -> UNION (dedup)
      exclusion_riders             -> UNION (dedup)
      hlv_max_multiple             -> MIN of non-None values (most conservative ceiling)
      reinsurance_retention_limit  -> MIN of non-None values (most conservative)
      underwriter_authority_level  -> MAX (highest authority required wins)
      commission_pct / withholding_tax_pct -> last-write-wins in priority order
      is_terminal                  -> caller short-circuits once a matched rule sets it
    """

    def __init__(self) -> None:
        self.extra_mortality_pct = 0.0
        self.flat_extra_per_thousand = 0.0
        self.medical_profile_codes: List[str] = []
        self.exclusion_riders: List[str] = []
        self.hlv_max_multiple: Optional[float] = None
        self.reinsurance_retention_limit: Optional[float] = None
        self.underwriter_authority_level: Optional[int] = None
        self.commission_pct: Optional[float] = None
        self.withholding_tax_pct: Optional[float] = None

    def accumulate(self, impact_data: Dict[str, Any]) -> None:
        self.extra_mortality_pct += float(impact_data.get("extra_mortality_pct") or 0)
        self.flat_extra_per_thousand = max(
            self.flat_extra_per_thousand, float(impact_data.get("flat_extra_per_thousand") or 0)
        )
        for code in impact_data.get("medical_profile_codes") or []:
            if code not in self.medical_profile_codes:
                self.medical_profile_codes.append(code)
        for rider in impact_data.get("exclusion_riders") or []:
            if rider not in self.exclusion_riders:
                self.exclusion_riders.append(rider)

        hlv = impact_data.get("hlv_max_multiple")
        if hlv is not None:
            self.hlv_max_multiple = hlv if self.hlv_max_multiple is None else min(self.hlv_max_multiple, hlv)

        retention = impact_data.get("reinsurance_retention_limit")
        if retention is not None:
            self.reinsurance_retention_limit = (
                retention if self.reinsurance_retention_limit is None else min(self.reinsurance_retention_limit, retention)
            )

        authority = impact_data.get("underwriter_authority_level")
        if authority is not None:
            self.underwriter_authority_level = (
                authority if self.underwriter_authority_level is None else max(self.underwriter_authority_level, authority)
            )

        if impact_data.get("commission_pct") is not None:
            self.commission_pct = impact_data["commission_pct"]
        if impact_data.get("withholding_tax_pct") is not None:
            self.withholding_tax_pct = impact_data["withholding_tax_pct"]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "extra_mortality_pct": self.extra_mortality_pct,
            "flat_extra_per_thousand": self.flat_extra_per_thousand,
            "medical_profile_codes": self.medical_profile_codes,
            "exclusion_riders": self.exclusion_riders,
            "hlv_max_multiple": self.hlv_max_multiple,
            "reinsurance_retention_limit": self.reinsurance_retention_limit,
            "underwriter_authority_level": self.underwriter_authority_level,
            "commission_pct": self.commission_pct,
            "withholding_tax_pct": self.withholding_tax_pct,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Steps 2-8 — single rule set, and full hierarchy-scope evaluation
# ─────────────────────────────────────────────────────────────────────────────

async def evaluate_rule_set(
    session: AsyncSession,
    rule_set_code: str,
    context: Dict[str, Any],
    tenant_id: Optional[UUID] = None,
    proposal_id: Optional[str] = None,
    actor: Optional[str] = "System",
    case_id: Optional[str] = None,  # deprecated alias for proposal_id, kept for one deploy cycle
) -> Dict[str, Any]:
    """
    Evaluates an active RuleVersion of a single named RuleSet against the
    provided context payload (pipeline steps 3-8).

    Returns:
        {
            "rule_set_code": str, "version_number": str,
            "evaluated_at": str, "matched_rule_codes": [...],
            "final_impacts": {...}, "reasons": [...],
            "status": "SUCCESS" | "NO_MATCH" | "RULE_SET_NOT_FOUND" | "NO_ACTIVE_VERSION"
        }
    """
    proposal_id = proposal_id or case_id
    started = time.perf_counter()

    query = select(RuleSet).where(RuleSet.rule_code == rule_set_code)
    if tenant_id:
        query = select(RuleSet).where(
            (RuleSet.rule_code == rule_set_code) & ((RuleSet.tenant_id == tenant_id) | (RuleSet.tenant_id == None))  # noqa: E711
        )
    result = await session.exec(query)
    rule_set = result.first()

    if not rule_set or not rule_set.is_active:
        return {
            "rule_set_code": rule_set_code,
            "status": "RULE_SET_NOT_FOUND",
            "matched_rule_codes": [],
            "final_impacts": {},
            "reasons": [f"Rule set '{rule_set_code}' not found or inactive."],
            "evaluated_at": datetime.utcnow().isoformat(),
        }

    now = datetime.utcnow()
    ver_result = await session.exec(
        select(RuleVersion)
        .where(RuleVersion.rule_set_id == rule_set.id)
        .where(RuleVersion.status == RuleVersionStatusEnum.ACTIVE)
        .where(RuleVersion.effective_from <= now)
        .where((RuleVersion.effective_to == None) | (RuleVersion.effective_to >= now))  # noqa: E711
        .order_by(RuleVersion.created_at.desc())
    )
    active_version = ver_result.first()

    if not active_version:
        return {
            "rule_set_code": rule_set_code,
            "status": "NO_ACTIVE_VERSION",
            "matched_rule_codes": [],
            "final_impacts": {},
            "reasons": [f"Rule set '{rule_set_code}' has no ACTIVE version deployed."],
            "evaluated_at": datetime.utcnow().isoformat(),
        }

    rules_result = await session.exec(
        select(ActualRule)
        .where(ActualRule.version_id == active_version.id)
        .where(ActualRule.is_active == True)  # noqa: E712
        .where(ActualRule.affected_from <= now)
        .where((ActualRule.affected_to == None) | (ActualRule.affected_to >= now))  # noqa: E711
        .order_by(ActualRule.priority.asc())
    )
    rules: List[ActualRule] = list(rules_result.all())

    accumulator = ImpactAccumulator()
    matched_rule_codes: List[str] = []
    reasons: List[str] = []

    for rule in rules:
        criteria_result = await session.exec(
            select(RuleCriteria).where(RuleCriteria.rule_id == rule.id)
        )
        criteria = list(criteria_result.all())

        if not _evaluate_rule(criteria, context):
            continue

        accumulator.accumulate(rule.impact_data or {})
        matched_rule_codes.append(rule.rule_code)
        impact_label = rule.impact_type.value if hasattr(rule.impact_type, "value") else str(rule.impact_type)
        reasons.append(f"Rule '{rule.name}' matched ({impact_label} — {rule.action_outcome})")

        if (rule.impact_data or {}).get("is_terminal") is True:
            break

    final_impacts = accumulator.to_dict()
    output_result = {
        "rule_set_code": rule_set_code,
        "version_number": active_version.version_number,
        "status": "SUCCESS" if matched_rule_codes else "NO_MATCH",
        "matched_rule_codes": matched_rule_codes,
        "final_impacts": final_impacts,
        "reasons": reasons,
        "evaluated_at": datetime.utcnow().isoformat(),
    }

    duration_ms = (time.perf_counter() - started) * 1000

    try:
        subcategory = await session.get(SubCategory, rule_set.subcategory_id)
        eligibility = await session.get(EligibilityProfile, rule_set.eligibility_id) if rule_set.eligibility_id else None
        category_code = None
        if subcategory:
            from shared.models.core import Category
            category = await session.get(Category, subcategory.category_id)
            category_code = category.code if category else None

        audit_log = RuleEvaluationLog(
            tenant_id=tenant_id,
            proposal_id=proposal_id,
            customer_cnic=context.get("customer_cnic"),
            category_code=category_code,
            subcategory_code=subcategory.code if subcategory else None,
            channel_code=eligibility.channel_code if eligibility else context.get("channel_code"),
            rule_set_code=rule_set_code,
            version_number=active_version.version_number,
            actor=actor,
            input_context_snapshot=context,
            tsar_accumulated=float(context.get("tsar_accumulated") or 0),
            matched_rule_codes=matched_rule_codes,
            final_impacts=final_impacts,
            reasons=reasons,
            evaluated_at=datetime.utcnow(),
            execution_duration_ms=duration_ms,
        )
        session.add(audit_log)
        await session.commit()
    except Exception as err:
        logger.error("Failed to record RuleEvaluationLog: %s", err)

    return output_result


async def evaluate_scope(
    session: AsyncSession,
    *,
    tenant_id: UUID,
    subcategory_code: str,
    channel_code: Optional[str] = None,
    context: Dict[str, Any],
    proposal_id: Optional[str] = None,
    actor: Optional[str] = "System",
) -> Dict[str, Any]:
    """
    Pipeline step 2: resolves the EligibilityProfile for
    (subcategory_code, channel_code), then evaluates every RuleSet in scope —
    RuleSets pinned to that profile, plus every GLOBAL-scope RuleSet under the
    same SubCategory — merging results via the same ImpactAccumulator
    semantics across rule sets. Wiring this into real production call sites
    (quote/underwriting flow) is a follow-up; this entry point exists and is
    fully callable today (e.g. from the admin Simulator tab).
    """
    sub_result = await session.exec(select(SubCategory).where(SubCategory.code == subcategory_code))
    subcategory = sub_result.first()
    if not subcategory:
        return {
            "subcategory_code": subcategory_code,
            "status": "SUBCATEGORY_NOT_FOUND",
            "rule_set_results": [],
            "matched_rule_codes": [],
            "final_impacts": {},
            "evaluated_at": datetime.utcnow().isoformat(),
        }

    eligibility_id: Optional[UUID] = None
    if channel_code:
        elig_result = await session.exec(
            select(EligibilityProfile)
            .where(EligibilityProfile.subcategory_id == subcategory.id)
            .where(EligibilityProfile.channel_code == channel_code)
        )
        eligibility = elig_result.first()
        eligibility_id = eligibility.id if eligibility else None

    scope_filter = (RuleSet.scope_type == ScopeTypeEnum.GLOBAL)
    if eligibility_id is not None:
        scope_filter = scope_filter | (RuleSet.eligibility_id == eligibility_id)

    rule_sets_result = await session.exec(
        select(RuleSet)
        .where(RuleSet.subcategory_id == subcategory.id)
        .where(RuleSet.is_active == True)  # noqa: E712
        .where(scope_filter)
    )
    rule_sets = list(rule_sets_result.all())

    accumulator = ImpactAccumulator()
    matched_rule_codes: List[str] = []
    rule_set_results = []

    for rs in rule_sets:
        result = await evaluate_rule_set(
            session, rs.rule_code, context, tenant_id=tenant_id, proposal_id=proposal_id, actor=actor,
        )
        rule_set_results.append(result)
        matched_rule_codes.extend(result.get("matched_rule_codes") or [])
        accumulator.accumulate(result.get("final_impacts") or {})

    return {
        "subcategory_code": subcategory_code,
        "channel_code": channel_code,
        "status": "SUCCESS" if matched_rule_codes else "NO_MATCH",
        "rule_set_results": rule_set_results,
        "matched_rule_codes": matched_rule_codes,
        "final_impacts": accumulator.to_dict(),
        "evaluated_at": datetime.utcnow().isoformat(),
    }
