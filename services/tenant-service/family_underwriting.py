"""Family-policy (FamilyGroup) underwriting rules and member-batch validation.

Deliberately separate from services/risk-engine/underwriting_rules.py, same
reasoning as group_underwriting.py: this module operates on a batch of family
members before they're persisted, not a single already-created customer.

Unlike group_underwriting.py there is no Free Cover Limit / guaranteed-issue
concept here — a family is small and self-selected (unlike a large random
employer pool), so every member is always individually risk-scored regardless
of plan type. See routers/families.py.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Set

from pydantic import BaseModel

from group_underwriting import age_from_dob, normalize_cnic  # noqa: F401 — re-exported for routers/families.py

MIN_FAMILY_SIZE = 2
MAX_FAMILY_SIZE = 8

REQUIRED_MEMBER_FIELDS = ["cnic", "name", "dob", "gender", "occupation", "declared_income", "relationship"]

# Life-bundle members additionally choose their own coverage and catalog plan
# (mirrors POST /quote's plan_code — a tenant can have more than one TERM_LIFE
# product, so "insurance_type" alone isn't specific enough to price against).
# Not required for floater members, who all share the FAMILY_FLOATER catalog
# row and the pool's total_sum_insured instead of a per-member coverage_amount.
LIFE_BUNDLE_EXTRA_FIELDS = ["coverage_amount", "plan_code"]

_VALID_RELATIONSHIPS = {"Self", "Spouse", "Child", "Parent"}


class FamilyValidationResult(BaseModel):
    is_valid: bool
    total: int
    duplicate_cnics: List[str] = []
    missing_fields: List[str] = []
    errors: List[str] = []


def _row_missing_fields(row: Dict[str, Any], index: int) -> List[str]:
    missing = [f for f in REQUIRED_MEMBER_FIELDS if row.get(f) in (None, "") and row.get(f) != 0]
    return [f"Row {index + 1}: missing {field}" for field in missing]


def validate_family_members(
    existing_cnics: Set[str],
    members: List[Dict[str, Any]],
) -> FamilyValidationResult:
    """Validate a family-member batch before it's persisted.

    Checks: family-size bounds (2-8), required fields per row (including
    `relationship`), exactly one SELF member, duplicate CNICs within the
    batch, and CNICs already enrolled in *this specific FamilyPolicy*
    (`existing_cnics` — see routers/families.py's callers). Unlike
    group_underwriting.validate_census, this is deliberately scoped to one
    policy, not the whole family: the same person is expected to appear
    across a family's multiple policies (e.g. enrolled in both the floater
    and the life bundle) — routers/families.py reuses their existing
    Customer row rather than re-validating them as a duplicate there.
    """
    errors: List[str] = []
    missing_fields: List[str] = []

    if len(members) < MIN_FAMILY_SIZE or len(members) > MAX_FAMILY_SIZE:
        errors.append(
            f"Family size ({len(members)}) must be between {MIN_FAMILY_SIZE} and "
            f"{MAX_FAMILY_SIZE} members."
        )

    seen_cnics: Set[str] = set()
    duplicate_cnics: Set[str] = set()
    self_count = 0

    for i, row in enumerate(members):
        missing_fields.extend(_row_missing_fields(row, i))

        relationship = row.get("relationship")
        if relationship is not None and relationship not in _VALID_RELATIONSHIPS:
            errors.append(
                f"Row {i + 1}: relationship '{relationship}' must be one of "
                f"{sorted(_VALID_RELATIONSHIPS)}."
            )
        elif relationship == "Self":
            self_count += 1

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
            f"this batch or already enrolled in this family policy."
        )

    if self_count != 1:
        errors.append(
            f"A family group must have exactly one 'Self' member (found {self_count})."
        )

    is_valid = not errors and not missing_fields

    return FamilyValidationResult(
        is_valid=is_valid,
        total=len(members),
        duplicate_cnics=sorted(duplicate_cnics),
        missing_fields=missing_fields,
        errors=errors,
    )


def validate_life_bundle_members(
    existing_cnics: Set[str],
    members: List[Dict[str, Any]],
) -> FamilyValidationResult:
    """Same checks as validate_family_members, plus each row must also carry
    its own coverage_amount + plan_code (see LIFE_BUNDLE_EXTRA_FIELDS)."""
    result = validate_family_members(existing_cnics, members)

    extra_missing: List[str] = []
    for i, row in enumerate(members):
        extra_missing.extend(
            f"Row {i + 1}: missing {field}"
            for field in LIFE_BUNDLE_EXTRA_FIELDS
            if row.get(field) in (None, "") and row.get(field) != 0
        )

    if not extra_missing:
        return result

    missing_fields = result.missing_fields + extra_missing
    return FamilyValidationResult(
        is_valid=False,
        total=result.total,
        duplicate_cnics=result.duplicate_cnics,
        missing_fields=missing_fields,
        errors=result.errors,
    )


def eldest_age(members: List[Dict[str, Any]]) -> int:
    """Eldest member's age (in years) across a family batch, from each row's
    `dob` — a floater is priced once, off the eldest life, per standard
    floater actuarial practice (see calculate_premium's call site in
    routers/families.py)."""
    ages: List[int] = []
    for row in members:
        raw_dob = row.get("dob")
        if raw_dob is None:
            continue
        dob = raw_dob if isinstance(raw_dob, date) else date.fromisoformat(str(raw_dob))
        ages.append(age_from_dob(dob))
    return max(ages) if ages else 0
