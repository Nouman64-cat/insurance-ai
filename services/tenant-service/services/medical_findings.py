"""
Turning lab results into an underwriting verdict.

A panel lab returns numbers; an underwriter needs a rating. This module holds
the reference ranges and the ratings table that bridge the two, so a completed
MedicalExamOrder carries not just "here are the values" but "here is what they
cost in extra mortality and why".

The debits below are the standard shape of a life-underwriting rating manual —
each abnormal finding contributes a percentage loading, they accumulate, and
past a ceiling the case is adverse rather than ratable. Values are deliberately
conservative and, like every other grid in this codebase, deterministic: the
same results always produce the same verdict, which is what makes an
underwriting decision defensible on appeal.

Ranges are adult reference ranges as reported by the Pakistani panel labs the
platform integrates with (Chughtai, Aga Khan, IDC). A lab that reports a value
outside a range we do not model is preserved verbatim in the stored results and
surfaced to the underwriter unrated, rather than silently ignored.
"""

from __future__ import annotations

from typing import Any, Optional

# code → (low, high, unit, [(threshold, loading_pct, label), ...])
# The band list is read in order; the first band the value exceeds wins.
REFERENCE_RANGES: dict[str, dict] = {
    "FBS": {
        "label": "Fasting Blood Sugar",
        "unit": "mg/dL",
        "normal": (70, 99),
        "high_bands": [
            (200, 100, "Poorly controlled diabetes"),
            (126, 50, "Diabetic range"),
            (100, 25, "Impaired fasting glucose (pre-diabetes)"),
        ],
        "low_bands": [(0, 25, "Hypoglycaemia — requires explanation")],
    },
    "HBA1C": {
        "label": "HbA1c",
        "unit": "%",
        "normal": (4.0, 5.6),
        "high_bands": [
            (9.0, 125, "Poor long-term glycaemic control"),
            (7.0, 75, "Diabetes, suboptimal control"),
            (6.5, 50, "Diabetic range"),
            (5.7, 20, "Pre-diabetic range"),
        ],
        "low_bands": [],
    },
    "LIPID": {
        # Reported as total cholesterol; the full profile is kept in the raw value.
        "label": "Total Cholesterol",
        "unit": "mg/dL",
        "normal": (0, 199),
        "high_bands": [
            (280, 75, "Severe hypercholesterolaemia"),
            (240, 40, "High cholesterol"),
            (200, 15, "Borderline-high cholesterol"),
        ],
        "low_bands": [],
    },
    "LFT": {
        "label": "ALT (SGPT)",
        "unit": "U/L",
        "normal": (7, 55),
        "high_bands": [
            (150, 100, "Marked hepatic enzyme elevation"),
            (100, 50, "Moderate hepatic enzyme elevation"),
            (56, 25, "Mild hepatic enzyme elevation"),
        ],
        "low_bands": [],
    },
    "RFT": {
        "label": "Serum Creatinine",
        "unit": "mg/dL",
        "normal": (0.6, 1.3),
        "high_bands": [
            (2.0, 150, "Significant renal impairment"),
            (1.5, 75, "Renal impairment"),
            (1.31, 30, "Borderline renal function"),
        ],
        "low_bands": [],
    },
    "CBC": {
        "label": "Haemoglobin",
        "unit": "g/dL",
        "normal": (12.0, 17.5),
        "high_bands": [(19.0, 40, "Polycythaemia — requires investigation")],
        "low_bands": [
            (8.0, 75, "Severe anaemia"),
            (11.9, 25, "Anaemia"),
        ],
    },
}

# Qualitative tests: a result is a verdict, not a number.
QUALITATIVE_TESTS: dict[str, dict] = {
    "ECG": {
        "label": "Resting ECG",
        "normal_values": {"normal", "nad", "within normal limits", "wnl"},
        "adverse_loading": 100,
        "adverse_label": "Abnormal resting ECG — cardiology opinion required",
    },
    "CXR": {
        "label": "Chest X-Ray",
        "normal_values": {"normal", "nad", "clear", "within normal limits"},
        "adverse_loading": 75,
        "adverse_label": "Abnormal chest radiograph — respiratory opinion required",
    },
    "TMT": {
        "label": "Treadmill / Stress ECG",
        "normal_values": {"negative", "normal", "nad"},
        "adverse_loading": 150,
        "adverse_label": "Positive stress test — ischaemia suspected",
    },
    "ECHO": {
        "label": "Echocardiography",
        "normal_values": {"normal", "nad", "within normal limits"},
        "adverse_loading": 125,
        "adverse_label": "Structural cardiac abnormality on echocardiography",
    },
    "URINE_RE": {
        "label": "Urine Routine Examination",
        "normal_values": {"normal", "nad", "clear", "negative"},
        "adverse_loading": 30,
        "adverse_label": "Abnormal urinalysis — proteinuria/glycosuria requires follow-up",
    },
    "MER": {
        "label": "Medical Examiner's Report",
        "normal_values": {"normal", "nad", "satisfactory", "unremarkable"},
        "adverse_loading": 50,
        "adverse_label": "Adverse findings on physical examination",
    },
    "PSA": {
        "label": "Prostate Specific Antigen",
        "normal_values": {"normal", "negative", "nad"},
        "adverse_loading": 100,
        "adverse_label": "Raised PSA — urology opinion required",
    },
    "PAP": {
        "label": "PAP Smear",
        "normal_values": {"normal", "negative", "nad"},
        "adverse_loading": 100,
        "adverse_label": "Abnormal cervical cytology — gynaecology opinion required",
    },
}

# Findings that are not ratable at all — the risk is declined or postponed, not
# priced. Kept separate from the loading table on purpose: no premium loading
# makes an uninsurable risk insurable.
UNINSURABLE_TESTS: dict[str, dict] = {
    "HIV": {
        "label": "HIV I & II",
        "normal_values": {"negative", "non-reactive", "nonreactive", "nr"},
        "adverse_label": "Reactive HIV screen — proposal cannot proceed on standard terms",
    },
    "HEPATITIS": {
        "label": "Hepatitis B / C",
        "normal_values": {"negative", "non-reactive", "nonreactive", "nr"},
        "adverse_label": "Reactive hepatitis screen — specialist assessment and "
                         "individual consideration required",
    },
    "COTININE": {
        # Not a health finding — a truthfulness finding. A positive cotinine on
        # a declared non-smoker means the proposal was rated on false premises.
        "label": "Urine Cotinine",
        "normal_values": {"negative", "non-reactive", "nonreactive", "nr"},
        "adverse_label": "Positive cotinine on a declared non-smoker — smoker rates "
                         "apply and the declaration must be re-taken",
    },
}

# Above this cumulative loading the case stops being ratable.
ADVERSE_LOADING_CEILING: float = 200.0


def _as_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    cleaned = "".join(ch for ch in str(value) if ch.isdigit() or ch in ".-")
    try:
        return float(cleaned) if cleaned not in ("", "-", ".", "-.") else None
    except ValueError:
        return None


def _normalise(value: Any) -> str:
    return str(value or "").strip().lower()


def evaluate(results: dict) -> dict:
    """Rate a results payload.

    `results` is {test_code: value} or {test_code: {"value": ..., "unit": ...}}.
    Returns the outcome, the abnormal findings with their individual debits, and
    the total suggested loading — everything the underwriter and the reinsurance
    slip need.
    """
    findings: list[dict] = []
    total_loading = 0.0
    uninsurable = False
    unrated: list[str] = []

    for code, raw in (results or {}).items():
        value = raw.get("value") if isinstance(raw, dict) else raw
        if value in (None, ""):
            continue

        if code in UNINSURABLE_TESTS:
            spec = UNINSURABLE_TESTS[code]
            if _normalise(value) not in spec["normal_values"]:
                uninsurable = True
                findings.append({
                    "test": code, "label": spec["label"], "value": value,
                    "severity": "uninsurable", "loading_pct": 0.0,
                    "finding": spec["adverse_label"],
                })
            continue

        if code in QUALITATIVE_TESTS:
            spec = QUALITATIVE_TESTS[code]
            if _normalise(value) not in spec["normal_values"]:
                total_loading += spec["adverse_loading"]
                findings.append({
                    "test": code, "label": spec["label"], "value": value,
                    "severity": "abnormal", "loading_pct": float(spec["adverse_loading"]),
                    "finding": spec["adverse_label"],
                })
            continue

        if code in REFERENCE_RANGES:
            spec = REFERENCE_RANGES[code]
            numeric = _as_float(value)
            if numeric is None:
                unrated.append(code)
                continue
            low, high = spec["normal"]
            matched = None
            if numeric > high:
                for threshold, loading, label in spec["high_bands"]:
                    if numeric >= threshold:
                        matched = (loading, label)
                        break
            elif numeric < low:
                for threshold, loading, label in spec["low_bands"]:
                    if numeric <= threshold or threshold == 0:
                        matched = (loading, label)
                        break
            if matched:
                loading, label = matched
                total_loading += loading
                findings.append({
                    "test": code, "label": spec["label"], "value": numeric,
                    "unit": spec["unit"], "reference_range": f"{low}–{high} {spec['unit']}",
                    "severity": "abnormal", "loading_pct": float(loading), "finding": label,
                })
            continue

        # A test the manual does not model — never silently dropped.
        unrated.append(code)

    total_loading = round(min(total_loading, 400.0), 1)

    if uninsurable:
        outcome = "Adverse"
    elif total_loading >= ADVERSE_LOADING_CEILING:
        outcome = "Adverse"
    elif findings:
        outcome = "MinorFindings"
    else:
        outcome = "Normal"

    return {
        "outcome": outcome,
        "suggested_loading_pct": 0.0 if outcome == "Adverse" and uninsurable else total_loading,
        "abnormal_findings": findings,
        "unrated_tests": unrated,
        "uninsurable": uninsurable,
        "ceiling": ADVERSE_LOADING_CEILING,
    }
