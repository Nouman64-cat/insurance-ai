"""Deterministic premium calculation — the single formula for the whole journey.

Pure functions only — no DB, no HTTP, no LLM — so a quote returns in one
request/response cycle instead of waiting on the LangGraph AI risk pipeline
(see services/risk-engine/workflow.py, which is a separate, slower path that
produces an AI underwriting decision, not a price).

This module is the ONE place a premium is computed. It is deliberately in
``shared/`` so that both sides of the journey reach the same numbers:

  • api-gateway  ``POST /quote``  → the indicative quote (PremiumQuote row),
    which is also what the pre-underwriting Initial Premium Payment collects.
  • tenant-service ``POST /issue`` → the bound contract (PolicyVersion 1.0),
    via services/pricing_engine.py, which is a thin product-dispatch wrapper
    around ``calculate_premium`` below.

Historically these were two independent formulas: the quote priced an *annual*
premium off age/BMI bands, while issuance priced ``rate × coverage × term_years``
plus fee and duty and then booked that multi-year figure as year one's
installment — so a 20-year term issued at roughly 15× the quoted price. Both
paths now share the function below; ``term_years`` is not a multiplier anywhere.

Bands below are v1 placeholder actuarial approximations (same spirit as
services/risk-engine/underwriting_rules.py's eligibility bands) — reasonable
estimates to make the pricing engine functional, not a regulatory filing.
Tenant admins can override the per-plan `base_premium_rate`/`smoker_factor`
inputs to these functions via the Insurance Plans admin UI without any code
change.
"""

from __future__ import annotations

import os
from typing import List, Tuple

from pydantic import BaseModel, Field

# ─────────────────────────────────────────────────────────────────────────────
# Statutory charges added on top of the risk premium. Env-configurable so a
# different regulator (or a P&C product) can be honoured without a redeploy.
# Read here rather than in tenant-service so the quote and the contract cannot
# disagree about what the customer owes.
# ─────────────────────────────────────────────────────────────────────────────

POLICY_FEE: float = float(os.environ.get("POLICY_FEE_PKR", "500"))
STAMP_DUTY_RATE: float = float(os.environ.get("STAMP_DUTY_RATE", "0.01"))  # 1% federal

# ─────────────────────────────────────────────────────────────────────────────
# Age factor — banded multiplier approximating increasing mortality risk with
# age. (lower_bound_age, factor) — the highest band whose lower bound the
# customer's age meets or exceeds applies.
# ─────────────────────────────────────────────────────────────────────────────

_AGE_BANDS: List[Tuple[int, float]] = [
    (18, 0.8),
    (26, 1.0),
    (36, 1.3),
    (46, 1.8),
    (56, 2.5),
    (66, 3.5),
]


def calculate_age_factor(age: int) -> float:
    """Return the age-band multiplier for `age`.

    Ages below the lowest band clamp to the lowest factor; ages above the
    highest band clamp to the highest factor (eligibility bands on the plan
    itself, e.g. entry_age_max, are expected to reject out-of-range ages
    before this is ever called).
    """
    applicable = [factor for lower, factor in _AGE_BANDS if age >= lower]
    return applicable[-1] if applicable else _AGE_BANDS[0][1]


# ─────────────────────────────────────────────────────────────────────────────
# BMI factor — a simple in-range/out-of-range loading, not a clinical model.
# ─────────────────────────────────────────────────────────────────────────────

_BMI_NORMAL_MIN = 18.5
_BMI_NORMAL_MAX = 24.9
_BMI_OUT_OF_RANGE_FACTOR = 1.15


def calculate_bmi_factor(height_cm: float, weight_kg: float) -> Tuple[float, str | None]:
    """Return (factor, reason). reason is None when BMI is within normal range."""
    height_m = height_cm / 100
    bmi = weight_kg / (height_m * height_m)

    if bmi < _BMI_NORMAL_MIN:
        return _BMI_OUT_OF_RANGE_FACTOR, f"BMI {bmi:.1f} below normal range ({_BMI_NORMAL_MIN}-{_BMI_NORMAL_MAX})"
    if bmi > _BMI_NORMAL_MAX:
        return _BMI_OUT_OF_RANGE_FACTOR, f"BMI {bmi:.1f} above normal range ({_BMI_NORMAL_MIN}-{_BMI_NORMAL_MAX})"
    return 1.0, None


# ─────────────────────────────────────────────────────────────────────────────
# Premium calculation
# ─────────────────────────────────────────────────────────────────────────────

class PremiumBreakdown(BaseModel):
    base_premium: float = Field(ge=0)
    loading_applied: float = Field(ge=0)
    total_premium: float = Field(ge=0)
    age_factor: float
    bmi_factor: float
    smoker_multiplier: float
    reasons: List[str]
    # Statutory charges, itemised so the contract and the quote can show the
    # same split. Defaulted so older constructions of this model stay valid.
    risk_premium: float = Field(default=0.0, ge=0)
    policy_fee: float = Field(default=0.0, ge=0)
    tax_amount: float = Field(default=0.0, ge=0)
    underwriting_loading: float = Field(default=0.0, ge=0)


def calculate_premium(
    coverage_amount: float,
    base_premium_rate: float,
    smoker_factor: float,
    age: int,
    is_smoker: bool,
    height_cm: float,
    weight_kg: float,
    loading_pct: float = 0.0,
    age_index: float = 1.0,
    apply_age_factor: bool = True,
    apply_charges: bool = True,
) -> PremiumBreakdown:
    """Compute the annual premium.

        base_premium   = (coverage / 1,000) x base_premium_rate x age_factor
        loading        = base x (smoker_multiplier - 1)
                       + base x (bmi_factor - 1)
                       + base x (loading_pct / 100)      # underwriting / medical
        risk_premium   = base_premium + loading
        total_premium  = risk_premium + POLICY_FEE + stamp duty

    `total_premium` is the annual premium payable each year of the policy
    term — matching "Rs. X per year for N years" framing, not a lump sum
    multiplied by the term. The policy term is deliberately NOT an input:
    a longer term does not make one year's cover cost more.

    ``loading_pct`` carries the underwriting decision into the price — the
    accepted counter-offer's revised loading, the panel medical's rating, or
    the AI's suggested loading (see routers/policies.py::_effective_loading_pct).

    ``age_index`` re-rates the base for renewals (1.02 ** (renewal_year - 1)).

    ``apply_age_factor`` / ``apply_charges`` exist for group business, which is
    negotiated at pool level rather than individually age-rated.
    """
    reasons: List[str] = []

    age_factor = calculate_age_factor(age) if apply_age_factor else 1.0
    if apply_age_factor:
        reasons.append(f"Age {age} → age-band factor {age_factor:g}x")

    smoker_multiplier = smoker_factor if is_smoker else 1.0
    if is_smoker:
        reasons.append(f"Smoker → rate factor {smoker_factor:g}x")

    bmi_factor, bmi_reason = calculate_bmi_factor(height_cm, weight_kg)
    if bmi_reason:
        reasons.append(bmi_reason)

    raw_base = (coverage_amount / 1000) * base_premium_rate * age_index
    base_premium = raw_base * age_factor

    underwriting_loading = base_premium * (max(0.0, loading_pct) / 100.0)
    if loading_pct:
        reasons.append(f"Underwriting loading +{loading_pct:g}% → {underwriting_loading:,.0f}")

    loading_applied = (
        base_premium * (smoker_multiplier - 1)
        + base_premium * (bmi_factor - 1)
        + underwriting_loading
    )
    risk_premium = base_premium + loading_applied

    policy_fee = POLICY_FEE if apply_charges else 0.0
    subtotal = risk_premium + policy_fee
    tax_amount = subtotal * STAMP_DUTY_RATE if apply_charges else 0.0
    total_premium = subtotal + tax_amount

    reasons.append(
        f"Annual premium {total_premium:,.0f} = base {base_premium:,.0f} "
        f"+ loading {loading_applied:,.0f} + fee {policy_fee:,.0f} + duty {tax_amount:,.0f}"
    )

    return PremiumBreakdown(
        base_premium=round(base_premium, 2),
        loading_applied=round(loading_applied, 2),
        total_premium=round(total_premium, 2),
        age_factor=age_factor,
        bmi_factor=bmi_factor,
        smoker_multiplier=smoker_multiplier,
        reasons=reasons,
        risk_premium=round(risk_premium, 2),
        policy_fee=round(policy_fee, 2),
        tax_amount=round(tax_amount, 2),
        underwriting_loading=round(underwriting_loading, 2),
    )
