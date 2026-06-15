"""
Risk Engine — LangGraph multi-agent evaluation workflow.

Graph topology:

  START
    └─► intake_validation ──[invalid]──► END
                          └──[valid]──► medical_scoring
                                            └─► financial_scoring
                                                      └─► fraud_check
                                                                └─► decision_maker
                                                                          └─► END

All nodes are deterministic mock functions; no LLM API keys are required.
Drop-in LLM calls can replace the mock bodies in v2 without touching the graph.

Scoring convention: 0 = no risk, 100 = maximum risk.
Composite = medical×0.40 + financial×0.35 + fraud_pct×0.25
Decision thresholds: 0–25 Auto Approve | 26–50 Loading | 51–75 Review | 76–100 Decline
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, List, Optional

from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict


# ─────────────────────────────────────────────────────────────────────────────
# State schema
# ─────────────────────────────────────────────────────────────────────────────

class RiskState(TypedDict):
    # ── Inputs ────────────────────────────────────────────────────────────────
    applicant: Dict[str, Any]
    # expected keys: cnic, name, dob, gender, occupation, declared_income (annual PKR)

    policy: Dict[str, Any]
    # expected keys: coverage_amount (PKR), term_years, product_name

    # ── Validation ────────────────────────────────────────────────────────────
    is_valid: bool
    validation_errors: List[str]

    # ── Agent outputs ─────────────────────────────────────────────────────────
    medical_score: int           # 0–100
    medical_reasons: List[str]

    financial_score: int         # 0–100
    financial_reasons: List[str]

    fraud_probability: float     # 0.0–1.0
    fraud_reasons: List[str]

    # ── Final decision ────────────────────────────────────────────────────────
    composite_risk_score: int
    ai_decision: str             # mirrors AIDecision enum values in shared/models
    suggested_loading: Optional[float]  # % premium loading; None if not applicable
    reasons: List[str]           # unified explainability list for the UI


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

_HIGH_HAZARD_KEYWORDS = {
    "mining", "miner", "military", "soldier", "army", "navy", "air force",
    "police", "security guard", "fisherman", "fishing", "lumberjack",
    "construction", "demolition", "oil rig", "pilot", "motorcyclist",
    "racing driver", "firefighter", "bomb disposal",
}

_MEDIUM_HAZARD_KEYWORDS = {
    "driver", "factory worker", "mechanic", "plumber", "welder",
    "painter", "carpenter", "mason", "delivery", "courier", "electrician",
}


def _parse_dob(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return datetime.strptime(str(value), "%Y-%m-%d").date()


def _age(dob: date) -> int:
    today = date.today()
    return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))


def _occupation_tier(occupation: str) -> str:
    """Returns 'high', 'medium', or 'low' hazard tier for a given occupation."""
    occ = occupation.lower()
    if any(k in occ for k in _HIGH_HAZARD_KEYWORDS):
        return "high"
    if any(k in occ for k in _MEDIUM_HAZARD_KEYWORDS):
        return "medium"
    return "low"


# ─────────────────────────────────────────────────────────────────────────────
# Node 1 — Intake Validation
# ─────────────────────────────────────────────────────────────────────────────

_REQUIRED_APPLICANT = {"cnic", "name", "dob", "gender", "occupation", "declared_income"}
_REQUIRED_POLICY = {"coverage_amount", "term_years"}


def intake_validation(state: RiskState) -> Dict[str, Any]:
    """
    Gate node. Checks that all required fields are present and within
    acceptable ranges. Invalid applications short-circuit to END.
    """
    errors: List[str] = []
    applicant = state["applicant"]
    policy = state["policy"]

    for field in _REQUIRED_APPLICANT:
        if applicant.get(field) is None:
            errors.append(f"Missing required applicant field: '{field}'")

    for field in _REQUIRED_POLICY:
        if policy.get(field) is None:
            errors.append(f"Missing required policy field: '{field}'")

    if not errors:
        try:
            age = _age(_parse_dob(applicant["dob"]))
            if not (18 <= age <= 75):
                errors.append(
                    f"Applicant age {age} is outside the insurable range (18–75)."
                )
        except (ValueError, TypeError):
            errors.append("'dob' must be a valid ISO date string (YYYY-MM-DD).")

        if float(applicant.get("declared_income", -1)) < 0:
            errors.append("'declared_income' must be ≥ 0.")

        if float(policy.get("coverage_amount", 0)) <= 0:
            errors.append("'coverage_amount' must be > 0.")

        if not (1 <= int(policy.get("term_years", 0)) <= 40):
            errors.append("'term_years' must be between 1 and 40.")

    return {"is_valid": len(errors) == 0, "validation_errors": errors}


# ─────────────────────────────────────────────────────────────────────────────
# Node 2 — Medical Scoring
# ─────────────────────────────────────────────────────────────────────────────

def medical_scoring(state: RiskState) -> Dict[str, Any]:
    """
    Actuarial proxy for medical underwriting.

    Signals used:
      - Age bracket         (dominant factor for mortality tables)
      - Biological sex      (small actuarial mortality differential)
      - Occupation hazard   (accidental death / disability exposure)

    LLM replacement hook: swap the bracket lookups for a structured Claude call
    that accepts BMI, medical history, and smoker status when that data is available.
    """
    applicant = state["applicant"]
    reasons: List[str] = []
    score = 0

    # ── Age bracket ───────────────────────────────────────────────────────────
    age = _age(_parse_dob(applicant["dob"]))
    age_table = [
        (26,  10, "18–25"),
        (36,  20, "26–35"),
        (46,  32, "36–45"),
        (56,  48, "46–55"),
        (66,  62, "56–65"),
        (76,  78, "66–75"),
    ]
    for upper, pts, label in age_table:
        if age < upper:
            score += pts
            reasons.append(f"Age {age} (bracket {label}): +{pts} pts")
            break

    # ── Gender actuarial adjustment ───────────────────────────────────────────
    if str(applicant.get("gender", "")).lower() in {"male", "m", "male"}:
        score += 5
        reasons.append("Gender Male: +5 pts (actuarial mortality differential)")

    # ── Occupation hazard ─────────────────────────────────────────────────────
    occ = applicant.get("occupation", "Unknown")
    tier = _occupation_tier(occ)
    occ_pts = {"high": 20, "medium": 10, "low": 0}[tier]
    score += occ_pts
    reasons.append(
        f"Occupation '{occ}' ({tier}-hazard category): +{occ_pts} pts"
    )

    return {"medical_score": min(score, 100), "medical_reasons": reasons}


# ─────────────────────────────────────────────────────────────────────────────
# Node 3 — Financial Scoring
# ─────────────────────────────────────────────────────────────────────────────

def financial_scoring(state: RiskState) -> Dict[str, Any]:
    """
    Evaluates affordability and over-insurance risk.

    Signals used:
      - Coverage-to-income ratio  (primary lapse / contestability indicator)
      - Absolute income bracket   (proxy for financial stability)
      - Policy term length        (longer exposure = higher default/lapse risk)

    LLM replacement hook: extend with credit bureau data, existing policy
    aggregation, and debt-to-income ratio when available.
    """
    applicant = state["applicant"]
    policy = state["policy"]
    reasons: List[str] = []
    score = 0

    income = max(float(applicant.get("declared_income", 1)), 1)
    coverage = float(policy.get("coverage_amount", 0))
    ratio = coverage / income

    # ── Coverage-to-income ratio ──────────────────────────────────────────────
    ratio_table = [
        (3,           10, "< 3×",    "low over-insurance risk"),
        (5,           25, "3–5×",    "acceptable"),
        (10,          45, "5–10×",   "moderate"),
        (15,          65, "10–15×",  "high"),
        (float("inf"), 80, "> 15×",  "extreme — potential over-insurance"),
    ]
    for upper, pts, label, note in ratio_table:
        if ratio < upper:
            score += pts
            reasons.append(
                f"Coverage-to-income ratio {ratio:.1f}× ({label}, {note}): +{pts} pts"
            )
            break

    # ── Absolute income bracket (annual PKR) ──────────────────────────────────
    income_table = [
        (600_000,        20, "< PKR 600k/yr"),
        (1_200_000,      15, "PKR 600k–1.2M/yr"),
        (2_400_000,      10, "PKR 1.2M–2.4M/yr"),
        (4_800_000,       5, "PKR 2.4M–4.8M/yr"),
        (float("inf"),    0, "> PKR 4.8M/yr"),
    ]
    for upper, pts, label in income_table:
        if income < upper:
            score += pts
            if pts:
                reasons.append(f"Income bracket ({label}): +{pts} pts")
            else:
                reasons.append(f"Income bracket ({label}): no additional risk")
            break

    # ── Policy term length ────────────────────────────────────────────────────
    term = int(policy.get("term_years", 0))
    if term > 30:
        score += 10
        reasons.append(f"Long policy term ({term} yrs): +10 pts (lapse exposure)")
    elif term > 20:
        score += 5
        reasons.append(f"Medium-long term ({term} yrs): +5 pts")
    else:
        reasons.append(f"Policy term ({term} yrs): +0 pts")

    return {"financial_score": min(score, 100), "financial_reasons": reasons}


# ─────────────────────────────────────────────────────────────────────────────
# Node 4 — Fraud Check
# ─────────────────────────────────────────────────────────────────────────────

def fraud_check(state: RiskState) -> Dict[str, Any]:
    """
    Lightweight rule-based fraud signal aggregator.

    In production this node would call a Memgraph Cypher query to check
    entity relationships (shared CNICs, shared bank accounts, ring networks).
    For the prototype it uses observable application-layer signals only.

    LLM replacement hook: pass the full applicant profile to a Claude call
    with a structured fraud-signal extraction prompt and SHAP-style weights.
    """
    applicant = state["applicant"]
    policy = state["policy"]
    reasons: List[str] = []
    prob: float = 0.02  # 2% baseline industry fraud rate

    income = max(float(applicant.get("declared_income", 1)), 1)
    coverage = float(policy.get("coverage_amount", 0))
    ratio = coverage / income

    # ── CNIC format check (Pakistan: 13 numeric digits, optionally hyphenated) ──
    cnic: str = str(applicant.get("cnic", ""))
    cnic_digits = cnic.replace("-", "").replace(" ", "")
    if not (cnic_digits.isdigit() and len(cnic_digits) == 13):
        prob += 0.30
        reasons.append(
            f"CNIC '{cnic}' failed format validation (expected 13 digits): +0.30"
        )
    else:
        reasons.append(f"CNIC format valid: no signal")

    # ── Coverage-to-income anomaly ────────────────────────────────────────────
    if ratio > 15:
        prob += 0.25
        reasons.append(f"Extreme coverage-to-income ratio ({ratio:.1f}×): +0.25")
    elif ratio > 10:
        prob += 0.12
        reasons.append(f"Elevated coverage-to-income ratio ({ratio:.1f}×): +0.12")

    # ── Age boundary anomaly ──────────────────────────────────────────────────
    age = _age(_parse_dob(applicant["dob"]))
    if age < 18 or age > 70:
        prob += 0.10
        reasons.append(f"Age {age} outside normal underwriting range: +0.10")

    # ── Low income + high coverage combination ────────────────────────────────
    if income < 300_000 and coverage > 5_000_000:
        prob += 0.15
        reasons.append(
            "Low annual income (<PKR 300k) combined with high coverage (>PKR 5M): +0.15"
        )

    final_prob = min(round(prob, 4), 0.95)
    if final_prob <= 0.02:
        reasons.append("No fraud signals detected; baseline probability (2%) applies")

    return {"fraud_probability": final_prob, "fraud_reasons": reasons}


# ─────────────────────────────────────────────────────────────────────────────
# Node 5 — Decision Maker
# ─────────────────────────────────────────────────────────────────────────────

def decision_maker(state: RiskState) -> Dict[str, Any]:
    """
    Aggregates all agent scores into a single composite risk score and maps
    it to a final underwriting decision with an optional premium loading.

    Composite = medical×0.40 + financial×0.35 + fraud_pct×0.25

    Thresholds:
        0–25   → Auto Approve           (loading = 0%)
       26–50   → Approve with Loading   (loading 10%–50%, stepped to nearest 5%)
       51–75   → Human Review           (no automated loading)
       76–100  → Decline
    """
    medical = state["medical_score"]
    financial = state["financial_score"]
    fraud_pct = state["fraud_probability"] * 100

    composite = int(round(medical * 0.40 + financial * 0.35 + fraud_pct * 0.25))

    if composite <= 25:
        decision = "Auto Approve"
        loading: Optional[float] = 0.0
        decision_reason = f"Composite {composite}/100 ≤ 25 → Auto Approve (no loading)"

    elif composite <= 50:
        decision = "Approve with Loading"
        raw = ((composite - 25) / 25) * 40 + 10   # scales 10% → 50%
        loading = float(round(raw / 5) * 5)        # rounded to nearest 5%
        decision_reason = (
            f"Composite {composite}/100 in 26–50 → Approve with Loading "
            f"({loading:.0f}% premium loading)"
        )

    elif composite <= 75:
        decision = "Human Review"
        loading = None
        decision_reason = (
            f"Composite {composite}/100 in 51–75 → Referred to Human Underwriter"
        )

    else:
        decision = "Decline"
        loading = None
        decision_reason = f"Composite {composite}/100 > 75 → Decline"

    all_reasons = (
        state["medical_reasons"]
        + state["financial_reasons"]
        + state["fraud_reasons"]
        + [
            "─── Decision ───",
            (
                f"Composite risk score: {composite}/100  "
                f"(medical {medical}×0.40 + financial {financial}×0.35 "
                f"+ fraud {fraud_pct:.1f}×0.25)"
            ),
            decision_reason,
        ]
    )

    return {
        "composite_risk_score": composite,
        "ai_decision": decision,
        "suggested_loading": loading,
        "reasons": all_reasons,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Conditional routing
# ─────────────────────────────────────────────────────────────────────────────

def _route_after_validation(state: RiskState) -> str:
    return "valid" if state["is_valid"] else "invalid"


# ─────────────────────────────────────────────────────────────────────────────
# Graph assembly — compiled once at module load
# ─────────────────────────────────────────────────────────────────────────────

def _build_graph() -> StateGraph:
    g = StateGraph(RiskState)

    g.add_node("intake_validation", intake_validation)
    g.add_node("medical_scoring",   medical_scoring)
    g.add_node("financial_scoring", financial_scoring)
    g.add_node("fraud_check",       fraud_check)
    g.add_node("decision_maker",    decision_maker)

    g.add_edge(START, "intake_validation")

    g.add_conditional_edges(
        "intake_validation",
        _route_after_validation,
        {"valid": "medical_scoring", "invalid": END},
    )

    g.add_edge("medical_scoring",   "financial_scoring")
    g.add_edge("financial_scoring", "fraud_check")
    g.add_edge("fraud_check",       "decision_maker")
    g.add_edge("decision_maker",    END)

    return g


_compiled_graph = _build_graph().compile()


# ─────────────────────────────────────────────────────────────────────────────
# Public interface
# ─────────────────────────────────────────────────────────────────────────────

def run_evaluation(
    applicant_data: Dict[str, Any],
    policy_data: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Execute the full risk evaluation pipeline synchronously.

    Args:
        applicant_data: dict with keys matching the Applicant model
                        (cnic, name, dob, gender, occupation, declared_income)
        policy_data:    dict with keys matching the Policy model
                        (coverage_amount, term_years, product_name)

    Returns:
        Final RiskState as a plain dict. Key output fields:
            is_valid            bool
            validation_errors   list[str]
            medical_score       int  0–100
            financial_score     int  0–100
            fraud_probability   float  0.0–1.0
            composite_risk_score int  0–100
            ai_decision         str  ("Auto Approve" | "Approve with Loading" |
                                      "Human Review" | "Decline")
            suggested_loading   float | None  (% premium loading)
            reasons             list[str]  (explainability output for the UI)
    """
    initial: RiskState = {
        "applicant": applicant_data,
        "policy": policy_data,
        "is_valid": False,
        "validation_errors": [],
        "medical_score": 0,
        "medical_reasons": [],
        "financial_score": 0,
        "financial_reasons": [],
        "fraud_probability": 0.0,
        "fraud_reasons": [],
        "composite_risk_score": 0,
        "ai_decision": "",
        "suggested_loading": None,
        "reasons": [],
    }
    return dict(_compiled_graph.invoke(initial))
