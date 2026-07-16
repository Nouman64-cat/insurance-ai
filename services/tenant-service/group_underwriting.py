"""Group-policy (Master Policy) underwriting rules and census validation.

Deliberately separate from services/risk-engine/underwriting_rules.py — group
underwriting operates on a batch of employees (a census), not a single
applicant, and has no per-person medical-exam-tier concept. Real insurers
evaluate the group as a whole (size, industry, claims history) rather than
underwriting each employee individually.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set

from pydantic import BaseModel

MIN_GROUP_SIZE = 10
SUM_ASSURED_MULTIPLE_RANGE = (12.0, 36.0)   # x monthly basic salary

REQUIRED_CENSUS_FIELDS = ["cnic", "name", "dob", "gender", "occupation", "declared_income"]

_CNIC_RE = re.compile(r"\d{5}-\d{7}-\d")


def normalize_cnic(raw: str) -> Optional[str]:
    """Same format accepted for individual applicants: 13 digits or
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
