"""Profile risk assessment: shares always total 100, factors land on the right side."""
from datetime import date

from services.profile_risk import assess_profile, FACTORS

TODAY = date(2026, 10, 15)

HEALTHY = {
    "dob": date(1990, 7, 16), "is_smoker": False, "declared_income": 3_420_000,
    "details": {
        "lifestyle": {"smoking_status": "NonSmoker", "alcohol_status": "None", "bmi": 22.0, "has_hazardous_hobby": False},
        "medical_history": {"has_pre_existing_conditions": False},
        "conditions": [], "family_history": [],
        "occupation_details": {"industry": "Banking & Finance", "occupation_hazard_level": "Low"},
        "income_record": {"annual_income": 3_420_000},
        "financial_records": {"credit_bureau": {"credit_score": 772, "default_history": False}},
        "habit_check": {"alcohol_consumption_frequency": "None", "moving_violations_past_3_years": 0},
    },
}


def _total(r):
    return round(sum(f["contribution_pct"] for f in r["safe_factors"] + r["risk_factors"]), 1)


def test_weights_total_100():
    assert sum(w for _, _, w in FACTORS) == 100


def test_healthy_profile_is_all_safe_and_totals_100():
    r = assess_profile(HEALTHY, cover=23_900_000, today=TODAY)
    assert _total(r) == 100.0
    assert [f["key"] for f in r["risk_factors"]] == ["age"]   # 36: a small age loading only
    assert r["risk_pct"] < 5 and r["band"] == "Low"
    assert r["completeness_pct"] == 100 and not r["missing"]


def test_adverse_factors_move_to_risk_side():
    p = {**HEALTHY, "is_smoker": True, "dob": date(1966, 1, 1),
         "details": {**HEALTHY["details"], "medical_history": {"has_heart_disease": True}}}
    r = assess_profile(p, cover=23_900_000, today=TODAY)
    risky = {f["key"] for f in r["risk_factors"]}
    assert {"smoking", "medical", "age"} <= risky
    assert _total(r) == 100.0
    assert r["risk_pct"] >= 35 and r["band"] in {"Elevated", "High"}


def test_partial_factor_splits_between_sides():
    p = {**HEALTHY, "details": {**HEALTHY["details"], "lifestyle": {**HEALTHY["details"]["lifestyle"], "bmi": 26.4}}}
    r = assess_profile(p, cover=23_900_000, today=TODAY)
    assert "bmi" in {f["key"] for f in r["safe_factors"]} and "bmi" in {f["key"] for f in r["risk_factors"]}
    assert _total(r) == 100.0


def test_missing_data_is_listed_and_rescaled():
    r = assess_profile({"dob": date(1990, 1, 1), "is_smoker": None, "details": {}}, today=TODAY)
    assert "Medical history" in r["missing"] and "Cover vs income" in r["missing"]
    assert r["completeness_pct"] == 12
    assert _total(r) == 100.0


def test_cover_far_above_income_is_a_risk():
    r = assess_profile(HEALTHY, cover=3_420_000 * 40, today=TODAY)
    assert any(f["key"] == "cover_income" and f["risk_level"] == 1.0 for f in r["risk_factors"])


def test_empty_profile():
    r = assess_profile({"is_smoker": None, "details": {}}, today=TODAY)
    assert r["band"] == "Unknown"


def test_four_sections_add_up_to_the_whole():
    r = assess_profile(HEALTHY, cover=23_900_000, today=TODAY)
    assert [c["key"] for c in r["categories"]] == ["medical", "occupational", "financial", "avocational"]
    assert round(sum(c["share_pct"] for c in r["categories"]), 1) == 100.0
    assert round(sum(c["risk_pct"] for c in r["categories"]), 1) == r["risk_pct"]
    medical = r["categories"][0]
    assert {f["key"] for f in medical["safe_factors"]} == {"medical", "age", "bmi", "family_history"}


def test_smoker_shows_up_as_avocational_risk():
    r = assess_profile({**HEALTHY, "is_smoker": True}, cover=23_900_000, today=TODAY)
    avo = next(c for c in r["categories"] if c["key"] == "avocational")
    assert any(f["key"] == "smoking" for f in avo["risk_factors"])
    assert avo["risk_within_pct"] > 0


def test_each_risk_names_the_rule_and_reason_that_decided_it():
    r = assess_profile({**HEALTHY, "is_smoker": True}, cover=23_900_000, today=TODAY)
    smoking = next(f for f in r["risk_factors"] if f["key"] == "smoking")
    assert [x["code"] for x in smoking["rules"]] == ["RSK-SMK-01"]
    assert "mortality" in smoking["rules"][0]["reason"]
    assert "Cotinine" in r["underwriting"]["medical_tests"]


def test_rule_engine_matches_drive_the_score():
    # A rule edited in the rule engine (here: age 36 counted as fully adverse) changes the result.
    custom = [{"rule_code": "RSK-AGE-X", "name": "Custom age rule", "reason": "Tenant policy", "risk_factor": "age",
               "risk_level": 1.0, "impact_type": "REFER_TO_UNDERWRITER"}]
    r = assess_profile(HEALTHY, cover=23_900_000, today=TODAY, matched_rules=custom)
    age = next(f for f in r["risk_factors"] if f["key"] == "age")
    assert age["risk_level"] == 1.0 and age["rules"][0]["code"] == "RSK-AGE-X"
    assert r["underwriting"]["referral"] is True
    assert _total(r) == 100.0


def test_seed_rules_cover_every_factor():
    from services.profile_risk import RISK_RULE_SET
    assert {r["outcome_payload"]["risk_factor"] for r in RISK_RULE_SET["rules"]} == {k for k, _, _ in FACTORS}
    assert all(r["outcome_payload"]["reason"] for r in RISK_RULE_SET["rules"])
