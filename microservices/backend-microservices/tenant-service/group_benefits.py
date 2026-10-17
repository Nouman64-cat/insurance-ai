"""Group Life benefit structure — class resolution and sum-assured calculation.

Pure functions (no DB, no I/O) so they're unit-testable on their own; the
census endpoints in routers/organizations.py feed them GroupBenefitClass rows.

A MasterPolicy's cover formula is negotiated per scheme. Each benefit class
uses one basis (shared/models/core.py GroupBenefitBasis):

    Flat            every member of the class gets flat_amount — grade or
                    designation schemes are one Flat class per grade
    SalaryMultiple  salary_multiple × basic monthly salary
    ServiceBanded   amount of the highest band whose min_years the member's
                    completed years of service reach
    LoanBalance     the member's own outstanding loan balance (Group Credit Life)

then min_cover / max_cover are applied. A MasterPolicy with no classes keeps
its legacy behaviour: sum_assured_multiple × (declared_income / 12).
"""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Optional, Sequence, Tuple

from group_underwriting import SUM_ASSURED_MULTIPLE_RANGE, CensusValidationResult, validate_census
from shared.models.core import GroupBenefitBasis, GroupCoverageType

_BASES = {b.value for b in GroupBenefitBasis}
RIDER_TYPES = {c.value for c in GroupCoverageType if c is not GroupCoverageType.LIFE}


def parse_date(raw: Any) -> Optional[date]:
    if raw in (None, ""):
        return None
    return raw if isinstance(raw, date) else date.fromisoformat(str(raw))


def optional_text(raw: Any) -> Optional[str]:
    """Census cell → trimmed string, or None for blank/missing."""
    if raw in (None, ""):
        return None
    text = str(raw).strip()
    return text or None


def completed_years_of_service(joining_date: date, as_of: date) -> int:
    years = as_of.year - joining_date.year
    if (as_of.month, as_of.day) < (joining_date.month, joining_date.day):
        years -= 1
    return max(years, 0)


def basic_monthly_salary(row: Dict[str, Any]) -> float:
    """Census rows may give basic_monthly_salary explicitly (the usual base for
    a salary multiple); otherwise fall back to declared annual income / 12,
    which is what the pre-class census always used."""
    explicit = row.get("basic_monthly_salary")
    if explicit not in (None, ""):
        return float(explicit)
    return float(row["declared_income"]) / 12


# ── Class definition validation ─────────────────────────────────────────────

def validate_benefit_class(spec: Dict[str, Any]) -> List[str]:
    """Errors for a benefit-class definition (create request body as a dict)."""
    errors: List[str] = []
    basis = spec.get("basis")
    if basis not in _BASES:
        return [f"basis must be one of {sorted(_BASES)} (got {basis!r})."]

    if basis == GroupBenefitBasis.FLAT.value:
        if not spec.get("flat_amount") or spec["flat_amount"] <= 0:
            errors.append("Flat classes need a positive flat_amount.")
    elif basis == GroupBenefitBasis.SALARY_MULTIPLE.value:
        multiple = spec.get("salary_multiple")
        lo, hi = SUM_ASSURED_MULTIPLE_RANGE
        if multiple is None or not lo <= multiple <= hi:
            errors.append(f"SalaryMultiple classes need salary_multiple between {lo:g}x and {hi:g}x.")
    elif basis == GroupBenefitBasis.LOAN_BALANCE.value:
        pass            # cover is each member's own outstanding balance — nothing to define here (min/max caps below)
    else:
        bands = spec.get("service_bands") or []
        if not bands:
            errors.append("ServiceBanded classes need at least one service band.")
        else:
            try:
                years = [int(b["min_years"]) for b in bands]
                amounts = [float(b["amount"]) for b in bands]
            except (KeyError, TypeError, ValueError):
                errors.append('Each service band needs numeric "min_years" and "amount".')
            else:
                if years[0] != 0 or years != sorted(set(years)):
                    errors.append("Service bands must start at min_years 0 and increase strictly.")
                if any(a <= 0 for a in amounts):
                    errors.append("Service band amounts must be positive.")

    lo_cap, hi_cap = spec.get("min_cover"), spec.get("max_cover")
    if lo_cap is not None and hi_cap is not None and lo_cap > hi_cap:
        errors.append("min_cover cannot exceed max_cover.")
    return errors


def validate_coverage(spec: Dict[str, Any]) -> List[str]:
    """Errors for a benefit added to a class on top of Life (Life 100% is automatic)."""
    errors: List[str] = []
    kind = spec.get("coverage_type")
    if kind == GroupCoverageType.LIFE.value:
        errors.append("Life cover is automatic (100% of the class's base) and can't be added or changed.")
    elif kind not in RIDER_TYPES:
        errors.append(f"coverage_type must be one of {sorted(RIDER_TYPES)} (got {kind!r}).")
    pct = spec.get("percent_of_base")
    if pct is None or not 0 < float(pct) <= 1000:
        errors.append("percent_of_base must be above 0 and at most 1000.")
    cap = spec.get("max_amount")
    if cap is not None and float(cap) <= 0:
        errors.append("max_amount must be positive when given.")
    return errors


# ── Member → class → cover ──────────────────────────────────────────────────

def resolve_benefit_class(row: Dict[str, Any], classes: Sequence[Any]) -> Tuple[Optional[Any], Optional[str]]:
    """(class, error). Explicit `benefit_class` name wins, then a class listing
    the row's `grade`, then the default class. With no classes at all the
    scheme is legacy (flat multiple) and (None, None) is a valid answer."""
    if not classes:
        return None, None

    named = (row.get("benefit_class") or "").strip()
    if named:
        for cls in classes:
            if cls.name.strip().lower() == named.lower():
                return cls, None
        return None, f"benefit class '{named}' does not exist on this master policy"

    grade = str(row.get("grade") or "").strip().lower()
    if grade:
        for cls in classes:
            if grade in {str(g).strip().lower() for g in (cls.grades or [])}:
                return cls, None

    for cls in classes:
        if cls.is_default:
            return cls, None
    return None, "no benefit class given, no class matches its grade, and the scheme has no default class"


def class_cover(cls: Any, monthly_salary: float, joining_date: Optional[date], as_of: date,
                loan_amount: Optional[float] = None) -> float:
    basis = cls.basis.value if hasattr(cls.basis, "value") else cls.basis
    if basis == GroupBenefitBasis.FLAT.value:
        amount = float(cls.flat_amount or 0)
    elif basis == GroupBenefitBasis.SALARY_MULTIPLE.value:
        amount = float(cls.salary_multiple or 0) * monthly_salary
    elif basis == GroupBenefitBasis.LOAN_BALANCE.value:
        if loan_amount in (None, ""):
            raise ValueError("LoanBalance cover needs the member's loan_amount")
        amount = float(loan_amount)
    else:
        if joining_date is None:
            raise ValueError("ServiceBanded cover needs a joining_date")
        years = completed_years_of_service(joining_date, as_of)
        eligible = [b for b in (cls.service_bands or []) if years >= int(b["min_years"])]
        amount = float(max(eligible, key=lambda b: int(b["min_years"]))["amount"]) if eligible else 0.0

    if cls.min_cover is not None:
        amount = max(amount, float(cls.min_cover))
    if cls.max_cover is not None:
        amount = min(amount, float(cls.max_cover))
    return amount


def member_cover(
    row: Dict[str, Any],
    classes: Sequence[Any],
    legacy_multiple: float,
    as_of: date,
) -> Tuple[Optional[Any], float]:
    """(class or None, sum assured) for a census row that already passed
    validation. No classes → legacy flat multiple of monthly salary."""
    salary = basic_monthly_salary(row)
    cls, error = resolve_benefit_class(row, classes)
    if error:
        raise ValueError(error)
    if cls is None:
        return None, salary * legacy_multiple
    return cls, class_cover(cls, salary, parse_date(row.get("joining_date")), as_of, row.get("loan_amount"))


def census_row_class_errors(row: Dict[str, Any], index: int, classes: Sequence[Any]) -> List[str]:
    """Per-row benefit-structure problems, phrased like validate_census's errors."""
    cls, error = resolve_benefit_class(row, classes)
    if error:
        return [f"Row {index + 1}: {error}."]
    if cls is not None:
        basis = cls.basis.value if hasattr(cls.basis, "value") else cls.basis
        if basis == GroupBenefitBasis.SERVICE_BANDED.value and not row.get("joining_date"):
            return [f"Row {index + 1}: class '{cls.name}' is service-banded, so joining_date is required."]
        if basis == GroupBenefitBasis.LOAN_BALANCE.value:
            try:
                ok = float(row.get("loan_amount")) > 0
            except (TypeError, ValueError):
                ok = False
            if not ok:
                return [f"Row {index + 1}: class '{cls.name}' covers the outstanding loan, so loan_amount (above zero) is required."]
    return []


def validate_scheme_census(
    existing_cnics: set,
    employees: List[Dict[str, Any]],
    classes: Sequence[Any],
    min_group_size: Optional[int] = None,
) -> CensusValidationResult:
    """validate_census plus this scheme's benefit-class checks per row."""
    result = validate_census(existing_cnics, employees, min_group_size)
    class_errors = [e for i, row in enumerate(employees) for e in census_row_class_errors(row, i, classes)]
    if class_errors:
        result.errors.extend(class_errors)
        result.is_valid = False
    return result
