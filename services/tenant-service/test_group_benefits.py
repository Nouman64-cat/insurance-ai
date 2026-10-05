"""Unit tests for group_benefits.py and validate_census — pure, no DB.

Run with: docker compose exec tenant-service python test_group_benefits.py
"""

from datetime import date, timedelta
from types import SimpleNamespace

from group_benefits import (
    basic_monthly_salary,
    class_cover,
    completed_years_of_service,
    member_cover,
    resolve_benefit_class,
    validate_benefit_class,
    validate_scheme_census,
)
from group_underwriting import validate_census

AS_OF = date(2026, 1, 1)


def _cls(name, basis, **kw):
    base = dict(flat_amount=None, salary_multiple=None, service_bands=None, grades=None,
                min_cover=None, max_cover=None, is_default=False, id=name)
    base.update(kw)
    return SimpleNamespace(name=name, basis=basis, **base)


MGMT = _cls("Management", "Flat", flat_amount=10_000_000, grades=["M1", "M2"])
STAFF = _cls("Staff", "SalaryMultiple", salary_multiple=24, max_cover=5_000_000, is_default=True)
TENURE = _cls("Tenure", "ServiceBanded", service_bands=[
    {"min_years": 0, "amount": 1_000_000}, {"min_years": 5, "amount": 2_000_000}, {"min_years": 10, "amount": 4_000_000},
])
CLASSES = [MGMT, STAFF, TENURE]


def _row(i=0, **kw):
    row = {"cnic": f"35201-{1000000 + i}-1", "name": f"Emp {i}", "dob": "1985-01-01", "gender": "Male",
           "occupation": "Clerk", "declared_income": 1_200_000}
    row.update(kw)
    return row


def test_salary_defaults_to_annual_income_over_12():
    assert basic_monthly_salary({"declared_income": 1_200_000}) == 100_000
    assert basic_monthly_salary({"declared_income": 1_200_000, "basic_monthly_salary": 60_000}) == 60_000


def test_years_of_service():
    assert completed_years_of_service(date(2021, 1, 2), AS_OF) == 4
    assert completed_years_of_service(date(2021, 1, 1), AS_OF) == 5
    assert completed_years_of_service(date(2027, 1, 1), AS_OF) == 0


def test_class_resolution_order():
    assert resolve_benefit_class({"benefit_class": "tenure", "grade": "M1"}, CLASSES)[0] is TENURE  # explicit name wins
    assert resolve_benefit_class({"grade": "m2"}, CLASSES)[0] is MGMT                            # grade match
    assert resolve_benefit_class({"grade": "Z9"}, CLASSES)[0] is STAFF                           # default
    cls, err = resolve_benefit_class({"benefit_class": "Nope"}, CLASSES)
    assert cls is None and "does not exist" in err
    assert resolve_benefit_class({}, []) == (None, None)                                         # legacy scheme
    cls, err = resolve_benefit_class({"grade": "Z9"}, [MGMT])
    assert cls is None and "no default class" in err


def test_cover_by_basis_and_caps():
    assert class_cover(MGMT, 100_000, None, AS_OF) == 10_000_000
    assert class_cover(STAFF, 100_000, None, AS_OF) == 2_400_000
    assert class_cover(STAFF, 500_000, None, AS_OF) == 5_000_000            # max_cover cap
    floored = _cls("Floor", "SalaryMultiple", salary_multiple=12, min_cover=1_500_000)
    assert class_cover(floored, 50_000, None, AS_OF) == 1_500_000           # min_cover floor
    assert class_cover(TENURE, 0, date(2023, 6, 1), AS_OF) == 1_000_000
    assert class_cover(TENURE, 0, date(2020, 6, 1), AS_OF) == 2_000_000
    assert class_cover(TENURE, 0, date(2010, 6, 1), AS_OF) == 4_000_000
    try:
        class_cover(TENURE, 0, None, AS_OF)
    except ValueError:
        pass
    else:
        raise AssertionError("service-banded cover without joining_date must fail")


def test_member_cover_legacy_and_classed():
    assert member_cover(_row(), [], 24, AS_OF) == (None, 2_400_000)
    cls, amount = member_cover(_row(grade="M1"), CLASSES, 24, AS_OF)
    assert cls is MGMT and amount == 10_000_000


def test_validate_benefit_class():
    assert validate_benefit_class({"basis": "Flat", "flat_amount": 1}) == []
    assert validate_benefit_class({"basis": "Bogus"})
    assert validate_benefit_class({"basis": "Flat"})
    assert validate_benefit_class({"basis": "SalaryMultiple", "salary_multiple": 48})
    assert validate_benefit_class({"basis": "SalaryMultiple", "salary_multiple": 24}) == []
    assert validate_benefit_class({"basis": "ServiceBanded", "service_bands": []})
    assert validate_benefit_class({"basis": "ServiceBanded", "service_bands": [{"min_years": 2, "amount": 1}]})
    assert validate_benefit_class({"basis": "ServiceBanded", "service_bands": [
        {"min_years": 0, "amount": 1}, {"min_years": 0, "amount": 2}]})
    assert validate_benefit_class({"basis": "Flat", "flat_amount": 1, "min_cover": 5, "max_cover": 1})


def test_census_min_group_size_and_formats():
    rows = [_row(i) for i in range(3)]
    assert validate_census(set(), rows).is_valid                                  # no minimum given
    small = validate_census(set(), rows, min_group_size=10)
    assert not small.is_valid and any("at least 10" in e for e in small.errors)
    bad = validate_census(set(), [_row(0, dob="01/01/1985"), _row(1, joining_date="2999-01-01"),
                                  _row(2, declared_income="lots")])
    assert not bad.is_valid and len(bad.errors) == 3


def test_census_duplicates_against_enrolled():
    rows = [_row(0), _row(1)]
    res = validate_census({"35201-1000000-1"}, rows)
    assert not res.is_valid and res.duplicate_cnics == ["35201-1000000-1"]


def test_scheme_census_class_errors():
    rows = [_row(0, benefit_class="Nope"), _row(1, benefit_class="Tenure"), _row(2, grade="M1")]
    res = validate_scheme_census(set(), rows, CLASSES)
    assert not res.is_valid
    assert any("Row 1" in e and "does not exist" in e for e in res.errors)
    assert any("Row 2" in e and "joining_date is required" in e for e in res.errors)
    assert not any("Row 3" in e for e in res.errors)
    joined = str(date.today() - timedelta(days=400))
    assert validate_scheme_census(set(), [_row(0, benefit_class="Tenure", joining_date=joined)], CLASSES).is_valid


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS {name}")
