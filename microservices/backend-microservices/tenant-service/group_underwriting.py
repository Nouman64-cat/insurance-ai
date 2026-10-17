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

SUM_ASSURED_MULTIPLE_RANGE = (12.0, 36.0)   # x monthly basic salary

REQUIRED_CENSUS_FIELDS = ["cnic", "name", "dob", "gender", "occupation", "declared_income"]

# Optional census columns (the census template — GROUP_LIFE_PLAN.md):
#   employee_id, designation, grade, joining_date (YYYY-MM-DD),
#   benefit_class (class name), basic_monthly_salary,
#   is_smoker, height_cm, weight_kg
# declared_income is ANNUAL; basic_monthly_salary defaults to declared_income / 12.

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


def _row_format_errors(row: Dict[str, Any], index: int) -> List[str]:
    """Unparseable values that would otherwise crash census confirm mid-batch."""
    errors: List[str] = []
    for field in ("dob", "joining_date"):
        raw = row.get(field)
        if raw in (None, "") or isinstance(raw, date):
            continue
        try:
            parsed = date.fromisoformat(str(raw))
        except ValueError:
            errors.append(f"Row {index + 1}: {field} '{raw}' must be YYYY-MM-DD.")
            continue
        if parsed > date.today():
            errors.append(f"Row {index + 1}: {field} cannot be in the future.")
    for field in ("declared_income", "basic_monthly_salary"):
        raw = row.get(field)
        if raw in (None, ""):
            continue
        try:
            if float(raw) < 0:
                raise ValueError
        except (TypeError, ValueError):
            errors.append(f"Row {index + 1}: {field} must be a non-negative number.")
    return errors


def validate_census(
    existing_cnics: Set[str],
    employees: List[Dict[str, Any]],
    min_group_size: Optional[int] = None,
) -> CensusValidationResult:
    """Validate an employee census batch before it's persisted.

    Checks: minimum group size (only when given — callers pass the plan's
    min_group_size for a master policy's first census, not for top-ups),
    required fields and parseable values per row, duplicate CNICs within the
    batch, and CNICs already enrolled on this master policy.
    """
    errors: List[str] = []
    missing_fields: List[str] = []

    if min_group_size and len(employees) < min_group_size:
        errors.append(
            f"This plan needs at least {min_group_size} employees on the first census "
            f"(got {len(employees)})."
        )

    seen_cnics: Set[str] = set()
    duplicate_cnics: Set[str] = set()

    for i, row in enumerate(employees):
        missing_fields.extend(_row_missing_fields(row, i))
        errors.extend(_row_format_errors(row, i))

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
            f"this batch or already enrolled on this master policy."
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


# ─────────────────────────────────────────────────────────────────────────────
# Above-FCL outcome — what cover a member actually gets on the quote
# ─────────────────────────────────────────────────────────────────────────────
#
# At or under the FCL a member is guaranteed issue. Above it, the underwriter's
# decision on the member's case (mirrored onto the certificate Policy.status by
# routers/cases.py) decides: approved → full cover, approved with loading →
# full cover priced with the loading, declined → cover restricted to the FCL
# (standard group practice: the guaranteed-issue part is never lost). Anything
# still undecided blocks quoting.

class MemberOutcome(BaseModel):
    basis: str                       # Guaranteed | Approved | Loaded | Restricted | Pending
    covered_amount: float
    loading_pct: float = 0.0
    note: Optional[str] = None


_APPROVED = {"Approved"}
_LOADED = {"AcceptedWithLoadings"}
_DECLINED = {"Declined"}


def member_underwriting_outcome(
    coverage_amount: float,
    free_cover_limit: Optional[float],
    certificate_status: str,
    suggested_loading: Optional[float] = None,
) -> MemberOutcome:
    if free_cover_limit is None or coverage_amount <= free_cover_limit:
        return MemberOutcome(basis="Guaranteed", covered_amount=coverage_amount)
    if certificate_status in _APPROVED:
        return MemberOutcome(basis="Approved", covered_amount=coverage_amount)
    if certificate_status in _LOADED:
        return MemberOutcome(basis="Loaded", covered_amount=coverage_amount, loading_pct=float(suggested_loading or 0))
    if certificate_status in _DECLINED:
        return MemberOutcome(
            basis="Restricted", covered_amount=free_cover_limit,
            note="Restricted to the Free Cover Limit after an underwriting decline",
        )
    return MemberOutcome(basis="Pending", covered_amount=coverage_amount,
                         note="Above the Free Cover Limit — awaiting an underwriting decision")
