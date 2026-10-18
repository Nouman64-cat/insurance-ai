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

Safety net: when nothing matches and there is no sticky domain, every pack in
FALLBACK_DOMAINS is bound — identical to the old behaviour. A missed keyword
degrades to "costs what it used to", never to "the agent cannot do the thing".

Packs added after the registry reached the provider's 128-tool cap (see
graph.MAX_BOUND_TOOLS) are keyword-only: binding them on the fallback too would
push a keyword-less turn past the cap. Their keywords are deliberately broad.
"""

from __future__ import annotations

from typing import Iterable

# ── Always bound ─────────────────────────────────────────────────────────────
CORE_TOOLS: set[str] = {
    "search_capabilities", "get_capability_schema", "list_customers",
    # navigation & discovery
    "navigate_to_page",
    "show_record",
    "search_records",
    # everyday reads
    "list_leads",
    "list_cases",
    "get_case_details",
    "get_document_checklist",
    "list_artifacts",
    "list_quotes",
    "list_insurance_plans",
    "get_dashboard_stats",
    # intake & case handling — the spine of every conversation
    "resolve_customer_type",
    "add_customer",
    "update_customer",
    # Named in the base prompt's step 1 alongside add_customer, so they have to
    # be bound whenever that instruction is in front of the model.
    "add_organization",
    "add_family_group",
    "prepare_family_insurance",
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
    # The 5 pre-underwriting gates, risk assessment and the policy lifecycle.
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
    "finance": {"list_finance_payments", "get_finance_dashboard", "get_claim_payment_details", "pay_authorized_claim", "reconcile_finance_claim"},
    "admin": {
        "list_acquisition_sources",
        "list_organizations",
        "list_family_groups",
        "bulk_add_customers",
        "bulk_underwriting_journey",
        "delete_case",
    },
    # User management (Admin). Keyword-only, so it never counts against the no-keyword fallback's tool cap.
    "users": {
        "list_users",
        "add_user",
        "update_user_role",
        "set_user_active",
        "delete_user",
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
    "group": {
        "start_group_journey",
        "continue_group_journey",
        "create_group_scheme",
        "add_group_benefit_class",
        "submit_group_census",
        "upload_group_census",
        "get_group_scheme_status",
        "list_group_members",
        "generate_group_quote",
        "accept_group_quote",
        "decline_group_quote",
        "issue_group_policy",
        "record_group_payment",
        "preview_group_endorsement",
        "apply_group_endorsement",
        "list_group_endorsements",
        "resolve_group_endorsement",
        "settle_group_endorsement",
        "start_group_renewal",
        "get_group_renewal",
        "decide_group_renewal",
        "record_group_renewal_payment",
        "register_group_claim",
        "list_group_claims",
        "preview_group_claim_payout",
        "pay_group_claim",
        "get_group_ptf_report",
        "add_group_class_coverage",
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
        "list_commission_rules",
        "create_commission_rule",
        "update_commission_rule",
        "delete_commission_rule",
        "toggle_commission_rule_active",
        "list_incentive_schemes",
        "create_incentive_scheme",
        "update_incentive_scheme",
        "delete_incentive_scheme",
        "toggle_incentive_scheme_active",
    },
    # Evidence: what is missing, where it goes, and staff review of medical reports.
    "documents": {
        "request_missing_documents",
        "link_document_to_requirement",
        "get_medical_report_status",
        "read_medical_reports",
        "record_medical_review",
    },
    # Recovery and availability: resume a failed step, explain an outage.
    "support": {
        "get_operation_status",
        "resume_operation",
        "get_service_health",
        "diagnose_connection",
    },
    # An issued individual policy: delivery, onboarding, premiums, changes, renewal,
    # reinstatement and exit.
    "servicing": {
        "get_policy_delivery_status",
        "retry_failed_delivery",
        "get_onboarding_status",
        "provision_portal_access",
        "send_portal_invitation",
        "get_premium_schedule",
        "get_payment_receipt",
        "send_premium_reminder",
        "preview_policy_endorsement",
        "submit_policy_endorsement",
        "get_endorsement_status",
        "get_renewal_readiness",
        "preview_policy_renewal",
        "submit_policy_renewal",
        "get_reinstatement_requirements",
        "submit_reinstatement_request",
        "get_reinstatement_status",
        "preview_policy_exit",
        "submit_policy_exit_request",
        "get_exit_status",
    },
    # Request Management and Customer Service.
    "service_desk": {
        "create_service_request",
        "get_service_request",
        "add_request_attachment",
        "submit_service_request",
        "create_support_ticket",
        "get_support_ticket",
        "add_ticket_comment",
        "assign_support_ticket",
    },
    # Exceptions, family/corporate members, queues and histories.
    "workflow": {
        "resolve_insurance_record",
        "preview_application_transition",
        "request_additional_evidence",
        "refer_underwriting_review",
        "get_member_workflow_matrix",
        "resume_member_workflow",
        "get_claim_blockers",
        "get_work_queue",
        "get_workflow_timeline",
    },
    # The 7-step claims-management workflow (claim_workflow_tools.py). Keyword-only:
    # the fallback set is at the provider cap, and every claims keyword binds it.
    "claims_workflow": {
        "get_claim_financial_review",
        "record_claim_financial_check",
        "get_policy_claim_options",
        "get_claim_workflow",
        "intimate_claim",
        "adopt_claim_into_workflow",
        "verify_claim_eligibility",
        "override_claim_eligibility",
        "update_claim_document",
        "record_claim_investigation",
        "assess_claim_benefit",
        "decide_claim",
        "prepare_claim_settlement",
        "verify_claim_payees",
        "authorize_claim_disbursement",
        "disburse_claim_settlement",
        "reconcile_claim_settlement",
        "close_claim_file",
    },
    # Commission agreements, producer splits and accrual exceptions (commission_tools.py).
    # Keyword-only for the same reason; every commission keyword binds it.
    "commission_admin": {
        "deploy_commission_rules",
        "set_producer_start_date",
        "list_payable_commissions",
        "list_payout_runs",

        "get_customer_commission_setup",
        "list_commission_agreements",
        "create_commission_agreement",
        "approve_commission_agreement",
        "get_policy_commission_split",
        "assign_policy_producers",
        "list_commission_exceptions",
        "reconcile_commission_receipts",
        "explain_commission_earning",
    },
    # Pre-proposal profile screening (profile_risk_tools.py). Keyword-only, like the packs above.
    "profile_risk": {
        "run_customer_risk_assessment",
        "get_customer_risk_assessment",
        "assess_customer_risk_profile",
    },
    # Specialist underwriting: the medical and financial reviews and the final compile
    # (specialist_review_tools.py). The specialist agents bind this pack on its own.
    "specialist_review": {
        "record_claim_underwriting_outcome",
        "upload_underwriting_document",
        "waive_underwriting_document",
        "record_claim_underwriting_check",
        "list_my_underwriting_reviews",
        "get_underwriting_review",
        "start_my_review",
        "send_e_application_questionnaire",
        "run_ai_medical_underwriting",
        "run_ai_financial_underwriting",
        "record_underwriting_review",
        "list_track_underwriters",
        "assign_underwriting_track",
        "get_specialist_reviews",
        "compile_final_underwriting",
    },
}

# Bound when no keyword matches and nothing is sticky. Must fit the provider cap
# together with CORE_TOOLS (pinned by test_registries).
FALLBACK_DOMAINS: tuple[str, ...] = ("admin", "rules", "claims", "group", "commission")

# Words that put a conversation into a domain. Generous on purpose — a false
# positive costs a few hundred tokens, a false negative costs a capability.
DOMAIN_KEYWORDS: dict[str, tuple[str, ...]] = {
    "finance": ("finance", "payment history", "reconciliation", "authorised payout", "authorized payout"),
    "admin": (
        "user", "users", "staff", "team", "role", "underwriter", "organization",
        "organisation", "corporate", "company", "family", "families", "household",
        "bulk", "batch", "delete case", "remove case",
        "acquisition", "acquisition source", "broker", "brokers", "bancassurance",
        "lead source", "lead sources",
    ),
    "users": (
        "user", "users", "staff", "team", "teammate", "employee", "colleague", "role", "roles",
        "underwriter", "adjuster", "admin", "login", "sign in", "sign-in", "access",
        "deactivate", "reactivate", "suspend", "promote", "demote", "account", "accounts",
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
    "group": (
        "group life", "group scheme", "group policy", "group policies", "group takaful", "group family",
        "group quote", "group cover", "group insurance", "takaful", "master policy", "master policies",
        "census", "benefit class", "benefit classes", "free cover limit", "fcl", "employer",
        "employees", "wakala", "tabarru", "participants' takaful", "ptf", "certificate of insurance",
        "above the free cover", "salary multiple",
        "endorsement", "endorse", "new joiner", "joiners", "employee left", "employees left", "leaver",
        "add employees", "remove employees", "mid-term", "midterm", "pro rata", "pro-rata",
        "renewal", "renew the scheme", "experience rating", "group claim", "nominee", "payout split", "accidental death", "disability cover",
        "pay continuation", "fee continuation", "credit life", "retakaful", "participants takaful fund",
    ),
    "commission": (
        "commission", "payout", "payee", "rate card", "brokerage", "override",
        "clawback", "ledger", "statement", "incentive", "bonus", "waterfall",
        "producer", "agent earning", "earnings", "settlement", "treasury",
        "withholding", "wht", "tax deduction", "disburse",
        "commission type", "commission rule", "commission rate", "rate card rule",
        "bonus plan", "incentive scheme", "persistency bonus", "production bonus",
        "pay the agent", "pays the agent", "paid to the agent", "agent earn", "agent's pay", "agent get",
    ),
    "documents": (
        "document", "documents", "upload", "uploaded", "missing", "evidence", "requirement",
        "checklist", "resubmi", "re-upload", "reupload", "salary slip", "bank statement",
        "medical report", "medical reports", "lab report", "lab result", "test result", "report",
        "physician", "blood", "lipid", "ecg", "hba1c", "urine", "medical review", "findings",
    ),
    "support": (
        "failed", "fail", "error", "retry", "resume", "interrupted", "where we stopped",
        "where we left", "pick up", "stuck", "operation", "didn't go through", "did not go through",
        "sign in", "signin", "sign-in", "log in", "login", "connect", "connection", "timeout",
        "timed out", "took too long", "unreachable", "unavailable", "server", "health", "outage",
        "down", "not loading", "not opening", "won't open", "won't load", "can't open", "cannot open",
        "network", "customer service", "request management",
    ),
    "servicing": (
        "policy number", "pl-", "his policy", "her policy", "their policy", "the policy", "policyholder",
        "policy holder", "email", "emails", "contact detail", "phone number", "mobile number", "in force", "in-force", "issued policy", "welcome kit", "welcome email", "welcome pack",
        "delivered", "delivery", "emailed", "onboard", "policyholder id", "portal access", "portal account",
        "customer portal", "invitation", "premium", "instalment", "installment", "overdue", "arrears", "grace",
        "receipt", "paid", "reminder", "billing", "endorse", "endorsement", "nominee", "beneficiar", "change the address",
        "change address", "change of address", "sum assured", "rider", "renew", "renewal", "expire", "expiry",
        "reinstat", "lapse", "lapsed", "revive", "restore", "free-look", "free look", "cooling", "cancel the policy",
        "cancel policy", "cancellation", "surrender", "maturity", "exit",
    ),
    "service_desk": (
        "service request", "change request", "request management", "my request", "request status", "req-",
        "correction", "correct the", "ticket", "complaint", "complain", "support", "enquiry", "inquiry",
        "customer service", "escalat", "assign the ticket", "claim the ticket",
    ),
    "workflow": (
        "which record", "which application", "which customer", "transition", "can it move", "move to",
        "send to underwriting", "evidence", "loading", "dispute", "contest", "refer", "review it",
        "member", "members", "family", "household", "employees", "blocked", "blocking", "waiting", "why is",
        "stuck", "queue", "backlog", "aging", "ageing", "oldest", "delayed", "overdue", "sla", "deadline",
        "timeline", "history", "audit trail", "who did", "payouts",
    ),
}
DOMAIN_KEYWORDS["claims_workflow"] = DOMAIN_KEYWORDS["claims"] + (
    "intimat", "eligib", "in force on", "was the policy in force", "covered on", "nominee", "payee", "iban",
    "assess the benefit", "benefit payable", "closure letter", "close the claim", "reconcile the settlement",
    "death benefit", "disability", "accidental death", "hospital", "ex-gratia", "ex gratia",
)
DOMAIN_KEYWORDS["specialist_review"] = (
    "medical review", "financial review", "specialist review", "medical underwriter", "financial underwriter",
    "assign the medical", "assign the financial", "compile", "final underwriting", "my reviews", "my review",
    "ai medical underwriting", "ai financial underwriting", "medical e-application", "financial e-application",
)
DOMAIN_KEYWORDS["profile_risk"] = (
    "risk profile", "profile risk", "risk assessment", "assess risk", "assess the risk", "risk factors",
    "how risky", "risky", "safe factors", "risk score", "risk band",
)
DOMAIN_KEYWORDS["commission_admin"] = DOMAIN_KEYWORDS["commission"] + (
    "agreement", "producer split", "split", "commission exception", "did not post", "didn't post",
    "reconcile commission", "why did i get", "how was my commission", "my commission", "maker-checker",
)



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
    return matched or set(FALLBACK_DOMAINS)


def matched_domains(texts: Iterable[str]) -> list[str]:
    """Domains whose keywords appear in `texts`, without the fallback — in
    DOMAIN_TOOLS order, for prioritising."""
    blob = " ".join(t for t in texts if t).lower()
    return [d for d, words in DOMAIN_KEYWORDS.items() if any(w in blob for w in words)]


def domains_used(tool_names: Iterable[str]) -> list[str]:
    """The packs the given tools belong to (core tools belong to none)."""
    out: list[str] = []
    for name in tool_names:
        d = domain_of(name)
        if d and d not in out:
            out.append(d)
    return out


def fit_to_cap(domains: Iterable[str], priority: Iterable[str], cap: int) -> set[str]:
    """Drop whole packs, least relevant first, until CORE plus the packs fits the
    provider's tool cap. A pack is never half-bound: trimming tool by tool used
    to cut whichever tools happened to sit last in the registry — e.g. every
    servicing tool — and leave the model reaching for a lookalike."""
    domains = set(domains)
    ordered = [d for d in dict.fromkeys(priority) if d in domains]
    ordered += [d for d in DOMAIN_TOOLS if d in domains and d not in ordered]
    chosen: list[str] = []
    for d in ordered:
        if len(tool_names_for([*chosen, d])) <= cap:
            chosen.append(d)
    return set(chosen)


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


# Verified adapters for previously unreachable platform and proposal operations.
from capability_tools import PLATFORM_TOOLS, PROPOSAL_TOOLS
DOMAIN_TOOLS["platform"] = set(PLATFORM_TOOLS)
DOMAIN_TOOLS["proposal_payment"] = set(PROPOSAL_TOOLS)
DOMAIN_KEYWORDS["platform"] = ("tenant", "platform", "llm", "model", "token usage", "global role")
DOMAIN_KEYWORDS["proposal_payment"] = ("initial premium", "payment proof", "payment link", "submit proposal", "proposal review")

# Role operations (role_operations.py): servicing back office, underwriting decisions and desk work.
from role_operations import DOMAINS as _ROLE_OPERATION_DOMAINS, KEYWORDS as _ROLE_OPERATION_KEYWORDS
DOMAIN_TOOLS.update({name: set(tools) for name, tools in _ROLE_OPERATION_DOMAINS.items()})
DOMAIN_KEYWORDS.update(_ROLE_OPERATION_KEYWORDS)
