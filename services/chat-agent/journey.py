"""The autonomous underwriting journey — the 7-stage agentic pipeline.

Implements the staged state machine from the underwriting flow spec as real
LangGraph nodes: once the user confirms `start_underwriting_journey`, the
graph drives Intake → Case → Proposal → Document Audit → Risk Assessment →
Decision → Closure deterministically, with no further hand-holding. It
suspends in exactly two places, mirroring the spec's HITL checkpoints:

  - Document audit fails      → outcome "Pending Documents", upload chips
  - Decision says human review → outcome "Under Review", approve/reject chips

`continue_underwriting_journey` re-enters through `j_resume`, which routes to
the right stage from persisted state — so an upload or a human decision picks
the pipeline up exactly where it stopped.

Every node reuses the battle-tested REST handlers in tool_executor (the same
code the individual tools run), appends to the immutable `journey_audit`
trail, and reports itself to the UI through `journey_done` / `journey_next`
markers that routers/chat.py turns into animated state-graph steps.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

from langchain_core.messages import ToolMessage

from pages import build_route
from state import ChatState
from tool_executor import ExecCtx, execute_tool

# Stage metadata: node -> (stage id, UI label). Order matters for the
# "what comes next" markers.
STAGES: dict[str, tuple[str, str]] = {
    "j_intake":   ("lead_intake",           "Stage 1 · Lead Intake"),
    "j_case":     ("case_creation",         "Stage 2 · Case Creation"),
    "j_proposal": ("proposal_structuring",  "Stage 3 · Proposal Structuring"),
    "j_audit":    ("document_audit",        "Stage 4 · Document Audit"),
    "j_risk":     ("risk_assessment",       "Stage 5 · AI Risk Assessment"),
    "j_decide":   ("underwriting_decision", "Stage 6 · Underwriting Decision"),
    "j_close":    ("case_closure",          "Stage 7 · Case Closure"),
}


def _ctx(state: ChatState) -> ExecCtx:
    return ExecCtx(tenant_id=state.get("tenant_id", ""), jwt_token=state.get("jwt_token", ""))


def _log(state: ChatState, entry: str) -> list[str]:
    stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
    return [*state.get("journey_audit", []), f"[{stamp}] {entry}"]


def _mark(node: str, *, next_node: Optional[str], status: str = "done") -> dict[str, Any]:
    """UI process-graph markers consumed by routers/chat.py."""
    sid, label = STAGES[node]
    out: dict[str, Any] = {"journey_done": {"id": f"stage:{sid}", "label": label, "status": status}}
    if next_node and next_node in STAGES:
        nid, nlabel = STAGES[next_node]
        out["journey_next"] = {"id": f"stage:{nid}", "label": nlabel}
    return out


def _fail(state: ChatState, node: str, error: str) -> dict[str, Any]:
    return {
        "journey_error": error,
        "journey_audit": _log(state, f"ERROR at {STAGES[node][1]}: {error}"),
        **_mark(node, next_node=None, status="error"),
    }


# ═══════════════════════════════════════════════════════════════════════════
# Stage nodes
# ═══════════════════════════════════════════════════════════════════════════

async def j_intake(state: ChatState) -> dict:
    """Stage 1 — resolve or register the applicant."""
    args = (state.get("pending_call") or {}).get("args", {})
    ctx = _ctx(state)

    # Existing customer first: cnic or name lookup.
    found = await execute_tool("list_customers", {"search": args.get("cnic") or args.get("applicant_name"), "limit": 1}, ctx)
    if not found.get("success", True):
        # Auth/service failure ≠ "customer doesn't exist" — report the truth.
        return _fail(state, "j_intake", found.get("error") or "Could not reach the customer registry.")
    customers = found.get("customers") or []
    if customers:
        c = customers[0]
        cnic = c.get("cnic")
        return {
            "journey_stage": "case_creation",
            "journey_cnic": cnic,
            "journey_customer_id": c.get("id"),
            "journey_audit": _log(state, f"Applicant resolved: {c.get('first_name', '')} {c.get('last_name', '')} ({cnic})"),
            **_mark("j_intake", next_node="j_case"),
        }

    # No match — register from provided fields if we have the essentials.
    required = ("first_name", "last_name", "cnic", "date_of_birth", "gender", "occupation", "declared_income")
    if all(args.get(k) for k in required):
        res = await execute_tool("add_customer", {k: args[k] for k in required}, ctx)
        if not res.get("success"):
            return _fail(state, "j_intake", res.get("error") or "Could not register the applicant.")
        return {
            "journey_stage": "case_creation",
            "journey_cnic": args["cnic"],
            "journey_customer_id": res.get("customer_id"),
            "journey_audit": _log(state, f"Applicant registered: {args['first_name']} {args['last_name']} ({args['cnic']})"),
            **_mark("j_intake", next_node="j_case"),
        }

    hint = args.get("applicant_name") or args.get("cnic") or "the applicant"
    return _fail(
        state, "j_intake",
        f'No customer found for "{hint}" and not enough details to register one '
        "(need name, CNIC, date of birth, gender, occupation, income).",
    )


async def j_case(state: ChatState) -> dict:
    """Stage 2 — open the underwriting case (reuses one if already open)."""
    ctx = _ctx(state)
    cnic = state.get("journey_cnic")

    # Idempotency: an open case for this applicant is reused, not duplicated.
    existing = await execute_tool("list_cases", {"limit": 100}, ctx)
    for c in existing.get("cases") or []:
        if c.get("customer_cnic") == cnic and c.get("caseStatus") not in ("Closed", "Rejected"):
            return {
                "journey_stage": "proposal_structuring",
                "journey_case_id": c.get("caseld") or c.get("id"),
                "journey_case_number": c.get("caseNumber"),
                "journey_audit": _log(state, f"Reusing open case {c.get('caseNumber')}"),
                **_mark("j_case", next_node="j_proposal"),
            }

    res = await execute_tool("create_case", {"cnic": cnic}, ctx)
    if not res.get("success"):
        return _fail(state, "j_case", res.get("error") or "Could not open a case.")
    case_number = (res.get("message") or "").split("**")
    number = case_number[1] if len(case_number) > 1 else res.get("case_id", "")
    return {
        "journey_stage": "proposal_structuring",
        "journey_case_id": res.get("case_id"),
        "journey_case_number": number,
        "journey_audit": _log(state, f"Case opened: {number} [New]"),
        **_mark("j_case", next_node="j_proposal"),
    }


async def j_proposal(state: ChatState) -> dict:
    """Stage 3 — structure the proposal from requested or default product terms."""
    ctx = _ctx(state)
    args = (state.get("pending_call") or {}).get("args", {})
    cnic = state.get("journey_cnic")

    # If the case already carries a policy, keep it — progression, not churn.
    detail = await execute_tool("get_case_details", {"cnic": cnic}, ctx)
    policy = ((detail.get("case") or {}).get("policy")) if detail.get("success") else None
    if policy:
        product = {"product_name": policy.get("product_name"), "coverage_amount": policy.get("coverage_amount"),
                   "term_years": policy.get("term_years")}
        return {
            "journey_stage": "document_audit",
            "journey_product": product,
            "journey_audit": _log(state, f"Existing proposal kept: {policy.get('product_name')}"),
            **_mark("j_proposal", next_node="j_audit"),
        }

    proposal_args = {
        "cnic": cnic,
        "product_name": args.get("product_name"),
        "insurance_type": args.get("insurance_type"),
        "coverage_amount": args.get("coverage_amount"),
        "term_years": args.get("term_years"),
    }
    res = await execute_tool("create_proposal", proposal_args, ctx)
    if not res.get("success"):
        return _fail(state, "j_proposal", res.get("error") or "Could not create the proposal.")
    product = {
        "product_name": args.get("product_name") or "Term Life Plus",
        "coverage_amount": args.get("coverage_amount") or 5_000_000,
        "term_years": args.get("term_years") or 10,
    }
    return {
        "journey_stage": "document_audit",
        "journey_product": product,
        "journey_audit": _log(
            state,
            f"Proposal structured: {product['product_name']}, PKR {product['coverage_amount']:,.0f} × {product['term_years']}y",
        ),
        **_mark("j_proposal", next_node="j_audit"),
    }


async def j_audit(state: ChatState) -> dict:
    """Stage 4 — gap analysis on required documents. Missing docs suspend the
    pipeline (spec: Pending Documents wait state)."""
    ctx = _ctx(state)
    res = await execute_tool("get_document_checklist", {"cnic": state.get("journey_cnic")}, ctx)
    if not res.get("success"):
        return _fail(state, "j_audit", res.get("error") or "Could not audit documents.")

    missing = (res.get("checklist") or {}).get("missing") or []
    if missing:
        await execute_tool(
            "update_case_status",
            {"cnic": state.get("journey_cnic"), "new_status": "Pending Documents"},
            ctx,
        )
        return {
            "journey_stage": "document_audit",
            "journey_missing_documents": missing,
            "journey_outcome": "Pending Documents",
            "journey_audit": _log(state, f"Document audit: missing {', '.join(missing)} — pipeline suspended"),
            **_mark("j_audit", next_node=None, status="error"),
        }

    return {
        "journey_stage": "risk_assessment",
        "journey_missing_documents": [],
        "journey_audit": _log(state, "Document audit passed — all required files present"),
        **_mark("j_audit", next_node="j_risk"),
    }


async def j_risk(state: ChatState) -> dict:
    """Stage 5 — tri-fold AI evaluation via the risk engine."""
    ctx = _ctx(state)
    await execute_tool("update_case_status", {"cnic": state.get("journey_cnic"), "new_status": "InProgress"}, ctx)

    res = await execute_tool("run_risk_assessment", {"cnic": state.get("journey_cnic")}, ctx)
    if not res.get("success"):
        return _fail(state, "j_risk", res.get("error") or res.get("message") or "Risk assessment failed.")

    assessment = res.get("assessment") or {}
    scores = assessment.get("scores") or assessment
    risk = {
        "medical_score": scores.get("medical_score"),
        "financial_score": scores.get("financial_score"),
        "fraud_probability": scores.get("fraud_probability"),
        "composite_score": scores.get("composite_risk_score") or assessment.get("composite_risk_score"),
        "recommendation": assessment.get("ai_decision") or "Human Review",
    }
    return {
        "journey_stage": "underwriting_decision",
        "journey_risk": risk,
        "journey_audit": _log(
            state,
            f"Risk assessment: med={risk['medical_score']} fin={risk['financial_score']} "
            f"fraud={risk['fraud_probability']} → {risk['recommendation']}",
        ),
        **_mark("j_risk", next_node="j_decide"),
    }


async def j_decide(state: ChatState) -> dict:
    """Stage 6 — deterministic routing on the engine's recommendation.
    Auto Approve / Decline proceed to closure; anything else suspends for a
    human underwriter (spec's HITL checkpoint)."""
    ctx = _ctx(state)
    rec = ((state.get("journey_risk") or {}).get("recommendation") or "Human Review").strip()

    if rec == "Auto Approve":
        await execute_tool("update_case_status", {"cnic": state.get("journey_cnic"), "new_status": "Approved"}, ctx)
        return {
            "journey_stage": "case_closure",
            "journey_outcome": "Approved",
            "journey_audit": _log(state, "Auto-approved by AI underwriter — policy bound"),
            **_mark("j_decide", next_node="j_close"),
        }

    if rec == "Decline":
        await execute_tool("update_case_status", {"cnic": state.get("journey_cnic"), "new_status": "Rejected"}, ctx)
        return {
            "journey_stage": "case_closure",
            "journey_outcome": "Rejected",
            "journey_audit": _log(state, "Declined on composite risk threshold"),
            **_mark("j_decide", next_node="j_close"),
        }

    await execute_tool("update_case_status", {"cnic": state.get("journey_cnic"), "new_status": "Under Review"}, ctx)
    return {
        "journey_stage": "underwriting_decision",
        "journey_outcome": "Under Review",
        "requires_human_intervention": True,
        "journey_audit": _log(state, "Routed to human underwriter — pipeline suspended"),
        **_mark("j_decide", next_node=None, status="error"),
    }


async def j_close(state: ChatState) -> dict:
    """Stage 7 — close the case and write the audit trail as a case comment."""
    ctx = _ctx(state)
    cnic = state.get("journey_cnic")
    audit = _log(state, f"Case closed — underwriting lifecycle finalised ({state.get('journey_outcome')})")

    await execute_tool("update_case_status", {"cnic": cnic, "new_status": "Closed"}, ctx)
    await execute_tool(
        "add_case_comment",
        {"cnic": cnic, "comment_text": "UNDERWRITING AUDIT TRAIL\n" + "\n".join(audit), "comment_type": "Internal"},
        ctx,
    )
    return {
        "journey_stage": "completed",
        "journey_audit": audit,
        **_mark("j_close", next_node=None),
    }


async def j_resume(state: ChatState) -> dict:
    """Router for continue_underwriting_journey — no work, just an audit line;
    the conditional edge below picks the re-entry stage from state."""
    return {"journey_audit": _log(state, "Journey resumed"), "journey_error": None}


# ═══════════════════════════════════════════════════════════════════════════
# Routing + final summary
# ═══════════════════════════════════════════════════════════════════════════

def route_after_audit(state: ChatState) -> str:
    if state.get("journey_error"):
        return "j_finish"
    return "j_finish" if state.get("journey_missing_documents") else "j_risk"


def route_after_decide(state: ChatState) -> str:
    if state.get("journey_error") or state.get("requires_human_intervention"):
        return "j_finish"
    return "j_close"


def route_error(next_node: str):
    def _route(state: ChatState) -> str:
        return "j_finish" if state.get("journey_error") else next_node
    return _route


def route_resume(state: ChatState) -> str:
    """Re-enter where the pipeline stopped, per persisted state."""
    outcome = state.get("journey_outcome")
    if outcome in ("Approved", "Rejected"):
        return "j_close"  # human decided via UI/chat — finish the lifecycle
    if state.get("journey_missing_documents"):
        return "j_audit"  # re-audit; passes once uploads landed
    if state.get("requires_human_intervention"):
        return "j_decide"  # re-read the case; status may have changed
    if not state.get("journey_case_id"):
        return "j_intake"
    return "j_audit"


async def j_finish(state: ChatState) -> dict:
    """Answer the launching tool_call with one consolidated ToolMessage —
    outcome, audit trail, navigation and the exact next-step chips."""
    call = state.get("pending_call") or {}
    outcome = state.get("journey_outcome")
    error = state.get("journey_error")
    case_no = state.get("journey_case_number") or ""
    cnic = state.get("journey_cnic") or ""
    case_id = state.get("journey_case_id")
    # Documents suspension lands on the case's documents view (uploads live
    # there); every scored outcome lands on the detail page with the results.
    docs_route = build_route("cases", case_id) if case_id else "underwriting"
    results_route = f"case/{case_id}" if case_id else "underwriting"
    route = docs_route if outcome == "Pending Documents" else results_route

    result: dict[str, Any] = {"audit_trail": state.get("journey_audit", []), "case_number": case_no, "outcome": outcome}

    if error:
        result.update({"success": False, "error": error})
    elif outcome == "Pending Documents":
        missing = state.get("journey_missing_documents", [])
        result.update({
            "success": True,
            "message": f"Journey suspended at document audit — {case_no} needs: {', '.join(missing)}.",
            "quick_actions": [
                *({"label": f"Upload {d}", "actionType": "upload",
                   "payload": json.dumps({"document_type": d, "cnic": cnic})} for d in missing[:2]),
                {"label": "Resume journey", "actionType": "submit", "payload": "Continue the underwriting journey"},
            ],
        })
    elif outcome == "Under Review":
        r = state.get("journey_risk") or {}
        result.update({
            "success": True,
            "message": (
                f"Journey suspended for human review — {case_no} "
                f"(composite {r.get('composite_score')}, fraud {r.get('fraud_probability')})."
            ),
            "quick_actions": [
                {"label": "Approve case", "actionType": "submit", "payload": f"Approve case {case_no} and continue the journey"},
                {"label": "Reject case", "actionType": "submit", "payload": f"Reject case {case_no} and continue the journey"},
                {"label": "View Case", "actionType": "navigate", "payload": route},
            ],
        })
    else:
        result.update({
            "success": True,
            "message": f"Underwriting journey complete — {case_no} finished as **{outcome or 'Closed'}**.",
            "quick_actions": [
                {"label": "View Case", "actionType": "navigate", "payload": route},
                {"label": "Start another journey", "actionType": "submit", "payload": "Run the underwriting journey with demo data"},
            ],
        })

    if state.get("journey_case_id"):
        result["last_action"] = {
            "tool_name": "underwriting_journey", "entity_type": "case",
            "entity_id": state["journey_case_id"], "route": route,
            "label": f"Journey: {outcome or ('error' if error else 'done')} ({case_no})",
        }
        result["navigate"] = {"route": route, "entity_id": state["journey_case_id"], "highlight": True}

    return {
        "messages": [ToolMessage(content=json.dumps(result), tool_call_id=call.get("id", ""), name=call.get("name", "start_underwriting_journey"))],
        "pending_call": None,
    }


def register_journey(builder) -> None:
    """Attach all journey nodes and edges to the main StateGraph builder."""
    for node_name, fn in [
        ("j_intake", j_intake), ("j_case", j_case), ("j_proposal", j_proposal),
        ("j_audit", j_audit), ("j_risk", j_risk), ("j_decide", j_decide),
        ("j_close", j_close), ("j_resume", j_resume), ("j_finish", j_finish),
    ]:
        builder.add_node(node_name, fn)

    builder.add_conditional_edges("j_intake", route_error("j_case"), {"j_case": "j_case", "j_finish": "j_finish"})
    builder.add_conditional_edges("j_case", route_error("j_proposal"), {"j_proposal": "j_proposal", "j_finish": "j_finish"})
    builder.add_conditional_edges("j_proposal", route_error("j_audit"), {"j_audit": "j_audit", "j_finish": "j_finish"})
    builder.add_conditional_edges("j_audit", route_after_audit, {"j_risk": "j_risk", "j_finish": "j_finish"})
    builder.add_conditional_edges("j_risk", route_error("j_decide"), {"j_decide": "j_decide", "j_finish": "j_finish"})
    builder.add_conditional_edges("j_decide", route_after_decide, {"j_close": "j_close", "j_finish": "j_finish"})
    builder.add_edge("j_close", "j_finish")
    builder.add_conditional_edges(
        "j_resume", route_resume,
        {"j_intake": "j_intake", "j_audit": "j_audit", "j_decide": "j_decide", "j_close": "j_close"},
    )
    builder.add_edge("j_finish", "agent")
