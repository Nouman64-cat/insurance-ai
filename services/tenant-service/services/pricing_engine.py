"""
Polymorphic premium pricing engine.

Design goals:
  1. Product-agnostic interface: the router only calls PricingEngine.calculate().
  2. Product-specific subclasses handle rating logic; adding P&C / Marine / Auto
     requires only a new subclass — no changes to the router.
  3. All inputs come from the Policy and InsurancePlan models; no domain knowledge
     leaks into the routing layer.
  4. The arithmetic itself lives in shared/pricing/calculator.py, NOT here. This
     module only chooses *which* rating treatment a product gets and shapes the
     result for the issuance routers. That is what keeps `POST /quote` and
     `POST /issue` at the same number — they run the same function.

Rate table (PKR per 1,000 sum assured per year) — v1 estimates:
  These mirror the values seeded in migrate.py v12a-g. A future pricing admin UI
  will allow tenant admins to upload rate tables without code changes.

Grace period is read from the GRACE_PERIOD_DAYS env var (default: 30 days)
so P&C products can use a shorter 14-day window without code changes.
"""

import logging
import os
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

from shared.pricing.calculator import calculate_premium

log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

GRACE_PERIOD_DAYS: int = int(os.environ.get("GRACE_PERIOD_DAYS", "30"))

# The statutory charges (POLICY_FEE / STAMP_DUTY_RATE) deliberately live in
# shared/pricing/calculator.py, not here, so the quote and the bound contract
# cannot drift apart on what the customer owes.

# Rating defaults for an applicant whose biometrics were never captured (e.g. a
# Live Evaluation what-if, or a legacy row). Mid-band age and a normal-range BMI
# keep the factors at ~1.0 instead of silently mis-rating the contract.
_DEFAULT_AGE: int = 35
_DEFAULT_HEIGHT_CM: float = 170.0
_DEFAULT_WEIGHT_KG: float = 70.0

# Per-product fallback rates (used when InsurancePlan.base_premium_rate == 0)
_DEFAULT_RATES: dict[str, tuple[float, float]] = {
    "TERM_LIFE":                  (3.5,  1.6),
    "WHOLE_LIFE":                 (5.5,  1.5),
    "ENDOWMENT":                  (6.0,  1.4),
    "SAVINGS":                    (6.0,  1.4),
    "SINGLE_PREMIUM":             (4.0,  1.3),
    "HEALTH_CASH":                (8.0,  1.2),
    "CHILD_EDUCATION_MARRIAGE":   (5.0,  1.0),
    "FAMILY_FLOATER":             (7.0,  1.3),
    "GROUP_LIFE":                 (2.5,  1.0),  # negotiated per-group; placeholder
}


# ── Value object returned by every calculator ─────────────────────────────────

@dataclass
class PremiumBreakdown:
    base_premium: float
    loading_amount: float
    policy_fee: float
    tax_amount: float
    total_premium: float
    rating_basis: str           # human-readable explanation for audit log
    loading_pct: float = 0.0

    def to_dict(self) -> dict:
        return {
            "base_premium": round(self.base_premium, 2),
            "loading_amount": round(self.loading_amount, 2),
            "policy_fee": round(self.policy_fee, 2),
            "tax_amount": round(self.tax_amount, 2),
            "total_premium": round(self.total_premium, 2),
            "rating_basis": self.rating_basis,
        }


# ── Abstract base ─────────────────────────────────────────────────────────────

class _BaseCalculator:
    """
    Subclass this for each product family.

    Every subclass funnels into shared.pricing.calculator.calculate_premium —
    the same function POST /quote uses — and only varies which rating treatment
    applies (individual age/BMI rating vs. negotiated group rates). Note there is
    no ``term_years`` in the arithmetic: these are ANNUAL premiums, and a 20-year
    term does not make one year of cover cost twenty times as much.
    """

    #: Individually age-rated products apply the age band and statutory charges.
    _age_rated: bool = True
    _charged: bool = True

    def calculate(
        self,
        coverage_amount: float,
        term_years: int,
        base_rate: float,
        loading_pct: float,
        smoker_factor: float = 1.0,
        is_smoker: bool = False,
        age: Optional[int] = None,
        height_cm: Optional[float] = None,
        weight_kg: Optional[float] = None,
        age_index: float = 1.0,
        **kwargs,
    ) -> PremiumBreakdown:
        shared = calculate_premium(
            coverage_amount=coverage_amount,
            base_premium_rate=base_rate,
            smoker_factor=smoker_factor,
            age=age if age is not None else _DEFAULT_AGE,
            is_smoker=is_smoker,
            height_cm=height_cm if height_cm is not None else _DEFAULT_HEIGHT_CM,
            weight_kg=weight_kg if weight_kg is not None else _DEFAULT_WEIGHT_KG,
            loading_pct=loading_pct,
            age_index=age_index,
            apply_age_factor=self._age_rated,
            apply_charges=self._charged,
        )
        return PremiumBreakdown(
            base_premium=shared.base_premium,
            loading_amount=shared.loading_applied,
            policy_fee=shared.policy_fee,
            tax_amount=shared.tax_amount,
            total_premium=shared.total_premium,
            rating_basis=self._rating_basis(),
            loading_pct=loading_pct,
        )

    def _rating_basis(self) -> str:
        raise NotImplementedError


# ── Life & Endowment calculator (uses smoker factor) ─────────────────────────

class _LifeCalculator(_BaseCalculator):
    """
    Used for: TERM_LIFE, WHOLE_LIFE, ENDOWMENT, SAVINGS, SINGLE_PREMIUM,
              CHILD_EDUCATION_MARRIAGE, FAMILY_FLOATER

    Annual premium:
      base    = (rate / 1000) × coverage × age_factor
      loading = base × (smoker_factor - 1) + base × (bmi_factor - 1)
              + base × (loading_pct / 100)
      total   = base + loading + policy_fee + stamp_duty
    """

    def _rating_basis(self) -> str:
        return ("Life: annual (rate/1000 × coverage × age_factor) "
                "+ smoker/BMI/underwriting loadings + fee + duty")


# ── Health / Hospital Cash calculator ─────────────────────────────────────────

class _HealthCalculator(_LifeCalculator):
    """
    HEALTH_CASH — same actuarial formula as Life but smoker loading is lower
    and the rate table reflects medical utilisation, not mortality.
    Inherits _LifeCalculator; override _rating_basis only for audit clarity.
    """

    def _rating_basis(self) -> str:
        return ("Health: annual (utilisation_rate/1000 × coverage × age_factor) "
                "+ smoker/BMI/underwriting loadings + fee + duty")


# ── Group Life calculator (negotiated, age-banded) ────────────────────────────

class _GroupLifeCalculator(_BaseCalculator):
    """
    GROUP_LIFE — simplified flat rate; no individual age band and no smoker
    loading, because group business is negotiated at pool level per-MasterPolicy.
    This is a reasonable STP placeholder for member certificates.

    Annual premium:
      total = (rate / 1000) × coverage   (+ underwriting loading, if any)
    """

    _age_rated = False
    _charged = False

    def calculate(self, *args, **kwargs) -> PremiumBreakdown:
        # Group members are not individually smoker-rated.
        kwargs["is_smoker"] = False
        kwargs["smoker_factor"] = 1.0
        return super().calculate(*args, **kwargs)

    def _rating_basis(self) -> str:
        return "Group Life: annual flat rate/1000 × coverage (no individual age/smoker rating)"


# ── Registry & factory ────────────────────────────────────────────────────────

_CALCULATOR_MAP: dict[str, _BaseCalculator] = {
    "TERM_LIFE":                _LifeCalculator(),
    "WHOLE_LIFE":               _LifeCalculator(),
    "ENDOWMENT":                _LifeCalculator(),
    "SAVINGS":                  _LifeCalculator(),
    "SINGLE_PREMIUM":           _LifeCalculator(),
    "CHILD_EDUCATION_MARRIAGE": _LifeCalculator(),
    "FAMILY_FLOATER":           _LifeCalculator(),
    "HEALTH_CASH":              _HealthCalculator(),
    "GROUP_LIFE":               _GroupLifeCalculator(),
}

_DEFAULT_CALCULATOR = _LifeCalculator()


def get_calculator(insurance_type: str) -> _BaseCalculator:
    """Return the correct calculator for an insurance product type."""
    calc = _CALCULATOR_MAP.get(insurance_type.upper(), _DEFAULT_CALCULATOR)
    if calc is _DEFAULT_CALCULATOR and insurance_type.upper() not in _CALCULATOR_MAP:
        log.warning(
            "No calculator registered for insurance_type=%r — falling back to LifeCalculator",
            insurance_type,
        )
    return calc


def get_default_rates(insurance_type: str) -> tuple[float, float]:
    """Return (base_rate, smoker_factor) fallback for an insurance type."""
    return _DEFAULT_RATES.get(insurance_type.upper(), (3.5, 1.0))


# ── Public API ─────────────────────────────────────────────────────────────────

class PricingEngine:
    """
    Stateless facade. The router calls PricingEngine.calculate() — it never
    references product-specific fields or rating formulas directly.

    Usage:
        from services.pricing_engine import PricingEngine, GRACE_PERIOD_DAYS

        breakdown = PricingEngine.calculate(
            insurance_type=policy.insurance_type,
            coverage_amount=policy.coverage_amount,
            term_years=policy.term_years,
            base_rate=plan.base_premium_rate,
            smoker_factor=plan.smoker_factor,
            loading_pct=20.0,         # see routers/policies.py::_effective_loading_pct
            is_smoker=customer.is_smoker,
            age=42,                   # drives the age band — omit only if unknown
            height_cm=customer.height_cm,
            weight_kg=customer.weight_kg,
            age_index=1.0,            # 1.02^(renewal_year-1) for renewals
        )
        total = breakdown.total_premium   # ANNUAL premium, not a term total

    ``term_years`` is accepted (and recorded on the contract) but is NOT a
    multiplier: the result is the premium for one policy year.
    """

    @staticmethod
    def calculate(
        insurance_type: str,
        coverage_amount: float,
        term_years: int,
        base_rate: float,
        smoker_factor: float,
        loading_pct: float = 0.0,
        is_smoker: bool = False,
        age: Optional[int] = None,
        height_cm: Optional[float] = None,
        weight_kg: Optional[float] = None,
        age_index: float = 1.0,         # multiplier for renewal re-rating
    ) -> PremiumBreakdown:
        """
        Polymorphic entry point. Routes to the correct _BaseCalculator subclass
        based on insurance_type, which then delegates the arithmetic to
        shared.pricing.calculator.calculate_premium — the same function POST
        /quote runs, so a quote and its issued contract agree.

        ``age_index`` re-rates the base for renewals; it is passed through
        rather than pre-multiplied so the shared calculator reports it.
        """
        calc = get_calculator(insurance_type)
        return calc.calculate(
            coverage_amount=coverage_amount,
            term_years=term_years,
            base_rate=base_rate,
            loading_pct=loading_pct,
            smoker_factor=smoker_factor,
            is_smoker=is_smoker,
            age=age,
            height_cm=height_cm,
            weight_kg=weight_kg,
            age_index=age_index,
        )

    @staticmethod
    def preview(
        insurance_type: str,
        coverage_amount: float,
        term_years: int,
        base_rate: float = 0.0,
        smoker_factor: float = 1.0,
        loading_pct: float = 0.0,
        is_smoker: bool = False,
        age: Optional[int] = None,
        height_cm: Optional[float] = None,
        weight_kg: Optional[float] = None,
    ) -> PremiumBreakdown:
        """
        Same as calculate() but falls back to default rates when base_rate == 0.
        Used by the UI modal to show an indicative premium before plan data loads.
        """
        if base_rate == 0:
            base_rate, smoker_factor = get_default_rates(insurance_type)
        return PricingEngine.calculate(
            insurance_type=insurance_type,
            coverage_amount=coverage_amount,
            term_years=term_years,
            base_rate=base_rate,
            smoker_factor=smoker_factor,
            loading_pct=loading_pct,
            is_smoker=is_smoker,
            age=age,
            height_cm=height_cm,
            weight_kg=weight_kg,
        )
