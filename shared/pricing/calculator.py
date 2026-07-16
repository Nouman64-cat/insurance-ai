"""Instant, deterministic premium calculation for the /quote endpoint.

Pure functions only — no DB, no HTTP, no LLM — so a quote returns in one
request/response cycle instead of waiting on the LangGraph AI risk pipeline
(see services/risk-engine/workflow.py, which is a separate, slower path that
produces an AI underwriting decision, not a price).

Bands below are v1 placeholder actuarial approximations (same spirit as
services/risk-engine/underwriting_rules.py's eligibility bands) — reasonable
estimates to make the pricing engine functional, not a regulatory filing.
Tenant admins can override the per-plan `base_premium_rate`/`smoker_factor`
inputs to these functions via the Insurance Plans admin UI without any code
change.
"""

from __future__ import annotations

from typing import List, Tuple

from pydantic import BaseModel, Field

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


def calculate_premium(
    coverage_amount: float,
    base_premium_rate: float,
    smoker_factor: float,
    age: int,
    is_smoker: bool,
    height_cm: float,
    weight_kg: float,
) -> PremiumBreakdown:
    """Compute an annual premium quote.

    base_premium  = (coverage / 1,000) x base_premium_rate x age_factor
    loading       = base_premium x (smoker_multiplier - 1) + base_premium x (bmi_factor - 1)
    total_premium = base_premium + loading

    `total_premium` is the annual premium payable each year of the policy
    term — matching "Rs. X per year for N years" framing, not a lump sum
    multiplied by the term.
    """
    reasons: List[str] = []

    age_factor = calculate_age_factor(age)
    reasons.append(f"Age {age} → age-band factor {age_factor:g}x")

    smoker_multiplier = smoker_factor if is_smoker else 1.0
    if is_smoker:
        reasons.append(f"Smoker → rate factor {smoker_factor:g}x")

    bmi_factor, bmi_reason = calculate_bmi_factor(height_cm, weight_kg)
    if bmi_reason:
        reasons.append(bmi_reason)

    raw_base = (coverage_amount / 1000) * base_premium_rate
    base_premium = raw_base * age_factor
    loading_applied = base_premium * (smoker_multiplier - 1) + base_premium * (bmi_factor - 1)
    total_premium = base_premium + loading_applied

    reasons.append(
        f"Total premium {total_premium:,.0f} = base {base_premium:,.0f} + loading {loading_applied:,.0f}"
    )

    return PremiumBreakdown(
        base_premium=round(base_premium, 2),
        loading_applied=round(loading_applied, 2),
        total_premium=round(total_premium, 2),
        age_factor=age_factor,
        bmi_factor=bmi_factor,
        smoker_multiplier=smoker_multiplier,
        reasons=reasons,
    )
