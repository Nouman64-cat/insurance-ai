"""
Rule Engine Router (v2.1) — API endpoints for the Category -> SubCategory ->
EligibilityProfile -> RuleSet -> RuleVersion -> ActualRule -> RuleCriteria
hierarchy: hierarchy CRUD, rule set/version/rule management, live evaluation
(by rule set code, or by category/subcategory/channel scope), and audit trails.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field as PydanticField
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from rule_evaluator import ContextDerivationService, evaluate_rule_set, evaluate_scope
from services.underwriting_limits import (
    HLV_MULTIPLES,
    NON_MEDICAL_LIMITS,
    RETENTION_AGE_SCALING,
    RETENTION_LIMIT,
    TREATY_LINES,
)
from shared.models.core import (
    ActualRule,
    Category,
    EligibilityProfile,
    ImpactTypeEnum,
    RuleCriteria,
    RuleEvaluationLog,
    RuleSet,
    RuleVersion,
    RuleVersionStatusEnum,
    ScopeTypeEnum,
    SubCategory,
)

router = APIRouter(prefix="/tenants/{tenant_id}/rules", tags=["Rule Engine"])


# ─────────────────────────────────────────────────────────────────────────────
# Old -> new seed-shape conversion
#
# The seed catalogue below is authored in the same "old-style" rule dict shape
# (conditions/operator/outcome_payload/action_outcome) the pre-v2.1 engine
# used, so the 63 real, calibrated rules didn't need hand-transcription into
# the new shape. seed_rules_if_empty() converts each one at insert time via
# the same mapping logic migrate.py's _migrate_rule_engine_v2() uses for
# existing installs, so a fresh DB and a migrated DB land on identical data.
# ─────────────────────────────────────────────────────────────────────────────

def _to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _eq_kwargs(value):
    if isinstance(value, bool):
        return {"value_string": "true" if value else "false"}
    if isinstance(value, (int, float)):
        return {"value_numeric": float(value)}
    return {"value_string": str(value)}


def _map_condition_operator(op: str, value: Any):
    op = str(op or "eq").lower().strip()
    if op in ("gt", ">"):
        return "gt", {"value_numeric": _to_float(value)}
    if op in ("gte", ">="):
        return "gte", {"value_numeric": _to_float(value)}
    if op in ("lt", "<"):
        return "lt", {"value_numeric": _to_float(value)}
    if op in ("lte", "<="):
        return "lte", {"value_numeric": _to_float(value)}
    if op in ("ne", "!=", "not_equals"):
        return "neq", _eq_kwargs(value)
    if op in ("in", "is_one_of", "not_in", "is_not_one_of"):
        items = value if isinstance(value, list) else [value]
        return "in_set", {"value_list": items}
    if op in ("contains", "has"):
        return "contains", {"value_string": str(value)}
    if op in ("between", "range"):
        if isinstance(value, (list, tuple)) and len(value) == 2:
            return "between", {"value_range_min": _to_float(value[0]), "value_range_max": _to_float(value[1])}
        return "between", {"value_range_min": None, "value_range_max": None}
    if op in ("boolean", "is"):
        truthy = value if isinstance(value, bool) else str(value).lower() in ("true", "1", "yes")
        return "eq", {"value_string": "true" if truthy else "false"}
    return "eq", _eq_kwargs(value)


_IMPACT_TYPE_VALUES = {t.value for t in ImpactTypeEnum}


def _map_outcome_to_impact(action_outcome: str, outcome_payload: dict):
    outcome_payload = outcome_payload or {}
    label = str(action_outcome or "").upper()

    if label in _IMPACT_TYPE_VALUES:
        impact_type = label
    elif "DECLIN" in label or "REJECT" in label:
        impact_type = "DECLINE"
    elif "MEDICAL" in label:
        impact_type = "REQUIRE_MEDICAL"
    elif "REFER" in label:
        impact_type = "REFER_TO_UNDERWRITER"
    elif "EXCLU" in label:
        impact_type = "EXCLUSION_CLAUSE"
    elif "JUSTIF" in label:
        impact_type = "FINANCIAL_JUSTIFICATION"
    elif "FACULTATIVE" in label or "REINSUR" in label:
        impact_type = "REINSURANCE_FACULTATIVE"
    elif "LOAD" in label or "COMMISSION" in label or "RATE" in label or "TAX" in label:
        impact_type = "APPLY_LOADING"
    else:
        impact_type = "AUTO_APPROVE"

    impact_data = {
        "extra_mortality_pct": float(outcome_payload.get("extra_mortality_pct") or outcome_payload.get("loading_pct") or 0),
        "flat_extra_per_thousand": float(outcome_payload.get("flat_extra_per_thousand") or 0),
        "medical_profile_codes": outcome_payload.get("medical_profile_codes") or outcome_payload.get("tests") or [],
        "hlv_max_multiple": outcome_payload.get("hlv_max_multiple") or outcome_payload.get("multiple"),
        "reinsurance_retention_limit": (
            outcome_payload.get("reinsurance_retention_limit") or outcome_payload.get("retention_limit")
        ),
        "underwriter_authority_level": outcome_payload.get("underwriter_authority_level"),
        "exclusion_riders": outcome_payload.get("exclusion_riders") or [],
        "is_terminal": bool(outcome_payload.get("terminal")),
        "commission_pct": outcome_payload.get("commission_pct"),
        "withholding_tax_pct": outcome_payload.get("withholding_tax_pct"),
    }
    return impact_type, impact_data


def _convert_seed_rule(old: Dict[str, Any]):
    """Old-style seed rule dict -> (rule_code, name, priority, criteria, impact_type, impact_data, action_outcome)."""
    impact_type, impact_data = _map_outcome_to_impact(old["action_outcome"], old.get("outcome_payload") or {})
    is_any = str(old.get("operator", "ALL")).upper() == "ANY"
    criteria = []
    for idx, cond in enumerate(old.get("conditions") or []):
        group_id = (idx + 1) if is_any else 1
        new_op, kwargs = _map_condition_operator(cond.get("operator", "eq"), cond.get("value"))
        criteria.append({
            "group_id": group_id,
            "field_name": cond.get("field"),
            "operator": new_op,
            **kwargs,
        })
    return {
        "rule_code": old.get("code") or f"RULE-{uuid4().hex[:8]}",
        "name": old["name"],
        "priority": old["priority"],
        "criteria": criteria,
        "impact_type": impact_type,
        "impact_data": impact_data,
        "action_outcome": old["action_outcome"],
    }


# ─────────────────────────────────────────────────────────────────────────────
# Seed rule catalogue (unchanged rule content from the pre-v2.1 engine —
# generators still source real calibrated numbers from underwriting_limits.py)
# ─────────────────────────────────────────────────────────────────────────────

def _build_nml_rules() -> List[Dict[str, Any]]:
    """Generates the medical.nml_grid rules straight from
    services.underwriting_limits.NON_MEDICAL_LIMITS — the same age-band table
    services/underwriting_limits.py:assess_medical_requirement() enforces —
    so the rule engine's seed can never drift from the sync codepath the rest
    of the platform still calls directly. Also encodes that codepath's other
    two overrides: age >= 61 is always medical, and any adverse E-Application
    disclosure pulls a proposal into medicals regardless of sum assured."""
    rules: List[Dict[str, Any]] = [
        {
            "code": "MED-NML-00A",
            "name": "Age 61+ Always Medical",
            "priority": 1,
            "operator": "ALL",
            "conditions": [{"field": "age", "operator": "gte", "value": 61}],
            "action_outcome": "REQUIRE_MEDICAL_EXAM",
            "outcome_payload": {
                "terminal": True,
                "reason": "Applicant age 61 or above — all proposals above age 60 are medically underwritten.",
            },
        },
        {
            "code": "MED-NML-00B",
            "name": "Adverse Disclosure Override",
            "priority": 2,
            "operator": "ALL",
            "conditions": [{"field": "has_adverse_disclosure", "operator": "boolean", "value": True}],
            "action_outcome": "REQUIRE_MEDICAL_EXAM",
            "outcome_payload": {
                "terminal": True,
                "reason": "Adverse disclosure on the E-Application overrides the non-medical limit.",
            },
        },
    ]

    for i, (lo, hi, limit) in enumerate(NON_MEDICAL_LIMITS, start=1):
        priority = 10 + i
        if limit <= 0:
            continue
        rules.append({
            "code": f"MED-NML-{i:02d}",
            "name": f"Age {lo}-{hi} Over NML",
            "priority": priority,
            "operator": "ALL",
            "conditions": [
                {"field": "age", "operator": "between", "value": [lo, hi]},
                {"field": "sum_assured", "operator": "gt", "value": limit},
            ],
            "action_outcome": "REQUIRE_MEDICAL_EXAM",
            "outcome_payload": {
                "terminal": True,
                "reason": f"Aggregate sum at risk exceeds the non-medical limit of PKR {limit:,.0f} for ages {lo}-{hi}.",
            },
        })

    rules.append({
        "code": "MED-NML-WAIVE",
        "name": "Waive Medical Exam",
        "priority": 99,
        "operator": "ALL",
        "conditions": [],
        "action_outcome": "WAIVE_MEDICAL",
        "outcome_payload": {
            "reason": "Within the non-medical limit for this age band; no medical examination required.",
        },
    })
    return rules


def _build_nml_variant_rules(band_limits: List[tuple]) -> List[Dict[str, Any]]:
    """3-band (18-40/41-50/51-60) NML grid for a Phase-4 channel variant, plus
    the same age>60 always-medical terminal override as the baseline grid.
    band_limits values are conservatively interpolated from
    NON_MEDICAL_LIMITS' finer bands (min of the sub-bands covered), not
    invented — see routers/rules.py:_DEFAULT_RULE_SETS Phase-4 entries."""
    rules: List[Dict[str, Any]] = [
        {
            "code": "MED-NML-00A",
            "name": "Age 61+ Always Medical",
            "priority": 1,
            "operator": "ALL",
            "conditions": [{"field": "age", "operator": "gte", "value": 61}],
            "action_outcome": "REQUIRE_MEDICAL_EXAM",
            "outcome_payload": {"terminal": True, "reason": "Applicant age 61 or above — always medically underwritten."},
        },
    ]
    for i, (lo, hi, limit) in enumerate(band_limits, start=1):
        rules.append({
            "code": f"MED-NML-{i:02d}",
            "name": f"Age {lo}-{hi} Over NML",
            "priority": 10 + i,
            "operator": "ALL",
            "conditions": [
                {"field": "age", "operator": "between", "value": [lo, hi]},
                {"field": "sum_assured", "operator": "gt", "value": limit},
            ],
            "action_outcome": "REQUIRE_MEDICAL_EXAM",
            "outcome_payload": {
                "terminal": True,
                "reason": f"Aggregate sum at risk exceeds the non-medical limit of PKR {limit:,.0f} for ages {lo}-{hi}.",
            },
        })
    rules.append({
        "code": "MED-NML-WAIVE",
        "name": "Waive Medical Exam",
        "priority": 99,
        "operator": "ALL",
        "conditions": [],
        "action_outcome": "WAIVE_MEDICAL",
        "outcome_payload": {"reason": "Within the non-medical limit for this age band; no medical examination required."},
    })
    return rules


def _build_hlv_rules() -> List[Dict[str, Any]]:
    """Generates the Human Life Value multiple lookup from
    services.underwriting_limits.HLV_MULTIPLES — the same age-band table
    services/insurance_history.py:screen() uses to size the over-insurance
    ceiling (aggregate cover > income x multiple)."""
    rules: List[Dict[str, Any]] = []
    for i, (lo, hi, mult) in enumerate(HLV_MULTIPLES, start=1):
        rules.append({
            "code": f"HIST-HLV-{i:02d}",
            "name": f"Age {lo}-{hi} HLV Multiple",
            "priority": i,
            "operator": "ALL",
            "conditions": [{"field": "age", "operator": "between", "value": [lo, hi]}],
            "action_outcome": "HLV_MULTIPLE_LOOKUP",
            "outcome_payload": {
                "terminal": True,
                "multiple": mult,
                "reason": f"HLV ceiling for ages {lo}-{hi} is {mult:g}x declared annual income.",
            },
        })
    return rules


def _build_retention_rules() -> List[Dict[str, Any]]:
    """Generates the age-banded retention/treaty-capacity lookup from
    services.underwriting_limits.RETENTION_AGE_SCALING x RETENTION_LIMIT x
    TREATY_LINES — the same constants services/reinsurance.py and
    underwriting_limits.py:compute_cession() use to decide how much of a life
    the insurer keeps net versus cedes automatically under treaty."""
    rules: List[Dict[str, Any]] = []
    for i, (lo, hi, factor) in enumerate(RETENTION_AGE_SCALING, start=1):
        retention = round(RETENTION_LIMIT * factor, 2)
        treaty = round(retention * TREATY_LINES, 2)
        rules.append({
            "code": f"REINS-RET-{i:02d}",
            "name": f"Age {lo}-{hi} Retention & Treaty Capacity",
            "priority": i,
            "operator": "ALL",
            "conditions": [{"field": "age", "operator": "between", "value": [lo, hi]}],
            "action_outcome": "RETENTION_LOOKUP",
            "outcome_payload": {
                "terminal": True,
                "retention_limit": retention,
                "treaty_capacity": treaty,
                "automatic_capacity": round(retention + treaty, 2),
                "reason": f"Ages {lo}-{hi}: retention PKR {retention:,.0f}, automatic capacity (retention + treaty) PKR {round(retention + treaty, 2):,.0f}.",
            },
        })
    return rules


# Each entry: rule_code, name, description, category_code/sub_code/sub_name
# (SubCategory is the single browsing taxonomy for both GLOBAL and
# CHANNEL_PRODUCT rule sets — see shared/models/core.py:RuleSet docstring),
# scope_type, channel_code (only meaningful for CHANNEL_PRODUCT), rules.
_DEFAULT_RULE_SETS = [
    {
        "code": "RS-MED-001",
        "name": "Non-Medical Limits (NML) — Agency Direct",
        "description": "Determines whether an applicant requires panel medical examination based on age and sum assured. Generated from services/underwriting_limits.py:NON_MEDICAL_LIMITS.",
        "category_code": "MEDICAL_NML", "sub_code": "NON_MEDICAL_LIMITS", "sub_name": "Non-Medical Limits",
        "scope_type": "CHANNEL_PRODUCT", "channel_code": "AGENCY_DIRECT",
        "rules": _build_nml_rules(),
    },
    {
        "code": "RS-MED-002",
        "name": "Non-Medical Limits (NML) — Window Takaful",
        "description": "Adamjee Window Takaful NML grid (18-40/41-50/51-60), same limits as the conventional agency grid.",
        "category_code": "MEDICAL_NML", "sub_code": "NON_MEDICAL_LIMITS", "sub_name": "Non-Medical Limits",
        "scope_type": "CHANNEL_PRODUCT", "channel_code": "WINDOW_TAKAFUL",
        "rules": _build_nml_variant_rules([(18, 40, 2_000_000), (41, 50, 1_000_000), (51, 60, 250_000)]),
    },
    {
        "code": "RS-MED-003",
        "name": "Non-Medical Limits (NML) — Bancassurance MCB",
        "description": "Adamjee Bancassurance (MCB Bank) NML grid — tighter age band per the channel's EligibilityProfile.",
        "category_code": "MEDICAL_NML", "sub_code": "NON_MEDICAL_LIMITS", "sub_name": "Non-Medical Limits",
        "scope_type": "CHANNEL_PRODUCT", "channel_code": "BANCASSURANCE_MCB",
        "rules": _build_nml_variant_rules([(18, 40, 2_000_000), (41, 50, 1_000_000), (51, 60, 250_000)]),
    },
    {
        "code": "RS-MED-004",
        "name": "Non-Medical Limits (NML) — Bancassurance Bank Alfalah",
        "description": "Adamjee Bancassurance (Bank Alfalah) NML grid — tighter age band per the channel's EligibilityProfile.",
        "category_code": "MEDICAL_NML", "sub_code": "NON_MEDICAL_LIMITS", "sub_name": "Non-Medical Limits",
        "scope_type": "CHANNEL_PRODUCT", "channel_code": "BANCASSURANCE_ALFALAH",
        "rules": _build_nml_variant_rules([(18, 40, 2_000_000), (41, 50, 1_000_000), (51, 60, 250_000)]),
    },
    {
        "code": "RS-COM-001",
        "name": "SECP Commission Rates",
        "description": "Statutory commission caps under SECP Insurance Rules 2017.",
        "category_code": "COMMISSION_SECP", "sub_code": "STATUTORY_RATES", "sub_name": "SECP Statutory Rates",
        "scope_type": "GLOBAL", "channel_code": None,
        "rules": [
            {
                "code": "COM-IND-Y1", "name": "Individual Year 1", "priority": 1, "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "eq", "value": "Individual"},
                    {"field": "policy_year", "operator": "eq", "value": 1},
                    {"field": "premium_type", "operator": "eq", "value": "FIRST_YEAR"},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {"terminal": True, "commission_pct": 35.0, "withholding_tax_pct": 10.0, "reason": "SECP Rule 24: Individual first-year statutory max 35%."},
            },
            {
                "code": "COM-IND-Y2", "name": "Individual Year 2", "priority": 2, "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "eq", "value": "Individual"},
                    {"field": "policy_year", "operator": "eq", "value": 2},
                    {"field": "premium_type", "operator": "eq", "value": "RENEWAL"},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {"terminal": True, "commission_pct": 7.5, "withholding_tax_pct": 10.0, "reason": "SECP Rule 24: Individual 2nd year renewal 7.5%."},
            },
            {
                "code": "COM-IND-Y3", "name": "Individual Year 3+", "priority": 3, "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "eq", "value": "Individual"},
                    {"field": "policy_year", "operator": "gte", "value": 3},
                    {"field": "premium_type", "operator": "eq", "value": "RENEWAL"},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {"terminal": True, "commission_pct": 5.0, "withholding_tax_pct": 10.0, "reason": "SECP Rule 24: Individual renewal 3rd year+ 5.0%."},
            },
            {
                "code": "COM-IND-SP", "name": "Individual Single Premium", "priority": 4, "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "eq", "value": "Individual"},
                    {"field": "premium_type", "operator": "eq", "value": "SINGLE_PREMIUM"},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {"terminal": True, "commission_pct": 2.5, "withholding_tax_pct": 10.0, "reason": "Single premium upfront acquisition commission 2.5% (Adamjee Life 2024 Report — could not be independently verified against a public rate card; recommend actuarial confirmation)."},
            },
            {
                "code": "COM-GRP-Y1", "name": "Group Year 1", "priority": 5, "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "in", "value": ["Group", "Organization"]},
                    {"field": "policy_year", "operator": "eq", "value": 1},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {"terminal": True, "commission_pct": 15.0, "withholding_tax_pct": 10.0, "reason": "SECP Rules 2017 Form LG: Group Corporate Life first-year commission 15%."},
            },
            {
                "code": "COM-GRP-Y2", "name": "Group Renewal", "priority": 6, "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "in", "value": ["Group", "Organization"]},
                    {"field": "policy_year", "operator": "gte", "value": 2},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {"terminal": True, "commission_pct": 3.0, "withholding_tax_pct": 10.0, "reason": "SECP Rules 2017 Form LG: Group Corporate Life renewal trail commission 3%."},
            },
            {
                "code": "COM-TAK", "name": "Takaful Year 1", "priority": 7, "operator": "ALL",
                "conditions": [{"field": "category", "operator": "eq", "value": "Family"}],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {"terminal": True, "commission_pct": 30.0, "withholding_tax_pct": 10.0, "reason": "SECP Takaful Rules 2012: Family Takaful first-year statutory rate 30%. Renewal-year Takaful rate not independently confirmed in public sources."},
            },
        ],
    },
    {
        "code": "RS-CMP-001",
        "name": "AML & Sanctions Compliance",
        "description": "High-risk customer AML screening, PEP flagging, and clearance rules.",
        "category_code": "COMPLIANCE_AML", "sub_code": "SANCTIONS_PEP_AML", "sub_name": "Sanctions, PEP & AML",
        "scope_type": "GLOBAL", "channel_code": None,
        "rules": [
            {
                "code": "AML-SANC-01", "name": "Sanctions Block", "priority": 1, "operator": "ALL",
                "conditions": [{"field": "sanctions_matched", "operator": "boolean", "value": True}],
                "action_outcome": "BLOCK_APPLICATION",
                "outcome_payload": {"terminal": True, "risk_level": "CRITICAL", "reason": "Match found on UN/SECP Sanctions List. Policy issue blocked."},
            },
            {
                "code": "AML-PEP-01", "name": "PEP Clearance", "priority": 2, "operator": "ALL",
                "conditions": [{"field": "is_pep", "operator": "boolean", "value": True}],
                "action_outcome": "REQUIRE_MANUAL_CLEARANCE",
                "outcome_payload": {"risk_level": "HIGH", "reason": "Politically Exposed Person (PEP) requires senior compliance sign-off."},
            },
            {
                "code": "AML-EDD-01", "name": "High Premium EDD", "priority": 3, "operator": "ALL",
                "conditions": [{"field": "annual_premium", "operator": "gt", "value": 1000000}],
                "action_outcome": "REQUIRE_ENHANCED_DUE_DILIGENCE",
                "outcome_payload": {"risk_level": "MEDIUM_HIGH", "reason": "Annual premium > 1,000,000 PKR requires Source of Funds documentation."},
            },
        ],
    },
    {
        "code": "RS-PRC-001",
        "name": "Risk Loadings",
        "description": "Computes health, BMI, and smoker premium loadings.",
        "category_code": "PRICING", "sub_code": "BMI_SMOKING", "sub_name": "BMI & Smoking Loadings",
        "scope_type": "GLOBAL", "channel_code": None,
        "rules": [
            {
                "code": "RSK-BMI-01", "name": "Obese Smoker Surcharge", "priority": 1, "operator": "ALL",
                "conditions": [
                    {"field": "bmi", "operator": "gt", "value": 32},
                    {"field": "is_smoker", "operator": "boolean", "value": True},
                ],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {"loading_pct": 50.0, "reason": "Severe Obesity (BMI > 32) combined with active smoking."},
            },
            {
                "code": "RSK-SMK-01", "name": "Standard Smoker Loading", "priority": 2, "operator": "ALL",
                "conditions": [{"field": "is_smoker", "operator": "boolean", "value": True}],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {"loading_pct": 25.0, "reason": "Active tobacco/smoker surcharge."},
            },
            {
                "code": "RSK-BMI-02", "name": "Overweight Loading", "priority": 3, "operator": "ALL",
                "conditions": [{"field": "bmi", "operator": "between", "value": [28, 32]}],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {"loading_pct": 15.0, "reason": "Overweight BMI band (28 - 32)."},
            },
        ],
    },
    {
        "code": "RS-AI-001",
        "name": "AI Risk Bands",
        "description": "Maps composite risk scores (0-100) to automated underwriting decisions.",
        "category_code": "AI_DECISION_BANDS", "sub_code": "STANDARD_BANDS", "sub_name": "Standard Decision Bands",
        "scope_type": "GLOBAL", "channel_code": None,
        "rules": [
            {
                "code": "AI-BND-01", "name": "Low Risk Auto-Approve", "priority": 1, "operator": "ALL",
                "conditions": [{"field": "composite_score", "operator": "lt", "value": 40}],
                "action_outcome": "AUTO_APPROVE",
                "outcome_payload": {"status_code": "APPROVED", "reason": "Composite risk score below 40. Standard acceptance."},
            },
            {
                "code": "AI-BND-02", "name": "Moderate Risk Loading", "priority": 2, "operator": "ALL",
                "conditions": [{"field": "composite_score", "operator": "between", "value": [40, 69]}],
                "action_outcome": "APPROVE_WITH_LOADING",
                "outcome_payload": {"status_code": "ACCEPTED_WITH_LOADINGS", "reason": "Moderate risk score. Underwriting loading or counter-offer required."},
            },
            {
                "code": "AI-BND-03", "name": "High Risk Human Review", "priority": 3, "operator": "ALL",
                "conditions": [{"field": "composite_score", "operator": "gte", "value": 70}],
                "action_outcome": "REQUIRE_HUMAN_REVIEW",
                "outcome_payload": {"status_code": "UNDER_REVIEW", "reason": "High composite risk score. Manual review mandated."},
            },
        ],
    },
    {
        "code": "RS-ELG-001",
        "name": "Proposal Eligibility Gates",
        "description": (
            "The four eligibility checks routers/quote.py runs before pricing a proposal: "
            "entry-age band, term band, maturity age, and income-multiple ceiling. The caller "
            "pre-evaluates each boolean against the selected plan's own bands and passes the "
            "booleans in as context."
        ),
        "category_code": "ELIGIBILITY", "sub_code": "POLICY_LIMITS", "sub_name": "Policy Limits",
        "scope_type": "CHANNEL_PRODUCT", "channel_code": "AGENCY_DIRECT",
        "rules": [
            {
                "code": "ELG-AGE-01", "name": "Entry Age Out of Band", "priority": 1, "operator": "ALL",
                "conditions": [{"field": "age_in_entry_band", "operator": "boolean", "value": False}],
                "action_outcome": "INELIGIBLE",
                "outcome_payload": {"terminal": True, "reason": "Customer age is outside the plan's eligible entry-age band."},
            },
            {
                "code": "ELG-TERM-01", "name": "Term Out of Band", "priority": 2, "operator": "ALL",
                "conditions": [{"field": "term_in_band", "operator": "boolean", "value": False}],
                "action_outcome": "INELIGIBLE",
                "outcome_payload": {"terminal": True, "reason": "Policy term is outside the plan's eligible term band."},
            },
            {
                "code": "ELG-MAT-01", "name": "Maturity Age Exceeded", "priority": 3, "operator": "ALL",
                "conditions": [{"field": "maturity_age_ok", "operator": "boolean", "value": False}],
                "action_outcome": "INELIGIBLE",
                "outcome_payload": {"terminal": True, "reason": "Age at maturity exceeds the plan's maximum maturity age."},
            },
            {
                "code": "ELG-INC-01", "name": "Coverage Exceeds Income Multiple", "priority": 4, "operator": "ALL",
                "conditions": [{"field": "coverage_within_multiple", "operator": "boolean", "value": False}],
                "action_outcome": "INELIGIBLE",
                "outcome_payload": {"terminal": True, "reason": "Requested coverage exceeds the plan's maximum income multiple."},
            },
            {
                "code": "ELG-PASS", "name": "Eligible", "priority": 99, "operator": "ALL",
                "conditions": [],
                "action_outcome": "ELIGIBLE",
                "outcome_payload": {"reason": "Entry age, term, maturity age, and income multiple are all within the plan's eligible bands."},
            },
        ],
    },
    {
        "code": "RS-UW-001",
        "name": "Six Pre-Underwriting Gates",
        "description": (
            "The canonical 'done' definition for each of the six pre-underwriting clearance "
            "gates a case must clear before Stage-A pre-issuance can begin."
        ),
        "category_code": "UNDERWRITING_GATES", "sub_code": "PRE_UW_GATES", "sub_name": "Pre-Underwriting Gates",
        "scope_type": "GLOBAL", "channel_code": None,
        "rules": [
            {
                "code": "GATE-1", "name": "E-Application Verified", "priority": 1, "operator": "ALL",
                "conditions": [{"field": "e_application_status", "operator": "in", "value": ["Verified"]}],
                "action_outcome": "GATE_CLEARED",
                "outcome_payload": {"gate": 1, "reason": "E-Application Verified."},
            },
            {
                "code": "GATE-2", "name": "ACR Submitted", "priority": 2, "operator": "ALL",
                "conditions": [{"field": "acr_status", "operator": "in", "value": ["Submitted"]}],
                "action_outcome": "GATE_CLEARED",
                "outcome_payload": {"gate": 2, "reason": "Agent's Confidential Report Submitted."},
            },
            {
                "code": "GATE-3", "name": "Compliance Passed", "priority": 3, "operator": "ALL",
                "conditions": [{"field": "compliance_status", "operator": "in", "value": ["Passed"]}],
                "action_outcome": "GATE_CLEARED",
                "outcome_payload": {"gate": 3, "reason": "Compliance screening Passed."},
            },
            {
                "code": "GATE-4", "name": "IPP Realized", "priority": 4, "operator": "ALL",
                "conditions": [{"field": "ipp_status", "operator": "in", "value": ["Realized"]}],
                "action_outcome": "GATE_CLEARED",
                "outcome_payload": {"gate": 4, "reason": "Initial Premium Payment Realized."},
            },
            {
                "code": "GATE-5", "name": "Insurance History Clear", "priority": 5, "operator": "ALL",
                "conditions": [{"field": "insurance_history_status", "operator": "in", "value": ["Clear"]}],
                "action_outcome": "GATE_CLEARED",
                "outcome_payload": {"gate": 5, "reason": "Insurance History Clear."},
            },
            {
                "code": "GATE-6", "name": "Medical Resolved", "priority": 6, "operator": "ALL",
                "conditions": [{"field": "medical_status", "operator": "in", "value": ["NotRequired", "Completed", "Waived"]}],
                "action_outcome": "GATE_CLEARED",
                "outcome_payload": {"gate": 6, "reason": "Medical requirement resolved (not required / completed / waived)."},
            },
        ],
    },
    {
        "code": "RS-HIS-001",
        "name": "Human Life Value Ceiling",
        "description": "Age-banded income multiple used to size the over-insurance ceiling. Generated from services/underwriting_limits.py:HLV_MULTIPLES.",
        "category_code": "INSURANCE_HISTORY", "sub_code": "HLV_CEILING", "sub_name": "Human Life Value Ceiling",
        "scope_type": "GLOBAL", "channel_code": None,
        "rules": _build_hlv_rules(),
    },
    {
        "code": "RS-HIS-002",
        "name": "Insurance History Score Bands",
        "description": "Maps the weighted insurance-history finding score (0-100) to a CLEAR / FLAGGED / FAILED status. Mirrors services/insurance_history.py's _FLAG_THRESHOLD (40) / _FAIL_THRESHOLD (85).",
        "category_code": "INSURANCE_HISTORY", "sub_code": "SCORE_BANDS", "sub_name": "Insurance History Score Bands",
        "scope_type": "GLOBAL", "channel_code": None,
        "rules": [
            {
                "code": "HIST-BAND-01", "name": "Failed", "priority": 1, "operator": "ALL",
                "conditions": [{"field": "score", "operator": "gte", "value": 85}],
                "action_outcome": "DECLINE",
                "outcome_payload": {"terminal": True, "status_code": "FAILED", "reason": "Insurance-history score at or above the fail threshold (85)."},
            },
            {
                "code": "HIST-BAND-02", "name": "Flagged", "priority": 2, "operator": "ALL",
                "conditions": [{"field": "score", "operator": "gte", "value": 40}],
                "action_outcome": "REFER_TO_UNDERWRITER",
                "outcome_payload": {"terminal": True, "status_code": "FLAGGED", "reason": "Insurance-history score at or above the flag threshold (40)."},
            },
            {
                "code": "HIST-BAND-03", "name": "Clear", "priority": 3, "operator": "ALL",
                "conditions": [],
                "action_outcome": "AUTO_APPROVE",
                "outcome_payload": {"status_code": "CLEAR", "reason": "Insurance-history score below the flag threshold."},
            },
        ],
    },
    {
        "code": "RS-RBA-001",
        "name": "RBAC Action-Role Matrix",
        "description": "Canonical action -> allowed-role(s) matrix. Roles are the 5 seeded in main.py:_SEED_ROLES.",
        "category_code": "RBAC_AUTHORIZATION", "sub_code": "ACTION_ROLE_MATRIX", "sub_name": "Action / Role Matrix",
        "scope_type": "GLOBAL", "channel_code": None,
        "rules": [
            {
                "code": "RBAC-01", "name": "Admin Resource Management", "priority": 1, "operator": "ALL",
                "conditions": [
                    {"field": "action", "operator": "eq", "value": "manage_admin_resources"},
                    {"field": "role", "operator": "in", "value": ["Admin", "SuperAdmin"]},
                ],
                "action_outcome": "ALLOW",
                "outcome_payload": {"terminal": True, "reason": "verify_admin surface — Admin (own tenant) or SuperAdmin (cross-tenant)."},
            },
            {
                "code": "RBAC-02", "name": "Case Decision", "priority": 2, "operator": "ALL",
                "conditions": [
                    {"field": "action", "operator": "eq", "value": "case_decision"},
                    {"field": "role", "operator": "in", "value": ["Underwriter", "Admin", "SuperAdmin"]},
                ],
                "action_outcome": "ALLOW",
                "outcome_payload": {"terminal": True, "reason": "cases.py:_CASE_DECISION_ROLES."},
            },
            {
                "code": "RBAC-03", "name": "Case Submission", "priority": 3, "operator": "ALL",
                "conditions": [
                    {"field": "action", "operator": "eq", "value": "case_submission"},
                    {"field": "role", "operator": "in", "value": ["Agent", "Underwriter", "Admin", "SuperAdmin"]},
                ],
                "action_outcome": "ALLOW",
                "outcome_payload": {"terminal": True, "reason": "cases.py:_CASE_SUBMISSION_ROLES."},
            },
            {
                "code": "RBAC-04", "name": "Medical Requirement Waiver", "priority": 4, "operator": "ALL",
                "conditions": [
                    {"field": "action", "operator": "eq", "value": "medical_waiver"},
                    {"field": "role", "operator": "in", "value": ["Underwriter", "Admin", "SuperAdmin"]},
                ],
                "action_outcome": "ALLOW",
                "outcome_payload": {"terminal": True, "reason": "medical_exam.py:_WAIVER_ROLES."},
            },
            {
                "code": "RBAC-05", "name": "Reinsurance Referral", "priority": 5, "operator": "ALL",
                "conditions": [
                    {"field": "action", "operator": "eq", "value": "reinsurance_referral"},
                    {"field": "role", "operator": "in", "value": ["Underwriter", "Admin", "SuperAdmin"]},
                ],
                "action_outcome": "ALLOW",
                "outcome_payload": {"terminal": True, "reason": "reinsurance.py:_REINSURANCE_ROLES."},
            },
            {
                "code": "RBAC-06", "name": "Insurance History Override", "priority": 6, "operator": "ALL",
                "conditions": [
                    {"field": "action", "operator": "eq", "value": "insurance_history_override"},
                    {"field": "role", "operator": "in", "value": ["Underwriter", "Admin", "SuperAdmin"]},
                ],
                "action_outcome": "ALLOW",
                "outcome_payload": {"terminal": True, "reason": "insurance_history.py:_OVERRIDE_ROLES."},
            },
            {
                "code": "RBAC-DENY", "name": "Deny", "priority": 99, "operator": "ALL",
                "conditions": [],
                "action_outcome": "DECLINE",
                "outcome_payload": {"reason": "No ALLOW rule matched this action for this role."},
            },
        ],
    },
    {
        "code": "RS-REI-001",
        "name": "Self-Retention & Treaty Capacity",
        "description": "Age-banded net retention and automatic treaty capacity. Generated from services/underwriting_limits.py:RETENTION_AGE_SCALING x RETENTION_LIMIT x TREATY_LINES.",
        "category_code": "REINSURANCE", "sub_code": "SELF_RETENTION", "sub_name": "Self-Retention Grid",
        "scope_type": "GLOBAL", "channel_code": None,
        "rules": _build_retention_rules(),
    },
    {
        "code": "RS-REI-002",
        "name": "Facultative Referral Decision",
        "description": "Whether a case must be referred to a reinsurer facultatively.",
        "category_code": "REINSURANCE", "sub_code": "FACULTATIVE_REFERRAL", "sub_name": "Facultative Referral",
        "scope_type": "GLOBAL", "channel_code": None,
        "rules": [
            {
                "code": "REINS-REF-01", "name": "Facultative Referral Required", "priority": 1, "operator": "ALL",
                "conditions": [{"field": "facultative_required", "operator": "boolean", "value": True}],
                "action_outcome": "REINSURANCE_FACULTATIVE",
                "outcome_payload": {"terminal": True, "reason": "Sum at risk exceeds retention + automatic treaty capacity; reinsurer must underwrite the excess before approval."},
            },
            {
                "code": "REINS-REF-02", "name": "Retained / Automatic Treaty", "priority": 99, "operator": "ALL",
                "conditions": [],
                "action_outcome": "AUTO_APPROVE",
                "outcome_payload": {"reason": "Fully covered by net retention and/or automatic treaty capacity — no reinsurer referral required."},
            },
        ],
    },
    {
        "code": "RS-PRC-002",
        "name": "Occupational Hazard Loading",
        "description": "Extra-mortality loading by occupational hazard class. The keyword list and loading percentages are illustrative and should get actuarial confirmation before use in live pricing.",
        "category_code": "PRICING", "sub_code": "OCCUPATIONAL_HAZARD", "sub_name": "Occupational Hazard Loadings",
        "scope_type": "GLOBAL", "channel_code": None,
        "rules": [
            {
                "code": "OCC-04", "name": "Extra Hazardous Occupation", "priority": 1, "operator": "ANY",
                "conditions": [
                    {"field": "occupation", "operator": "contains", "value": kw} for kw in [
                        "miner", "mining", "offshore", "oil rig", "pilot", "air crew", "aircrew",
                        "armed forces", "military", "bomb disposal", "explosive", "demolition", "diver",
                    ]
                ],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {"terminal": True, "loading_pct": 100.0, "occupation_class": 4, "reason": "Extra-hazardous occupation class — highest mortality loading."},
            },
            {
                "code": "OCC-03", "name": "Hazardous Occupation", "priority": 2, "operator": "ANY",
                "conditions": [
                    {"field": "occupation", "operator": "contains", "value": kw} for kw in [
                        "construction", "fisherman", "fishing", "security guard", "firefighter",
                        "fire fighter", "electrician", "crane operator", "welder", "police",
                    ]
                ],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {"terminal": True, "loading_pct": 50.0, "occupation_class": 3, "reason": "Hazardous occupation class — elevated mortality loading."},
            },
            {
                "code": "OCC-02", "name": "Moderate Risk Occupation", "priority": 3, "operator": "ANY",
                "conditions": [
                    {"field": "occupation", "operator": "contains", "value": kw} for kw in [
                        "driver", "factory", "mechanic", "warehouse",
                    ]
                ],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {"terminal": True, "loading_pct": 15.0, "occupation_class": 2, "reason": "Moderate-risk occupation class — small mortality loading."},
            },
            {
                "code": "OCC-01", "name": "Standard Occupation", "priority": 99, "operator": "ALL",
                "conditions": [],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {"loading_pct": 0.0, "occupation_class": 1, "reason": "Standard occupation class — no occupational loading."},
            },
        ],
    },
    {
        "code": "RS-CLM-001",
        "name": "Claims Auto-Adjudication",
        "description": "Rules for automated claims triage, fraud detection, and adjuster threshold limits.",
        "category_code": "CLAIMS_ADJUDICATION", "sub_code": "CLAIM_TRIAGE", "sub_name": "Claims Triage & Thresholds",
        "scope_type": "GLOBAL", "channel_code": None,
        "rules": [
            {
                "code": "CLM-ADJ-01", "name": "Low Value Fast-Track Auto-Approve", "priority": 1, "operator": "ALL",
                "conditions": [
                    {"field": "submitted_amount", "operator": "lte", "value": 100000},
                    {"field": "fraud_probability", "operator": "lt", "value": 0.15},
                    {"field": "duplicate_flag", "operator": "boolean", "value": False},
                ],
                "action_outcome": "AUTO_APPROVE",
                "outcome_payload": {"terminal": True, "reason": "Claim under PKR 100,000 with low fraud score automatically approved for payout."},
            },
            {
                "code": "CLM-ADJ-02", "name": "High Fraud Score Investigation", "priority": 2, "operator": "ALL",
                "conditions": [{"field": "fraud_probability", "operator": "gte", "value": 0.70}],
                "action_outcome": "FLAG_FOR_INVESTIGATION",
                "outcome_payload": {"terminal": True, "reason": "High fraud probability score (>= 70%). Special investigation unit review required."},
            },
            {
                "code": "CLM-ADJ-03", "name": "High Value Manager Referral", "priority": 3, "operator": "ALL",
                "conditions": [{"field": "submitted_amount", "operator": "gt", "value": 2000000}],
                "action_outcome": "REFER_TO_MANAGER",
                "outcome_payload": {"terminal": True, "reason": "Claim amount exceeds PKR 2,000,000 adjuster limit. Manager approval mandatory."},
            },
        ],
    },
]

# Category.code -> display name, 1:1 with the retired RuleDomainEnum values.
_CATEGORY_SEED = [
    ("ELIGIBILITY", "Eligibility & Policy Limits"),
    ("PRICING", "Pricing & Risk Loadings"),
    ("UNDERWRITING_GATES", "Pre-Underwriting Clearance Gates"),
    ("COMPLIANCE_AML", "AML & Sanctions Compliance"),
    ("MEDICAL_NML", "Medical Examination Limits"),
    ("INSURANCE_HISTORY", "Insurance & Financial History"),
    ("COMMISSION_SECP", "SECP Statutory Commission Rates"),
    ("RBAC_AUTHORIZATION", "Role Authorization Rules"),
    ("AI_DECISION_BANDS", "AI Underwriting Risk Bands"),
    ("REINSURANCE", "Reinsurance & Retention"),
    ("CLAIMS_ADJUDICATION", "Claims Auto-Adjudication"),
]

# channel_code -> (min_entry_age, max_entry_age, max_maturity_age, min_sum_assured)
# Real seeded partner banks (services/tenant-service/seeds/insurance_plans_seed.py).
_ELIGIBILITY_SEED = {
    "AGENCY_DIRECT": (18, 65, 75, 500000.0),
    "BANCASSURANCE_MCB": (18, 60, 70, 500000.0),
    "BANCASSURANCE_ALFALAH": (18, 60, 70, 500000.0),
    "BANCASSURANCE_KHUSHHALI": (18, 59, 65, 100000.0),
    "BANCASSURANCE_MOBILINK": (18, 59, 65, 100000.0),
    "WINDOW_TAKAFUL": (18, 65, 75, 500000.0),
}


async def _get_or_create_category(session: AsyncSession, code: str, name: str) -> Category:
    existing = (await session.exec(select(Category).where(Category.code == code))).first()
    if existing:
        return existing
    cat = Category(code=code, name=name)
    session.add(cat)
    await session.commit()
    await session.refresh(cat)
    return cat


async def _get_or_create_subcategory(session: AsyncSession, category_id: UUID, code: str, name: str) -> SubCategory:
    existing = (
        await session.exec(
            select(SubCategory).where(SubCategory.category_id == category_id, SubCategory.code == code)
        )
    ).first()
    if existing:
        return existing
    sub = SubCategory(category_id=category_id, code=code, name=name)
    session.add(sub)
    await session.commit()
    await session.refresh(sub)
    return sub


async def _get_or_create_eligibility(session: AsyncSession, subcategory_id: UUID, channel_code: str) -> EligibilityProfile:
    existing = (
        await session.exec(
            select(EligibilityProfile).where(
                EligibilityProfile.subcategory_id == subcategory_id,
                EligibilityProfile.channel_code == channel_code,
            )
        )
    ).first()
    if existing:
        return existing
    band = _ELIGIBILITY_SEED.get(channel_code, _ELIGIBILITY_SEED["AGENCY_DIRECT"])
    profile = EligibilityProfile(
        subcategory_id=subcategory_id, channel_code=channel_code,
        min_entry_age=band[0], max_entry_age=band[1], max_maturity_age=band[2], min_sum_assured=band[3],
    )
    session.add(profile)
    await session.commit()
    await session.refresh(profile)
    return profile


async def seed_rules_if_empty(session: AsyncSession):
    """Populates the full v2.1 hierarchy + baseline rule catalogue if the
    hierarchy is empty. On a DB that went through migrate.py's
    _migrate_rule_engine_v2(), rule_categories is already populated, so this
    is a no-op there — it only runs on a genuinely fresh install."""
    res = await session.exec(select(Category))
    if res.first() is not None:
        return

    categories = {code: await _get_or_create_category(session, code, name) for code, name in _CATEGORY_SEED}
    subcategories: Dict[tuple, SubCategory] = {}

    for rs_data in _DEFAULT_RULE_SETS:
        category = categories[rs_data["category_code"]]
        sub_key = (rs_data["category_code"], rs_data["sub_code"])
        if sub_key not in subcategories:
            subcategories[sub_key] = await _get_or_create_subcategory(
                session, category.id, rs_data["sub_code"], rs_data["sub_name"]
            )
        subcategory = subcategories[sub_key]

        eligibility_id = None
        if rs_data["scope_type"] == "CHANNEL_PRODUCT" and rs_data.get("channel_code"):
            profile = await _get_or_create_eligibility(session, subcategory.id, rs_data["channel_code"])
            eligibility_id = profile.id

        rule_set = RuleSet(
            scope_type=ScopeTypeEnum(rs_data["scope_type"]),
            subcategory_id=subcategory.id,
            eligibility_id=eligibility_id,
            rule_code=rs_data["code"],
            name=rs_data["name"],
            description=rs_data["description"],
            is_active=True,
        )
        session.add(rule_set)
        await session.commit()
        await session.refresh(rule_set)

        version = RuleVersion(
            rule_set_id=rule_set.id,
            version_number="1.0.0",
            status=RuleVersionStatusEnum.ACTIVE,
            authored_by="System Baseline",
            approved_by="Compliance Office",
            notes="Initial statutory and operational rule baseline.",
        )
        session.add(version)
        await session.commit()
        await session.refresh(version)

        for old_rule in rs_data["rules"]:
            converted = _convert_seed_rule(old_rule)
            rule = ActualRule(
                version_id=version.id,
                rule_code=converted["rule_code"],
                name=converted["name"],
                priority=converted["priority"],
                is_active=True,
                impact_type=ImpactTypeEnum(converted["impact_type"]),
                impact_data=converted["impact_data"],
                action_outcome=converted["action_outcome"],
            )
            session.add(rule)
            await session.commit()
            await session.refresh(rule)

            for c in converted["criteria"]:
                session.add(RuleCriteria(
                    rule_id=rule.id,
                    group_id=c["group_id"],
                    field_name=c["field_name"],
                    operator=c["operator"],
                    value_numeric=c.get("value_numeric"),
                    value_string=c.get("value_string"),
                    value_range_min=c.get("value_range_min"),
                    value_range_max=c.get("value_range_max"),
                    value_list=c.get("value_list"),
                ))
            await session.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Request / Response Schemas
# ─────────────────────────────────────────────────────────────────────────────

class EvaluateRuleRequest(BaseModel):
    rule_set_code: str
    context: Dict[str, Any] = PydanticField(default_factory=dict)
    proposal_id: Optional[str] = None
    case_id: Optional[str] = None  # deprecated alias for proposal_id
    actor: Optional[str] = "Portal Admin"
    # Step-1 context derivation (TSAR/HLV/channel) — when either is given,
    # ContextDerivationService.derive() runs first and `context` is layered
    # on top as caller-supplied overrides (see rule_evaluator.py).
    customer_id: Optional[UUID] = None
    cnic: Optional[str] = None
    proposed_sum_assured: float = 0.0
    exclude_policy_id: Optional[UUID] = None


class EvaluateScopeRequest(BaseModel):
    subcategory_code: str
    channel_code: Optional[str] = None
    context: Dict[str, Any] = PydanticField(default_factory=dict)
    proposal_id: Optional[str] = None
    actor: Optional[str] = "Portal Admin"
    customer_id: Optional[UUID] = None
    cnic: Optional[str] = None
    proposed_sum_assured: float = 0.0
    exclude_policy_id: Optional[UUID] = None


class CategoryCreateRequest(BaseModel):
    code: str
    name: str
    description: Optional[str] = ""


class SubCategoryCreateRequest(BaseModel):
    code: str
    name: str


class EligibilityProfileCreateRequest(BaseModel):
    channel_code: str
    min_entry_age: int = 18
    max_entry_age: int = 65
    max_maturity_age: int = 75
    min_sum_assured: float = 500000.0


class RuleSetCreateRequest(BaseModel):
    rule_code: str
    name: str
    description: Optional[str] = ""
    scope_type: ScopeTypeEnum = ScopeTypeEnum.CHANNEL_PRODUCT
    subcategory_id: UUID
    eligibility_id: Optional[UUID] = None


class ActuarialImpactDetailIn(BaseModel):
    extra_mortality_pct: float = 0.0
    flat_extra_per_thousand: float = 0.0
    medical_profile_codes: List[str] = PydanticField(default_factory=list)
    hlv_max_multiple: Optional[float] = None
    reinsurance_retention_limit: Optional[float] = None
    underwriter_authority_level: Optional[int] = None
    exclusion_riders: List[str] = PydanticField(default_factory=list)
    is_terminal: bool = False
    commission_pct: Optional[float] = None
    withholding_tax_pct: Optional[float] = None


class RuleCriteriaCreate(BaseModel):
    group_id: int = 1
    field_name: str
    operator: str
    value_numeric: Optional[float] = None
    value_string: Optional[str] = None
    value_range_min: Optional[float] = None
    value_range_max: Optional[float] = None
    value_list: Optional[List[Any]] = None
    target_field_name: Optional[str] = None
    target_multiplier: float = 1.0


class RuleCreateRequest(BaseModel):
    name: str
    rule_code: Optional[str] = None
    priority: int = 100
    is_active: bool = True
    impact_type: ImpactTypeEnum
    impact_data: ActuarialImpactDetailIn = PydanticField(default_factory=ActuarialImpactDetailIn)
    action_outcome: str = ""
    criteria: List[RuleCriteriaCreate] = PydanticField(default_factory=list)


class RuleUpdateRequest(BaseModel):
    name: Optional[str] = None
    priority: Optional[int] = None
    is_active: Optional[bool] = None
    impact_type: Optional[ImpactTypeEnum] = None
    impact_data: Optional[ActuarialImpactDetailIn] = None
    action_outcome: Optional[str] = None
    criteria: Optional[List[RuleCriteriaCreate]] = None


class VersionStatusRequest(BaseModel):
    status: RuleVersionStatusEnum
    approved_by: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# Hierarchy endpoints
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/categories", summary="List the Category -> SubCategory -> EligibilityProfile hierarchy")
async def list_categories(tenant_id: UUID, session: AsyncSession = Depends(get_session)):
    await seed_rules_if_empty(session)
    categories = (await session.exec(select(Category).order_by(Category.code))).all()
    output = []
    for cat in categories:
        subs = (await session.exec(select(SubCategory).where(SubCategory.category_id == cat.id))).all()
        sub_out = []
        for sub in subs:
            profiles = (await session.exec(select(EligibilityProfile).where(EligibilityProfile.subcategory_id == sub.id))).all()
            sub_out.append({
                "id": str(sub.id), "code": sub.code, "name": sub.name,
                "eligibility_profiles": [
                    {
                        "id": str(p.id), "channel_code": p.channel_code,
                        "min_entry_age": p.min_entry_age, "max_entry_age": p.max_entry_age,
                        "max_maturity_age": p.max_maturity_age, "min_sum_assured": p.min_sum_assured,
                    }
                    for p in profiles
                ],
            })
        output.append({"id": str(cat.id), "code": cat.code, "name": cat.name, "description": cat.description, "subcategories": sub_out})
    return output


@router.post("/categories", status_code=status.HTTP_201_CREATED, summary="Create a Category")
async def create_category(tenant_id: UUID, body: CategoryCreateRequest, session: AsyncSession = Depends(get_session)):
    existing = (await session.exec(select(Category).where(Category.code == body.code))).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Category code '{body.code}' already exists.")
    cat = Category(code=body.code, name=body.name, description=body.description or "")
    session.add(cat)
    await session.commit()
    await session.refresh(cat)
    return {"id": str(cat.id), "code": cat.code}


@router.post("/categories/{category_id}/subcategories", status_code=status.HTTP_201_CREATED, summary="Create a SubCategory")
async def create_subcategory(tenant_id: UUID, category_id: UUID, body: SubCategoryCreateRequest, session: AsyncSession = Depends(get_session)):
    category = await session.get(Category, category_id)
    if not category:
        raise HTTPException(status_code=404, detail="Category not found.")
    sub = SubCategory(category_id=category_id, code=body.code, name=body.name)
    session.add(sub)
    await session.commit()
    await session.refresh(sub)
    return {"id": str(sub.id), "code": sub.code}


@router.post("/subcategories/{subcategory_id}/eligibility-profiles", status_code=status.HTTP_201_CREATED, summary="Create an EligibilityProfile")
async def create_eligibility_profile(tenant_id: UUID, subcategory_id: UUID, body: EligibilityProfileCreateRequest, session: AsyncSession = Depends(get_session)):
    subcategory = await session.get(SubCategory, subcategory_id)
    if not subcategory:
        raise HTTPException(status_code=404, detail="SubCategory not found.")
    profile = EligibilityProfile(
        subcategory_id=subcategory_id, channel_code=body.channel_code,
        min_entry_age=body.min_entry_age, max_entry_age=body.max_entry_age,
        max_maturity_age=body.max_maturity_age, min_sum_assured=body.min_sum_assured,
    )
    session.add(profile)
    await session.commit()
    await session.refresh(profile)
    return {"id": str(profile.id), "channel_code": profile.channel_code}


@router.delete("/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a Category")
async def delete_category(tenant_id: UUID, category_id: UUID, session: AsyncSession = Depends(get_session)):
    subs = (await session.exec(select(SubCategory).where(SubCategory.category_id == category_id))).all()
    if subs:
        raise HTTPException(status_code=400, detail="Cannot delete a Category that still has SubCategories.")
    category = await session.get(Category, category_id)
    if category:
        await session.delete(category)
        await session.commit()
    return None


@router.delete("/subcategories/{subcategory_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a SubCategory")
async def delete_subcategory(tenant_id: UUID, subcategory_id: UUID, session: AsyncSession = Depends(get_session)):
    in_use = (await session.exec(select(RuleSet).where(RuleSet.subcategory_id == subcategory_id))).first()
    if in_use:
        raise HTTPException(status_code=400, detail="Cannot delete a SubCategory that still has RuleSets.")
    sub = await session.get(SubCategory, subcategory_id)
    if sub:
        await session.delete(sub)
        await session.commit()
    return None


# ─────────────────────────────────────────────────────────────────────────────
# RuleSet / RuleVersion / ActualRule endpoints
# ─────────────────────────────────────────────────────────────────────────────

async def _rule_set_hierarchy_labels(session: AsyncSession, rule_set: RuleSet):
    subcategory = await session.get(SubCategory, rule_set.subcategory_id)
    category = await session.get(Category, subcategory.category_id) if subcategory else None
    eligibility = await session.get(EligibilityProfile, rule_set.eligibility_id) if rule_set.eligibility_id else None
    return category, subcategory, eligibility


@router.get("/sets", summary="List rule sets")
async def list_rule_sets(
    tenant_id: UUID,
    category: Optional[str] = None,
    subcategory: Optional[str] = None,
    channel: Optional[str] = None,
    scope_type: Optional[ScopeTypeEnum] = None,
    session: AsyncSession = Depends(get_session),
):
    await seed_rules_if_empty(session)
    query = select(RuleSet).where((RuleSet.tenant_id == tenant_id) | (RuleSet.tenant_id == None))  # noqa: E711
    if scope_type:
        query = query.where(RuleSet.scope_type == scope_type)
    res = await session.exec(query)
    rule_sets = res.all()

    output = []
    for rs in rule_sets:
        cat, sub, elig = await _rule_set_hierarchy_labels(session, rs)
        if category and (not cat or cat.code != category):
            continue
        if subcategory and (not sub or sub.code != subcategory):
            continue
        if channel and (not elig or elig.channel_code != channel):
            continue

        ver_res = await session.exec(
            select(RuleVersion).where(RuleVersion.rule_set_id == rs.id).order_by(RuleVersion.created_at.desc())
        )
        versions = ver_res.all()
        active_ver = next((v for v in versions if v.status == RuleVersionStatusEnum.ACTIVE), None)
        rule_count = 0
        if active_ver:
            rule_res = await session.exec(select(ActualRule).where(ActualRule.version_id == active_ver.id))
            rule_count = len(rule_res.all())

        output.append({
            "id": str(rs.id),
            "rule_code": rs.rule_code,
            "name": rs.name,
            "description": rs.description,
            "scope_type": rs.scope_type,
            "category_code": cat.code if cat else None,
            "subcategory_code": sub.code if sub else None,
            "channel_code": elig.channel_code if elig else None,
            "is_active": rs.is_active,
            "active_version_number": active_ver.version_number if active_ver else None,
            "active_version_status": active_ver.status if active_ver else "NO_VERSION",
            "version_count": len(versions),
            "rule_count": rule_count,
            "updated_at": rs.updated_at.isoformat(),
        })
    return output


@router.post("/sets", status_code=status.HTTP_201_CREATED, summary="Create a new rule set")
async def create_rule_set(tenant_id: UUID, body: RuleSetCreateRequest, session: AsyncSession = Depends(get_session)):
    existing = (await session.exec(select(RuleSet).where(RuleSet.rule_code == body.rule_code))).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Rule set code '{body.rule_code}' already exists.")
    if body.scope_type != ScopeTypeEnum.GLOBAL and not body.eligibility_id:
        raise HTTPException(status_code=400, detail="eligibility_id is required unless scope_type is GLOBAL.")
    subcategory = await session.get(SubCategory, body.subcategory_id)
    if not subcategory:
        raise HTTPException(status_code=404, detail="SubCategory not found.")

    rule_set = RuleSet(
        tenant_id=tenant_id,
        scope_type=body.scope_type,
        subcategory_id=body.subcategory_id,
        eligibility_id=body.eligibility_id if body.scope_type != ScopeTypeEnum.GLOBAL else None,
        rule_code=body.rule_code,
        name=body.name,
        description=body.description or "",
    )
    session.add(rule_set)
    await session.commit()
    await session.refresh(rule_set)

    version = RuleVersion(rule_set_id=rule_set.id, version_number="1.0.0", status=RuleVersionStatusEnum.DRAFT, authored_by="Admin")
    session.add(version)
    await session.commit()

    return {"id": str(rule_set.id), "rule_code": rule_set.rule_code, "message": "Rule set created successfully."}


@router.get("/sets/{rule_set_id}", summary="Get detailed rule set with rules, criteria, and versions")
async def get_rule_set_detail(tenant_id: UUID, rule_set_id: UUID, session: AsyncSession = Depends(get_session)):
    rule_set = await session.get(RuleSet, rule_set_id)
    if not rule_set:
        raise HTTPException(status_code=404, detail="Rule set not found.")

    cat, sub, elig = await _rule_set_hierarchy_labels(session, rule_set)

    ver_res = await session.exec(
        select(RuleVersion).where(RuleVersion.rule_set_id == rule_set.id).order_by(RuleVersion.created_at.desc())
    )
    versions = ver_res.all()

    versions_data = []
    for v in versions:
        rules_res = await session.exec(
            select(ActualRule).where(ActualRule.version_id == v.id).order_by(ActualRule.priority.asc())
        )
        rules = rules_res.all()

        rules_data = []
        for r in rules:
            crit_res = await session.exec(select(RuleCriteria).where(RuleCriteria.rule_id == r.id))
            criteria = crit_res.all()
            rules_data.append({
                "id": str(r.id),
                "rule_code": r.rule_code,
                "name": r.name,
                "priority": r.priority,
                "is_active": r.is_active,
                "affected_from": r.affected_from.isoformat() if r.affected_from else None,
                "affected_to": r.affected_to.isoformat() if r.affected_to else None,
                "impact_type": r.impact_type,
                "impact_data": r.impact_data,
                "action_outcome": r.action_outcome,
                "criteria": [
                    {
                        "id": str(c.id), "group_id": c.group_id, "field_name": c.field_name, "operator": c.operator,
                        "value_numeric": c.value_numeric, "value_string": c.value_string,
                        "value_range_min": c.value_range_min, "value_range_max": c.value_range_max,
                        "value_list": c.value_list, "target_field_name": c.target_field_name,
                        "target_multiplier": c.target_multiplier,
                    }
                    for c in criteria
                ],
            })

        versions_data.append({
            "id": str(v.id),
            "version_number": v.version_number,
            "status": v.status,
            "effective_from": v.effective_from.isoformat(),
            "effective_to": v.effective_to.isoformat() if v.effective_to else None,
            "authored_by": v.authored_by,
            "approved_by": v.approved_by,
            "notes": v.notes,
            "rules": rules_data,
        })

    return {
        "id": str(rule_set.id),
        "rule_code": rule_set.rule_code,
        "name": rule_set.name,
        "description": rule_set.description,
        "scope_type": rule_set.scope_type,
        "category_code": cat.code if cat else None,
        "subcategory_code": sub.code if sub else None,
        "channel_code": elig.channel_code if elig else None,
        "is_active": rule_set.is_active,
        "versions": versions_data,
    }


@router.post("/sets/{rule_set_id}/versions", status_code=status.HTTP_201_CREATED, summary="Create a new draft version")
async def create_rule_version(tenant_id: UUID, rule_set_id: UUID, session: AsyncSession = Depends(get_session)):
    rule_set = await session.get(RuleSet, rule_set_id)
    if not rule_set:
        raise HTTPException(status_code=404, detail="Rule set not found.")

    latest = (
        await session.exec(
            select(RuleVersion).where(RuleVersion.rule_set_id == rule_set.id).order_by(RuleVersion.created_at.desc())
        )
    ).first()

    def _next_version(v: Optional[str]) -> str:
        if not v:
            return "1.0.0"
        parts = v.split(".")
        try:
            parts[0] = str(int(parts[0]) + 1)
        except (ValueError, IndexError):
            return "1.0.0"
        return ".".join(parts) if len(parts) == 3 else f"{parts[0]}.0.0"

    new_version = RuleVersion(
        rule_set_id=rule_set.id,
        version_number=_next_version(latest.version_number if latest else None),
        status=RuleVersionStatusEnum.DRAFT,
        authored_by="Admin",
    )
    session.add(new_version)
    await session.commit()
    await session.refresh(new_version)

    if latest:
        prev_rules = (await session.exec(select(ActualRule).where(ActualRule.version_id == latest.id))).all()
        for r in prev_rules:
            new_rule = ActualRule(
                version_id=new_version.id, rule_code=r.rule_code, name=r.name, priority=r.priority,
                is_active=r.is_active, impact_type=r.impact_type, impact_data=r.impact_data,
                action_outcome=r.action_outcome,
            )
            session.add(new_rule)
            await session.commit()
            await session.refresh(new_rule)

            prev_criteria = (await session.exec(select(RuleCriteria).where(RuleCriteria.rule_id == r.id))).all()
            for c in prev_criteria:
                session.add(RuleCriteria(
                    rule_id=new_rule.id, group_id=c.group_id, field_name=c.field_name, operator=c.operator,
                    value_numeric=c.value_numeric, value_string=c.value_string,
                    value_range_min=c.value_range_min, value_range_max=c.value_range_max,
                    value_list=c.value_list, target_field_name=c.target_field_name, target_multiplier=c.target_multiplier,
                ))
            await session.commit()

    return {"id": str(new_version.id), "version_number": new_version.version_number, "status": new_version.status}


@router.patch("/versions/{version_id}/status", summary="Update version status (Deploy/Archive)")
async def update_version_status(tenant_id: UUID, version_id: UUID, body: VersionStatusRequest, session: AsyncSession = Depends(get_session)):
    version = await session.get(RuleVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail="Rule version not found.")

    if body.status == RuleVersionStatusEnum.ACTIVE:
        active_versions = (
            await session.exec(
                select(RuleVersion)
                .where(RuleVersion.rule_set_id == version.rule_set_id)
                .where(RuleVersion.status == RuleVersionStatusEnum.ACTIVE)
            )
        ).all()
        for av in active_versions:
            av.status = RuleVersionStatusEnum.ARCHIVED
            av.effective_to = datetime.utcnow()
            session.add(av)

        version.status = RuleVersionStatusEnum.ACTIVE
        version.approved_by = body.approved_by or "Compliance Officer"
        version.effective_from = datetime.utcnow()
    else:
        version.status = body.status

    session.add(version)
    await session.commit()
    return {"id": str(version.id), "status": version.status}


@router.post("/versions/{version_id}/rules", status_code=status.HTTP_201_CREATED, summary="Add a rule to a DRAFT version")
async def add_rule_to_version(tenant_id: UUID, version_id: UUID, body: RuleCreateRequest, session: AsyncSession = Depends(get_session)):
    version = await session.get(RuleVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail="Rule version not found.")
    if version.status != RuleVersionStatusEnum.DRAFT:
        raise HTTPException(status_code=400, detail="Can only add rules to DRAFT versions.")

    rule = ActualRule(
        version_id=version.id,
        rule_code=body.rule_code or f"RULE-{uuid4().hex[:8]}",
        name=body.name,
        priority=body.priority,
        is_active=body.is_active,
        impact_type=body.impact_type,
        impact_data=body.impact_data.model_dump(),
        action_outcome=body.action_outcome,
    )
    session.add(rule)
    await session.commit()
    await session.refresh(rule)

    for c in body.criteria:
        session.add(RuleCriteria(
            rule_id=rule.id, group_id=c.group_id, field_name=c.field_name, operator=c.operator,
            value_numeric=c.value_numeric, value_string=c.value_string,
            value_range_min=c.value_range_min, value_range_max=c.value_range_max,
            value_list=c.value_list, target_field_name=c.target_field_name, target_multiplier=c.target_multiplier,
        ))
    await session.commit()

    return {"id": str(rule.id), "rule_code": rule.rule_code, "priority": rule.priority}


@router.put("/versions/{version_id}/rules/{rule_id}", summary="Update a rule (DRAFT versions only)")
async def update_rule(tenant_id: UUID, version_id: UUID, rule_id: UUID, body: RuleUpdateRequest, session: AsyncSession = Depends(get_session)):
    rule = await session.get(ActualRule, rule_id)
    if not rule or rule.version_id != version_id:
        raise HTTPException(status_code=404, detail="Rule not found.")

    version = await session.get(RuleVersion, version_id)
    if not version or version.status != RuleVersionStatusEnum.DRAFT:
        raise HTTPException(status_code=400, detail="Can only edit rules in DRAFT versions.")

    update_data = body.model_dump(exclude_unset=True, exclude={"criteria", "impact_data"})
    for key, value in update_data.items():
        setattr(rule, key, value)
    if body.impact_data is not None:
        rule.impact_data = body.impact_data.model_dump()

    session.add(rule)
    await session.commit()

    if body.criteria is not None:
        existing = (await session.exec(select(RuleCriteria).where(RuleCriteria.rule_id == rule.id))).all()
        for c in existing:
            await session.delete(c)
        await session.commit()
        for c in body.criteria:
            session.add(RuleCriteria(
                rule_id=rule.id, group_id=c.group_id, field_name=c.field_name, operator=c.operator,
                value_numeric=c.value_numeric, value_string=c.value_string,
                value_range_min=c.value_range_min, value_range_max=c.value_range_max,
                value_list=c.value_list, target_field_name=c.target_field_name, target_multiplier=c.target_multiplier,
            ))
        await session.commit()

    return {"message": "Rule updated successfully", "rule_id": str(rule.id)}


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a rule")
async def delete_rule(tenant_id: UUID, rule_id: UUID, session: AsyncSession = Depends(get_session)):
    rule = await session.get(ActualRule, rule_id)
    if rule:
        criteria = (await session.exec(select(RuleCriteria).where(RuleCriteria.rule_id == rule.id))).all()
        for c in criteria:
            await session.delete(c)
        await session.delete(rule)
        await session.commit()
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Evaluation + audit
# ─────────────────────────────────────────────────────────────────────────────

async def _resolve_context(tenant_id: UUID, session: AsyncSession, body) -> Dict[str, Any]:
    if not body.customer_id and not body.cnic:
        return body.context
    return await ContextDerivationService(session, tenant_id).derive(
        customer_id=body.customer_id,
        cnic=body.cnic,
        proposed_sum_assured=body.proposed_sum_assured,
        exclude_policy_id=body.exclude_policy_id,
        extra_context=body.context,
    )


@router.post("/evaluate", summary="Evaluate a single rule set (by code) against input context")
async def evaluate_rule_endpoint(tenant_id: UUID, body: EvaluateRuleRequest, session: AsyncSession = Depends(get_session)):
    context = await _resolve_context(tenant_id, session, body)
    return await evaluate_rule_set(
        session=session,
        rule_set_code=body.rule_set_code,
        context=context,
        tenant_id=tenant_id,
        proposal_id=body.proposal_id or body.case_id,
        actor=body.actor or "Portal Admin",
    )


@router.post("/evaluate-scope", summary="Evaluate every rule set in scope for a category/subcategory/channel")
async def evaluate_scope_endpoint(tenant_id: UUID, body: EvaluateScopeRequest, session: AsyncSession = Depends(get_session)):
    context = await _resolve_context(tenant_id, session, body)
    return await evaluate_scope(
        session=session,
        tenant_id=tenant_id,
        subcategory_code=body.subcategory_code,
        channel_code=body.channel_code,
        context=context,
        proposal_id=body.proposal_id,
        actor=body.actor or "Portal Admin",
    )


@router.get("/logs", summary="Get rule evaluation audit logs")
async def list_rule_evaluation_logs(tenant_id: UUID, limit: int = Query(default=50, le=200), session: AsyncSession = Depends(get_session)):
    query = (
        select(RuleEvaluationLog)
        .where((RuleEvaluationLog.tenant_id == tenant_id) | (RuleEvaluationLog.tenant_id == None))  # noqa: E711
        .order_by(RuleEvaluationLog.evaluated_at.desc())
        .limit(limit)
    )
    logs = (await session.exec(query)).all()

    return [
        {
            "id": str(log.id),
            "rule_set_code": log.rule_set_code,
            "version_number": log.version_number,
            "proposal_id": log.proposal_id,
            "customer_cnic": log.customer_cnic,
            "category_code": log.category_code,
            "subcategory_code": log.subcategory_code,
            "channel_code": log.channel_code,
            "actor": log.actor,
            "input_context_snapshot": log.input_context_snapshot,
            "tsar_accumulated": log.tsar_accumulated,
            "matched_rule_codes": log.matched_rule_codes,
            "final_impacts": log.final_impacts,
            "reasons": log.reasons,
            "execution_duration_ms": log.execution_duration_ms,
            "evaluated_at": log.evaluated_at.isoformat(),
        }
        for log in logs
    ]
