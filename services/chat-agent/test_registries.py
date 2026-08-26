"""Registry and permission invariants for the chat agent.

Adding a tool means touching five registries (tools.ALL_TOOLS, a
tool_executor handler, permission's MUTATING/SAFE split, STEP_LABELS, and a
toolsets pack). Missing one used to fail open — RBAC ended in `return True`
and Underwriter was a deny-list, so a newly declared tool was granted to
everyone until somebody noticed.

These tests make each of those a hard failure instead.

Run with:  python -m pytest services/chat-agent/test_registries.py -q
"""

from __future__ import annotations

import pytest

import permission
import toolsets
from permission import (
    ADMIN_ONLY_TOOLS,
    MUTATING_TOOLS,
    SAFE_TOOLS,
    STEP_LABELS,
    is_role_allowed,
)
from tool_executor import _HANDLERS
from tools import ALL_TOOLS

TOOL_NAMES = sorted(t.name for t in ALL_TOOLS)
ROLES = ["SuperAdmin", "Admin", "Underwriter", "Agent", "Viewer"]

# Executed by the browser or routed by the graph rather than by a handler.
CLIENT_EXECUTED = {"upload_document"}
GRAPH_ROUTED = {
    "start_underwriting_journey", "continue_underwriting_journey",
    "start_claim_journey", "continue_claim_journey",
}


def test_every_tool_has_an_executor():
    missing = [n for n in TOOL_NAMES if n not in _HANDLERS and n not in CLIENT_EXECUTED | GRAPH_ROUTED]
    assert not missing, f"Declared with no way to execute them: {missing}"


def test_every_tool_is_classified_safe_or_mutating():
    """The classification drives whether a confirmation is required. An
    unclassified tool silently skips its confirmation prompt."""
    unclassified = [n for n in TOOL_NAMES if n not in SAFE_TOOLS and n not in MUTATING_TOOLS]
    assert not unclassified, f"Neither SAFE nor MUTATING: {unclassified}"


def test_no_tool_is_both_safe_and_mutating():
    both = sorted(SAFE_TOOLS & MUTATING_TOOLS)
    assert not both, f"Classified as both SAFE and MUTATING: {both}"


def test_every_tool_is_routed_to_a_toolset():
    """A tool in no pack is never bound to the model, so it can never fire."""
    unrouted = toolsets.unrouted_tools(TOOL_NAMES)
    assert not unrouted, f"In no CORE/domain pack, so unreachable: {sorted(unrouted)}"


def test_no_pack_references_an_undeclared_tool():
    routed = set(toolsets.CORE_TOOLS)
    for names in toolsets.DOMAIN_TOOLS.values():
        routed |= names
    ghosts = sorted(routed - set(TOOL_NAMES))
    assert not ghosts, f"Routed but not declared in ALL_TOOLS: {ghosts}"


def test_every_tool_has_a_step_label():
    """Without one the UI shows a raw snake_case tool name mid-conversation."""
    missing = [n for n in TOOL_NAMES if n not in STEP_LABELS]
    assert not missing, f"No STEP_LABELS entry: {missing}"


# ── RBAC ─────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("tool_name", TOOL_NAMES)
def test_viewer_can_never_mutate(tool_name):
    if tool_name in MUTATING_TOOLS:
        assert not is_role_allowed(tool_name, "Viewer"), f"Viewer may run mutating {tool_name}"


@pytest.mark.parametrize("tool_name", TOOL_NAMES)
def test_unknown_role_gets_read_only(tool_name):
    """The old implementation ended in `return True`, so an unrecognised role
    was granted every non-mutating tool and any tool missing from the
    registries. It must fail closed instead."""
    allowed = is_role_allowed(tool_name, "SomeRoleNobodyDefined")
    if tool_name not in SAFE_TOOLS:
        assert not allowed, f"Unknown role may run {tool_name}"


@pytest.mark.parametrize("tool_name", sorted(ADMIN_ONLY_TOOLS))
def test_admin_only_tools_are_denied_to_underwriter(tool_name):
    assert not is_role_allowed(tool_name, "Underwriter"), f"Underwriter may run admin-only {tool_name}"


@pytest.mark.parametrize("tool_name", sorted(ADMIN_ONLY_TOOLS))
def test_admin_only_tools_are_denied_to_agent(tool_name):
    assert not is_role_allowed(tool_name, "Agent"), f"Agent may run admin-only {tool_name}"


def test_claims_money_movement_needs_a_manager():
    """Disbursement and reinsurance recovery are the two claims actions that
    move money or bind the reinsurer — an adjuster prepares them, a manager
    releases them."""
    for tool_name in permission.CLAIMS_MANAGER_ONLY_TOOLS:
        assert not is_role_allowed(tool_name, "ClaimsAdjuster"), f"Adjuster may run {tool_name}"
        assert is_role_allowed(tool_name, "ClaimsManager"), f"Manager cannot run {tool_name}"


def test_claims_roles_cannot_reach_underwriting_or_governance():
    """A claims desk is not an underwriting desk: the claims roles read cases
    but must not decide them, issue policies, or touch the rule engine."""
    forbidden = {
        "run_risk_assessment", "approve_case", "issue_policy", "confirm_policy_payment",
        "update_case_status", "deploy_rule_version", "create_rule_set", "add_user",
        "create_payout_run", "start_underwriting_journey",
    }
    for role in ("ClaimsAdjuster", "ClaimsManager"):
        for tool_name in forbidden:
            assert not is_role_allowed(tool_name, role), f"{role} may run {tool_name}"


def test_underwriter_rules_on_referrals_but_does_not_adjudicate():
    """The underwriter's half of the claims workflow is the re-underwriting
    verdict — not the adjudication, the FNOL, or the money."""
    assert is_role_allowed("resolve_claim_underwriting", "Underwriter")
    for tool_name in ("adjudicate_claim", "register_claim", "issue_claim_payout"):
        assert not is_role_allowed(tool_name, "Underwriter"), f"Underwriter may run {tool_name}"


def test_governance_tools_are_admin_only():
    """Deploying a rule version changes underwriting for every later case;
    approving a payout run moves money. Neither belongs to a non-admin."""
    for tool_name in ("deploy_rule_version", "archive_rule_version",
                      "create_payout_run", "approve_payout_run"):
        for role in ("Underwriter", "Agent", "Viewer"):
            assert not is_role_allowed(tool_name, role), f"{role} may run {tool_name}"


def test_mobile_agent_stops_at_the_medical_exam_gate():
    """The field app covers onboarding through Gate 6; everything downstream
    is web-portal only."""
    for tool_name in permission.MOBILE_PORTAL_ONLY_TOOLS:
        assert not is_role_allowed(tool_name, "Agent", "mobile"), f"Mobile agent may run {tool_name}"


def test_admin_can_run_everything_declared():
    denied = [n for n in TOOL_NAMES if not is_role_allowed(n, "Admin")]
    assert not denied, f"Admin denied: {denied}"


# ── Domain selection ─────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "text,expected",
    [
        ("show me the commission ledger", "commission"),
        ("what does this policy pay the agent?", "commission"),
        ("deploy the draft rule version", "rules"),
        ("simulate the NML rule set", "rules"),
        ("add a new underwriter user", "admin"),
        ("register an FNOL for this policy", "claims"),
        ("adjudicate the hospitalization claim", "claims"),
        ("settle claim CLM-2026-0001", "claims"),
    ],
)
def test_domain_keywords_route_correctly(text, expected):
    assert expected in toolsets.select_domains([text])


def test_journey_tools_are_never_scoped_away():
    """The base system prompt walks the journey and names these tools by name.
    A prompt naming an unbound tool makes the model call something that isn't
    there, so every one of them must live in CORE, not in a domain pack."""
    named_in_journey_prompt = {
        "add_customer", "create_case", "create_proposal",
        "verify_e_application", "submit_agent_confidential_report",
        "run_compliance_screening", "process_initial_premium_payment",
        "run_insurance_history_check", "assess_medical_examination",
        "get_pre_underwriting_status", "get_document_checklist", "upload_document",
        "run_risk_assessment", "approve_case", "get_pre_issuance_status",
        "run_pre_issuance_verification", "issue_policy", "confirm_policy_payment",
        "get_active_policy_status", "navigate_to_page", "show_record",
        "search_records", "start_underwriting_journey", "continue_underwriting_journey",
        "quick_start_workflow", "add_organization", "add_family_group",
    }
    scoped_away = sorted(named_in_journey_prompt - toolsets.CORE_TOOLS)
    assert not scoped_away, f"Named in the base prompt but only in a domain pack: {scoped_away}"


def test_domain_prompt_sections_only_name_bound_tools():
    """Same invariant from the other side: a DOMAIN_PROMPTS section may only
    reference tools that ship in its own pack (or core)."""
    import re
    import graph

    for domain, text in graph.DOMAIN_PROMPTS.items():
        available = toolsets.tool_names_for([domain])
        mentioned = set(re.findall(r"\*\*([a-z_]+)\*\*", text)) & set(TOOL_NAMES)
        stray = sorted(mentioned - available)
        assert not stray, f"{domain} prompt names tools not in its pack: {stray}"


def test_unmatched_conversation_falls_back_to_every_domain():
    """A missed keyword must degrade to 'costs what it used to', never to
    'the agent has lost the capability'."""
    assert toolsets.select_domains(["hello there"]) == set(toolsets.DOMAIN_TOOLS)


def test_sticky_domain_survives_a_keywordless_turn():
    assert "commission" in toolsets.select_domains(["yes please"], sticky=["commission"])


def test_core_is_always_bound():
    for domain in toolsets.DOMAIN_TOOLS:
        assert toolsets.CORE_TOOLS <= toolsets.tool_names_for([domain])
