from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

from langchain_core.prompts import ChatPromptTemplate
from langgraph.graph import END, START, StateGraph
from neo4j import GraphDatabase
from neo4j import exceptions as neo4j_exc
from pydantic import BaseModel, Field
from typing_extensions import TypedDict

import usage
from llm import structured_llm
from underwriting_rules import (
    UNDERWRITING_RULES,
    _GENERIC_FALLBACK,
    MedicalExamTier,
    check_plan_rules,
    resolve_medical_exam_tier,
)

from shared.underwriting.decision_rules import decide
from shared.underwriting.profile import build_profile
from shared.underwriting.results import (
    FinancialUnderwritingResult,
    FraudAssessment,
    FraudSeverity,
    MedicalRiskClass,
    MedicalUnderwritingResult,
    VerificationFindingSpec,
)

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Memgraph connection config
# ─────────────────────────────────────────────────────────────────────────────

MEMGRAPH_URI  = os.getenv("MEMGRAPH_URI",      "bolt://memgraph:7687")
MEMGRAPH_USER = os.getenv("MEMGRAPH_USERNAME", "")
MEMGRAPH_PASS = os.getenv("MEMGRAPH_PASSWORD", "")


# ─────────────────────────────────────────────────────────────────────────────
# State schema
# ─────────────────────────────────────────────────────────────────────────────

class RiskState(TypedDict):
    customer: Dict[str, Any]
    policy: Dict[str, Any]
    tenant_id: str
    e_application: Optional[Dict[str, Any]]
    acr: Optional[Dict[str, Any]]
    compliance_screening: Optional[Any]
    # Evidence bundle api-gateway assembles from tenant-service before ever
    # calling risk-engine (brief §2) — document OCR evidence, cross-document
    # verification findings, and whether the Requirements Engine's mandatory
    # items are satisfied (api-gateway never reaches here when they are not,
    # but a direct/test call can still set this explicitly to False).
    document_evidence: Optional[List[Dict[str, Any]]]
    verified_facts: Optional[List[Dict[str, Any]]]
    requirements_satisfied: bool
    # The normalized Underwriting Profile (shared/underwriting/profile.py),
    # built once by load_underwriting_profile and read by every scoring node.
    underwriting_profile: Optional[Dict[str, Any]]
    is_valid: bool
    validation_errors: List[str]
    medical_score: int
    medical_reasons: List[Any]
    medical_result: Optional[Dict[str, Any]]
    financial_score: int
    financial_reasons: List[Any]
    financial_result: Optional[Dict[str, Any]]
    fraud_probability: float
    fraud_reasons: List[Any]
    fraud_result: Optional[Dict[str, Any]]
    composite_risk_score: int
    ai_decision: str
    suggested_loading: Optional[float]
    reasons: List[Any]
    # Structured medical/financial/fraud results + the requirements/
    # verification snapshot in effect at decision time — persisted verbatim
    # onto RiskAssessment.underwriting_results (brief §17).
    underwriting_results: Optional[Dict[str, Any]]


# ─────────────────────────────────────────────────────────────────────────────
# LLM helper — see llm.py. structured_llm() returns a Gemini structured-output
# runnable that transparently fails over to OpenAI when OPENAI_API_KEY is set.
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# LLM output schemas
# ─────────────────────────────────────────────────────────────────────────────

class RiskFactor(BaseModel):
    parameter: str = Field(description="The specific parameter being evaluated (e.g. 'Age', 'BMI', 'Diabetes', 'Coverage Ratio')")
    observation: str = Field(description="The observed value or finding (e.g. '54', '29.0 (Overweight)', 'Type 2 (controlled)', '5x annual income')")
    risk_rating: str = Field(description="The severity of this risk ('High', 'Moderate', 'Low')")


class MedicalScoreOutput(BaseModel):
    medical_score: int = Field(
        ge=0, le=100,
        description="Actuarial medical risk score from 0 to 100.")
    medical_reasons: List[RiskFactor] = Field(
        description="List of structured medical risk factors and their explanations.")


class FinancialScoreOutput(BaseModel):
    financial_score: int = Field(
        ge=0, le=100,
        description="Financial risk score from 0 to 100.")
    financial_reasons: List[RiskFactor] = Field(
        description="List of structured financial risk factors and their explanations.")


class FraudScoreOutput(BaseModel):
    fraud_probability: float = Field(
        ge=0.0, le=1.0,
        description="Float between 0.0 (no fraud) and 1.0 (certain fraud).")
    fraud_reasons: List[RiskFactor] = Field(
        description="List of structured fraud risk factors based on graph data.")


# DecisionOutput removed — final node is deterministic (no LLM).


# Neutral placeholder scores used when an LLM read is unavailable. Each node
# also forces its structured result to a review-level outcome, so these never
# drive the decision on their own.
_LLM_UNAVAILABLE_MEDICAL_SCORE = 50
_LLM_UNAVAILABLE_FINANCIAL_SCORE = 50
_LLM_UNAVAILABLE_FRAUD_PROBABILITY = 0.5


def _invoke_structured(prompt: ChatPromptTemplate, schema: Any, inputs: Dict[str, Any],
                       state: RiskState, node: str) -> Optional[Any]:
    """Returns the parsed LLM output, or None if every provider failed or the
    output didn't parse (include_raw=True reports parse failures as
    parsed=None rather than raising)."""
    try:
        raw = (prompt | structured_llm(schema)).invoke(inputs)
    except Exception:
        logger.exception("%s: LLM call failed on all providers", node)
        return None
    usage.record(raw["raw"], tenant_id=state.get("tenant_id"))
    if raw.get("parsed") is None:
        logger.error("%s: LLM output could not be parsed: %s", node, raw.get("parsing_error"))
        return None
    return raw["parsed"]


def _llm_unavailable_reason(parameter: str) -> Dict[str, str]:
    return {
        "parameter": parameter,
        "observation": "AI assessment unavailable (provider error or unparseable output) — routed to underwriter review.",
        "risk_rating": "Moderate",
    }


# ─────────────────────────────────────────────────────────────────────────────
# Graph nodes
# ─────────────────────────────────────────────────────────────────────────────

def validate_input(state: RiskState) -> Dict[str, Any]:
    customer = state["customer"]
    policy = state["policy"]

    is_valid, errors = check_plan_rules(policy.get("insurance_type"), customer, policy)

    return {"is_valid": is_valid, "validation_errors": errors}


def load_underwriting_profile(state: RiskState) -> Dict[str, Any]:
    """Builds the normalized Underwriting Profile once, so every scoring node
    reads the same assembled view of customer + policy + e-application + ACR
    + document evidence instead of each re-deriving age/BMI/ratios itself."""
    profile = build_profile(
        state["customer"], state["policy"],
        e_application=state.get("e_application"),
        acr=state.get("acr"),
        document_evidence=state.get("document_evidence"),
        verified_facts=state.get("verified_facts"),
    )
    return {"underwriting_profile": profile.model_dump(mode="json")}


# ── Deterministic medical floors (brief §6, §15) ─────────────────────────────
# A score the LLM produces can be *raised* in severity by these hard facts,
# never lowered — this is what makes "severe medical risk cannot be
# mathematically cancelled by good finances" literally true: the floor is
# applied before decision_engine ever sees the result, not averaged into it.
BMI_DECLINE_THRESHOLD = 40.0
BMI_POSTPONE_THRESHOLD = 35.0
BMI_RATED_THRESHOLD = 30.0

_RISK_CLASS_SEVERITY = {
    MedicalRiskClass.PREFERRED: 0,
    MedicalRiskClass.STANDARD: 1,
    MedicalRiskClass.SUBSTANDARD: 2,
    MedicalRiskClass.RATED: 3,
    MedicalRiskClass.MEDICAL_REVIEW_REQUIRED: 3,
    MedicalRiskClass.POSTPONE: 4,
    MedicalRiskClass.DECLINE: 5,
}


_STANDARD_MAX_SCORE = 35
_SUBSTANDARD_MAX_SCORE = 55

# Lowest raw score that lands in each loadable class.
_RISK_CLASS_MIN_SCORE = {
    MedicalRiskClass.SUBSTANDARD: _STANDARD_MAX_SCORE + 1,
    MedicalRiskClass.RATED: _SUBSTANDARD_MAX_SCORE + 1,
}


def _score_to_risk_class(score: int) -> MedicalRiskClass:
    if score <= 15:
        return MedicalRiskClass.PREFERRED
    if score <= _STANDARD_MAX_SCORE:
        return MedicalRiskClass.STANDARD
    if score <= _SUBSTANDARD_MAX_SCORE:
        return MedicalRiskClass.SUBSTANDARD
    if score <= 75:
        return MedicalRiskClass.RATED
    if score <= 90:
        return MedicalRiskClass.POSTPONE
    return MedicalRiskClass.DECLINE


def _deterministic_medical_floor(profile: Dict[str, Any]) -> tuple[Optional[MedicalRiskClass], List[str]]:
    medical_history = profile.get("medical_history") or {}
    reasons: List[str] = []
    floor: Optional[MedicalRiskClass] = None

    bmi = medical_history.get("bmi")
    if bmi is None:
        # Omitting height/weight must not silently bypass the BMI floors once
        # the plan's own exam tier says this coverage needs medical evidence.
        policy_request = profile.get("policy_request") or {}
        insurance_type = policy_request.get("insurance_type")
        rules = UNDERWRITING_RULES.get(insurance_type, _GENERIC_FALLBACK) if insurance_type else _GENERIC_FALLBACK
        tier = resolve_medical_exam_tier(rules, float(policy_request.get("coverage_amount") or 0))
        if tier is not None and tier != MedicalExamTier.NONE:
            floor = MedicalRiskClass.MEDICAL_REVIEW_REQUIRED
            reasons.append(
                f"Height/weight not provided, so BMI could not be assessed, and this coverage "
                f"requires medical evidence ({tier.value})."
            )
    else:
        if bmi >= BMI_DECLINE_THRESHOLD:
            floor = MedicalRiskClass.DECLINE
            reasons.append(f"BMI {bmi} is at/above the deterministic decline threshold of {BMI_DECLINE_THRESHOLD:g}.")
        elif bmi >= BMI_POSTPONE_THRESHOLD:
            floor = MedicalRiskClass.POSTPONE
            reasons.append(f"BMI {bmi} is at/above the deterministic postpone threshold of {BMI_POSTPONE_THRESHOLD:g}.")
        elif bmi >= BMI_RATED_THRESHOLD:
            floor = MedicalRiskClass.RATED
            reasons.append(f"BMI {bmi} is at/above the deterministic rating threshold of {BMI_RATED_THRESHOLD:g}.")

    if medical_history.get("document_findings"):
        candidate = MedicalRiskClass.MEDICAL_REVIEW_REQUIRED
        if floor is None or _RISK_CLASS_SEVERITY[candidate] > _RISK_CLASS_SEVERITY[floor]:
            floor = candidate
        reasons.append("Document-evidenced medical findings require underwriter review before a final classification.")

    return floor, reasons


def medical_scoring(state: RiskState) -> Dict[str, Any]:
    customer = state["customer"]
    e_app = state.get("e_application")
    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are an expert life insurance medical underwriter.
         Evaluate the following customer's baseline medical and lifestyle risk based on:
         1. Age (Calculate from DOB. Older = higher risk).
         2. Gender (Standard actuarial mortality differentials).
         3. Occupation Hazard (High hazard like mining/military/deep sea diver = high points).
         4. Declarative Medical Questionnaire (E-Application Yes/No answers, smoker status, family history, chronic conditions).
         5. Substance Consumption (Smoking status/vaper, alcohol consumption frequency, recreational drug use history).
         6. High-Risk Hobbies / Avocations (Participates in extreme sports, private aviation).
         7. Travel & Location Risks (Frequent travel to politically unstable or high-risk regions).
         8. Driving & Legal History (Driving violations, DUI history).

         Output a strict composite risk score from 0 (standard risk) to 100 (uninsurable) and the specific reasons. 
         Provide structured risk factors including the parameter, observation, and risk rating."""),
        ("user", "Customer Data: {customer}\n\nE-Application Disclosures: {e_app}")
    ])
    result = _invoke_structured(
        prompt, MedicalScoreOutput,
        {"customer": customer, "e_app": e_app or "None provided"},
        state, "medical_scoring",
    )
    if result is not None:
        medical_score = result.medical_score
        medical_reasons = [r.dict() for r in result.medical_reasons]
        risk_class = _score_to_risk_class(medical_score)
    else:
        medical_score = _LLM_UNAVAILABLE_MEDICAL_SCORE
        medical_reasons = [_llm_unavailable_reason("Medical Assessment")]
        risk_class = MedicalRiskClass.MEDICAL_REVIEW_REQUIRED

    profile = state.get("underwriting_profile") or {}
    floor, floor_reasons = _deterministic_medical_floor(profile)
    if floor is not None and _RISK_CLASS_SEVERITY[floor] > _RISK_CLASS_SEVERITY[risk_class]:
        risk_class = floor

    # A floor can raise the class above what the raw score implies (e.g. BMI
    # 32 with a score of 10 → Rated); price at no less than that class's own
    # lowest score so a loaded decision never carries a standard-rate loading.
    loading_percentage = (
        _medical_loading(max(medical_score, _RISK_CLASS_MIN_SCORE[risk_class]))
        if risk_class in _RISK_CLASS_MIN_SCORE else None
    )
    evidence_refs = [
        str(d.get("artifact_id")) for d in profile.get("document_evidence", [])
        if any(kw in (d.get("document_type") or "").lower() for kw in ("medical", "lab", "ecg", "physician", "health"))
    ]
    medical_result = MedicalUnderwritingResult(
        risk_score=medical_score,
        risk_class=risk_class,
        loading_percentage=loading_percentage,
        requires_human_review=(risk_class == MedicalRiskClass.MEDICAL_REVIEW_REQUIRED),
        reasons=[*medical_reasons, *floor_reasons],
        evidence_refs=evidence_refs,
    )
    return {
        "medical_score": medical_score,
        "medical_reasons": medical_reasons,
        "medical_result": medical_result.model_dump(mode="json"),
    }


FINANCIAL_REFERRAL_TOLERANCE = 1.5


def financial_scoring(state: RiskState) -> Dict[str, Any]:
    customer = state["customer"]
    policy = state["policy"]
    acr = state.get("acr")
    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are an expert insurance financial underwriter.
         Assess the financial risk of this customer based on:
         1. Income-to-coverage ratio (high coverage vs low income = higher risk).
         2. Policy term (longer term = higher exposure).
         3. Occupation stability and income reliability.
         4. Agent's Confidential Report (ACR) findings (Agent's estimated income opinion, verified source of income, moral hazard observations, agent remarks).

         Output a financial risk score from 0 (low risk) to 100 (very high risk) and specific reasons.
         Provide structured risk factors including the parameter, observation, and risk rating."""),
        ("user", "Customer: {customer}\nPolicy: {policy}\n\nAgent Confidential Report (ACR): {acr}")
    ])
    result = _invoke_structured(
        prompt, FinancialScoreOutput,
        {"customer": customer, "policy": policy, "acr": acr or "None provided"},
        state, "financial_scoring",
    )
    if result is not None:
        financial_score = result.financial_score
        financial_reasons = [r.dict() for r in result.financial_reasons]
    else:
        financial_score = _LLM_UNAVAILABLE_FINANCIAL_SCORE
        financial_reasons = [_llm_unavailable_reason("Financial Assessment")]

    # Deterministic coverage-vs-income ceiling (brief §7) — two tiers so the
    # decision chain (shared/underwriting/decision_rules.py::decide) can
    # actually reach every one of its own branches:
    #   <= 1.0x the plan multiple        -> financially_justified
    #   1.0x - FINANCIAL_REFERRAL_TOLERANCE -> Human Review (referral)
    #   beyond FINANCIAL_REFERRAL_TOLERANCE -> Decline, not referred
    # validate_input no longer hard-rejects over-coverage with a 422 (see
    # underwriting_rules.py::check_plan_rules) specifically so this judgment
    # gets recorded as a real, explainable underwriting decision instead of
    # dropping the case before scoring ever runs.
    rules = UNDERWRITING_RULES.get(policy.get("insurance_type"), _GENERIC_FALLBACK) if policy.get("insurance_type") else _GENERIC_FALLBACK
    declared_income = float(customer.get("declared_income") or 0)
    coverage_amount = float(policy.get("coverage_amount") or 0)

    profile = state.get("underwriting_profile") or {}
    verified_income = (profile.get("financial") or {}).get("verified_income")
    # Deterministic floor: when documents evidence a lower income than
    # declared, the ceiling is computed on the evidenced figure — the LLM's
    # read of the ACR/salary slip can't talk a cover above it back down.
    underwriting_income = declared_income
    if verified_income is not None and 0 < verified_income < declared_income:
        underwriting_income = float(verified_income)
        financial_reasons.append({
            "parameter": "Verified Income",
            "observation": (
                f"Income evidenced by documents ({underwriting_income:,.0f}) is below declared "
                f"income ({declared_income:,.0f}); coverage ceiling uses the evidenced figure."
            ),
            "risk_rating": "Moderate",
        })

    maximum_supported_cover = underwriting_income * rules.max_income_multiple if underwriting_income > 0 else None
    hard_ceiling = maximum_supported_cover * FINANCIAL_REFERRAL_TOLERANCE if maximum_supported_cover else None
    coverage_to_income_ratio = (coverage_amount / underwriting_income) if underwriting_income > 0 else 0.0
    financially_justified = maximum_supported_cover is not None and coverage_amount <= maximum_supported_cover
    beyond_hard_ceiling = hard_ceiling is None or coverage_amount > hard_ceiling
    # A numeric financial_score still over the referral line (ambiguous LLM
    # read) sends this to Human Review even when the deterministic ceiling
    # alone would have cleared it — the score and the ceiling are independent
    # checks, neither one can single-handedly force an approval. A clear
    # breach of the hard ceiling skips referral entirely — decide() declines
    # it outright rather than sending an obvious over-insurance case to an
    # underwriter.
    if beyond_hard_ceiling:
        referral_required = False
    else:
        referral_required = (not financially_justified) or result is None or financial_score >= 60

    evidence_refs = [
        str(d.get("artifact_id")) for d in profile.get("document_evidence", [])
        if any(kw in (d.get("document_type") or "").lower() for kw in ("salary", "income", "bank", "tax"))
    ]
    financial_result = FinancialUnderwritingResult(
        financially_justified=financially_justified,
        declared_income=declared_income,
        verified_income=verified_income,
        coverage_to_income_ratio=coverage_to_income_ratio,
        maximum_supported_cover=maximum_supported_cover,
        referral_required=referral_required,
        reasons=financial_reasons,
        evidence_refs=evidence_refs,
    )
    return {
        "financial_score": financial_score,
        "financial_reasons": financial_reasons,
        "financial_result": financial_result.model_dump(mode="json"),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Fraud detection — Memgraph ring query + Gemini evaluation
# ─────────────────────────────────────────────────────────────────────────────

# Detects two classes of fraud signal by matching peer customers directly on
# their stored attributes (tenant, CNIC-prefix area, occupation) rather than
# via the SAME_AREA/SAME_OCCUPATION_CLUSTER edges graph_writer.py precomputes.
# This also means income/coverage are compared using the CURRENT request's
# values, not whatever was last written to this customer's own node.
#
#   1. Income-outlier ring — this customer's declared income wildly exceeds
#      the average of peers in the same area *and* occupation, suggesting a
#      fabricated salary figure within a coordinated group.
#
#   2. Coverage cluster — peers in the same occupation applying for near-
#      identical coverage amounts, indicating coordinated high-value applications.
#
# Both queries are tenant-scoped, aggregate with no grouping key (so they
# always return exactly one row, even over zero peers), and never require
# this customer's own node to already exist. If Memgraph is unreachable the
# node falls back to empty signals so the rest of the workflow is never
# blocked by a graph-DB outage.

# Income-outlier detection within the same area + occupation cluster.
_INCOME_OUTLIER_QUERY = """
MATCH (n:Customer {tenant_id: $tenant_id})
WHERE n.cnic <> $cnic
  AND left(n.cnic, 5) = left($cnic, 5)
  AND n.occupation = $occupation
WITH collect(n) AS neighbours, avg(n.declared_income) AS avg_income
RETURN
  size(neighbours)                                            AS cluster_size,
  coalesce(avg_income, 0.0)                                   AS avg_income_in_cluster,
  (avg_income > 0 AND $declared_income > avg_income * 3)      AS income_outlier
"""

# Coverage-cluster detection (suspicious near-identical coverage amounts).
_COVERAGE_CLUSTER_QUERY = """
MATCH (p:Customer {tenant_id: $tenant_id})
WHERE p.cnic <> $cnic
  AND p.occupation = $occupation
  AND abs(p.coverage_amount - $coverage_amount) < 50000
RETURN count(p) AS coverage_cluster_size
"""

_GRAPH_FALLBACK: Dict[str, Any] = {
    "graph_available":        False,
    "cluster_size":           0,
    "avg_income_in_cluster":  0.0,
    "income_outlier":         False,
    "coverage_cluster_size":  0,
}


def _query_fraud_graph(
    cnic: str,
    tenant_id: str,
    occupation: str,
    declared_income: float,
    coverage_amount: float,
) -> Dict[str, Any]:
    """Run the ring-detection Cypher queries against Memgraph.

    Matches peer customers directly on their attributes and compares against
    this request's declared_income/coverage_amount — never depends on this
    customer's own node already existing, and never reads stale values off
    it. Runs both queries in a single session and merges their results.
    Returns graph intelligence on success; returns _GRAPH_FALLBACK on any
    connectivity or query error so the calling node is never blocked.
    """
    try:
        with GraphDatabase.driver(
            MEMGRAPH_URI, auth=(MEMGRAPH_USER, MEMGRAPH_PASS)
        ) as driver:
            driver.verify_connectivity()
            with driver.session() as session:
                income_rec = session.run(
                    _INCOME_OUTLIER_QUERY,
                    cnic=cnic, tenant_id=tenant_id,
                    occupation=occupation, declared_income=declared_income,
                ).single()
                coverage_rec = session.run(
                    _COVERAGE_CLUSTER_QUERY,
                    cnic=cnic, tenant_id=tenant_id,
                    occupation=occupation, coverage_amount=coverage_amount,
                ).single()

        result: Dict[str, Any] = {**_GRAPH_FALLBACK, "graph_available": True}

        if income_rec is not None:
            result["cluster_size"]          = income_rec["cluster_size"] or 0
            result["avg_income_in_cluster"] = income_rec["avg_income_in_cluster"] or 0.0
            result["income_outlier"]        = bool(income_rec["income_outlier"])

        if coverage_rec is not None:
            result["coverage_cluster_size"] = coverage_rec["coverage_cluster_size"] or 0

        return result

    except neo4j_exc.ServiceUnavailable:
        logger.warning("Memgraph unavailable — graph fraud check skipped (cnic=%s)", cnic)
        return _GRAPH_FALLBACK
    except Exception as exc:
        logger.error("Memgraph query failed (cnic=%s): %s", cnic, exc)
        return _GRAPH_FALLBACK


# Deterministic fraud severity bands (brief §8) — (lower_bound_probability,
# severity); the highest band the probability reaches wins.
_FRAUD_SEVERITY_BANDS: List[tuple] = [
    (0.0, FraudSeverity.LOW),
    (0.30, FraudSeverity.MEDIUM),
    (0.60, FraudSeverity.HIGH),
    (0.85, FraudSeverity.CRITICAL),
]


_FRAUD_SEVERITY_RANK = {
    FraudSeverity.LOW: 0,
    FraudSeverity.MEDIUM: 1,
    FraudSeverity.HIGH: 2,
    FraudSeverity.CRITICAL: 3,
}


def _fraud_severity(probability: float) -> FraudSeverity:
    severity = FraudSeverity.LOW
    for lower, band in _FRAUD_SEVERITY_BANDS:
        if probability >= lower:
            severity = band
    return severity


def fraud_check(state: RiskState) -> Dict[str, Any]:
    customer = state["customer"]
    policy    = state["policy"]
    cnic      = customer["cnic"]
    tenant_id = state.get("tenant_id", "")

    # ── 1. Graph intelligence from Memgraph ───────────────────────────────────
    graph = _query_fraud_graph(
        cnic=cnic,
        tenant_id=tenant_id,
        occupation=customer.get("occupation") or "",
        declared_income=float(customer.get("declared_income") or 0),
        coverage_amount=float(policy.get("coverage_amount") or 0),
    )

    # ── 2. Format graph results as a readable block for the LLM ──────────────
    graph_summary = (
        f"Graph database available          : {graph['graph_available']}\n"
        f"Cluster size (same area + occ.)   : {graph['cluster_size']} "
        f"(neighbours sharing CNIC area and occupation cluster)\n"
        f"Average income in cluster         : {graph['avg_income_in_cluster']}\n"
        f"Income outlier vs cluster         : {graph['income_outlier']} "
        f"(declared income > 3× the cluster average)\n"
        f"Coverage cluster size             : {graph['coverage_cluster_size']} "
        f"(occupation peers within 50,000 of this coverage amount)\n"
    )

    comp_screening = state.get("compliance_screening")

    # ── 3. LLM evaluation (Gemini, → OpenAI on failure) ───────────────────────
    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are a senior insurance fraud investigator specialising in network-based fraud rings and compliance screening.
You have access to raw customer data, live Memgraph graph intelligence, and Pre-Underwriting Compliance Screening results.

Evaluate fraud & compliance risk using a signal hierarchy:

TIER 1 — COMPLIANCE & GRAPH SIGNALS (highest weight, hard evidence):
  • Compliance Screening: Sanctions matches, PEP matches, SECP invalid CNICs, AML high risk rating.
  • income_outlier = true → declared income exceeds 3× the average of neighbours in the same area + occupation cluster.
  • coverage_cluster_size > 0 → occupation peers applying for near-identical coverage amounts.

TIER 2 — DATA SIGNALS (secondary weight, circumstantial):
  • Coverage-to-income ratio > 15× → moral hazard / over-insurance.
  • Age-occupation-income inconsistency.

GRAPH UNAVAILABLE: If graph_available is false, assess from data & compliance signals.

Output a fraud_probability from 0.0 (clean) to 1.0 (certain fraud) and a list
of specific, evidence-backed reasons referencing graph and compliance findings.
Provide structured risk factors including the parameter, observation, and risk rating."""),
        ("user",
         "=== CUSTOMER DATA ===\n{customer}\n\n"
         "=== POLICY DATA ===\n{policy}\n\n"
         "=== PRE-UNDERWRITING COMPLIANCE SCREENING ===\n{comp_screening}\n\n"
         "=== MEMGRAPH RING INTELLIGENCE ===\n{graph_summary}"),
    ])

    result = _invoke_structured(
        prompt, FraudScoreOutput,
        {
            "customer":       customer,
            "policy":         policy,
            "comp_screening": comp_screening or "None provided",
            "graph_summary":  graph_summary,
        },
        state, "fraud_check",
    )
    if result is not None:
        fraud_probability = result.fraud_probability
        fraud_reasons = [r.dict() for r in result.fraud_reasons]
        severity = _fraud_severity(fraud_probability)
    else:
        fraud_probability = _LLM_UNAVAILABLE_FRAUD_PROBABILITY
        fraud_reasons = [_llm_unavailable_reason("Fraud Assessment")]
        severity = FraudSeverity.MEDIUM

    # Deterministic Tier-1 graph floors — the LLM's read can raise severity
    # above these, never lower it. income_outlier alone → at least Medium
    # (underwriter review); income_outlier + coverage cluster → at least High
    # (fraud investigation). A coverage cluster alone is too common (round
    # coverage amounts) to floor on by itself.
    income_outlier = bool(graph.get("income_outlier"))
    coverage_cluster = graph.get("coverage_cluster_size", 0) > 0
    graph_floor: Optional[FraudSeverity] = None
    if income_outlier and coverage_cluster:
        graph_floor = FraudSeverity.HIGH
    elif income_outlier:
        graph_floor = FraudSeverity.MEDIUM
    if graph_floor is not None and _FRAUD_SEVERITY_RANK[graph_floor] > _FRAUD_SEVERITY_RANK[severity]:
        severity = graph_floor
        fraud_reasons.append({
            "parameter": "Graph Fraud Signal",
            "observation": (
                f"Declared income exceeds 3× the peer-cluster average"
                f"{' and peers hold near-identical coverage' if coverage_cluster else ''} — "
                f"severity floored at {graph_floor.value} regardless of the AI score."
            ),
            "risk_rating": "High" if graph_floor == FraudSeverity.HIGH else "Moderate",
        })

    investigation_required = severity in (FraudSeverity.HIGH, FraudSeverity.CRITICAL)
    fraud_result = FraudAssessment(
        probability=fraud_probability,
        severity=severity,
        investigation_required=investigation_required,
        reasons=fraud_reasons,
    )
    return {
        "fraud_probability": fraud_probability,
        "fraud_reasons":     fraud_reasons,
        "fraud_result":      fraud_result.model_dump(mode="json"),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Decision aggregation — deterministic, no LLM
# ─────────────────────────────────────────────────────────────────────────────

# The outcome itself comes from shared.underwriting.decision_rules.decide(),
# a sequential rule chain — the composite score is computed for display only.

# Extra-mortality loading for Substandard/Rated medical classes, as a % on the
# base premium. (lower_bound_medical_score, loading_pct) — the highest band the
# score reaches wins. Deliberately coarse and explainable rather than a
# continuous curve: an underwriter has to be able to justify the number to the
# customer.
_LOADING_BANDS: List[tuple] = [
    (30, 25.0),
    (40, 50.0),
    (50, 75.0),
    (60, 100.0),
]


def _medical_loading(medical_score: int) -> Optional[float]:
    """Extra-mortality loading implied by the medical risk score, or None if standard.

    Read by the whole downstream chain — the RiskAssessment row, the issuance
    price (tenant-service routers/policies.py::_effective_loading_pct) and the
    reinsurance referral. Before this existed, decision_aggregation never
    returned a loading at all, so RiskAssessment.suggested_loading was always
    NULL and every contract priced at standard rates no matter the risk.
    """
    applicable = [pct for lower, pct in _LOADING_BANDS if medical_score >= lower]
    return applicable[-1] if applicable else None


def decision_engine(state: RiskState) -> Dict[str, Any]:
    """Rule-based final decision (brief §9) — shared.underwriting.decision_rules
    branches on the independent medical/financial/fraud results, not a
    weighted sum. A missing upstream result (a prior node failed) falls back
    to the most conservative structured result rather than a numeric default,
    so a failure still routes to Human Review instead of accidentally
    clearing every rule-chain check with an optimistic guess."""
    medical_score     = int(state.get("medical_score",     50))
    financial_score   = int(state.get("financial_score",   50))
    fraud_probability = float(state.get("fraud_probability", 0.5))

    medical_reasons   = list(state.get("medical_reasons",   []))
    financial_reasons = list(state.get("financial_reasons", []))
    fraud_reasons     = list(state.get("fraud_reasons",     []))

    medical_result = MedicalUnderwritingResult.model_validate(state.get("medical_result") or {
        "risk_score": medical_score, "risk_class": MedicalRiskClass.MEDICAL_REVIEW_REQUIRED.value,
        "loading_percentage": None, "requires_human_review": True,
        "reasons": medical_reasons, "evidence_refs": [],
    })
    financial_result = FinancialUnderwritingResult.model_validate(state.get("financial_result") or {
        "financially_justified": False, "declared_income": 0.0, "verified_income": None,
        "coverage_to_income_ratio": 0.0, "maximum_supported_cover": None, "referral_required": True,
        "reasons": financial_reasons, "evidence_refs": [],
    })
    fraud_result = FraudAssessment.model_validate(state.get("fraud_result") or {
        "probability": fraud_probability, "severity": FraudSeverity.MEDIUM.value,
        "investigation_required": False, "reasons": fraud_reasons,
    })

    verified_facts = state.get("verified_facts") or []
    findings = [VerificationFindingSpec.model_validate(f) for f in verified_facts]
    requirements_satisfied = bool(state.get("requirements_satisfied", True))

    decision, decision_reasons = decide(
        requirements_satisfied=requirements_satisfied,
        medical=medical_result, financial=financial_result, fraud=fraud_result,
        findings=findings,
    )

    # Composite score — dashboard/explainability metric only (brief §9). Kept
    # for backward compatibility with existing UI/reporting that reads it,
    # but decide() above never looks at it.
    fraud_scaled          = round(fraud_probability * 100, 2)
    composite_risk_score  = max(0, min(100, round(
        0.40 * medical_score + 0.40 * financial_score + 0.20 * fraud_scaled
    )))

    math_breakdown = {
        "parameter": "Composite Score (dashboard only)",
        "risk_rating": "Info",
        "observation": (
            f"Composite {composite_risk_score}/100 = (40% × medical {medical_score}) + "
            f"(40% × financial {financial_score}) + (20% × fraud {fraud_scaled:.0f}) — "
            "shown for explainability only; the decision below is the independent "
            "rule-based outcome of medical/financial/fraud, not this weighted sum."
        ),
    }

    reasons: List[Any] = [*medical_reasons, *financial_reasons, *fraud_reasons, math_breakdown]
    for r in decision_reasons:
        reasons.append({"parameter": "Decision Rule", "risk_rating": "Info", "observation": r})

    suggested_loading = medical_result.loading_percentage
    if suggested_loading:
        reasons.append({
            "parameter": "Suggested Loading",
            "risk_rating": "Info",
            "observation": (
                f"Medical classification {medical_result.risk_class.value} implies an "
                f"extra-mortality loading of +{suggested_loading:g}% on the base premium."
            ),
        })

    return {
        "composite_risk_score": composite_risk_score,
        "ai_decision":          decision.value,
        "suggested_loading":    suggested_loading,
        "reasons":              reasons,
        "underwriting_results": {
            "medical": medical_result.model_dump(mode="json"),
            "financial": financial_result.model_dump(mode="json"),
            "fraud": fraud_result.model_dump(mode="json"),
            "requirements_satisfied": requirements_satisfied,
            "verified_facts": verified_facts,
        },
    }


# ─────────────────────────────────────────────────────────────────────────────
# Graph assembly
#
#   START -> validate_input -> [valid?]
#       NO  -> END (is_valid=False, nothing else runs)
#       YES -> load_underwriting_profile
#                 -> {medical_scoring, financial_scoring, fraud_detection}  (parallel)
#                 -> decision_engine -> END
# ─────────────────────────────────────────────────────────────────────────────

def _should_continue(state: RiskState) -> list[str]:
    return ["load_underwriting_profile"] if state["is_valid"] else [END]


_graph = StateGraph(RiskState)
_graph.add_node("validate_input",             validate_input)
_graph.add_node("load_underwriting_profile",  load_underwriting_profile)
_graph.add_node("medical_scoring",            medical_scoring)
_graph.add_node("financial_scoring",          financial_scoring)
_graph.add_node("fraud_detection",            fraud_check)
_graph.add_node("decision_engine",            decision_engine)

_graph.add_edge(START, "validate_input")
_graph.add_conditional_edges("validate_input", _should_continue)
# Unconditional fan-out: LangGraph's add_edge only accepts a list on the
# START side (a join, as used below for decision_engine) — a list on the END
# side raises "TypeError: unhashable type: 'list'" since internally it tries
# to hash (start_key, end_key) as a set member. Three separate edges from the
# same source is the correct idiom for parallel fan-out to multiple nodes.
_graph.add_edge("load_underwriting_profile", "medical_scoring")
_graph.add_edge("load_underwriting_profile", "financial_scoring")
_graph.add_edge("load_underwriting_profile", "fraud_detection")
_graph.add_edge(["medical_scoring", "financial_scoring", "fraud_detection"], "decision_engine")
_graph.add_edge("decision_engine", END)

_workflow = _graph.compile()


# ─────────────────────────────────────────────────────────────────────────────
# Public entry points
# ─────────────────────────────────────────────────────────────────────────────

def _initial_state(
    customer_data: Dict[str, Any],
    policy_data: Dict[str, Any],
    tenant_id: str = "",
    e_application: Optional[Dict[str, Any]] = None,
    acr: Optional[Dict[str, Any]] = None,
    compliance_screening: Optional[Any] = None,
    document_evidence: Optional[List[Dict[str, Any]]] = None,
    verified_facts: Optional[List[Dict[str, Any]]] = None,
    requirements_satisfied: bool = True,
) -> RiskState:
    return {
        "customer":           customer_data,
        "policy":              policy_data,
        "tenant_id":           tenant_id,
        "e_application":       e_application,
        "acr":                 acr,
        "compliance_screening": compliance_screening,
        "document_evidence":   document_evidence,
        "verified_facts":      verified_facts,
        "requirements_satisfied": requirements_satisfied,
        "underwriting_profile": None,
        "is_valid":            False,
        "validation_errors":   [],
        "medical_score":       0,
        "medical_reasons":     [],
        "medical_result":      None,
        "financial_score":     0,
        "financial_reasons":   [],
        "financial_result":    None,
        "fraud_probability":   0.0,
        "fraud_reasons":       [],
        "fraud_result":        None,
        "composite_risk_score": 0,
        "ai_decision":         "",
        "suggested_loading":   None,
        "reasons":             [],
        "underwriting_results": None,
    }


def run_evaluation(
    customer_data: Dict[str, Any],
    policy_data: Dict[str, Any],
    tenant_id: str = "",
    e_application: Optional[Dict[str, Any]] = None,
    acr: Optional[Dict[str, Any]] = None,
    compliance_screening: Optional[Any] = None,
    document_evidence: Optional[List[Dict[str, Any]]] = None,
    verified_facts: Optional[List[Dict[str, Any]]] = None,
    requirements_satisfied: bool = True,
) -> Dict[str, Any]:
    init_st = _initial_state(
        customer_data, policy_data, tenant_id, e_application, acr, compliance_screening,
        document_evidence, verified_facts, requirements_satisfied,
    )
    return dict(_workflow.invoke(init_st))


def stream_evaluation(
    customer_data: Dict[str, Any],
    policy_data: Dict[str, Any],
    tenant_id: str = "",
    e_application: Optional[Dict[str, Any]] = None,
    acr: Optional[Dict[str, Any]] = None,
    compliance_screening: Optional[Any] = None,
    document_evidence: Optional[List[Dict[str, Any]]] = None,
    verified_facts: Optional[List[Dict[str, Any]]] = None,
    requirements_satisfied: bool = True,
):
    """Yields (node_name, node_data) for each completed node, then ('__done__', full_state)."""
    init_st = _initial_state(
        customer_data, policy_data, tenant_id, e_application, acr, compliance_screening,
        document_evidence, verified_facts, requirements_satisfied,
    )
    accumulated = dict(init_st)
    for update in _workflow.stream(init_st, stream_mode="updates"):
        node_name = list(update.keys())[0]
        node_data = update[node_name]
        accumulated.update(node_data)
        yield node_name, node_data
    yield "__done__", accumulated
