"""
Polymorphic premium pricing engine.

Design goals:
  1. Product-agnostic interface: the router only calls PricingEngine.calculate().
  2. Product-specific subclasses handle rating logic; adding P&C / Marine / Auto
     requires only a new subclass — no changes to the router.
  3. All inputs come from the Policy and InsurancePlan models; no domain knowledge
     leaks into the routing layer.

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

log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

GRACE_PERIOD_DAYS: int = int(os.environ.get("GRACE_PERIOD_DAYS", "30"))
POLICY_FEE: float = float(os.environ.get("POLICY_FEE_PKR", "500"))
STAMP_DUTY_RATE: float = float(os.environ.get("STAMP_DUTY_RATE", "0.01"))  # 1% federal

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
    Implements the shared fee + tax wrapper; subclasses supply _net_premium().
    """

    def calculate(
        self,
        coverage_amount: float,
        term_years: int,
        base_rate: float,
        loading_pct: float,
        **kwargs,
    ) -> PremiumBreakdown:
        net = self._net_premium(coverage_amount, term_years, base_rate, loading_pct, **kwargs)
        subtotal = net + POLICY_FEE
        tax = subtotal * STAMP_DUTY_RATE
        total = subtotal + tax
        return PremiumBreakdown(
            base_premium=round(net - round(net * loading_pct / 100.0, 2), 2),
            loading_amount=round(net * loading_pct / 100.0, 2),
            policy_fee=POLICY_FEE,
            tax_amount=round(tax, 2),
            total_premium=round(total, 2),
            rating_basis=self._rating_basis(),
            loading_pct=loading_pct,
        )

    def _net_premium(
        self, coverage_amount: float, term_years: int,
        base_rate: float, loading_pct: float, **kwargs
    ) -> float:
        raise NotImplementedError

    def _rating_basis(self) -> str:
        raise NotImplementedError


# ── Life & Endowment calculator (uses smoker factor) ─────────────────────────

class _LifeCalculator(_BaseCalculator):
    """
    Used for: TERM_LIFE, WHOLE_LIFE, ENDOWMENT, SAVINGS, SINGLE_PREMIUM,
              CHILD_EDUCATION_MARRIAGE, FAMILY_FLOATER

    Formula:
      base_premium = (effective_rate / 1000) × coverage_amount × term_years
      effective_rate = base_rate × smoker_factor   (if is_smoker else base_rate)
      net = base_premium × (1 + loading_pct / 100)
    """

    def _net_premium(
        self, coverage_amount: float, term_years: int,
        base_rate: float, loading_pct: float,
        smoker_factor: float = 1.0, is_smoker: bool = False, **kwargs
    ) -> float:
        effective_rate = base_rate * (smoker_factor if is_smoker else 1.0)
        base = (effective_rate / 1000.0) * coverage_amount * term_years
        return base * (1.0 + loading_pct / 100.0)

    def _rating_basis(self) -> str:
        return "Life: (rate/1000 × coverage × term × smoker_factor) × (1 + loading%)"


# ── Health / Hospital Cash calculator ─────────────────────────────────────────

class _HealthCalculator(_LifeCalculator):
    """
    HEALTH_CASH — same actuarial formula as Life but smoker loading is lower
    and the rate table reflects medical utilisation, not mortality.
    Inherits _LifeCalculator; override _rating_basis only for audit clarity.
    """

    def _rating_basis(self) -> str:
        return "Health: (utilisation_rate/1000 × coverage × term × smoker_factor) × (1 + loading%)"


# ── Group Life calculator (negotiated, age-banded) ────────────────────────────

class _GroupLifeCalculator(_BaseCalculator):
    """
    GROUP_LIFE — simplified flat rate; no individual smoker loading.
    Real group pricing is age-banded and negotiated per-MasterPolicy;
    this is a reasonable STP placeholder for member certificates.

    Formula:
      net = (base_rate / 1000) × coverage_amount × term_years
    """

    def _net_premium(
        self, coverage_amount: float, term_years: int,
        base_rate: float, loading_pct: float, **kwargs
    ) -> float:
        return (base_rate / 1000.0) * coverage_amount * term_years

    def _rating_basis(self) -> str:
        return "Group Life: flat rate/1000 × coverage × term (no individual smoker loading)"


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
            loading_pct=20.0,         # from RiskAssessment.suggested_loading
            is_smoker=customer.is_smoker,
            age_index=1.0,            # 1.02^(renewal_year-1) for renewals
        )
        total = breakdown.total_premium
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
        age_index: float = 1.0,         # multiplier for renewal re-rating
    ) -> PremiumBreakdown:
        """
        Polymorphic entry point. Routes to the correct _BaseCalculator subclass
        based on insurance_type. Applies age_index to base_rate before dispatch
        (used by the renewal engine to escalate rates year-on-year).
        """
        calc = get_calculator(insurance_type)
        adjusted_rate = base_rate * age_index
        return calc.calculate(
            coverage_amount=coverage_amount,
            term_years=term_years,
            base_rate=adjusted_rate,
            loading_pct=loading_pct,
            smoker_factor=smoker_factor,
            is_smoker=is_smoker,
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
        )
