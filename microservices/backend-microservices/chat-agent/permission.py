"""Static permission/validation rules for tool calls — enforced in code, not prompts.

Mirrors the role restriction that used to live only in the frontend's system
prompt (frontend/app/api/chat/route.ts:35-37) and the "ask before executing"
instruction that used to be prose-only (route.ts:10) — both are now hard gates
the graph checks before a tool ever runs.
"""

from env_mode import is_demo

MUTATING_TOOLS = {
    "run_customer_risk_assessment",
    "pay_authorized_claim", "reconcile_finance_claim",
    "record_claim_financial_check",
    "issue_claim_payout",
    "create_platform_tenant", "manage_platform_role", "configure_platform_model",
    "request_initial_premium", "review_initial_premium_proof", "transition_proposal",
    # Specialist underwriting (specialist_review_tools.py)
    "upload_underwriting_document",
    "waive_underwriting_document",
    "record_claim_underwriting_check",
    "record_claim_underwriting_outcome",
    "start_my_review",
    "send_e_application_questionnaire",
    "run_ai_medical_underwriting",
    "run_ai_financial_underwriting",
    "record_underwriting_review",
    "assign_underwriting_track",
    "compile_final_underwriting",
    "add_customer",
    "update_customer",
    "delete_customer",
    "bulk_add_customers",
    "add_user",
    "update_user_role",
    "set_user_active",
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
    # Pre-underwriting (the 5 gates)
    "verify_e_application",
    "submit_agent_confidential_report",
    "run_compliance_screening",
    "override_compliance_screening",
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
    "refer_claim_to_reinsurance",
    "refer_claim_to_underwriting",
    "resolve_claim_underwriting",
    "upload_claim_document",
    # One confirmation buys the whole autonomous claims pipeline, exactly as
    # start_underwriting_journey does. (continue_claim_journey is deliberately
    # NOT here — the journey was already consented to at start.)
    "start_claim_journey",
    # Group Life / Takaful — each of these writes an employer's scheme, roster or
    # contract. generate_group_quote is a guided step (WORKFLOW_STEP_TOOLS) and
    # confirms nothing; start_group_journey is one confirmation for the pipeline,
    # like the other journeys (continue_group_journey is deliberately not here).
    "start_group_journey",
    "create_group_scheme",
    "add_group_benefit_class",
    "submit_group_census",
    "upload_group_census",
    "generate_group_quote",
    "accept_group_quote",
    "decline_group_quote",
    "issue_group_policy",
    "record_group_payment",
    "apply_group_endorsement",
    "resolve_group_endorsement",
    "settle_group_endorsement",
    "start_group_renewal",
    "decide_group_renewal",
    "record_group_renewal_payment",
    "register_group_claim",
    "pay_group_claim",
    "add_group_class_coverage",
    # Claims workflow — each step writes the claim file; disbursement moves money.
    "intimate_claim",
    "adopt_claim_into_workflow",
    "verify_claim_eligibility",
    "override_claim_eligibility",
    "update_claim_document",
    "record_claim_investigation",
    "assess_claim_benefit",
    "decide_claim",
    "verify_claim_payees",
    "authorize_claim_disbursement",
    "disburse_claim_settlement",
    "reconcile_claim_settlement",
    "close_claim_file",
    # Commission administration — agreements set rates, assignments decide who earns.
    "create_commission_agreement",
    "approve_commission_agreement",
    "assign_policy_producers",
    "reconcile_commission_receipts",
    # Commission — payout runs move money; rules & schemes govern payout structure.
    "create_payout_run",
    "approve_payout_run",
    "create_commission_rule",
    "update_commission_rule",
    "delete_commission_rule",
    "toggle_commission_rule_active",
    "deploy_commission_rules",
    "set_producer_start_date",
    "create_incentive_scheme",
    "update_incentive_scheme",
    "delete_incentive_scheme",
    "toggle_incentive_scheme_active",
    # Evidence — emails the customer, re-types an uploaded file, records the
    # medical review. read_medical_reports writes only the AI reading cache, but
    # it is kept off SAFE so Viewer and unknown roles never read medical values.
    "request_missing_documents",
    "link_document_to_requirement",
    "read_medical_reports",
    "record_medical_review",
    # Re-runs a failed mutation; the target tool's own RBAC is checked again.
    "resume_operation",
    # Policy servicing — deliveries, portal access, reminders, contract changes,
    # renewal / reinstatement / exit requests.
    "retry_failed_delivery",
    "provision_portal_access",
    "send_portal_invitation",
    "send_premium_reminder",
    "submit_policy_endorsement",
    "submit_policy_renewal",
    "submit_reinstatement_request",
    "submit_policy_exit_request",
    # Request Management & Customer Service (those services re-check permissions)
    "create_service_request",
    "add_request_attachment",
    "submit_service_request",
    "create_support_ticket",
    "add_ticket_comment",
    "assign_support_ticket",
    # Underwriting exceptions & member workflows
    "request_additional_evidence",
    "refer_underwriting_review",
    "resume_member_workflow",
}

# Read-only + navigation. Never gated, never confirmed — asking "shall I open
# the cases page?" before every navigation makes the agent unusable.
SAFE_TOOLS = {
    "get_customer_risk_assessment",
    "get_finance_dashboard", "get_claim_payment_details",
    "get_claim_financial_review",
    "get_platform_configuration", "get_platform_token_usage", "get_initial_premium_status",
    "search_capabilities", "get_capability_schema",
    # Specialist underwriting reads — scoped further by ROLE_SCOPED_READS below.
    "list_my_underwriting_reviews",
    "get_underwriting_review",
    "list_track_underwriters",
    "get_specialist_reviews",
    "prepare_family_insurance",
    "resolve_customer_type",
    "navigate_to_page",
    "show_record",
    "search_records",
    "list_leads",
    "list_customers",
    "list_cases",
    "get_case_details",
    "get_document_checklist",
    "list_artifacts",
    "list_users",
    "list_acquisition_sources",
    "list_organizations",
    "list_family_groups",
    "list_quotes",
    "list_insurance_plans",
    "get_risk_assessment",
    "assess_customer_risk_profile",
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
    "get_policy_claim_options",
    "get_claim_workflow",
    "list_claims",
    "get_claim_details",
    "get_claims_dashboard",
    "get_claim_document_checklist",
    "continue_claim_journey",
    # Group schemes (read-only) — still admin-only through GROUP_TOOLS below.
    "continue_group_journey",
    "get_group_scheme_status",
    "list_group_members",
    "preview_group_endorsement",
    "list_group_endorsements",
    "get_group_ptf_report",
    "get_group_renewal",
    "list_group_claims",
    "preview_group_claim_payout",
    # Commission (read-only). The agreement/split/exception reads are Admin-only
    # through COMMISSION_ADMIN_TOOLS below; earnings are scoped by the API itself.
    "explain_commission_earning",
    "get_customer_commission_setup",
    "list_commission_agreements",
    "get_policy_commission_split",
    "list_commission_exceptions",
    "list_commission_payees",
    "get_commission_rate_card",
    "calculate_commission",
    "get_commission_ledger",
    "get_agent_statement",
    "get_commission_summary",
    "list_commission_rules",
    "list_payable_commissions",
    "list_payout_runs",
    "list_incentive_schemes",
    # Evidence & recovery (read-only)
    "get_medical_report_status",
    "get_operation_status",
    "get_service_health",
    "diagnose_connection",
    # Policy servicing (read-only / previews)
    "get_policy_delivery_status",
    "get_onboarding_status",
    "get_premium_schedule",
    "get_payment_receipt",
    "preview_policy_endorsement",
    "get_endorsement_status",
    "get_renewal_readiness",
    "preview_policy_renewal",
    "get_reinstatement_requirements",
    "get_reinstatement_status",
    "preview_policy_exit",
    "get_exit_status",
    # Requests, tickets, records, queues (read-only)
    "get_service_request",
    "get_support_ticket",
    "resolve_insurance_record",
    "preview_application_transition",
    "get_member_workflow_matrix",
    "get_claim_blockers",
    "get_work_queue",
    "get_workflow_timeline",
}

# Destructive enough that the confirmation prompt names the record explicitly
# rather than the generic "Ready to <tool name> — proceed?".
DESTRUCTIVE_TOOLS = {"delete_customer", "delete_user", "delete_case", "delete_rule", "delete_commission_rule", "delete_incentive_scheme"}


ADMIN_ROLES = {"SuperAdmin", "Admin"}

# Every group-scheme tool, read-only ones included. tenant-service gates all of
# /organizations/**/master-policies/** on verify_admin, so the chat mirrors that:
# Admin and SuperAdmin only. Without this guard the read-only ones sit in
# SAFE_TOOLS, which would hand them to Viewer and to any unrecognised role.
GROUP_TOOLS = {
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
}

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
    "create_commission_rule": ["rule_code", "name", "commission_pct"],
    "update_commission_rule": ["rule_code"],
    "delete_commission_rule": ["rule_code"],
    "toggle_commission_rule_active": ["rule_code"],
    "set_producer_start_date": ["payee_name", "start_date"],
    "approve_payout_run": ["run_id"],
    "record_claim_financial_check": ["key", "finding", "note"],
    "record_underwriting_review": ["decision"],
    "assign_underwriting_track": ["track"],
    "add_customer": [
        "first_name", "last_name", "cnic", "date_of_birth",
        "gender", "occupation", "declared_income",
    ],
    "add_user": ["full_name", "email", "role_name"],
    # `active` is a bool: False (deactivate) would read as missing here; the tool schema requires it anyway.
    "update_user_role": ["user", "role_name"],
    "set_user_active": ["user"],
    "add_organization": ["name"],
    "start_group_journey": ["organization_name"],
    "create_group_scheme": ["organization_name"],
    "record_group_payment": ["reference"],
    "settle_group_endorsement": ["reference"],
    "register_group_claim": ["member_name"],
    "add_group_class_coverage": ["coverage_type", "percent_of_base"],
    "add_family_group": ["name"],
    "prepare_family_insurance": ["customer_id"],
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
    "link_document_to_requirement": ["document_type"],
    "record_medical_review": ["results_json"],
    "diagnose_connection": ["symptom"],
    "preview_policy_endorsement": ["endorsement_type"],
    "submit_policy_endorsement": ["endorsement_type"],
    "submit_policy_exit_request": ["exit_type"],
    "create_service_request": ["description"],
    "add_request_attachment": ["request_reference"],
    "submit_service_request": ["request_reference"],
    "create_support_ticket": ["title", "description"],
    "add_ticket_comment": ["ticket_reference", "comment"],
    "assign_support_ticket": ["ticket_reference"],
    "resolve_insurance_record": ["identifier"],
    "request_additional_evidence": ["evidence"],
    "refer_underwriting_review": ["reason"],
}

# Tools that emit progress steps worth showing in the UI's process graph, with
# the label each step gets. Everything else falls back to a humanised tool name.
STEP_LABELS: dict[str, str] = {
    "get_finance_dashboard": "Checking Finance queues",
    "get_claim_payment_details": "Checking claim payment details",
    "pay_authorized_claim": "Recording authorised settlement payment",
    "reconcile_finance_claim": "Reconciling claim payment",
    "get_claim_financial_review": "Checking claim financial underwriting",
    "record_claim_financial_check": "Recording financial claim finding",
    "get_platform_configuration": "Read platform configuration",
    "get_platform_token_usage": "Read token usage",
    "create_platform_tenant": "Create tenant",
    "manage_platform_role": "Manage role",
    "configure_platform_model": "Configure model",
    "get_initial_premium_status": "Read initial premium",
    "request_initial_premium": "Request initial premium",
    "review_initial_premium_proof": "Review payment proof",
    "transition_proposal": "Update proposal stage",
    "search_capabilities": "Find available capabilities",
    "get_capability_schema": "Load capability",
    "list_my_underwriting_reviews": "Loading your reviews",
    "get_underwriting_review": "Reading the review workspace",
    "start_my_review": "Starting your review",
    "send_e_application_questionnaire": "Sending the e-application",
    "run_ai_medical_underwriting": "Running AI medical underwriting",
    "run_ai_financial_underwriting": "Running AI financial underwriting",
    "record_underwriting_review": "Recording your review",
    "upload_underwriting_document": "Uploading underwriting evidence",
    "waive_underwriting_document": "Waiving claim document requirement",
    "record_claim_underwriting_check": "Recording claim underwriting finding",
    "record_claim_underwriting_outcome": "Recording human underwriting outcome",
    "list_track_underwriters": "Finding underwriters",
    "assign_underwriting_track": "Assigning the review",
    "get_specialist_reviews": "Reading the specialist reviews",
    "compile_final_underwriting": "Compiling final underwriting",
    "resolve_customer_type": "Determining customer type",
    "add_customer": "Registering customer",
    "update_customer": "Updating customer",
    "delete_customer": "Deleting customer",
    "bulk_add_customers": "Adding customers in bulk",
    "add_user": "Creating user",
    "update_user_role": "Changing user role",
    "set_user_active": "Updating user access",
    "delete_user": "Removing user",
    "add_organization": "Creating organization",
    "add_family_group": "Creating family group",
    "prepare_family_insurance": "Preparing family insurance with existing customer",
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
    "list_leads": "Fetching leads",
    "list_customers": "Fetching customers",
    "list_cases": "Fetching applications",
    "get_case_details": "Loading application details",
    "get_document_checklist": "Checking documents",
    "list_artifacts": "Fetching documents",
    "list_users": "Fetching users",
    "list_acquisition_sources": "Fetching acquisition sources",
    "list_organizations": "Fetching organizations",
    "list_family_groups": "Fetching family groups",
    "list_quotes": "Fetching quotations",
    "list_insurance_plans": "Fetching plans",
    "get_risk_assessment": "Loading assessment",
    "assess_customer_risk_profile": "Assessing profile risk",
    "run_customer_risk_assessment": "Running lead risk assessment",
    "get_customer_risk_assessment": "Reading saved lead risk assessment",
    "get_dashboard_stats": "Loading metrics",
    "get_workflow_recommendation": "Planning next step",
    "quick_start_workflow": "Generating demo data",
    "start_underwriting_journey": "Launching autonomous underwriting journey",
    "continue_underwriting_journey": "Resuming underwriting journey",
    "bulk_underwriting_journey": "Running bulk underwriting journey",
    # Pre-underwriting (the 5 gates)
    "get_pre_underwriting_status": "Checking pre-underwriting gates",
    "verify_e_application": "Processing E-Application",
    "submit_agent_confidential_report": "Submitting Agent Confidential Report",
    "run_compliance_screening": "Running compliance screening",
    "override_compliance_screening": "Applying compliance override",
    "run_insurance_history_check": "Running insurance history check",
    "request_missing_documents": "Requesting missing documents",
    "link_document_to_requirement": "Linking document to requirement",
    "get_medical_report_status": "Checking medical reports",
    "read_medical_reports": "Reading medical reports",
    "record_medical_review": "Recording medical review",
    "get_operation_status": "Checking operation status",
    "resume_operation": "Resuming failed step",
    "get_service_health": "Checking service health",
    "diagnose_connection": "Diagnosing connection",
    "get_policy_delivery_status": "Checking policy delivery",
    "retry_failed_delivery": "Retrying failed delivery",
    "get_onboarding_status": "Checking onboarding",
    "provision_portal_access": "Setting up portal access",
    "send_portal_invitation": "Sending portal invitation",
    "get_premium_schedule": "Loading premium schedule",
    "get_payment_receipt": "Fetching receipts",
    "send_premium_reminder": "Sending premium reminder",
    "preview_policy_endorsement": "Previewing policy change",
    "submit_policy_endorsement": "Applying policy change",
    "get_endorsement_status": "Loading endorsements",
    "get_renewal_readiness": "Checking renewal readiness",
    "preview_policy_renewal": "Previewing renewal",
    "submit_policy_renewal": "Opening renewal",
    "get_reinstatement_requirements": "Checking reinstatement requirements",
    "submit_reinstatement_request": "Requesting reinstatement",
    "get_reinstatement_status": "Checking reinstatement",
    "preview_policy_exit": "Previewing exit options",
    "submit_policy_exit_request": "Submitting exit request",
    "get_exit_status": "Checking exit status",
    "create_service_request": "Drafting service request",
    "get_service_request": "Checking service request",
    "add_request_attachment": "Attaching document",
    "submit_service_request": "Submitting service request",
    "create_support_ticket": "Opening support ticket",
    "get_support_ticket": "Checking support ticket",
    "add_ticket_comment": "Commenting on ticket",
    "assign_support_ticket": "Assigning ticket",
    "resolve_insurance_record": "Resolving record",
    "preview_application_transition": "Checking allowed transition",
    "request_additional_evidence": "Requesting additional evidence",
    "refer_underwriting_review": "Referring for review",
    "get_member_workflow_matrix": "Building member matrix",
    "resume_member_workflow": "Resuming member workflow",
    "get_claim_blockers": "Checking claim blockers",
    "get_policy_claim_options": "Checking cover and claimable benefits",
    "get_claim_workflow": "Loading claim workflow",
    "intimate_claim": "Intimating claim",
    "adopt_claim_into_workflow": "Bringing claim into the workflow",
    "verify_claim_eligibility": "Verifying cover on the event date",
    "override_claim_eligibility": "Overriding claim eligibility",
    "update_claim_document": "Updating claim checklist",
    "record_claim_investigation": "Recording claim investigation",
    "assess_claim_benefit": "Assessing benefit payable",
    "decide_claim": "Recording claim decision",
    "verify_claim_payees": "Verifying payee",
    "authorize_claim_disbursement": "Authorising disbursement",
    "disburse_claim_settlement": "Disbursing claim settlement",
    "reconcile_claim_settlement": "Reconciling claim settlement",
    "close_claim_file": "Closing claim file",
    "list_commission_agreements": "Loading commission agreements",
    "get_customer_commission_setup": "Checking customer commission setup",
    "create_commission_agreement": "Drafting commission agreement",
    "approve_commission_agreement": "Approving commission agreement",
    "get_policy_commission_split": "Loading producer split",
    "assign_policy_producers": "Assigning producers",
    "list_commission_exceptions": "Loading commission exceptions",
    "reconcile_commission_receipts": "Reconciling commission receipts",
    "explain_commission_earning": "Explaining commission earning",
    "get_work_queue": "Loading work queue",
    "get_workflow_timeline": "Loading timeline",
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
    # Group schemes
    "start_group_journey": "Launching group scheme journey",
    "continue_group_journey": "Resuming group scheme journey",
    "create_group_scheme": "Creating group scheme",
    "add_group_benefit_class": "Adding benefit classes",
    "submit_group_census": "Validating and enrolling the census",
    "upload_group_census": "Uploading the employee census",
    "get_group_scheme_status": "Checking group scheme status",
    "list_group_members": "Listing group members",
    "generate_group_quote": "Pricing the group scheme",
    "accept_group_quote": "Recording quote acceptance",
    "decline_group_quote": "Recording quote decline",
    "issue_group_policy": "Issuing the master policy",
    "record_group_payment": "Recording the employer's payment",
    "preview_group_endorsement": "Pricing the endorsement",
    "apply_group_endorsement": "Applying the endorsement",
    "list_group_endorsements": "Listing endorsements",
    "resolve_group_endorsement": "Applying underwriting decisions to the endorsement",
    "settle_group_endorsement": "Recording the endorsement settlement",
    "start_group_renewal": "Opening and pricing the renewal",
    "get_group_renewal": "Checking the renewal",
    "decide_group_renewal": "Recording the employer's renewal decision",
    "record_group_renewal_payment": "Recording the renewal payment",
    "register_group_claim": "Registering the group claim",
    "list_group_claims": "Listing the scheme's claims",
    "preview_group_claim_payout": "Working out the payout split",
    "pay_group_claim": "Paying the claim to its nominees",
    "get_group_ptf_report": "Building the Takaful fund report",
    "add_group_class_coverage": "Adding an extra benefit to the class",
    # Commission engine
    "list_commission_payees": "Fetching payees",
    "get_commission_rate_card": "Looking up rate card",
    "calculate_commission": "Previewing policy commission",
    "get_commission_ledger": "Loading commission ledger",
    "get_agent_statement": "Building agent statement",
    "get_commission_summary": "Loading commission summary",
    "create_payout_run": "Assembling payout run",
    "approve_payout_run": "Approving payout run",
    "list_commission_rules": "Fetching commission rate card rules",
    "create_commission_rule": "Creating commission rate card rule",
    "update_commission_rule": "Updating commission rule",
    "delete_commission_rule": "Deleting commission rule",
    "toggle_commission_rule_active": "Toggling commission rule status",
    "deploy_commission_rules": "Deploying commission rules",
    "set_producer_start_date": "Setting producer payout day",
    "list_payable_commissions": "Checking payable commissions",
    "list_payout_runs": "Loading payout runs",
    "list_incentive_schemes": "Fetching performance bonus plans",
    "create_incentive_scheme": "Creating performance bonus plan",
    "update_incentive_scheme": "Updating bonus plan",
    "delete_incentive_scheme": "Deleting bonus plan",
    "toggle_incentive_scheme_active": "Toggling bonus plan status",
}



def step_label(tool_name: str) -> str:
    return STEP_LABELS.get(tool_name, tool_name.replace("_", " ").capitalize())


def is_destructive(tool_name: str) -> bool:
    return tool_name in DESTRUCTIVE_TOOLS


AGENT_ALLOWED_TOOLS = {
    # Their own commission. The earnings API scopes an Agent to their own
    # acquisition source, so these can never show another producer's money.
    "get_agent_statement",
    "get_commission_ledger",
    "explain_commission_earning",
    # What the commission rules pay (RS-COM-002); the rate-preview API is open to staff and agents.
    "get_commission_rate_card",
    # Lead Generation & Customer Intake
    "resolve_customer_type",
    "add_customer",
    "update_customer",
    "add_organization",
    "add_family_group",
    "prepare_family_insurance",
    "bulk_add_customers",
    "quick_start_workflow",
    "list_leads",
    "list_customers",
    "assess_customer_risk_profile",
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
    # Evidence collection & recovery
    "request_missing_documents",
    "link_document_to_requirement",
    "get_medical_report_status",
    "get_operation_status",
    "resume_operation",
    "get_service_health",
    "diagnose_connection",
    # Records & member journeys (pre-underwriting scope, so the field app has them too)
    "resolve_insurance_record",
    "preview_application_transition",
    "get_member_workflow_matrix",
    "resume_member_workflow",
    "get_workflow_timeline",
    # Raising and following requests and tickets
    "create_service_request",
    "get_service_request",
    "add_request_attachment",
    "submit_service_request",
    "create_support_ticket",
    "get_support_ticket",
    "add_ticket_comment",
}

# Servicing an issued policy is post-issuance work: Agent on the web portal only.
# Contract changes, portal credentials and policy exits stay with staff.
AGENT_WEB_ONLY_TOOLS = {
    "get_policy_delivery_status",
    "retry_failed_delivery",
    "get_onboarding_status",
    "send_portal_invitation",
    "get_premium_schedule",
    "get_payment_receipt",
    "send_premium_reminder",
    "preview_policy_endorsement",
    "get_endorsement_status",
    "get_renewal_readiness",
    "preview_policy_renewal",
    "submit_policy_renewal",
    "get_reinstatement_requirements",
    "submit_reinstatement_request",
    "get_reinstatement_status",
    "preview_policy_exit",
    "get_exit_status",
    "get_work_queue",
}

# The agent-app mobile client is Agent-only and covers onboarding through
# Gate 5 (Medical Examination booking) — everything from AI Risk Assessment
# onward (risk engine, OCR/document-audit decisioning, approval, pre-issuance,
# policy issuance, payment) stays web-portal-only. Deliberately excludes
# run_pre_underwriting_clearance / the autonomous-journey tools: those
# fabricate/auto-fill gates instead of collecting the field agent's real ACR
# and the customer's real e-app/medical-exam submissions, which would defeat
# the point of a field agent driving this from their own device.
AGENT_MOBILE_ALLOWED_TOOLS = AGENT_ALLOWED_TOOLS | {
    "run_compliance_screening",
    "override_compliance_screening",
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
    "deploy_commission_rules",
    "decide_claim",
    "authorize_claim_disbursement",
    "disburse_claim_settlement",
    *AGENT_WEB_ONLY_TOOLS,
}


# Governance actions that stay with Admin even for an Underwriter: deploying a
# rule version changes how every subsequent case is underwritten, and a payout
# run moves money. Kept as an explicit deny-list on top of the Underwriter
# allow-list so adding a tool can never silently grant one of these.
ADMIN_ONLY_TOOLS = {
    "add_user",
    "update_user_role",
    "set_user_active",
    "delete_user",
    "list_users",
    "list_acquisition_sources",
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

ADMIN_ONLY_TOOLS |= GROUP_TOOLS

# Commission administration, read-only ones included: tenant-service gates
# /commissions/agreements, /assignments, /exceptions and /reconcile on Admin, so
# the chat mirrors that — same pattern as GROUP_TOOLS, and for the same reason
# (the reads sit in SAFE_TOOLS, which would otherwise hand them to Viewer).
COMMISSION_ADMIN_TOOLS = {
    "get_customer_commission_setup",
    "list_commission_agreements",
    "create_commission_agreement",
    "approve_commission_agreement",
    "get_policy_commission_split",
    "assign_policy_producers",
    "list_commission_exceptions",
    "reconcile_commission_receipts",
    # Policy preview, commission rules (RS-COM-002), payout day and payout runs: Admin in
    # tenant-service too. Rule edits change every later posting, so they stay admin-only.
    "calculate_commission",
    "create_commission_rule",
    "update_commission_rule",
    "delete_commission_rule",
    "toggle_commission_rule_active",
    "deploy_commission_rules",
    "set_producer_start_date",
    "list_payable_commissions",
    "list_payout_runs",
    "create_payout_run",
    "approve_payout_run",
}

ADMIN_ONLY_TOOLS |= COMMISSION_ADMIN_TOOLS

# ── Claims roles ────────────────────────────────────────────────────────────
#
# tenant-service/routers/claims.py gates every claims endpoint on
# {ClaimsAdjuster, ClaimsManager, Admin, SuperAdmin, Underwriter} and gates
# high-value approval on {ClaimsManager, Admin, SuperAdmin} on top of that.
# Mirrored here so an unauthorised role gets a plain sentence from the chat
# gate instead of a raw 403 out of the API — same defence, two layers.

CLAIMS_READ_TOOLS = {
    "get_policy_claim_options",
    "get_claim_workflow",
    "list_claims",
    "get_claim_details",
    "get_claims_dashboard",
    "get_claim_document_checklist",
}

# Disbursement and reinsurance recovery are the two claims actions that move
# money or bind the reinsurer. Adjusters prepare them; managers release them.
CLAIMS_MANAGER_ONLY_TOOLS = {
    "resolve_claim_underwriting",
    "refer_claim_to_reinsurance",
    # Workflow equivalents: releasing and paying the settlement, and letting an
    # ineligible claim through. (The API lets an adjuster authorise up to the
    # manager limit; the chat keeps money release with managers, as above.)
    "authorize_claim_disbursement",
    "override_claim_eligibility",
}

CLAIMS_ADJUSTER_ALLOWED_TOOLS = CLAIMS_READ_TOOLS | {
    "register_claim",
    "update_claim_status",
    "adjudicate_claim",
    "refer_claim_to_underwriting",
    "upload_claim_document",
    "start_claim_journey",
    "continue_claim_journey",
    # The 7-step workflow, up to (not including) releasing the money.
    "intimate_claim",
    "adopt_claim_into_workflow",
    "verify_claim_eligibility",
    "update_claim_document",
    "record_claim_investigation",
    "assess_claim_benefit",
    "decide_claim",
    "verify_claim_payees",
    "reconcile_claim_settlement",
    "close_claim_file",
    # Enough of the platform to do the job around a claim: find the customer,
    # read the case and policy it hangs off, and navigate to any of it.
    "navigate_to_page",
    "show_record",
    "search_records",
    "list_leads",
    "list_customers",
    "list_cases",
    "get_case_details",
    "list_artifacts",
    "get_document_checklist",
    "add_case_comment",
    "get_dashboard_stats",
    "get_workflow_recommendation",
    "get_operation_status",
    "resume_operation",
    "get_service_health",
    "diagnose_connection",
    "get_claim_blockers",
    "get_work_queue",
    "get_workflow_timeline",
    "resolve_insurance_record",
    "create_service_request",
    "get_service_request",
    "add_request_attachment",
    "submit_service_request",
    "create_support_ticket",
    "get_support_ticket",
    "add_ticket_comment",
}

CLAIMS_MANAGER_ALLOWED_TOOLS = (CLAIMS_ADJUSTER_ALLOWED_TOOLS | CLAIMS_MANAGER_ONLY_TOOLS | {
    "get_claim_financial_review",
    "record_claim_financial_check",
    "get_active_policy_status",
    "list_users",
    # Claims managers are Customer Service staff too (customer-service STAFF roles).
    "assign_support_ticket",
}) - {
    # Underwriting work, not claims: assigning underwriting cases and running a member's pre-underwriting steps.
    "assign_case",
    "resume_member_workflow",
}

# Customer Service desk: reads everything a customer may ask about, works its tickets,
# and handles the routine servicing that needs no underwriting authority.
CUSTOMER_SERVICE_ALLOWED_TOOLS = SAFE_TOOLS | {
    "create_support_ticket",
    "add_ticket_comment",
    "assign_support_ticket",
    "retry_failed_delivery",
    "send_portal_invitation",
    "send_premium_reminder",
    "resume_operation",
}

# What an Underwriter may do beyond SAFE_TOOLS. This is an ALLOW-list: it used
# to be expressed as "anything not in {add_user, delete_user, ...}", which meant
# every newly declared tool — including payout approval and rule deployment —
# was granted to Underwriter the moment it existed.
UNDERWRITER_ALLOWED_TOOLS = SAFE_TOOLS | {
    "resolve_customer_type",
    "add_customer",
    "update_customer",
    "bulk_add_customers",
    "add_organization",
    "add_family_group",
    "prepare_family_insurance",
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
    # Underwriters read claims and submit specialist reviews; the Claims Manager records final resolution.
    *CLAIMS_READ_TOOLS,
    # Evidence & medical review — reviewing medical reports is underwriting work.
    "request_missing_documents",
    "link_document_to_requirement",
    "read_medical_reports",
    "record_medical_review",
    "resume_operation",
    # Policy servicing — underwriting staff hold the contractual authority.
    "retry_failed_delivery",
    "provision_portal_access",
    "send_portal_invitation",
    "send_premium_reminder",
    "submit_policy_endorsement",
    "submit_policy_renewal",
    "submit_reinstatement_request",
    "submit_policy_exit_request",
    "create_service_request",
    "add_request_attachment",
    "submit_service_request",
    "create_support_ticket",
    "add_ticket_comment",
    "request_additional_evidence",
    "refer_underwriting_review",
    "resume_member_workflow",
}


# The Medical and Financial Underwriter work one track each, in their own
# workspace; the backend additionally refuses anything outside their track.
SPECIALIST_TOOLS = {
    "upload_underwriting_document",
    "waive_underwriting_document",
    "record_claim_underwriting_check",
    "list_my_underwriting_reviews",
    "get_underwriting_review",
    "start_my_review",
    "send_e_application_questionnaire",
    "record_underwriting_review",
}
# Their whole allow-list — no SAFE_TOOLS: a specialist has no business reading commission ledgers, agent
# statements, claims, group schemes, the rule engine or the user list. The same list applies whether the request
# comes through their subagent, a quick-action chip or voice (/chat/execute-tool).
SPECIALIST_NAVIGATION = {"navigate_to_page", "show_record", "search_records"}
MEDICAL_UNDERWRITER_ALLOWED_TOOLS = SPECIALIST_TOOLS | SPECIALIST_NAVIGATION | {"run_ai_medical_underwriting", "get_medical_report_status"}
FINANCIAL_UNDERWRITER_ALLOWED_TOOLS = SPECIALIST_TOOLS | SPECIALIST_NAVIGATION | {"run_ai_financial_underwriting", "run_insurance_history_check"}
# Final underwriting: compiles the two specialist reviews (Admin has every tool).
FINAL_UNDERWRITING_TOOLS = {
    "list_track_underwriters",
    "get_specialist_reviews",
    "compile_final_underwriting",
    "send_e_application_questionnaire",
    "record_underwriting_review",
}


# Read-only, but carrying medical findings and underwriters' rationale: only the
# roles that do the work see them, never Viewer or Customer Service.
_FINAL_READERS = {"SuperAdmin", "Admin", "Underwriter"}
ROLE_SCOPED_READS: dict[str, set[str]] = {
    # Admins may call these too; the handlers explain they are a specialist's view.
    "list_my_underwriting_reviews": {"Medical Underwriter", "Financial Underwriter", *ADMIN_ROLES},
    "get_underwriting_review": {"Medical Underwriter", "Financial Underwriter", *ADMIN_ROLES},
    "list_track_underwriters": _FINAL_READERS,
    "get_specialist_reviews": _FINAL_READERS,
}


# Mirrored from tenant-service/services/claim_authority.py. These restrictions
# precede the legacy Admin fast path: platform administration is not claims authority.
CLAIM_AUTHORITY_ROLES = {
    "upload_underwriting_document": {"Medical Underwriter", "Financial Underwriter"},
    "waive_underwriting_document": {"Medical Underwriter", "Financial Underwriter"},
    "record_claim_underwriting_check": {"Medical Underwriter", "Financial Underwriter"},
    "record_claim_underwriting_outcome": {"Admin", "SuperAdmin"},
    "resolve_claim_underwriting": {"ClaimsManager"},
    "get_claim_financial_review": {"ClaimsManager"},
    "record_claim_financial_check": {"ClaimsManager"},
    "register_claim": {"ClaimsAdjuster", "ClaimsManager"},
    "adjudicate_claim": {"ClaimsAdjuster", "ClaimsManager"},
    "decide_claim": {"ClaimsAdjuster", "ClaimsManager"},
    "authorize_claim_disbursement": {"ClaimsManager"},
    "override_claim_eligibility": {"ClaimsManager"},
    "issue_claim_payout": {"Finance"},
    "disburse_claim_settlement": {"Finance"},
    "reconcile_claim_settlement": {"Finance", "ClaimsManager"},
}
CLAIM_PROCESS_TOOLS = {
    "intimate_claim", "adopt_claim_into_workflow", "verify_claim_eligibility",
    "update_claim_document", "record_claim_investigation", "assess_claim_benefit",
    "verify_claim_payees", "close_claim_file", "update_claim_status",
    "refer_claim_to_reinsurance", "refer_claim_to_underwriting",
}
CLAIM_AUTHORITY_ROLES.update({name: {"ClaimsAdjuster", "ClaimsManager", "Underwriter"} for name in CLAIM_PROCESS_TOOLS})
CLAIM_AUTHORITY_ROLES.update({name: {"ClaimsAdjuster", "ClaimsManager"} for name in
                              {"start_claim_journey", "continue_claim_journey"}})

FINANCE_ALLOWED_TOOLS = CLAIMS_READ_TOOLS | SPECIALIST_NAVIGATION | {
    "get_finance_dashboard", "get_claim_payment_details", "pay_authorized_claim", "reconcile_finance_claim",
    "issue_claim_payout", "disburse_claim_settlement", "reconcile_claim_settlement",
    "resolve_insurance_record", "get_claim_blockers", "get_workflow_timeline",
}


# Finance-specific capabilities cannot be discovered or executed by another role.
_FINANCE_ONLY_TOOLS = {"get_finance_dashboard", "get_claim_payment_details", "pay_authorized_claim", "reconcile_finance_claim"}
CLAIM_AUTHORITY_ROLES.update({name: {"Finance"} for name in _FINANCE_ONLY_TOOLS})

# Role operations carry their own explicit grants, mirrored from the owning
# routers (role_operations.py). They precede every allow-list below.
from role_operations import MUTATING as _ROLE_OPERATION_MUTATING, READ_TOOLS as _ROLE_OPERATION_READS
from role_operations import STEP_LABELS as _ROLE_OPERATION_LABELS, TOOL_ROLES as ROLE_OPERATION_ROLES
MUTATING_TOOLS |= _ROLE_OPERATION_MUTATING
SAFE_TOOLS |= _ROLE_OPERATION_READS
STEP_LABELS.update(_ROLE_OPERATION_LABELS)


def is_role_allowed(tool_name: str, role: str, platform: str = "web") -> bool:
    """Whether `role` may run `tool_name`.

    Every branch is an allow-list and the function ends in False. That matters:
    the previous version ended in `return True`, so any tool missing from the
    registries above defaulted to *permitted* for unrecognised roles, and
    Underwriter was a deny-list that auto-granted anything newly added.
    """
    # Match the owning customer risk-profile endpoints, which require verify_admin.
    if tool_name in {"run_customer_risk_assessment", "get_customer_risk_assessment"}:
        return role in ADMIN_ROLES
    if tool_name in {"search_capabilities", "get_capability_schema"}:
        from skills import enabled
        return enabled()
    from capability_tools import PLATFORM_TOOLS, PROPOSAL_TOOLS
    if tool_name in PLATFORM_TOOLS:
        return role == "SuperAdmin"
    if tool_name in ROLE_OPERATION_ROLES:
        return role in ROLE_OPERATION_ROLES[tool_name]
    if tool_name in PROPOSAL_TOOLS:
        if tool_name == "review_initial_premium_proof":
            return role in {"SuperAdmin", "Admin", "Underwriter"}
        return role in {"SuperAdmin", "Admin", "Underwriter", "Agent"}
    if tool_name in CLAIM_AUTHORITY_ROLES and role not in CLAIM_AUTHORITY_ROLES[tool_name]:
        return False
    if tool_name in _FINANCE_ONLY_TOOLS:
        return role == "Finance"
    if role == "Finance":
        return tool_name in FINANCE_ALLOWED_TOOLS
    if tool_name in ROLE_SCOPED_READS and role not in ROLE_SCOPED_READS[tool_name]:
        return False
    if role in ADMIN_ROLES:
        return True
    if tool_name in GROUP_TOOLS or tool_name in COMMISSION_ADMIN_TOOLS:
        return False
    if role == "Agent":
        if platform == "mobile":
            return tool_name in AGENT_MOBILE_ALLOWED_TOOLS
        return tool_name in AGENT_ALLOWED_TOOLS or tool_name in AGENT_WEB_ONLY_TOOLS
    if role == "Underwriter":
        if tool_name in ADMIN_ONLY_TOOLS:
            return False
        return tool_name in UNDERWRITER_ALLOWED_TOOLS or tool_name in FINAL_UNDERWRITING_TOOLS
    if role == "Medical Underwriter":
        return tool_name in MEDICAL_UNDERWRITER_ALLOWED_TOOLS
    if role == "Financial Underwriter":
        return tool_name in FINANCIAL_UNDERWRITER_ALLOWED_TOOLS
    if role == "ClaimsManager":
        return tool_name in CLAIMS_MANAGER_ALLOWED_TOOLS
    if role == "ClaimsAdjuster":
        return tool_name in CLAIMS_ADJUSTER_ALLOWED_TOOLS
    if role == "CustomerService":
        return tool_name in CUSTOMER_SERVICE_ALLOWED_TOOLS
    if role == "Viewer":
        return tool_name in SAFE_TOOLS
    # Unknown role — read-only at most.
    return tool_name in SAFE_TOOLS


def get_tools_for_role(role: str, platform: str = "web") -> list:
    """Return only the tool definitions authorized for the given user role (Multitenant Tools)."""
    from tools import ALL_TOOLS
    return [t for t in ALL_TOOLS if is_role_allowed(t.name, role, platform)]


# Steps of the guided underwriting → issuance automation. Each one is started
# by the user clicking that step (a quick action or journey node), so the click
# *is* the consent — a second "Ready to <step> — proceed?" on every gate just
# doubles the clicks. They stay in MUTATING_TOOLS, so RBAC is unchanged; the
# irreversible forks (demo data, send to underwriting) are warned about in the
# message that offers them, and flagged gates ask their own "continue anyway?".
WORKFLOW_STEP_TOOLS = {
    "quick_start_workflow",
    "verify_e_application",
    "submit_agent_confidential_report",
    "run_compliance_screening",
    "override_compliance_screening",
    "run_insurance_history_check",
    "assess_medical_examination",
    "run_pre_underwriting_clearance",
    "run_risk_assessment",
    "approve_case",
    "run_pre_issuance_verification",
    "issue_policy",
    "confirm_policy_payment",
    "generate_group_quote",
    "resolve_group_endorsement",
}


def requires_confirmation(tool_name: str) -> bool:
    """The user's action request authorizes execution; no extra Yes/Cancel gate."""
    return False


# Args that are only required outside demo mode: a demo employer "pays" with a
# generated reference, a real one has to supply the bank's.
DEMO_OPTIONAL_ARGS = {"record_group_payment": {"reference"}, "settle_group_endorsement": {"reference"}}


# An argument that can be given by another one instead. A group scheme is found by company name OR by id — and after
# "which Demo Corporation?" the answer is the id, which must not be answered with "I need the organization name".
ARG_ALTERNATIVES: dict[str, tuple[str, ...]] = {
    "organization_name": ("organization_id",),
    # Demo data supplies the name itself (a generated company / family), so none has to be asked for.
    "name": ("use_demo_data",),
}


# How a missing required field is named to the user — never the raw arg name.
# Each reads naturally after "could you tell me …".
FIELD_LABELS: dict[str, str] = {
    "first_name": "the first name",
    "last_name": "the last name",
    "full_name": "the full name",
    "name": "the name",
    "cnic": "the CNIC (e.g. 35202-1234567-1)",
    "date_of_birth": "the date of birth (e.g. 14 March 1990)",
    "gender": "the gender",
    "occupation": "the occupation",
    "declared_income": "the annual income in PKR",
    "email": "the email address",
    "organization_name": "the organization name",
    "member_name": "the member's name",
    "customer_id": "which customer this is for",
    "identifier": "which record you mean (name, ID or CNIC)",
    "query": "what to search for",
    "record_type": "the kind of record",
    "page_name": "which page to open",
    "role_name": "the role",
    "assigned_user_name": "who to assign it to",
    "new_status": "the new status",
    "coverage_type": "the type of cover",
    "document_type": "the document type",
    "endorsement_type": "what to change on the policy",
    "exit_type": "how the policy should end (e.g. surrender or cancellation)",
    "comment": "the comment",
    "comment_text": "the comment",
    "description": "a short description",
    "title": "a title",
    "reason": "the reason",
    "symptom": "the symptom or issue",
    "evidence": "the evidence required",
    "reference": "the payment or transaction reference",
    "request_reference": "the request reference",
    "ticket_reference": "the ticket reference",
    "percent_of_base": "the percentage",
    "rule_set_code": "the rule set",
    "category_code": "the rule category",
    "subcategory_code": "the rule subcategory",
    "channel_code": "the sales channel",
    "customers_json": "the customer list",
    "results_json": "the results",
}

# What the user is doing, for "To <action>, I still need …".
TOOL_ACTIONS: dict[str, str] = {
    "add_customer": "register this customer",
    "update_customer": "update this customer",
    "add_organization": "add this organization",
    "add_family_group": "add this family",
    "add_user": "add this user",
    "update_user_role": "change this user's role",
    "set_user_active": "change this user's access",
    "create_case": "open the application",
    "create_proposal": "create the proposal",
    "assign_case": "assign this application",
}


def _join_words(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def missing_args_question(tool_name: str, args: dict, missing: list[str]) -> str:
    """A plain-language request for the fields missing_args found."""
    action = TOOL_ACTIONS.get(tool_name)
    who = " ".join(str(args[k]) for k in ("first_name", "last_name") if args.get(k)) or args.get("name") or args.get("full_name")
    if tool_name in {"add_customer", "update_customer"} and who:
        action = f"{'register' if tool_name == 'add_customer' else 'update'} {who}"
    labels = [FIELD_LABELS.get(field, field.replace("_", " ")) for field in missing]
    lead = f"To {action}, " if action else ""
    if len(labels) == 1:
        question = f"could you tell me {labels[0]}?"
        return lead + question if lead else question[0].upper() + question[1:]
    bullets = "\n".join(f"- {label[0].upper()}{label[1:]}" for label in (l.removeprefix("the ") for l in labels))
    return f"{lead or 'To continue, '}I still need a few details:\n\n{bullets}\n\nYou can send them all in one message."


def missing_args(tool_name: str, args: dict) -> list[str]:
    required = REQUIRED_ARGS.get(tool_name, [])
    optional = DEMO_OPTIONAL_ARGS.get(tool_name, set()) if is_demo() else set()
    return [
        r for r in required
        if r not in optional and not args.get(r) and not any(args.get(alt) for alt in ARG_ALTERNATIVES.get(r, ()))
    ]
