"""Profile risk assessment — explains a customer's risk before any proposal exists.

Two halves, kept apart on purpose:

1. **Facts** (`profile_facts`): this module only reads the profile and flattens it
   into plain facts — age, BMI, smoking status, cover-to-income multiple, … — plus a
   human-readable finding per factor. It decides nothing.
2. **Decisions** (`RISK_RULE_SET`): whether a fact is a risk, how much, and *why* is
   decided by rules in the rule engine (rule set RS-RISK-001, editable and versioned
   in the rule-engine admin). Each rule carries `risk_factor`, `risk_level` (0–1) and
   a `reason`, plus any underwriting consequence (tests, loading, referral).

Scoring: each factor has a fixed weight (weights total 100). Its risk level is the
sum of the matched rules' levels for that factor, capped at 1. The weight is split
between the safe and risk sides in that proportion, so all safe and risk shares
together make exactly 100. Factors the profile doesn't record are left out and
listed as missing; the remaining weights are rescaled.

This is a screening view for leads, not the underwriting decision — the risk
engine still assesses the case once a proposal exists.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Optional

# (key, label, weight). Weights total 100.
FACTORS: list[tuple[str, str, int]] = [
    ("medical", "Medical history", 18),
    ("age", "Age", 12),
    ("smoking", "Smoking", 12),
    ("bmi", "Body mass index", 10),
    ("cover_income", "Cover vs income", 10),
    ("occupation", "Occupation hazard", 8),
    ("credit", "Credit & financial health", 8),
    ("alcohol", "Alcohol & substances", 6),
    ("family_history", "Family medical history", 6),
    ("lifestyle", "Hazardous activities", 6),
    ("conduct", "Driving & conduct record", 4),
]
# The four underwriting sections the factors are reported under, in display order.
CATEGORIES: list[tuple[str, str, tuple[str, ...]]] = [
    ("medical", "Medical risk", ("medical", "age", "bmi", "family_history")),
    ("occupational", "Occupational risk", ("occupation",)),
    ("financial", "Financial risk", ("cover_income", "credit")),
    ("avocational", "Avocational risk", ("smoking", "alcohol", "lifestyle", "conduct")),
]
CATEGORY_OF = {f: key for key, _, factors in CATEGORIES for f in factors}
assert set(CATEGORY_OF) == {k for k, _, _ in FACTORS}
assert sum(w for _, _, w in FACTORS) == 100

RISK_RULE_SET_CODE = "RS-RISK-001"


# ─────────────────────────────────────────────────────────────────────────────
# Rules — seeded into the rule engine (routers/rules.ensure_profile_risk_rule_set)
# ─────────────────────────────────────────────────────────────────────────────

def _rule(code: str, name: str, factor: str, level: float, reason: str, conditions: list[dict],
          outcome: str = "REFER_TO_UNDERWRITER", operator: str = "ALL", **payload) -> dict:
    return {"code": code, "name": name, "priority": 10, "operator": operator, "conditions": conditions,
            "action_outcome": outcome,
            "outcome_payload": {"risk_factor": factor, "risk_level": level, "reason": reason, **payload}}


def _between(field: str, low: float, high: float) -> list[dict]:
    return [{"field": field, "operator": "between", "value": [low, high]}]


def _is(field: str, value: Any = True) -> list[dict]:
    return [{"field": field, "operator": "eq", "value": value}]


_RULES: list[dict] = [
    # Medical history
    _rule("RSK-MED-01", "Declared heart disease", "medical", 1.0,
          "Heart disease is the leading cause of early death claims; cardiac reports are required before cover.",
          _is("has_heart_disease"), medical_profile_codes=["ECG", "TMT"]),
    _rule("RSK-MED-02", "Diabetes", "medical", 0.5,
          "Diabetes raises cardiovascular and kidney risk; blood-sugar control has to be evidenced.",
          _is("is_diabetic"), "REQUIRE_MEDICAL", medical_profile_codes=["FBS", "HbA1c"]),
    _rule("RSK-MED-03", "Hypertension", "medical", 0.5,
          "High blood pressure increases stroke and heart-attack risk; readings and treatment need review.",
          _is("has_hypertension"), "REQUIRE_MEDICAL", medical_profile_codes=["BP", "ECG"]),
    _rule("RSK-MED-04", "Pre-existing condition declared", "medical", 0.4,
          "A declared pre-existing condition may be excluded or loaded once its details are reviewed.",
          _is("has_pre_existing")),
    _rule("RSK-MED-05", "Recorded medical conditions", "medical", 0.3,
          "Each recorded condition adds to the medical risk and needs supporting records.",
          [{"field": "condition_count", "operator": "gte", "value": 1}]),
    _rule("RSK-MED-06", "Surgical history", "medical", 0.2,
          "Past surgery can point to an underlying condition; the operation notes should be checked.",
          _is("has_surgical_history")),
    # Age
    _rule("RSK-AGE-01", "Age 36–45", "age", 0.2,
          "Mortality starts rising steadily after 35.", _between("age", 36, 45), "AUTO_APPROVE"),
    _rule("RSK-AGE-02", "Age 46–55", "age", 0.5,
          "Mortality roughly doubles every 8–10 years of age; non-medical limits are lower in this band.",
          _between("age", 46, 55), "REQUIRE_MEDICAL", medical_profile_codes=["MER"]),
    _rule("RSK-AGE-03", "Age 56–65", "age", 0.8,
          "Older entry age sharply increases mortality and the chance of undeclared conditions.",
          _between("age", 56, 65), "REQUIRE_MEDICAL", medical_profile_codes=["MER", "ECG"]),
    _rule("RSK-AGE-04", "Age over 65", "age", 1.0,
          "Above the normal maximum entry age for individual life cover.",
          [{"field": "age", "operator": "gt", "value": 65}]),
    # BMI
    _rule("RSK-BMI-01", "Underweight (BMI 17–18.4)", "bmi", 0.3,
          "Low body weight can indicate an underlying illness.", _between("bmi", 17, 18.49), "AUTO_APPROVE"),
    _rule("RSK-BMI-02", "Overweight (BMI 25–29.9)", "bmi", 0.3,
          "Excess weight raises the risk of diabetes, hypertension and heart disease.",
          _between("bmi", 25, 29.99), "AUTO_APPROVE"),
    _rule("RSK-BMI-03", "Obese (BMI 30–34.9)", "bmi", 0.6,
          "Obesity materially increases mortality; a premium loading normally applies.",
          _between("bmi", 30, 34.99), "APPLY_LOADING", extra_mortality_pct=25),
    _rule("RSK-BMI-04", "BMI severely outside the healthy range", "bmi", 1.0,
          "A BMI of 35+ or below 17 carries a high medical risk and needs a full medical.",
          [{"field": "bmi", "operator": "gte", "value": 35}, {"field": "bmi", "operator": "lt", "value": 17}],
          "REQUIRE_MEDICAL", operator="ANY", medical_profile_codes=["MER", "FBS", "Lipid profile"]),
    # Family history
    _rule("RSK-FAM-01", "One relative with a declared condition", "family_history", 0.4,
          "A parent or sibling with a hereditary condition raises the applicant's own risk.",
          _is("family_history_count", 1), "AUTO_APPROVE"),
    _rule("RSK-FAM-02", "Two or more relatives with conditions", "family_history", 0.7,
          "Several affected relatives point to a hereditary pattern worth investigating.",
          [{"field": "family_history_count", "operator": "gte", "value": 2}]),
    # Occupation
    _rule("RSK-OCC-01", "Medium-hazard occupation", "occupation", 0.5,
          "The job carries a higher accident risk than office work; an occupational loading may apply.",
          [{"field": "occupation_hazard", "operator": "in", "value": ["medium", "moderate"]}],
          "APPLY_LOADING", extra_mortality_pct=25),
    _rule("RSK-OCC-02", "High-hazard occupation", "occupation", 1.0,
          "High-hazard work (e.g. heights, mining, explosives) sharply increases accidental death risk.",
          [{"field": "occupation_hazard", "operator": "in", "value": ["high", "veryhigh"]}]),
    # Cover vs income (financial justification)
    _rule("RSK-FIN-01", "Cover 10–15× income", "cover_income", 0.2,
          "Cover is above the usual 10× income guideline; income should be confirmed.",
          [{"field": "cover_income_multiple", "operator": "gt", "value": 10},
           {"field": "cover_income_multiple", "operator": "lte", "value": 15}], "AUTO_APPROVE"),
    _rule("RSK-FIN-02", "Cover 15–20× income", "cover_income", 0.5,
          "Cover is well above income; proof of income is needed to rule out over-insurance.",
          [{"field": "cover_income_multiple", "operator": "gt", "value": 15},
           {"field": "cover_income_multiple", "operator": "lte", "value": 20}], "FINANCIAL_JUSTIFICATION"),
    _rule("RSK-FIN-03", "Cover 20–30× income", "cover_income", 0.8,
          "Cover far exceeds the human-life value supported by income — an over-insurance and anti-selection signal.",
          [{"field": "cover_income_multiple", "operator": "gt", "value": 20},
           {"field": "cover_income_multiple", "operator": "lte", "value": 30}], "FINANCIAL_JUSTIFICATION"),
    _rule("RSK-FIN-04", "Cover over 30× income", "cover_income", 1.0,
          "Cover is more than 30× income; it cannot be justified without exceptional evidence.",
          [{"field": "cover_income_multiple", "operator": "gt", "value": 30}]),
    # Credit
    _rule("RSK-CRD-01", "Fair credit score (650–749)", "credit", 0.3,
          "A middling credit score suggests some financial strain, which raises lapse risk.",
          _between("credit_score", 650, 749.99), "AUTO_APPROVE"),
    _rule("RSK-CRD-02", "Weak credit score (550–649)", "credit", 0.6,
          "A weak credit score points to financial stress and a higher chance of premiums lapsing.",
          _between("credit_score", 550, 649.99), "FINANCIAL_JUSTIFICATION"),
    _rule("RSK-CRD-03", "Poor credit score (below 550)", "credit", 1.0,
          "A poor credit score is a strong lapse and financial-fraud indicator.",
          [{"field": "credit_score", "operator": "lt", "value": 550}]),
    _rule("RSK-CRD-04", "Loan default on record", "credit", 1.0,
          "A past default is a strong indicator of financial stress and possible misrepresentation.",
          _is("credit_default")),
    _rule("RSK-CRD-05", "Payment delinquencies", "credit", 0.3,
          "Missed repayments suggest premiums may also be missed.",
          [{"field": "delinquency_count", "operator": "gte", "value": 1}], "AUTO_APPROVE"),
    # Smoking
    _rule("RSK-SMK-01", "Current smoker", "smoking", 1.0,
          "Smoking roughly doubles mortality and drives cancer, heart and lung disease; smoker rates apply.",
          _is("smoking_status", "current"), "APPLY_LOADING", medical_profile_codes=["Cotinine"]),
    _rule("RSK-SMK-02", "Former smoker", "smoking", 0.4,
          "Risk falls after quitting but stays above a lifelong non-smoker's for several years.",
          _is("smoking_status", "former"), "AUTO_APPROVE"),
    # Alcohol & substances
    _rule("RSK-ALC-01", "Occasional alcohol", "alcohol", 0.2,
          "Occasional drinking adds a small accident and liver risk.",
          _is("alcohol_level", "occasional"), "AUTO_APPROVE"),
    _rule("RSK-ALC-02", "Regular alcohol", "alcohol", 0.5,
          "Regular drinking raises liver, accident and cardiovascular risk.",
          _is("alcohol_level", "moderate"), "REQUIRE_MEDICAL", medical_profile_codes=["LFT"]),
    _rule("RSK-ALC-03", "Heavy alcohol use", "alcohol", 1.0,
          "Heavy drinking is a major mortality driver and is usually declined or heavily loaded.",
          _is("alcohol_level", "heavy"), medical_profile_codes=["LFT", "GGT"]),
    _rule("RSK-ALC-04", "Recreational drug use history", "alcohol", 1.0,
          "Drug use carries overdose, accident and dependency risk.",
          _is("drug_history")),
    # Hazardous activities
    _rule("RSK-AVO-01", "One hazardous activity", "lifestyle", 0.5,
          "Extreme sports, private flying or high-risk travel add accidental death risk; an exclusion may apply.",
          _is("hazardous_activity_count", 1), "EXCLUSION_CLAUSE"),
    _rule("RSK-AVO-02", "Several hazardous activities", "lifestyle", 1.0,
          "Multiple hazardous pursuits compound the accidental death risk.",
          [{"field": "hazardous_activity_count", "operator": "gte", "value": 2}]),
    # Driving & conduct
    _rule("RSK-CND-01", "1–2 driving violations in 3 years", "conduct", 0.3,
          "Recent traffic violations correlate with higher road-accident risk.",
          _between("driving_violations", 1, 2), "AUTO_APPROVE"),
    _rule("RSK-CND-02", "3+ driving violations in 3 years", "conduct", 0.5,
          "A pattern of violations signals risky driving behaviour.",
          [{"field": "driving_violations", "operator": "gte", "value": 3}]),
    _rule("RSK-CND-03", "Drink-driving history", "conduct", 1.0,
          "Driving under the influence combines alcohol and accident risk.",
          _is("dui_history")),
    _rule("RSK-CND-04", "Criminal record", "conduct", 1.0,
          "A criminal record raises moral-hazard and violent-death risk.",
          _is("criminal_record")),
]

RISK_RULE_SET: dict = {
    "code": RISK_RULE_SET_CODE,
    "name": "Profile Risk Screening",
    "description": ("Decides which profile facts are risks, how much each adds, and why. Drives the Risk "
                    "Assessment shown on a lead before a proposal exists."),
    "category_code": "UNDERWRITING_RISK", "category_name": "Underwriting Risk",
    "sub_code": "PROFILE_RISK", "sub_name": "Profile Risk Screening",
    "scope_type": "GLOBAL", "channel_code": None,
    "rules": _RULES,
}


# ─────────────────────────────────────────────────────────────────────────────
# Facts — the profile flattened for the rules, plus a finding per factor
# ─────────────────────────────────────────────────────────────────────────────

def _age(dob: Any, today: date) -> Optional[int]:
    if not dob:
        return None
    if isinstance(dob, str):
        try:
            dob = date.fromisoformat(dob[:10])
        except ValueError:
            return None
    return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def _text(v: Any) -> str:
    return str(v or "").strip().lower().replace("-", "").replace(" ", "")


_ALCOHOL = {"none": "none", "never": "none", "no": "none", "occasional": "occasional", "social": "occasional",
            "rarely": "occasional", "moderate": "moderate", "regular": "moderate", "weekly": "moderate",
            "heavy": "heavy", "daily": "heavy"}


def profile_facts(customer: dict, cover: Optional[float] = None, today: Optional[date] = None
                  ) -> tuple[dict, dict[str, str]]:
    """(facts for the rule engine, {factor key: finding}). A factor absent from the
    findings wasn't recorded on the profile and is left out of the score."""
    today = today or date.today()
    d = customer.get("details") or {}
    life, habit = d.get("lifestyle") or {}, d.get("habit_check")
    facts: dict[str, Any] = {}
    findings: dict[str, str] = {}

    age = _age(customer.get("dob"), today)
    if age is not None:
        facts["age"] = age
        findings["age"] = f"{age} years"

    bmi = _num(life.get("bmi"))
    if bmi is None and _num(life.get("height_cm")) and _num(life.get("weight_kg")):
        bmi = float(life["weight_kg"]) / (float(life["height_cm"]) / 100) ** 2
    if bmi is not None:
        facts["bmi"] = round(bmi, 1)
        band = ("healthy" if 18.5 <= bmi < 25 else "overweight" if 25 <= bmi < 30 else "underweight" if 17 <= bmi < 18.5
                else "obese" if 30 <= bmi < 35 else "severely outside the healthy range")
        findings["bmi"] = f"BMI {bmi:.1f} ({band})"

    status = _text(life.get("smoking_status") or (habit or {}).get("smoking_status"))
    if customer.get("is_smoker") or status in {"smoker", "current", "currentsmoker", "regular"}:
        facts["smoking_status"], findings["smoking"] = "current", "Current smoker"
    elif status in {"exsmoker", "former", "formersmoker", "quit"} or life.get("quit_smoking_date"):
        facts["smoking_status"], findings["smoking"] = "former", "Former smoker"
    elif status in {"nonsmoker", "never", "no", "none"} or customer.get("is_smoker") is False:
        facts["smoking_status"], findings["smoking"] = "never", "Non-smoker"

    raw_alcohol = (habit or {}).get("alcohol_consumption_frequency") or life.get("alcohol_status")
    drugs = (habit or {}).get("recreational_drug_use_history")
    if raw_alcohol or drugs is not None:
        facts["alcohol_level"] = _ALCOHOL.get(_text(raw_alcohol), "occasional" if raw_alcohol else "none")
        facts["drug_history"] = bool(drugs)
        notes = [f"Alcohol: {raw_alcohol}"] if raw_alcohol else []
        if drugs:
            notes.append("recreational drug use history")
        findings["alcohol"] = ", ".join(notes) or "No alcohol or substance use"

    med, conditions = d.get("medical_history"), d.get("conditions") or []
    if med is not None or conditions:
        med = med or {}
        facts.update(has_heart_disease=bool(med.get("has_heart_disease")), is_diabetic=bool(med.get("is_diabetic")),
                     has_hypertension=bool(med.get("has_hypertension")),
                     has_pre_existing=bool(med.get("has_pre_existing_conditions")),
                     has_surgical_history=bool(med.get("surgical_history")), condition_count=len(conditions))
        found = [label for key, label in (("has_heart_disease", "heart disease"), ("is_diabetic", "diabetes"),
                                          ("has_hypertension", "hypertension"),
                                          ("has_pre_existing", "pre-existing condition declared"),
                                          ("has_surgical_history", "surgical history")) if facts[key]]
        if conditions:
            found.append(f"{len(conditions)} recorded condition{'s' if len(conditions) != 1 else ''}")
        findings["medical"] = ", ".join(found).capitalize() if found else "No conditions declared"

    if "family_history" in d:
        n = len(d.get("family_history") or [])
        facts["family_history_count"] = n
        findings["family_history"] = "None declared" if n == 0 else f"{n} relative condition{'s' if n != 1 else ''} declared"

    occ = d.get("occupation_details") or {}
    level = _text(occ.get("occupation_hazard_level") or life.get("occupation_hazard_level"))
    if level:
        facts["occupation_hazard"] = level
        facts["occupation"] = occ.get("job_title") or occ.get("industry") or customer.get("occupation") or ""
        job = facts["occupation"] or "Occupation"
        findings["occupation"] = f"{job} — {occ.get('occupation_hazard_level') or level} hazard"

    if habit is not None or "has_hazardous_hobby" in life:
        h = habit or {}
        found = [label for key, label in (("participates_in_extreme_sports", "extreme sports"),
                                          ("private_aviation", "private aviation"),
                                          ("frequent_high_risk_travel", "high-risk travel")) if h.get(key)]
        if life.get("has_hazardous_hobby"):
            found.append("hazardous hobby")
        facts["hazardous_activity_count"] = len(found)
        findings["lifestyle"] = ", ".join(found).capitalize() if found else "No hazardous activities"

    if habit is not None:
        violations = int(habit.get("moving_violations_past_3_years") or 0)
        facts.update(driving_violations=violations, dui_history=bool(habit.get("dui_dwi_history")),
                     criminal_record=bool(habit.get("criminal_record")))
        found = [f"{violations} driving violation{'s' if violations != 1 else ''} in 3 years"] if violations else []
        if facts["dui_history"]:
            found.append("DUI history")
        if facts["criminal_record"]:
            found.append("criminal record")
        findings["conduct"] = ", ".join(found).capitalize() if found else "Clean record"

    income_rec = d.get("income_record") or {}
    income = (_num(income_rec.get("annual_income")) or _num(income_rec.get("declared_income"))
              or _num(customer.get("declared_income")))
    if cover and income:
        facts["cover_income_multiple"] = round(cover / income, 2)
        findings["cover_income"] = f"Cover is {cover / income:.1f}× annual income"

    bureau = (d.get("financial_records") or {}).get("credit_bureau") or {}
    score = _num(bureau.get("credit_score"))
    if score is not None or bureau.get("default_history"):
        delinquencies = int(bureau.get("delinquency_count") or 0)
        facts.update(credit_score=score, credit_default=bool(bureau.get("default_history")),
                     delinquency_count=delinquencies)
        notes = [f"Credit score {int(score)}"] if score else []
        if delinquencies:
            notes.append(f"{delinquencies} delinquenc{'ies' if delinquencies != 1 else 'y'}")
        if facts["credit_default"]:
            notes.append("default history")
        findings["credit"] = ", ".join(notes)
    return facts, findings


def evaluate_seed_rules(facts: dict) -> list[dict]:
    """Evaluate the built-in RS-RISK-001 rules with the rule engine's own criteria
    logic. Used when the rule set isn't deployed in the database (and by tests)."""
    from routers.rules import _convert_seed_rule
    from rule_evaluator import _evaluate_rule
    from shared.models.core import RuleCriteria

    matched = []
    for seed in _RULES:
        rule = _convert_seed_rule(seed)
        criteria = [RuleCriteria(rule_id=None, **c) for c in rule["criteria"]]
        if _evaluate_rule(criteria, facts):
            data = rule["impact_data"]
            matched.append({"rule_code": rule["rule_code"], "name": rule["name"], "impact_type": rule["impact_type"],
                            "reason": data.get("reason"), "risk_factor": data.get("risk_factor"),
                            "risk_level": data.get("risk_level"),
                            "medical_profile_codes": data.get("medical_profile_codes") or [],
                            "extra_mortality_pct": data.get("extra_mortality_pct") or 0})
    return matched


# ─────────────────────────────────────────────────────────────────────────────
# Scoring
# ─────────────────────────────────────────────────────────────────────────────

def _round_to_100(values: list[float]) -> list[float]:
    """Round to one decimal so the parts still total exactly 100.0 (largest remainder)."""
    tenths = [v * 10 for v in values]
    floors = [int(t) for t in tenths]
    short = round(sum(tenths)) - sum(floors)
    order = sorted(range(len(values)), key=lambda i: tenths[i] - floors[i], reverse=True)
    for i in order[:max(short, 0)]:
        floors[i] += 1
    return [f / 10 for f in floors]


def band_for(risk_pct: float) -> str:
    if risk_pct < 20:
        return "Low"
    if risk_pct < 35:
        return "Moderate"
    if risk_pct < 50:
        return "Elevated"
    return "High"


def assess_profile(customer: dict, cover: Optional[float] = None, today: Optional[date] = None,
                   matched_rules: Optional[list[dict]] = None, rule_set: Optional[dict] = None) -> dict:
    """`customer` holds the Customer columns plus `details`; `cover` is the sum assured
    being considered. `matched_rules` are the rule engine's matches for this profile's
    facts; when omitted the built-in rule baseline is evaluated."""
    facts, findings = profile_facts(customer, cover, today)
    if matched_rules is None:
        matched_rules = evaluate_seed_rules(facts)
        rule_set = rule_set or {"code": RISK_RULE_SET_CODE, "version": "built-in", "source": "baseline"}

    by_factor: dict[str, list[dict]] = {}
    for m in matched_rules:
        if m.get("risk_factor") in findings:
            by_factor.setdefault(m["risk_factor"], []).append(m)

    scored, missing = [], []
    for key, label, weight in FACTORS:
        if key not in findings:
            missing.append(label)
            continue
        rules = by_factor.get(key, [])
        risk = min(1.0, sum(float(r.get("risk_level") or 0) for r in rules))
        scored.append((key, label, weight, risk, findings[key], rules))

    answered = sum(s[2] for s in scored)
    base = {"facts": facts, "rule_set": rule_set, "matched_rules": matched_rules}
    if not answered:
        return {**base, "safe_pct": 0.0, "risk_pct": 0.0, "band": "Unknown", "completeness_pct": 0,
                "categories": [], "safe_factors": [], "risk_factors": [], "missing": missing,
                "underwriting": {"medical_tests": [], "extra_mortality_pct": 0, "referral": False},
                "summary": "Not enough profile information to assess risk yet."}

    # Each factor's share of 100, split into its safe and risk parts.
    parts: list[tuple[str, int, float]] = []
    for i, (_, _, weight, risk, _, _) in enumerate(scored):
        share = weight * 100 / answered
        if risk < 1:
            parts.append(("safe", i, share * (1 - risk)))
        if risk > 0:
            parts.append(("risk", i, share * risk))
    rounded = _round_to_100([p[2] for p in parts])

    safe, adverse = [], []
    for (side, i, _), pct in zip(parts, rounded):
        key, label, weight, risk, detail, rules = scored[i]
        row = {"key": key, "label": label, "detail": detail, "contribution_pct": pct, "weight": weight,
               "risk_level": round(risk, 2), "category": CATEGORY_OF[key],
               "rules": [{"code": r["rule_code"], "name": r["name"], "reason": r.get("reason"),
                          "impact_type": r.get("impact_type"), "risk_level": r.get("risk_level")} for r in rules]}
        (safe if side == "safe" else adverse).append(row)
    safe.sort(key=lambda r: r["contribution_pct"], reverse=True)
    adverse.sort(key=lambda r: r["contribution_pct"], reverse=True)

    categories = []
    for cat_key, cat_label, _keys in CATEGORIES:
        cat_safe = [r for r in safe if r["category"] == cat_key]
        cat_risk = [r for r in adverse if r["category"] == cat_key]
        s_pct = round(sum(r["contribution_pct"] for r in cat_safe), 1)
        r_pct = round(sum(r["contribution_pct"] for r in cat_risk), 1)
        share = round(s_pct + r_pct, 1)
        within = round(r_pct * 100 / share, 1) if share else 0.0
        categories.append({
            "key": cat_key, "label": cat_label,
            "share_pct": share,              # this section's part of the overall 100%
            "safe_pct": s_pct, "risk_pct": r_pct,
            "risk_within_pct": within,       # how adverse the section is on its own scale
            "band": band_for(within) if share else "Not recorded",
            "safe_factors": cat_safe, "risk_factors": cat_risk,
            "missing": [label for k, label, _ in FACTORS if CATEGORY_OF[k] == cat_key and label in missing],
        })

    # What the matched rules mean for underwriting, accumulated like the rule engine does.
    counted = [r for rules in by_factor.values() for r in rules]
    tests = sorted({t for r in counted for t in (r.get("medical_profile_codes") or [])})
    loading = sum(float(r.get("extra_mortality_pct") or 0) for r in counted)
    referral = any(r.get("impact_type") in {"REFER_TO_UNDERWRITER", "DECLINE"} for r in counted)

    risk_pct = round(sum(r["contribution_pct"] for r in adverse), 1)
    safe_pct = round(100 - risk_pct, 1)
    band = band_for(risk_pct)
    top = ", ".join(r["label"].lower() for r in adverse[:2])
    return {
        **base,
        "safe_pct": safe_pct,
        "risk_pct": risk_pct,
        "band": band,
        "completeness_pct": answered,
        "categories": categories,
        "safe_factors": safe,
        "risk_factors": adverse,
        "missing": missing,
        "cover_considered": cover,
        "underwriting": {"medical_tests": tests, "extra_mortality_pct": loading, "referral": referral},
        "summary": (f"{band} risk: {safe_pct}% of the profile is favourable and {risk_pct}% adverse"
                    + (f", driven mainly by {top}." if top else ".")),
    }
