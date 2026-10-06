"""Group Life scheme pricing — one rate for the whole pool.

Pure functions (no DB, no I/O), like shared/pricing/calculator.py, whose age
bands and statutory charges this reuses so group and individual quotes agree
on what "age 40" and "stamp duty" mean.

A group is priced collectively, not as N individual policies:

    rate_per_mille = plan.base_premium_rate
                     × age_factor     (SA-weighted average age of all lives)
                     × size_factor    (volume / credibility discount)
                     × hazard_factor  (share of SA in hazardous occupations)
                     × experience     (1.0 for a new scheme; a renewal prices in the
                                       expiring year's claims — services/group_renewal.py)

    life premium   = SA / 1,000 × rate_per_mille × (1 + loading% / 100)
    risk premium   = Σ life premiums            (members + covered dependents)
    total          = risk premium + one policy fee + stamp duty

Loadings come from above-FCL underwriting ("Approve with Loading"). Bands are
v1 placeholders in the same spirit as calculator.py — not an actuarial filing.
Takaful schemes use the same arithmetic and call the result a contribution.
On top of that, takaful_split() allocates the risk contribution between the
operator's Wakala fee and the Participants' Takaful Fund (PTF), and cedes a share
of the PTF allocation to the retakaful operator. The policy fee and stamp duty are
charges, not contribution, so they sit outside the split.

Benefits beyond Life (Accidental Death, Disability, Pay Continuation, Fee
Continuation) are priced per 1,000 of their own cover at flat v1 rates and added to
the member's premium — see RIDER_RATES_PER_MILLE.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel

from shared.pricing.calculator import POLICY_FEE, STAMP_DUTY_RATE, calculate_age_factor
from shared.underwriting.occupation_hazard import OccupationHazardLevel, classify_occupation_hazard

# Wakala (agency) fee used when a Takaful plan doesn't set its own, as a % of
# the risk contribution. A v1 placeholder, like the rating bands below.
DEFAULT_WAKALA_FEE_PCT = float(os.environ.get("TAKAFUL_WAKALA_FEE_PCT", "30"))

# Retakaful: the share of the PTF allocation ceded to the retakaful operator when a Takaful
# plan doesn't set its own. A v1 placeholder, like the Wakala fee.
DEFAULT_RETAKAFUL_SHARE_PCT = float(os.environ.get("TAKAFUL_RETAKAFUL_SHARE_PCT", "20"))

# Annual PKR per 1,000 of cover for the benefits sold on top of Life. v1 placeholders in
# the spirit of the rating bands below — flat per benefit, not age-rated.
RIDER_RATES_PER_MILLE: Dict[str, float] = {
    "AccidentalDeath": 0.30,
    "Disability": 0.60,
    "PayContinuation": 1.20,
    "FeeContinuation": 0.40,
}

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
    riders: Dict[str, float] = {}     # benefit -> cover amount, beyond Life (members only)


class GroupPricingResult(BaseModel):
    experience_factor: float = 1.0
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
    by_life: Dict[str, float]        # key -> annual premium allocation (life + riders)
    by_coverage: Dict[str, float] = {}          # benefit -> annual premium, Life included
    cover_by_coverage: Dict[str, float] = {}    # benefit -> total cover amount, Life included


def life_premium(sum_assured: float, rate_per_mille: float, loading_pct: float = 0.0) -> float:
    """One covered life's annual premium at an effective rate. The single place
    this arithmetic lives — price_group() and the endorsement engine both use it,
    so a mid-term change is priced exactly like the quote it amends."""
    return sum_assured / 1000 * rate_per_mille * (1 + max(0.0, loading_pct) / 100)


def rider_premiums(riders: Dict[str, float], experience_factor: float = 1.0) -> Dict[str, float]:
    """Annual premium of each rider cover. A benefit with no rate (an unknown type) is free
    rather than silently mispriced — class setup rejects unknown types."""
    return {k: amount / 1000 * RIDER_RATES_PER_MILLE.get(k, 0.0) * experience_factor for k, amount in riders.items()}


def member_annual_premium(sum_assured: float, rate_per_mille: float, loading_pct: float = 0.0,
                          riders: Optional[Dict[str, float]] = None, experience_factor: float = 1.0) -> float:
    """A member's whole annual premium: life at the scheme's effective rate plus their riders."""
    return life_premium(sum_assured, rate_per_mille, loading_pct) + sum(rider_premiums(riders or {}, experience_factor).values())


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


def price_group(lives: List[PricedLife], base_rate_per_mille: float, experience_factor: float = 1.0) -> GroupPricingResult:
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
    rate = round(base_rate_per_mille * age_f * size_f * hazard_f * experience_factor, 4)

    by_life: Dict[str, float] = {}
    by_coverage: Dict[str, float] = {"Life": 0.0}
    cover_by_coverage: Dict[str, float] = {"Life": 0.0}
    classes: Dict[str, Dict[str, Any]] = {}
    for life in lives:
        life_part = life_premium(life.sum_assured, rate, life.loading_pct)
        by_coverage["Life"] += life_part
        cover_by_coverage["Life"] += life.sum_assured
        riders = rider_premiums(life.riders, experience_factor)
        for kind, amount in riders.items():
            by_coverage[kind] = by_coverage.get(kind, 0.0) + amount
            cover_by_coverage[kind] = cover_by_coverage.get(kind, 0.0) + life.riders[kind]
        premium = life_part + sum(riders.values())
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
        experience_factor=experience_factor,
        base_rate_per_mille=base_rate_per_mille,
        rate_per_mille=rate,
        risk_premium=risk_premium,
        policy_fee=round(POLICY_FEE, 2),
        stamp_duty=stamp_duty,
        total_premium=round(subtotal + stamp_duty, 2),
        by_class=[{**c, "sum_assured": round(c["sum_assured"], 2), "premium": round(c["premium"], 2)}
                  for c in classes.values()],
        by_life=by_life,
        by_coverage={k: round(v, 2) for k, v in by_coverage.items()},
        cover_by_coverage={k: round(v, 2) for k, v in cover_by_coverage.items()},
    )


class TakafulSplit(BaseModel):
    wakala_fee_pct: float
    wakala_fee: float
    ptf_allocation: float                 # gross: the contribution less the Wakala fee
    retakaful_share_pct: float = 0.0
    retakaful_contribution: float = 0.0   # ceded out of the PTF allocation
    ptf_retained: float = 0.0             # what the fund keeps to pay claims


def takaful_split(risk_contribution: float, wakala_fee_pct: Optional[float],
                  retakaful_share_pct: Optional[float] = None) -> TakafulSplit:
    """Split a Takaful risk contribution into the operator's Wakala fee and the PTF
    allocation, and cede a share of the PTF allocation to the retakaful operator. The
    Wakala fee and PTF always add back to the contribution; the retakaful contribution
    is paid out of the PTF, so PTF retained + retakaful = PTF allocation."""
    pct = DEFAULT_WAKALA_FEE_PCT if wakala_fee_pct is None else float(wakala_fee_pct)
    if not 0 <= pct <= 100:
        raise ValueError(f"Wakala fee must be between 0% and 100% (got {pct:g}%).")
    ceded = DEFAULT_RETAKAFUL_SHARE_PCT if retakaful_share_pct is None else float(retakaful_share_pct)
    if not 0 <= ceded <= 100:
        raise ValueError(f"Retakaful share must be between 0% and 100% (got {ceded:g}%).")
    fee = round(risk_contribution * pct / 100, 2)
    ptf = round(risk_contribution - fee, 2)
    retakaful = round(ptf * ceded / 100, 2)
    return TakafulSplit(wakala_fee_pct=pct, wakala_fee=fee, ptf_allocation=ptf, retakaful_share_pct=ceded,
                        retakaful_contribution=retakaful, ptf_retained=round(ptf - retakaful, 2))


def takaful_quote_fields(split: Optional[TakafulSplit]) -> Dict[str, Optional[float]]:
    """The GroupQuote columns a split fills in (all None for a Conventional quote)."""
    if split is None:
        return {"wakala_fee_pct": None, "wakala_fee": None, "ptf_allocation": None,
                "retakaful_share_pct": None, "retakaful_contribution": None}
    return {"wakala_fee_pct": split.wakala_fee_pct, "wakala_fee": split.wakala_fee, "ptf_allocation": split.ptf_allocation,
            "retakaful_share_pct": split.retakaful_share_pct, "retakaful_contribution": split.retakaful_contribution}
