"""Domain-scoped tool loading.

Every tool bound to the model costs input tokens on *every* call of *every*
turn, whether or not the conversation has anything to do with it. With one
flat toolset the schemas were already ~7k tokens per call; adding the
commission and rules-engine tools on top of that would have pushed the fixed
overhead past 10k before a word of conversation.

So the toolset is assembled per turn instead:

    CORE            always bound — navigation, lookup, intake, case handling,
                    the autonomous journey. The things any conversation might
                    reach for.
    DOMAIN packs    bound only when the conversation is actually about them,
                    decided by keyword match over the recent messages plus a
                    sticky carry-over from whatever the last turn used.

This is deliberately NOT a model-driven "load tools for domain X" step: that
would cost an extra round-trip per domain switch, which is the thing we are
trying to avoid. Keyword selection is free and happens before the call.

Safety net: when nothing matches and there is no sticky domain, every pack is
bound — identical to the old behaviour. A missed keyword degrades to "costs
what it used to", never to "the agent cannot do the thing".
"""

from __future__ import annotations

from typing import Iterable

# ── Always bound ─────────────────────────────────────────────────────────────
CORE_TOOLS: set[str] = {
    # navigation & discovery
    "navigate_to_page",
    "show_record",
    "search_records",
    # everyday reads
    "list_customers",
    "list_cases",
    "get_case_details",
    "get_document_checklist",
    "list_artifacts",
    "list_quotes",
    "list_insurance_plans",
    "get_dashboard_stats",
    # intake & case handling — the spine of every conversation
    "add_customer",
    "update_customer",
    # Named in the base prompt's step 1 alongside add_customer, so they have to
    # be bound whenever that instruction is in front of the model.
    "add_organization",
    "add_family_group",
    "create_case",
    "update_case_status",
    "assign_case",
    "add_case_comment",
    "create_proposal",
    "upload_document",
    # guidance & the autonomous pipeline
    "get_workflow_recommendation",
    "quick_start_workflow",
    "start_underwriting_journey",
    "continue_underwriting_journey",
    # The 6 pre-underwriting gates, risk assessment and the policy lifecycle.
    #
    # These are core rather than scoped packs for a correctness reason, not a
    # cost one: the base system prompt walks through the journey step by step
    # and names each of these tools. A prompt that names a tool which is not
    # bound this turn makes the model try to call something that does not
    # exist — which is exactly how Gemini ends up emitting an empty completion.
    # Prompt and toolset have to agree, so anything the journey prompt names
    # stays permanently bound.
    "get_pre_underwriting_status",
    "verify_e_application",
    "submit_agent_confidential_report",
    "run_compliance_screening",
    "override_compliance_screening",
    "process_initial_premium_payment",
    "run_insurance_history_check",
    "assess_medical_examination",
    "run_pre_underwriting_clearance",
    "run_risk_assessment",
    "get_risk_assessment",
    "approve_case",
    "get_pre_issuance_status",
    "run_pre_issuance_verification",
    "issue_policy",
    "confirm_policy_payment",
    "get_active_policy_status",
}

# ── Domain packs ─────────────────────────────────────────────────────────────
DOMAIN_TOOLS: dict[str, set[str]] = {
    "admin": {
        "list_users",
        "add_user",
        "delete_user",
        "list_organizations",
        "list_family_groups",
        "bulk_add_customers",
        "bulk_underwriting_journey",
        "delete_case",
    },
    "rules": {
        "list_rule_categories",
        "list_rule_sets",
        "get_rule_set",
        "evaluate_rule_set",
        "evaluate_rule_scope",
        "get_rule_evaluation_logs",
        "create_rule_set",
        "create_rule_version",
        "add_rule_to_version",
        "update_rule",
        "delete_rule",
        "deploy_rule_version",
        "archive_rule_version",
        "create_rule_category",
        "create_rule_subcategory",
        "create_eligibility_profile",
    },
    "claims": {
        "list_claims",
        "get_claim_details",
        "get_claims_dashboard",
        "get_claim_document_checklist",
        "register_claim",
        "update_claim_status",
        "adjudicate_claim",
        "issue_claim_payout",
        "refer_claim_to_reinsurance",
        "refer_claim_to_underwriting",
        "resolve_claim_underwriting",
        "upload_claim_document",
        "start_claim_journey",
        "continue_claim_journey",
    },
    "commission": {
        "list_commission_payees",
        "get_commission_rate_card",
        "calculate_commission",
        "get_commission_ledger",
        "get_agent_statement",
        "create_payout_run",
        "approve_payout_run",
        "get_commission_summary",
    },
}

# Words that put a conversation into a domain. Generous on purpose — a false
# positive costs a few hundred tokens, a false negative costs a capability.
DOMAIN_KEYWORDS: dict[str, tuple[str, ...]] = {
    "admin": (
        "user", "users", "staff", "team", "role", "underwriter", "organization",
        "organisation", "corporate", "company", "family", "families", "household",
        "bulk", "batch", "delete case", "remove case",
    ),
    "rules": (
        "rule", "rules", "rule set", "ruleset", "rule engine", "criteria",
        "eligibility", "version", "deploy", "draft", "archive", "simulate",
        "simulator", "evaluate rule", "governance", "underwriting rule",
        "catalog", "catalogue", "category", "subcategory",
        # Plain-English terms that map to seeded rule set content
        "nml", "non-medical limit", "non medical limit", "non-medical", "non medical",
        "medical limit", "medical threshold",
        "hlv", "human life value", "over-insurance", "over insurance",
        "sum assured limit", "coverage ceiling",
        "reinsurance rule", "retention rule", "treaty capacity", "treaty rule",
        "facultative", "self-retention",
        "commission rate rule", "secp rate", "rate card rule", "statutory rate",
        "claim rule", "claims rule", "death benefit rule",
        "occupation loading", "occupational hazard", "hazard loading",
        "bmi loading", "smoker loading", "smoking surcharge", "risk loading",
        "ai band", "ai decision band", "risk band", "score band", "decision band",
        "composite score rule", "auto approve rule", "auto-approve",
        "eligibility gate", "policy gate", "gate rule", "pre-underwriting rule",
        "rbac rule", "authorization rule", "role rule", "action role",
        "insurance history rule", "history score", "hlv ceiling",
    ),
    "claims": (
        "claim", "claims", "fnol", "first notice of loss", "notice of loss",
        "claimant", "adjuster", "adjudicate", "adjudication", "settle", "settlement",
        "disburse", "disbursement", "payout on claim", "claim payout",
        "hospitalization", "hospitalisation", "hospital bill", "discharge summary",
        "death claim", "death certificate", "surgery", "reimbursement",
        "incident", "loss date", "triage", "triaged", "investigation",
        "contestability", "contestable", "non-disclosure", "non disclosure",
        "duplicate claim", "re-underwrite", "re-underwriting", "reunderwriting",
        "reinsurance recovery", "recovery referral", "lab test report",
        "claims manager", "claims dashboard", "claim file", "clm-",
    ),
    "commission": (
        "commission", "payout", "payee", "rate card", "brokerage", "override",
        "clawback", "ledger", "statement", "incentive", "bonus", "waterfall",
        "producer", "agent earning", "earnings", "settlement", "treasury",
        "withholding", "wht", "tax deduction", "disburse",
    ),
}


def select_domains(texts: Iterable[str], sticky: Iterable[str] = ()) -> set[str]:
    """Which domain packs this turn needs.

    `texts` is the recent conversation (most recent last); `sticky` is whatever
    the previous turn resolved to, so a multi-step flow keeps its tools even
    once the keyword has scrolled out of the window.

    Returns every domain when nothing matches — see the module docstring.
    """
    blob = " ".join(t for t in texts if t).lower()
    matched = {
        domain
        for domain, words in DOMAIN_KEYWORDS.items()
        if any(word in blob for word in words)
    }
    matched |= {d for d in sticky if d in DOMAIN_TOOLS}
    return matched or set(DOMAIN_TOOLS)


def domain_of(tool_name: str) -> str | None:
    """The pack a tool belongs to, or None for core tools."""
    for domain, names in DOMAIN_TOOLS.items():
        if tool_name in names:
            return domain
    return None


def tool_names_for(domains: Iterable[str]) -> set[str]:
    names = set(CORE_TOOLS)
    for domain in domains:
        names |= DOMAIN_TOOLS.get(domain, set())
    return names


# Registry drift guard: every tool declared in tools.py must be reachable
# through exactly one of CORE_TOOLS or a domain pack, or the model can never
# call it. Verified by test; also cheap enough to assert at import.
def unrouted_tools(all_tool_names: Iterable[str]) -> set[str]:
    routed = set(CORE_TOOLS)
    for names in DOMAIN_TOOLS.values():
        routed |= names
    return set(all_tool_names) - routed
