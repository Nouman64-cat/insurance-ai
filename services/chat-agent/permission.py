"""Static permission/validation rules for tool calls — enforced in code, not prompts.

Mirrors the role restriction that used to live only in the frontend's system
prompt (frontend/app/api/chat/route.ts:35-37) and the "ask before executing"
instruction that used to be prose-only (route.ts:10) — both are now hard gates
the graph checks before a tool ever runs.
"""

MUTATING_TOOLS = {
    "add_customer",
    "update_customer",
    "delete_customer",
    "bulk_add_customers",
    "add_user",
    "delete_user",
    "add_organization",
    "add_family_group",
    "create_case",
    "update_case_status",
    "assign_case",
    "add_case_comment",
    "delete_case",
    "create_proposal",
    "upload_document",
    "run_risk_assessment",
    "quick_start_workflow",
    # Pre-underwriting (the 6 gates)
    "verify_e_application",
    "submit_agent_confidential_report",
    "run_compliance_screening",
    "override_compliance_screening",
    "process_initial_premium_payment",
    "run_insurance_history_check",
    "assess_medical_examination",
    "run_pre_underwriting_clearance",
    # Policy lifecycle (steps 5–7)
    "approve_case",
    "run_pre_issuance_verification",
    "issue_policy",
    "confirm_policy_payment",
    # One confirmation buys the whole autonomous pipeline — that's the point.
    # (continue_underwriting_journey is deliberately NOT here: the journey was
    # already consented to at start; resuming it shouldn't re-prompt.)
    "start_underwriting_journey",
    "bulk_underwriting_journey",
    # Rules engine — authoring is safe-ish, deploying changes underwriting
    # behaviour for every case evaluated afterwards.
    "create_rule_set",
    "create_rule_version",
    "add_rule_to_version",
    "update_rule",
    "delete_rule",
    "deploy_rule_version",
    "archive_rule_version",
    # Rules catalogue — adding a governance level is structural, not destructive,
    # but it changes what every rule-set picker offers from then on.
    "create_rule_category",
    "create_rule_subcategory",
    "create_eligibility_profile",
    # Claims — adjudication decides whether a policyholder is paid, and
    # issue_claim_payout literally moves money out the door.
    "register_claim",
    "update_claim_status",
    "adjudicate_claim",
    "issue_claim_payout",
    "refer_claim_to_reinsurance",
    "refer_claim_to_underwriting",
    "resolve_claim_underwriting",
    "upload_claim_document",
    # One confirmation buys the whole autonomous claims pipeline, exactly as
    # start_underwriting_journey does. (continue_claim_journey is deliberately
    # NOT here — the journey was already consented to at start.)
    "start_claim_journey",
    # Commission — payout runs move money.
    "create_payout_run",
    "approve_payout_run",
}

# Read-only + navigation. Never gated, never confirmed — asking "shall I open
# the cases page?" before every navigation makes the agent unusable.
SAFE_TOOLS = {
    "navigate_to_page",
    "show_record",
    "search_records",
    "list_customers",
    "list_cases",
    "get_case_details",
    "get_document_checklist",
    "list_artifacts",
    "list_users",
    "list_organizations",
    "list_family_groups",
    "list_quotes",
    "list_insurance_plans",
    "get_risk_assessment",
    "get_dashboard_stats",
    "get_workflow_recommendation",
    "continue_underwriting_journey",
    # Pre-underwriting (read-only)
    "get_pre_underwriting_status",
    # Policy lifecycle (read-only)
    "get_pre_issuance_status",
    "get_active_policy_status",
    # Rules engine (read-only). evaluate_* are dry runs — they change nothing,
    # they only report what the rulebook would decide.
    "list_rule_categories",
    "list_rule_sets",
    "get_rule_set",
    "evaluate_rule_set",
    "evaluate_rule_scope",
    "get_rule_evaluation_logs",
    # Claims (read-only)
    "list_claims",
    "get_claim_details",
    "get_claims_dashboard",
    "get_claim_document_checklist",
    "continue_claim_journey",
    # Commission (read-only)
    "list_commission_payees",
    "get_commission_rate_card",
    "calculate_commission",
    "get_commission_ledger",
    "get_agent_statement",
    "get_commission_summary",
}

# Destructive enough that the confirmation prompt names the record explicitly
# rather than the generic "Ready to <tool name> — proceed?".
DESTRUCTIVE_TOOLS = {"delete_customer", "delete_user", "delete_case", "delete_rule"}

ADMIN_ROLES = {"SuperAdmin", "Admin"}

# Tools whose execution needs a real file the browser already has in memory
# (an attached File object) — chat-agent has no way to receive that over a
# JSON tool-call, so these are executed client-side after the user confirms,
# not by tool_executor.py.
# NOTE: upload_claim_document is deliberately NOT here. This set short-circuits
# straight to the browser *before* the handler runs, which is right for
# upload_document (the case is resolved browser-side from the CNIC) but wrong
# for a claim: the browser has no way to turn "Ahmed's claim" into a claim id.
# Its handler resolves the claim server-side and then returns the
# __client_execute__ marker, which permission_gate honours after execution — so
# the file picker opens with a real claim_id already in hand.
CLIENT_EXECUTED_TOOLS = {"upload_document"}

# Required args per tool — missing any of these triggers a "clarify" interrupt
# instead of letting the model invent a value. Deliberately excludes fields
# that are optional/inferable (e.g. create_case's applicant lookup, which can
# proceed on cnic OR applicant_name).
REQUIRED_ARGS: dict[str, list[str]] = {
    "add_customer": [
        "first_name", "last_name", "cnic", "date_of_birth",
        "gender", "occupation", "declared_income",
    ],
    "add_user": ["full_name", "email", "role_name"],
    "add_organization": ["name"],
    "add_family_group": ["name"],
    "bulk_add_customers": ["customers_json"],
    "upload_document": ["document_type"],
    "show_record": ["record_type", "identifier"],
    "search_records": ["query"],
    "update_case_status": ["new_status"],
    "assign_case": ["assigned_user_name"],
    "add_case_comment": ["comment_text"],
    "navigate_to_page": ["page_name"],
    # Rules engine — guard against the model calling authoring tools with no args.
    # The clarify-interrupt is friendlier than a raw 422 from the API.
    # Note: create_rule_set is NOT here — permission_gate has a dedicated interceptor
    # that fetches live categories and presents them as clickable chips before executing.
    # Only the rule set is a hard prerequisite — graph.py's dedicated
    # add_rule_to_version interceptor resolves the rule content (code, name,
    # conditions, outcome) with template chips before this ever fires, so a
    # generic "missing rule_code, name, priority, conditions_json,
    # action_outcome" field-dump is never what the user sees.
    "add_rule_to_version": ["rule_set_code"],
    "deploy_rule_version": ["rule_set_code"],
    "archive_rule_version": ["rule_set_code"],
    "get_rule_set": ["rule_set_code"],
    "evaluate_rule_set": ["rule_set_code"],
    "create_rule_category": ["name"],
    "create_rule_subcategory": ["category_code", "name"],
    "create_eligibility_profile": ["category_code", "subcategory_code", "channel_code"],
    # Claims. Deliberately minimal: every claims tool resolves the claim from a
    # number OR a claimant name, and the handlers answer a missing decision /
    # amount / claim type with clickable chips of their own — a clarify
    # interrupt asking the user to *type* one of those would be a regression on
    # exactly the thing this flow is for. Only upload_claim_document, whose
    # document_type the browser genuinely cannot guess, is required here.
    "upload_claim_document": ["document_type"],
}

# Tools that emit progress steps worth showing in the UI's process graph, with
# the label each step gets. Everything else falls back to a humanised tool name.
STEP_LABELS: dict[str, str] = {
    "add_customer": "Registering customer",
    "update_customer": "Updating customer",
    "delete_customer": "Deleting customer",
    "bulk_add_customers": "Adding customers in bulk",
    "add_user": "Creating user",
    "delete_user": "Removing user",
    "add_organization": "Creating organization",
    "add_family_group": "Creating family group",
    "create_case": "Opening case",
    "update_case_status": "Updating case status",
    "assign_case": "Assigning case",
    "add_case_comment": "Adding comment",
    "delete_case": "Deleting case",
    "create_proposal": "Building proposal",
    "upload_document": "Uploading document",
    "run_risk_assessment": "Running AI risk assessment",
    "navigate_to_page": "Navigating",
    "show_record": "Locating record",
    "search_records": "Searching",
    "list_customers": "Fetching customers",
    "list_cases": "Fetching cases",
    "get_case_details": "Loading case details",
    "get_document_checklist": "Checking documents",
    "list_artifacts": "Fetching documents",
    "list_users": "Fetching users",
    "list_organizations": "Fetching organizations",
    "list_family_groups": "Fetching family groups",
    "list_quotes": "Fetching quotations",
    "list_insurance_plans": "Fetching plans",
    "get_risk_assessment": "Loading assessment",
    "get_dashboard_stats": "Loading metrics",
    "get_workflow_recommendation": "Planning next step",
    "quick_start_workflow": "Generating demo data",
    "start_underwriting_journey": "Launching autonomous underwriting journey",
    "continue_underwriting_journey": "Resuming underwriting journey",
    "bulk_underwriting_journey": "Running bulk underwriting journey",
    # Pre-underwriting (the 6 gates)
    "get_pre_underwriting_status": "Checking pre-underwriting gates",
    "verify_e_application": "Processing E-Application",
    "submit_agent_confidential_report": "Submitting Agent Confidential Report",
    "run_compliance_screening": "Running compliance screening",
    "override_compliance_screening": "Applying compliance override",
    "process_initial_premium_payment": "Processing initial premium payment",
    "run_insurance_history_check": "Running insurance history check",
    "assess_medical_examination": "Assessing medical examination requirements",
    "run_pre_underwriting_clearance": "Clearing all pre-underwriting gates",
    # Policy lifecycle (steps 5–7)
    "approve_case": "Approving case",
    "get_pre_issuance_status": "Checking pre-issuance readiness",
    "run_pre_issuance_verification": "Running pre-issuance verification",
    "issue_policy": "Issuing policy",
    "confirm_policy_payment": "Confirming payment",
    "get_active_policy_status": "Checking active policy status",
    # Rules engine
    "list_rule_categories": "Loading rule catalogue",
    "list_rule_sets": "Fetching rule sets",
    "get_rule_set": "Loading rule set",
    "evaluate_rule_set": "Simulating rule set",
    "evaluate_rule_scope": "Simulating rulebook scope",
    "get_rule_evaluation_logs": "Loading rule audit trail",
    "create_rule_set": "Creating rule set",
    "create_rule_version": "Opening draft version",
    "add_rule_to_version": "Adding rule",
    "update_rule": "Updating rule",
    "delete_rule": "Deleting rule",
    "deploy_rule_version": "Deploying rule version",
    "archive_rule_version": "Archiving rule version",
    # Rules catalogue
    "create_rule_category": "Creating rule category",
    "create_rule_subcategory": "Creating subcategory",
    "create_eligibility_profile": "Adding channel profile",
    # Claims
    "list_claims": "Fetching claims",
    "get_claim_details": "Loading claim file",
    "get_claims_dashboard": "Loading claims portfolio",
    "get_claim_document_checklist": "Auditing claim documents",
    "register_claim": "Registering First Notice of Loss",
    "update_claim_status": "Moving claim through the state machine",
    "adjudicate_claim": "Adjudicating claim",
    "issue_claim_payout": "Disbursing claim payout",
    "refer_claim_to_reinsurance": "Raising reinsurance recovery",
    "refer_claim_to_underwriting": "Referring claim to underwriting",
    "resolve_claim_underwriting": "Recording underwriting verdict",
    "upload_claim_document": "Uploading claim document",
    "start_claim_journey": "Launching autonomous claims journey",
    "continue_claim_journey": "Resuming claims journey",
    # Commission engine
    "list_commission_payees": "Fetching payees",
    "get_commission_rate_card": "Looking up rate card",
    "calculate_commission": "Computing commission waterfall",
    "get_commission_ledger": "Loading commission ledger",
    "get_agent_statement": "Building agent statement",
    "get_commission_summary": "Loading commission summary",
    "create_payout_run": "Assembling payout run",
    "approve_payout_run": "Approving payout run",
}


def step_label(tool_name: str) -> str:
    return STEP_LABELS.get(tool_name, tool_name.replace("_", " ").capitalize())


def is_destructive(tool_name: str) -> bool:
    return tool_name in DESTRUCTIVE_TOOLS


AGENT_ALLOWED_TOOLS = {
    # Lead Generation & Customer Intake
    "add_customer",
    "update_customer",
    "add_organization",
    "add_family_group",
    "bulk_add_customers",
    "quick_start_workflow",
    "list_customers",
    "list_organizations",
    "list_family_groups",
    "create_case",
    "list_cases",
    "get_case_details",
    "add_case_comment",
    # Proposals & Document Collection
    "create_proposal",
    "list_quotes",
    "list_insurance_plans",
    "upload_document",
    "get_document_checklist",
    "list_artifacts",
    # Pre-Underwriting Field Steps (Agent Field Roles)
    "get_pre_underwriting_status",
    "verify_e_application",
    "submit_agent_confidential_report",
    # Discovery & Navigation
    "navigate_to_page",
    "show_record",
    "search_records",
    "get_dashboard_stats",
    "get_workflow_recommendation",
}

# The agent-app mobile client is Agent-only and covers onboarding through
# Gate 6 (Medical Examination booking) — everything from AI Risk Assessment
# onward (risk engine, OCR/document-audit decisioning, approval, pre-issuance,
# policy issuance, payment) stays web-portal-only. Deliberately excludes
# run_pre_underwriting_clearance / the autonomous-journey tools: those
# fabricate/auto-fill gates instead of collecting the field agent's real ACR
# and the customer's real e-app/medical-exam submissions, which would defeat
# the point of a field agent driving this from their own device.
AGENT_MOBILE_ALLOWED_TOOLS = AGENT_ALLOWED_TOOLS | {
    "run_compliance_screening",
    "override_compliance_screening",
    "process_initial_premium_payment",
    "run_insurance_history_check",
    "assess_medical_examination",
}

# Tools blocked on mobile even though they'd be allowed for this role on web —
# used only to give the mobile client a friendlier "wrong app for this step"
# message instead of the generic RBAC denial.
MOBILE_PORTAL_ONLY_TOOLS = {
    "run_risk_assessment",
    "get_risk_assessment",
    "approve_case",
    "update_case_status",
    "run_pre_issuance_verification",
    "get_pre_issuance_status",
    "issue_policy",
    "confirm_policy_payment",
    "get_active_policy_status",
    "run_pre_underwriting_clearance",
    "start_underwriting_journey",
    "continue_underwriting_journey",
    "bulk_underwriting_journey",
    # Rules-engine governance, claims adjudication and commission payouts are
    # back-office work — they belong on the portal, not a field agent's phone.
    "deploy_rule_version",
    "archive_rule_version",
    "adjudicate_claim",
    "issue_claim_payout",
    "resolve_claim_underwriting",
    "refer_claim_to_reinsurance",
    "start_claim_journey",
    "continue_claim_journey",
    "create_payout_run",
    "approve_payout_run",
}


# Governance actions that stay with Admin even for an Underwriter: deploying a
# rule version changes how every subsequent case is underwritten, and a payout
# run moves money. Kept as an explicit deny-list on top of the Underwriter
# allow-list so adding a tool can never silently grant one of these.
ADMIN_ONLY_TOOLS = {
    "add_user",
    "delete_user",
    "list_users",
    "delete_customer",
    "deploy_rule_version",
    "archive_rule_version",
    "delete_rule",
    "create_rule_category",
    "create_rule_subcategory",
    "create_eligibility_profile",
    "create_payout_run",
    "approve_payout_run",
}

# ── Claims roles ────────────────────────────────────────────────────────────
#
# tenant-service/routers/claims.py gates every claims endpoint on
# {ClaimsAdjuster, ClaimsManager, Admin, SuperAdmin, Underwriter} and gates
# high-value approval on {ClaimsManager, Admin, SuperAdmin} on top of that.
# Mirrored here so an unauthorised role gets a plain sentence from the chat
# gate instead of a raw 403 out of the API — same defence, two layers.

CLAIMS_READ_TOOLS = {
    "list_claims",
    "get_claim_details",
    "get_claims_dashboard",
    "get_claim_document_checklist",
}

# Disbursement and reinsurance recovery are the two claims actions that move
# money or bind the reinsurer. Adjusters prepare them; managers release them.
CLAIMS_MANAGER_ONLY_TOOLS = {
    "issue_claim_payout",
    "refer_claim_to_reinsurance",
}

CLAIMS_ADJUSTER_ALLOWED_TOOLS = CLAIMS_READ_TOOLS | {
    "register_claim",
    "update_claim_status",
    "adjudicate_claim",
    "refer_claim_to_underwriting",
    "upload_claim_document",
    "start_claim_journey",
    "continue_claim_journey",
    # Enough of the platform to do the job around a claim: find the customer,
    # read the case and policy it hangs off, and navigate to any of it.
    "navigate_to_page",
    "show_record",
    "search_records",
    "list_customers",
    "list_cases",
    "get_case_details",
    "list_artifacts",
    "get_document_checklist",
    "add_case_comment",
    "get_dashboard_stats",
    "get_workflow_recommendation",
}

CLAIMS_MANAGER_ALLOWED_TOOLS = CLAIMS_ADJUSTER_ALLOWED_TOOLS | CLAIMS_MANAGER_ONLY_TOOLS | {
    "get_active_policy_status",
    "list_users",
    "assign_case",
}

# What an Underwriter may do beyond SAFE_TOOLS. This is an ALLOW-list: it used
# to be expressed as "anything not in {add_user, delete_user, ...}", which meant
# every newly declared tool — including payout approval and rule deployment —
# was granted to Underwriter the moment it existed.
UNDERWRITER_ALLOWED_TOOLS = SAFE_TOOLS | {
    "add_customer",
    "update_customer",
    "bulk_add_customers",
    "add_organization",
    "add_family_group",
    "create_case",
    "update_case_status",
    "assign_case",
    "add_case_comment",
    "delete_case",
    "create_proposal",
    "upload_document",
    "run_risk_assessment",
    "quick_start_workflow",
    # Pre-underwriting gates
    "get_pre_underwriting_status",
    "verify_e_application",
    "submit_agent_confidential_report",
    "run_compliance_screening",
    "override_compliance_screening",
    "process_initial_premium_payment",
    "run_insurance_history_check",
    "assess_medical_examination",
    "run_pre_underwriting_clearance",
    # Policy lifecycle
    "approve_case",
    "run_pre_issuance_verification",
    "issue_policy",
    "confirm_policy_payment",
    # Journeys
    "start_underwriting_journey",
    "continue_underwriting_journey",
    "bulk_underwriting_journey",
    # Rules engine — may author and simulate, may not deploy.
    "create_rule_set",
    "create_rule_version",
    "add_rule_to_version",
    "update_rule",
    # Claims — an underwriter reads the claim file and rules on re-underwriting
    # referrals (that IS their half of the claims workflow). They do not
    # adjudicate, disburse, or open an FNOL: that is the adjuster's desk.
    *CLAIMS_READ_TOOLS,
    "resolve_claim_underwriting",
}


def is_role_allowed(tool_name: str, role: str, platform: str = "web") -> bool:
    """Whether `role` may run `tool_name`.

    Every branch is an allow-list and the function ends in False. That matters:
    the previous version ended in `return True`, so any tool missing from the
    registries above defaulted to *permitted* for unrecognised roles, and
    Underwriter was a deny-list that auto-granted anything newly added.
    """
    if role in ADMIN_ROLES:
        return True
    if role == "Agent":
        if platform == "mobile":
            return tool_name in AGENT_MOBILE_ALLOWED_TOOLS
        return tool_name in AGENT_ALLOWED_TOOLS
    if role == "Underwriter":
        if tool_name in ADMIN_ONLY_TOOLS:
            return False
        return tool_name in UNDERWRITER_ALLOWED_TOOLS
    if role == "ClaimsManager":
        return tool_name in CLAIMS_MANAGER_ALLOWED_TOOLS
    if role == "ClaimsAdjuster":
        return tool_name in CLAIMS_ADJUSTER_ALLOWED_TOOLS
    if role == "Viewer":
        return tool_name in SAFE_TOOLS
    # Unknown role — read-only at most.
    return tool_name in SAFE_TOOLS


def get_tools_for_role(role: str, platform: str = "web") -> list:
    """Return only the tool definitions authorized for the given user role (Multitenant Tools)."""
    from tools import ALL_TOOLS
    return [t for t in ALL_TOOLS if is_role_allowed(t.name, role, platform)]


def requires_confirmation(tool_name: str) -> bool:
    if tool_name == "run_risk_assessment":
        return False
    return tool_name in MUTATING_TOOLS


def missing_args(tool_name: str, args: dict) -> list[str]:
    required = REQUIRED_ARGS.get(tool_name, [])
    return [r for r in required if not args.get(r)]
