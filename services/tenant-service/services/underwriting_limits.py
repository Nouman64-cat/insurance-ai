"""
The insurer's underwriting limit book — one module, three grids.

Everything here is a *published limit*, not a judgement call: the numbers below
are what an insurer's underwriting manual states and what its systems enforce
mechanically. Keeping them together means the three places that consume them —
the medical-exam order, the reinsurance referral, and the insurance-history
over-insurance screen — can never read three different versions of the same
number.

  1. NON_MEDICAL_LIMITS   — age band → sum assured underwritable on the
                            E-Application alone. Above it, physical diagnostics
                            become mandatory (routers/medical_exam.py).
  2. TEST_TIERS           — how much diagnostics: which test panel is mandated
                            at each (age, sum-at-risk) tier, drawn from
                            TEST_CATALOGUE.
  3. RETENTION / TREATY   — how much of a risk the insurer keeps on its own
                            book before it must cede (routers/reinsurance.py).

Defaults reflect the mid-market Pakistani life book (PKR, panel labs like
Chughtai / Aga Khan / IDC). Every figure is overridable by environment variable
so a tenant deployment can be tuned without a code change — same convention
insurer_config.py already uses for the premium-notice settings.
"""

from __future__ import annotations

import os
from datetime import date
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# 1. Non-Medical Limits (NML)
#
# Read as: "an applicant in this age band may be underwritten on declarations
# alone up to this aggregate sum assured." The limit falls with age because
# undetected impairment prevalence rises with it. Beyond age 60 nothing is
# non-medical — every proposal is examined.
# ─────────────────────────────────────────────────────────────────────────────

# (min_age, max_age, non_medical_limit_pkr)
NON_MEDICAL_LIMITS: list[tuple[int, int, float]] = [
    (0,  17,  1_000_000),    # juvenile lives — parent-underwritten, low limit
    (18, 35,  3_000_000),
    (36, 40,  2_000_000),
    (41, 45,  1_500_000),
    (46, 50,  1_000_000),
    (51, 55,    500_000),
    (56, 60,    250_000),
    (61, 120,         0),    # always medical
]


def non_medical_limit(age: Optional[int]) -> float:
    """The NML for an applicant's age. An unknown age is treated as the most
    conservative band (0) — you cannot grant a non-medical concession to
    someone whose age you do not know."""
    if age is None:
        return 0.0
    for lo, hi, limit in NON_MEDICAL_LIMITS:
        if lo <= age <= hi:
            return float(limit)
    return 0.0


def age_from_dob(dob: Optional[date], as_of: Optional[date] = None) -> Optional[int]:
    """Age last birthday. (Insurers vary between age-last and age-nearest;
    age-last is the conservative reading for a limit grid.)"""
    if dob is None:
        return None
    ref = as_of or date.today()
    return ref.year - dob.year - ((ref.month, ref.day) < (dob.month, dob.day))


# ─────────────────────────────────────────────────────────────────────────────
# 2. Medical test catalogue + tier grid
#
# `code` is what the panel lab and the results payload key on; `cost` is the
# insurer-borne panel rate used to budget the requirement. `fasting` drives the
# customer-facing appointment instructions.
# ─────────────────────────────────────────────────────────────────────────────

TEST_CATALOGUE: dict[str, dict] = {
    "MER": {
        "name": "Medical Examiner's Report",
        "category": "Clinical",
        "fasting": False,
        "cost": 3_500,
        "description": "Physical examination by a panel doctor — build, BP, pulse, systemic review.",
    },
    "FBS": {
        "name": "Fasting Blood Sugar",
        "category": "Biochemistry",
        "fasting": True,
        "cost": 400,
        "description": "Screens for undiagnosed diabetes.",
    },
    "URINE_RE": {
        "name": "Urine Routine Examination",
        "category": "Pathology",
        "fasting": False,
        "cost": 500,
        "description": "Sugar, protein and microscopy — renal and diabetic screen.",
    },
    "LIPID": {
        "name": "Lipid Profile",
        "category": "Biochemistry",
        "fasting": True,
        "cost": 1_800,
        "description": "Total cholesterol, HDL, LDL, triglycerides — cardiovascular risk.",
    },
    "CBC": {
        "name": "Complete Blood Count + ESR",
        "category": "Haematology",
        "fasting": False,
        "cost": 900,
        "description": "Anaemia, infection and haematological disorder screen.",
    },
    "LFT": {
        "name": "Liver Function Test",
        "category": "Biochemistry",
        "fasting": True,
        "cost": 2_200,
        "description": "ALT/AST/bilirubin — hepatic and alcohol-related impairment.",
    },
    "RFT": {
        "name": "Renal Function Test",
        "category": "Biochemistry",
        "fasting": True,
        "cost": 2_000,
        "description": "Urea, creatinine, electrolytes — renal impairment.",
    },
    "HBA1C": {
        "name": "HbA1c (Glycated Haemoglobin)",
        "category": "Biochemistry",
        "fasting": False,
        "cost": 2_500,
        "description": "Three-month glycaemic control — confirms or excludes diabetes.",
    },
    "ECG": {
        "name": "Resting ECG",
        "category": "Cardiology",
        "fasting": False,
        "cost": 1_500,
        "description": "12-lead resting electrocardiogram.",
    },
    "CXR": {
        "name": "Chest X-Ray (PA view)",
        "category": "Radiology",
        "fasting": False,
        "cost": 1_200,
        "description": "Pulmonary and cardiac silhouette screen — TB-endemic-region standard.",
    },
    "TMT": {
        "name": "Treadmill / Exercise Stress ECG",
        "category": "Cardiology",
        "fasting": True,
        "cost": 8_000,
        "description": "Exercise-provoked ischaemia — mandated at high sums assured and older ages.",
    },
    "ECHO": {
        "name": "Echocardiography",
        "category": "Cardiology",
        "fasting": False,
        "cost": 7_000,
        "description": "Structural and functional cardiac assessment.",
    },
    "HIV": {
        "name": "HIV I & II Screening",
        "category": "Serology",
        "fasting": False,
        "cost": 2_400,
        "description": "Mandatory above the high-sum-assured threshold.",
    },
    "HEPATITIS": {
        "name": "Hepatitis B & C Screening (HBsAg / Anti-HCV)",
        "category": "Serology",
        "fasting": False,
        "cost": 2_600,
        "description": "High regional prevalence — standard at large sums assured.",
    },
    "PSA": {
        "name": "Prostate Specific Antigen",
        "category": "Biochemistry",
        "fasting": False,
        "cost": 3_000,
        "description": "Male lives aged 50 and over at large sums assured.",
    },
    "COTININE": {
        "name": "Urine Cotinine (Nicotine) Test",
        "category": "Pathology",
        "fasting": False,
        "cost": 2_800,
        "description": "Verifies a declared non-smoker before non-smoker rates are granted.",
    },
    "PAP": {
        "name": "PAP Smear",
        "category": "Pathology",
        "fasting": False,
        "cost": 3_200,
        "description": "Female lives aged 40 and over at large sums assured.",
    },
}

# Tiered requirement grid. Each tier applies when the sum at risk is at or above
# `min_sum_assured` AND the applicant's age is at or above `min_age`; every
# matching tier's tests are unioned, so the panel grows with both money and age.
# (label, min_sum_assured, min_age, tests)
TEST_TIERS: list[tuple[str, float, int, tuple[str, ...]]] = [
    ("Standard non-medical breach", 0,           0,  ("MER", "FBS", "URINE_RE")),
    ("Metabolic panel",             2_000_000,   0,  ("LIPID", "CBC")),
    ("Organ function panel",        5_000_000,   0,  ("LFT", "RFT", "HBA1C")),
    ("Cardiac baseline",            5_000_000,   0,  ("ECG",)),
    ("Radiology",                   7_500_000,   0,  ("CXR",)),
    ("Serology (large sum assured)", 10_000_000, 0,  ("HIV", "HEPATITIS")),
    ("Stress cardiology",           15_000_000,  0,  ("TMT",)),
    ("Age-based cardiac baseline",  0,           45, ("ECG",)),
    ("Age-based radiology",         0,           50, ("CXR",)),
    ("Age-based stress cardiology", 10_000_000,  45, ("TMT",)),
    ("Senior cardiac workup",       0,           55, ("ECG", "CXR", "LIPID", "HBA1C")),
    ("Structural cardiology",       25_000_000,  50, ("ECHO",)),
]

# Above this aggregate exposure a declared non-smoker is cotinine-verified —
# the discount is too large to grant on a tick-box alone.
COTININE_THRESHOLD: float = float(os.environ.get("UW_COTININE_THRESHOLD", "10000000"))
# Gender/age-specific additions at large sums assured.
PSA_MIN_AGE: int = 50
PAP_MIN_AGE: int = 40
GENDER_SPECIFIC_THRESHOLD: float = float(os.environ.get("UW_GENDER_TEST_THRESHOLD", "10000000"))

# How long a completed medical stays valid before it must be repeated.
MEDICAL_VALIDITY_DAYS: int = int(os.environ.get("UW_MEDICAL_VALIDITY_DAYS", "180"))
# How long the customer has to book after being invited.
MEDICAL_INVITE_VALID_DAYS: int = int(os.environ.get("UW_MEDICAL_INVITE_DAYS", "21"))


def required_tests(
    *,
    age: Optional[int],
    sum_at_risk: float,
    gender: Optional[str] = None,
    is_smoker: Optional[bool] = None,
) -> list[dict]:
    """Resolve the mandated test panel for one life.

    Returns catalogue entries (with their code) in catalogue order, so the
    customer-facing appointment sheet and the lab requisition always list the
    tests in the same, clinically sensible sequence.
    """
    effective_age = age if age is not None else 0
    codes: set[str] = set()

    for _label, min_sa, min_age, tests in TEST_TIERS:
        if sum_at_risk >= min_sa and effective_age >= min_age:
            codes.update(tests)

    if sum_at_risk >= COTININE_THRESHOLD and is_smoker is False:
        codes.add("COTININE")

    if sum_at_risk >= GENDER_SPECIFIC_THRESHOLD and gender:
        g = gender.lower()
        if g.startswith("m") and effective_age >= PSA_MIN_AGE:
            codes.add("PSA")
        if g.startswith("f") and effective_age >= PAP_MIN_AGE:
            codes.add("PAP")

    return [
        {"code": code, **TEST_CATALOGUE[code]}
        for code in TEST_CATALOGUE
        if code in codes
    ]


def panel_cost(tests: list[dict]) -> float:
    return float(sum(t.get("cost", 0) for t in tests))


def assess_medical_requirement(
    *,
    age: Optional[int],
    sum_at_risk: float,
    gender: Optional[str] = None,
    is_smoker: Optional[bool] = None,
    adverse_disclosures: Optional[list[str]] = None,
) -> dict:
    """Decide whether this life needs a physical medical, and if so, which one.

    `adverse_disclosures` lets a Yes on the E-Application questionnaire pull a
    proposal into medicals even when the sum assured sits under the NML — which
    is how real underwriting works: the grid is a floor, disclosure overrides it.
    """
    nml = non_medical_limit(age)
    reasons: list[str] = []

    over_nml = sum_at_risk > nml
    if over_nml:
        reasons.append(
            f"Aggregate sum at risk PKR {sum_at_risk:,.0f} exceeds the "
            f"non-medical limit of PKR {nml:,.0f} for age {age if age is not None else '—'}."
        )
    if age is not None and age >= 61:
        reasons.append(f"Applicant age {age} — all proposals above 60 are medically underwritten.")
    for disclosure in adverse_disclosures or []:
        reasons.append(f"Adverse disclosure on the E-Application: {disclosure}.")

    required = bool(reasons)
    tests = required_tests(
        age=age, sum_at_risk=sum_at_risk, gender=gender, is_smoker=is_smoker
    ) if required else []

    return {
        "required": required,
        "non_medical_limit": nml,
        "sum_at_risk": sum_at_risk,
        "age": age,
        "reasons": reasons,
        "tests": tests,
        "estimated_cost": panel_cost(tests),
        "fasting_required": any(t["fasting"] for t in tests),
    }


# ─────────────────────────────────────────────────────────────────────────────
# 3. Retention & treaty capacity
#
# Retention is what the insurer keeps net on its own balance sheet for a single
# life. Automatic treaty capacity is a multiple of retention that the reinsurer
# has pre-agreed to take without seeing the file. Anything beyond retention +
# treaty must be placed facultatively — the reinsurer underwrites that life
# individually and returns its own terms.
# ─────────────────────────────────────────────────────────────────────────────

RETENTION_LIMIT: float = float(os.environ.get("UW_RETENTION_LIMIT", "5000000"))
# Automatic capacity expressed as a multiple of retention (a "4-line treaty").
TREATY_LINES: float = float(os.environ.get("UW_TREATY_LINES", "4"))
# Retention is scaled down for ages the insurer is less willing to hold net.
RETENTION_AGE_SCALING: list[tuple[int, int, float]] = [
    (0,  17, 0.50),
    (18, 45, 1.00),
    (46, 55, 0.75),
    (56, 60, 0.50),
    (61, 120, 0.25),
]
# Quota-share of the facultative excess the reinsurer prices on. Reinsurance
# premium is charged on the ceded portion at this rate per mille of sum assured.
FAC_PREMIUM_PER_MILLE: float = float(os.environ.get("UW_FAC_PREMIUM_PER_MILLE", "1.85"))


def retention_limit(age: Optional[int] = None) -> float:
    """The insurer's net retention for a single life, age-scaled."""
    factor = 1.0
    if age is not None:
        for lo, hi, f in RETENTION_AGE_SCALING:
            if lo <= age <= hi:
                factor = f
                break
    return round(RETENTION_LIMIT * factor, 2)


def treaty_capacity(age: Optional[int] = None) -> float:
    """Automatic (obligatory) reinsurance capacity above retention."""
    return round(retention_limit(age) * TREATY_LINES, 2)


def compute_cession(sum_assured: float, age: Optional[int] = None) -> dict:
    """Split a sum assured into retained / treaty-ceded / facultative-ceded.

    This is the whole referral decision in one function: a facultative amount
    greater than zero is exactly the condition under which a case must go to a
    reinsurer before it can be approved.
    """
    retention = retention_limit(age)
    treaty = treaty_capacity(age)

    retained = min(sum_assured, retention)
    above_retention = max(sum_assured - retention, 0.0)
    treaty_ceded = min(above_retention, treaty)
    facultative_ceded = max(above_retention - treaty, 0.0)

    if facultative_ceded > 0:
        referral_type = "Facultative"
    elif treaty_ceded > 0:
        referral_type = "Treaty"
    else:
        referral_type = "Treaty"  # nothing ceded at all — retained in full

    total_ceded = treaty_ceded + facultative_ceded
    return {
        "total_sum_assured": round(sum_assured, 2),
        "retention_limit": retention,
        "treaty_capacity": treaty,
        "automatic_capacity": round(retention + treaty, 2),
        "retained_amount": round(retained, 2),
        "treaty_ceded_amount": round(treaty_ceded, 2),
        "facultative_ceded_amount": round(facultative_ceded, 2),
        "total_ceded_amount": round(total_ceded, 2),
        "cession_pct": round(total_ceded / sum_assured * 100, 2) if sum_assured else 0.0,
        "referral_required": facultative_ceded > 0,
        "referral_type": referral_type,
        "reinsurance_premium": round(total_ceded / 1000 * FAC_PREMIUM_PER_MILLE, 2),
    }


# ─────────────────────────────────────────────────────────────────────────────
# 4. Human Life Value — the over-insurance ceiling used by the history screen
#
# The financial-underwriting counterpart to the NML: a life may only be insured
# for a multiple of income that a court would accept as an insurable interest.
# The multiple falls with age because there are fewer earning years left to
# replace.
# ─────────────────────────────────────────────────────────────────────────────

HLV_MULTIPLES: list[tuple[int, int, float]] = [
    (0,  30, 25.0),
    (31, 40, 20.0),
    (41, 50, 15.0),
    (51, 55, 10.0),
    (56, 60,  8.0),
    (61, 120, 5.0),
]


def hlv_multiple(age: Optional[int]) -> float:
    if age is None:
        return 10.0
    for lo, hi, mult in HLV_MULTIPLES:
        if lo <= age <= hi:
            return mult
    return 5.0


def hlv_limit(annual_income: Optional[float], age: Optional[int]) -> Optional[float]:
    """The maximum aggregate sum assured justifiable on this life's income."""
    if not annual_income or annual_income <= 0:
        return None
    return round(annual_income * hlv_multiple(age), 2)
