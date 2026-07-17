"""Plan-specific underwriting rule bands, keyed by Policy.insurance_type.

Real insurers underwrite different life insurance plan types against
different age bands, sum-assured limits, and medical-exam thresholds — a
Child Education & Marriage plan and a Term Life plan are not underwritten
the same way. This module replaces the single hardcoded band that used to
live in workflow.py's validate_input node.

Bands are grounded in public underwriting guides for Term/Whole Life/
Endowment plans and State Life's Child Education & Marriage Plan (Table 76).
Values are a reasonable v1 approximation, not a regulatory filing — a future
iteration may move this to a per-tenant DB-backed table.
"""

from __future__ import annotations

from datetime import date, datetime
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel


class MedicalExamTier(str, Enum):
    NONE = "None — no medical exam required"
    PARAMEDICAL = "Paramedical exam required"
    FULL_MEDICAL_AND_FINANCIALS = "Full medical exam and financial underwriting required"


class PlanRules(BaseModel):
    min_entry_age: int
    max_entry_age: int
    min_term_years: int
    max_term_years: int
    max_maturity_age: int
    max_income_multiple: float

    # Only meaningful for plans with a dependent (Child Education & Marriage)
    dependent_min_age: Optional[int] = None
    dependent_max_age: Optional[int] = None

    # (min_sum_assured_pkr, tier) — the highest threshold the requested
    # coverage meets or exceeds determines the required exam tier.
    medical_exam_tiers: List[Tuple[float, MedicalExamTier]] = []


UNDERWRITING_RULES: Dict[str, PlanRules] = {
    "TERM_LIFE": PlanRules(
        min_entry_age=18, max_entry_age=65,
        min_term_years=5, max_term_years=30,
        max_maturity_age=70,
        max_income_multiple=20,
        medical_exam_tiers=[
            (0, MedicalExamTier.NONE),
            (5_000_000, MedicalExamTier.PARAMEDICAL),
            (20_000_000, MedicalExamTier.FULL_MEDICAL_AND_FINANCIALS),
        ],
    ),
    "WHOLE_LIFE": PlanRules(
        min_entry_age=18, max_entry_age=65,
        min_term_years=1, max_term_years=40,
        max_maturity_age=99,
        max_income_multiple=25,
        medical_exam_tiers=[
            (0, MedicalExamTier.NONE),
            (5_000_000, MedicalExamTier.PARAMEDICAL),
            (15_000_000, MedicalExamTier.FULL_MEDICAL_AND_FINANCIALS),
        ],
    ),
    "ENDOWMENT": PlanRules(
        min_entry_age=18, max_entry_age=60,
        min_term_years=10, max_term_years=30,
        max_maturity_age=70,
        max_income_multiple=15,
        medical_exam_tiers=[
            (0, MedicalExamTier.NONE),
            (5_000_000, MedicalExamTier.PARAMEDICAL),
            (15_000_000, MedicalExamTier.FULL_MEDICAL_AND_FINANCIALS),
        ],
    ),
    "CHILD_EDUCATION_MARRIAGE": PlanRules(
        min_entry_age=20, max_entry_age=60,
        dependent_min_age=1, dependent_max_age=15,
        min_term_years=10, max_term_years=24,
        max_maturity_age=70,
        max_income_multiple=15,
        medical_exam_tiers=[
            (0, MedicalExamTier.NONE),
            (3_000_000, MedicalExamTier.PARAMEDICAL),
            (10_000_000, MedicalExamTier.FULL_MEDICAL_AND_FINANCIALS),
        ],
    ),
    # Unit-linked flexible savings/investment plans (Adamjee Life catalog —
    # Apna Savings, Pay Smart, Mustakil Yaqeen, Tahafuzz, Signature Plus, etc.)
    "SAVINGS": PlanRules(
        min_entry_age=18, max_entry_age=65,
        min_term_years=5, max_term_years=25,
        max_maturity_age=75,
        max_income_multiple=15,
        medical_exam_tiers=[
            (0, MedicalExamTier.NONE),
            (5_000_000, MedicalExamTier.PARAMEDICAL),
            (15_000_000, MedicalExamTier.FULL_MEDICAL_AND_FINANCIALS),
        ],
    ),
    # One-time lump-sum investment plans (Shandar Sarmaya, Asaan Takaful).
    "SINGLE_PREMIUM": PlanRules(
        min_entry_age=18, max_entry_age=70,
        min_term_years=1, max_term_years=10,
        max_maturity_age=75,
        max_income_multiple=10,
        medical_exam_tiers=[
            (0, MedicalExamTier.NONE),
            (10_000_000, MedicalExamTier.PARAMEDICAL),
        ],
    ),
    # Hospital cash-back / micro-health plans (Sehat Zamanat, Sehat Kafalat,
    # COVID-19 Protection Plan) — guaranteed-issue, no medical underwriting.
    "HEALTH_CASH": PlanRules(
        min_entry_age=18, max_entry_age=59,
        min_term_years=1, max_term_years=5,
        max_maturity_age=65,
        max_income_multiple=5,
        medical_exam_tiers=[
            (0, MedicalExamTier.NONE),
        ],
    ),
    # Group/corporate life certificates issued under a MasterPolicy
    # (services/tenant-service/routers/organizations.py). Only members whose
    # coverage exceeds the group's computed Free Cover Limit reach this band
    # at all — at-or-under-FCL members are guaranteed-issue and never call
    # risk-engine. term_years is always sent as 1 for this check (an
    # annually-renewable certificate), independent of the MasterPolicy's own
    # (admin-entered, up to 40-year) contract term.
    #
    # max_income_multiple=3.0 — NOT the seeded InsurancePlan.max_income_multiple
    # (36) for the GROUP_LIFE catalog row, which means something different
    # there (it mirrors sum_assured_multiple's own 12-36x range). Coverage here
    # is computed as declared_income (annual) x (sum_assured_multiple / 12), and
    # sum_assured_multiple is validated to 12-36x MONTHLY salary
    # (group_underwriting.py), so the true annual-income multiple is 1x-3x,
    # never more than 3x.
    "GROUP_LIFE": PlanRules(
        min_entry_age=18, max_entry_age=65,
        min_term_years=1, max_term_years=1,
        max_maturity_age=70,
        max_income_multiple=3.0,
    ),
}

# Used when insurance_type is missing/unrecognized — preserves the original
# generic band so nothing already in flight hard-breaks.
_GENERIC_FALLBACK = PlanRules(
    min_entry_age=18, max_entry_age=70,
    min_term_years=1, max_term_years=40,
    max_maturity_age=99,
    max_income_multiple=20,
)


def _age_from_dob(dob_str: str) -> int:
    dob = datetime.strptime(dob_str, "%Y-%m-%d").date()
    return (date.today() - dob).days // 365


def resolve_medical_exam_tier(rules: PlanRules, coverage_amount: float) -> Optional[MedicalExamTier]:
    if not rules.medical_exam_tiers:
        return None
    applicable = [tier for threshold, tier in sorted(rules.medical_exam_tiers) if coverage_amount >= threshold]
    return applicable[-1] if applicable else None


def check_plan_rules(
    insurance_type: Optional[str],
    customer: Dict[str, Any],
    policy: Dict[str, Any],
) -> Tuple[bool, List[str]]:
    """Validate customer + policy against the rule band for insurance_type.

    Falls back to a generic band if insurance_type is missing/unrecognized.
    Returns (is_valid, errors).
    """
    rules = UNDERWRITING_RULES.get(insurance_type, _GENERIC_FALLBACK) if insurance_type else _GENERIC_FALLBACK
    plan_label = insurance_type or "Unspecified plan"
    errors: List[str] = []
    age: Optional[int] = None

    # ── Proposer age ───────────────────────────────────────────────────────
    try:
        age = _age_from_dob(customer["dob"])
        if age < rules.min_entry_age:
            errors.append(
                f"[{plan_label}] Customer is below minimum entry age of {rules.min_entry_age} (age: {age})."
            )
        if age > rules.max_entry_age:
            errors.append(
                f"[{plan_label}] Customer exceeds maximum entry age of {rules.max_entry_age} (age: {age})."
            )
    except (KeyError, ValueError, TypeError):
        errors.append("Invalid or missing date of birth.")

    # ── Income ─────────────────────────────────────────────────────────────
    income = customer.get("declared_income", 0)
    if income <= 0:
        errors.append("Declared income must be greater than zero.")

    # ── Coverage vs income multiple ───────────────────────────────────────
    coverage = policy.get("coverage_amount", 0)
    if coverage <= 0:
        errors.append("Coverage amount must be greater than zero.")
    if income > 0 and coverage > income * rules.max_income_multiple:
        errors.append(
            f"[{plan_label}] Coverage amount ({coverage:,.0f}) exceeds "
            f"{rules.max_income_multiple:g}× annual income "
            f"({income * rules.max_income_multiple:,.0f})."
        )

    # ── Term ───────────────────────────────────────────────────────────────
    term = policy.get("term_years", 0)
    if term < rules.min_term_years or term > rules.max_term_years:
        errors.append(
            f"[{plan_label}] Policy term must be between {rules.min_term_years} and "
            f"{rules.max_term_years} years (got {term})."
        )

    # ── Maturity age ───────────────────────────────────────────────────────
    if age is not None and age + term > rules.max_maturity_age:
        errors.append(
            f"[{plan_label}] Maturity age ({age + term}) exceeds maximum of {rules.max_maturity_age}."
        )

    # ── Dependent age (Child Education & Marriage only) ───────────────────
    if rules.dependent_min_age is not None:
        dependent_dob = policy.get("dependent_dob")
        if not dependent_dob:
            errors.append(f"[{plan_label}] Dependent date of birth is required for this plan.")
        else:
            try:
                dependent_age = _age_from_dob(dependent_dob)
                if dependent_age < rules.dependent_min_age or dependent_age > rules.dependent_max_age:
                    errors.append(
                        f"[{plan_label}] Dependent age must be between {rules.dependent_min_age} "
                        f"and {rules.dependent_max_age} years (got {dependent_age})."
                    )
            except (ValueError, TypeError):
                errors.append("Invalid dependent date of birth.")

    return len(errors) == 0, errors
