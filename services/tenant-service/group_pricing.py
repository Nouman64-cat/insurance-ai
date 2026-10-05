"""Group Life scheme pricing — one rate for the whole pool.

Pure functions (no DB, no I/O), like shared/pricing/calculator.py, whose age
bands and statutory charges this reuses so group and individual quotes agree
on what "age 40" and "stamp duty" mean.

A group is priced collectively, not as N individual policies:

    rate_per_mille = plan.base_premium_rate
                     × age_factor     (SA-weighted average age of all lives)
                     × size_factor    (volume / credibility discount)
                     × hazard_factor  (share of SA in hazardous occupations)

    life premium   = SA / 1,000 × rate_per_mille × (1 + loading% / 100)
    risk premium   = Σ life premiums            (members + covered dependents)
    total          = risk premium + one policy fee + stamp duty

Loadings come from above-FCL underwriting ("Approve with Loading"). Bands are
v1 placeholders in the same spirit as calculator.py — not an actuarial filing.
Takaful schemes use the same arithmetic and call the result a contribution;
the Wakala fee / PTF split lands in GROUP_LIFE_PLAN.md Phase 6.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel

from shared.pricing.calculator import POLICY_FEE, STAMP_DUTY_RATE, calculate_age_factor
from shared.underwriting.occupation_hazard import OccupationHazardLevel, classify_occupation_hazard

# (min_member_count, factor) — larger pools are more credible, so cheaper per life.
_SIZE_FACTOR_BANDS: List[Tuple[int, float]] = [
    (0, 1.00),
    (25, 0.95),
    (50, 0.90),
    (100, 0.85),
    (250, 0.80),
    (1000, 0.75),
]

# Extra mortality loading per unit share of sum assured in each hazard level.
_HAZARD_LOADING = {
    OccupationHazardLevel.HIGH: 0.50,
    OccupationHazardLevel.MEDIUM: 0.20,
}


class PricedLife(BaseModel):
    """One covered life — a member or a covered dependent."""
    key: str                         # GroupMember / GroupMemberDependent id
    kind: str                        # "member" | "dependent"
    benefit_class: Optional[str] = None
    age: int
    sum_assured: float
    occupation: Optional[str] = None
    loading_pct: float = 0.0


class GroupPricingResult(BaseModel):
    member_count: int
    dependent_count: int
    total_sum_assured: float
    weighted_average_age: float
    age_factor: float
    size_factor: float
    hazard_factor: float
    base_rate_per_mille: float
    rate_per_mille: float
    risk_premium: float
    policy_fee: float
    stamp_duty: float
    total_premium: float
    by_class: List[Dict[str, Any]]
    by_life: Dict[str, float]        # key -> annual premium allocation


def size_factor(member_count: int) -> float:
    applicable = [f for lower, f in _SIZE_FACTOR_BANDS if member_count >= lower]
    return applicable[-1]


def hazard_factor(lives: List[PricedLife]) -> float:
    """1 + Σ loading × (share of members' SA in that hazard level). Dependents
    have no occupation and don't move the factor."""
    members = [l for l in lives if l.kind == "member"]
    total = sum(l.sum_assured for l in members)
    if total <= 0:
        return 1.0
    factor = 1.0
    for level, loading in _HAZARD_LOADING.items():
        share = sum(l.sum_assured for l in members if classify_occupation_hazard(l.occupation) == level) / total
        factor += loading * share
    return round(factor, 4)


def price_group(lives: List[PricedLife], base_rate_per_mille: float) -> GroupPricingResult:
    if not lives:
        raise ValueError("Cannot price a scheme with no covered lives.")
    total_sa = sum(l.sum_assured for l in lives)
    if total_sa <= 0:
        raise ValueError("Cannot price a scheme with zero total sum assured.")

    member_count = sum(1 for l in lives if l.kind == "member")
    weighted_age = sum(l.age * l.sum_assured for l in lives) / total_sa
    age_f = calculate_age_factor(round(weighted_age))
    size_f = size_factor(member_count)
    hazard_f = hazard_factor(lives)
    rate = round(base_rate_per_mille * age_f * size_f * hazard_f, 4)

    by_life: Dict[str, float] = {}
    classes: Dict[str, Dict[str, Any]] = {}
    for life in lives:
        premium = life.sum_assured / 1000 * rate * (1 + max(0.0, life.loading_pct) / 100)
        by_life[life.key] = round(premium, 2)
        name = life.benefit_class or "Standard"
        bucket = classes.setdefault(name, {"benefit_class": name, "members": 0, "dependents": 0,
                                           "sum_assured": 0.0, "premium": 0.0})
        bucket["members" if life.kind == "member" else "dependents"] += 1
        bucket["sum_assured"] += life.sum_assured
        bucket["premium"] += premium

    risk_premium = round(sum(by_life.values()), 2)
    subtotal = risk_premium + POLICY_FEE
    stamp_duty = round(subtotal * STAMP_DUTY_RATE, 2)

    return GroupPricingResult(
        member_count=member_count,
        dependent_count=len(lives) - member_count,
        total_sum_assured=round(total_sa, 2),
        weighted_average_age=round(weighted_age, 1),
        age_factor=age_f,
        size_factor=size_f,
        hazard_factor=hazard_f,
        base_rate_per_mille=base_rate_per_mille,
        rate_per_mille=rate,
        risk_premium=risk_premium,
        policy_fee=round(POLICY_FEE, 2),
        stamp_duty=stamp_duty,
        total_premium=round(subtotal + stamp_duty, 2),
        by_class=[{**c, "sum_assured": round(c["sum_assured"], 2), "premium": round(c["premium"], 2)}
                  for c in classes.values()],
        by_life=by_life,
    )
