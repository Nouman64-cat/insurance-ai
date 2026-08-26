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
