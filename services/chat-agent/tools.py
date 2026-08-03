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

RecordType = Literal[
    "customer", "case", "user", "organization", "family",
    "quote", "artifact", "assessment", "plan",
]


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
        description="Anything that identifies it — name, CNIC, case number, email, "
        "organization name, or a raw id."
    )


@tool(args_schema=ShowRecordArgs)
def show_record(record_type: str, identifier: str) -> str:
    """Find one specific record, navigate to the page that lists it, and visually
    highlight it so the user can see exactly which row it is. Use this whenever
    the user asks to SEE, VIEW, FIND, OPEN or LOCATE a particular record
    ("show me Ahmed Khan", "where is case CASE-2026-A3F9C1", "pull up that
    organization"). Prefer this over plain navigate_to_page when a specific
    record is named — it lands on the row, not just the list."""
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
    """Fetch the full detail of one case — status, applicant, policy, latest AI
    decision, and assigned underwriter."""
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
    role: Optional[Literal["SuperAdmin", "Admin", "Underwriter", "Agent", "Viewer"]] = None


@tool(args_schema=ListUsersArgs)
def list_users(**kwargs) -> str:
    """List system users, optionally filtered by role. Useful before assign_case
    to find out who is available to take the work."""
    return "{}"


class EmptyArgs(BaseModel):
    pass


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
    """List generated quotations / proposals with their premium figures."""
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


@tool(args_schema=AddCustomerArgs)
def add_customer(**kwargs) -> str:
    """Register a new customer/applicant. First step of the insurance journey."""
    return "{}"


class UpdateCustomerArgs(BaseModel):
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
    pass only the fields that change."""
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
    role_name: Literal["SuperAdmin", "Admin", "Underwriter", "Agent", "Viewer"]


@tool(args_schema=AddUserArgs)
def add_user(**kwargs) -> str:
    """Add a new system user (admin, underwriter, agent…)."""
    return "{}"


class DeleteUserArgs(BaseModel):
    email: Optional[str] = None
    full_name: Optional[str] = None


@tool(args_schema=DeleteUserArgs)
def delete_user(**kwargs) -> str:
    """Remove a system user."""
    return "{}"


class AddOrganizationArgs(BaseModel):
    name: str
    contact_person: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None


@tool(args_schema=AddOrganizationArgs)
def add_organization(**kwargs) -> str:
    """Add a corporate / group-life client organization."""
    return "{}"


class FamilyMember(BaseModel):
    cnic: str
    name: str
    dob: str
    gender: Literal["Male", "Female", "Other"]
    relationship: Literal["Self", "Spouse", "Child", "Parent"]
    occupation: str
    declared_income: float
    is_smoker: Optional[bool] = None
    height_cm: Optional[float] = None
    weight_kg: Optional[float] = None


class AddFamilyGroupArgs(BaseModel):
    name: str
    contact_person: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    household_declared_income: Optional[float] = None
    members: Optional[list[FamilyMember]] = Field(
        default=None, description="Members to enroll. Exactly one must be 'Self'."
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


@tool(args_schema=CreateProposalArgs)
def create_proposal(**kwargs) -> str:
    """Create the insurance proposal/policy that defines product, coverage and
    term. Required before a risk assessment can run."""
    return "{}"


class UploadDocumentArgs(BaseModel):
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None
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

@tool(args_schema=CaseLookupArgs)
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

class GetRecommendationArgs(BaseModel):
    action_context: str = Field(
        description="Where the user is in the journey, e.g. 'customer added', "
        "'case created', 'assessment complete'."
    )


@tool(args_schema=GetRecommendationArgs)
def get_workflow_recommendation(**kwargs) -> str:
    """Work out the best next step given where the user currently is. Call this
    after every completed action — it drives the recommendation buttons the UI
    renders under the chat."""
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


@tool(args_schema=QuickStartArgs)
def quick_start_workflow(**kwargs) -> str:
    """Spin up a demo applicant with realistic auto-generated details so the user
    can exercise the platform without typing data. Use whenever they say
    "demo", "test data", "sample", "generic data", "just make something up",
    or "show me how this works". With full_journey=true it also creates the
    case and proposal and kicks off the assessment."""
    return "{}"


ALL_TOOLS = [
    # navigation & discovery
    navigate_to_page,
    show_record,
    search_records,
    # read / list
    list_customers,
    list_cases,
    get_case_details,
    get_document_checklist,
    list_artifacts,
    list_users,
    list_organizations,
    list_family_groups,
    list_quotes,
    list_insurance_plans,
    get_risk_assessment,
    get_dashboard_stats,
    # customers
    add_customer,
    update_customer,
    delete_customer,
    bulk_add_customers,
    # users / orgs / families
    add_user,
    delete_user,
    add_organization,
    add_family_group,
    # cases & policies
    create_case,
    update_case_status,
    assign_case,
    add_case_comment,
    delete_case,
    create_proposal,
    upload_document,
    run_risk_assessment,
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
]
