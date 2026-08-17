"""
Rule Engine Router — API endpoints for managing decision tables, rule sets,
rule versioning, live evaluation, and audit trails across the 9 taxonomy domains.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from rule_evaluator import evaluate_rule_set
from services.underwriting_limits import (
    HLV_MULTIPLES,
    NON_MEDICAL_LIMITS,
    RETENTION_AGE_SCALING,
    RETENTION_LIMIT,
    TREATY_LINES,
)
from shared.models.core import (
    BusinessRule,
    RuleDomainEnum,
    RuleEvaluationLog,
    RuleSet,
    RuleVersion,
    RuleVersionStatusEnum,
)

router = APIRouter(prefix="/tenants/{tenant_id}/rules", tags=["Rule Engine"])


# ─────────────────────────────────────────────────────────────────────────────
# Baseline Seeder for System Rule Sets
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
            "description": "Every proposal above age 60 is medically underwritten, regardless of sum assured.",
            "category": "Medical Underwriting",
            "subcategory": "Non-Medical Limits",
            "eligibility_criteria": "Age >= 61",
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
            "description": "A Yes on the E-Application health questionnaire pulls a proposal into medicals even under the non-medical limit — disclosure overrides the grid.",
            "category": "Medical Underwriting",
            "subcategory": "Non-Medical Limits",
            "eligibility_criteria": "Has Adverse Disclosure",
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
            # (61, 120, 0) is already covered by MED-NML-00A above.
            continue
        rules.append({
            "code": f"MED-NML-{i:02d}",
            "name": f"Age {lo}-{hi} Over NML",
            "description": f"Ages {lo}-{hi}: aggregate sum at risk above PKR {limit:,.0f} exceeds the non-medical limit for this age band.",
            "category": "Medical Underwriting",
            "subcategory": "Non-Medical Limits",
            "eligibility_criteria": f"Age {lo}-{hi}, Sum Assured > {limit:,.0f}",
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
        "description": "Within the age-banded non-medical limit — no adverse disclosure, no medical examination required.",
        "category": "Medical Underwriting",
        "subcategory": "Non-Medical Limits",
        "eligibility_criteria": "Within age-banded NML, no adverse disclosure",
        "priority": 99,
        "operator": "ALL",
        "conditions": [],
        "action_outcome": "WAIVE_MEDICAL",
        "outcome_payload": {
            "reason": "Within the non-medical limit for this age band; no medical examination required.",
        },
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
            "description": f"Ages {lo}-{hi}: Human Life Value ceiling is {mult:g}x declared annual income.",
            "category": "Insurance History",
            "subcategory": "Human Life Value Ceiling",
            "eligibility_criteria": f"Age {lo}-{hi}",
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
            "description": f"Ages {lo}-{hi}: net retention PKR {retention:,.0f}, automatic treaty capacity PKR {treaty:,.0f} on top of it.",
            "category": "Reinsurance",
            "subcategory": "Self-Retention",
            "eligibility_criteria": f"Age {lo}-{hi}",
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


_DEFAULT_RULE_SETS = [
    {
        "code": "medical.nml_grid",
        "name": "Non-Medical Limits (NML)",
        "domain": RuleDomainEnum.MEDICAL_NML,
        "description": "Determines whether an applicant requires panel medical examination based on age and sum assured. Generated from services/underwriting_limits.py:NON_MEDICAL_LIMITS.",
        "rules": _build_nml_rules(),
    },
    {
        "code": "commission.secp_rate_card",
        "name": "SECP Commission Rates",
        "domain": RuleDomainEnum.COMMISSION_SECP,
        "description": "Statutory commission caps under SECP Insurance Rules 2017.",
        "rules": [
            {
                "code": "COM-IND-Y1",
                "name": "Individual Year 1",
                "description": "First-year statutory maximum commission for individual policies.",
                "category": "Commissions",
                "subcategory": "Individual Life",
                "eligibility_criteria": "Policy Year 1, Premium Type = First Year",
                "priority": 1,
                "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "eq", "value": "Individual"},
                    {"field": "policy_year", "operator": "eq", "value": 1},
                    {"field": "premium_type", "operator": "eq", "value": "FIRST_YEAR"},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {
                    "terminal": True,
                    "commission_pct": 35.0,
                    "withholding_tax_pct": 10.0,
                    "reason": "SECP Rule 24: Individual first-year statutory max 35%.",
                },
            },
            {
                "code": "COM-IND-Y2",
                "name": "Individual Year 2",
                "description": "Second-year statutory commission for individual policies.",
                "category": "Commissions",
                "subcategory": "Individual Life",
                "eligibility_criteria": "Policy Year 2, Premium Type = Renewal",
                "priority": 2,
                "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "eq", "value": "Individual"},
                    {"field": "policy_year", "operator": "eq", "value": 2},
                    {"field": "premium_type", "operator": "eq", "value": "RENEWAL"},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {
                    "terminal": True,
                    "commission_pct": 7.5,
                    "withholding_tax_pct": 10.0,
                    "reason": "SECP Rule 24: Individual 2nd year renewal 7.5%.",
                },
            },
            {
                "code": "COM-IND-Y3",
                "name": "Individual Year 3+",
                "description": "Third-year and onwards statutory commission for individual policies.",
                "category": "Commissions",
                "subcategory": "Individual Life",
                "eligibility_criteria": "Policy Year >= 3, Premium Type = Renewal",
                "priority": 3,
                "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "eq", "value": "Individual"},
                    {"field": "policy_year", "operator": "gte", "value": 3},
                    {"field": "premium_type", "operator": "eq", "value": "RENEWAL"},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {
                    "terminal": True,
                    "commission_pct": 5.0,
                    "withholding_tax_pct": 10.0,
                    "reason": "SECP Rule 24: Individual renewal 3rd year+ 5.0%.",
                },
            },
            {
                "code": "COM-IND-SP",
                "name": "Individual Single Premium",
                "description": "Upfront acquisition commission for single-premium individual policies.",
                "category": "Commissions",
                "subcategory": "Individual Life",
                "eligibility_criteria": "Premium Type = Single Premium",
                "priority": 4,
                "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "eq", "value": "Individual"},
                    {"field": "premium_type", "operator": "eq", "value": "SINGLE_PREMIUM"},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {
                    "terminal": True,
                    "commission_pct": 2.5,
                    "withholding_tax_pct": 10.0,
                    "reason": "Single premium upfront acquisition commission 2.5% (Adamjee Life 2024 Report — could not be independently verified against a public rate card; recommend actuarial confirmation).",
                },
            },
            {
                "code": "COM-GRP-Y1",
                "name": "Group Year 1",
                "description": "First-year commission rate for group/organization policies.",
                "category": "Commissions",
                "subcategory": "Group Life",
                "eligibility_criteria": "Group/Organization Category, Policy Year 1",
                "priority": 5,
                "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "in", "value": ["Group", "Organization"]},
                    {"field": "policy_year", "operator": "eq", "value": 1},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {
                    "terminal": True,
                    "commission_pct": 15.0,
                    "withholding_tax_pct": 10.0,
                    "reason": "SECP Rules 2017 Form LG: Group Corporate Life first-year commission 15%.",
                },
            },
            {
                "code": "COM-GRP-Y2",
                "name": "Group Renewal",
                "description": "Renewal (trail) commission rate for group/organization policies from year 2 onward.",
                "category": "Commissions",
                "subcategory": "Group Life",
                "eligibility_criteria": "Group/Organization Category, Policy Year >= 2",
                "priority": 6,
                "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "in", "value": ["Group", "Organization"]},
                    {"field": "policy_year", "operator": "gte", "value": 2},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {
                    "terminal": True,
                    "commission_pct": 3.0,
                    "withholding_tax_pct": 10.0,
                    "reason": "SECP Rules 2017 Form LG: Group Corporate Life renewal trail commission 3%.",
                },
            },
            {
                "code": "COM-TAK",
                "name": "Takaful Year 1",
                "description": "First-year statutory commission rate for Family Takaful policies.",
                "category": "Commissions",
                "subcategory": "Takaful",
                "eligibility_criteria": "Family Category",
                "priority": 7,
                "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "eq", "value": "Family"},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {
                    "terminal": True,
                    "commission_pct": 30.0,
                    "withholding_tax_pct": 10.0,
                    "reason": "SECP Takaful Rules 2012: Family Takaful first-year statutory rate 30%. Renewal-year Takaful rate not independently confirmed in public sources.",
                },
            },
        ],
    },
    {
        "code": "compliance.secp_aml",
        "name": "AML & Sanctions Compliance",
        "domain": RuleDomainEnum.COMPLIANCE_AML,
        "description": "High-risk customer AML screening, PEP flagging, and clearance rules.",
        "rules": [
            {
                "code": "AML-SANC-01",
                "name": "Sanctions Block",
                "description": "Automatically decline and block applications with active sanctions match.",
                "category": "Compliance",
                "subcategory": "Sanctions",
                "eligibility_criteria": "Matched Sanctions List",
                "priority": 1,
                "operator": "ALL",
                "conditions": [
                    {"field": "sanctions_matched", "operator": "boolean", "value": True},
                ],
                "action_outcome": "BLOCK_APPLICATION",
                "outcome_payload": {
                    "terminal": True,
                    "risk_level": "CRITICAL",
                    "reason": "Match found on UN/SECP Sanctions List. Policy issue blocked.",
                },
            },
            {
                "code": "AML-PEP-01",
                "name": "PEP Clearance",
                "description": "Politically Exposed Persons require manual clearance by a Compliance Officer.",
                "category": "Compliance",
                "subcategory": "PEP Screening",
                "eligibility_criteria": "Is PEP",
                "priority": 2,
                "operator": "ALL",
                "conditions": [
                    {"field": "is_pep", "operator": "boolean", "value": True},
                ],
                "action_outcome": "REQUIRE_MANUAL_CLEARANCE",
                "outcome_payload": {
                    "risk_level": "HIGH",
                    "reason": "Politically Exposed Person (PEP) requires senior compliance sign-off.",
                },
            },
            {
                "code": "AML-EDD-01",
                "name": "High Premium EDD",
                "description": "High premium applications require Enhanced Due Diligence (EDD) and source of funds documentation.",
                "category": "Compliance",
                "subcategory": "Transaction Monitoring",
                "eligibility_criteria": "Premium > 1M PKR",
                "priority": 3,
                "operator": "ALL",
                "conditions": [
                    {"field": "annual_premium", "operator": "gt", "value": 1000000},
                ],
                "action_outcome": "REQUIRE_ENHANCED_DUE_DILIGENCE",
                "outcome_payload": {
                    "risk_level": "MEDIUM_HIGH",
                    "reason": "Annual premium > 1,000,000 PKR requires Source of Funds documentation.",
                },
            },
        ],
    },
    {
        "code": "pricing.base_loading",
        "name": "Risk Loadings",
        "domain": RuleDomainEnum.PRICING,
        "description": "Computes health, BMI, and smoker premium loadings.",
        "rules": [
            {
                "code": "RSK-BMI-01",
                "name": "Obese Smoker Surcharge",
                "description": "Applies a 50% extra mortality loading for severe obesity combined with active smoking.",
                "category": "Medical Rating",
                "subcategory": "BMI & Smoking",
                "eligibility_criteria": "BMI > 32, Active Smoker",
                "priority": 1,
                "operator": "ALL",
                "conditions": [
                    {"field": "bmi", "operator": "gt", "value": 32},
                    {"field": "is_smoker", "operator": "boolean", "value": True},
                ],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {
                    "loading_pct": 50.0,
                    "reason": "Severe Obesity (BMI > 32) combined with active smoking.",
                },
            },
            {
                "code": "RSK-SMK-01",
                "name": "Standard Smoker Loading",
                "description": "Applies a 25% premium loading for active tobacco users.",
                "category": "Medical Rating",
                "subcategory": "Smoking",
                "eligibility_criteria": "Active Smoker",
                "priority": 2,
                "operator": "ALL",
                "conditions": [
                    {"field": "is_smoker", "operator": "boolean", "value": True},
                ],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {
                    "loading_pct": 25.0,
                    "reason": "Active tobacco/smoker surcharge.",
                },
            },
            {
                "code": "RSK-BMI-02",
                "name": "Overweight Loading",
                "description": "Applies a 15% loading for applicants in the overweight BMI band.",
                "category": "Medical Rating",
                "subcategory": "BMI",
                "eligibility_criteria": "BMI 28 - 32",
                "priority": 3,
                "operator": "ALL",
                "conditions": [
                    {"field": "bmi", "operator": "between", "value": [28, 32]},
                ],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {
                    "loading_pct": 15.0,
                    "reason": "Overweight BMI band (28 - 32).",
                },
            },
        ],
    },
    {
        "code": "ai.composite_decision_bands",
        "name": "AI Risk Bands",
        "domain": RuleDomainEnum.AI_DECISION_BANDS,
        "description": "Maps composite risk scores (0-100) to automated underwriting decisions.",
        "rules": [
            {
                "code": "AI-BND-01",
                "name": "Low Risk Auto-Approve",
                "description": "Automatically approves applications with a low composite risk score.",
                "category": "AI Scoring",
                "subcategory": "Standard Bands",
                "eligibility_criteria": "Score < 40",
                "priority": 1,
                "operator": "ALL",
                "conditions": [
                    {"field": "composite_score", "operator": "lt", "value": 40},
                ],
                "action_outcome": "AUTO_APPROVE",
                "outcome_payload": {
                    "recommendation": "Auto Approve",
                    "status_code": "APPROVED",
                    "reason": "Composite risk score below 40. Standard acceptance.",
                },
            },
            {
                "code": "AI-BND-02",
                "name": "Moderate Risk Loading",
                "description": "Flags moderate risk applications for underwriting loading or counter-offers.",
                "category": "AI Scoring",
                "subcategory": "Standard Bands",
                "eligibility_criteria": "Score 40 - 69",
                "priority": 2,
                "operator": "ALL",
                "conditions": [
                    {"field": "composite_score", "operator": "between", "value": [40, 69]},
                ],
                "action_outcome": "APPROVE_WITH_LOADING",
                "outcome_payload": {
                    "recommendation": "Approve with Loading",
                    "status_code": "ACCEPTED_WITH_LOADINGS",
                    "reason": "Moderate risk score. Underwriting loading or counter-offer required.",
                },
            },
            {
                "code": "AI-BND-03",
                "name": "High Risk Human Review",
                "description": "Diverts high-risk applications to manual human underwriting review.",
                "category": "AI Scoring",
                "subcategory": "Standard Bands",
                "eligibility_criteria": "Score >= 70",
                "priority": 3,
                "operator": "ALL",
                "conditions": [
                    {"field": "composite_score", "operator": "gte", "value": 70},
                ],
                "action_outcome": "REQUIRE_HUMAN_REVIEW",
                "outcome_payload": {
                    "recommendation": "Human Underwriting Required",
                    "status_code": "UNDER_REVIEW",
                    "reason": "High composite risk score. Manual review mandated.",
                },
            },
        ],
    },
    {
        "code": "eligibility.proposal_gates",
        "name": "Proposal Eligibility Gates",
        "domain": RuleDomainEnum.ELIGIBILITY,
        "description": (
            "The four eligibility checks routers/quote.py runs before pricing a proposal: "
            "entry-age band, term band, maturity age, and income-multiple ceiling. The numeric "
            "bands themselves are per-product data on InsurancePlan (entry_age_min/max, "
            "term_min/max_years, max_maturity_age, max_income_multiple — they vary by product, "
            "e.g. 5x-50x income across the seeded catalogue, so they are not duplicated here). "
            "This rule set is the single definition of *which* checks gate eligibility and in "
            "what order they're reported — the caller pre-evaluates each boolean against the "
            "selected plan's own bands and passes the booleans in as context."
        ),
        "rules": [
            {
                "code": "ELG-AGE-01",
                "name": "Entry Age Out of Band",
                "description": "Applicant age falls outside the selected plan's entry-age band.",
                "category": "Eligibility",
                "subcategory": "Entry Age",
                "eligibility_criteria": "age_in_entry_band = false",
                "priority": 1,
                "operator": "ALL",
                "conditions": [{"field": "age_in_entry_band", "operator": "boolean", "value": False}],
                "action_outcome": "INELIGIBLE",
                "outcome_payload": {"terminal": True, "reason": "Customer age is outside the plan's eligible entry-age band."},
            },
            {
                "code": "ELG-TERM-01",
                "name": "Term Out of Band",
                "description": "Requested policy term falls outside the selected plan's min/max term.",
                "category": "Eligibility",
                "subcategory": "Policy Term",
                "eligibility_criteria": "term_in_band = false",
                "priority": 2,
                "operator": "ALL",
                "conditions": [{"field": "term_in_band", "operator": "boolean", "value": False}],
                "action_outcome": "INELIGIBLE",
                "outcome_payload": {"terminal": True, "reason": "Policy term is outside the plan's eligible term band."},
            },
            {
                "code": "ELG-MAT-01",
                "name": "Maturity Age Exceeded",
                "description": "Age at maturity (entry age + term) exceeds the plan's max maturity age.",
                "category": "Eligibility",
                "subcategory": "Maturity Age",
                "eligibility_criteria": "maturity_age_ok = false",
                "priority": 3,
                "operator": "ALL",
                "conditions": [{"field": "maturity_age_ok", "operator": "boolean", "value": False}],
                "action_outcome": "INELIGIBLE",
                "outcome_payload": {"terminal": True, "reason": "Age at maturity exceeds the plan's maximum maturity age."},
            },
            {
                "code": "ELG-INC-01",
                "name": "Coverage Exceeds Income Multiple",
                "description": "Requested coverage exceeds the plan's max income-multiple ceiling.",
                "category": "Eligibility",
                "subcategory": "Income Multiple",
                "eligibility_criteria": "coverage_within_multiple = false",
                "priority": 4,
                "operator": "ALL",
                "conditions": [{"field": "coverage_within_multiple", "operator": "boolean", "value": False}],
                "action_outcome": "INELIGIBLE",
                "outcome_payload": {"terminal": True, "reason": "Requested coverage exceeds the plan's maximum income multiple."},
            },
            {
                "code": "ELG-PASS",
                "name": "Eligible",
                "description": "All four eligibility checks passed.",
                "category": "Eligibility",
                "subcategory": "Overall",
                "eligibility_criteria": "All gates pass",
                "priority": 99,
                "operator": "ALL",
                "conditions": [],
                "action_outcome": "ELIGIBLE",
                "outcome_payload": {"reason": "Entry age, term, maturity age, and income multiple are all within the plan's eligible bands."},
            },
        ],
    },
    {
        "code": "underwriting.six_gates",
        "name": "Six Pre-Underwriting Gates",
        "domain": RuleDomainEnum.UNDERWRITING_GATES,
        "description": (
            "The canonical 'done' definition for each of the six pre-underwriting clearance "
            "gates a case must clear before Stage-A pre-issuance can begin. Backend, agent-app, "
            "portal, and copilot each re-derive this checklist independently today and disagree "
            "on Gate 1 (portal's isFullyReady() accepts a merely-Submitted E-App; every other "
            "copy requires Verified) — this rule set uses the stricter, backend definition as "
            "the single source of truth. Not yet consumed by any of the four call sites."
        ),
        "rules": [
            {
                "code": "GATE-1",
                "name": "E-Application Verified",
                "description": "Customer E-Application must be Verified (not merely Submitted).",
                "category": "Underwriting Gates",
                "subcategory": "Gate 1 — E-Application",
                "eligibility_criteria": "e_application_status = Verified",
                "priority": 1,
                "operator": "ALL",
                "conditions": [{"field": "e_application_status", "operator": "in", "value": ["Verified"]}],
                "action_outcome": "GATE_CLEARED",
                "outcome_payload": {"gate": 1, "reason": "E-Application Verified."},
            },
            {
                "code": "GATE-2",
                "name": "ACR Submitted",
                "description": "Agent's Confidential Report must be Submitted.",
                "category": "Underwriting Gates",
                "subcategory": "Gate 2 — ACR",
                "eligibility_criteria": "acr_status = Submitted",
                "priority": 2,
                "operator": "ALL",
                "conditions": [{"field": "acr_status", "operator": "in", "value": ["Submitted"]}],
                "action_outcome": "GATE_CLEARED",
                "outcome_payload": {"gate": 2, "reason": "Agent's Confidential Report Submitted."},
            },
            {
                "code": "GATE-3",
                "name": "Compliance Passed",
                "description": "AML/PEP/Sanctions/SECP compliance screen must be Passed.",
                "category": "Underwriting Gates",
                "subcategory": "Gate 3 — Compliance",
                "eligibility_criteria": "compliance_status = Passed",
                "priority": 3,
                "operator": "ALL",
                "conditions": [{"field": "compliance_status", "operator": "in", "value": ["Passed"]}],
                "action_outcome": "GATE_CLEARED",
                "outcome_payload": {"gate": 3, "reason": "Compliance screening Passed."},
            },
            {
                "code": "GATE-4",
                "name": "IPP Realized",
                "description": "Initial Premium Payment must be Realized.",
                "category": "Underwriting Gates",
                "subcategory": "Gate 4 — IPP",
                "eligibility_criteria": "ipp_status = Realized",
                "priority": 4,
                "operator": "ALL",
                "conditions": [{"field": "ipp_status", "operator": "in", "value": ["Realized"]}],
                "action_outcome": "GATE_CLEARED",
                "outcome_payload": {"gate": 4, "reason": "Initial Premium Payment Realized."},
            },
            {
                "code": "GATE-5",
                "name": "Insurance History Clear",
                "description": "Insurance-history over-insurance/replacement/non-disclosure screen must be Clear.",
                "category": "Underwriting Gates",
                "subcategory": "Gate 5 — Insurance History",
                "eligibility_criteria": "insurance_history_status = Clear",
                "priority": 5,
                "operator": "ALL",
                "conditions": [{"field": "insurance_history_status", "operator": "in", "value": ["Clear"]}],
                "action_outcome": "GATE_CLEARED",
                "outcome_payload": {"gate": 5, "reason": "Insurance History Clear."},
            },
            {
                "code": "GATE-6",
                "name": "Medical Resolved",
                "description": "Medical requirement must be resolved — not required, completed, or waived.",
                "category": "Underwriting Gates",
                "subcategory": "Gate 6 — Medical",
                "eligibility_criteria": "medical_status in [NotRequired, Completed, Waived]",
                "priority": 6,
                "operator": "ALL",
                "conditions": [{"field": "medical_status", "operator": "in", "value": ["NotRequired", "Completed", "Waived"]}],
                "action_outcome": "GATE_CLEARED",
                "outcome_payload": {"gate": 6, "reason": "Medical requirement resolved (not required / completed / waived)."},
            },
        ],
    },
    {
        "code": "history.hlv_ceiling",
        "name": "Human Life Value Ceiling",
        "domain": RuleDomainEnum.INSURANCE_HISTORY,
        "description": "Age-banded income multiple used to size the over-insurance ceiling. Generated from services/underwriting_limits.py:HLV_MULTIPLES.",
        "rules": _build_hlv_rules(),
    },
    {
        "code": "history.score_bands",
        "name": "Insurance History Score Bands",
        "domain": RuleDomainEnum.INSURANCE_HISTORY,
        "description": "Maps the weighted insurance-history finding score (0-100) to a CLEAR / FLAGGED / FAILED status. Mirrors services/insurance_history.py's _FLAG_THRESHOLD (40) / _FAIL_THRESHOLD (85).",
        "rules": [
            {
                "code": "HIST-BAND-01",
                "name": "Failed",
                "description": "Score at or above the fail threshold — hard stop pending underwriter override.",
                "category": "Insurance History",
                "subcategory": "Score Bands",
                "eligibility_criteria": "Score >= 85",
                "priority": 1,
                "operator": "ALL",
                "conditions": [{"field": "score", "operator": "gte", "value": 85}],
                "action_outcome": "FAILED",
                "outcome_payload": {"terminal": True, "status_code": "FAILED", "reason": "Insurance-history score at or above the fail threshold (85)."},
            },
            {
                "code": "HIST-BAND-02",
                "name": "Flagged",
                "description": "Score at or above the flag threshold — underwriter review required.",
                "category": "Insurance History",
                "subcategory": "Score Bands",
                "eligibility_criteria": "Score 40 - 84",
                "priority": 2,
                "operator": "ALL",
                "conditions": [{"field": "score", "operator": "gte", "value": 40}],
                "action_outcome": "FLAGGED",
                "outcome_payload": {"terminal": True, "status_code": "FLAGGED", "reason": "Insurance-history score at or above the flag threshold (40)."},
            },
            {
                "code": "HIST-BAND-03",
                "name": "Clear",
                "description": "Score below the flag threshold.",
                "category": "Insurance History",
                "subcategory": "Score Bands",
                "eligibility_criteria": "Score < 40",
                "priority": 3,
                "operator": "ALL",
                "conditions": [],
                "action_outcome": "CLEAR",
                "outcome_payload": {"status_code": "CLEAR", "reason": "Insurance-history score below the flag threshold."},
            },
        ],
    },
    {
        "code": "rbac.action_role_matrix",
        "name": "RBAC Action-Role Matrix",
        "domain": RuleDomainEnum.RBAC_AUTHORIZATION,
        "description": (
            "Canonical action -> allowed-role(s) matrix, consolidating the role-sets duplicated "
            "verbatim across routers/cases.py (_CASE_DECISION_ROLES, _CASE_SUBMISSION_ROLES), "
            "routers/medical_exam.py (_WAIVER_ROLES), routers/reinsurance.py (_REINSURANCE_ROLES), "
            "and routers/insurance_history.py (_OVERRIDE_ROLES), plus the verify_admin-gated admin "
            "surface (users/plans/organizations/acquisition-sources). Roles are the 5 seeded in "
            "main.py:_SEED_ROLES. Not yet consumed by any call site — those still check their own "
            "local set literal."
        ),
        "rules": [
            {
                "code": "RBAC-01",
                "name": "Admin Resource Management",
                "description": "Manage users, insurance plans, organizations, and acquisition sources.",
                "category": "RBAC",
                "subcategory": "Admin Surface",
                "eligibility_criteria": "role in [Admin, SuperAdmin]",
                "priority": 1,
                "operator": "ALL",
                "conditions": [
                    {"field": "action", "operator": "eq", "value": "manage_admin_resources"},
                    {"field": "role", "operator": "in", "value": ["Admin", "SuperAdmin"]},
                ],
                "action_outcome": "ALLOW",
                "outcome_payload": {"terminal": True, "reason": "verify_admin surface — Admin (own tenant) or SuperAdmin (cross-tenant)."},
            },
            {
                "code": "RBAC-02",
                "name": "Case Decision",
                "description": "Approve, decline, or counter-offer a case.",
                "category": "RBAC",
                "subcategory": "Underwriting",
                "eligibility_criteria": "role in [Underwriter, Admin, SuperAdmin]",
                "priority": 2,
                "operator": "ALL",
                "conditions": [
                    {"field": "action", "operator": "eq", "value": "case_decision"},
                    {"field": "role", "operator": "in", "value": ["Underwriter", "Admin", "SuperAdmin"]},
                ],
                "action_outcome": "ALLOW",
                "outcome_payload": {"terminal": True, "reason": "cases.py:_CASE_DECISION_ROLES."},
            },
            {
                "code": "RBAC-03",
                "name": "Case Submission",
                "description": "Submit a new proposal/case.",
                "category": "RBAC",
                "subcategory": "Sales",
                "eligibility_criteria": "role in [Agent, Underwriter, Admin, SuperAdmin]",
                "priority": 3,
                "operator": "ALL",
                "conditions": [
                    {"field": "action", "operator": "eq", "value": "case_submission"},
                    {"field": "role", "operator": "in", "value": ["Agent", "Underwriter", "Admin", "SuperAdmin"]},
                ],
                "action_outcome": "ALLOW",
                "outcome_payload": {"terminal": True, "reason": "cases.py:_CASE_SUBMISSION_ROLES."},
            },
            {
                "code": "RBAC-04",
                "name": "Medical Requirement Waiver",
                "description": "Waive a required medical examination.",
                "category": "RBAC",
                "subcategory": "Underwriting",
                "eligibility_criteria": "role in [Underwriter, Admin, SuperAdmin]",
                "priority": 4,
                "operator": "ALL",
                "conditions": [
                    {"field": "action", "operator": "eq", "value": "medical_waiver"},
                    {"field": "role", "operator": "in", "value": ["Underwriter", "Admin", "SuperAdmin"]},
                ],
                "action_outcome": "ALLOW",
                "outcome_payload": {"terminal": True, "reason": "medical_exam.py:_WAIVER_ROLES."},
            },
            {
                "code": "RBAC-05",
                "name": "Reinsurance Referral",
                "description": "Refer or action a facultative reinsurance case.",
                "category": "RBAC",
                "subcategory": "Underwriting",
                "eligibility_criteria": "role in [Underwriter, Admin, SuperAdmin]",
                "priority": 5,
                "operator": "ALL",
                "conditions": [
                    {"field": "action", "operator": "eq", "value": "reinsurance_referral"},
                    {"field": "role", "operator": "in", "value": ["Underwriter", "Admin", "SuperAdmin"]},
                ],
                "action_outcome": "ALLOW",
                "outcome_payload": {"terminal": True, "reason": "reinsurance.py:_REINSURANCE_ROLES."},
            },
            {
                "code": "RBAC-06",
                "name": "Insurance History Override",
                "description": "Manually clear or fail an insurance-history finding.",
                "category": "RBAC",
                "subcategory": "Underwriting",
                "eligibility_criteria": "role in [Underwriter, Admin, SuperAdmin]",
                "priority": 6,
                "operator": "ALL",
                "conditions": [
                    {"field": "action", "operator": "eq", "value": "insurance_history_override"},
                    {"field": "role", "operator": "in", "value": ["Underwriter", "Admin", "SuperAdmin"]},
                ],
                "action_outcome": "ALLOW",
                "outcome_payload": {"terminal": True, "reason": "insurance_history.py:_OVERRIDE_ROLES."},
            },
            {
                "code": "RBAC-DENY",
                "name": "Deny",
                "description": "No matching allow rule for this action/role pair.",
                "category": "RBAC",
                "subcategory": "Default",
                "eligibility_criteria": "No matching ALLOW rule",
                "priority": 99,
                "operator": "ALL",
                "conditions": [],
                "action_outcome": "DENY",
                "outcome_payload": {"reason": "No ALLOW rule matched this action for this role."},
            },
        ],
    },
    {
        "code": "reinsurance.retention_grid",
        "name": "Self-Retention & Treaty Capacity",
        "domain": RuleDomainEnum.REINSURANCE,
        "description": (
            "Age-banded net retention and automatic treaty capacity — Adamjee's "
            "'Self-retention' underwriting category. Generated from "
            "services/underwriting_limits.py:RETENTION_AGE_SCALING x RETENTION_LIMIT x TREATY_LINES, "
            "the same constants services/reinsurance.py already uses."
        ),
        "rules": _build_retention_rules(),
    },
    {
        "code": "reinsurance.referral_decision",
        "name": "Facultative Referral Decision",
        "domain": RuleDomainEnum.REINSURANCE,
        "description": (
            "Whether a case must be referred to a reinsurer facultatively. Sum assured "
            "above retention + automatic treaty capacity always requires referral — the "
            "caller computes facultative_required from reinsurance.retention_grid's "
            "lookup (via underwriting_limits.py:compute_cession()) and passes it in."
        ),
        "rules": [
            {
                "code": "REINS-REF-01",
                "name": "Facultative Referral Required",
                "description": "Sum at risk exceeds retention plus automatic treaty capacity — must be placed facultatively before approval.",
                "category": "Reinsurance",
                "subcategory": "Facultative Referral",
                "eligibility_criteria": "facultative_required = true",
                "priority": 1,
                "operator": "ALL",
                "conditions": [{"field": "facultative_required", "operator": "boolean", "value": True}],
                "action_outcome": "REFERRAL_REQUIRED",
                "outcome_payload": {"terminal": True, "reason": "Sum at risk exceeds retention + automatic treaty capacity; reinsurer must underwrite the excess before approval."},
            },
            {
                "code": "REINS-REF-02",
                "name": "Retained / Automatic Treaty",
                "description": "Sum at risk is within retention plus automatic treaty capacity — no facultative referral needed.",
                "category": "Reinsurance",
                "subcategory": "Facultative Referral",
                "eligibility_criteria": "facultative_required = false",
                "priority": 99,
                "operator": "ALL",
                "conditions": [],
                "action_outcome": "AUTO_RETAINED",
                "outcome_payload": {"reason": "Fully covered by net retention and/or automatic treaty capacity — no reinsurer referral required."},
            },
        ],
    },
    {
        "code": "pricing.occupational_loading",
        "name": "Occupational Hazard Loading",
        "domain": RuleDomainEnum.PRICING,
        "description": (
            "Extra-mortality loading by occupational hazard class — Adamjee's 'Occupational' "
            "underwriting category. Standard life-insurance hazard classification (office/"
            "professional -> heavy manual -> extra-hazardous); the keyword list and loading "
            "percentages are illustrative and should get actuarial confirmation before use in "
            "live pricing, same as the single-premium commission rate (COM-IND-SP)."
        ),
        "rules": [
            {
                "code": "OCC-04",
                "name": "Extra Hazardous Occupation",
                "description": "Mining, offshore, aviation crew, armed forces combat roles, explosives/demolition, deep-sea diving.",
                "category": "Medical Rating",
                "subcategory": "Occupational Hazard",
                "eligibility_criteria": "Occupation matches Class 4 (extra hazardous)",
                "priority": 1,
                "operator": "ANY",
                "conditions": [
                    {"field": "occupation", "operator": "contains", "value": "miner"},
                    {"field": "occupation", "operator": "contains", "value": "mining"},
                    {"field": "occupation", "operator": "contains", "value": "offshore"},
                    {"field": "occupation", "operator": "contains", "value": "oil rig"},
                    {"field": "occupation", "operator": "contains", "value": "pilot"},
                    {"field": "occupation", "operator": "contains", "value": "air crew"},
                    {"field": "occupation", "operator": "contains", "value": "aircrew"},
                    {"field": "occupation", "operator": "contains", "value": "armed forces"},
                    {"field": "occupation", "operator": "contains", "value": "military"},
                    {"field": "occupation", "operator": "contains", "value": "bomb disposal"},
                    {"field": "occupation", "operator": "contains", "value": "explosive"},
                    {"field": "occupation", "operator": "contains", "value": "demolition"},
                    {"field": "occupation", "operator": "contains", "value": "diver"},
                ],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {"terminal": True, "loading_pct": 100.0, "occupation_class": 4, "reason": "Extra-hazardous occupation class — highest mortality loading."},
            },
            {
                "code": "OCC-03",
                "name": "Hazardous Occupation",
                "description": "Construction, fishing, armed/frontline security, firefighting, high-voltage electrical work, crane operation, welding.",
                "category": "Medical Rating",
                "subcategory": "Occupational Hazard",
                "eligibility_criteria": "Occupation matches Class 3 (hazardous)",
                "priority": 2,
                "operator": "ANY",
                "conditions": [
                    {"field": "occupation", "operator": "contains", "value": "construction"},
                    {"field": "occupation", "operator": "contains", "value": "fisherman"},
                    {"field": "occupation", "operator": "contains", "value": "fishing"},
                    {"field": "occupation", "operator": "contains", "value": "security guard"},
                    {"field": "occupation", "operator": "contains", "value": "firefighter"},
                    {"field": "occupation", "operator": "contains", "value": "fire fighter"},
                    {"field": "occupation", "operator": "contains", "value": "electrician"},
                    {"field": "occupation", "operator": "contains", "value": "crane operator"},
                    {"field": "occupation", "operator": "contains", "value": "welder"},
                    {"field": "occupation", "operator": "contains", "value": "police"},
                ],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {"terminal": True, "loading_pct": 50.0, "occupation_class": 3, "reason": "Hazardous occupation class — elevated mortality loading."},
            },
            {
                "code": "OCC-02",
                "name": "Moderate Risk Occupation",
                "description": "Heavy-vehicle/commercial driving, factory floor work, mechanics, warehouse labor.",
                "category": "Medical Rating",
                "subcategory": "Occupational Hazard",
                "eligibility_criteria": "Occupation matches Class 2 (moderate)",
                "priority": 3,
                "operator": "ANY",
                "conditions": [
                    {"field": "occupation", "operator": "contains", "value": "driver"},
                    {"field": "occupation", "operator": "contains", "value": "factory"},
                    {"field": "occupation", "operator": "contains", "value": "mechanic"},
                    {"field": "occupation", "operator": "contains", "value": "warehouse"},
                ],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {"terminal": True, "loading_pct": 15.0, "occupation_class": 2, "reason": "Moderate-risk occupation class — small mortality loading."},
            },
            {
                "code": "OCC-01",
                "name": "Standard Occupation",
                "description": "Office/professional/desk-based or unclassified occupation — no occupational loading.",
                "category": "Medical Rating",
                "subcategory": "Occupational Hazard",
                "eligibility_criteria": "No hazardous occupation keyword matched",
                "priority": 99,
                "operator": "ALL",
                "conditions": [],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {"loading_pct": 0.0, "occupation_class": 1, "reason": "Standard occupation class — no occupational loading."},
            },
        ],
    },
]


async def seed_rules_if_empty(session: AsyncSession):
    """Populates initial rule sets if empty."""
    res = await session.exec(select(RuleSet))
    if res.first() is not None:
        return

    for rs_data in _DEFAULT_RULE_SETS:
        rule_set = RuleSet(
            code=rs_data["code"],
            name=rs_data["name"],
            domain=rs_data["domain"],
            description=rs_data["description"],
            is_active=True,
        )
        session.add(rule_set)
        await session.commit()
        await session.refresh(rule_set)

        # Active version 1
        version = RuleVersion(
            rule_set_id=rule_set.id,
            version_no=1,
            status=RuleVersionStatusEnum.ACTIVE,
            authored_by="System Baseline",
            approved_by="Compliance Office",
            notes="Initial statutory and operational rule baseline.",
        )
        session.add(version)
        await session.commit()
        await session.refresh(version)

        # Rules
        for r_data in rs_data["rules"]:
            rule = BusinessRule(
                rule_version_id=version.id,
                name=r_data["name"],
                code=r_data.get("code"),
                description=r_data.get("description"),
                category=r_data.get("category"),
                subcategory=r_data.get("subcategory"),
                eligibility_criteria=r_data.get("eligibility_criteria"),
                priority=r_data["priority"],
                condition_operator=r_data["operator"],
                conditions=r_data["conditions"],
                action_outcome=r_data["action_outcome"],
                outcome_payload=r_data["outcome_payload"],
                is_enabled=True,
            )
            session.add(rule)
        await session.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Request / Response Schemas
# ─────────────────────────────────────────────────────────────────────────────

class EvaluateRuleRequest(BaseModel):
    rule_set_code: str
    context: Dict[str, Any]
    case_id: Optional[str] = None
    actor: Optional[str] = "Portal Admin"


class RuleSetCreateRequest(BaseModel):
    code: str
    name: str
    domain: RuleDomainEnum
    description: Optional[str] = ""


class RuleCreateRequest(BaseModel):
    name: str
    code: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    subcategory: Optional[str] = None
    eligibility_criteria: Optional[str] = None
    priority: int = 10
    condition_operator: str = "ALL"
    conditions: List[Dict[str, Any]]
    action_outcome: str
    outcome_payload: Dict[str, Any]
    is_enabled: bool = True


class RuleUpdateRequest(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    subcategory: Optional[str] = None
    eligibility_criteria: Optional[str] = None
    priority: Optional[int] = None
    condition_operator: Optional[str] = None
    conditions: Optional[List[Dict[str, Any]]] = None
    action_outcome: Optional[str] = None
    outcome_payload: Optional[Dict[str, Any]] = None
    is_enabled: Optional[bool] = None


class VersionStatusRequest(BaseModel):
    status: RuleVersionStatusEnum
    approved_by: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# API Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/sets", summary="List rule sets")
async def list_rule_sets(
    tenant_id: UUID,
    domain: Optional[RuleDomainEnum] = None,
    session: AsyncSession = Depends(get_session),
):
    await seed_rules_if_empty(session)
    query = select(RuleSet).where(
        (RuleSet.tenant_id == tenant_id) | (RuleSet.tenant_id == None)
    )
    if domain:
        query = query.where(RuleSet.domain == domain)

    res = await session.exec(query)
    rule_sets = res.all()

    output = []
    for rs in rule_sets:
        # Get active version & rule count
        ver_res = await session.exec(
            select(RuleVersion)
            .where(RuleVersion.rule_set_id == rs.id)
            .order_by(RuleVersion.version_no.desc())
        )
        versions = ver_res.all()
        active_ver = next((v for v in versions if v.status == RuleVersionStatusEnum.ACTIVE), None)
        rule_count = 0
        if active_ver:
            rule_res = await session.exec(
                select(BusinessRule).where(BusinessRule.rule_version_id == active_ver.id)
            )
            rule_count = len(rule_res.all())

        output.append({
            "id": str(rs.id),
            "code": rs.code,
            "name": rs.name,
            "domain": rs.domain,
            "description": rs.description,
            "is_active": rs.is_active,
            "active_version_no": active_ver.version_no if active_ver else None,
            "active_version_status": active_ver.status if active_ver else "NO_VERSION",
            "version_count": len(versions),
            "rule_count": rule_count,
            "updated_at": rs.updated_at.isoformat(),
        })

    return output


@router.post("/sets", status_code=status.HTTP_201_CREATED, summary="Create a new rule set")
async def create_rule_set(
    tenant_id: UUID,
    body: RuleSetCreateRequest,
    session: AsyncSession = Depends(get_session),
):
    existing = (await session.exec(select(RuleSet).where(RuleSet.code == body.code))).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Rule set code '{body.code}' already exists.")

    rule_set = RuleSet(
        tenant_id=tenant_id,
        code=body.code,
        name=body.name,
        domain=body.domain,
        description=body.description or "",
    )
    session.add(rule_set)
    await session.commit()
    await session.refresh(rule_set)

    # Initial draft version 1
    version = RuleVersion(
        rule_set_id=rule_set.id,
        version_no=1,
        status=RuleVersionStatusEnum.DRAFT,
        authored_by="Admin",
    )
    session.add(version)
    await session.commit()

    return {"id": str(rule_set.id), "code": rule_set.code, "message": "Rule set created successfully."}


@router.get("/sets/{rule_set_id}", summary="Get detailed rule set details with rules and versions")
async def get_rule_set_detail(
    tenant_id: UUID,
    rule_set_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    rule_set = await session.get(RuleSet, rule_set_id)
    if not rule_set:
        raise HTTPException(status_code=44, detail="Rule set not found.")

    ver_res = await session.exec(
        select(RuleVersion)
        .where(RuleVersion.rule_set_id == rule_set.id)
        .order_by(RuleVersion.version_no.desc())
    )
    versions = ver_res.all()

    versions_data = []
    for v in versions:
        rules_res = await session.exec(
            select(BusinessRule)
            .where(BusinessRule.rule_version_id == v.id)
            .order_by(BusinessRule.priority.asc())
        )
        rules = rules_res.all()

        versions_data.append({
            "id": str(v.id),
            "version_no": v.version_no,
            "status": v.status,
            "effective_from": v.effective_from.isoformat(),
            "effective_to": v.effective_to.isoformat() if v.effective_to else None,
            "authored_by": v.authored_by,
            "approved_by": v.approved_by,
            "notes": v.notes,
            "rules": [
                {
                    "id": str(r.id),
                    "name": r.name,
                    "code": r.code,
                    "description": r.description,
                    "category": r.category,
                    "subcategory": r.subcategory,
                    "eligibility_criteria": r.eligibility_criteria,
                    "priority": r.priority,
                    "condition_operator": r.condition_operator,
                    "conditions": r.conditions,
                    "action_outcome": r.action_outcome,
                    "outcome_payload": r.outcome_payload,
                    "is_enabled": r.is_enabled,
                }
                for r in rules
            ],
        })

    return {
        "id": str(rule_set.id),
        "code": rule_set.code,
        "name": rule_set.name,
        "domain": rule_set.domain,
        "description": rule_set.description,
        "is_active": rule_set.is_active,
        "versions": versions_data,
    }


@router.post("/sets/{rule_set_id}/versions", status_code=status.HTTP_201_CREATED, summary="Create a new draft version")
async def create_rule_version(
    tenant_id: UUID,
    rule_set_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    rule_set = await session.get(RuleSet, rule_set_id)
    if not rule_set:
        raise HTTPException(status_code=404, detail="Rule set not found.")

    latest = (
        await session.exec(
            select(RuleVersion)
            .where(RuleVersion.rule_set_id == rule_set.id)
            .order_by(RuleVersion.version_no.desc())
        )
    ).first()

    next_no = (latest.version_no + 1) if latest else 1
    new_version = RuleVersion(
        rule_set_id=rule_set.id,
        version_no=next_no,
        status=RuleVersionStatusEnum.DRAFT,
        authored_by="Admin",
    )
    session.add(new_version)
    await session.commit()
    await session.refresh(new_version)

    # Copy rules from latest if exists
    if latest:
        prev_rules = (
            await session.exec(
                select(BusinessRule).where(BusinessRule.rule_version_id == latest.id)
            )
        ).all()
        for r in prev_rules:
            session.add(
                BusinessRule(
                    rule_version_id=new_version.id,
                    name=r.name,
                    code=r.code,
                    description=r.description,
                    category=r.category,
                    subcategory=r.subcategory,
                    eligibility_criteria=r.eligibility_criteria,
                    priority=r.priority,
                    condition_operator=r.condition_operator,
                    conditions=r.conditions,
                    action_outcome=r.action_outcome,
                    outcome_payload=r.outcome_payload,
                    is_enabled=r.is_enabled,
                )
            )
        await session.commit()

    return {"id": str(new_version.id), "version_no": new_version.version_no, "status": new_version.status}


@router.patch("/versions/{version_id}/status", summary="Update version status (Deploy/Retire)")
async def update_version_status(
    tenant_id: UUID,
    version_id: UUID,
    body: VersionStatusRequest,
    session: AsyncSession = Depends(get_session),
):
    version = await session.get(RuleVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail="Rule version not found.")

    if body.status == RuleVersionStatusEnum.ACTIVE:
        # Retire current active version for this rule set
        active_versions = (
            await session.exec(
                select(RuleVersion)
                .where(RuleVersion.rule_set_id == version.rule_set_id)
                .where(RuleVersion.status == RuleVersionStatusEnum.ACTIVE)
            )
        ).all()
        for av in active_versions:
            av.status = RuleVersionStatusEnum.RETIRED
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


@router.post("/versions/{version_id}/rules", status_code=status.HTTP_201_CREATED, summary="Add rule to a version")
async def add_rule_to_version(
    tenant_id: UUID,
    version_id: UUID,
    body: RuleCreateRequest,
    session: AsyncSession = Depends(get_session),
):
    version = await session.get(RuleVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail="Rule version not found.")

    rule = BusinessRule(
        rule_version_id=version.id,
        name=body.name,
        code=body.code,
        description=body.description,
        category=body.category,
        subcategory=body.subcategory,
        eligibility_criteria=body.eligibility_criteria,
        priority=body.priority,
        condition_operator=body.condition_operator,
        conditions=body.conditions,
        action_outcome=body.action_outcome,
        outcome_payload=body.outcome_payload,
        is_enabled=body.is_enabled,
    )
    session.add(rule)
    await session.commit()
    await session.refresh(rule)

    return {"id": str(rule.id), "name": rule.name, "priority": rule.priority}


@router.put("/versions/{version_id}/rules/{rule_id}", summary="Update a rule")
async def update_rule(
    tenant_id: UUID,
    version_id: UUID,
    rule_id: UUID,
    body: RuleUpdateRequest,
    session: AsyncSession = Depends(get_session),
):
    rule = await session.get(BusinessRule, rule_id)
    if not rule or rule.rule_version_id != version_id:
        raise HTTPException(status_code=404, detail="Rule not found.")

    version = await session.get(RuleVersion, version_id)
    if not version or version.status != RuleVersionStatusEnum.DRAFT:
        raise HTTPException(status_code=400, detail="Can only edit rules in DRAFT versions.")

    update_data = body.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(rule, key, value)

    session.add(rule)
    await session.commit()
    return {"message": "Rule updated successfully", "rule_id": str(rule.id)}


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a rule")
async def delete_rule(
    tenant_id: UUID,
    rule_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    rule = await session.get(BusinessRule, rule_id)
    if rule:
        await session.delete(rule)
        await session.commit()
    return None


@router.post("/evaluate", summary="Evaluate a rule set against input context")
async def evaluate_rule_endpoint(
    tenant_id: UUID,
    body: EvaluateRuleRequest,
    session: AsyncSession = Depends(get_session),
):
    result = await evaluate_rule_set(
        session=session,
        rule_set_code=body.rule_set_code,
        context=body.context,
        tenant_id=tenant_id,
        case_id=body.case_id,
        actor=body.actor or "Portal Admin",
    )
    return result


@router.get("/logs", summary="Get rule evaluation audit logs")
async def list_rule_evaluation_logs(
    tenant_id: UUID,
    limit: int = Query(default=50, le=200),
    session: AsyncSession = Depends(get_session),
):
    query = (
        select(RuleEvaluationLog)
        .where(
            (RuleEvaluationLog.tenant_id == tenant_id) | (RuleEvaluationLog.tenant_id == None)
        )
        .order_by(RuleEvaluationLog.evaluated_at.desc())
        .limit(limit)
    )
    logs = (await session.exec(query)).all()

    return [
        {
            "id": str(log.id),
            "rule_set_code": log.rule_set_code,
            "rule_version_no": log.rule_version_no,
            "case_id": log.case_id,
            "actor": log.actor,
            "input_context": log.input_context,
            "outcome": log.outcome,
            "reasons": log.reasons,
            "evaluated_at": log.evaluated_at.isoformat(),
        }
        for log in logs
    ]
