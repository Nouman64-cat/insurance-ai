"""Regression guard: the group-life journey must not change the existing ones.

Phase 0 of GROUP_LIFE_PLAN.md. The group journey is added to the same
StateGraph as the underwriting (journey.py) and claims (claims_journey.py)
pipelines, and shares graph.py's permission_gate dispatch. These tests pin the
shape of the two existing pipelines — nodes, transitions, launch tools, state
namespaces and resume routing — so wiring in group nodes can't silently
rename, rewire or reroute an individual or claims flow.

Run with:  docker compose exec chat-agent python test_journey_isolation.py
      or:  python -m pytest services/chat-agent/test_journey_isolation.py -q
"""

from __future__ import annotations

import graph
import journey
from state import ChatState

# node -> every node it may hand off to (conditional ends + static edges).
UNDERWRITING_TRANSITIONS = {
    "j_intake": {"j_case", "j_finish"},
    "j_case": {"j_proposal", "j_finish"},
    "j_proposal": {"j_pre_underwriting", "j_finish"},
    "j_pre_underwriting": {"j_audit", "j_finish"},
    "j_audit": {"j_risk", "j_finish"},
    "j_risk": {"j_decide", "j_finish"},
    "j_decide": {"j_close", "j_finish"},
    "j_close": {"j_finish"},
    "j_resume": {"j_intake", "j_pre_underwriting", "j_audit", "j_decide", "j_close"},
    "j_finish": {"agent"},
}

CLAIMS_TRANSITIONS = {
    "c_intake": {"c_triage", "c_finish"},
    "c_triage": {"c_documents", "c_finish"},
    "c_documents": {"c_review", "c_finish"},
    "c_review": {"c_adjudicate", "c_finish"},
    "c_adjudicate": {"c_payout", "c_close", "c_finish"},
    "c_payout": {"c_close", "c_finish"},
    "c_close": {"c_finish"},
    "c_resume": {"c_intake", "c_documents", "c_review", "c_adjudicate", "c_close"},
    "c_finish": {"agent"},
}

UNDERWRITING_STATE_KEYS = {
    "journey_stage", "journey_cnic", "journey_customer_id", "journey_case_id",
    "journey_case_number", "journey_product", "journey_missing_documents",
    "journey_pre_underwriting", "journey_risk", "journey_outcome",
    "requires_human_intervention", "journey_audit", "journey_error",
}

CLAIMS_STATE_KEYS = {
    "claim_stage", "claim_id", "claim_number", "claim_record",
    "claim_missing_documents", "claim_referral_reasons", "claim_decision",
    "claim_payout", "claim_outcome", "requires_claim_intervention",
    "claim_audit", "claim_error", "claim_blocking_actions",
}


def _transitions(node: str) -> set[str]:
    builder = graph._graph_builder
    targets = {dst for src, dst in builder.edges if src == node}
    for spec in builder.branches.get(node, {}).values():
        targets |= set((spec.ends or {}).values())
    return targets


def test_underwriting_journey_shape_unchanged():
    for node, expected in UNDERWRITING_TRANSITIONS.items():
        assert node in graph._graph_builder.nodes, f"{node} missing from graph"
        assert _transitions(node) == expected, f"{node} transitions changed: {_transitions(node)}"


def test_claims_journey_shape_unchanged():
    for node, expected in CLAIMS_TRANSITIONS.items():
        assert node in graph._graph_builder.nodes, f"{node} missing from graph"
        assert _transitions(node) == expected, f"{node} transitions changed: {_transitions(node)}"


def test_journey_launch_tools_unchanged():
    assert graph.JOURNEY_TOOLS == {"start_underwriting_journey", "continue_underwriting_journey"}
    assert graph.CLAIM_JOURNEY_TOOLS == {"start_claim_journey", "continue_claim_journey"}


def test_underwriting_stage_ids_unchanged():
    # The UI's process graph keys off these ids (`stage:<id>`).
    assert [sid for sid, _ in journey.STAGES.values()] == [
        "lead_intake", "case_creation", "proposal_structuring",
        "pre_underwriting_clearance", "document_audit", "risk_assessment",
        "underwriting_decision", "case_closure",
    ]


def test_state_namespaces_present_and_disjoint():
    keys = set(ChatState.__annotations__)
    assert UNDERWRITING_STATE_KEYS <= keys
    assert CLAIMS_STATE_KEYS <= keys
    # Any group-journey key must live in its own `group_` namespace.
    group_keys = {k for k in keys if k.startswith("group_")}
    assert not group_keys & (UNDERWRITING_STATE_KEYS | CLAIMS_STATE_KEYS)


def test_underwriting_resume_routing_unchanged():
    route = journey.route_resume
    assert route({"journey_outcome": "Approved"}) == "j_close"
    assert route({"journey_outcome": "Rejected"}) == "j_close"
    assert route({"journey_missing_documents": ["CNIC"]}) == "j_audit"
    assert route({"requires_human_intervention": True}) == "j_decide"
    assert route({}) == "j_intake"
    assert route({"journey_case_id": "c1"}) == "j_pre_underwriting"
    assert route({"journey_case_id": "c1", "journey_pre_underwriting": {"ok": True}}) == "j_audit"


def test_underwriting_suspension_routing_unchanged():
    assert journey.route_after_audit({"journey_missing_documents": ["CNIC"]}) == "j_finish"
    assert journey.route_after_audit({}) == "j_risk"
    assert journey.route_after_decide({"requires_human_intervention": True}) == "j_finish"
    assert journey.route_after_decide({}) == "j_close"
    assert journey.route_error("j_case")({"journey_error": "boom"}) == "j_finish"


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        fn()
        print(f"PASS {name}")
