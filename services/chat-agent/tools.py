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
    agent_name: Optional[str] = Field(
        default=None,
        description="Name or email of the Agent who owns this lead. Only needed when the caller "
        "isn't themselves an Agent — leave unset otherwise, the tool figures out who to ask.",
    )


@tool(args_schema=AddCustomerArgs)
def add_customer(**kwargs) -> str:
    """Register a new customer/applicant. First step of the insurance journey. If the caller is an
    Agent, the lead is auto-assigned to them. Otherwise the tool will ask who the agent is — don't
    pre-ask for agent_name yourself, let the tool's response drive that."""
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
    agent_name: Optional[str] = Field(
        default=None,
        description="Name or email of the Agent who owns this lead. Only needed when the caller "
        "isn't themselves an Agent — leave unset otherwise, the tool figures out who to ask.",
    )


@tool(args_schema=QuickStartArgs)
def quick_start_workflow(**kwargs) -> str:
    """Spin up a demo applicant with realistic auto-generated details so the user
    can exercise the platform without typing data. Use whenever they say
    "demo", "test data", "sample", "generic data", "just make something up",
    or "show me how this works". With full_journey=true it also creates the
    case and proposal and kicks off the assessment."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Pre-Underwriting clearance (the 6 gates before risk assessment)
# ═══════════════════════════════════════════════════════════════════════════

@tool(args_schema=CaseLookupArgs)
def get_pre_underwriting_status(**kwargs) -> str:
    """Fetch the status of the 6 pre-underwriting clearance gates for a case:
    1. E-Application (customer medical/lifestyle form)
    2. Agent's Confidential Report (ACR - moral hazard & KYC)
    3. Compliance Screening (PEP, Sanctions, AML, SECP)
    4. Initial Premium Payment (IPP - Section 30 "no premium, no risk")
    5. SECP Insurance History (HLV & cumulative exposure)
    6. Medical Examination (Non-Medical Limit NML grid & panel clinics)
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


class SubmitACRArgs(BaseModel):
    case_number: Optional[str] = None
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None
    recommendation: Optional[Literal["Recommend", "RecommendWithCaution", "DoNotRecommend", "STANDARD_RISK"]] = "Recommend"
    remarks: Optional[str] = "Applicant verified in person. Moral hazard and financial standing satisfactory."


@tool(args_schema=SubmitACRArgs)
def submit_agent_confidential_report(**kwargs) -> str:
    """Gate 2: File the Agent's Confidential Report (ACR). Call this immediately when asked — do NOT ask the user for recommendation/remarks first, the tool itself decides what happens: it opens the real ACR form in the UI for the case's Agent to fill and sign, or tells the caller to ask their Agent to do it if they aren't one."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def run_compliance_screening(**kwargs) -> str:
    """Gate 3: Run automated PEP, Sanctions, AML, and SECP compliance screening for the pre-underwriting case. If it comes back Flagged, do not treat that as an error — offer to proceed anyway."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def override_compliance_screening(**kwargs) -> str:
    """Gate 3 override: clears a Flagged compliance screening result and proceeds, after the user explicitly confirms (e.g. clicks 'Proceed Anyway'). Only call this when the user has confirmed they want to proceed despite the flag."""
    return "{}"


class ProcessIPPArgs(BaseModel):
    case_number: Optional[str] = None
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None
    payment_method: Optional[str] = Field(default="JazzCash", description="Payment method: JazzCash, Easypaisa, Card, BankTransfer.")


@tool(args_schema=ProcessIPPArgs)
def process_initial_premium_payment(**kwargs) -> str:
    """Gate 4: Initiate and realize the Section 30 Initial Premium Payment (IPP) priced off the pre-underwriting quote. payment_method already defaults to JazzCash — call this immediately when asked, do NOT ask the user to choose a method first unless they want to change it."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def run_insurance_history_check(**kwargs) -> str:
    """Gate 5: Run the SECP shared industry insurance history screen, checking cumulative sum assured against HLV and policy churning."""
    return "{}"


class AssessMedicalExamArgs(BaseModel):
    case_number: Optional[str] = None
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None


@tool(args_schema=AssessMedicalExamArgs)
def assess_medical_examination(**kwargs) -> str:
    """Gate 6: Assess the applicant against the Non-Medical Limit (NML) grid. If diagnostics are mandated, generates the customer's tokenized panel-clinic booking link (same as Gate 1's E-Application link) — the gate clears once the customer books and completes the exam, not immediately."""
    return "{}"


@tool(args_schema=CaseLookupArgs)
def run_pre_underwriting_clearance(**kwargs) -> str:
    """Run all 6 pre-underwriting clearance gates in sequence (E-Application, ACR, Compliance, IPP, Insurance History, Medical Exam) so the case is 100% ready for AI Risk Assessment. Use when the user says "clear all gates", "run pre-underwriting", "complete pre-underwriting checks"."""
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
    notes: Optional[str] = None


@tool(args_schema=RegisterClaimArgs)
def register_claim(**kwargs) -> str:
    """Register a First Notice of Loss (FNOL) — opens a claim against an active
    policy, auto-generates the claim number, runs duplicate detection and opens
    the linked SLA case. Call it with whatever you have; the platform presents
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
    """List everyone who can be owed commission — producers, sales and branch
    managers, agencies, brokers, bank partners, referral partners — with their
    licence status and year-to-date earnings."""
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
        Literal["ACCRUED", "PAYABLE", "IN_RUN", "PARTIALLY_RELEASED", "DISBURSED", "CLAWED_BACK", "HELD"]
    ] = None
    limit: int = Field(default=20)


@tool(args_schema=LedgerArgs)
def get_commission_ledger(**kwargs) -> str:
    """List commission ledger entries — what has been earned, what is payable,
    what is held and what has been disbursed."""
    return "{}"


class StatementArgs(BaseModel):
    payee_name: str = Field(description="Agent or payee name.")
    period: Optional[str] = Field(default=None, description="YYYY-MM. Defaults to the current month.")


@tool(args_schema=StatementArgs)
def get_agent_statement(**kwargs) -> str:
    """Produce one payee's commission statement for a period — gross earnings,
    deductions, tax withheld and net payable."""
    return "{}"


@tool(args_schema=EmptyArgs)
def get_commission_summary() -> str:
    """Portfolio-level commission position: total accrued, payable, held and
    disbursed, plus the top earning producers."""
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
    # pre-underwriting (the 6 gates)
    get_pre_underwriting_status,
    verify_e_application,
    submit_agent_confidential_report,
    run_compliance_screening,
    override_compliance_screening,
    process_initial_premium_payment,
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
]

