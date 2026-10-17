"""Regression checks for researched early-exit reference data (no database)."""

from copy import deepcopy
import json

from seeds.insurance_plan_surrender_seed import DATA_PATH, surrender_terms_for, validate_catalog
from seeds.insurance_plans_seed import INSURANCE_PLAN_SEED_DATA


def test_catalog_covers_exactly_the_seeded_adamjee_retail_products():
    data = json.loads(DATA_PATH.read_text())
    validate_catalog(data)
    retail_codes = {p["code"] for p in INSURANCE_PLAN_SEED_DATA if p["category"] == "Individual"}
    assert set(data["plans"]) == retail_codes


def test_distinct_plan_surrender_schedules_are_not_premium_allocation_charges():
    assert [b["charge_pct"] for b in surrender_terms_for("APNA_SAVINGS")["charge_schedule"]] == [100, 100, 0]
    assert [b["charge_pct"] for b in surrender_terms_for("LIFE_SIGNATURE_PLUS")["charge_schedule"]] == [10, 5, 0]
    assert [b["charge_pct"] for b in surrender_terms_for("TAHAFUZZ_PLAN")["charge_schedule"]] == [50, 25, 0]
    assert surrender_terms_for("NIBAH")["charge_schedule"][0]["charge_pct"] == 0
    assert surrender_terms_for("NIBAH")["processing_fee_pkr"] == 500


def test_monthly_versions_and_internal_source_conflicts_remain_explicit():
    shandar = surrender_terms_for("SHANDAR_SARMAYA")
    assert shandar["charge_schedule"][0]["through"] == 12
    assert shandar["alternative_published_schedules"][0]["charge_schedule"][0]["through"] == 11
    assert shandar["status"] == "conflicting_sources"
    assert surrender_terms_for("ZAMANAT_SAVINGS_PLAN")["status"] == "conflicting_sources"


def test_unknown_values_are_not_treated_as_free_surrender_and_generic_plans_are_not_enriched():
    assert surrender_terms_for("NIGRAAN")["charge_schedule"] is None
    assert surrender_terms_for("NIGRAAN")["has_surrender_value"] is None
    assert surrender_terms_for("SALARY_PROTECTION_PLAN")["has_surrender_value"] is False
    assert surrender_terms_for("GROUP_LIFE") is None
    invalid = json.loads(DATA_PATH.read_text())
    invalid["plans"]["NIGRAAN"]["charge_schedule"] = [{"from": 1, "through": None, "charge_pct": 0}]
    try:
        validate_catalog(invalid)
    except ValueError:
        pass
    else:
        raise AssertionError("An unknown schedule must not silently become zero")


def test_seeded_terms_are_independent_and_cannot_enable_financial_calculations():
    one = surrender_terms_for("NIBAH")
    one["charge_schedule"][0]["charge_pct"] = 99
    assert surrender_terms_for("NIBAH")["charge_schedule"][0]["charge_pct"] == 0
    data = deepcopy(json.loads(DATA_PATH.read_text()))
    data["plans"]["NIBAH"]["operational_calculation_enabled"] = True
    try:
        validate_catalog(data)
    except ValueError:
        pass
    else:
        raise AssertionError("Catalog references must not enable financial calculations")


if __name__ == "__main__":
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS {name}")
