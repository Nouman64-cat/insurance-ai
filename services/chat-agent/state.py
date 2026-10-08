from typing import Annotated, Any, Optional

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from typing_extensions import TypedDict


class ChatState(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    tenant_id: str
    user_role: str
    platform: str  # "web" or "mobile" — see permission.py
    jwt_token: str
    last_action: Optional[dict[str, Any]]
    # Domain tool-packs bound on the previous turn (see toolsets.py). Carried
    # forward so a multi-step flow keeps its tools once the triggering keyword
    # has scrolled out of the matching window.
    active_domains: list[str]
    # Agent picked at the very start of customer intake (resolve_customer_type),
    # applied to the create call that follows and then cleared. Only ever set
    # for non-Agent roles — an Agent is auto-assigned as their own lead's owner.
    lead_agent: Optional[str]
    # Acquisition source picked at the very start of intake, same lifecycle as
    # lead_agent. {"id": <uuid or None>, "name": <label>} — id None means the user
    # chose "Direct" (no source). None = never asked.
    lead_source: Optional[dict[str, Any]]
    # True once the customer-intake questions (source / agent / type) have been
    # answered and until the customer is created. Lets later steps know they are part
    # of that guided flow — which, for demo data, means the proposal steps, never the
    # automated full journey — even for an Agent login, who is asked neither source
    # nor agent.
    lead_intake: Optional[bool]
    # The tool the guided intake resolved the customer type to (add_customer / add_family_group / add_organization),
    # so "Add demo data" can be answered without asking the model to invent anything.
    lead_tool: Optional[str]

    # ── Autonomous underwriting journey (agentic pipeline) ──────────────────
    # The tool_call that launched the pipeline — j_finish answers it with a
    # single consolidated ToolMessage (Gemini requires every call answered).
    pending_call: Optional[dict[str, Any]]
    # Where the applicant currently is: lead_intake, case_creation,
    # proposal_structuring, document_audit, risk_assessment,
    # underwriting_decision, case_closure, completed.
    journey_stage: Optional[str]
    journey_cnic: Optional[str]
    journey_customer_id: Optional[str]
    journey_case_id: Optional[str]
    journey_case_number: Optional[str]
    journey_product: Optional[dict[str, Any]]
    journey_missing_documents: list[str]
    journey_pre_underwriting: Optional[dict[str, Any]]
    journey_risk: Optional[dict[str, Any]]
    journey_outcome: Optional[str]  # Approved | Rejected | Under Review | Pending Documents
    requires_human_intervention: bool
    # Immutable, timestamped log of every pipeline transition — written to the
    # case as a comment at closure for regulatory audit.
    journey_audit: list[str]
    # Set by a failing node so j_finish can report instead of crashing the run.
    journey_error: Optional[str]
    # Transient UI markers — routers/chat.py turns these into animated `step`
    # SSE events. Declared as state channels only so node updates carrying
    # them are valid; their values are overwritten at every stage.
    journey_done: Optional[dict[str, Any]]
    journey_next: Optional[dict[str, Any]]

    # ── Autonomous claims journey (claims_journey.py) ───────────────────────
    # Deliberately a separate namespace from the `journey_*` keys above: an
    # underwriting journey and a claims journey can both be suspended on the
    # same thread (a claim referred back to underwriting is exactly that), so
    # sharing the keys would have one pipeline resume into the other's state.
    # The two exceptions are `pending_call` and the transient journey_done /
    # journey_next UI markers, which are per-turn and shared on purpose.
    claim_stage: Optional[str]
    claim_id: Optional[str]
    claim_number: Optional[str]
    claim_record: Optional[dict[str, Any]]
    claim_missing_documents: list[str]
    claim_referral_reasons: list[str]
    claim_decision: Optional[str]
    claim_payout: Optional[dict[str, Any]]
    # Settled | Declined | Pending Documents | Underwriting Referral | Manager Review
    claim_outcome: Optional[str]
    requires_claim_intervention: bool
    claim_audit: list[str]
    claim_error: Optional[str]
    # Chips carried out of a node that failed a gate, so the suspension is
    # still one click to clear (see claims_journey._finish_actions).
    claim_blocking_actions: list[dict[str, Any]]

    # ── Autonomous group-scheme journey (group_journey.py) ──────────────────
    # Its own `group_*` namespace, for the same reason the claims journey has
    # `claim_*`: a group scheme and an individual case (or a claim) can be
    # suspended on one thread at once, and shared keys would let one pipeline
    # resume into another's state. The transient journey_done / journey_next UI
    # markers and `pending_call` are per-turn and shared on purpose.
    # The corporate being worked on in this conversation. Unlike group_organization_id (a journey's own working
    # state, reset when one starts) this is remembered across turns, so a company that shares its name with others
    # is never asked about again once one of them has been chosen or has just been saved.
    group_current_org_id: Optional[str]
    group_current_org_name: Optional[str]
    group_stage: Optional[str]
    group_organization_id: Optional[str]
    group_organization_name: Optional[str]
    group_master_policy_id: Optional[str]
    group_plan_code: Optional[str]
    group_business_type: Optional[str]          # Conventional | Takaful
    group_quote: Optional[dict[str, Any]]
    group_scheme: Optional[dict[str, Any]]      # latest scheme snapshot (status, counts, classes)
    group_pending_members: list[str]            # above-FCL members awaiting an underwriting decision
    group_census_errors: list[str]
    group_missing_nominations: list[str]
    # Census_Needed | Census_Invalid | Underwriting_Pending | Awaiting_Acceptance |
    # Awaiting_Payment | Declined | Completed
    group_outcome: Optional[str]
    requires_group_intervention: bool
    group_audit: list[str]
    group_error: Optional[str]
    # Chips carried out of a node that stopped on a question the user must answer
    # (e.g. which Agent owns a new organization), so the suspension is one click.
    group_blocking_actions: list[dict[str, Any]]
