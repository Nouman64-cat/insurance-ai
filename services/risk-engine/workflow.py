from __future__ import annotations

import logging
import os
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from langchain_core.prompts import ChatPromptTemplate
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import END, START, StateGraph
from neo4j import GraphDatabase
from neo4j import exceptions as neo4j_exc
from pydantic import BaseModel, Field
from typing_extensions import TypedDict

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
    applicant: Dict[str, Any]
    policy: Dict[str, Any]
    tenant_id: str
    is_valid: bool
    validation_errors: List[str]
    medical_score: int
    medical_reasons: List[str]
    financial_score: int
    financial_reasons: List[str]
    fraud_probability: float
    fraud_reasons: List[str]
    composite_risk_score: int
    ai_decision: str
    suggested_loading: Optional[float]
    reasons: List[str]


# ─────────────────────────────────────────────────────────────────────────────
# LLM helper
# ─────────────────────────────────────────────────────────────────────────────

def _llm() -> ChatGoogleGenerativeAI:
    return ChatGoogleGenerativeAI(
        model="gemini-2.5-flash",
        temperature=0.1,
        google_api_key=os.getenv("GEMINI_API_KEY"),
    )


# ─────────────────────────────────────────────────────────────────────────────
# LLM output schemas
# ─────────────────────────────────────────────────────────────────────────────

class MedicalScoreOutput(BaseModel):
    medical_score: int = Field(
        ge=0, le=100,
        description="Actuarial medical risk score from 0 to 100.")
    medical_reasons: List[str] = Field(
        description="List of strings explaining the exact reasons for the score.")


class FinancialScoreOutput(BaseModel):
    financial_score: int = Field(
        ge=0, le=100,
        description="Financial risk score from 0 to 100.")
    financial_reasons: List[str] = Field(
        description="List of strings explaining the financial risk assessment.")


class FraudScoreOutput(BaseModel):
    fraud_probability: float = Field(
        ge=0.0, le=1.0,
        description="Float between 0.0 (no fraud) and 1.0 (certain fraud).")
    fraud_reasons: List[str] = Field(
        description="List of specific reasons for this probability based on graph data.")


# DecisionOutput removed — final node is deterministic (no LLM).


# ─────────────────────────────────────────────────────────────────────────────
# Graph nodes
# ─────────────────────────────────────────────────────────────────────────────

def validate_input(state: RiskState) -> Dict[str, Any]:
    errors: List[str] = []
    applicant = state["applicant"]
    policy = state["policy"]

    try:
        dob = datetime.strptime(applicant["dob"], "%Y-%m-%d").date()
        age = (date.today() - dob).days // 365
        if age < 18:
            errors.append(f"Applicant is under 18 (age: {age}).")
        if age > 70:
            errors.append(f"Applicant exceeds maximum entry age of 70 (age: {age}).")
    except (KeyError, ValueError):
        errors.append("Invalid or missing date of birth.")

    income = applicant.get("declared_income", 0)
    if income <= 0:
        errors.append("Declared income must be greater than zero.")

    coverage = policy.get("coverage_amount", 0)
    if coverage <= 0:
        errors.append("Coverage amount must be greater than zero.")

    if income > 0 and coverage > income * 20:
        errors.append(
            f"Coverage amount ({coverage:,.0f}) exceeds 20× annual income ({income * 20:,.0f})."
        )

    term = policy.get("term_years", 0)
    if term < 1 or term > 40:
        errors.append(f"Policy term must be between 1 and 40 years (got {term}).")

    return {"is_valid": len(errors) == 0, "validation_errors": errors}


def medical_scoring(state: RiskState) -> Dict[str, Any]:
    applicant = state["applicant"]
    structured_llm = _llm().with_structured_output(MedicalScoreOutput)
    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are an expert life insurance medical underwriter.
         Evaluate the following applicant's baseline medical risk based on:
         1. Age (Calculate from DOB. Older = higher risk).
         2. Gender (Standard actuarial mortality differentials).
         3. Occupation Hazard (High hazard like mining/military = high points, office work = 0 points).

         Output a strict composite risk score from 0 (standard risk) to 100 (uninsurable) and the specific reasons."""),
        ("user", "Applicant Data: {applicant}")
    ])
    result = (prompt | structured_llm).invoke({"applicant": applicant})
    return {"medical_score": result.medical_score, "medical_reasons": result.medical_reasons}


def financial_scoring(state: RiskState) -> Dict[str, Any]:
    applicant = state["applicant"]
    policy = state["policy"]
    structured_llm = _llm().with_structured_output(FinancialScoreOutput)
    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are an expert insurance financial underwriter.
         Assess the financial risk of this applicant based on:
         1. Income-to-coverage ratio (high coverage vs low income = higher risk).
         2. Policy term (longer term = higher exposure).
         3. Occupation stability and income reliability.

         Output a financial risk score from 0 (low risk) to 100 (very high risk) and specific reasons."""),
        ("user", "Applicant: {applicant}\nPolicy: {policy}")
    ])
    result = (prompt | structured_llm).invoke({"applicant": applicant, "policy": policy})
    return {"financial_score": result.financial_score, "financial_reasons": result.financial_reasons}


# ─────────────────────────────────────────────────────────────────────────────
# Fraud detection — Memgraph ring query + Gemini evaluation
# ─────────────────────────────────────────────────────────────────────────────

# Detects two classes of fraud signal from the relationships built up by
# graph_writer.py after each evaluation (SAME_AREA and SAME_OCCUPATION_CLUSTER):
#
#   1. Income-outlier ring — an applicant whose declared income wildly exceeds
#      the average of neighbours in the same area *and* occupation cluster,
#      suggesting a fabricated salary figure within a coordinated group.
#
#   2. Coverage cluster — peers in the same occupation cluster applying for near-
#      identical coverage amounts, indicating coordinated high-value applications.
#
# Both queries are tenant-scoped. If Memgraph is unreachable the node falls back
# to empty signals so the rest of the workflow is never blocked by a graph-DB
# outage.

# Income-outlier detection within the same area + occupation cluster.
_INCOME_OUTLIER_QUERY = """
MATCH (a:Applicant {cnic: $cnic, tenant_id: $tenant_id})
OPTIONAL MATCH (a)-[:SAME_AREA]->(neighbour:Applicant)-[:SAME_OCCUPATION_CLUSTER]->(a)
WITH a, collect(neighbour) AS neighbours, avg(neighbour.declared_income) AS avg_income
RETURN
  size(neighbours)                                        AS cluster_size,
  avg_income                                              AS avg_income_in_cluster,
  CASE
    WHEN avg_income > 0 AND a.declared_income > avg_income * 3 THEN true
    ELSE false
  END                                                     AS income_outlier,
  left(a.cnic, 5)                                         AS cnic_prefix
"""

# Coverage-cluster detection (suspicious near-identical coverage amounts).
_COVERAGE_CLUSTER_QUERY = """
MATCH (a:Applicant {cnic: $cnic, tenant_id: $tenant_id})
OPTIONAL MATCH (a)-[:SAME_OCCUPATION_CLUSTER]->(peer:Applicant)
WHERE abs(peer.coverage_amount - a.coverage_amount) < 50000
WITH collect(peer) AS cluster
RETURN size(cluster) AS coverage_cluster_size
"""

_GRAPH_FALLBACK: Dict[str, Any] = {
    "graph_available":        False,
    "cluster_size":           0,
    "avg_income_in_cluster":  0.0,
    "income_outlier":         False,
    "coverage_cluster_size":  0,
}


def _query_fraud_graph(cnic: str, tenant_id: str) -> Dict[str, Any]:
    """Run the ring-detection Cypher queries against Memgraph.

    Runs both the income-outlier and coverage-cluster queries in a single
    session and merges their results. Returns graph intelligence on success;
    returns _GRAPH_FALLBACK on any connectivity or query error so the calling
    node is never blocked.
    """
    try:
        with GraphDatabase.driver(
            MEMGRAPH_URI, auth=(MEMGRAPH_USER, MEMGRAPH_PASS)
        ) as driver:
            driver.verify_connectivity()
            with driver.session() as session:
                income_rec = session.run(
                    _INCOME_OUTLIER_QUERY, cnic=cnic, tenant_id=tenant_id
                ).single()
                coverage_rec = session.run(
                    _COVERAGE_CLUSTER_QUERY, cnic=cnic, tenant_id=tenant_id
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


def fraud_check(state: RiskState) -> Dict[str, Any]:
    applicant = state["applicant"]
    policy    = state["policy"]
    cnic      = applicant["cnic"]
    tenant_id = state.get("tenant_id", "")

    # ── 1. Graph intelligence from Memgraph ───────────────────────────────────
    graph = _query_fraud_graph(cnic=cnic, tenant_id=tenant_id)

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

    # ── 3. LLM evaluation with Gemini ─────────────────────────────────────────
    structured_llm = _llm().with_structured_output(FraudScoreOutput)

    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are a senior insurance fraud investigator specialising in network-based fraud rings.
You have access to both raw applicant data AND live Memgraph graph intelligence.

Evaluate fraud probability using a two-tier signal hierarchy:

TIER 1 — GRAPH SIGNALS (highest weight, hard evidence):
  • income_outlier = true → declared income exceeds 3× the average of neighbours
    in the same area + occupation cluster; classic income-fabrication signal.
  • coverage_cluster_size > 0 → occupation peers applying for near-identical
    coverage amounts; coordinated high-value applications through a shared network.
  • cluster_size large → a dense area/occupation cluster amplifies ring risk.

TIER 2 — DATA SIGNALS (secondary weight, circumstantial):
  • Coverage-to-income ratio > 15× → moral hazard / over-insurance.
  • Age-occupation-income inconsistency (e.g. 25-year-old "retired").
  • Unusually round income figures that match known fabrication patterns.

GRAPH UNAVAILABLE: If graph_available is false, assess from data signals only
and cap probability at 0.5 — absence of graph evidence is not proof of fraud.

Output a fraud_probability from 0.0 (clean) to 1.0 (certain fraud) and a list
of specific, evidence-backed reasons referencing the actual graph findings."""),
        ("user",
         "=== APPLICANT DATA ===\n{applicant}\n\n"
         "=== POLICY DATA ===\n{policy}\n\n"
         "=== MEMGRAPH RING INTELLIGENCE ===\n{graph_summary}"),
    ])

    result = (prompt | structured_llm).invoke({
        "applicant":     applicant,
        "policy":        policy,
        "graph_summary": graph_summary,
    })

    return {
        "fraud_probability": result.fraud_probability,
        "fraud_reasons":     result.fraud_reasons,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Decision aggregation — deterministic, no LLM
# ─────────────────────────────────────────────────────────────────────────────

# Actuarial decision bands
#   Auto Approve  → composite < 30  AND  fraud < 0.10  (clean profile, low risk)
#   Decline       → composite > 75  OR   fraud > 0.60  (either dimension is disqualifying)
#   Human Review  → everything else                     (ambiguous — needs underwriter eyes)

def decision_aggregation(state: RiskState) -> Dict[str, Any]:
    # ── 1. Pull scores with conservative safe defaults ────────────────────────
    # Defaults to 50 / 0.5 if a prior node failed, keeping the decision safely
    # in the "Human Review" band rather than accidentally auto-approving.
    medical_score     = int(state.get("medical_score",     50))
    financial_score   = int(state.get("financial_score",   50))
    fraud_probability = float(state.get("fraud_probability", 0.5))

    medical_reasons   = list(state.get("medical_reasons",   []))
    financial_reasons = list(state.get("financial_reasons", []))
    fraud_reasons     = list(state.get("fraud_reasons",     []))

    # ── 2. Composite score: 40% medical + 40% financial + 20% fraud ──────────
    fraud_scaled         = round(fraud_probability * 100, 2)
    raw_composite        = 0.40 * medical_score + 0.40 * financial_score + 0.20 * fraud_scaled
    composite_risk_score = max(0, min(100, round(raw_composite)))

    # ── 3. Actuarial decision bands ───────────────────────────────────────────
    if composite_risk_score < 30 and fraud_probability < 0.10:
        ai_decision = "Auto Approve"
        band_rationale = (
            f"composite {composite_risk_score} < 30 "
            f"and fraud probability {fraud_probability:.2f} < 0.10"
        )
    elif composite_risk_score > 75 or fraud_probability > 0.60:
        ai_decision = "Decline"
        if fraud_probability > 0.60:
            band_rationale = (
                f"fraud probability {fraud_probability:.2f} exceeds hard-decline "
                f"threshold of 0.60 (composite: {composite_risk_score})"
            )
        else:
            band_rationale = (
                f"composite {composite_risk_score} exceeds hard-decline "
                f"threshold of 75 (fraud: {fraud_probability:.2f})"
            )
    else:
        ai_decision = "Human Review"
        band_rationale = (
            f"composite {composite_risk_score} falls in the 30–75 review band "
            f"(fraud: {fraud_probability:.2f})"
        )

    # ── 4. XAI reasons — all node outputs + mathematical breakdown ────────────
    math_breakdown = (
        f"Composite score {composite_risk_score}/100 = "
        f"(40% × medical {medical_score}) + "
        f"(40% × financial {financial_score}) + "
        f"(20% × fraud {fraud_scaled:.0f}) → "
        f"{band_rationale} → decision: '{ai_decision}'"
    )

    reasons = [*medical_reasons, *financial_reasons, *fraud_reasons, math_breakdown]

    return {
        "composite_risk_score": composite_risk_score,
        "ai_decision":          ai_decision,
        "reasons":              reasons,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Graph assembly
# ─────────────────────────────────────────────────────────────────────────────

def _should_continue(state: RiskState) -> str:
    return "medical_scoring" if state["is_valid"] else END


_graph = StateGraph(RiskState)
_graph.add_node("validate_input",      validate_input)
_graph.add_node("medical_scoring",     medical_scoring)
_graph.add_node("financial_scoring",   financial_scoring)
_graph.add_node("fraud_detection",     fraud_check)
_graph.add_node("decision_aggregation", decision_aggregation)

_graph.add_edge(START, "validate_input")
_graph.add_conditional_edges("validate_input", _should_continue)
_graph.add_edge("medical_scoring",     "financial_scoring")
_graph.add_edge("financial_scoring",   "fraud_detection")
_graph.add_edge("fraud_detection",     "decision_aggregation")
_graph.add_edge("decision_aggregation", END)

_workflow = _graph.compile()


# ─────────────────────────────────────────────────────────────────────────────
# Public entry points
# ─────────────────────────────────────────────────────────────────────────────

def _initial_state(
    applicant_data: Dict[str, Any],
    policy_data: Dict[str, Any],
    tenant_id: str = "",
) -> RiskState:
    return {
        "applicant":           applicant_data,
        "policy":              policy_data,
        "tenant_id":           tenant_id,
        "is_valid":            False,
        "validation_errors":   [],
        "medical_score":       0,
        "medical_reasons":     [],
        "financial_score":     0,
        "financial_reasons":   [],
        "fraud_probability":   0.0,
        "fraud_reasons":       [],
        "composite_risk_score": 0,
        "ai_decision":         "",
        "suggested_loading":   None,
        "reasons":             [],
    }


def run_evaluation(
    applicant_data: Dict[str, Any],
    policy_data: Dict[str, Any],
    tenant_id: str = "",
) -> Dict[str, Any]:
    return dict(_workflow.invoke(_initial_state(applicant_data, policy_data, tenant_id)))


def stream_evaluation(
    applicant_data: Dict[str, Any],
    policy_data: Dict[str, Any],
    tenant_id: str = "",
):
    """Yields (node_name, node_data) for each completed node, then ('__done__', full_state)."""
    accumulated = dict(_initial_state(applicant_data, policy_data, tenant_id))
    for update in _workflow.stream(
        _initial_state(applicant_data, policy_data, tenant_id), stream_mode="updates"
    ):
        node_name = list(update.keys())[0]
        node_data = update[node_name]
        accumulated.update(node_data)
        yield node_name, node_data
    yield "__done__", accumulated
