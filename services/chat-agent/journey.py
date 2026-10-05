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

import httpx
from langchain_core.messages import ToolMessage

from pages import build_route
from state import ChatState
from tool_executor import API_GATEWAY_URL, ExecCtx, execute_tool, upload_documents_action

# Stage metadata: node -> (stage id, UI label). Order matters for the
# "what comes next" markers.
STAGES: dict[str, tuple[str, str]] = {
    "j_intake":             ("lead_intake",                 "Stage 1 · Lead Intake"),
    "j_case":               ("case_creation",               "Stage 2 · Case Creation"),
    "j_proposal":           ("proposal_structuring",        "Stage 3 · Proposal Structuring"),
    "j_pre_underwriting":   ("pre_underwriting_clearance",  "Stage 4 · Pre-Underwriting Clearance (6 Gates)"),
    "j_audit":              ("document_audit",              "Stage 5 · Document Audit"),
    "j_risk":               ("risk_assessment",             "Stage 6 · AI Risk Assessment"),
    "j_decide":             ("underwriting_decision",       "Stage 7 · Underwriting Decision"),
    "j_close":              ("case_closure",                "Stage 8 · Case Closure"),
}


def _ctx(state: ChatState) -> ExecCtx:
    return ExecCtx(
        tenant_id=state.get("tenant_id", ""),
        jwt_token=state.get("jwt_token", ""),
        role=state.get("user_role") or "Agent",
    )


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
        # Stamped explicitly rather than left to carry over from whichever
        # stage happened to run last — j_finish reads this to decide which
        # recovery chips (if any) make sense for the stage that actually failed.
        "journey_stage": STAGES[node][0],
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
        # agent_name/agent_email were being silently dropped here (only the
        # `required` fields were forwarded) — for anyone but the Agent role,
        # add_customer needs one explicitly or it stalls on its own
        # agent-picker prompt even though the caller already supplied one.
        add_args = {k: args[k] for k in required}
        if args.get("agent_name"):
            add_args["agent_name"] = args["agent_name"]
        if args.get("agent_email"):
            add_args["agent_email"] = args["agent_email"]
        if args.get("acquisition_source_id"):
            add_args["acquisition_source_id"] = args["acquisition_source_id"]
        for key in ("agent_id", "no_agent"):
            if args.get(key):
                add_args[key] = args[key]
        res = await execute_tool("add_customer", add_args, ctx)
        if not res.get("success"):
            return _fail(state, "j_intake", res.get("error") or res.get("message") or "Could not register the applicant.")
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
        return _fail(state, "j_case", res.get("error") or res.get("message") or "Could not open a case.")
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
            "journey_stage": "pre_underwriting_clearance",
            "journey_product": product,
            "journey_audit": _log(state, f"Existing proposal kept: {policy.get('product_name')}"),
            **_mark("j_proposal", next_node="j_pre_underwriting"),
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
        return _fail(state, "j_proposal", res.get("error") or res.get("message") or "Could not create the proposal.")
    product = {
        "product_name": args.get("product_name") or "Term Life Plus",
        "coverage_amount": args.get("coverage_amount") or 5_000_000,
        "term_years": args.get("term_years") or 10,
    }
    return {
        "journey_stage": "pre_underwriting_clearance",
        "journey_product": product,
        "journey_audit": _log(
            state,
            f"Proposal structured: {product['product_name']}, PKR {product['coverage_amount']:,.0f} × {product['term_years']}y",
        ),
        **_mark("j_proposal", next_node="j_pre_underwriting"),
    }


async def j_pre_underwriting(state: ChatState) -> dict:
    """Stage 4 — 6-gate Pre-Underwriting clearance (E-App, ACR, Compliance, IPP, History, Medical)."""
    ctx = _ctx(state)
    case_no = state.get("journey_case_number")
    cnic = state.get("journey_cnic")
    lookup = {"case_number": case_no} if case_no else {"cnic": cnic}

    res = await execute_tool("run_pre_underwriting_clearance", lookup, ctx)
    if not res.get("success"):
        return _fail(state, "j_pre_underwriting", res.get("error") or res.get("message") or "Could not complete pre-underwriting clearance.")

    return {
        "journey_stage": "document_audit",
        "journey_pre_underwriting": res.get("pre_underwriting_status") or {},
        "journey_audit": _log(state, f"Pre-Underwriting clearance passed — all 6 gates verified for {case_no or cnic}"),
        **_mark("j_pre_underwriting", next_node="j_audit"),
    }


async def j_audit(state: ChatState) -> dict:
    """Stage 5 — gap analysis on required documents. Missing docs suspend the
    pipeline (spec: Pending Documents wait state)."""
    ctx = _ctx(state)
    res = await execute_tool("get_document_checklist", {"cnic": state.get("journey_cnic")}, ctx)
    checklist = res.get("checklist")
    # get_document_checklist returns success:False as a BUSINESS outcome
    # ("checklist fetched fine, some documents are still missing"), not a
    # tool failure — that's what the `missing` branch below handles. Only
    # the genuine absence of a checklist (case lookup failed, HTTP error,
    # ...) is an actual audit failure.
    if checklist is None:
        return _fail(state, "j_audit", res.get("error") or res.get("message") or "Could not audit documents.")

    missing = checklist.get("missing") or []
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


async def _run_evaluation_directly(customer: dict, policy: dict, ctx: ExecCtx) -> dict:
    """Runs + persists a risk assessment server-side, for callers (like this
    journey) that have no browser to stream progress to.

    run_risk_assessment's own tool handler is interactive-only: once every
    precondition passes it returns a `__client_execute__` marker so the chat
    UI can run api-gateway's SSE /evaluate/stream and show live steps. A
    server-side journey has no client to hand that off to, so this calls the
    same persisting endpoint directly and just waits for the final event —
    same result, no progress UI. Mirrors CopilotInterface.tsx's SSE consumer.
    """
    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST", f"{API_GATEWAY_URL}/evaluate/stream",
            json={"customer": customer, "policy": policy},
            headers=ctx.headers,
        ) as resp:
            resp.raise_for_status()
            buffer = ""
            async for chunk in resp.aiter_text():
                buffer += chunk
                while "\n\n" in buffer:
                    line, buffer = buffer.split("\n\n", 1)
                    line = line.strip()
                    if not line.startswith("data: "):
                        continue
                    evt = json.loads(line[6:])
                    if evt.get("type") == "saved":
                        return {"success": True, "assessment": evt["data"]}
                    if evt.get("type") in ("error", "invalid"):
                        data = evt.get("data") or {}
                        msg = evt.get("message") or "; ".join(data.get("errors") or []) or "Risk evaluation failed."
                        return {"success": False, "message": msg}
    return {"success": False, "message": "Risk evaluation stream ended without a result."}


async def j_risk(state: ChatState) -> dict:
    """Stage 5 — tri-fold AI evaluation via the risk engine."""
    ctx = _ctx(state)
    await execute_tool("update_case_status", {"cnic": state.get("journey_cnic"), "new_status": "InProgress"}, ctx)

    res = await execute_tool("run_risk_assessment", {"cnic": state.get("journey_cnic")}, ctx)
    if res.get("__client_execute__"):
        # Every precondition (gates, documents, an existing policy) already
        # passed for the marker to be returned — nothing left to check, just
        # run it ourselves since there's no browser to hand it to.
        args = res["tool_call"]["args"]
        res = await _run_evaluation_directly(args["customer"], args["policy"], ctx)
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
        "reasons": scores.get("reasons") or assessment.get("reasons") or [],
        "medical_reasons": scores.get("medical_reasons") or assessment.get("medical_reasons") or [],
        "financial_reasons": scores.get("financial_reasons") or assessment.get("financial_reasons") or [],
        "fraud_reasons": scores.get("fraud_reasons") or assessment.get("fraud_reasons") or [],
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
    """Stage 6 — a human always confirms the final call. The AI recommendation
    (Auto Approve / Decline / Human Review) is presented as context, not acted
    on automatically — j_finish's "Under Review" branch is what actually shows
    the Approve/Reject buttons, for every recommendation alike. Case status
    moves to Under Review here so it's visibly awaiting a decision instead of
    silently parked in Progress while the journey pauses."""
    ctx = _ctx(state)
    await execute_tool("update_case_status", {"cnic": state.get("journey_cnic"), "new_status": "Under Review"}, ctx)
    return {
        "journey_stage": "underwriting_decision",
        "journey_outcome": "Under Review",
        "requires_human_intervention": True,
        "journey_audit": _log(state, "Risk assessment complete — awaiting proceed/decline"),
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
    """Router for continue_underwriting_journey.

    A "Proceed"/"Decline" click updates the case's real status through the
    plain approve_case/update_case_status tools, not through journey state —
    journey_outcome is never actually written to "Approved"/"Rejected"
    anywhere else. Without re-reading the real case here, route_resume's
    check for that would always miss and loop back into j_decide, re-asking
    the same question forever. Re-read the live status so a decision made
    since the last pause is recognised.
    """
    update: dict[str, Any] = {"journey_audit": _log(state, "Journey resumed"), "journey_error": None}
    if state.get("requires_human_intervention") and state.get("journey_case_id"):
        ctx = _ctx(state)
        try:
            res = await execute_tool("get_case_details", {"case_number": state.get("journey_case_number")}, ctx)
            # get_case_details wraps the whole /detail bundle under "case",
            # and that bundle's own "case" key holds the actual case record.
            bundle = res.get("case") or {}
            status = str((bundle.get("case") or {}).get("caseStatus") or "")
        except Exception:
            status = ""
        if status in ("Approved", "Rejected"):
            update["journey_outcome"] = status
            update["requires_human_intervention"] = False
    return update


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
    if not state.get("journey_pre_underwriting"):
        return "j_pre_underwriting"
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
    # Every outcome — including a documents suspension — lands on the case
    # detail page: that's where both the upload checklist and the gate/result
    # views actually live (app/case/[id]/page.tsx). A prior version pointed
    # documents suspension at the bare cases list instead, which doesn't have
    # an upload UI at all.
    results_route = f"case/{case_id}" if case_id else "underwriting"
    route = results_route

    result: dict[str, Any] = {"audit_trail": state.get("journey_audit", []), "case_number": case_no, "outcome": outcome}

    if error:
        result.update({"success": False, "error": error})
        if state.get("journey_stage") == "document_audit":
            # get_document_checklist itself failed here (as opposed to the
            # Pending Documents branch below, where it succeeded and named
            # exact missing docs) — offer the same recovery path as a click
            # instead of narrating "would you like to see the checklist?" in
            # prose and waiting for the user to type yes.
            result["quick_actions"] = [
                {"label": "View document checklist", "actionType": "submit",
                 "payload": f"Show me the document checklist for {case_no or cnic}"},
            ]
        elif state.get("journey_stage") == "pre_underwriting_clearance":
            # run_pre_underwriting_clearance is all-or-nothing (no mid-gate
            # pause), so a flagged/blocked gate surfaces here as a plain
            # error. Same "embed" case view as the Pending Documents branch
            # below — this IS one of the 6 pre-underwriting gate stages, so
            # the user should be able to clear the remaining gates from the
            # in-chat case panel instead of retyping which gate to run next.
            result["quick_actions"] = [
                {"label": "Open Case", "actionType": "embed", "payload": route},
                {"label": "Check gate status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case_no or cnic}"},
            ]
    elif outcome == "Pending Documents":
        missing = state.get("journey_missing_documents", [])
        result.update({
            "success": True,
            "message": f"Journey suspended at document audit — {case_no} needs: {', '.join(missing)}.",
            "quick_actions": [
                upload_documents_action(state.get("journey_case_id") or "", case_no, cnic, missing),
                # "embed" (not "navigate") — this is the pre-underwriting
                # gate stage, the one case the in-chat case view is for.
                {"label": "Open Case", "actionType": "embed", "payload": route},
                {"label": "Resume journey", "actionType": "submit", "payload": "Continue the underwriting journey"},
            ],
        })
    elif outcome == "Under Review":
        r = state.get("journey_risk") or {}
        rec = r.get("recommendation", "Human Review")
        result.update({
            "success": True,
            "message": (
                f"I've completed the underwriting risk assessment for {case_no} — "
                f"AI recommendation: **{rec}**.\n\n"
                "Would you like to **proceed** with these results, or **decline**?"
            ),
            "quick_actions": [
                {"label": "Proceed", "actionType": "submit", "payload": f"Approve case {case_no} and continue the journey"},
                {"label": "Decline", "actionType": "submit", "payload": f"Reject case {case_no} and continue the journey"},
                {"label": "Download Report", "actionType": "download", "payload": case_id},
                {"label": "View Case", "actionType": "embed", "payload": route},
            ],
        })
        if r:
            result["assessment"] = {
                "scores": r, "ai_decision": r.get("recommendation", "Unknown"), "case_id": case_id,
                "reasons": r.get("reasons", []),
                "medical_reasons": r.get("medical_reasons", []),
                "financial_reasons": r.get("financial_reasons", []),
                "fraud_reasons": r.get("fraud_reasons", []),
            }
    else:
        r = state.get("journey_risk") or {}
        result.update({
            "success": True,
            "message": f"Underwriting journey complete — {case_no} finished as **{outcome or 'Closed'}**.",
            "quick_actions": [
                {"label": "View Case", "actionType": "embed", "payload": route},
                {"label": "Start another journey", "actionType": "submit", "payload": "Run the underwriting journey with demo data"},
            ],
        })
        if r:
            result["assessment"] = {
                "scores": r, "ai_decision": r.get("recommendation", "Unknown"), "case_id": case_id,
                "reasons": r.get("reasons", []),
                "medical_reasons": r.get("medical_reasons", []),
                "financial_reasons": r.get("financial_reasons", []),
                "fraud_reasons": r.get("fraud_reasons", []),
            }

    if state.get("journey_case_id"):
        result["last_action"] = {
            "tool_name": "underwriting_journey", "entity_type": "case",
            "entity_id": state["journey_case_id"], "route": route,
            "label": f"Journey: {outcome or ('error' if error else 'done')} ({case_no})",
        }
        if outcome == "Pending Documents" or (error and state.get("journey_stage") == "pre_underwriting_clearance"):
            # Auto-open the in-chat case view the instant the journey pauses
            # here — this is the one stage the embed exists for (tracking the
            # 6 pre-underwriting gates), so it shouldn't need an extra click.
            # Covers both a missing-documents pause AND a blocked/flagged
            # gate (e.g. Compliance came back Flagged, locking IPP/History/
            # Medical behind it) — either way the fix happens in this same
            # case view, so open it automatically rather than making the
            # user click "Open Case" first.
            #
            # No `navigate` at all for every later outcome (Under Review,
            # Approved, Closed, ...): auto-navigating unconditionally used to
            # pop a new tab the instant that message arrived, with no click
            # involved — once past pre-underwriting, nothing should open on
            # its own. A "View Case"/"Open Case" quick_action (embed) is
            # still offered per-outcome above for anyone who explicitly
            # wants to look.
            result["navigate"] = {"route": route, "entity_id": state["journey_case_id"], "highlight": True, "embed": True}

    return {
        "messages": [ToolMessage(content=json.dumps(result), tool_call_id=call.get("id", ""), name=call.get("name", "start_underwriting_journey"))],
        "pending_call": None,
    }


def register_journey(builder) -> None:
    """Attach all journey nodes and edges to the main StateGraph builder."""
    for node_name, fn in [
        ("j_intake", j_intake), ("j_case", j_case), ("j_proposal", j_proposal),
        ("j_pre_underwriting", j_pre_underwriting),
        ("j_audit", j_audit), ("j_risk", j_risk), ("j_decide", j_decide),
        ("j_close", j_close), ("j_resume", j_resume), ("j_finish", j_finish),
    ]:
        builder.add_node(node_name, fn)

    builder.add_conditional_edges("j_intake", route_error("j_case"), {"j_case": "j_case", "j_finish": "j_finish"})
    builder.add_conditional_edges("j_case", route_error("j_proposal"), {"j_proposal": "j_proposal", "j_finish": "j_finish"})
    builder.add_conditional_edges("j_proposal", route_error("j_pre_underwriting"), {"j_pre_underwriting": "j_pre_underwriting", "j_finish": "j_finish"})
    builder.add_conditional_edges("j_pre_underwriting", route_error("j_audit"), {"j_audit": "j_audit", "j_finish": "j_finish"})
    builder.add_conditional_edges("j_audit", route_after_audit, {"j_risk": "j_risk", "j_finish": "j_finish"})
    builder.add_conditional_edges("j_risk", route_error("j_decide"), {"j_decide": "j_decide", "j_finish": "j_finish"})
    builder.add_conditional_edges("j_decide", route_after_decide, {"j_close": "j_close", "j_finish": "j_finish"})
    builder.add_edge("j_close", "j_finish")
    builder.add_conditional_edges(
        "j_resume", route_resume,
        {"j_intake": "j_intake", "j_pre_underwriting": "j_pre_underwriting", "j_audit": "j_audit", "j_decide": "j_decide", "j_close": "j_close"},
    )
    builder.add_edge("j_finish", "agent")
