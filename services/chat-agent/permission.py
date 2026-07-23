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
    # One confirmation buys the whole autonomous pipeline — that's the point.
    # (continue_underwriting_journey is deliberately NOT here: the journey was
    # already consented to at start; resuming it shouldn't re-prompt.)
    "start_underwriting_journey",
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
}

# Destructive enough that the confirmation prompt names the record explicitly
# rather than the generic "Ready to <tool name> — proceed?".
DESTRUCTIVE_TOOLS = {"delete_customer", "delete_user", "delete_case"}

ADMIN_ROLES = {"SuperAdmin", "Admin"}

# Tools whose execution needs a real file the browser already has in memory
# (an attached File object) — chat-agent has no way to receive that over a
# JSON tool-call, so these are executed client-side after the user confirms,
# not by tool_executor.py.
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
}


def step_label(tool_name: str) -> str:
    return STEP_LABELS.get(tool_name, tool_name.replace("_", " ").capitalize())


def is_destructive(tool_name: str) -> bool:
    return tool_name in DESTRUCTIVE_TOOLS


def is_role_allowed(tool_name: str, role: str) -> bool:
    if tool_name in MUTATING_TOOLS:
        return role in ADMIN_ROLES
    return True


def requires_confirmation(tool_name: str) -> bool:
    return tool_name in MUTATING_TOOLS


def missing_args(tool_name: str, args: dict) -> list[str]:
    required = REQUIRED_ARGS.get(tool_name, [])
    return [r for r in required if not args.get(r)]
