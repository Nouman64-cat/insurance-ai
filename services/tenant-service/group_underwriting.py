"""Group-policy (Master Policy) underwriting rules and census validation.

Deliberately separate from services/risk-engine/underwriting_rules.py — group
underwriting operates on a batch of employees (a census), not a single
customer, and has no per-person medical-exam-tier concept. Real insurers
evaluate the group as a whole (size, industry, claims history) rather than
underwriting each employee individually.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any, Dict, List, Optional, Set, Tuple

from pydantic import BaseModel

# Flat regardless of catalog entry — the seeded GROUP_LIFE_SME InsurancePlan
# row declares min_group_size=5, but nothing links a MasterPolicy to a specific
# InsurancePlan row yet, so a 5-9 employee SME group can never pass validation
# today. Pre-existing gap, not introduced here; fixing it needs the
# MasterPolicy -> InsurancePlan linkage this module's callers don't have.
MIN_GROUP_SIZE = 10
SUM_ASSURED_MULTIPLE_RANGE = (12.0, 36.0)   # x monthly basic salary

REQUIRED_CENSUS_FIELDS = ["cnic", "name", "dob", "gender", "occupation", "declared_income"]

_CNIC_RE = re.compile(r"\d{5}-\d{7}-\d")


def normalize_cnic(raw: str) -> Optional[str]:
    """Same format accepted for individual customers: 13 digits or
    XXXXX-XXXXXXX-X. Returns None if the value doesn't match either form."""
    v = raw.strip()
    if re.fullmatch(r"\d{13}", v):
        v = f"{v[:5]}-{v[5:12]}-{v[12]}"
    return v if _CNIC_RE.fullmatch(v) else None


class CensusValidationResult(BaseModel):
    is_valid: bool
    total: int
    duplicate_cnics: List[str] = []
    missing_fields: List[str] = []
    errors: List[str] = []


def _row_missing_fields(row: Dict[str, Any], index: int) -> List[str]:
    missing = [f for f in REQUIRED_CENSUS_FIELDS if row.get(f) in (None, "") and row.get(f) != 0]
    return [f"Row {index + 1}: missing {field}" for field in missing]


def validate_census(
    existing_cnics: Set[str],
    employees: List[Dict[str, Any]],
) -> CensusValidationResult:
    """Validate an employee census batch before it's persisted.

    Checks: minimum group size, required fields per row, duplicate CNICs
    within the batch, and CNICs that already exist for this organization.
    """
    errors: List[str] = []
    missing_fields: List[str] = []

    if len(employees) < MIN_GROUP_SIZE:
        errors.append(
            f"Group size ({len(employees)}) is below the minimum of {MIN_GROUP_SIZE} "
            f"employees required for a group policy."
        )

    seen_cnics: Set[str] = set()
    duplicate_cnics: Set[str] = set()

    for i, row in enumerate(employees):
        missing_fields.extend(_row_missing_fields(row, i))

        raw_cnic = (row.get("cnic") or "").strip()
        if not raw_cnic:
            continue

        cnic = normalize_cnic(raw_cnic)
        if cnic is None:
            errors.append(
                f"Row {i + 1}: CNIC '{raw_cnic}' must be 13 digits or in the format XXXXX-XXXXXXX-X."
            )
            continue

        if cnic in existing_cnics or cnic in seen_cnics:
            duplicate_cnics.add(cnic)
        else:
            seen_cnics.add(cnic)

    if duplicate_cnics:
        errors.append(
            f"{len(duplicate_cnics)} duplicate CNIC(s) found — either repeated within "
            f"this batch or already enrolled for this organization."
        )

    is_valid = not errors and not missing_fields

    return CensusValidationResult(
        is_valid=is_valid,
        total=len(employees),
        duplicate_cnics=sorted(duplicate_cnics),
        missing_fields=missing_fields,
        errors=errors,
    )


def validate_sum_assured_multiple(multiple: float) -> List[str]:
    lo, hi = SUM_ASSURED_MULTIPLE_RANGE
    if multiple < lo or multiple > hi:
        return [
            f"Sum assured multiple must be between {lo:g}x and {hi:g}x monthly basic "
            f"salary (got {multiple:g}x)."
        ]
    return []


# ─────────────────────────────────────────────────────────────────────────────
# Free Cover Limit (FCL) — the guaranteed-issue ceiling for a group
# ─────────────────────────────────────────────────────────────────────────────
#
# Real insurers derive FCL from group size, average age, growth trend, and
# past mortality experience (see the R&D notes this was designed from) — none
# of which a brand-new scheme has except size and age. The bands below are a
# v1 heuristic in the same banded-multiplier spirit as
# shared/pricing/calculator.py's _AGE_BANDS: a reasonable approximation to
# make guaranteed-issue vs. above-FCL routing behave sensibly, not an
# actuarial filing or a regulatory figure.

_FCL_BASE_AMOUNT = 1_000_000.0   # PKR — base FCL for a minimum-size, average-age group

# (min_group_size, factor) — bigger groups give the insurer more confidence in
# the average risk (credibility-style scaling), so more of the group is
# auto-issued without evidence of insurability.
_FCL_SIZE_FACTOR_BANDS: List[Tuple[int, float]] = [
    (10, 1.0),
    (25, 1.5),
    (50, 2.0),
    (100, 3.0),
    (250, 4.0),
]

# (min_average_age, factor) — an older group carries higher mortality risk, so
# the guaranteed-issue ceiling is lower.
_FCL_AGE_FACTOR_BANDS: List[Tuple[float, float]] = [
    (0.0, 1.2),
    (30.0, 1.0),
    (40.0, 0.8),
    (50.0, 0.6),
]


def age_from_dob(dob: date) -> int:
    """Local helper — risk-engine's equivalent isn't importable cross-service,
    same reasoning this module already keeps its own underwriting rules
    separate from services/risk-engine/underwriting_rules.py."""
    today = date.today()
    years = today.year - dob.year
    if (today.month, today.day) < (dob.month, dob.day):
        years -= 1
    return years


def average_age(employees: List[Dict[str, Any]]) -> float:
    """Average age (in years) across a census batch, from each row's `dob`."""
    ages: List[int] = []
    for row in employees:
        raw_dob = row.get("dob")
        if raw_dob is None:
            continue
        dob = raw_dob if isinstance(raw_dob, date) else date.fromisoformat(str(raw_dob))
        ages.append(age_from_dob(dob))
    return sum(ages) / len(ages) if ages else 0.0


def _banded_factor(value: float, bands: List[Tuple[float, float]]) -> float:
    applicable = [factor for lower, factor in bands if value >= lower]
    return applicable[-1] if applicable else bands[0][1]


def compute_free_cover_limit(group_size: int, average_age: float) -> float:
    """v1 heuristic FCL: base amount x size-factor x age-factor.

    Not a regulatory filing — a placeholder approximation so guaranteed-issue
    vs. above-FCL routing behaves sensibly for a brand-new scheme with no
    claims history yet.
    """
    size_factor = _banded_factor(float(group_size), _FCL_SIZE_FACTOR_BANDS)
    age_factor = _banded_factor(average_age, _FCL_AGE_FACTOR_BANDS)
    return _FCL_BASE_AMOUNT * size_factor * age_factor
