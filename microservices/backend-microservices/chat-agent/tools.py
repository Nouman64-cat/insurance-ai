"""Tool declarations for the conversational agent.

Declarations only — they are bound to the LLM so it can emit structured
tool_calls; the actual REST work lives in tool_executor.py, dispatched by
graph.py. Grouped below by capability:

  Navigation & discovery : navigate_to_page, show_record, search_records
  Read / list            : list_*, get_*
  Write / mutate         : add_*, create_*, update_*, delete_*, assign_case
  Workflow               : run_risk_assessment, get_workflow_recommendation,
                           quick_start_workflow

THE INSURANCE JOURNEY (the order these are normally called in):
  add_customer -> create_case -> create_proposal -> upload_document
  -> run_risk_assessment -> update_case_status -> close_case
"""

from __future__ import annotations

from typing import Literal, Optional

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from pages import PAGE_ROUTES

# Every value here must have a source in tool_executor._RECORD_SOURCES — the
# model treats this enum as a promise. Artifacts and assessments hang off a
# case, so they're reached through list_artifacts / get_risk_assessment instead.
RecordType = Literal[
    "lead", "customer", "case", "policy", "claim", "user", "organization",
    "family", "quote", "plan",
]

_AGENT_NAME_DESCRIPTION = (
    "Name or email of the Agent who owns this lead. Only needed when the caller "
    "isn't themselves an Agent — leave unset otherwise, the tool figures out who to ask. "
    "This MUST be a real Agent's name/email the user actually gave you — even for demo/test "
    "data, NEVER invent a placeholder like 'demo_agent' or 'Test Agent'."
)


# ═══════════════════════════════════════════════════════════════════════════
# Navigation & discovery
# ═══════════════════════════════════════════════════════════════════════════

class NavigateToPageArgs(BaseModel):
    page_name: str = Field(
        description="Exact page route. Must be one of: " + ", ".join(PAGE_ROUTES)
    )
    entity_id: Optional[str] = Field(
        default=None,
        description="Optional record id/CNIC to scroll to and highlight once the page loads.",
    )


@tool(args_schema=NavigateToPageArgs)
def navigate_to_page(page_name: str, entity_id: Optional[str] = None) -> str:
    """Navigate the user to any page in the application. Use this the moment the
    user expresses a navigation intent ("open cases", "take me to leads",
    "show the dashboard", "go to fraud detection"). Pass entity_id when you
    already know which record they want to land on."""
    return "{}"


class ShowRecordArgs(BaseModel):
    record_type: RecordType = Field(description="What kind of record to surface.")
    identifier: str = Field(
        description="Anything that identifies it — name, CNIC, lead ID (IND-2610-003, "
        "FAM-…, CORP-…), case number, policy number, claim number, email, "
        "organization name, or a raw id."
    )


@tool(args_schema=ShowRecordArgs)
def show_record(record_type: str, identifier: str) -> str:
    """Find one specific record, navigate to the page that lists it, and visually
    highlight it so the user can see exactly which row it is. Use this whenever
    the user asks to SEE, VIEW, FIND, OPEN or LOCATE a particular record
    ("show me Ahmed Khan", "where is application APP-2026-A3F9C1", "check lead
    IND-2610-003", "pull up that organization"). Prefer this over plain
    navigate_to_page when a specific record is named — it lands on the row,
    not just the list. If the identifier belongs to a different record type
    than the one asked for, the result says which type it actually is."""
    return "{}"


class SearchRecordsArgs(BaseModel):
    query: str = Field(description="Free-text search term.")
    record_type: Optional[RecordType] = Field(
        default=None, description="Restrict the search to one record type. Omit to search everything."
    )


@tool(args_schema=SearchRecordsArgs)
def search_records(query: str, record_type: Optional[str] = None) -> str:
    """Search across the platform and return matching records. Use when the user
    is looking for something but hasn't named it precisely enough to jump
    straight to it ("any customers called Ahmed?", "find cases for Malik")."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Read / list
# ═══════════════════════════════════════════════════════════════════════════

class ListLeadsArgs(BaseModel):
    record_scope: Literal["leads", "customers", "policyholders"] = Field(default="leads", description="Use policyholders for policy holders or customers with active coverage; leads for the Leads board; customers for all registered customers.")
    segment: Optional[Literal["individual", "family", "organization"]] = Field(default=None, description="Customer segment; used only with record_scope customers.")
    search: Optional[str] = Field(default=None, description="Filter by lead name, board ID, CNIC or contact.")
    lead_type: Optional[Literal["INDIVIDUAL", "FAMILY", "CORPORATE"]] = None
    sort: Literal["newest", "oldest"] = Field(default="newest", description="Order by date added. Rows come newest first, so 'most recent lead' is limit=1; 'first/oldest lead' needs sort=oldest.")
    brought_by: Optional[str] = Field(default=None, description="Acquisition source or assigned agent name/code, for 'leads brought by / from / sourced by X'. Not a lead-name search.")
    limit: int = Field(default=20, ge=1, le=100, description="Maximum rows shown; total counts all matching leads.")
    offset: int = Field(default=0, ge=0, description="Rows to skip for pagination.")


@tool(args_schema=ListLeadsArgs)
def list_leads(**kwargs) -> str:
    """Count and list leads from the Leads board, including individual, family
    and corporate leads. Use for 'how many leads do I have?' and 'show my leads'.
    Display the returned leads as a Markdown table, preserving the tool's columns
    and readable status_label/type_label values instead of raw database enums.
    Excludes converted policyholders. Customer counts are not lead counts.
    For registered customers, set record_scope to customers. For policyholders,
    ALWAYS set record_scope to policyholders; only active coverage qualifies."""
    return "{}"


class ListCustomersArgs(BaseModel):
    search: Optional[str] = Field(default=None, description="Filter by name or CNIC.")
    segment: Optional[Literal["individual", "family", "organization"]] = None
    limit: int = Field(default=10, description="Max rows to return.")


@tool(args_schema=ListCustomersArgs)
def list_customers(**kwargs) -> str:
    """List registered customers/applicants, optionally filtered."""
    return "{}"


class ListCasesArgs(BaseModel):
    status: Optional[
        Literal["New", "InProgress", "Pending Documents", "Under Review", "Approved", "Rejected", "Closed"]
    ] = None
    case_type: Optional[Literal["Underwriting", "Claim", "Inquiry"]] = None
    limit: int = Field(default=10)


@tool(args_schema=ListCasesArgs)
def list_cases(**kwargs) -> str:
    """List cases, optionally filtered by status or type. Use for questions like
    "what's pending?", "how many cases are under review?"."""
    return "{}"


class CaseLookupArgs(BaseModel):
    """Shared applicant/case lookup — any one field is enough to resolve it."""
    case_number: Optional[str] = None
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None


@tool(args_schema=CaseLookupArgs)
def get_case_details(**kwargs) -> str:
    """Look up the current application stage across the lead, proposal and
    underwriting case using fresh records. Use for "what stage is his case/application?".
    An application can be in Proposal Draft, Submitted or Under Review without an
    underwriting case. Also returns case details when one exists."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def get_document_checklist(**kwargs) -> str:
    """Show which documents a case requires, which have been received, and which
    are still missing. Call this BEFORE run_risk_assessment so the user knows
    upfront whether the assessment can actually proceed."""
    return "{}"


class ListArtifactsArgs(BaseModel):
    status: Optional[Literal["Processing", "Accepted", "Rejected"]] = None
    limit: int = Field(default=10)


@tool(args_schema=ListArtifactsArgs)
def list_artifacts(**kwargs) -> str:
    """List uploaded documents (artifacts) and their processing status."""
    return "{}"


class ListUsersArgs(BaseModel):
    role: Optional[str] = Field(default=None, description="Only users with this role. The role name exactly as the platform calls it: Admin, Underwriter, Medical Underwriter, Financial Underwriter, Agent, Broker, Bancassurance, ClaimsManager, ClaimsAdjuster, Finance or Viewer.")
    status: Optional[Literal["active", "inactive", "all"]] = Field(default="all", description="Active, inactive (deactivated) or all users.")
    search: Optional[str] = Field(default=None, description="Part of a name or email.")


@tool(args_schema=ListUsersArgs)
def list_users(**kwargs) -> str:
    """List the tenant's staff users with their role and whether they are active (Admin only). Filter by role,
    status or a name/email. Use it to see who exists, who can take work, or before changing a user."""
    return "{}"


class EmptyArgs(BaseModel):
    pass


class ListAcquisitionSourcesArgs(BaseModel):
    search: Optional[str] = Field(default=None, description="Filter by name, code, partner, contact or city.")
    source_type: Optional[Literal["AGENT", "BROKER", "BANCASSURANCE", "CORPORATE_AGENT", "DIRECT", "DIGITAL"]] = Field(
        default=None, description="DIRECT is shown to users as Walk-in.")
    status: Literal["active", "inactive", "all"] = Field(default="active", description="Active sources unless the user asks otherwise.")
    limit: int = Field(default=20, ge=1, le=50, description="Maximum rows shown; total counts all matching sources.")
    offset: int = Field(default=0, ge=0, description="Rows to skip for pagination.")


@tool(args_schema=ListAcquisitionSourcesArgs)
def list_acquisition_sources(**kwargs) -> str:
    """Count and list acquisition sources: the agents, brokers, bank desks and
    channels customers arrive through. Use for 'list acquisition sources', 'how many
    brokers do we have?'. Do NOT navigate to the page instead. Display the returned
    Markdown table as-is; when has_more is true, say how many remain and offer the
    next page (offset) or a filter rather than fetching everything."""
    return "{}"


@tool(args_schema=EmptyArgs)
def list_organizations() -> str:
    """List corporate / group-life client organizations."""
    return "{}"


@tool(args_schema=EmptyArgs)
def list_family_groups() -> str:
    """List family insurance groups."""
    return "{}"


@tool(args_schema=EmptyArgs)
def list_quotes() -> str:
    """List generated quotations / proposals. Display the returned Markdown table
    using insurance_type_label and status_label, never raw enums."""
    return "{}"


@tool(args_schema=EmptyArgs)
def list_insurance_plans() -> str:
    """List the insurance product catalogue — plan names, types, and eligibility
    bands. DO NOT call this before create_proposal (create_proposal fetches it automatically)."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def get_risk_assessment(**kwargs) -> str:
    """Fetch the AI risk assessment result for a case — medical score, financial
    score, fraud probability, composite score, and the decision with reasons."""
    return "{}"


@tool(args_schema=EmptyArgs)
def get_dashboard_stats() -> str:
    """Fetch top-level platform metrics: cases evaluated, portfolio risk index,
    premium collected, fraud savings, and decision distribution."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Write / mutate — customers
# ═══════════════════════════════════════════════════════════════════════════

class ResolveCustomerTypeArgs(BaseModel):
    keep_agent: Optional[bool] = Field(
        default=False,
        description="Set true ONLY when the user pressed 'Go back' to choose the customer type again "
        "(their message says keep_agent true) — the agent they already picked is kept instead of asked again.",
    )


@tool(args_schema=ResolveCustomerTypeArgs)
def resolve_customer_type(**kwargs) -> str:
    """Call this FIRST whenever the user asks to add/register a new customer but hasn't
    said whether it's an Individual, a Corporate (Organization), or a Family group. Presents
    the three as clickable buttons and its result tells you which of add_customer /
    add_organization / add_family_group to call next. Never ask this question yourself in
    plain text — always call this tool. If the user pressed 'Go back' to choose the type
    again, call it with keep_agent=true."""
    return "{}"


class AddCustomerArgs(BaseModel):
    first_name: str
    last_name: str = Field(description="If only one name is known, reuse it here.")
    cnic: str = Field(description="Format XXXXX-XXXXXXX-X.")
    date_of_birth: str = Field(description="YYYY-MM-DD.")
    gender: Literal["Male", "Female", "Other"]
    occupation: str
    declared_income: float
    is_smoker: Optional[bool] = None
    height_cm: Optional[float] = None
    weight_kg: Optional[float] = None
    agent_name: Optional[str] = Field(default=None, description=_AGENT_NAME_DESCRIPTION)


@tool(args_schema=AddCustomerArgs)
def add_customer(**kwargs) -> str:
    """Register a new customer/applicant. First step of the insurance journey. If the caller is an
    Agent, the lead is auto-assigned to them. Otherwise the tool will ask who the agent is — don't
    pre-ask for agent_name yourself, let the tool's response drive that."""
    return "{}"


class UpdateCustomerArgs(BaseModel):
    send_to_draft: bool = Field(default=False, description="Set true for send draft / move lead to proposals. Creates a draft proposal without opening or advancing an underwriting case.")
    cnic: Optional[str] = None
    name: Optional[str] = None
    occupation: Optional[str] = None
    declared_income: Optional[float] = None
    is_smoker: Optional[bool] = None
    height_cm: Optional[float] = None
    weight_kg: Optional[float] = None


@tool(args_schema=UpdateCustomerArgs)
def update_customer(**kwargs) -> str:
    """Update an existing customer's details. Identify them by cnic or name, then
    pass only the fields that change. For send draft / send to proposals, set
    send_to_draft=true. This is the Leads page Create Proposal action, not create_case."""
    return "{}"


class DeleteCustomerArgs(BaseModel):
    cnic: Optional[str] = None
    name: Optional[str] = None


@tool(args_schema=DeleteCustomerArgs)
def delete_customer(**kwargs) -> str:
    """Attempt to delete a customer. Note: Customer records cannot be deleted because we must maintain records for future use and audit compliance."""
    return "{}"


class BulkAddCustomersArgs(BaseModel):
    customers_json: str = Field(
        description="JSON array string. Each object: first_name, last_name, cnic, "
        "date_of_birth, gender, occupation, declared_income, is_smoker, height_cm, weight_kg."
    )


@tool(args_schema=BulkAddCustomersArgs)
def bulk_add_customers(**kwargs) -> str:
    """Add many customers in one call."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Write / mutate — users, organizations, families
# ═══════════════════════════════════════════════════════════════════════════

class AddUserArgs(BaseModel):
    full_name: str
    email: str
    role_name: str = Field(description="The role name exactly as the platform calls it: Admin, Underwriter, Medical Underwriter, Financial Underwriter, Agent, Broker, Bancassurance, ClaimsManager, ClaimsAdjuster, Finance or Viewer. SuperAdmin cannot be given here.")


@tool(args_schema=AddUserArgs)
def add_user(**kwargs) -> str:
    """Add a new staff user to this tenant with any role, e.g. a Medical Underwriter when no one can take a
    medical review (Admin only). Their username and a temporary password are emailed to them."""
    return "{}"


class UpdateUserRoleArgs(BaseModel):
    user: str = Field(description="The user's email or full name, or \"me\" for the signed-in user's own account.")
    role_name: str = Field(description="The new role. The role name exactly as the platform calls it: Admin, Underwriter, Medical Underwriter, Financial Underwriter, Agent, Broker, Bancassurance, ClaimsManager, ClaimsAdjuster, Finance or Viewer.")


@tool(args_schema=UpdateUserRoleArgs)
def update_user_role(**kwargs) -> str:
    """Change an existing user's role (Admin only), e.g. make an Underwriter a Medical Underwriter."""
    return "{}"


class SetUserActiveArgs(BaseModel):
    user: str = Field(description="The user's email or full name, or \"me\" for the signed-in user's own account.")
    active: bool = Field(description="False to deactivate (they can no longer sign in, history kept), True to reactivate.")


@tool(args_schema=SetUserActiveArgs)
def set_user_active(**kwargs) -> str:
    """Deactivate or reactivate a user's account (Admin only). Prefer this over delete_user when someone leaves
    or is on leave: it is reversible and keeps their history."""
    return "{}"


class DeleteUserArgs(BaseModel):
    email: Optional[str] = Field(default=None, description="The user's email, or \"me\" for the signed-in user.")
    full_name: Optional[str] = None


@tool(args_schema=DeleteUserArgs)
def delete_user(**kwargs) -> str:
    """Remove a user's account for good (Admin only). If they may come back, use set_user_active instead."""
    return "{}"


class AddOrganizationArgs(BaseModel):
    name: Optional[str] = Field(default=None, description="The company name. Not needed with use_demo_data.")
    contact_person: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    agent_name: Optional[str] = Field(default=None, description=_AGENT_NAME_DESCRIPTION)
    use_demo_data: bool = Field(
        default=False,
        description="Demo mode only: generate a complete demo corporate — a company, its Group Life policy, benefit "
        "classes and 10 employees — and enrol it. Pass NO name and make nothing up yourself.",
    )


@tool(args_schema=AddOrganizationArgs)
def add_organization(**kwargs) -> str:
    """Add a corporate / group-life client organization."""
    return "{}"


class FamilyMember(BaseModel):
    """One person in the household. Only the head ("Self") and — if the family chooses — the spouse are
    insured; everyone else is a nominee who receives a share of the head's death benefit."""
    relationship: Literal["Self", "Spouse", "Child", "Parent", "Sibling", "Other"]
    name: str
    is_insured: Optional[bool] = Field(
        default=None,
        description="Self is always insured. A Spouse is insured only if the family wants them fully covered "
        "(then they are underwritten too). Children, parents and others are never insured.",
    )
    share_pct: Optional[float] = Field(
        default=None, description="Their share of the head's death benefit, in %. Every member except Self needs one; all shares total 100.",
    )
    # Required only for insured members (the head, an insured spouse):
    cnic: Optional[str] = None
    dob: Optional[str] = None
    gender: Optional[Literal["Male", "Female", "Other"]] = None
    occupation: Optional[str] = None
    declared_income: Optional[float] = None
    is_smoker: Optional[bool] = None
    height_cm: Optional[float] = None
    weight_kg: Optional[float] = None


class PrepareFamilyInsuranceArgs(BaseModel):
    customer_id: str = Field(description="Existing customer's UUID. Reuse the customer's identity instead of creating another person.")

@tool(args_schema=PrepareFamilyInsuranceArgs)
def prepare_family_insurance(**kwargs) -> str:
    """Prepare family insurance for an existing individual customer without changing their current proposal. Opens a prefilled review form."""
    return ""


class AddFamilyGroupArgs(BaseModel):
    name: str
    contact_person: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    household_declared_income: Optional[float] = None
    agent_name: Optional[str] = Field(default=None, description=_AGENT_NAME_DESCRIPTION)
    members: Optional[list[FamilyMember]] = Field(
        default=None,
        description="Members to enroll. Exactly one must be 'Self'. Ask which relatives are nominees and what share "
        "of the death benefit each gets (they total 100%); ask whether the spouse is also fully insured.",
    )
    use_demo_data: bool = Field(
        default=False,
        description="Generate a realistic, randomly-varied demo family (name, members, CNICs, "
        "incomes) instead of the caller inventing member details themselves — set this instead of "
        "writing member data by hand whenever the user says 'demo'/'test data'/'make something up' "
        "for a family. Each call produces a different family, never the same names/CNICs twice.",
    )


@tool(args_schema=AddFamilyGroupArgs)
def add_family_group(**kwargs) -> str:
    """Add a family insurance group, optionally enrolling members into a floater
    policy at the same time."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Write / mutate — cases & policies
# ═══════════════════════════════════════════════════════════════════════════

class CreateCaseArgs(BaseModel):
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None
    case_type: Optional[Literal["Underwriting", "Claim", "Inquiry"]] = None
    priority_level: Optional[Literal["Low", "Normal", "High", "Critical"]] = None


@tool(args_schema=CreateCaseArgs)
def create_case(**kwargs) -> str:
    """Open a case for an existing customer so underwriting can proceed. Second
    step of the journey, straight after add_customer."""
    return "{}"


class UpdateCaseStatusArgs(BaseModel):
    case_number: Optional[str] = None
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None
    new_status: Literal[
        "New", "InProgress", "Pending Documents", "Under Review", "Approved", "Rejected", "Closed"
    ]
    notes: Optional[str] = None


@tool(args_schema=UpdateCaseStatusArgs)
def update_case_status(**kwargs) -> str:
    """Move a case along its lifecycle:
    New -> InProgress -> Pending Documents / Under Review -> Approved | Rejected -> Closed.
    Use for "approve this", "decline it", "put it under review", "close the case"."""
    return "{}"


class AssignCaseArgs(BaseModel):
    case_number: Optional[str] = None
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None
    assigned_user_name: str = Field(description="Name of the underwriter/agent to assign.")
    assigned_role: Literal["Underwriter", "Analyst", "Manager", "Coordinator", "Reviewer"] = "Underwriter"


@tool(args_schema=AssignCaseArgs)
def assign_case(**kwargs) -> str:
    """Assign a case to a specific user so they can start work on it."""
    return "{}"


class AddCommentArgs(BaseModel):
    case_number: Optional[str] = None
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None
    comment_text: str
    comment_type: Literal["Internal", "External"] = "Internal"


@tool(args_schema=AddCommentArgs)
def add_case_comment(**kwargs) -> str:
    """Add a note/comment to a case for documentation or team hand-off."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def delete_case(**kwargs) -> str:
    """Delete a case and all of its child records."""
    return "{}"


class CreateProposalArgs(BaseModel):
    cnic: Optional[str] = None
    applicant_name: Optional[str] = None
    product_name: Optional[str] = Field(default=None, description="LEAVE EMPTY unless explicitly selected. Output 'auto' if the user asks you to pick any generic plan.")
    insurance_type: Optional[
        Literal["TERM_LIFE", "WHOLE_LIFE", "ENDOWMENT", "CHILD_EDUCATION_MARRIAGE",
                "GROUP_LIFE", "SAVINGS", "SINGLE_PREMIUM", "HEALTH_CASH"]
    ] = None
    coverage_amount: Optional[float] = Field(default=None, description="LEAVE EMPTY unless user explicitly specified it. Defaults to 5,000,000 PKR.")
    term_years: Optional[int] = Field(default=None, description="LEAVE EMPTY unless user explicitly specified it. Defaults to 10 years.")
    additional_proposal: bool = Field(default=False, description="True only when the user explicitly asked for "
                                      "another proposal although one for this product is already open.")


@tool(args_schema=CreateProposalArgs)
def create_proposal(**kwargs) -> str:
    """Create the insurance proposal/policy that defines product, coverage and
    term. Required before a risk assessment can run."""
    return "{}"


class UploadDocumentArgs(BaseModel):
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None
    case_number: Optional[str] = Field(
        default=None,
        description="The case's number if you already know it (e.g. from a recent tool result) — "
        "more reliable than cnic/applicant_name for finding the right case.",
    )
    document_type: str = Field(description="e.g. CNIC, Salary Slip, Bank Statement, Medical Report.")


@tool(args_schema=UploadDocumentArgs)
def upload_document(**kwargs) -> str:
    """Attach a document to a customer's case. Always executed browser-side —
    only the browser holds the File object (see permission.CLIENT_EXECUTED_TOOLS)."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def run_risk_assessment(**kwargs) -> str:
    """Run the AI underwriting evaluation — medical, financial and fraud scoring
    via the LangGraph risk engine — and record the composite decision.
    Requires the case to already have a proposal and its required documents."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Policy lifecycle — approve, issue, activate (steps 5–7)
# ═══════════════════════════════════════════════════════════════════════════

class ApproveCaseArgs(CaseLookupArgs):
    bypass_prerequisites: bool = Field(default=False, description="Demo mode only, and only after the user chose "
                                       "'continue anyway'. Ignored outside demo mode.")


@tool(args_schema=ApproveCaseArgs)
def approve_case(**kwargs) -> str:
    """Approve a case after risk assessment. This moves the case to 'Approved'
    status and it appears in the Policy Issuance queue. Use when the user says
    "approve this case", "approve it", "mark as approved"."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def get_pre_issuance_status(**kwargs) -> str:
    """Fetch the pre-issuance readiness checklist for a case's policy. Shows the
    4-step verification status: revised terms, requirements, compliance, and
    beneficiaries. Use when the user asks "check issuance status" or "is it
    ready to issue?"."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def run_pre_issuance_verification(**kwargs) -> str:
    """Automatically run and clear all 4 pre-issuance verification steps:
    seed/verify requirements, run/clear compliance checks. Use when the user
    says "run verification", "verify for issuance", "complete pre-issuance
    checks"."""
    return "{}"


class IssuePolicyArgs(BaseModel):
    case_number: Optional[str] = None
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None


@tool(args_schema=IssuePolicyArgs)
def issue_policy(**kwargs) -> str:
    """Draft the policy contract — assign a policy number, generate documents,
    compute the premium, and move to PendingPayment. Use when the user says
    "issue the policy", "draft the contract", "bind coverage"."""
    return "{}"


class ConfirmPaymentArgs(BaseModel):
    case_number: Optional[str] = None
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None
    payment_method: Optional[str] = Field(default=None, description="Payment method code, e.g. 'JazzCash', 'BankTransfer'. Defaults to JazzCash.")


@tool(args_schema=ConfirmPaymentArgs)
def confirm_policy_payment(**kwargs) -> str:
    """Confirm the first premium payment, activating coverage. The policy moves
    from PendingPayment to Active, the case is closed, and the customer is
    promoted to Policyholder. Use when the user says "confirm payment",
    "activate the policy", "complete payment"."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def get_active_policy_status(**kwargs) -> str:
    """Check the status of an active policy in the post-issuance section. Shows
    coverage details, documents, and management options. Use when the user asks
    "show the active policy", "is it active?", "check post-issuance status"."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Workflow guidance
# ═══════════════════════════════════════════════════════════════════════════

class GetRecommendationArgs(CaseLookupArgs):
    action_context: Optional[str] = Field(
        default=None,
        description="Where the user is in the journey, e.g. 'customer added', "
        "'case created', 'assessment complete'. Only used when no application is named.",
    )


@tool(args_schema=GetRecommendationArgs)
def get_workflow_recommendation(**kwargs) -> str:
    """Work out the best next step. When an application is named (case_number, cnic or
    applicant_name) the recommendation comes from its live state — stage, blockers and
    the legal next actions — so always pass one when it is known."""
    return "{}"


class StartJourneyArgs(BaseModel):
    """Identify the applicant (existing customer OR full registration details)
    plus optional product terms. Everything else is autonomous."""
    cnic: Optional[str] = None
    applicant_name: Optional[str] = None
    # Registration fields — only needed when the applicant isn't a customer yet.
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    date_of_birth: Optional[str] = None
    gender: Optional[Literal["Male", "Female", "Other"]] = None
    occupation: Optional[str] = None
    declared_income: Optional[float] = None
    # Product terms — sensible defaults apply when omitted.
    product_name: Optional[str] = None
    insurance_type: Optional[
        Literal["TERM_LIFE", "WHOLE_LIFE", "ENDOWMENT", "CHILD_EDUCATION_MARRIAGE",
                "GROUP_LIFE", "SAVINGS", "SINGLE_PREMIUM", "HEALTH_CASH"]
    ] = None
    coverage_amount: Optional[float] = None
    term_years: Optional[int] = None


@tool(args_schema=StartJourneyArgs)
def start_underwriting_journey(**kwargs) -> str:
    """Run the FULL autonomous underwriting pipeline end-to-end for one
    applicant: intake → case → proposal → document audit → AI risk assessment
    → decision → closure. It drives every stage itself, pausing only when
    documents are missing or a human underwriting decision is required.

    CALL IMMEDIATELY with just applicant_name or cnic — the pipeline looks the
    customer up itself and only reports back if they truly don't exist. Do NOT
    ask the user for date of birth / income / product details first; every
    registration and product field is optional with sensible defaults.

    Use when the user wants the whole process handled ("process this
    application", "underwrite Fatima start to finish", "run the journey")
    rather than one step at a time."""
    return "{}"


class ContinueJourneyArgs(BaseModel):
    note: Optional[str] = Field(default=None, description="Optional context, e.g. 'documents uploaded' or 'case approved'.")


@tool(args_schema=ContinueJourneyArgs)
def continue_underwriting_journey(**kwargs) -> str:
    """Resume a suspended underwriting journey after its blocker is cleared —
    documents uploaded, or a human approve/reject recorded. Re-enters the
    pipeline exactly where it stopped and keeps driving to closure."""
    return "{}"


class BulkJourneyArgs(BaseModel):
    cnics: list[str] = Field(description="List of CNICs to process.")


@tool(args_schema=BulkJourneyArgs)
def bulk_underwriting_journey(**kwargs) -> str:
    """Run the autonomous underwriting pipeline for MULTIPLE customers in bulk.
    Use this when the user asks to process a batch of customers, create cases
    and proposals for multiple people, or run bulk risk assessments."""
    return "{}"


class QuickStartArgs(BaseModel):
    use_demo_data: bool = Field(
        default=True,
        description="Generate a realistic demo applicant instead of asking the user to type one.",
    )
    full_journey: bool = Field(
        default=False,
        description="Run the whole journey end to end — customer, case, proposal, "
        "then assessment — rather than stopping after the customer.",
    )
    applicant_name: Optional[str] = Field(
        default=None,
        description="Optional specific name to use for the demo customer, instead of a random one."
    )
    agent_name: Optional[str] = Field(default=None, description=_AGENT_NAME_DESCRIPTION)


@tool(args_schema=QuickStartArgs)
def quick_start_workflow(**kwargs) -> str:
    """Spin up a demo applicant with realistic auto-generated details so the user
    can exercise the platform without typing data. Use whenever they say
    "demo", "test data", "sample", "generic data", "just make something up",
    or "show me how this works". With full_journey=true it also creates the
    case and proposal and kicks off the assessment."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Pre-Underwriting clearance (the 5 gates before risk assessment)
# ═══════════════════════════════════════════════════════════════════════════

@tool(args_schema=CaseLookupArgs)
def get_pre_underwriting_status(**kwargs) -> str:
    """Fetch the status of the 5 pre-underwriting clearance gates for a case:
    1. E-Application (customer medical/lifestyle form)
    2. Agent's Confidential Report (ACR - moral hazard & KYC)
    3. Compliance Screening (PEP, Sanctions, AML, SECP)
    4. SECP Insurance History (HLV & cumulative exposure)
    5. Medical Examination (Non-Medical Limit NML grid & panel clinics)
    The rule-defined upfront premium is collected before underwriting. At issuance, credit that receipt and collect only the outstanding balance, including any underwriting loading.
    Use when the user asks "check pre-underwriting status", "are gates cleared?",
    "what's pending before risk assessment?"."""
    return "{}"


class VerifyEApplicationArgs(BaseModel):
    case_number: Optional[str] = None
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None
    action: Optional[Literal["invite", "verify", "auto_submit"]] = Field(
        default="invite",
        description="Action to take: 'invite' generates the customer form link for the customer to fill (default). 'verify' marks a submitted form as verified. 'auto_submit' fills & submits demo e-application for automated tests."
    )


@tool(args_schema=VerifyEApplicationArgs)
def verify_e_application(**kwargs) -> str:
    """Gate 1: Customer E-Application. Generates the tokenized public form link (http://localhost:3000/e-application/<token>) for the customer to fill and sign their medical questionnaire & declarations, or verifies a submitted application."""
    return "{}"


class GateRunArgs(CaseLookupArgs):
    """CaseLookupArgs plus the demo "continue anyway" flag, for gates that warn when an earlier one is incomplete."""
    bypass_prerequisites: Optional[bool] = Field(
        default=False,
        description="Set true ONLY when the user has just confirmed they want to continue anyway "
        "(clicked 'Yes, continue anyway') past a warning that an earlier step isn't done. Never set it on a first request.",
    )


class SubmitACRArgs(BaseModel):
    case_number: Optional[str] = None
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None
    recommendation: Optional[Literal["Recommend", "RecommendWithCaution", "DoNotRecommend", "STANDARD_RISK"]] = "Recommend"
    remarks: Optional[str] = "Applicant verified in person. Moral hazard and financial standing satisfactory."
    bypass_prerequisites: Optional[bool] = Field(
        default=False,
        description="Set true ONLY when the user has just confirmed they want to continue anyway "
        "(clicked 'Yes, continue anyway') past a warning that an earlier step isn't done. Never set it on a first request.",
    )


@tool(args_schema=SubmitACRArgs)
def submit_agent_confidential_report(**kwargs) -> str:
    """Gate 2: File the Agent's Confidential Report (ACR). Call this immediately when asked — do NOT ask the user for recommendation/remarks first, the tool itself decides what happens: it opens the real ACR form in the UI for the case's Agent to fill and sign, or — for anyone else — sends an ACR request to the case's acquisition source (agent, broker, bank desk…), who files it from the agent app. When they submit, the chat is told automatically and the workflow moves on to Gate 3; do not poll or ask the user to confirm the submission."""
    return "{}"


@tool(args_schema=GateRunArgs)
def run_compliance_screening(**kwargs) -> str:
    """Gate 3: Run automated PEP, Sanctions, AML, and SECP compliance screening for the pre-underwriting case. If it comes back Flagged, do not treat that as an error — offer to proceed anyway."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def override_compliance_screening(**kwargs) -> str:
    """Gate 3 override: clears a Flagged compliance screening result and proceeds, after the user explicitly confirms (e.g. clicks 'Proceed Anyway'). Only call this when the user has confirmed they want to proceed despite the flag."""
    return "{}"


@tool(args_schema=GateRunArgs)
def run_insurance_history_check(**kwargs) -> str:
    """Gate 4: Run the SECP shared industry insurance history screen, checking cumulative sum assured against HLV and policy churning."""
    return "{}"


class AssessMedicalExamArgs(BaseModel):
    case_number: Optional[str] = None
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None
    bypass_prerequisites: Optional[bool] = Field(
        default=False,
        description="Set true ONLY when the user has just confirmed they want to continue anyway "
        "(clicked 'Yes, continue anyway') past a warning that an earlier step isn't done. Never set it on a first request.",
    )


@tool(args_schema=AssessMedicalExamArgs)
def assess_medical_examination(**kwargs) -> str:
    """Gate 5: Assess the applicant against the Non-Medical Limit (NML) grid. If diagnostics are mandated, generates the customer's tokenized panel-clinic booking link (same as Gate 1's E-Application link) — the gate clears once the customer books and completes the exam, not immediately."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def run_pre_underwriting_clearance(**kwargs) -> str:
    """Run all 5 pre-underwriting clearance gates in sequence (E-Application, ACR, Compliance, Insurance History, Medical Exam) so the case is 100% ready for AI Risk Assessment. Use when the user says "clear all gates", "run pre-underwriting", "complete pre-underwriting checks"."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Rules engine — versioned underwriting governance
# ═══════════════════════════════════════════════════════════════════════════

@tool(args_schema=EmptyArgs)
def list_rule_categories() -> str:
    """List the rule catalogue hierarchy: Category -> SubCategory -> Eligibility
    Profile (channel). Use to find out what governance domains exist before
    looking at individual rule sets."""
    return "{}"


class ListRuleSetsArgs(BaseModel):
    category: Optional[str] = Field(default=None, description="Category code filter, e.g. MEDICAL_NML.")
    channel: Optional[str] = Field(default=None, description="Channel code filter, e.g. AGENCY_DIRECT.")


@tool(args_schema=ListRuleSetsArgs)
def list_rule_sets(**kwargs) -> str:
    """List underwriting rule sets with their active version and rule count.
    Use for "what rules do we have?", "show the NML rules", "list rule sets"."""
    return "{}"


class RuleSetLookupArgs(BaseModel):
    rule_set_code: str = Field(description="Rule set code, e.g. medical.nml_grid or commission.secp_rate_card.")


@tool(args_schema=RuleSetLookupArgs)
def get_rule_set(**kwargs) -> str:
    """Show one rule set in full — every version, its status (DRAFT/ACTIVE/
    ARCHIVED), and the rules and criteria inside the active version."""
    return "{}"


class EvaluateRuleArgs(BaseModel):
    rule_set_code: str = Field(description="Which rule set to run, e.g. medical.nml_grid.")
    context_json: str = Field(
        description='JSON object of input facts, e.g. {"age": 45, "sum_assured": 5000000}. '
        "Field names must match the rule criteria."
    )


@tool(args_schema=EvaluateRuleArgs)
def evaluate_rule_set(**kwargs) -> str:
    """Dry-run one rule set against a set of facts and show which rule matched
    and what it decided. Nothing is changed — this is the simulator. Use for
    "what happens if a 45-year-old asks for 5 million?"."""
    return "{}"


class EvaluateScopeArgs(BaseModel):
    category: Optional[str] = None
    subcategory: Optional[str] = None
    channel: Optional[str] = None
    context_json: str = Field(description="JSON object of input facts.")


@tool(args_schema=EvaluateScopeArgs)
def evaluate_rule_scope(**kwargs) -> str:
    """Run EVERY rule set in a category/subcategory/channel against the same
    facts and show the combined outcome. Use when the question is "what would
    the whole rulebook do with this applicant?" rather than one rule set."""
    return "{}"


class RuleLogsArgs(BaseModel):
    limit: int = Field(default=20, description="How many recent evaluations to show.")


@tool(args_schema=RuleLogsArgs)
def get_rule_evaluation_logs(**kwargs) -> str:
    """Show the rule-engine audit trail — recent evaluations, which rules
    matched, and what they decided."""
    return "{}"


class CreateRuleSetArgs(BaseModel):
    intent: str = Field(description="What the user wants to do, e.g. 'Create a new rule set'")
    code: Optional[str] = Field(default=None, description="Dotted lowercase code, e.g. claims.death_benefit.")
    name: Optional[str] = None
    description: Optional[str] = None
    category_code: Optional[str] = Field(default=None, description="Existing category code to file it under.")
    subcategory_code: Optional[str] = None
    channel_code: Optional[str] = None


@tool(args_schema=CreateRuleSetArgs)
def create_rule_set(**kwargs) -> str:
    """Create a new rule set. It starts with an empty DRAFT version — add rules
    to it, then deploy."""
    return "{}"


@tool(args_schema=RuleSetLookupArgs)
def create_rule_version(**kwargs) -> str:
    """Open a new DRAFT version of a rule set, copying the current active rules
    as a starting point. Rules can only be edited in a DRAFT — this is the first
    step of any rule change."""
    return "{}"


class AddRuleArgs(BaseModel):
    intent: str = Field(description="What the user wants to do, e.g. 'Add rule'")
    rule_set_code: Optional[str] = None
    rule_code: Optional[str] = Field(default=None, description="Short uppercase code, e.g. MED-NML-07.")
    name: Optional[str] = None
    priority: Optional[int] = Field(default=None, description="Lower number runs first.")
    conditions_json: Optional[str] = Field(
        default=None, description='JSON array of criteria, e.g. [{"field":"age","operator":"gte","value":61}].'
    )
    action_outcome: Optional[str] = Field(default=None, description="e.g. REQUIRE_MEDICAL_EXAM, APPLY_COMMISSION_RATE, DECLINE.")
    outcome_json: Optional[str] = Field(default=None, description="JSON impact payload for the outcome.")


@tool(args_schema=AddRuleArgs)
def add_rule_to_version(**kwargs) -> str:
    """Add a rule to the rule set's DRAFT version. Fails if there is no draft —
    call create_rule_version first."""
    return "{}"


class UpdateRuleArgs(BaseModel):
    intent: str = Field(description="What the user wants to do, e.g. 'Update rule'")
    rule_set_code: Optional[str] = None
    rule_code: Optional[str] = None
    name: Optional[str] = None
    priority: Optional[int] = None
    is_active: Optional[bool] = None
    conditions_json: Optional[str] = None
    action_outcome: Optional[str] = None
    outcome_json: Optional[str] = None


@tool(args_schema=UpdateRuleArgs)
def update_rule(**kwargs) -> str:
    """Change a rule inside the DRAFT version. Pass only the fields that change."""
    return "{}"


class DeleteRuleArgs(BaseModel):
    intent: str = Field(description="What the user wants to do, e.g. 'Delete rule'")
    rule_set_code: Optional[str] = None
    rule_code: Optional[str] = None


@tool(args_schema=DeleteRuleArgs)
def delete_rule(**kwargs) -> str:
    """Remove a rule from the DRAFT version."""
    return "{}"


@tool(args_schema=RuleSetLookupArgs)
def deploy_rule_version(**kwargs) -> str:
    """Make the rule set's DRAFT version ACTIVE. THIS CHANGES UNDERWRITING
    BEHAVIOUR for every case evaluated afterwards — always tell the user which
    rule set and version number is going live before calling it."""
    return "{}"


@tool(args_schema=RuleSetLookupArgs)
def archive_rule_version(**kwargs) -> str:
    """Archive the rule set's currently active version, retiring it."""
    return "{}"


class ParseAndCreateFullRuleArgs(BaseModel):
    category_name: str = Field(description="Name of the category to create or find")
    subcategory_name: str = Field(description="Name of the subcategory to create or find")
    rule_set_name: str = Field(description="Name of the rule set to create or find")
    conditions_json: str = Field(description='JSON array of Criteria. Example: [{"group_id": 1, "field_name": "age", "operator": "gt", "value_numeric": 50}]')
    action_outcome: str = Field(description="Impact type, e.g., REQUIRE_MEDICAL, AUTO_APPROVE, DECLINE")
    outcome_json: Optional[str] = Field(default=None, description='JSON object of outcome parameters. Example: {"is_terminal": true, "medical_profile_codes": ["MER"]}')
    deploy_now: bool = Field(default=True, description="Whether to automatically deploy the rule set after adding the rule")

@tool(args_schema=ParseAndCreateFullRuleArgs)
def parse_and_create_full_rule(**kwargs) -> str:
    """Use this tool ONLY when the user provides all rule details in text (e.g. category, subcategory, rule set, conditions, and impacts). This will parse the text and fully create/deploy the rule hierarchy silently."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Rules catalogue authoring — Category -> SubCategory -> EligibilityProfile
#
# A rule set cannot exist without a subcategory to hang off, and a subcategory
# cannot exist without a category. Rather than telling the user "create a
# category first", the agent offers to create the missing level itself — these
# are the tools that let it.
# ═══════════════════════════════════════════════════════════════════════════

class CreateRuleCategoryArgs(BaseModel):
    intent: str = Field(description="What the user wants to do, e.g. 'Create category'")
    code: Optional[str] = Field(default=None, description="UPPER_SNAKE code, e.g. CLAIMS_GOVERNANCE.")
    name: Optional[str] = Field(default=None, description="Human-readable name, e.g. Claims Governance.")
    description: Optional[str] = None


@tool(args_schema=CreateRuleCategoryArgs)
def create_rule_category(**kwargs) -> str:
    """Create a new top-level rule CATEGORY in the catalogue. Use when the user
    wants to file rules under a governance domain that does not exist yet."""
    return "{}"


class CreateRuleSubcategoryArgs(BaseModel):
    intent: str = Field(description="What the user wants to do, e.g. 'Create subcategory'")
    category_code: Optional[str] = Field(default=None, description="Existing category code to nest under.")
    code: Optional[str] = Field(default=None, description="UPPER_SNAKE code, e.g. DEATH_BENEFIT.")
    name: Optional[str] = None


@tool(args_schema=CreateRuleSubcategoryArgs)
def create_rule_subcategory(**kwargs) -> str:
    """Create a SubCategory inside an existing rule category. Rule sets attach to
    subcategories, so this is the level a new rule set needs."""
    return "{}"


class CreateEligibilityProfileArgs(BaseModel):
    category_code: Optional[str] = None
    subcategory_code: Optional[str] = None
    channel_code: Optional[str] = Field(default=None, description="e.g. AGENCY_DIRECT, BANCA_MCB, WINDOW_TAKAFUL.")
    min_entry_age: Optional[int] = 18
    max_entry_age: Optional[int] = 65
    max_maturity_age: Optional[int] = 75
    min_sum_assured: Optional[float] = 500000.0


@tool(args_schema=CreateEligibilityProfileArgs)
def create_eligibility_profile(**kwargs) -> str:
    """Add a distribution-channel eligibility profile to a subcategory so rule
    sets can be scoped to that channel."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Claims — FNOL intake, adjuster workbench, adjudication, payout, recovery
#
# The claims lifecycle mirrors the underwriting one: an intake step, a set of
# gates (documents, manager authority, contestability), a decision, and a
# money movement. Every tool below resolves a claim by its CLAIM NUMBER
# (CLM-2026-0001) or the claimant's name — never a raw UUID, because that is
# what a human says and what the model can echo back.
# ═══════════════════════════════════════════════════════════════════════════

ClaimStatusLiteral = Literal[
    "New", "Triaged", "Under Investigation", "Pending Documents",
    "Approved", "Partial Approval", "Declined", "Referred to Manager",
    "Reinsurance Referred", "Re-Underwriting Required", "Settled", "Closed",
]


class ListClaimsArgs(BaseModel):
    status: Optional[str] = Field(default=None, description='Filter by claim status, e.g. "New", "Under Investigation".')
    claim_type: Optional[str] = Field(default=None, description="Hospitalization, Surgery, Death Claim or Reimbursement.")
    search: Optional[str] = Field(default=None, description="Claim number, claimant name or policy number.")


@tool(args_schema=ListClaimsArgs)
def list_claims(**kwargs) -> str:
    """List claims in the claims workbench, optionally filtered by status, type
    or a search term. Use for "show me open claims", "any death claims?",
    "what is pending with the adjusters?"."""
    return "{}"


class ClaimLookupArgs(BaseModel):
    claim_number: Optional[str] = Field(default=None, description="e.g. CLM-2026-0001.")
    claimant_name: Optional[str] = Field(default=None, description="Claimant / policyholder name, when the number isn't known.")


@tool(args_schema=ClaimLookupArgs)
def get_claim_details(**kwargs) -> str:
    """Full claim file — status, amounts, fraud and duplicate flags, documents
    on record, status history and payouts, plus what the next legal move is."""
    return "{}"


@tool(args_schema=EmptyArgs)
def get_claims_dashboard() -> str:
    """Portfolio view of claims: counts by status, total submitted vs settled,
    how many are blocked on documents, and what needs a manager. Use for
    "how are claims doing?", "claims summary", "what needs my attention?"."""
    return "{}"


@tool(args_schema=ClaimLookupArgs)
def get_claim_document_checklist(**kwargs) -> str:
    """Which claim documents are on file and which are still missing for this
    claim type. ALWAYS call this before approving or settling — the platform
    hard-blocks both without at least one verified document."""
    return "{}"


class RegisterClaimArgs(BaseModel):
    policy_number: Optional[str] = Field(default=None, description="Policy the claim is against, e.g. POL-2026-000123.")
    claimant_name: Optional[str] = Field(default=None, description="Policyholder name, when the policy number isn't known.")
    cnic: Optional[str] = Field(default=None, description="Policyholder CNIC, when the policy number isn't known.")
    claim_type: Optional[str] = Field(default=None, description="Hospitalization, Surgery, Death Claim or Reimbursement.")
    submitted_amount: Optional[float] = Field(default=None, description="Amount claimed, in PKR.")
    incident_date: Optional[str] = Field(default=None, description="YYYY-MM-DD. Defaults to today.")
    cause: Optional[Literal["Natural / illness", "Accident", "Suicide", "Other unnatural"]] = Field(
        default=None, description="Death claims: the cause of death. Leave unset to get buttons.")
    notes: Optional[str] = None


@tool(args_schema=RegisterClaimArgs)
def register_claim(**kwargs) -> str:
    """Register a First Notice of Loss (FNOL) — opens a claim against an active
    policy, auto-generates the claim number, runs duplicate detection, opens
    the linked SLA case and puts it straight into the claims workflow
    (eligibility, plan exclusions, document checklist). Call it with whatever you have; the platform presents
    a policy picker and claim-type buttons for anything missing."""
    return "{}"


class UpdateClaimStatusArgs(BaseModel):
    claim_number: Optional[str] = None
    claimant_name: Optional[str] = None
    new_status: ClaimStatusLiteral = Field(description="Target status. The state machine only allows legal transitions.")
    notes: Optional[str] = None


@tool(args_schema=UpdateClaimStatusArgs)
def update_claim_status(**kwargs) -> str:
    """Move a claim through the claims state machine (New -> Triaged ->
    Under Investigation -> decision -> Settled -> Closed). Illegal jumps are
    refused with the list of legal next steps."""
    return "{}"


class AdjudicateClaimArgs(BaseModel):
    claim_number: Optional[str] = None
    claimant_name: Optional[str] = None
    decision: Literal["APPROVED", "PARTIAL_APPROVAL", "DECLINED", "REFERRED_TO_MANAGER"] = Field(
        description="The adjudication outcome."
    )
    approved_amount: Optional[float] = Field(default=None, description="PKR approved. Cannot exceed the claimed amount.")
    notes: Optional[str] = Field(
        default=None,
        description="Adjudicator rationale. REQUIRED (min 15 chars) when approving a duplicate-flagged claim.",
    )


@tool(args_schema=AdjudicateClaimArgs)
def adjudicate_claim(**kwargs) -> str:
    """Record the adjudication decision on a claim. Requires at least one
    document on file to approve; claims over PKR 500,000 or already referred
    need a ClaimsManager."""
    return "{}"


class ClaimPayoutArgs(BaseModel):
    claim_number: Optional[str] = None
    claimant_name: Optional[str] = None
    amount: Optional[float] = Field(default=None, description="PKR to disburse. Defaults to the approved amount.")
    method: Optional[str] = Field(default=None, description="Bank Transfer, Cheque or Cash.")
    reference_number: Optional[str] = None
    notes: Optional[str] = None


@tool(args_schema=ClaimPayoutArgs)
def issue_claim_payout(**kwargs) -> str:
    """Disburse an approved claim — creates the payout record and moves the
    claim to Settled. THIS MOVES MONEY: state the claim number and amount
    before calling. Only valid from Approved or Partial Approval."""
    return "{}"


@tool(args_schema=ClaimLookupArgs)
def refer_claim_to_reinsurance(**kwargs) -> str:
    """Open a facultative reinsurance recovery referral for a claim whose sum
    assured exceeds the net retention limit (PKR 5M)."""
    return "{}"


class ReUnderwriteClaimArgs(BaseModel):
    claim_number: Optional[str] = None
    claimant_name: Optional[str] = None
    referral_reason: Optional[str] = Field(
        default=None,
        description="Why underwriting must re-open the risk, e.g. contestability window, non-disclosure. "
        "Multiple reasons are joined with '; '.",
    )
    notes: Optional[str] = None


@tool(args_schema=ReUnderwriteClaimArgs)
def refer_claim_to_underwriting(**kwargs) -> str:
    """Refer a claim back to underwriting for a technical re-underwriting audit
    — used inside the 2-year contestability window, on suspected non-disclosure,
    or when the amount exceeds adjuster authority."""
    return "{}"


class ResolveClaimUnderwritingArgs(BaseModel):
    claim_number: Optional[str] = None
    claimant_name: Optional[str] = None
    decision: Literal[
        "APPROVE_CONTINUE", "APPROVE_WITH_EXCLUSION", "APPROVE_WITH_LOADING", "DECLINE_NON_DISCLOSURE"
    ] = Field(description="Underwriting's verdict on the re-underwriting referral.")
    decision_notes: Optional[str] = Field(default=None, description="The underwriter's written rationale.")


@tool(args_schema=ResolveClaimUnderwritingArgs)
def resolve_claim_underwriting(**kwargs) -> str:
    """Close out a re-underwriting referral. DECLINE_NON_DISCLOSURE declines the
    claim outright; the other three send it back to Under Investigation."""
    return "{}"


class UploadClaimDocumentArgs(BaseModel):
    claim_number: Optional[str] = None
    claimant_name: Optional[str] = None
    document_type: str = Field(
        description="Hospital Bill, Discharge Summary, Death Certificate, CNIC or Lab Test Report."
    )


@tool(args_schema=UploadClaimDocumentArgs)
def upload_claim_document(**kwargs) -> str:
    """Attach a claim document. The browser holds the file, so this hands over
    to the file picker — call it and the user just chooses a file."""
    return "{}"


class StartClaimJourneyArgs(BaseModel):
    claim_number: Optional[str] = Field(default=None, description="Existing claim to drive end-to-end.")
    policy_number: Optional[str] = Field(default=None, description="Policy to register a fresh FNOL against.")
    claimant_name: Optional[str] = None
    cnic: Optional[str] = None
    claim_type: Optional[str] = None
    submitted_amount: Optional[float] = None
    incident_date: Optional[str] = None
    cause: Optional[Literal["Natural / illness", "Accident", "Suicide", "Other unnatural"]] = Field(
        default=None, description="Death claims: the cause of death.")


@tool(args_schema=StartClaimJourneyArgs)
def start_claim_journey(**kwargs) -> str:
    """Run the ENTIRE claims pipeline autonomously: FNOL -> Triage -> Document
    Audit -> Fraud & Contestability Review -> Adjudication -> Disbursement ->
    Closure. Suspends only for missing documents, a manager decision, or an
    underwriting referral. Use for "settle this claim end to end", "process
    claim CLM-2026-0001", "handle Ahmed's claim"."""
    return "{}"


@tool(args_schema=ClaimLookupArgs)
def continue_claim_journey(**kwargs) -> str:
    """Resume a suspended claims journey after documents were uploaded or a
    human decision was recorded. Pass the claim number when the user names one
    — the thread may have been started in a different session."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Group Life / Group Family Takaful — scheme through issuance
# (GROUP_LIFE_PLAN.md Phase 3; handlers in group_tools.py, pipeline in group_journey.py)
# ═══════════════════════════════════════════════════════════════════════════

class GroupSchemeLookupArgs(BaseModel):
    organization_name: Optional[str] = Field(
        default=None, description="The employer's company name. Schemes are addressed by company name, never a UUID.")
    organization_id: Optional[str] = Field(default=None, description="Only when the user or a chip supplied an id.")
    master_policy_id: Optional[str] = Field(
        default=None, description="Only for a specific scheme; omit to use the organization's newest.")


class StartGroupJourneyArgs(GroupSchemeLookupArgs):
    plan_code: Optional[Literal["GROUP_LIFE", "GROUP_LIFE_SME", "GROUP_FAMILY_TAKAFUL"]] = Field(
        default=None, description="Product. Omit for conventional Group Life; GROUP_FAMILY_TAKAFUL for Takaful.")
    business_type: Optional[Literal["Conventional", "Takaful"]] = None
    effective_date: Optional[str] = Field(default=None, description="YYYY-MM-DD cover start. Defaults to today.")
    term_years: Optional[int] = Field(default=None, description="Contract term; group cover is normally 1 year, renewed annually.")
    sum_assured_multiple: Optional[float] = Field(default=None, description="Default cover as a multiple of monthly salary (12–36). Defaults to 24.")
    use_demo_data: Optional[bool] = Field(
        default=False,
        description="Demo mode only: generate benefit classes and a random employee census instead of asking for them. "
                    "Set it when the user says 'demo', 'test data' or 'make something up'.",
    )
    employee_count: Optional[int] = Field(default=None, description="Size of the generated demo census (default 12).")
    above_fcl_count: Optional[int] = Field(default=0, description="Demo only: how many senior staff to cover above the Free Cover Limit.")
    contact_person: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    agent_name: Optional[str] = Field(default=None, description=_AGENT_NAME_DESCRIPTION)


@tool(args_schema=StartGroupJourneyArgs)
def start_group_journey(**kwargs) -> str:
    """Run the ENTIRE group-scheme pipeline autonomously: scheme -> benefit classes
    -> census -> group underwriting -> quote -> (employer acceptance) -> issuance ->
    enrolment. It stops only where a person must act: a missing or invalid census,
    above-limit members awaiting an underwriting decision, the employer's accept /
    revise / decline, and the employer's payment. Use for "set up a group life scheme
    for Meridian Textiles", "start a group takaful for ...", "start a group scheme"."""
    return "{}"


@tool(args_schema=GroupSchemeLookupArgs)
def continue_group_journey(**kwargs) -> str:
    """Resume a suspended group journey after the census was uploaded, an
    underwriting decision was made, the quote was accepted or the payment was
    recorded. Pass the company name when the user names one — the thread may have
    been started in a different session."""
    return "{}"


class CreateGroupSchemeArgs(StartGroupJourneyArgs):
    create_if_missing: Optional[bool] = Field(
        default=False, description="Create the organization too when it doesn't exist. Only set it when the user asked for that.")
    new_scheme: Optional[bool] = Field(
        default=False, description="Open a second scheme even though one is in progress. Almost never wanted.")


@tool(args_schema=CreateGroupSchemeArgs)
def create_group_scheme(**kwargs) -> str:
    """Create the Master Policy (the scheme) for an employer: product (Group Life or
    Group Family Takaful), term, start date and default cover multiple. One step on
    its own — use start_group_journey to run the whole thing."""
    return "{}"


class ServiceBandIn(BaseModel):
    min_years: int = Field(ge=0)
    amount: float = Field(gt=0)


class AddGroupBenefitClassArgs(GroupSchemeLookupArgs):
    name: Optional[str] = Field(default=None, description="Class name, e.g. Management, Staff, Workers.")
    basis: Optional[Literal["Flat", "SalaryMultiple", "ServiceBanded", "LoanBalance"]] = Field(
        default=None, description="LoanBalance is for Group Credit Life: cover is each borrower's outstanding loan (census column loan_amount).")
    flat_amount: Optional[float] = Field(default=None, description="PKR, for Flat.")
    salary_multiple: Optional[float] = Field(default=None, description="Times monthly basic salary, for SalaryMultiple.")
    service_bands: Optional[list[ServiceBandIn]] = Field(default=None, description="For ServiceBanded: cover by completed years of service.")
    grades: Optional[list[str]] = Field(default=None, description="Employee grades that fall into this class.")
    min_cover: Optional[float] = None
    max_cover: Optional[float] = None
    coverages: Optional[list[dict]] = Field(default=None, description="Extra benefits for the class: [{coverage_type: AccidentalDeath|Disability|PayContinuation|FeeContinuation, percent_of_base, max_amount?}].")
    is_default: Optional[bool] = Field(default=False, description="The class for employees who match no grade.")
    classes_json: Optional[str] = Field(default=None, description="Several classes at once as a JSON array of the same fields.")
    use_demo_template: Optional[bool] = Field(default=False, description="Demo mode only: add a ready-made set of classes.")
    include_above_fcl: Optional[bool] = Field(default=False, description="With the demo template: also add an Executive class above the Free Cover Limit.")


@tool(args_schema=AddGroupBenefitClassArgs)
def add_group_benefit_class(**kwargs) -> str:
    """Define who gets how much cover under a group scheme: a benefit class with a
    flat amount, a salary multiple, or cover banded by years of service. Classes can
    only be added before employees are enrolled."""
    return "{}"


class SubmitGroupCensusArgs(GroupSchemeLookupArgs):
    employees_json: Optional[str] = Field(
        default=None,
        description="JSON array of employees with cnic, name, dob (YYYY-MM-DD), gender, occupation and annual declared_income; "
                    "optional employee_id, designation, grade, joining_date, benefit_class, basic_monthly_salary.",
    )
    use_demo_data: Optional[bool] = Field(default=False, description="Demo mode only: generate a random census.")
    employee_count: Optional[int] = None
    above_fcl_count: Optional[int] = 0


@tool(args_schema=SubmitGroupCensusArgs)
def submit_group_census(**kwargs) -> str:
    """Validate and enrol a group's employee census given as rows (or a generated
    demo census). Nothing is enrolled unless every row is valid. For a real
    spreadsheet use upload_group_census instead."""
    return "{}"


@tool(args_schema=GroupSchemeLookupArgs)
def upload_group_census(**kwargs) -> str:
    """Load the employee census from a CSV or Excel file. The browser holds the
    file, so this opens the file picker — call it and the user just chooses a file;
    it is validated and enrolled automatically."""
    return "{}"


@tool(args_schema=GroupSchemeLookupArgs)
def get_group_scheme_status(**kwargs) -> str:
    """Where a group scheme stands: status, benefit classes, members, undecided
    above-limit members, latest quote and the next step."""
    return "{}"


class ListGroupMembersArgs(GroupSchemeLookupArgs):
    limit: Optional[int] = None


@tool(args_schema=ListGroupMembersArgs)
def list_group_members(**kwargs) -> str:
    """List a group scheme's insured members with class, cover and certificate number."""
    return "{}"


@tool(args_schema=GroupSchemeLookupArgs)
def generate_group_quote(**kwargs) -> str:
    """Price the group as one pool and issue a versioned quote (a new one supersedes
    the open one). Blocked while any above-limit member still awaits an underwriting
    decision. Use for "quote the group", "revise the quote"."""
    return "{}"


class GroupQuoteDecisionArgs(GroupSchemeLookupArgs):
    decided_by: Optional[str] = Field(default=None, description="The employer contact who decided, if the user said.")
    notes: Optional[str] = None


@tool(args_schema=GroupQuoteDecisionArgs)
def accept_group_quote(**kwargs) -> str:
    """Record the employer's acceptance of the open group quote."""
    return "{}"


@tool(args_schema=GroupQuoteDecisionArgs)
def decline_group_quote(**kwargs) -> str:
    """Record that the employer declined the open group quote. A revised quote can still be generated."""
    return "{}"


@tool(args_schema=GroupSchemeLookupArgs)
def issue_group_policy(**kwargs) -> str:
    """Issue the master policy on the accepted quote: policy number, one numbered
    certificate per member, and the schedule. Cover is not live until the employer's
    payment is recorded."""
    return "{}"


class RecordGroupPaymentArgs(GroupSchemeLookupArgs):
    reference: Optional[str] = Field(default=None, description="The bank / transfer reference for the employer's payment.")
    amount: Optional[float] = Field(default=None, description="PKR paid. Defaults to the full amount due.")


@tool(args_schema=RecordGroupPaymentArgs)
def record_group_payment(**kwargs) -> str:
    """Record the employer's premium / contribution payment. Full payment binds cover
    for the whole scheme: every certificate and member goes Active."""
    return "{}"


# ── Group endorsements (Phase 4): mid-term changes to an in-force scheme ──────

class GroupEndorsementArgs(GroupSchemeLookupArgs):
    effective_date: Optional[str] = Field(default=None, description="YYYY-MM-DD the change takes effect. Defaults to today.")
    reason: Optional[str] = None


class PreviewGroupEndorsementArgs(GroupEndorsementArgs):
    endorsement_type: Literal["ADD", "DELETE", "CHANGE"]
    employees_json: Optional[str] = Field(default=None, description="ADD: JSON array of the joiners (cnic, name, dob, gender, occupation, declared_income, optional grade / benefit_class / employee_id).")
    use_demo_data: Optional[bool] = Field(default=False, description="ADD, demo mode only: generate joiners.")
    employee_count: Optional[int] = None
    member_names: Optional[list[str]] = Field(default=None, description="DELETE / CHANGE: members by name, CNIC or employee id.")
    new_salary: Optional[float] = Field(default=None, description="CHANGE: the new basic monthly salary.")
    grade: Optional[str] = None
    designation: Optional[str] = None
    benefit_class: Optional[str] = None


@tool(args_schema=PreviewGroupEndorsementArgs)
def preview_group_endorsement(**kwargs) -> str:
    """Show what a mid-term change to an in-force group scheme would do and cost —
    members joining (ADD), leaving (DELETE) or changing salary / grade / class (CHANGE),
    with the pro-rata premium (contribution for Takaful) — WITHOUT changing anything.
    Always preview before applying, and tell the user the amount."""
    return "{}"


class ApplyGroupEndorsementArgs(PreviewGroupEndorsementArgs):
    member_name: Optional[str] = Field(default=None, description="CHANGE: the member, by name, CNIC or employee id.")
    cnics: Optional[list[str]] = Field(default=None, description="DELETE: members leaving, by CNIC.")


@tool(args_schema=ApplyGroupEndorsementArgs)
def apply_group_endorsement(**kwargs) -> str:
    """Apply a mid-term change to an in-force group scheme: ADD joiners, DELETE leavers
    (certificate cancelled, unexpired premium refunded; the customer record is kept) or
    CHANGE a member's salary / grade / designation / class (cover re-priced pro rata).
    Joiners or increases above the Free Cover Limit wait for an underwriting decision.
    Preview first with preview_group_endorsement."""
    return "{}"


class GroupEndorsementRefArgs(GroupSchemeLookupArgs):
    endorsement_number: Optional[str] = Field(default=None, description="e.g. END-GL-2026-0001-002, or just 002. Defaults to the latest.")


@tool(args_schema=GroupEndorsementRefArgs)
def list_group_endorsements(**kwargs) -> str:
    """List a group scheme's endorsements with type, effective date, status and amount."""
    return "{}"


@tool(args_schema=GroupEndorsementRefArgs)
def resolve_group_endorsement(**kwargs) -> str:
    """Apply the endorsement lines that were waiting on an underwriting decision, now that
    underwriters may have decided. Lines still undecided stay pending."""
    return "{}"


class SettleGroupEndorsementArgs(GroupEndorsementRefArgs):
    reference: Optional[str] = Field(default=None, description="The bank reference for the collection or refund. Never invent one.")
    amount: Optional[float] = Field(default=None, description="PKR. Defaults to the exact adjustment.")


@tool(args_schema=SettleGroupEndorsementArgs)
def settle_group_endorsement(**kwargs) -> str:
    """Record an endorsement's additional premium as collected, or its refund as paid."""
    return "{}"



# ── Group renewals, claims and the Takaful fund (Phases 5–6) ─────────────────

class StartGroupRenewalArgs(GroupSchemeLookupArgs):
    employees_json: Optional[str] = Field(default=None, description="Optional refreshed workforce list (full census rows). Joiners are added and changes applied.")
    remove_missing: Optional[bool] = Field(default=False, description="Treat employees missing from the refreshed list as leavers.")
    notes: Optional[str] = None


@tool(args_schema=StartGroupRenewalArgs)
def start_group_renewal(**kwargs) -> str:
    """Open the annual renewal of an in-force group scheme, optionally apply the employer's
    refreshed census, and price the new period using the group's own claims experience.
    Returns the renewal quote for the employer to accept or decline."""
    return "{}"


@tool(args_schema=GroupSchemeLookupArgs)
def get_group_renewal(**kwargs) -> str:
    """Show the group scheme's current renewal: experience, factor, quote and status."""
    return "{}"


class DecideGroupRenewalArgs(GroupSchemeLookupArgs):
    decision: Literal["accept", "decline"] = Field(description="The employer's answer to the renewal quote.")
    decided_by: Optional[str] = Field(default=None, description="Who at the employer decided.")
    notes: Optional[str] = None


@tool(args_schema=DecideGroupRenewalArgs)
def decide_group_renewal(**kwargs) -> str:
    """Record the employer's answer to the renewal quote: accept (cover continues once
    paid) or decline (the scheme lapses at period end)."""
    return "{}"


class RecordGroupRenewalPaymentArgs(GroupSchemeLookupArgs):
    reference: Optional[str] = Field(default=None, description="The bank reference. Never invent one.")
    amount: Optional[float] = Field(default=None, description="PKR. Defaults to the renewal quote total.")


@tool(args_schema=RecordGroupRenewalPaymentArgs)
def record_group_renewal_payment(**kwargs) -> str:
    """Record the employer's renewal premium / contribution payment; the new period starts."""
    return "{}"


class RegisterGroupClaimArgs(GroupSchemeLookupArgs):
    member_name: Optional[str] = Field(default=None, description="The insured employee, by name, CNIC or employee id.")
    dependent_name: Optional[str] = Field(default=None, description="Set when the claim is for a covered dependant's death.")
    claim_type: Optional[str] = Field(default="Death Claim", description="Death Claim, Accidental Death, Disability, Pay Continuation, Fee Continuation.")
    coverage_type: Optional[str] = None
    submitted_amount: Optional[float] = Field(default=None, description="PKR. Defaults to the member's life cover.")
    incident_date: Optional[str] = Field(default=None, description="YYYY-MM-DD.")
    notes: Optional[str] = None


@tool(args_schema=RegisterGroupClaimArgs)
def register_group_claim(**kwargs) -> str:
    """Register a claim against a group scheme member (or their dependant) and show which
    documents are required for that benefit."""
    return "{}"


@tool(args_schema=GroupSchemeLookupArgs)
def list_group_claims(**kwargs) -> str:
    """List the claims on a group scheme with status and amounts."""
    return "{}"


class GroupClaimPayoutArgs(GroupSchemeLookupArgs):
    claim_number: Optional[str] = None
    member_name: Optional[str] = None
    amount: Optional[float] = Field(default=None, description="PKR. Defaults to the approved amount.")
    reference: Optional[str] = Field(default=None, description="Bank reference for the payout. Never invent one.")
    confirm_no_nominee: Optional[bool] = Field(default=False, description="Only when the user agreed to pay the claimant because no nominee is on file.")


@tool(args_schema=GroupClaimPayoutArgs)
def preview_group_claim_payout(**kwargs) -> str:
    """Show how an approved group claim would be split between the member's nominees
    (by their share percentages). Pays nothing."""
    return "{}"


@tool(args_schema=GroupClaimPayoutArgs)
def pay_group_claim(**kwargs) -> str:
    """Disburse an approved group claim to its nominees by their shares and settle it."""
    return "{}"


@tool(args_schema=GroupSchemeLookupArgs)
def get_group_ptf_report(**kwargs) -> str:
    """Participants' Takaful Fund position for a Takaful scheme: contributions, Wakala fee,
    retakaful, claims and surplus or deficit per period."""
    return "{}"


class AddGroupClassCoverageArgs(GroupSchemeLookupArgs):
    class_name: Optional[str] = Field(default=None, description="The benefit class.")
    coverage_type: Literal["AccidentalDeath", "Disability", "PayContinuation", "FeeContinuation"]
    percent_of_base: float = Field(description="% of the member's life cover, e.g. 100 or 200.")
    max_amount: Optional[float] = None


@tool(args_schema=AddGroupClassCoverageArgs)
def add_group_class_coverage(**kwargs) -> str:
    """Add an extra benefit (Accidental Death, Disability, Pay Continuation, Fee
    Continuation) to a benefit class. Withdraws any open quote, so re-quote afterwards."""
    return "{}"

# ═══════════════════════════════════════════════════════════════════════════
# Commission engine — rate card, waterfall, ledger, payout runs
# ═══════════════════════════════════════════════════════════════════════════

class ListPayeesArgs(BaseModel):
    search: Optional[str] = Field(default=None, description="Filter by payee name or code.")
    channel: Optional[str] = Field(
        default=None,
        description="DIRECT_AGENCY, BANCASSURANCE, BROKER, CORPORATE_AGENT, DIGITAL_DIRECT or REFERRAL.",
    )


@tool(args_schema=ListPayeesArgs)
def list_commission_payees(**kwargs) -> str:
    """List registered acquisition-source payees from the persistent commission backend."""
    return "{}"


class RateCardArgs(BaseModel):
    segment: Optional[Literal["individual", "group", "family"]] = Field(
        default=None, description="Defaults to individual."
    )
    policy_year: Optional[int] = Field(default=None, description="1 = first year. Defaults to 1.")
    premium_type: Optional[Literal["FIRST_YEAR", "RENEWAL", "SINGLE_PREMIUM"]] = None


@tool(args_schema=RateCardArgs)
def get_commission_rate_card(**kwargs) -> str:
    """Look up the applicable statutory commission rate from the rule engine
    (SECP Insurance Rules 2017 rate card). Use for "what commission does a
    first-year individual policy pay?"."""
    return "{}"


class CalculateCommissionArgs(BaseModel):
    policy_number: Optional[str] = None
    cnic: Optional[str] = None
    applicant_name: Optional[str] = None
    collected_premium: Optional[float] = Field(
        default=None, description="Premium collected. Defaults to the policy's own premium."
    )
    policy_year: Optional[int] = Field(default=None, description="Defaults to 1.")


@tool(args_schema=CalculateCommissionArgs)
def calculate_commission(**kwargs) -> str:
    """Compute the full commission waterfall for one policy — the producer's
    commission, every hierarchy override above them, channel partner and
    referral fees, and tax withholding. Use for "what does this policy pay
    out?", "break down the commission on Ahmed's policy"."""
    return "{}"


class LedgerArgs(BaseModel):
    payee_name: Optional[str] = Field(default=None, description="Restrict to one payee.")
    status: Optional[
        Literal["ACCRUED", "DRAFT", "SUBMITTED", "APPROVED", "PAID"]
    ] = None
    limit: int = Field(default=20)


@tool(args_schema=LedgerArgs)
def get_commission_ledger(**kwargs) -> str:
    """List persisted gross earnings, optionally filtered by disbursement state.
    PAID means external payment was manually confirmed, not a bank transfer by the app."""
    return "{}"


class StatementArgs(BaseModel):
    payee_name: Optional[str] = Field(default=None, description="Agent or payee name. Leave unset for an agent's own statement.")
    period: Optional[str] = Field(default=None, description="YYYY-MM. Defaults to the current month.")


@tool(args_schema=StatementArgs)
def get_agent_statement(**kwargs) -> str:
    """Summarize one payee's accrued gross earnings by posting month. No tax or settlement figures."""
    return "{}"


@tool(args_schema=EmptyArgs)
def get_commission_summary() -> str:
    """Summarize persisted accrued gross earnings. Does not imply payout or settlement."""
    return "{}"


class CreatePayoutRunArgs(BaseModel):
    period: Optional[str] = Field(default=None, description="YYYY-MM. Defaults to the current month.")
    channel: Optional[str] = Field(default=None, description="Restrict to one channel. Omit for all.")


@tool(args_schema=CreatePayoutRunArgs)
def create_payout_run(**kwargs) -> str:
    """Assemble every due commission tranche for a period into a payout run,
    ready for approval. This is the MAKER half of maker-checker — it does not
    release any money."""
    return "{}"


class ApprovePayoutRunArgs(BaseModel):
    run_id: str = Field(description="The payout run to approve.")


@tool(args_schema=ApprovePayoutRunArgs)
def approve_payout_run(**kwargs) -> str:
    """Approve a payout run, releasing its tranches for disbursement. This is
    the CHECKER half of maker-checker and moves real money — always state the
    run's period, payee count and net total before calling it."""
    return "{}"


# ── Commission Types & Rate Card Rules ─────────────────────────────────────

class ListCommissionRulesArgs(BaseModel):
    channel: Optional[str] = Field(default=None, description="DIRECT_AGENCY, BANCASSURANCE, BROKER, CORPORATE_AGENT, DIGITAL_DIRECT or REFERRAL.")
    segment: Optional[str] = Field(default=None, description="individual, group, family.")
    payee_type: Optional[str] = Field(default=None, description="AGENT, SALES_MANAGER, BRANCH_MANAGER, AGENCY, BROKER, BANK_PARTNER, BANK_SALES_OFFICER, REFERRAL_PARTNER.")
    search: Optional[str] = Field(default=None, description="Search term for rule ID, name or description.")


@tool(args_schema=ListCommissionRulesArgs)
def list_commission_rules(**kwargs) -> str:
    """List commission rate card rules — channel rates, policy year bands, SECP statutory caps and payee roles."""
    return "{}"


class CreateCommissionRuleArgs(BaseModel):
    id: Optional[str] = Field(default=None, description="Unique rule ID, e.g. COM-AG-IND-Y1.")
    channel: str = Field(description="Distribution channel code, e.g. DIRECT_AGENCY.")
    target_role: str = Field(description="Target payee role, e.g. AGENT, SALES_MANAGER.")
    policy_segment: str = Field(description="Policy segment: individual, group, family.")
    premium_type: str = Field(description="FIRST_YEAR, RENEWAL, SINGLE_PREMIUM.")
    policy_year: int = Field(default=1, description="Policy year band (1 = 1st year).")
    commission_rate: float = Field(description="Commission rate percentage, e.g. 45.0 for 45%.")
    description: Optional[str] = Field(default=None, description="Rule description.")
    secp_ref: Optional[str] = Field(default=None, description="SECP circular reference.")
    ref_status: Optional[str] = Field(default="STATUTORY", description="STATUTORY or CONTRACTUAL.")


@tool(args_schema=CreateCommissionRuleArgs)
def create_commission_rule(**kwargs) -> str:
    """Create a new commission type / rate card rule in the commission engine. Use this tool whenever the user asks to add or create a new commission type, commission rate card, or commission rule."""
    return "{}"



class UpdateCommissionRuleArgs(BaseModel):
    rule_id: str = Field(description="The ID of the commission rule to update, e.g. COM-AG-IND-Y1.")
    commission_rate: Optional[float] = Field(default=None, description="Updated commission rate percentage.")
    description: Optional[str] = Field(default=None, description="Updated description.")
    is_active: Optional[bool] = Field(default=None, description="Set active status.")


@tool(args_schema=UpdateCommissionRuleArgs)
def update_commission_rule(**kwargs) -> str:
    """Update an existing commission rate card rule in the engine."""
    return "{}"


class DeleteCommissionRuleArgs(BaseModel):
    rule_id: str = Field(description="The ID of the commission rule to delete.")


@tool(args_schema=DeleteCommissionRuleArgs)
def delete_commission_rule(**kwargs) -> str:
    """Delete a commission rate card rule from the engine."""
    return "{}"


class ToggleCommissionRuleActiveArgs(BaseModel):
    rule_id: str = Field(description="The ID of the commission rule to toggle active/inactive.")


@tool(args_schema=ToggleCommissionRuleActiveArgs)
def toggle_commission_rule_active(**kwargs) -> str:
    """Toggle the active status of a commission rate card rule."""
    return "{}"


# ── Performance Bonus Plans & Incentives ───────────────────────────────────

class ListIncentiveSchemesArgs(BaseModel):
    kind: Optional[str] = Field(default=None, description="PERSISTENCY_BONUS, PRODUCTION_BONUS, CLUB_QUALIFICATION.")
    search: Optional[str] = Field(default=None, description="Search by plan name, code or metric.")


@tool(args_schema=ListIncentiveSchemesArgs)
def list_incentive_schemes(**kwargs) -> str:
    """List performance bonus plans, policy retention rewards and club qualifications."""
    return "{}"


class CreateIncentiveSchemeArgs(BaseModel):
    id: Optional[str] = Field(default=None, description="Optional scheme ID, e.g. INC-5.")
    code: str = Field(description="Scheme code, e.g. BONUS-RET-13M.")
    name: str = Field(description="Scheme name, e.g. 1-Year Policy Retention Bonus.")
    kind: str = Field(description="PERSISTENCY_BONUS, PRODUCTION_BONUS, CLUB_QUALIFICATION.")
    metric: str = Field(description="Evaluation metric, e.g. 1-Year Policy Retention or Quarterly Sales Target.")
    threshold_label: str = Field(description="Human readable goal, e.g. ≥ 85% Active or ≥ PKR 5,000,000.")
    threshold: float = Field(description="Numeric goal value, e.g. 85 or 5000000.")
    reward_pct: Optional[float] = Field(default=None, description="Reward percentage of 1st-year earnings.")
    reward_amount: Optional[float] = Field(default=None, description="Flat reward cash amount in PKR.")
    measured_at: Optional[str] = Field(default=None, description="Evaluation period, e.g. End of Quarter, After 13 Months.")
    description: Optional[str] = Field(default=None, description="Scheme details and qualifications.")


@tool(args_schema=CreateIncentiveSchemeArgs)
def create_incentive_scheme(**kwargs) -> str:
    """Create a new performance bonus plan, incentive scheme, or bonus rule in the commission engine. Use this tool whenever the user asks to add new bonuses, create a bonus plan, or set up a performance incentive."""
    return "{}"



class UpdateIncentiveSchemeArgs(BaseModel):
    scheme_id: str = Field(description="Scheme ID to update, e.g. INC-1.")
    name: Optional[str] = Field(default=None, description="Updated scheme name.")
    threshold: Optional[float] = Field(default=None, description="Updated threshold value.")
    reward_pct: Optional[float] = Field(default=None, description="Updated reward percentage.")
    reward_amount: Optional[float] = Field(default=None, description="Updated reward flat cash amount.")
    is_active: Optional[bool] = Field(default=None, description="Updated active status.")


@tool(args_schema=UpdateIncentiveSchemeArgs)
def update_incentive_scheme(**kwargs) -> str:
    """Update an existing performance bonus plan or retention incentive scheme."""
    return "{}"


class DeleteIncentiveSchemeArgs(BaseModel):
    scheme_id: str = Field(description="Scheme ID to delete, e.g. INC-1.")


@tool(args_schema=DeleteIncentiveSchemeArgs)
def delete_incentive_scheme(**kwargs) -> str:
    """Delete a performance bonus plan or incentive scheme."""
    return "{}"


class ToggleIncentiveSchemeActiveArgs(BaseModel):
    scheme_id: str = Field(description="Scheme ID to toggle active/inactive.")


@tool(args_schema=ToggleIncentiveSchemeActiveArgs)
def toggle_incentive_scheme_active(**kwargs) -> str:
    """Toggle the active status of a performance bonus plan."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Evidence & medical review (handlers in evidence_tools.py)
# ═══════════════════════════════════════════════════════════════════════════

class RequestMissingDocumentsArgs(CaseLookupArgs):
    send_email: bool = Field(
        default=True,
        description="Email the customer their secure upload link. Set false to only return the link "
        "(e.g. the user will share it themselves).",
    )


@tool(args_schema=RequestMissingDocumentsArgs)
def request_missing_documents(**kwargs) -> str:
    """Ask the customer for the documents their application still needs: returns what is
    outstanding and the customer's secure upload link, renewing an expired link, and emails
    it unless send_email=false. Works before an underwriting case exists. Reports honestly
    whether the email was sent, failed, or the customer has no email address."""
    return "{}"


class LinkDocumentArgs(CaseLookupArgs):
    document_type: str = Field(description="The required document this file satisfies — exactly as the "
                               "checklist names it, e.g. Salary Slip, Bank Statement.")
    artifact_id: Optional[str] = Field(default=None, description="The uploaded file's id, from list_artifacts.")
    file_name: Optional[str] = Field(default=None, description="The uploaded file's name, when its id is unknown.")


@tool(args_schema=LinkDocumentArgs)
def link_document_to_requirement(**kwargs) -> str:
    """Count an already-uploaded file towards a required document — use when a file was
    uploaded under the wrong or a generic type ("that PDF is his salary slip"). Only files
    on this applicant's own application can be linked; no new upload happens."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def get_medical_report_status(**kwargs) -> str:
    """Medical examination report readiness for an application: which required tests have
    a processed report, which are still processing, rejected (need re-upload) or missing,
    whether staff review can start, and the recorded outcome once reviewed."""
    return "{}"


class ReadMedicalReportsArgs(CaseLookupArgs):
    test_code: Optional[str] = Field(default=None, description="Read one test only; omit for every required test.")
    refresh: bool = Field(default=False, description="Re-read even if a cached reading exists.")


@tool(args_schema=ReadMedicalReportsArgs)
def read_medical_reports(**kwargs) -> str:
    """Have the AI read each required test's value out of the customer's uploaded medical
    reports, with the line it was read from and which tests were unreadable. This is a
    pre-fill for staff review only — it never records a result or clears the medical gate."""
    return "{}"


class RecordMedicalReviewArgs(CaseLookupArgs):
    results_json: str = Field(description='JSON object of test code -> reported value with units, e.g. '
                              '{"FBS": "92 mg/dL", "HIV": "Non-reactive"}. Every required test needs a value.')
    staff_reviewed: bool = Field(description="True only when the staff user has stated or explicitly confirmed "
                                 "every value in this conversation. Never true for values taken unconfirmed "
                                 "from read_medical_reports.")
    artifact_id: Optional[str] = Field(default=None, description="The processed report the values come from.")


@tool(args_schema=RecordMedicalReviewArgs)
def record_medical_review(**kwargs) -> str:
    """Save the staff-reviewed medical examination results. The platform rates them against
    the underwriting manual (outcome, abnormal findings, suggested loading) and completes the
    medical requirement. Prefer opening the review screen when the user wants to check
    the reports side by side."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Recovery & availability (operations.py, support_tools.py)
# ═══════════════════════════════════════════════════════════════════════════

class OperationStatusArgs(BaseModel):
    operation_id: Optional[str] = Field(default=None, description="One operation's id; omit for the recent ones.")
    limit: Optional[int] = Field(default=8, description="How many recent operations to list (max 25).")


@tool(args_schema=OperationStatusArgs)
def get_operation_status(**kwargs) -> str:
    """What happened to the steps run in this conversation: which completed, which failed
    and why, which can be retried, and any suspended journey. Use for "did that go through?",
    "what failed?", "where did we stop?"."""
    return "{}"


class ResumeOperationArgs(BaseModel):
    operation_id: Optional[str] = Field(default=None, description="The failed operation to retry; omit for the most recent failure.")
    state_verified: bool = Field(default=False, description="Set true only after re-reading the record and "
                                 "confirming a timed-out step was NOT applied.")


@tool(args_schema=ResumeOperationArgs)
def resume_operation(**kwargs) -> str:
    """Continue where the conversation stopped: re-runs only the step that failed, with its
    original inputs, and never repeats completed steps (uploads, payments, drafts, messages).
    Use for "the upload failed, continue", "try that again", "pick up where we stopped"."""
    return "{}"


class ServiceHealthArgs(BaseModel):
    service: Optional[Literal[
        "api_gateway", "tenant_service", "risk_engine", "ocr_engine",
        "customer_service", "request_management", "customer_management",
    ]] = Field(default=None, description="Check one service; omit for all.")


@tool(args_schema=ServiceHealthArgs)
def get_service_health(**kwargs) -> str:
    """Live availability and response time of the platform's services. Use for "is the
    system down?", "why is Customer Service not opening?". Read-only: it never restarts anything."""
    return "{}"


class DiagnoseConnectionArgs(BaseModel):
    symptom: str = Field(description="What the user saw, verbatim if possible, e.g. "
                         "'server took too long to process, sign in failed'.")
    app: Optional[Literal["mobile_agent_app", "web_portal", "customer_portal", "customer_service", "other"]] = None
    client_api_url: Optional[str] = Field(default=None, description="The API address the failing app is "
                                          "configured with (e.g. the mobile app's EXPO_PUBLIC_API_URL), if known.")


@tool(args_schema=DiagnoseConnectionArgs)
def diagnose_connection(**kwargs) -> str:
    """Work out why an app cannot sign in or connect: separates a device that cannot reach
    the server (wrong address / different network), a misconfigured API address, an
    unavailable service, a backend timeout, and wrong credentials — then gives the fix."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Individual policy servicing (handlers in servicing_tools.py)
# ═══════════════════════════════════════════════════════════════════════════

class PolicyLookupArgs(BaseModel):
    """Any one field identifies the issued policy."""
    policy_number: Optional[str] = Field(default=None, description="e.g. POLICY-2026-0001")
    cnic: Optional[str] = Field(default=None, description="The policyholder's CNIC.")
    policyholder_name: Optional[str] = None
    case_number: Optional[str] = Field(default=None, description="The application (APP-/CASE-) the policy came from.")


@tool(args_schema=PolicyLookupArgs)
def get_policy_delivery_status(**kwargs) -> str:
    """Was the welcome kit generated and were the welcome / policy-issuance emails delivered?
    Reads the automatic delivery jobs: delivered, queued, or failed with the reason."""
    return "{}"


@tool(args_schema=PolicyLookupArgs)
def retry_failed_delivery(**kwargs) -> str:
    """Queue a retry of the policy's FAILED automatic deliveries only (welcome kit / emails).
    Completed deliveries are never re-sent. Refuses when the failure cause (e.g. no email
    on record) is still there."""
    return "{}"


@tool(args_schema=PolicyLookupArgs)
def get_onboarding_status(**kwargs) -> str:
    """The policyholder's onboarding: policyholder ID, welcome kit, portal account,
    welcome pack sent, and customer acknowledgement."""
    return "{}"


class ProvisionPortalArgs(PolicyLookupArgs):
    reset_password: bool = Field(default=False, description="Only when the customer is locked out and asked for a reset.")
    reason: Optional[str] = Field(default=None, description="Required with reset_password.")


@tool(args_schema=ProvisionPortalArgs)
def provision_portal_access(**kwargs) -> str:
    """Give the policyholder customer-portal access (creates their account and a one-time
    password). An account the customer already uses is never replaced unless a reset is
    explicitly requested with a reason. Does not notify the customer."""
    return "{}"


class PortalInvitationArgs(PolicyLookupArgs):
    channel: Optional[Literal["Email", "SMS", "Both", "Manual"]] = None
    resend: bool = Field(default=False, description="Send again although it was already sent.")


@tool(args_schema=PortalInvitationArgs)
def send_portal_invitation(**kwargs) -> str:
    """Send the policyholder their welcome pack with portal sign-in details. Reports
    delivery truthfully; refuses when there is no account or no contact."""
    return "{}"


class PremiumScheduleArgs(PolicyLookupArgs):
    only_outstanding: bool = Field(default=False, description="Only unpaid instalments.")


@tool(args_schema=PremiumScheduleArgs)
def get_premium_schedule(**kwargs) -> str:
    """The policy's premium instalments from the billing ledger: what is due, overdue, in
    grace or paid, with amounts and payment references."""
    return "{}"


class ReceiptArgs(PolicyLookupArgs):
    receipt_no: Optional[str] = None
    payment_reference: Optional[str] = None


@tool(args_schema=ReceiptArgs)
def get_payment_receipt(**kwargs) -> str:
    """Premium receipts issued for gateway-settled payments on a policy."""
    return "{}"


class PremiumReminderArgs(PolicyLookupArgs):
    installment_no: Optional[int] = Field(default=None, description="Defaults to the oldest unpaid instalment.")
    channel: Optional[Literal["Email", "SMS", "WhatsApp", "Letter"]] = None


@tool(args_schema=PremiumReminderArgs)
def send_premium_reminder(**kwargs) -> str:
    """Remind the policyholder about an unpaid premium instalment. Reports whether the
    email was actually delivered."""
    return "{}"


class EndorsementArgs(PolicyLookupArgs):
    endorsement_type: Literal["nominees", "address", "contact", "sum_assured", "rider_add", "rider_remove"]
    beneficiaries_json: Optional[str] = Field(default=None, description='nominees: JSON list of {"name", "cnic", '
                                              '"relationship", "share_pct"}; shares total 100.')
    address: Optional[str] = None
    city: Optional[str] = None
    province: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    new_sum_assured: Optional[float] = None
    rider_name: Optional[str] = None
    rider_sum_assured: Optional[float] = None
    rider_annual_premium: Optional[float] = None
    rider_id: Optional[str] = None


@tool(args_schema=EndorsementArgs)
def preview_policy_endorsement(**kwargs) -> str:
    """Preview a mid-term change to an in-force policy — current vs proposed values, the
    premium impact and what is still missing. Changes nothing."""
    return "{}"


@tool(args_schema=EndorsementArgs)
def submit_policy_endorsement(**kwargs) -> str:
    """Apply a mid-term change to an in-force policy: it changes the contract immediately and
    issues an endorsement letter. Underwriting staff only; preview it first. A customer's
    request that still needs approval is a service request, not this."""
    return "{}"


class EndorsementStatusArgs(PolicyLookupArgs):
    endorsement_no: Optional[str] = None


@tool(args_schema=EndorsementStatusArgs)
def get_endorsement_status(**kwargs) -> str:
    """Endorsements applied to a policy (number, type, summary, effective date, premium change)."""
    return "{}"


@tool(args_schema=PolicyLookupArgs)
def get_renewal_readiness(**kwargs) -> str:
    """When the policy next renews, the amount, the eligibility checks and any open renewal
    with its stages. Use for "what happens when this policy expires/renews?"."""
    return "{}"


@tool(args_schema=PolicyLookupArgs)
def preview_policy_renewal(**kwargs) -> str:
    """Preview the next renewal — type, amount, period and eligibility — without opening it."""
    return "{}"


@tool(args_schema=PolicyLookupArgs)
def submit_policy_renewal(**kwargs) -> str:
    """Open the renewal for an eligible individual policy. Opening is not renewing: the
    premium must still be collected and reconciled. Group scheme renewals use the group tools."""
    return "{}"


@tool(args_schema=PolicyLookupArgs)
def get_reinstatement_requirements(**kwargs) -> str:
    """Can a lapsed policy be reinstated: the reinstatement window, eligibility checks,
    arrears, required declarations/medical evidence and reviews."""
    return "{}"


class ReinstatementArgs(PolicyLookupArgs):
    reason: Optional[str] = None
    applicant_relationship: Optional[Literal["Policyholder", "Nominee", "Agent", "Representative"]] = None
    request_channel: Optional[Literal["Branch", "Portal", "Agent", "Phone", "Email"]] = None
    applicant_name: Optional[str] = None


@tool(args_schema=ReinstatementArgs)
def submit_reinstatement_request(**kwargs) -> str:
    """Register a reinstatement request for a lapsed policy. A request does not restore
    cover — declaration, evidence, decision and arrears payment follow."""
    return "{}"


@tool(args_schema=PolicyLookupArgs)
def get_reinstatement_status(**kwargs) -> str:
    """Where a reinstatement request stands and whether cover has actually been restored."""
    return "{}"


@tool(args_schema=PolicyLookupArgs)
def preview_policy_exit(**kwargs) -> str:
    """Explain the policy's exit options with estimates: free-look cancellation (window and
    refund), surrender value, and its natural end. Requests nothing."""
    return "{}"


class PolicyExitArgs(PolicyLookupArgs):
    exit_type: Literal["free_look_cancellation", "surrender"]
    customer_confirmed: bool = Field(description="True only when the customer's explicit instruction to end the "
                                     "policy has been stated in this conversation.")
    reason: Optional[str] = None
    relationship: Optional[str] = None
    channel: Optional[str] = None
    medical_exam_deduction: Optional[float] = Field(
        default=None, description="Free-look only: PKR of medical examination expenses to deduct from the refund. Never guess it.")
    medical_exam_note: Optional[str] = Field(default=None, description="Which examination / invoice the deduction is for.")


@tool(args_schema=PolicyExitArgs)
def submit_policy_exit_request(**kwargs) -> str:
    """End a policy on the customer's instruction: a free-look cancellation (cancels now; the
    premium is refunded less any medical examination expenses, settled separately) or a
    surrender request (savings products only — a pure term plan has no surrender value).
    Staff only."""
    return "{}"


@tool(args_schema=PolicyLookupArgs)
def get_exit_status(**kwargs) -> str:
    """Where a cancellation or surrender stands: requested, settlement calculated, paid out."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Service requests & support tickets (service_desk_tools.py)
# ═══════════════════════════════════════════════════════════════════════════

class CreateServiceRequestArgs(BaseModel):
    request_type: Literal["general", "customer_profile_correction"] = "general"
    title: Optional[str] = Field(default=None, description="Short subject line.")
    description: str = Field(description="What is needed and why (at least 10 characters). For a correction, the reason.")
    category: Optional[Literal["ACCESS", "DATA_FIX", "PROCESS_EXCEPTION", "DOCUMENT", "OTHER"]] = None
    desired_outcome: Optional[str] = None
    priority: Optional[Literal["LOW", "NORMAL", "HIGH", "URGENT"]] = None
    customer_cnic: Optional[str] = Field(default=None, description="Correction: whose record.")
    customer_name: Optional[str] = None
    changes_json: Optional[str] = Field(default=None, description='Correction: JSON of field -> new value. Fields: '
                                        'contact.mobile_number, contact.email, contact.emergency_contact_name, '
                                        'address.street_address, address.postal_code, city, province, marital_status.')


@tool(args_schema=CreateServiceRequestArgs)
def create_service_request(**kwargs) -> str:
    """Draft a service request in Request Management (a change or decision someone else must
    approve), e.g. correcting a customer's contact or address. Creates a DRAFT — submit it next."""
    return "{}"


class ServiceRequestRefArgs(BaseModel):
    request_reference: Optional[str] = Field(default=None, description="The request's reference number; omit to list your recent requests.")


@tool(args_schema=ServiceRequestRefArgs)
def get_service_request(**kwargs) -> str:
    """Where a service request stands: review status, who owns it, what the reviewer asked
    for, the decision, and whether an approved change has actually been applied."""
    return "{}"


class RequestAttachmentArgs(BaseModel):
    request_reference: str
    artifact_id: Optional[str] = Field(default=None, description="A document already on the platform (from list_artifacts).")


@tool(args_schema=RequestAttachmentArgs)
def add_request_attachment(**kwargs) -> str:
    """Attach a document already held on the platform to a service request. New files from
    the user's device are attached on the request's page."""
    return "{}"


class SubmitServiceRequestArgs(BaseModel):
    request_reference: str
    reviewer_id: Optional[str] = Field(default=None, description="A reviewer the routing allows the requester to name.")


@tool(args_schema=SubmitServiceRequestArgs)
def submit_service_request(**kwargs) -> str:
    """Submit (or resubmit after an information request) a draft service request for review."""
    return "{}"


class CreateTicketArgs(BaseModel):
    title: str = Field(description="3-200 characters.")
    description: str = Field(description="What the customer reported, at least 10 characters.")
    category: Optional[Literal["GENERAL", "POLICY_SERVICING", "BILLING", "CLAIM_ENQUIRY", "COMPLAINT", "DOCUMENTS"]] = None
    priority: Optional[Literal["LOW", "NORMAL", "HIGH", "URGENT"]] = None
    policy_number: Optional[str] = Field(default=None, description="Link the policy it is about.")
    customer_cnic: Optional[str] = None
    customer_name: Optional[str] = None
    conversation_summary: Optional[str] = Field(default=None, description="A short summary of this conversation to keep on the ticket.")


@tool(args_schema=CreateTicketArgs)
def create_support_ticket(**kwargs) -> str:
    """Open a Customer Service ticket — a complaint, enquiry or problem — linked to the
    customer/policy it concerns. Its status is separate from the policy's."""
    return "{}"


class TicketRefArgs(BaseModel):
    ticket_reference: Optional[str] = Field(default=None, description="T-XXXXXXXX or title; omit to list recent tickets.")
    status: Optional[Literal["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED", "CANCELLED"]] = None


@tool(args_schema=TicketRefArgs)
def get_support_ticket(**kwargs) -> str:
    """A support ticket's status, owner, due time, resolution and recent conversation."""
    return "{}"


class TicketCommentArgs(BaseModel):
    ticket_reference: str
    comment: str
    internal: bool = Field(default=False, description="An internal staff note the customer never sees.")


@tool(args_schema=TicketCommentArgs)
def add_ticket_comment(**kwargs) -> str:
    """Reply on a support ticket, or add an internal note (service staff)."""
    return "{}"


class AssignTicketArgs(BaseModel):
    ticket_reference: str
    release: bool = Field(default=False, description="Release it back to the queue instead of claiming it.")


@tool(args_schema=AssignTicketArgs)
def assign_support_ticket(**kwargs) -> str:
    """Claim a support ticket for yourself, or release it to the queue (service staff only —
    tickets can't be assigned to someone else)."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Exceptions, members & operations (workflow_tools.py)
# ═══════════════════════════════════════════════════════════════════════════

class ResolveRecordArgs(BaseModel):
    identifier: str = Field(description="Reference, CNIC, policy/claim number or name.")
    record_type: Optional[RecordType] = None


@tool(args_schema=ResolveRecordArgs)
def resolve_insurance_record(**kwargs) -> str:
    """Pin down exactly which record the user means and return its canonical ids — one match,
    a choice between several, or a clear "none". Use before acting on an ambiguous reference."""
    return "{}"


class TransitionArgs(CaseLookupArgs):
    target_status: Optional[Literal["New", "InProgress", "Pending Documents", "Under Review",
                                    "Approved", "Rejected", "Closed"]] = None


@tool(args_schema=TransitionArgs)
def preview_application_transition(**kwargs) -> str:
    """Whether an application may move to a status and what that would do, without changing
    it; without a target, the moves currently allowed."""
    return "{}"


class EvidenceRequestArgs(CaseLookupArgs):
    evidence: list[str] = Field(description="Each piece of evidence needed, e.g. ['ECG', 'Latest bank statement'].")
    reason: Optional[str] = None


@tool(args_schema=EvidenceRequestArgs)
def request_additional_evidence(**kwargs) -> str:
    """Send an application back for more underwriting evidence (moves it to Pending Documents
    and records exactly what is needed). The decision stays open."""
    return "{}"


class ReferReviewArgs(CaseLookupArgs):
    reason: str = Field(description="What is disputed or incomplete.")
    reviewer_name: Optional[str] = Field(default=None, description="A specific underwriter to assign it to.")


@tool(args_schema=ReferReviewArgs)
def refer_underwriting_review(**kwargs) -> str:
    """Refer a disputed or doubtful underwriting result (e.g. a loading the customer contests)
    to an underwriter for review instead of deciding it here."""
    return "{}"


class MemberMatrixArgs(BaseModel):
    group_name: Optional[str] = Field(default=None, description="Family or company name.")
    case_number: Optional[str] = Field(default=None, description="Any member's application reference.")
    cnic: Optional[str] = None


@tool(args_schema=MemberMatrixArgs)
def get_member_workflow_matrix(**kwargs) -> str:
    """Per-member progress of a family or corporate application: each member's stage and what
    blocks them, separating shared family steps from member-specific ones."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def resume_member_workflow(**kwargs) -> str:
    """Run the next pending pre-underwriting step for ONE member of a family/corporate
    application. Decisions are offered, never taken, and other members are untouched."""
    return "{}"


class ClaimBlockerArgs(BaseModel):
    claim_number: Optional[str] = None
    claimant_name: Optional[str] = None


@tool(args_schema=ClaimBlockerArgs)
def get_claim_blockers(**kwargs) -> str:
    """Why a claim is waiting: missing documents, referrals, approvals or the payout — and the
    next legal step."""
    return "{}"


class WorkQueueArgs(BaseModel):
    queue: Optional[Literal["all", "applications", "claims", "claim_payouts", "service_requests", "tickets"]] = "all"
    mine: bool = Field(default=False, description="Only applications assigned to me.")
    older_than_days: Optional[int] = None


@tool(args_schema=WorkQueueArgs)
def get_work_queue(**kwargs) -> str:
    """Open work with owners, age and deadlines, oldest/overdue first — applications, claims,
    approved claim payouts not yet disbursed, service requests and tickets."""
    return "{}"


class TimelineArgs(BaseModel):
    case_number: Optional[str] = None
    cnic: Optional[str] = None
    policy_number: Optional[str] = None
    claim_number: Optional[str] = None
    request_reference: Optional[str] = None
    limit: Optional[int] = 15


@tool(args_schema=TimelineArgs)
def get_workflow_timeline(**kwargs) -> str:
    """A record's traceable history — who did what and when — for an application, policy,
    claim or service request."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Claims workflow — the 7-step claims-management process (claim_workflow_tools.py)
#
# Drives the same Claim record as the register tools above, through eligibility
# on the event date, a category checklist, investigation, benefit assessment,
# payee verification and a reconciled settlement. Claims are named by claim
# number or claimant; policies by number, CNIC or policyholder name.
# ═══════════════════════════════════════════════════════════════════════════

ClaimCategory = Literal["Death", "AccidentalDeath", "Disability", "Hospitalization"]


class PolicyClaimLookupArgs(BaseModel):
    policy_number: Optional[str] = Field(default=None, description="e.g. PL-2026-0001.")
    policyholder_name: Optional[str] = None
    cnic: Optional[str] = None


@tool(args_schema=PolicyClaimLookupArgs)
def get_policy_claim_options(**kwargs) -> str:
    """What a policy can claim: its cover periods (was it in force on a date?), each
    benefit and its amount, the claims already on it with their workflow stage and
    SLA, and the nominee on record. Use for "can Ahmed's family claim?", "was the
    policy in force on 3 March?", "what claims are on PL-2026-0001?"."""
    return "{}"


@tool(args_schema=ClaimLookupArgs)
def get_claim_workflow(**kwargs) -> str:
    """Where one claim stands in the 7-step workflow — eligibility verdict, documents
    outstanding, investigation red flags, assessed benefit, decision, SLA clock,
    payees and settlement — with the next legal steps as buttons."""
    return "{}"


class IntimateClaimArgs(PolicyClaimLookupArgs):
    category: Optional[ClaimCategory] = Field(default=None, description="The benefit being claimed. Leave unset to get choices.")
    event_date: Optional[str] = Field(default=None, description="YYYY-MM-DD the death/accident/admission happened.")
    event_end_date: Optional[str] = Field(default=None, description="Discharge date for a hospitalisation.")
    cause: Optional[Literal["Natural / illness", "Accident", "Suicide", "Other unnatural"]] = Field(
        default=None, description="Required for death claims — decides the documents.")
    claimed_amount: Optional[float] = Field(default=None, description="PKR claimed.")
    claimant_name: Optional[str] = Field(default=None, description="Who is claiming. Required for death claims (nominee / heir).")
    claimant_relationship: Optional[str] = Field(default=None, description="Self, Spouse, Child, Parent, Sibling, Legal heir, Employer or Representative.")
    claimant_cnic: Optional[str] = None
    claimant_phone: Optional[str] = None
    claimant_email: Optional[str] = Field(default=None, description="Where the closure letter will be emailed.")
    covered_person_name: Optional[str] = Field(default=None, description="Only when the insured event happened to a covered dependant.")
    covered_person_relationship: Optional[str] = Field(default=None, description="Self, Spouse, Child or Parent. Defaults to Self.")
    event_place: Optional[str] = None
    event_description: Optional[str] = None
    hospital_name: Optional[str] = None
    diagnosis: Optional[str] = None
    channel: Optional[str] = Field(default=None, description="Branch, Phone, Email, Portal or Agent. Defaults to Branch.")
    notes: Optional[str] = None


@tool(args_schema=IntimateClaimArgs)
def intimate_claim(**kwargs) -> str:
    """Intimate (register) a claim into the claims workflow. Checks cover on the EVENT
    date — a policy lapsed today can still owe a claim — builds the document checklist
    and starts triage. Call with what you have; a missing benefit or cause comes back
    as buttons. Prefer this over register_claim for new claims."""
    return "{}"


class AdoptClaimArgs(ClaimLookupArgs):
    category: Optional[ClaimCategory] = None
    cause: Optional[Literal["Natural / illness", "Accident", "Suicide", "Other unnatural"]] = None
    covered_person_relationship: Optional[str] = None


@tool(args_schema=AdoptClaimArgs)
def adopt_claim_into_workflow(**kwargs) -> str:
    """Bring a claim registered on the claims register (register_claim / FNOL) into the
    workflow, so it gets an eligibility check, checklist and assessment."""
    return "{}"


@tool(args_schema=ClaimLookupArgs)
def verify_claim_eligibility(**kwargs) -> str:
    """Re-run the eligibility check on a claim (e.g. after a rider or cover record was corrected)."""
    return "{}"


class OverrideEligibilityArgs(ClaimLookupArgs):
    note: Optional[str] = Field(default=None, description="Why the ineligible claim may proceed (15+ characters). Permanent.")


@tool(args_schema=OverrideEligibilityArgs)
def override_claim_eligibility(**kwargs) -> str:
    """Claims manager only: let an INELIGIBLE claim proceed (ex-gratia or contested cover)."""
    return "{}"


class ClaimDocumentArgs(ClaimLookupArgs):
    action: Literal["request", "waive", "reject"] = Field(
        description="request = add a document to the checklist; waive = manager excuses a required one; "
        "reject = send a received one back to the claimant.")
    document: Optional[str] = Field(default=None, description="Checklist item label, e.g. 'Death certificate'.")
    reason: Optional[str] = Field(default=None, description="Required for reject. Optional for waive — never ask for one.")
    required: Optional[bool] = Field(default=True, description="For request: does the decision wait on it?")


@tool(args_schema=ClaimDocumentArgs)
def update_claim_document(**kwargs) -> str:
    """Change a claim's document checklist: request an extra document, waive a required
    one (manager), or reject a received one. Files themselves are uploaded in the claims workflow screen."""
    return "{}"


class ClaimInvestigationArgs(ClaimLookupArgs):
    action: Literal["finding", "complete"] = Field(description="finding = record one; complete = close the investigation.")
    note: Optional[str] = Field(default=None, description="What was found / the closing summary.")
    finding_kind: Optional[Literal["Verified", "Adverse", "Neutral"]] = None
    source: Optional[str] = Field(default=None, description="Hospital records, NADRA, field visit, police report…")
    outcome: Optional[Literal["Verified", "Adverse", "Inconclusive"]] = Field(default=None, description="For complete.")


@tool(args_schema=ClaimInvestigationArgs)
def record_claim_investigation(**kwargs) -> str:
    """Record an investigation finding on a red-flagged claim (contestable, early death,
    duplicate, fraud score, nominee mismatch) or complete the investigation. A claim
    with high flags cannot be assessed until it is complete."""
    return "{}"


class AssessClaimArgs(ClaimLookupArgs):
    disability_pct: Optional[float] = Field(default=None, description="Assessed disability % — required for disability claims.")
    copay_pct: Optional[float] = Field(default=None, description="Hospitalisation co-payment %.")
    deductions_json: Optional[str] = Field(
        default=None, description='Inadmissible items as JSON, e.g. [{"label": "Room upgrade", "amount": 15000}].')
    notes: Optional[str] = None


@tool(args_schema=AssessClaimArgs)
def assess_claim_benefit(**kwargs) -> str:
    """Calculate the contractual benefit payable — sum assured or rider, less premium
    arrears, inadmissible items and co-pay, capped at the amount claimed. Needs a
    complete document file and, if flagged, a completed investigation."""
    return "{}"


class DecideClaimArgs(ClaimLookupArgs):
    decision: Optional[Literal["Approve", "PartialApprove", "Reject", "RequestInfo", "Refer"]] = None
    amount: Optional[float] = Field(default=None, description="PartialApprove only: PKR below the assessed benefit.")
    reason: Optional[str] = Field(default=None, description="Required to reject, partly approve or refer; 15+ chars to approve a duplicate-flagged claim.")
    information_needed: Optional[list[str]] = Field(default=None, description="RequestInfo: what the claimant must provide.")


@tool(args_schema=DecideClaimArgs)
def decide_claim(**kwargs) -> str:
    """Decide an assessed claim: approve the assessed benefit, partially approve, reject,
    request more information, or refer to a claims manager. Above PKR 500,000 a
    manager decides. Approval derives the payees (nominees by share for death)."""
    return "{}"


class VerifyPayeeArgs(ClaimLookupArgs):
    payee_name: Optional[str] = Field(default=None, description="Which payee, when there are several nominees.")
    cnic: Optional[str] = None
    bank_name: Optional[str] = None
    account_title: Optional[str] = None
    iban: Optional[str] = Field(default=None, description="24-character Pakistani IBAN.")
    identity_verified_by: Optional[str] = Field(default=None, description="How identity was checked, e.g. 'Original CNIC seen, NADRA Verisys'.")
    note: Optional[str] = Field(default=None, description="Needed when the account title doesn't match the payee.")
    verify: Optional[bool] = Field(default=True, description="False to only save the details.")


@tool(args_schema=VerifyPayeeArgs)
def verify_claim_payees(**kwargs) -> str:
    """Record and verify one payee's identity and bank details on an approved claim
    (CNIC vs nominee on record, IBAN format, account title match). Every payee must be
    verified before disbursement can be authorised."""
    return "{}"


@tool(args_schema=ClaimLookupArgs)
def authorize_claim_disbursement(**kwargs) -> str:
    """Authorise payment of an approved claim once every payee is verified and the payee
    amounts equal the approved amount. Does NOT pay — disburse_claim_settlement does."""
    return "{}"


class DisburseClaimArgs(ClaimLookupArgs):
    method: Optional[Literal["Bank Transfer", "Pay Order", "JazzCash", "Easypaisa"]] = None


@tool(args_schema=DisburseClaimArgs)
def disburse_claim_settlement(**kwargs) -> str:
    """Pay an authorised claim to every verified payee and settle it. THIS MOVES MONEY:
    state the claim number and amount before calling."""
    return "{}"


class ReconcileClaimArgs(ClaimLookupArgs):
    note: Optional[str] = None


@tool(args_schema=ReconcileClaimArgs)
def reconcile_claim_settlement(**kwargs) -> str:
    """Reconcile a settled claim's payouts against the approved amount and each payee's share."""
    return "{}"


class CloseClaimFileArgs(ClaimLookupArgs):
    send_letter: Optional[bool] = Field(default=True, description="Email the closure letter to the claimant.")


@tool(args_schema=CloseClaimFileArgs)
def close_claim_file(**kwargs) -> str:
    """Close a reconciled settled claim or a rejected one, generate the closure letter
    and (by default) email it to the claimant. Death settlement also ends the cover."""
    return "{}"



# ═══════════════════════════════════════════════════════════════════════════
# Pre-proposal profile risk screening (profile_risk_tools.py)
# ═══════════════════════════════════════════════════════════════════════════

class CustomerRiskProfileArgs(BaseModel):
    cnic: Optional[str] = Field(default=None, description="Customer CNIC, if known.")
    customer_id: Optional[str] = Field(default=None, description="Customer UUID, never put it in the CNIC field.")
    customer_name: Optional[str] = Field(default=None, description="Stored customer name; asks for selection if ambiguous.")
    coverage_amount: Optional[float] = Field(default=None, gt=0, description="Sum assured to test. Defaults to the customer's selected plan or latest proposal.")


@tool(args_schema=CustomerRiskProfileArgs)
def assess_customer_risk_profile(**kwargs) -> str:
    """Screen an individual customer's or lead's profile for risk BEFORE or without a
    proposal: lists the safe and the risk factors (age, BMI, smoking, medical and family
    history, occupation, hazardous activities, conduct, cover vs income, credit) with each
    factor's percentage contribution — safe and risk together total 100% — plus the risk
    band and any missing information. Read-only. For a case's underwriting decision use
    get_risk_assessment / run_risk_assessment instead."""
    return "{}"

# ═══════════════════════════════════════════════════════════════════════════
# Commission administration — agreements, producer splits, exceptions
# (commission_tools.py)
# ═══════════════════════════════════════════════════════════════════════════

class ListAgreementsArgs(BaseModel):
    status: Optional[Literal["DRAFT", "APPROVED"]] = None
    search: Optional[str] = Field(default=None, description="Code or name.")


class CustomerCommissionSetupArgs(BaseModel):
    customer_id: Optional[str] = Field(default=None, description="Customer UUID, never put it in a CNIC field.")
    customer_name: Optional[str] = Field(default=None, description="Stored customer name; asks for selection if ambiguous.")


@tool(args_schema=CustomerCommissionSetupArgs)
def get_customer_commission_setup(**kwargs) -> str:
    """Read assigned agent, acquisition source and policy commission readiness for an
    individual customer, including quick leads without a CNIC. Use FIRST for customer
    commission setup/assignment questions. Never update the customer to perform a read.
    Returns missing approved agreements and producer splits; does not collect or pay."""
    return "{}"


@tool(args_schema=ListAgreementsArgs)
def list_commission_agreements(**kwargs) -> str:
    """List contractual commission agreements (code, version, first-year and renewal %,
    effective dates, DRAFT/APPROVED). These are the only source of commission rates."""
    return "{}"


class CreateAgreementArgs(BaseModel):
    code: Optional[str] = Field(default=None, description="Letters, digits, - and _, e.g. AGENCY-STD.")
    name: Optional[str] = None
    first_year_pct: Optional[float] = Field(default=None, description="% of first-year receipts. Never assume a default.")
    renewal_pct: Optional[float] = Field(default=None, description="% of renewal-year receipts.")
    effective_from: Optional[str] = Field(default=None, description="YYYY-MM-DD. Defaults to today.")
    effective_to: Optional[str] = None
    version: Optional[int] = Field(default=None, description="Defaults to the next version of this code.")


@tool(args_schema=CreateAgreementArgs)
def create_commission_agreement(**kwargs) -> str:
    """Draft a commission agreement (or a new version of one). It stays DRAFT until a
    DIFFERENT administrator approves it."""
    return "{}"


class ApproveAgreementArgs(BaseModel):
    code: Optional[str] = None
    version: Optional[int] = None


@tool(args_schema=ApproveAgreementArgs)
def approve_commission_agreement(**kwargs) -> str:
    """Approve a draft commission agreement (checker half of maker-checker — the admin
    who drafted it cannot approve it). Approved agreements are immutable."""
    return "{}"


@tool(args_schema=PolicyClaimLookupArgs)
def get_policy_commission_split(**kwargs) -> str:
    """Which producers earn on a policy, their split %, and under which agreement."""
    return "{}"


class AssignProducersArgs(PolicyClaimLookupArgs):
    payee_name: Optional[str] = Field(default=None, description="Single producer taking 100% (name or code).")
    agreement_code: Optional[str] = Field(default=None, description="Approved agreement for that single producer.")
    producers_json: Optional[str] = Field(
        default=None,
        description='Shared production, e.g. [{"payee": "AG-001", "agreement_code": "AGENCY-STD", "split_pct": 60}, ...]. Must total 100.')


@tool(args_schema=AssignProducersArgs)
def assign_policy_producers(**kwargs) -> str:
    """Set who earns commission on an individual policy and in what split, under approved
    agreements. Replaces the current split; frozen once any commission has posted."""
    return "{}"


@tool(args_schema=EmptyArgs)
def list_commission_exceptions() -> str:
    """Premium receipts that did not post commission, grouped by reason (no producer
    assigned, agreement not approved or out of date range, group/family policy)."""
    return "{}"


class ReconcileCommissionArgs(PolicyClaimLookupArgs):
    pass


@tool(args_schema=ReconcileCommissionArgs)
def reconcile_commission_receipts(**kwargs) -> str:
    """Re-run commission accrual for receipts in exception — for one policy, or all —
    after the cause (e.g. a missing producer assignment) was fixed."""
    return "{}"


class ExplainEarningArgs(BaseModel):
    policy_number: Optional[str] = None
    earning_id: Optional[str] = None


@tool(args_schema=ExplainEarningArgs)
def explain_commission_earning(**kwargs) -> str:
    """Show how a commission earning was calculated: receipt base × agreement rate ×
    producer split, policy year and agreement version. Agents see only their own.
    Use for "why did I get this commission on PL-2026-0001?"."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Specialist underwriting — medical & financial reviews, compiled into the
# final decision (specialist_review_tools.py)
# ═══════════════════════════════════════════════════════════════════════════

class ReviewLookupArgs(BaseModel):
    case_number: Optional[str] = Field(default=None, description="Application reference, e.g. APP-2026-19A187 or CASE-2026-19A187.")
    applicant_name: Optional[str] = Field(default=None, description="Applicant's name as stored.")
    cnic: Optional[str] = Field(default=None, description="Applicant CNIC. Never put a UUID here.")


class ListMyReviewsArgs(BaseModel):
    status: Optional[Literal["open", "closed", "PENDING", "IN_REVIEW", "CLEARED", "REFERRED", "DECLINED"]] = Field(
        default=None, description="Filter: 'open' (still in progress), 'closed' (approved/closed/rejected) or one review status.")


@tool(args_schema=ListMyReviewsArgs)
def list_my_underwriting_reviews(**kwargs) -> str:
    """Medical/Financial Underwriter only: the applications assigned to me on my track, with my review status.
    Read-only."""
    return "{}"


@tool(args_schema=ReviewLookupArgs)
def get_underwriting_review(**kwargs) -> str:
    """Medical/Financial Underwriter only: one assigned application's review workspace — my review status,
    my requirements (e-application questionnaire, medical exam or insurance history, documents), documents
    still needed from me, and whether AI underwriting can run yet — with the next step. Read-only."""
    return "{}"


@tool(args_schema=ReviewLookupArgs)
def start_my_review(**kwargs) -> str:
    """Medical/Financial Underwriter: take an unassigned application on my track (assigns it to me)."""
    return "{}"


class SendEApplicationArgs(ReviewLookupArgs):
    part: Optional[Literal["medical", "financial", "both"]] = Field(
        default=None, description="Which questionnaire. A specialist always sends their own track's; defaults to it.")


@tool(args_schema=SendEApplicationArgs)
def send_e_application_questionnaire(**kwargs) -> str:
    """Email the customer the medical and/or financial e-application questionnaire (a secure link each).
    A specialist sends only their own track's; resending replaces the old link but is refused once submitted."""
    return "{}"


class RunAiMedicalArgs(ReviewLookupArgs):
    confirm: Optional[bool] = Field(default=False, description=(
        "False (default): read the reports and show the AI's results to check. True ONLY after the user has "
        "explicitly confirmed recording those results (clicked 'Record these results')."))


@tool(args_schema=RunAiMedicalArgs)
def run_ai_medical_underwriting(**kwargs) -> str:
    """Medical Underwriter: AI medical underwriting. Works out the medical requirements if needed, checks every
    required test has an accepted report, has the AI read each result, and shows them for review. Only with
    confirm=true (after the user confirms) are the results recorded and rated (clinical outcome, loading)."""
    return "{}"


@tool(args_schema=ReviewLookupArgs)
def run_ai_financial_underwriting(**kwargs) -> str:
    """Financial Underwriter: AI financial underwriting — financial risk score, the cover the income supports
    and whether a referral is needed. Needs the financial e-application submitted, insurance history cleared and
    the plan's financial documents accepted. Analysis only: it records no decision."""
    return "{}"


class RecordReviewArgs(ReviewLookupArgs):
    decision: Literal["CLEARED", "REFERRED", "DECLINED", "IN_REVIEW"] = Field(description="The review outcome.")
    rationale: Optional[str] = Field(default=None, description="The underwriter's reason, in their words. Required for Cleared/Referred/Declined.")
    track: Optional[Literal["medical", "financial"]] = Field(default=None, description="Only for general underwriters; specialists use their own track.")
    confirm: Optional[bool] = Field(default=False, description="True ONLY after the user explicitly confirmed this exact decision and rationale.")


@tool(args_schema=RecordReviewArgs)
def record_underwriting_review(**kwargs) -> str:
    """Record my medical or financial review decision (Cleared / Referred / Declined) with a rationale. Without
    confirm=true it only shows what will be recorded; never decide on the underwriter's behalf."""
    return "{}"


class TrackUnderwritersArgs(BaseModel):
    track: Optional[Literal["medical", "financial"]] = Field(default=None, description="Only those who can take this track.")


@tool(args_schema=TrackUnderwritersArgs)
def list_track_underwriters(**kwargs) -> str:
    """The underwriters who can take the medical or financial review. Read-only."""
    return "{}"


class AssignTrackArgs(ReviewLookupArgs):
    track: Literal["medical", "financial"] = Field(description="Which review to assign.")
    underwriter_name: Optional[str] = Field(default=None, description="The underwriter's name or email. Asks with choices when omitted or ambiguous.")
    underwriter_id: Optional[str] = Field(default=None, description="The underwriter's user UUID, when already chosen.")


@tool(args_schema=AssignTrackArgs)
def assign_underwriting_track(**kwargs) -> str:
    """Admin: assign an application's medical or financial review to an underwriter."""
    return "{}"


@tool(args_schema=ReviewLookupArgs)
def get_specialist_reviews(**kwargs) -> str:
    """Final underwriting: both specialist reviews of an application (status, reviewer, rationale, AI results)
    plus the Agent's Confidential Report and PEP screening — and whether it is ready to compile. Read-only."""
    return "{}"


class CompileArgs(ReviewLookupArgs):
    confirm: Optional[bool] = Field(default=False, description="True ONLY after the user explicitly confirmed running the final compile.")


@tool(args_schema=CompileArgs)
def compile_final_underwriting(**kwargs) -> str:
    """Final underwriting: once the medical and financial reviews, the ACR and PEP screening are in, compile them
    with the AI risk assessment into the final recommendation (a specialist's decline or referral is never
    overridden). Without confirm=true it shows readiness and a summary only. It recommends; it does not approve."""
    return "{}"


SPECIALIST_REVIEW_TOOLS = [
    list_my_underwriting_reviews, get_underwriting_review, start_my_review, send_e_application_questionnaire,
    run_ai_medical_underwriting, run_ai_financial_underwriting, record_underwriting_review,
    list_track_underwriters, assign_underwriting_track, get_specialist_reviews, compile_final_underwriting,
]


ALL_TOOLS = [
    # navigation & discovery
    navigate_to_page,
    show_record,
    search_records,
    # read / list
    list_leads,
    list_cases,
    get_case_details,
    get_document_checklist,
    list_artifacts,
    list_users,
    list_acquisition_sources,
    list_organizations,
    list_family_groups,
    list_quotes,
    list_insurance_plans,
    get_risk_assessment,
    get_dashboard_stats,
    # customers
    resolve_customer_type,
    add_customer,
    update_customer,
    bulk_add_customers,
    # users / orgs / families
    add_user,
    update_user_role,
    set_user_active,
    delete_user,
    add_organization,
    add_family_group,
    prepare_family_insurance,
    # cases & policies
    create_case,
    update_case_status,
    assign_case,
    add_case_comment,
    delete_case,
    create_proposal,
    upload_document,
    run_risk_assessment,
    # pre-underwriting (the 5 gates)
    get_pre_underwriting_status,
    verify_e_application,
    submit_agent_confidential_report,
    run_compliance_screening,
    override_compliance_screening,
    run_insurance_history_check,
    assess_medical_examination,
    run_pre_underwriting_clearance,
    # policy lifecycle (steps 5–7)
    approve_case,
    get_pre_issuance_status,
    run_pre_issuance_verification,
    issue_policy,
    confirm_policy_payment,
    get_active_policy_status,
    # workflow
    get_workflow_recommendation,
    quick_start_workflow,
    start_underwriting_journey,
    continue_underwriting_journey,
    bulk_underwriting_journey,
    # rules engine
    list_rule_categories,
    list_rule_sets,
    get_rule_set,
    evaluate_rule_set,
    evaluate_rule_scope,
    get_rule_evaluation_logs,
    create_rule_set,
    create_rule_version,
    add_rule_to_version,
    update_rule,
    delete_rule,
    deploy_rule_version,
    archive_rule_version,
    create_rule_category,
    create_rule_subcategory,
    create_eligibility_profile,
    # claims
    list_claims,
    get_claim_details,
    get_claims_dashboard,
    get_claim_document_checklist,
    register_claim,
    update_claim_status,
    adjudicate_claim,
    issue_claim_payout,
    refer_claim_to_reinsurance,
    refer_claim_to_underwriting,
    resolve_claim_underwriting,
    upload_claim_document,
    start_claim_journey,
    continue_claim_journey,
    # group life / group family takaful
    start_group_journey,
    continue_group_journey,
    create_group_scheme,
    add_group_benefit_class,
    submit_group_census,
    upload_group_census,
    get_group_scheme_status,
    list_group_members,
    generate_group_quote,
    accept_group_quote,
    decline_group_quote,
    issue_group_policy,
    record_group_payment,
    preview_group_endorsement,
    apply_group_endorsement,
    list_group_endorsements,
    resolve_group_endorsement,
    settle_group_endorsement,
    start_group_renewal,
    get_group_renewal,
    decide_group_renewal,
    record_group_renewal_payment,
    register_group_claim,
    list_group_claims,
    preview_group_claim_payout,
    pay_group_claim,
    get_group_ptf_report,
    add_group_class_coverage,
    # commission engine
    list_commission_payees,
    get_commission_rate_card,
    calculate_commission,
    get_commission_ledger,
    get_agent_statement,
    get_commission_summary,
    create_payout_run,
    approve_payout_run,
    list_commission_rules,
    create_commission_rule,
    update_commission_rule,
    delete_commission_rule,
    toggle_commission_rule_active,
    list_incentive_schemes,
    create_incentive_scheme,
    update_incentive_scheme,
    delete_incentive_scheme,
    toggle_incentive_scheme_active,
    # evidence & medical review
    request_missing_documents,
    link_document_to_requirement,
    get_medical_report_status,
    read_medical_reports,
    record_medical_review,
    # recovery & availability
    get_operation_status,
    resume_operation,
    get_service_health,
    diagnose_connection,
    # individual policy servicing
    get_policy_delivery_status,
    retry_failed_delivery,
    get_onboarding_status,
    provision_portal_access,
    send_portal_invitation,
    get_premium_schedule,
    get_payment_receipt,
    send_premium_reminder,
    preview_policy_endorsement,
    submit_policy_endorsement,
    get_endorsement_status,
    get_renewal_readiness,
    preview_policy_renewal,
    submit_policy_renewal,
    get_reinstatement_requirements,
    submit_reinstatement_request,
    get_reinstatement_status,
    preview_policy_exit,
    submit_policy_exit_request,
    get_exit_status,
    # service requests & tickets
    create_service_request,
    get_service_request,
    add_request_attachment,
    submit_service_request,
    create_support_ticket,
    get_support_ticket,
    add_ticket_comment,
    assign_support_ticket,
    # exceptions, members & operations
    resolve_insurance_record,
    preview_application_transition,
    request_additional_evidence,
    refer_underwriting_review,
    get_member_workflow_matrix,
    resume_member_workflow,
    get_claim_blockers,
    get_work_queue,
    get_workflow_timeline,
    # claims workflow (7 steps)
    get_policy_claim_options,
    get_claim_workflow,
    intimate_claim,
    adopt_claim_into_workflow,
    verify_claim_eligibility,
    override_claim_eligibility,
    update_claim_document,
    record_claim_investigation,
    assess_claim_benefit,
    decide_claim,
    verify_claim_payees,
    authorize_claim_disbursement,
    disburse_claim_settlement,
    reconcile_claim_settlement,
    close_claim_file,
    # pre-proposal profile screening
    assess_customer_risk_profile,
    # commission administration
    get_customer_commission_setup,
    list_commission_agreements,
    create_commission_agreement,
    approve_commission_agreement,
    get_policy_commission_split,
    assign_policy_producers,
    list_commission_exceptions,
    reconcile_commission_receipts,
    explain_commission_earning,
    *SPECIALIST_REVIEW_TOOLS,
]

