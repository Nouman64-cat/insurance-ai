"""Role operations that had a staff UI and backend contract but no chat capability.

Found by walking each role's workspace against tenant-service routes (see
skills/reports/coverage.md). Declarations, role grants, step labels and domain
packs live here; handlers live in servicing_operations.py,
underwriting_operations.py and desk_operations.py (imported at the foot of
tool_executor.py).

The grants mirror the owning router's role checks. Where a router has no role
check of its own (premium collection, renewal stages, counter-offers) the grant
follows the workspace that owns the work, so chat never widens access. Paths,
methods and fields are fixed by the handlers; there is no arbitrary proxy.
"""
from __future__ import annotations

import functools
from datetime import date
from typing import Literal, Optional, Union

from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field, ValidationError


class _Args(BaseModel):
    # Unknown fields (tenant_id, url, ...) are dropped, never forwarded.
    model_config = ConfigDict(extra="ignore")


class PolicyRef(_Args):
    """Any one field identifies the issued policy."""
    policy_number: Optional[str] = Field(default=None, description="e.g. POLICY-2026-0001")
    cnic: Optional[str] = Field(default=None, description="The policyholder's CNIC.")
    policyholder_name: Optional[str] = None
    case_number: Optional[str] = Field(default=None, description="The application (APP-/CASE-) the policy came from.")


class CaseRef(_Args):
    """Any one field identifies the application."""
    case_number: Optional[str] = None
    applicant_name: Optional[str] = None
    cnic: Optional[str] = None


PaymentMethod = Literal["Cash", "Cheque", "BankTransfer", "JazzCash", "Easypaisa", "Card"]


class _ReceivedPayment(_Args):
    payment_method: Optional[PaymentMethod] = Field(default=None, description="How the customer actually paid.")
    payment_reference: Optional[str] = Field(default=None, max_length=150,
                                             description="The bank/receipt reference the user read off the real payment. Never invent one.")
    payment_confirmed: bool = Field(default=False, description="True only when the user confirms the funds were actually received.")


# ═══════════════════════════════════════════════════════════════════════════
# Policy servicing back office
# ═══════════════════════════════════════════════════════════════════════════

class RenewalStepArgs(PolicyRef, _ReceivedPayment):
    action: Literal["status", "send_notice", "evaluate_risk", "record_risk_decision", "record_acceptance",
                    "record_payment", "reconcile_payment", "complete", "cancel"] = "status"
    channel: Optional[Literal["Email", "SMS", "WhatsApp", "Letter"]] = None
    decision: Optional[Literal["Approve", "ApproveWithLoading", "Decline"]] = None
    loading_pct: Optional[float] = Field(default=None, gt=0, le=500)
    accepted: Optional[bool] = Field(default=None, description="The customer's answer to the renewal terms, as they gave it.")
    acceptance_method: Optional[str] = Field(default=None, description="How the customer answered, e.g. Portal, Branch, Phone.")
    note: Optional[str] = Field(default=None, max_length=2000, description="The user's own rationale. Never invent it.")


@tool(args_schema=RenewalStepArgs)
def progress_policy_renewal(**kwargs) -> str:
    """Work an open individual renewal case one stage at a time: status, send the notice, re-evaluate risk,
    record the underwriter's risk decision, record the customer's acceptance, record a premium already received
    (manual, with its real reference), reconcile, complete or cancel. Opening a renewal is submit_policy_renewal.
    Never simulates a gateway payment."""
    return "{}"


class ReinstatementStepArgs(PolicyRef, _ReceivedPayment):
    action: Literal["status", "recalculate_arrears", "record_declaration", "rerun_assessment", "record_decision",
                    "record_terms_response", "record_payment", "restore_cover", "withdraw"] = "status"
    answers: Optional[dict[str, bool]] = Field(default=None, description="Declaration question key -> the answer the signer gave.")
    answer_details: Optional[dict[str, str]] = Field(default=None, description="Details the signer gave for adverse answers.")
    signed_by: Optional[str] = None
    signature_method: Optional[Literal["Wet", "ESign", "Portal"]] = None
    signature_confirmed: bool = Field(default=False, description="True only when the user confirms the declaration is signed.")
    decision: Optional[Literal["Approve", "ApproveWithTerms", "RequestEvidence", "Decline"]] = None
    loading_pct: Optional[float] = Field(default=None, gt=0, le=500)
    exclusions: Optional[str] = None
    evidence_requested: Optional[list[str]] = Field(default=None, description="Labels of the evidence the underwriter asks for.")
    accepted: Optional[bool] = Field(default=None, description="The customer's answer to revised terms.")
    note: Optional[str] = Field(default=None, max_length=2000, description="The user's own rationale. Never invent it.")


@tool(args_schema=ReinstatementStepArgs)
def progress_reinstatement(**kwargs) -> str:
    """Work an open reinstatement request one stage at a time: status, recalculate arrears, record the signed
    health declaration (answers exactly as given), rerun the assessment, record the underwriter's decision, record
    the customer's response to revised terms, record arrears already received, restore cover, or withdraw.
    Opening the request is submit_reinstatement_request."""
    return "{}"


class Recoverable(_Args):
    label: str = Field(min_length=1, max_length=200)
    amount: float = Field(ge=0)
    note: Optional[str] = None


class ExitStepArgs(PolicyRef):
    action: Literal["status", "reverify_eligibility", "decide_extension", "waive_document", "record_consent",
                    "calculate_settlement", "record_settlement_response", "verify_payee", "authorize_settlement",
                    "disburse_settlement", "reconcile_settlement", "close", "cancel"] = "status"
    extension_decision: Optional[Literal["Declined", "Redirect"]] = None
    document: Optional[str] = Field(default=None, description="The document to waive, by name.")
    consent_given_by: Optional[str] = None
    consent_method: Optional[Literal["Signed form", "Portal", "Branch (in person)", "Phone (recorded)"]] = None
    consent_confirmed: bool = Field(default=False, description="True only when the customer accepted every exit declaration.")
    recoverables: Optional[list[Recoverable]] = Field(default=None, description="Deductions the user lists, e.g. an outstanding loan.")
    accepted: Optional[bool] = Field(default=None, description="The customer's answer to the settlement quote.")
    payee_cnic: Optional[str] = None
    bank_name: Optional[str] = None
    account_title: Optional[str] = None
    iban: Optional[str] = None
    payee_verified: bool = Field(default=False, description="True only when the user has checked the payee against evidence.")
    payout_method: Optional[Literal["Bank Transfer", "Pay Order", "JazzCash", "Easypaisa"]] = None
    note: Optional[str] = Field(default=None, max_length=2000, description="The user's own rationale. Never invent it.")


@tool(args_schema=ExitStepArgs)
def progress_policy_exit(**kwargs) -> str:
    """Work an open policy exit (surrender, maturity, expiry) one stage at a time: status, re-verify eligibility,
    decide an extension, waive a document, record consent, calculate the settlement, record the customer's answer,
    verify the payee, authorise (claims manager or admin), disburse, reconcile, close or cancel. Each step runs only
    when the case allows it. Opening a surrender is submit_policy_exit_request."""
    return "{}"


class InstalmentArgs(PolicyRef):
    installment_no: Optional[int] = Field(default=None, ge=1, description="Which instalment. Omit to be shown the outstanding ones.")


class CollectPremiumArgs(InstalmentArgs, _ReceivedPayment):
    pass


@tool(args_schema=CollectPremiumArgs)
def record_premium_collection(**kwargs) -> str:
    """Record a premium instalment the customer has ALREADY paid (cash, cheque, transfer) against the schedule,
    with its real reference. Issues the receipt and revives a grace-period policy once arrears clear. Never charges
    the customer or simulates a gateway payment."""
    return "{}"


class WaiveInstalmentArgs(InstalmentArgs):
    reason: Optional[str] = Field(default=None, max_length=1000, description="Why it is waived (goodwill, correction). Required.")


@tool(args_schema=WaiveInstalmentArgs)
def waive_premium_installment(**kwargs) -> str:
    """Waive one outstanding premium instalment with a stated reason. A waived instalment is no longer arrears."""
    return "{}"


class RestructureArgs(PolicyRef):
    frequency: Literal["Annual", "SemiAnnual", "Quarterly"]


@tool(args_schema=RestructureArgs)
def preview_premium_restructure(**kwargs) -> str:
    """Preview changing a policy's billing frequency mid-term: the new instalments and amounts. Saves nothing."""
    return "{}"


@tool(args_schema=RestructureArgs)
def restructure_premium_plan(**kwargs) -> str:
    """Change a policy's billing frequency mid-term. Paid instalments are kept; the outstanding amount is rebuilt
    into the new cadence. State the preview first."""
    return "{}"


@tool(args_schema=PolicyRef)
def issue_lapse_warning(**kwargs) -> str:
    """Generate the formal lapse-warning letter for a policy in grace with unpaid arrears, and log it as a final notice."""
    return "{}"


class AutopayArgs(PolicyRef):
    enabled: bool


@tool(args_schema=AutopayArgs)
def set_premium_autopay(**kwargs) -> str:
    """Turn the policy's standing payment instruction (auto-debit) on or off, as the customer asked."""
    return "{}"


class UpcomingRenewalsArgs(_Args):
    days: int = Field(default=90, ge=1, le=365, description="Look-ahead window in days.")


@tool(args_schema=UpcomingRenewalsArgs)
def list_upcoming_renewals(**kwargs) -> str:
    """List in-force individual policies expiring within the window (and those in grace), soonest first."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Underwriting decisions
# ═══════════════════════════════════════════════════════════════════════════

@tool(args_schema=CaseRef)
def get_counter_offer(**kwargs) -> str:
    """Read the counter-offer (revised terms) on an application: type, revised premium, validity and response."""
    return "{}"


class CounterOfferArgs(CaseRef):
    offer_type: Literal["Loading", "Exclusion", "ReducedSumAssured", "PlanSubstitution"]
    revised_loading_pct: Optional[float] = Field(default=None, gt=0, le=500)
    revised_coverage_amount: Optional[float] = Field(default=None, gt=0)
    revised_product_name: Optional[str] = None
    exclusions: Optional[list[str]] = None
    reason: Optional[str] = Field(default=None, max_length=2000, description="The underwriter's rationale. Required.")
    valid_days: Optional[int] = Field(default=None, ge=1, le=90)
    replace_existing: bool = Field(default=False, description="True only when the user wants a pending offer superseded.")


@tool(args_schema=CounterOfferArgs)
def make_counter_offer(**kwargs) -> str:
    """Underwriter: offer the applicant revised terms (loading, exclusion, reduced cover or another plan) instead of
    standard acceptance, with a stated reason. The customer must accept before issuance."""
    return "{}"


class CounterOfferResponseArgs(CaseRef):
    accepted: bool
    customer_confirmed: bool = Field(default=False, description="True only when the customer gave this answer themselves.")
    note: Optional[str] = Field(default=None, max_length=1000)


@tool(args_schema=CounterOfferResponseArgs)
def record_counter_offer_response(**kwargs) -> str:
    """Record the customer's own acceptance or refusal of a pending counter-offer. Declining ends the application
    as Not Taken Up."""
    return "{}"


class HoldArgs(CaseRef):
    reason: Optional[str] = Field(default=None, max_length=1000, description="Why underwriting is paused. Required.")


@tool(args_schema=HoldArgs)
def hold_underwriting_case(**kwargs) -> str:
    """Put an application's underwriting on hold where it stands. Every step is frozen until it is released."""
    return "{}"


class ReleaseArgs(CaseRef):
    note: Optional[str] = Field(default=None, max_length=1000)


@tool(args_schema=ReleaseArgs)
def release_underwriting_case(**kwargs) -> str:
    """Release a held application; underwriting resumes from the same step."""
    return "{}"


class CaseRequirementArgs(CaseRef):
    requirement: Optional[str] = Field(default=None, description="The requirement code or category to waive.")
    reason: Optional[str] = Field(default=None, max_length=1000, description="Why it is waived. Required.")


@tool(args_schema=CaseRequirementArgs)
def waive_case_requirement(**kwargs) -> str:
    """Underwriter: waive one underwriting requirement on an application, with a reason recorded on the case."""
    return "{}"


class ChangePlanArgs(CaseRef):
    plan_name: Optional[str] = Field(default=None, description="The plan to move the proposal to.")
    coverage_amount: Optional[float] = Field(default=None, gt=0)
    term_years: Optional[int] = Field(default=None, ge=1, le=60)
    dependent_name: Optional[str] = None
    dependent_dob: Optional[date] = None
    reason: Optional[str] = Field(default=None, max_length=1000)
    apply: bool = Field(default=False, description="False previews the impact; True applies it on the user's instruction.")


@tool(args_schema=ChangePlanArgs)
def change_case_plan(**kwargs) -> str:
    """Underwriter: move an application's proposal to another plan, cover or term. Previews the impact unless
    apply=true."""
    return "{}"


class IssuanceRequirementArgs(CaseRef):
    requirement: Optional[str] = Field(default=None, description="The pre-issuance requirement, by name.")
    action: Literal["verify", "waive"]
    note: Optional[str] = Field(default=None, max_length=1000, description="Required to waive.")


@tool(args_schema=IssuanceRequirementArgs)
def resolve_issuance_requirement(**kwargs) -> str:
    """Underwriter: verify a submitted pre-issuance requirement after reviewing it, or waive it with a reason."""
    return "{}"


class WaiverArgs(CaseRef):
    reason: Optional[str] = Field(default=None, max_length=1000, description="Why it is waived. Required.")


@tool(args_schema=WaiverArgs)
def waive_agent_confidential_report(**kwargs) -> str:
    """Underwriter: waive the agent's confidential report gate when it will not arrive, with a recorded reason."""
    return "{}"


@tool(args_schema=WaiverArgs)
def waive_medical_examination(**kwargs) -> str:
    """Underwriter or Medical Underwriter: waive the medical examination on an application, with a recorded reason."""
    return "{}"


class EmptyArgs(_Args):
    pass


@tool(args_schema=EmptyArgs)
def list_claim_underwriting_referrals(**kwargs) -> str:
    """Claims the claims department referred back to underwriting for a re-underwriting verdict, oldest first."""
    return "{}"


@tool(args_schema=CaseRef)
def get_policy_reinsurance(**kwargs) -> str:
    """Read an application's reinsurance position: retention, treaty and facultative share, any live referral,
    expected terms and the reinsurer panel."""
    return "{}"


class ReinsuranceReferArgs(CaseRef):
    reinsurer: Optional[str] = Field(default=None, description="The panel reinsurer, by code or name.")
    note: Optional[str] = Field(default=None, max_length=2000)


@tool(args_schema=ReinsuranceReferArgs)
def refer_policy_to_reinsurer(**kwargs) -> str:
    """Underwriter: refer an application to a panel reinsurer for facultative terms."""
    return "{}"


class ReinsurerResponseArgs(CaseRef):
    decision: Literal["Accept", "AcceptWithLoading", "AcceptWithExclusion", "Postpone", "Decline"]
    reinsurer_reference: Optional[str] = None
    extra_mortality_pct: Optional[float] = Field(default=None, ge=0)
    extra_premium_per_mille: Optional[float] = Field(default=None, ge=0)
    exclusions: Optional[list[str]] = None
    conditions: Optional[str] = None


@tool(args_schema=ReinsurerResponseArgs)
def record_reinsurer_response(**kwargs) -> str:
    """Underwriter: record the reinsurer's actual reply to a referral, exactly as received."""
    return "{}"


class ApplyReinsurerTermsArgs(CaseRef):
    valid_days: Optional[int] = Field(default=None, ge=1, le=90)
    note: Optional[str] = Field(default=None, max_length=2000)


@tool(args_schema=ApplyReinsurerTermsArgs)
def apply_reinsurer_terms(**kwargs) -> str:
    """Underwriter: apply the reinsurer's recorded terms to the application (may raise a counter-offer)."""
    return "{}"


class WithdrawReferralArgs(CaseRef):
    reason: Optional[str] = Field(default=None, max_length=1000)


@tool(args_schema=WithdrawReferralArgs)
def withdraw_reinsurance_referral(**kwargs) -> str:
    """Underwriter: withdraw an open reinsurance referral."""
    return "{}"


# ═══════════════════════════════════════════════════════════════════════════
# Desks: walk-in leads, ACR requests, claims authority, branches
# ═══════════════════════════════════════════════════════════════════════════

class WalkInQueueArgs(_Args):
    queue: Literal["all", "pending", "escalated", "unassigned", "mine"] = "pending"


@tool(args_schema=WalkInQueueArgs)
def list_walk_in_leads(**kwargs) -> str:
    """List walk-in leads routed from the branch/portal: who is assigned, acknowledgement due, overdue and escalated.
    An agent sees only their own."""
    return "{}"


class WalkInLeadArgs(_Args):
    lead_reference: str = Field(description="The walk-in lead's reference, e.g. WL-2026-0007, or the customer's name.")


@tool(args_schema=WalkInLeadArgs)
def acknowledge_walk_in_lead(**kwargs) -> str:
    """Acknowledge a walk-in lead assigned to you, stopping its escalation clock."""
    return "{}"


class ReassignLeadArgs(WalkInLeadArgs):
    agent_name: str = Field(description="The available agent to hand the lead to.")


@tool(args_schema=ReassignLeadArgs)
def reassign_walk_in_lead(**kwargs) -> str:
    """Manager: hand a walk-in lead to another available agent; the new agent is notified."""
    return "{}"


class ACRRequestsArgs(_Args):
    include_submitted: bool = False


@tool(args_schema=ACRRequestsArgs)
def list_my_acr_requests(**kwargs) -> str:
    """The agent confidential reports you have been asked to file, newest first."""
    return "{}"


@tool(args_schema=EmptyArgs)
def get_claim_authority_limits(**kwargs) -> str:
    """Read the delegated claims authority matrix: how much an adjuster and a manager may approve and authorise."""
    return "{}"


Limit = Union[float, Literal["unlimited"]]


class ClaimAuthorityArgs(_Args):
    role_name: Literal["ClaimsAdjuster", "ClaimsManager"]
    approve_limit: Optional[Limit] = Field(default=None, description="PKR, or 'unlimited'. Omit to keep the current limit.")
    authorize_limit: Optional[Limit] = Field(default=None, description="PKR, or 'unlimited'. Omit to keep the current limit.")


@tool(args_schema=ClaimAuthorityArgs)
def set_claim_authority_limit(**kwargs) -> str:
    """Admin: change a claims role's approval or settlement-authorisation limit. Unchanged limits are kept."""
    return "{}"


@tool(args_schema=EmptyArgs)
def list_branches(**kwargs) -> str:
    """List the organisation's branches and offices."""
    return "{}"


class BranchArgs(_Args):
    action: Literal["create", "update"]
    branch_code: str = Field(min_length=1, max_length=50, description="Existing code to update, or the new branch's code.")
    name: Optional[str] = None
    city: Optional[str] = None
    branch_type: Optional[Literal["HEAD_OFFICE", "REGIONAL_OFFICE", "BRANCH", "LIAISON_OFFICE"]] = None
    region: Optional[str] = None
    address: Optional[str] = None
    contact_person: Optional[str] = None
    contact_phone: Optional[str] = None
    contact_email: Optional[str] = None


@tool(args_schema=BranchArgs)
def manage_branch(**kwargs) -> str:
    """SuperAdmin: create a branch or update an existing branch's details. Deleting a branch stays in the console."""
    return "{}"


ROLE_OPERATION_TOOLS = [
    progress_policy_renewal, progress_reinstatement, progress_policy_exit, record_premium_collection,
    waive_premium_installment, preview_premium_restructure, restructure_premium_plan, issue_lapse_warning,
    set_premium_autopay, list_upcoming_renewals,
    get_counter_offer, make_counter_offer, record_counter_offer_response, hold_underwriting_case,
    release_underwriting_case, waive_case_requirement, change_case_plan, resolve_issuance_requirement,
    waive_agent_confidential_report, waive_medical_examination, list_claim_underwriting_referrals,
    get_policy_reinsurance, refer_policy_to_reinsurer, record_reinsurer_response, apply_reinsurer_terms,
    withdraw_reinsurance_referral,
    list_walk_in_leads, acknowledge_walk_in_lead, reassign_walk_in_lead, list_my_acr_requests,
    get_claim_authority_limits, set_claim_authority_limit, list_branches, manage_branch,
]

_ADMIN = frozenset({"SuperAdmin", "Admin"})
_UNDERWRITING = _ADMIN | {"Underwriter"}
# tenant-service policy_exit.py: _EXIT_ROLES and _MANAGERS.
EXIT_ROLES = _UNDERWRITING | {"ClaimsAdjuster", "ClaimsManager"}
EXIT_MANAGERS = _ADMIN | {"ClaimsManager"}

# Who may run each tool, on web and mobile alike. Checked before every other
# RBAC rule, so a role absent here is denied however permissive its allow-list.
TOOL_ROLES: dict[str, frozenset[str]] = {
    **{name: _UNDERWRITING for name in (
        "progress_policy_renewal", "progress_reinstatement", "record_premium_collection",
        "waive_premium_installment", "restructure_premium_plan", "issue_lapse_warning", "set_premium_autopay",
        "make_counter_offer", "hold_underwriting_case", "release_underwriting_case", "waive_case_requirement",
        "change_case_plan", "resolve_issuance_requirement", "waive_agent_confidential_report",
        "get_policy_reinsurance", "refer_policy_to_reinsurer", "record_reinsurer_response",
        "apply_reinsurer_terms", "withdraw_reinsurance_referral", "reassign_walk_in_lead")},
    "progress_policy_exit": EXIT_ROLES,
    "preview_premium_restructure": _UNDERWRITING | {"Agent", "CustomerService"},
    "list_upcoming_renewals": _UNDERWRITING | {"Agent", "CustomerService", "Viewer"},
    "get_counter_offer": _UNDERWRITING | {"Agent", "CustomerService"},
    "record_counter_offer_response": _UNDERWRITING | {"Agent"},
    "waive_medical_examination": _UNDERWRITING | {"Medical Underwriter"},
    "list_claim_underwriting_referrals": _UNDERWRITING | {"Medical Underwriter", "Financial Underwriter"},
    "list_walk_in_leads": _UNDERWRITING | {"Agent"},
    "acknowledge_walk_in_lead": _UNDERWRITING | {"Agent"},
    "list_my_acr_requests": _UNDERWRITING | {"Agent"},
    "get_claim_authority_limits": _ADMIN | {"ClaimsManager", "ClaimsAdjuster"},
    "set_claim_authority_limit": _ADMIN,
    "list_branches": _ADMIN,
    "manage_branch": frozenset({"SuperAdmin"}),
}

READ_TOOLS = frozenset({
    "preview_premium_restructure", "list_upcoming_renewals", "get_counter_offer", "list_claim_underwriting_referrals",
    "get_policy_reinsurance", "list_walk_in_leads", "list_my_acr_requests", "get_claim_authority_limits", "list_branches",
})
MUTATING = frozenset(TOOL_ROLES) - READ_TOOLS
# tenant-service routers/branches.py: verify_superadmin.
SUPERADMIN_ONLY = frozenset(name for name, roles in TOOL_ROLES.items() if "Admin" not in roles)

STEP_LABELS = {
    "progress_policy_renewal": "Working the renewal case",
    "progress_reinstatement": "Working the reinstatement request",
    "progress_policy_exit": "Working the policy exit",
    "record_premium_collection": "Recording the premium received",
    "waive_premium_installment": "Waiving the instalment",
    "preview_premium_restructure": "Previewing the new payment plan",
    "restructure_premium_plan": "Restructuring the payment plan",
    "issue_lapse_warning": "Issuing the lapse warning",
    "set_premium_autopay": "Updating auto-debit",
    "list_upcoming_renewals": "Checking upcoming renewals",
    "get_counter_offer": "Checking the counter-offer",
    "make_counter_offer": "Issuing the counter-offer",
    "record_counter_offer_response": "Recording the customer's response",
    "hold_underwriting_case": "Putting underwriting on hold",
    "release_underwriting_case": "Releasing the hold",
    "waive_case_requirement": "Waiving the requirement",
    "change_case_plan": "Changing the plan",
    "resolve_issuance_requirement": "Resolving the pre-issuance requirement",
    "waive_agent_confidential_report": "Waiving the agent's report",
    "waive_medical_examination": "Waiving the medical examination",
    "list_claim_underwriting_referrals": "Checking claim referrals",
    "get_policy_reinsurance": "Checking the reinsurance position",
    "refer_policy_to_reinsurer": "Referring to the reinsurer",
    "record_reinsurer_response": "Recording the reinsurer's response",
    "apply_reinsurer_terms": "Applying the reinsurer's terms",
    "withdraw_reinsurance_referral": "Withdrawing the referral",
    "list_walk_in_leads": "Checking walk-in leads",
    "acknowledge_walk_in_lead": "Acknowledging the lead",
    "reassign_walk_in_lead": "Reassigning the lead",
    "list_my_acr_requests": "Checking your report requests",
    "get_claim_authority_limits": "Checking claims authority",
    "set_claim_authority_limit": "Updating claims authority",
    "list_branches": "Checking branches",
    "manage_branch": "Saving the branch",
}

# Domain packs (toolsets.DOMAIN_TOOLS) and the words that bind them.
DOMAINS: dict[str, set[str]] = {
    "servicing_ops": {"progress_policy_renewal", "progress_reinstatement", "progress_policy_exit",
                      "record_premium_collection", "waive_premium_installment", "preview_premium_restructure",
                      "restructure_premium_plan", "issue_lapse_warning", "set_premium_autopay", "list_upcoming_renewals"},
    "underwriting_ops": {"get_counter_offer", "make_counter_offer", "record_counter_offer_response",
                         "hold_underwriting_case", "release_underwriting_case", "waive_case_requirement",
                         "change_case_plan", "resolve_issuance_requirement", "waive_agent_confidential_report",
                         "waive_medical_examination", "list_claim_underwriting_referrals", "get_policy_reinsurance",
                         "refer_policy_to_reinsurer", "record_reinsurer_response", "apply_reinsurer_terms",
                         "withdraw_reinsurance_referral"},
    "desk_ops": {"list_walk_in_leads", "acknowledge_walk_in_lead", "reassign_walk_in_lead", "list_my_acr_requests",
                 "get_claim_authority_limits", "set_claim_authority_limit", "list_branches", "manage_branch"},
}
KEYWORDS: dict[str, tuple[str, ...]] = {
    "servicing_ops": ("renewal", "renew", "reinstat", "surrender", "maturity", "policy exit", "instalment", "installment",
                      "collect premium", "premium received", "waive", "restructure", "billing frequency", "lapse",
                      "autopay", "auto-debit", "auto debit", "arrears", "expiring"),
    "underwriting_ops": ("counter-offer", "counter offer", "revised terms", "on hold", "hold the case", "release the",
                         "waive", "requirement", "change the plan", "change plan", "reinsur", "facultative",
                         "acr", "confidential report", "medical exam", "claim referral", "re-underwrit"),
    "desk_ops": ("walk-in", "walk in", "lead", "acknowledge", "reassign", "acr request", "report request",
                 "authority", "approval limit", "authorisation limit", "authorization limit", "branch", "branches"),
}


def operation(name: str):
    """Register `fn(args_model, ctx)` as the handler for `name`.

    The model call validates the declared schema (the executor otherwise passes
    raw tool-call args), the role is re-checked as in capability_tools, and a
    403 carrying a business rule is relayed rather than flattened.
    """
    from tool_executor import handles, relay_forbidden
    model = next(t.args_schema for t in ROLE_OPERATION_TOOLS if t.name == name)

    def register(fn):
        @functools.wraps(fn)
        async def handler(args, ctx):
            if ctx.exec_ctx.role not in TOOL_ROLES[name]:
                return {"success": False, "error_code": "forbidden", "retryable": False,
                        "error": "An authorized colleague in the owning workspace must perform this action."}
            try:
                parsed = model.model_validate(args or {})
            except ValidationError as exc:
                return {"success": False, "error_code": "validation", "needs_user_input": True, "retryable": False,
                        "error": "Some details are missing or invalid: "
                                 + "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors(include_input=False))}
            return await fn(parsed, ctx)
        handles(name)(relay_forbidden(handler))
        return fn
    return register
