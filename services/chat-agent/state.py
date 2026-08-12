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
