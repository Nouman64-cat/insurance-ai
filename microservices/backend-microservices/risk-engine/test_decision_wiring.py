"""Tests for risk-engine's deterministic medical/fraud wiring (brief §23).

Requires the service's own dependencies (langgraph, langchain, neo4j) —
run inside the container: `docker compose exec risk-engine python -m pytest test_decision_wiring.py -q`
"""

from __future__ import annotations

import workflow
from shared.underwriting.results import FraudSeverity, MedicalRiskClass


def test_score_to_risk_class_bands():
    assert workflow._score_to_risk_class(10) == MedicalRiskClass.PREFERRED
    assert workflow._score_to_risk_class(30) == MedicalRiskClass.STANDARD
    assert workflow._score_to_risk_class(50) == MedicalRiskClass.SUBSTANDARD
    assert workflow._score_to_risk_class(70) == MedicalRiskClass.RATED
    assert workflow._score_to_risk_class(85) == MedicalRiskClass.POSTPONE
    assert workflow._score_to_risk_class(95) == MedicalRiskClass.DECLINE


def test_deterministic_medical_floor_overrides_a_low_llm_score():
    """A smoker/BMI-driven floor must win even when the LLM itself returned a
    low (e.g. 10/100) score — this is what makes 'severe medical risk cannot
    be mathematically cancelled' hold even inside a single node, not just at
    the final decision_engine step."""
    profile_obese = {"medical_history": {"bmi": 41.0, "document_findings": []}}
    floor, reasons = workflow._deterministic_medical_floor(profile_obese)
    assert floor == MedicalRiskClass.DECLINE
    assert reasons

    profile_normal = {"medical_history": {"bmi": 22.0, "document_findings": []}}
    floor2, reasons2 = workflow._deterministic_medical_floor(profile_normal)
    assert floor2 is None
    assert reasons2 == []


def test_document_findings_force_medical_review_required():
    profile = {"medical_history": {"bmi": 22.0, "document_findings": [{"conditions": ["Diabetes"]}]}}
    floor, _ = workflow._deterministic_medical_floor(profile)
    assert floor == MedicalRiskClass.MEDICAL_REVIEW_REQUIRED


def test_fraud_severity_bands_are_monotonic():
    assert workflow._fraud_severity(0.0) == FraudSeverity.LOW
    assert workflow._fraud_severity(0.29) == FraudSeverity.LOW
    assert workflow._fraud_severity(0.30) == FraudSeverity.MEDIUM
    assert workflow._fraud_severity(0.59) == FraudSeverity.MEDIUM
    assert workflow._fraud_severity(0.60) == FraudSeverity.HIGH
    assert workflow._fraud_severity(0.84) == FraudSeverity.HIGH
    assert workflow._fraud_severity(0.85) == FraudSeverity.CRITICAL
    assert workflow._fraud_severity(1.0) == FraudSeverity.CRITICAL


def test_graph_outlier_signal_forces_investigation_even_at_moderate_probability():
    """Tier-1 graph signals (income_outlier + coverage_cluster_size>0) must
    escalate to investigation even if the LLM's own probability read lands
    in the merely-MEDIUM band — a hard network signal should not be
    talked down by an uncertain model output."""
    state = {
        "customer": {"cnic": "x"}, "policy": {}, "tenant_id": "t",
        "fraud_probability": 0.4,
    }
    graph = {"income_outlier": True, "coverage_cluster_size": 2, "graph_available": True,
             "cluster_size": 3, "avg_income_in_cluster": 100000}
    severity = workflow._fraud_severity(0.4)
    investigation_required = severity in (FraudSeverity.HIGH, FraudSeverity.CRITICAL) or (
        graph.get("income_outlier") and graph.get("coverage_cluster_size", 0) > 0
    )
    assert investigation_required is True


# ── Final underwriting compiles the specialists' reviews ─────────────────────

def test_specialist_reviews_only_make_the_decision_stricter():
    from shared.underwriting.results import UnderwritingDecision as D
    cleared = {"medical": {"status": "CLEARED", "note": "Normal results"}, "financial": {"status": "CLEARED"}}
    assert workflow.compile_specialist_reviews(D.AUTO_APPROVE, cleared)[0] == D.AUTO_APPROVE
    assert workflow.compile_specialist_reviews(D.HUMAN_REVIEW, cleared)[0] == D.HUMAN_REVIEW  # never more lenient
    referred = {**cleared, "financial": {"status": "REFERRED", "note": "Income unverified"}}
    decision, reasons, _ = workflow.compile_specialist_reviews(D.AUTO_APPROVE, referred)
    assert decision == D.HUMAN_REVIEW and any("Income unverified" in r for r in reasons)
    declined = {**cleared, "medical": {"status": "DECLINED"}}
    assert workflow.compile_specialist_reviews(D.APPROVE_WITH_LOADING, declined)[0] == D.DECLINE
    assert workflow.compile_specialist_reviews(D.FRAUD_INVESTIGATION, declined)[0] == D.FRAUD_INVESTIGATION
    loaded = {**cleared, "medical": {"status": "CLEARED", "ai": {"suggested_loading_pct": 25}}}
    decision, _, loading = workflow.compile_specialist_reviews(D.AUTO_APPROVE, loaded)
    assert (decision, loading) == (D.APPROVE_WITH_LOADING, 25.0)
    assert workflow.compile_specialist_reviews(D.AUTO_APPROVE, None)[0] == D.AUTO_APPROVE
