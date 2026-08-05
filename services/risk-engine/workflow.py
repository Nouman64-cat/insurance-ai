from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

from langchain_core.prompts import ChatPromptTemplate
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import END, START, StateGraph
from neo4j import GraphDatabase
from neo4j import exceptions as neo4j_exc
from pydantic import BaseModel, Field
from typing_extensions import TypedDict

from underwriting_rules import check_plan_rules

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
    is_valid: bool
    validation_errors: List[str]
    medical_score: int
    medical_reasons: List[Any]
    financial_score: int
    financial_reasons: List[Any]
    fraud_probability: float
    fraud_reasons: List[Any]
    composite_risk_score: int
    ai_decision: str
    suggested_loading: Optional[float]
    reasons: List[Any]


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


# ─────────────────────────────────────────────────────────────────────────────
# Graph nodes
# ─────────────────────────────────────────────────────────────────────────────

def validate_input(state: RiskState) -> Dict[str, Any]:
    customer = state["customer"]
    policy = state["policy"]

    is_valid, errors = check_plan_rules(policy.get("insurance_type"), customer, policy)

    return {"is_valid": is_valid, "validation_errors": errors}


def medical_scoring(state: RiskState) -> Dict[str, Any]:
    customer = state["customer"]
    e_app = state.get("e_application")
    structured_llm = _llm().with_structured_output(MedicalScoreOutput)
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
    result = (prompt | structured_llm).invoke({"customer": customer, "e_app": e_app or "None provided"})
    medical_reasons = [r.dict() for r in result.medical_reasons]
    return {"medical_score": result.medical_score, "medical_reasons": medical_reasons}


def financial_scoring(state: RiskState) -> Dict[str, Any]:
    customer = state["customer"]
    policy = state["policy"]
    acr = state.get("acr")
    structured_llm = _llm().with_structured_output(FinancialScoreOutput)
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
    result = (prompt | structured_llm).invoke({"customer": customer, "policy": policy, "acr": acr or "None provided"})
    financial_reasons = [r.dict() for r in result.financial_reasons]
    return {"financial_score": result.financial_score, "financial_reasons": financial_reasons}


# ─────────────────────────────────────────────────────────────────────────────
# Fraud detection — Memgraph ring query + Gemini evaluation
# ─────────────────────────────────────────────────────────────────────────────

# Detects two classes of fraud signal from the relationships built up by
# graph_writer.py after each evaluation (SAME_AREA and SAME_OCCUPATION_CLUSTER):
#
#   1. Income-outlier ring — an customer whose declared income wildly exceeds
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
MATCH (a:Customer {cnic: $cnic, tenant_id: $tenant_id})
OPTIONAL MATCH (a)-[:SAME_AREA]->(neighbour:Customer)-[:SAME_OCCUPATION_CLUSTER]->(a)
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
MATCH (a:Customer {cnic: $cnic, tenant_id: $tenant_id})
OPTIONAL MATCH (a)-[:SAME_OCCUPATION_CLUSTER]->(peer:Customer)
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
    customer = state["customer"]
    policy    = state["policy"]
    cnic      = customer["cnic"]
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

    comp_screening = state.get("compliance_screening")

    # ── 3. LLM evaluation with Gemini ─────────────────────────────────────────
    structured_llm = _llm().with_structured_output(FraudScoreOutput)

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

    result = (prompt | structured_llm).invoke({
        "customer":       customer,
        "policy":          policy,
        "comp_screening":  comp_screening or "None provided",
        "graph_summary":   graph_summary,
    })

    fraud_reasons = [r.dict() for r in result.fraud_reasons]
    return {
        "fraud_probability": result.fraud_probability,
        "fraud_reasons":     fraud_reasons,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Decision aggregation — deterministic, no LLM
# ─────────────────────────────────────────────────────────────────────────────

# Actuarial decision bands
#   Auto Approve         → composite < 30  AND  fraud < 0.10  (clean profile, low risk)
#   Decline              → composite > 75  OR   fraud > 0.60  (either is disqualifying)
#   Approve with Loading → composite 30–49 AND  fraud < 0.10  (ratable — sub-standard
#                          but writable at an extra premium)
#   Human Review         → everything else                    (needs underwriter eyes)

# Extra-mortality loading for the ratable band, as a % on the base premium.
# (lower_bound_composite, loading_pct) — the highest band the score reaches wins.
# Deliberately coarse and explainable rather than a continuous curve: an
# underwriter has to be able to justify the number to the customer.
_LOADING_BANDS: List[tuple] = [
    (30, 25.0),
    (40, 50.0),
    (50, 75.0),
    (60, 100.0),
]


def _suggested_loading(composite_risk_score: int) -> Optional[float]:
    """Extra-mortality loading implied by a composite score, or None if standard.

    Read by the whole downstream chain — the RiskAssessment row, the issuance
    price (tenant-service routers/policies.py::_effective_loading_pct) and the
    reinsurance referral. Before this existed, decision_aggregation never
    returned a loading at all, so RiskAssessment.suggested_loading was always
    NULL and every contract priced at standard rates no matter the risk.
    """
    applicable = [pct for lower, pct in _LOADING_BANDS if composite_risk_score >= lower]
    return applicable[-1] if applicable else None


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
    suggested_loading: Optional[float] = None
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
    elif composite_risk_score < 50 and fraud_probability < 0.10:
        # Sub-standard but ratable — writable at an extra premium rather than
        # occupying an underwriter. The loading travels with the decision so the
        # issuance price actually reflects it.
        suggested_loading = _suggested_loading(composite_risk_score)
        ai_decision = "Approve with Loading"
        band_rationale = (
            f"composite {composite_risk_score} falls in the 30–49 ratable band "
            f"(fraud: {fraud_probability:.2f}) → +{suggested_loading:g}% extra mortality"
        )
    else:
        # Still surface an indicative loading so an underwriter who approves this
        # case manually inherits a priced rating rather than standard rates.
        suggested_loading = _suggested_loading(composite_risk_score)
        ai_decision = "Human Review"
        band_rationale = (
            f"composite {composite_risk_score} falls in the 30–75 review band "
            f"(fraud: {fraud_probability:.2f})"
        )

    # ── 4. XAI reasons — all node outputs + mathematical breakdown ────────────
    math_breakdown = {
        "parameter": "Composite Logic",
        "risk_rating": "Info",
        "observation": (
            f"Composite score {composite_risk_score}/100 = "
            f"(40% × medical {medical_score}) + "
            f"(40% × financial {financial_score}) + "
            f"(20% × fraud {fraud_scaled:.0f}) → "
            f"{band_rationale} → decision: '{ai_decision}'"
        )
    }

    reasons = [*medical_reasons, *financial_reasons, *fraud_reasons, math_breakdown]
    if suggested_loading:
        reasons.append({
            "parameter": "Suggested Loading",
            "risk_rating": "Info",
            "observation": (
                f"Composite {composite_risk_score} maps to an extra-mortality "
                f"loading of +{suggested_loading:g}% on the base premium."
            ),
        })

    return {
        "composite_risk_score": composite_risk_score,
        "ai_decision":          ai_decision,
        "suggested_loading":    suggested_loading,
        "reasons":              reasons,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Graph assembly
# ─────────────────────────────────────────────────────────────────────────────

def _should_continue(state: RiskState) -> list[str]:
    return ["medical_scoring", "financial_scoring", "fraud_detection"] if state["is_valid"] else [END]


_graph = StateGraph(RiskState)
_graph.add_node("validate_input",      validate_input)
_graph.add_node("medical_scoring",     medical_scoring)
_graph.add_node("financial_scoring",   financial_scoring)
_graph.add_node("fraud_detection",     fraud_check)
_graph.add_node("decision_aggregation", decision_aggregation)

_graph.add_edge(START, "validate_input")
_graph.add_conditional_edges("validate_input", _should_continue)
_graph.add_edge(["medical_scoring", "financial_scoring", "fraud_detection"], "decision_aggregation")
_graph.add_edge("decision_aggregation", END)

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
) -> RiskState:
    return {
        "customer":           customer_data,
        "policy":              policy_data,
        "tenant_id":           tenant_id,
        "e_application":       e_application,
        "acr":                 acr,
        "compliance_screening": compliance_screening,
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
    customer_data: Dict[str, Any],
    policy_data: Dict[str, Any],
    tenant_id: str = "",
    e_application: Optional[Dict[str, Any]] = None,
    acr: Optional[Dict[str, Any]] = None,
    compliance_screening: Optional[Any] = None,
) -> Dict[str, Any]:
    init_st = _initial_state(customer_data, policy_data, tenant_id, e_application, acr, compliance_screening)
    return dict(_workflow.invoke(init_st))


def stream_evaluation(
    customer_data: Dict[str, Any],
    policy_data: Dict[str, Any],
    tenant_id: str = "",
    e_application: Optional[Dict[str, Any]] = None,
    acr: Optional[Dict[str, Any]] = None,
    compliance_screening: Optional[Any] = None,
):
    """Yields (node_name, node_data) for each completed node, then ('__done__', full_state)."""
    init_st = _initial_state(customer_data, policy_data, tenant_id, e_application, acr, compliance_screening)
    accumulated = dict(init_st)
    for update in _workflow.stream(init_st, stream_mode="updates"):
        node_name = list(update.keys())[0]
        node_data = update[node_name]
        accumulated.update(node_data)
        yield node_name, node_data
    yield "__done__", accumulated
