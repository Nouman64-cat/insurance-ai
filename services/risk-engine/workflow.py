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


class DecisionOutput(BaseModel):
    composite_risk_score: int = Field(
        ge=0, le=100,
        description="Overall composite risk score from 0 to 100.")
    ai_decision: str = Field(
        description='One of exactly: "Auto Approve", "Approve with Loading", "Human Review", "Decline"')
    suggested_loading: Optional[float] = Field(
        default=None,
        description="Premium loading percentage if applicable, e.g. 25.0 for 25% extra premium.")
    reasons: List[str] = Field(
        description="Final list of reasons summarising the underwriting decision.")


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

# Detects three classes of fraud ring:
#
#   1. Income-fabrication ring — multiple flagged applicants declaring the exact
#      same income figure, suggesting a coordinator supplies a common fake value.
#
#   2. Occupation-cluster ring — flagged peers in the same occupation applying
#      for similar coverage, indicating coordinated applications through a shared
#      fraud network or agent.
#
#   3. Repeat-applicant pattern — the same CNIC appearing multiple times signals
#      policy stacking or application churning.
#
# If Memgraph is unreachable the node falls back to 0.0 / empty signals so the
# rest of the workflow is never blocked by a graph-DB outage.

_RING_QUERY = """
OPTIONAL MATCH (self:Applicant {cnic: $cnic})
OPTIONAL MATCH (self)-[:APPLIED_FOR]->(prior_pol:Policy)

// Income-fabrication ring: previously flagged applicants sharing the exact same
// declared income — a common coordinator fabricates one plausible salary figure.
OPTIONAL MATCH (income_peer:Applicant {declared_income: $declared_income})
WHERE income_peer.cnic <> $cnic
  AND income_peer.fraud_flagged = true

// Occupation-cluster ring: flagged peers in the same occupation who applied for
// coverage within 50% of the current request — coordinated high-value applications.
OPTIONAL MATCH (occ_peer:Applicant {occupation: $occupation})-[:APPLIED_FOR]->(occ_pol:Policy)
WHERE occ_peer.cnic <> $cnic
  AND occ_peer.fraud_flagged = true
  AND occ_pol.coverage_amount >= $coverage_amount * 0.5

WITH
    self,
    count(DISTINCT prior_pol)                                              AS prior_application_count,
    coalesce(self.fraud_flagged, false)                                    AS previously_flagged,
    coalesce(self.fraud_probability, 0.0)                                  AS prior_fraud_probability,
    collect(DISTINCT {cnic: income_peer.cnic, name: income_peer.name})    AS income_ring_peers,
    collect(DISTINCT {cnic: occ_peer.cnic, occupation: occ_peer.occupation}) AS occupation_ring_peers

RETURN
    self IS NOT NULL                AS is_known_applicant,
    previously_flagged,
    prior_fraud_probability,
    prior_application_count,
    income_ring_peers,
    occupation_ring_peers,
    size(income_ring_peers)         AS income_ring_size,
    size(occupation_ring_peers)     AS occupation_ring_size
"""

_GRAPH_FALLBACK: Dict[str, Any] = {
    "graph_available":         False,
    "is_known_applicant":      False,
    "previously_flagged":      False,
    "prior_fraud_probability": 0.0,
    "prior_application_count": 0,
    "income_ring_peers":       [],
    "occupation_ring_peers":   [],
    "income_ring_size":        0,
    "occupation_ring_size":    0,
}


def _query_fraud_graph(
    cnic: str,
    occupation: str,
    declared_income: float,
    coverage_amount: float,
) -> Dict[str, Any]:
    """Run the ring-detection Cypher query against Memgraph.

    Returns graph intelligence on success; returns _GRAPH_FALLBACK on any
    connectivity or query error so the calling node is never blocked.
    """
    try:
        with GraphDatabase.driver(
            MEMGRAPH_URI, auth=(MEMGRAPH_USER, MEMGRAPH_PASS)
        ) as driver:
            driver.verify_connectivity()
            with driver.session() as session:
                record = session.run(
                    _RING_QUERY,
                    cnic=cnic,
                    declared_income=declared_income,
                    occupation=occupation,
                    coverage_amount=coverage_amount,
                ).single()

        if record is None:
            return {**_GRAPH_FALLBACK, "graph_available": True}

        return {
            "graph_available":         True,
            "is_known_applicant":      record["is_known_applicant"],
            "previously_flagged":      record["previously_flagged"],
            "prior_fraud_probability": record["prior_fraud_probability"],
            "prior_application_count": record["prior_application_count"],
            "income_ring_peers":       list(record["income_ring_peers"]),
            "occupation_ring_peers":   list(record["occupation_ring_peers"]),
            "income_ring_size":        record["income_ring_size"],
            "occupation_ring_size":    record["occupation_ring_size"],
        }

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

    # ── 1. Graph intelligence from Memgraph ───────────────────────────────────
    graph = _query_fraud_graph(
        cnic            = cnic,
        occupation      = applicant.get("occupation", ""),
        declared_income = float(applicant.get("declared_income", 0)),
        coverage_amount = float(policy.get("coverage_amount", 0)),
    )

    # ── 2. Format graph results as a readable block for the LLM ──────────────
    graph_summary = (
        f"Graph database available          : {graph['graph_available']}\n"
        f"Applicant seen in system before   : {graph['is_known_applicant']}\n"
        f"Previously flagged for fraud      : {graph['previously_flagged']}\n"
        f"Prior fraud probability on record : {graph['prior_fraud_probability']}\n"
        f"Number of prior applications      : {graph['prior_application_count']}\n"
        f"Income-fabrication ring size      : {graph['income_ring_size']} "
        f"(flagged peers sharing exact declared income)\n"
        f"Income ring peers                 : {graph['income_ring_peers'] or 'none'}\n"
        f"Occupation-cluster ring size      : {graph['occupation_ring_size']} "
        f"(flagged peers in same occupation with similar coverage)\n"
        f"Occupation ring peers             : {graph['occupation_ring_peers'] or 'none'}\n"
    )

    # ── 3. LLM evaluation with Gemini ─────────────────────────────────────────
    structured_llm = _llm().with_structured_output(FraudScoreOutput)

    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are a senior insurance fraud investigator specialising in network-based fraud rings.
You have access to both raw applicant data AND live Memgraph graph intelligence.

Evaluate fraud probability using a two-tier signal hierarchy:

TIER 1 — GRAPH SIGNALS (highest weight, hard evidence):
  • previously_flagged = true → strong prior evidence; weight heavily.
  • income_ring_size > 0 → flagged peers share the exact declared income; classic fabrication ring.
  • occupation_ring_size > 0 → flagged peers in same occupation targeting similar coverage; coordinated network.
  • prior_application_count > 2 → policy-stacking / churning behaviour.
  • prior_fraud_probability > 0.5 → prior evaluation already raised a flag.

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


def make_decision(state: RiskState) -> Dict[str, Any]:
    structured_llm = _llm().with_structured_output(DecisionOutput)
    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are a senior insurance underwriting manager making the final decision.
         Based on all risk scores, produce:
         1. A composite risk score (0-100) as a weighted blend: 40% medical + 30% financial + 30% (fraud×100).
         2. A decision using EXACTLY one of these strings:
            - "Auto Approve"         (composite score 0–40)
            - "Approve with Loading" (composite score 41–65)
            - "Human Review"         (composite score 66–80)
            - "Decline"              (composite score 81–100)
         3. If "Approve with Loading", suggest a loading percentage (e.g. 25.0 for 25% extra premium).
         4. A concise list of final reasons for the decision."""),
        ("user",
         "Medical score: {medical_score} | Reasons: {medical_reasons}\n"
         "Financial score: {financial_score} | Reasons: {financial_reasons}\n"
         "Fraud probability: {fraud_probability} | Reasons: {fraud_reasons}\n"
         "Applicant: {applicant}\nPolicy: {policy}")
    ])
    result = (prompt | structured_llm).invoke({
        "medical_score":    state["medical_score"],
        "medical_reasons":  state["medical_reasons"],
        "financial_score":  state["financial_score"],
        "financial_reasons": state["financial_reasons"],
        "fraud_probability": state["fraud_probability"],
        "fraud_reasons":    state["fraud_reasons"],
        "applicant":        state["applicant"],
        "policy":           state["policy"],
    })
    return {
        "composite_risk_score": result.composite_risk_score,
        "ai_decision":          result.ai_decision,
        "suggested_loading":    result.suggested_loading,
        "reasons":              result.reasons,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Graph assembly
# ─────────────────────────────────────────────────────────────────────────────

def _should_continue(state: RiskState) -> str:
    return "medical_scoring" if state["is_valid"] else END


_graph = StateGraph(RiskState)
_graph.add_node("validate_input",   validate_input)
_graph.add_node("medical_scoring",  medical_scoring)
_graph.add_node("financial_scoring", financial_scoring)
_graph.add_node("fraud_detection",  fraud_check)      # node name kept for stream compatibility
_graph.add_node("make_decision",    make_decision)

_graph.add_edge(START, "validate_input")
_graph.add_conditional_edges("validate_input", _should_continue)
_graph.add_edge("medical_scoring",  "financial_scoring")
_graph.add_edge("financial_scoring", "fraud_detection")
_graph.add_edge("fraud_detection",  "make_decision")
_graph.add_edge("make_decision",    END)

_workflow = _graph.compile()


# ─────────────────────────────────────────────────────────────────────────────
# Public entry points
# ─────────────────────────────────────────────────────────────────────────────

def _initial_state(applicant_data: Dict[str, Any], policy_data: Dict[str, Any]) -> RiskState:
    return {
        "applicant":           applicant_data,
        "policy":              policy_data,
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


def run_evaluation(applicant_data: Dict[str, Any], policy_data: Dict[str, Any]) -> Dict[str, Any]:
    return dict(_workflow.invoke(_initial_state(applicant_data, policy_data)))


def stream_evaluation(applicant_data: Dict[str, Any], policy_data: Dict[str, Any]):
    """Yields (node_name, node_data) for each completed node, then ('__done__', full_state)."""
    accumulated = dict(_initial_state(applicant_data, policy_data))
    for update in _workflow.stream(
        _initial_state(applicant_data, policy_data), stream_mode="updates"
    ):
        node_name = list(update.keys())[0]
        node_data = update[node_name]
        accumulated.update(node_data)
        yield node_name, node_data
    yield "__done__", accumulated
