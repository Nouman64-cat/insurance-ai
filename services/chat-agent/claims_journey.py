"""The autonomous claims journey — the 7-stage agentic settlement pipeline.

The claims mirror of `journey.py`. Once the user confirms `start_claim_journey`,
the graph drives FNOL → Triage → Document Audit → Fraud & Contestability Review
→ Adjudication → Disbursement → Closure deterministically, with no further
hand-holding.

It suspends in exactly the places the claims regulations force a human in:

  - No documents on file        → outcome "Pending Documents", upload chips
  - Contestability / duplicate  → outcome "Underwriting Referral", verdict chips
  - Over PKR 500k or referred   → outcome "Manager Review", approve/decline chips

`continue_claim_journey` re-enters through `c_resume`, which routes to the right
stage from persisted state — so an upload, a manager decision or an underwriting
verdict picks the pipeline up exactly where it stopped.

Every node reuses the REST handlers in tool_executor (the same code the
individual claims tools run), appends to the immutable `claim_audit` trail, and
reports itself to the UI through the same `journey_done` / `journey_next`
markers routers/chat.py already turns into animated state-graph steps.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

from langchain_core.messages import ToolMessage

from state import ChatState
from tool_executor import (
    CLAIM_MANAGER_THRESHOLD,
    CLAIM_RETENTION_LIMIT,
    ExecCtx,
    execute_tool,
)

# Stage metadata: node -> (stage id, UI label). Order matters for the
# "what comes next" markers.
STAGES: dict[str, tuple[str, str]] = {
    "c_intake":      ("claim_fnol",           "Stage 1 · First Notice of Loss"),
    "c_triage":      ("claim_triage",         "Stage 2 · Triage & SLA Assignment"),
    "c_documents":   ("claim_document_audit", "Stage 3 · Claim Document Audit"),
    "c_review":      ("claim_risk_review",    "Stage 4 · Fraud & Contestability Review"),
    "c_adjudicate":  ("claim_adjudication",   "Stage 5 · Adjudication"),
    "c_payout":      ("claim_disbursement",   "Stage 6 · Disbursement"),
    "c_close":       ("claim_closure",        "Stage 7 · Claim Closure"),
}


def _ctx(state: ChatState) -> ExecCtx:
    return ExecCtx(
        tenant_id=state.get("tenant_id", ""),
        jwt_token=state.get("jwt_token", ""),
        role=state.get("user_role") or "Agent",
    )


def _log(state: ChatState, entry: str) -> list[str]:
    stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
    return [*state.get("claim_audit", []), f"[{stamp}] {entry}"]


def _mark(node: str, *, next_node: str | None, status: str = "done") -> dict[str, Any]:
    """UI process-graph markers consumed by routers/chat.py."""
    sid, label = STAGES[node]
    out: dict[str, Any] = {"journey_done": {"id": f"stage:{sid}", "label": label, "status": status}}
    if next_node and next_node in STAGES:
        nid, nlabel = STAGES[next_node]
        out["journey_next"] = {"id": f"stage:{nid}", "label": nlabel}
    return out


def _fail(state: ChatState, node: str, error: str) -> dict[str, Any]:
    return {
        "claim_error": error,
        "claim_audit": _log(state, f"ERROR at {STAGES[node][1]}: {error}"),
        **_mark(node, next_node=None, status="error"),
    }


def _lookup(state: ChatState) -> dict[str, Any]:
    """How every downstream node addresses the claim it is working."""
    return {"claim_number": state.get("claim_number")}


async def _refresh(state: ChatState) -> dict[str, Any]:
    """Re-read the claim so a node decides on current truth, not stale state —
    the user may have uploaded a document or moved the claim in the portal
    between suspensions."""
    res = await execute_tool("get_claim_details", _lookup(state), _ctx(state))
    return res.get("claim") or {}


# ═══════════════════════════════════════════════════════════════════════════
# Stage nodes
# ═══════════════════════════════════════════════════════════════════════════

async def c_intake(state: ChatState) -> dict:
    """Stage 1 — resolve the existing claim, or register the FNOL."""
    args = (state.get("pending_call") or {}).get("args", {})
    ctx = _ctx(state)

    # Existing claim first — "process claim CLM-2026-0001" must never open a
    # second claim on the same loss.
    if args.get("claim_number") or args.get("claimant_name"):
        found = await execute_tool(
            "get_claim_details",
            {"claim_number": args.get("claim_number"), "claimant_name": args.get("claimant_name")},
            ctx,
        )
        if found.get("success"):
            claim = found.get("claim") or {}
            return {
                "claim_stage": "claim_triage",
                "claim_outcome": None,
                "requires_claim_intervention": False,
                "claim_id": str(claim.get("id") or ""),
                "claim_number": claim.get("claim_number"),
                "claim_record": claim,
                "claim_audit": _log(
                    state,
                    f"Claim resolved: {claim.get('claim_number')} — {claim.get('claimant_name')} "
                    f"({claim.get('claim_type')}, PKR {float(claim.get('submitted_amount') or 0):,.0f}) "
                    f"currently {claim.get('status')}",
                ),
                **_mark("c_intake", next_node="c_triage"),
            }
        # Only a genuine "no such claim" falls through to registration; a service
        # failure must not silently become "register a new one".
        if args.get("claim_number") and "no claim found" not in (found.get("error") or "").lower():
            return _fail(state, "c_intake", found.get("error") or "Could not reach the claims register.")

    if (state.get("pending_call") or {}).get("name") == "continue_claim_journey":
        # Reached from a resume that could not find the claim it named. Opening
        # a new FNOL here would register a second claim on the same loss.
        return {
            "claim_error": (
                "There is no suspended claims journey on this conversation"
                + (f", and I could not find claim {args.get('claim_number')}." if args.get("claim_number") else ".")
            ),
            "claim_blocking_actions": [
                {"label": "Show open claims", "actionType": "submit", "payload": "List claims that are Under Investigation"},
                {"label": "Register a claim (FNOL)", "actionType": "submit", "payload": "Register a new claim"},
                {"label": "Open Claims", "actionType": "navigate", "payload": "claims"},
            ],
            "claim_audit": _log(state, "Resume found no journey and no matching claim"),
            **_mark("c_intake", next_node=None, status="error"),
        }

    res = await execute_tool(
        "register_claim",
        {
            "policy_number": args.get("policy_number"),
            "claimant_name": args.get("claimant_name"),
            "cnic": args.get("cnic"),
            "claim_type": args.get("claim_type"),
            "submitted_amount": args.get("submitted_amount"),
            "incident_date": args.get("incident_date"),
        },
        ctx,
    )
    if not res.get("success"):
        # register_claim answers a missing claim type / amount with its own
        # chips — carry them out so the suspension is still one click to fix.
        return {
            "claim_error": res.get("error") or "Could not register the claim.",
            "claim_blocking_actions": res.get("quick_actions") or [],
            "claim_audit": _log(state, f"FNOL blocked: {res.get('error')}"),
            **_mark("c_intake", next_node=None, status="error"),
        }

    claim = res.get("claim") or {}
    return {
        "claim_stage": "claim_triage",
        "claim_outcome": None,
        "requires_claim_intervention": False,
        "claim_id": str(claim.get("id") or ""),
        "claim_number": claim.get("claim_number"),
        "claim_record": claim,
        "claim_audit": _log(
            state,
            f"FNOL registered: {claim.get('claim_number')} — {claim.get('claim_type')} for "
            f"PKR {float(claim.get('submitted_amount') or 0):,.0f} (AI: {claim.get('ai_recommendation')})",
        ),
        **_mark("c_intake", next_node="c_triage"),
    }


async def c_triage(state: ChatState) -> dict:
    """Stage 2 — move a fresh claim into Triaged so the SLA clock is honest."""
    ctx = _ctx(state)
    claim = state.get("claim_record") or {}
    status = str(claim.get("status") or "New")

    if status == "New":
        res = await execute_tool(
            "update_claim_status",
            {**_lookup(state), "new_status": "Triaged", "notes": "Auto-triaged by the claims pipeline."},
            ctx,
        )
        if not res.get("success"):
            return _fail(state, "c_triage", res.get("error") or "Could not triage the claim.")
        claim = res.get("claim") or claim
        entry = f"Triaged {state.get('claim_number')} — assigned for document audit"
    else:
        entry = f"Already {status} — triage skipped"

    return {
        "claim_stage": "claim_document_audit",
        "claim_record": claim,
        "claim_outcome": None,
        "requires_claim_intervention": False,
        "claim_audit": _log(state, entry),
        **_mark("c_triage", next_node="c_documents"),
    }


async def c_documents(state: ChatState) -> dict:
    """Stage 3 — document audit. No documents on file suspends the pipeline:
    the platform hard-blocks approval, payout and settlement without one."""
    ctx = _ctx(state)
    res = await execute_tool("get_claim_document_checklist", _lookup(state), ctx)
    if not res.get("success"):
        return _fail(state, "c_documents", res.get("error") or "Could not audit the claim documents.")

    claim = res.get("claim") or {}
    missing = res.get("missing") or []
    on_file = len(claim.get("artifacts") or [])

    if on_file == 0:
        # Park it honestly so the workbench shows why it stopped.
        if str(claim.get("status")) in ("New", "Triaged"):
            await execute_tool(
                "update_claim_status",
                {**_lookup(state), "new_status": "Pending Documents",
                 "notes": "Awaiting claim documents — pipeline suspended."},
                ctx,
            )
        return {
            "claim_stage": "claim_document_audit",
            "claim_record": claim,
            "claim_missing_documents": missing,
            "claim_outcome": "Pending Documents",
            "claim_audit": _log(state, f"Document audit: nothing on file — need {', '.join(missing)} — suspended"),
            **_mark("c_documents", next_node=None, status="error"),
        }

    return {
        "claim_stage": "claim_risk_review",
        "claim_record": claim,
        "claim_missing_documents": missing,
        # Forward progress clears the suspension that stopped the last run;
        # leaving it set would route the resumed journey straight back to
        # c_finish with a "Pending Documents" it has just cleared.
        "claim_outcome": None,
        "requires_claim_intervention": False,
        "claim_audit": _log(
            state,
            f"Document audit passed — {on_file} document(s) on file"
            + (f"; still outstanding: {', '.join(missing)}" if missing else "; file complete"),
        ),
        **_mark("c_documents", next_node="c_review"),
    }


async def c_review(state: ChatState) -> dict:
    """Stage 4 — fraud, duplicate and contestability review.

    This is where the pipeline decides whether it may adjudicate at all. A
    contestable policy or a duplicate flag is a legal referral, not a risk
    score the machine may overrule.
    """
    ctx = _ctx(state)
    claim = await _refresh(state) or (state.get("claim_record") or {})
    status = str(claim.get("status") or "")
    amount = float(claim.get("submitted_amount") or 0)
    fraud = float(claim.get("fraud_probability") or 0)

    # An underwriting verdict already resolved the referral — carry on.
    if status == "Re-Underwriting Required":
        return {
            "claim_stage": "claim_risk_review",
            "claim_record": claim,
            "claim_outcome": "Underwriting Referral",
            "requires_claim_intervention": True,
            "claim_audit": _log(state, "Awaiting underwriting verdict on the re-underwriting referral — suspended"),
            **_mark("c_review", next_node=None, status="error"),
        }

    # Contestability and the duplicate flag are static facts about the policy
    # and the claim — they never clear themselves. Once underwriting has ruled
    # on a referral (resolve_claim_underwriting stamps underwriting_decision_notes),
    # re-checking the same static triggers on every resume would refer the claim
    # right back where it just came from, looping forever. A resolution is a
    # verdict on the whole file, not just the specific reason first raised, so
    # its presence retires every static trigger for the rest of this run.
    already_resolved = bool(claim.get("underwriting_decision_notes"))

    triggers: list[str] = []
    if not already_resolved:
        if claim.get("is_contestable"):
            triggers.append("Policy Issued < 2 Years Ago (Contestability Window)")
        if claim.get("duplicate_flag"):
            triggers.append("Undisclosed Pre-Existing Medical History (OCR Flag)")
    if amount > CLAIM_RETENTION_LIMIT:
        triggers.append("Claim Amount Exceeds Net Retention (> PKR 5M)")

    if triggers:
        res = await execute_tool(
            "refer_claim_to_underwriting",
            {**_lookup(state), "referral_reason": "; ".join(triggers),
             "notes": "Raised automatically by the claims pipeline during fraud and contestability review."},
            ctx,
        )
        if not res.get("success"):
            return _fail(state, "c_review", res.get("error") or "Could not raise the underwriting referral.")
        return {
            "claim_stage": "claim_risk_review",
            "claim_record": res.get("claim") or claim,
            "claim_referral_reasons": triggers,
            "claim_outcome": "Underwriting Referral",
            "requires_claim_intervention": True,
            "claim_audit": _log(state, f"Referred to underwriting: {'; '.join(triggers)} — suspended"),
            **_mark("c_review", next_node=None, status="error"),
        }

    if status in ("Triaged", "Pending Documents", "New"):
        res = await execute_tool(
            "update_claim_status",
            {**_lookup(state), "new_status": "Under Investigation",
             "notes": "Fraud and contestability review cleared — moved to investigation."},
            ctx,
        )
        if not res.get("success"):
            return _fail(state, "c_review", res.get("error") or "Could not open the investigation.")
        claim = res.get("claim") or claim

    return {
        "claim_stage": "claim_adjudication",
        "claim_record": claim,
        "claim_outcome": None,
        "requires_claim_intervention": False,
        "claim_audit": _log(
            state,
            f"Review cleared — fraud probability {fraud:.0%}"
            + (", underwriting already ruled on contestability/disclosure" if already_resolved else ", no contestability or duplicate trigger"),
        ),
        **_mark("c_review", next_node="c_adjudicate"),
    }


async def c_adjudicate(state: ChatState) -> dict:
    """Stage 5 — the decision. Over the manager threshold the pipeline refers
    rather than approves: adjuster authority is a legal limit, not a policy the
    automation may relax."""
    ctx = _ctx(state)
    claim = state.get("claim_record") or {}
    status = str(claim.get("status") or "")
    amount = float(claim.get("submitted_amount") or 0)

    if status in ("Approved", "Partial Approval"):
        return {
            "claim_stage": "claim_disbursement",
            "claim_record": claim,
            "claim_decision": "APPROVED",
            "claim_outcome": None,
            "requires_claim_intervention": False,
            "claim_audit": _log(state, f"Already {status} — adjudication skipped"),
            **_mark("c_adjudicate", next_node="c_payout"),
        }
    if status == "Declined":
        return {
            "claim_stage": "claim_closure",
            "claim_record": claim,
            "claim_decision": "DECLINED",
            "claim_outcome": "Declined",
            "claim_audit": _log(state, "Claim already declined — proceeding to closure"),
            **_mark("c_adjudicate", next_node="c_close"),
        }

    if amount > CLAIM_MANAGER_THRESHOLD or status == "Referred to Manager":
        if status != "Referred to Manager":
            await execute_tool(
                "adjudicate_claim",
                {**_lookup(state), "decision": "REFERRED_TO_MANAGER",
                 "notes": f"Claimed amount PKR {amount:,.0f} exceeds adjuster authority (PKR {CLAIM_MANAGER_THRESHOLD:,.0f})."},
                ctx,
            )
        refreshed = await _refresh(state)
        return {
            "claim_stage": "claim_adjudication",
            "claim_record": refreshed or claim,
            "claim_outcome": "Manager Review",
            "requires_claim_intervention": True,
            "claim_audit": _log(
                state,
                f"Referred to the claims manager — PKR {amount:,.0f} exceeds adjuster authority — suspended",
            ),
            **_mark("c_adjudicate", next_node=None, status="error"),
        }

    res = await execute_tool(
        "adjudicate_claim",
        {**_lookup(state), "decision": "APPROVED", "approved_amount": amount,
         "notes": "Adjudicated by the claims pipeline: documents verified, no fraud, duplicate or contestability trigger."},
        ctx,
    )
    if not res.get("success"):
        return {
            "claim_error": res.get("error") or "Adjudication failed.",
            "claim_blocking_actions": res.get("quick_actions") or [],
            "claim_audit": _log(state, f"Adjudication blocked: {res.get('error')}"),
            **_mark("c_adjudicate", next_node=None, status="error"),
        }

    updated = res.get("claim") or claim
    return {
        "claim_stage": "claim_disbursement",
        "claim_record": updated,
        "claim_decision": "APPROVED",
        "claim_outcome": None,
        "requires_claim_intervention": False,
        "claim_audit": _log(state, f"Approved for PKR {float(updated.get('approved_amount') or amount):,.0f}"),
        **_mark("c_adjudicate", next_node="c_payout"),
    }


async def c_payout(state: ChatState) -> dict:
    """Stage 6 — disbursement. This moves money, so it runs only on a claim the
    pipeline itself just approved within adjuster authority."""
    ctx = _ctx(state)
    claim = state.get("claim_record") or {}
    payable = float(claim.get("approved_amount") or 0) or float(claim.get("submitted_amount") or 0)

    if str(claim.get("status")) == "Settled":
        return {
            "claim_stage": "claim_closure",
            "claim_record": claim,
            "claim_outcome": "Settled",
            "claim_audit": _log(state, "Already settled — disbursement skipped"),
            **_mark("c_payout", next_node="c_close"),
        }

    res = await execute_tool(
        "issue_claim_payout",
        {**_lookup(state), "amount": payable, "method": "Bank Transfer",
         "notes": "Disbursed by the claims pipeline on adjudicated approval."},
        ctx,
    )
    if not res.get("success"):
        return {
            "claim_error": res.get("error") or "Disbursement failed.",
            "claim_blocking_actions": res.get("quick_actions") or [],
            "claim_audit": _log(state, f"Disbursement blocked: {res.get('error')}"),
            **_mark("c_payout", next_node=None, status="error"),
        }

    payout = res.get("payout") or {}
    return {
        "claim_stage": "claim_closure",
        "claim_record": res.get("claim") or claim,
        "claim_payout": payout,
        "claim_outcome": "Settled",
        "claim_audit": _log(
            state,
            f"Disbursed PKR {payable:,.0f} via Bank Transfer — ref {payout.get('reference_number')}",
        ),
        **_mark("c_payout", next_node="c_close"),
    }


async def c_close(state: ChatState) -> dict:
    """Stage 7 — close the claim and write the audit trail onto the linked case."""
    ctx = _ctx(state)
    audit = _log(state, f"Claim closed — settlement lifecycle finalised ({state.get('claim_outcome')})")
    claim = state.get("claim_record") or {}

    res = await execute_tool(
        "update_claim_status",
        {**_lookup(state), "new_status": "Closed",
         "notes": "CLAIMS AUDIT TRAIL\n" + "\n".join(audit)},
        ctx,
    )
    # A refused close (an illegal transition from an unexpected state) is worth
    # recording but is not a pipeline failure — the money already moved.
    if not res.get("success"):
        audit = [*audit, f"Close refused: {res.get('error')}"]

    return {
        "claim_stage": "completed",
        "claim_record": res.get("claim") or claim,
        "claim_audit": audit,
        **_mark("c_close", next_node=None),
    }


async def c_resume(state: ChatState) -> dict:
    """Router for continue_claim_journey.

    Mostly an audit line — the conditional edge below picks the re-entry stage
    from state. The one piece of real work is rehydrating a COLD thread: a
    journey suspended in one session and resumed from another ("continue the
    claims journey for CLM-2026-0002" in a fresh chat) has no persisted claim,
    and without this it would fall through to c_intake and try to open a second
    FNOL on a loss that already has one.
    """
    update: dict[str, Any] = {
        "claim_audit": _log(state, "Claims journey resumed"),
        "claim_error": None,
        "claim_blocking_actions": [],
    }
    if state.get("claim_number"):
        return update

    args = (state.get("pending_call") or {}).get("args", {})
    if not (args.get("claim_number") or args.get("claimant_name")):
        return update  # nothing to go on — c_intake reports it honestly

    found = await execute_tool(
        "get_claim_details",
        {"claim_number": args.get("claim_number"), "claimant_name": args.get("claimant_name")},
        _ctx(state),
    )
    if not found.get("success"):
        return update
    claim = found.get("claim") or {}
    status = str(claim.get("status") or "")
    update.update({
        "claim_id": str(claim.get("id") or ""),
        "claim_number": claim.get("claim_number"),
        "claim_record": claim,
        # Re-derive where it stopped from the claim itself rather than trusting
        # a state we do not have: the workbench is the source of truth.
        "claim_outcome": _outcome_for_status(status, claim),
        "claim_stage": "claim_document_audit",
        "requires_claim_intervention": status in ("Re-Underwriting Required", "Referred to Manager"),
        "claim_audit": _log(state, f"Rehydrated {claim.get('claim_number')} from the workbench — currently {status}"),
    })
    return update


def _outcome_for_status(status: str, claim: dict) -> Optional[str]:
    """Map a live claim status back onto the suspension it corresponds to, so a
    cold resume re-enters at the same stage a warm one would."""
    if status == "Re-Underwriting Required":
        return "Underwriting Referral"
    if status == "Referred to Manager":
        return "Manager Review"
    if status == "Settled":
        return "Settled"
    if status in ("Pending Documents",) or not (claim.get("artifacts") or []):
        return "Pending Documents"
    return None


# ═══════════════════════════════════════════════════════════════════════════
# Routing + final summary
# ═══════════════════════════════════════════════════════════════════════════

def _route_error(next_node: str):
    def _route(state: ChatState) -> str:
        return "c_finish" if state.get("claim_error") else next_node
    return _route


def route_after_documents(state: ChatState) -> str:
    if state.get("claim_error"):
        return "c_finish"
    return "c_finish" if state.get("claim_outcome") == "Pending Documents" else "c_review"


def route_after_review(state: ChatState) -> str:
    if state.get("claim_error") or state.get("requires_claim_intervention"):
        return "c_finish"
    return "c_adjudicate"


def route_after_adjudicate(state: ChatState) -> str:
    if state.get("claim_error") or state.get("requires_claim_intervention"):
        return "c_finish"
    return "c_close" if state.get("claim_outcome") == "Declined" else "c_payout"


def route_resume(state: ChatState) -> str:
    """Re-enter where the pipeline stopped, per persisted state."""
    if not state.get("claim_number"):
        return "c_intake"
    outcome = state.get("claim_outcome")
    if outcome == "Pending Documents":
        return "c_documents"          # re-audit; passes once an upload landed
    if outcome == "Underwriting Referral":
        return "c_review"             # re-read; the verdict may have resolved it
    if outcome == "Manager Review":
        return "c_adjudicate"         # re-read; the manager may have decided
    if outcome == "Settled":
        return "c_close"
    return "c_documents"


def _finish_actions(state: ChatState, claim: dict) -> list[dict]:
    """The chips that clear whatever the pipeline stopped on — the whole point
    of suspending rather than failing."""
    ref = state.get("claim_number") or ""
    outcome = state.get("claim_outcome")
    route = f"claims/{state.get('claim_id')}" if state.get("claim_id") else "claims"

    if state.get("claim_blocking_actions"):
        return state["claim_blocking_actions"][:5]

    if outcome == "Pending Documents":
        missing = state.get("claim_missing_documents") or ["Hospital Bill"]
        return [
            *(
                {
                    "label": f"Upload {d}",
                    "actionType": "upload",
                    "payload": json.dumps({"document_type": d, "claim_id": state.get("claim_id"), "claim_number": ref}),
                }
                for d in missing[:3]
            ),
            {"label": "Resume the claim", "actionType": "submit", "payload": f"Continue the claims journey for {ref}"},
        ]

    if outcome == "Underwriting Referral":
        return [
            {"label": "Approve & continue", "actionType": "submit",
             "payload": f"Resolve underwriting on claim {ref} as APPROVE_CONTINUE"},
            {"label": "Approve with exclusion", "actionType": "submit",
             "payload": f"Resolve underwriting on claim {ref} as APPROVE_WITH_EXCLUSION"},
            {"label": "Decline — non-disclosure", "actionType": "submit",
             "payload": f"Resolve underwriting on claim {ref} as DECLINE_NON_DISCLOSURE"},
            {"label": "Open claim file", "actionType": "navigate", "payload": route},
        ]

    if outcome == "Manager Review":
        amount = float(claim.get("submitted_amount") or 0)
        return [
            {"label": f"Approve PKR {amount:,.0f}", "actionType": "submit",
             "payload": f"Adjudicate claim {ref} as APPROVED for {amount:.0f}"},
            {"label": "Partial approval", "actionType": "submit",
             "payload": f"Adjudicate claim {ref} as PARTIAL_APPROVAL"},
            {"label": "Decline claim", "actionType": "submit",
             "payload": f"Adjudicate claim {ref} as DECLINED"},
            {"label": "Open claim file", "actionType": "navigate", "payload": route},
        ]

    return [
        {"label": "Open claim file", "actionType": "navigate", "payload": route},
        {"label": "Claims dashboard", "actionType": "submit", "payload": "Show the claims dashboard"},
        {"label": "Register another claim", "actionType": "submit", "payload": "Register a new claim"},
    ]


async def c_finish(state: ChatState) -> dict:
    """Answer the launching tool_call with one consolidated ToolMessage —
    outcome, audit trail, navigation and the exact next-step chips."""
    call = state.get("pending_call") or {}
    outcome = state.get("claim_outcome")
    error = state.get("claim_error")
    ref = state.get("claim_number") or ""
    claim = state.get("claim_record") or {}
    claim_id = state.get("claim_id")
    route = f"claims/{claim_id}" if claim_id else "claims"

    result: dict[str, Any] = {
        "audit_trail": state.get("claim_audit", []),
        "claim_number": ref,
        "outcome": outcome,
    }

    if error:
        result.update({"success": False, "error": error})
    elif outcome == "Pending Documents":
        missing = state.get("claim_missing_documents") or []
        result.update({
            "success": True,
            "message": (
                f"Claims journey suspended at the document audit — **{ref}** has nothing on file. "
                f"Needed: {', '.join(missing) or 'at least one claim document'}. "
                "Approval, payout and settlement are all blocked until one is attached."
            ),
        })
    elif outcome == "Underwriting Referral":
        reasons = state.get("claim_referral_reasons") or []
        result.update({
            "success": True,
            "message": (
                f"Claims journey suspended — **{ref}** was referred back to underwriting."
                + (f"\nTrigger: {'; '.join(reasons)}" if reasons else "")
                + "\n\nUnderwriting must rule on whether the risk stands before the claim can be adjudicated."
            ),
        })
    elif outcome == "Manager Review":
        amount = float(claim.get("submitted_amount") or 0)
        result.update({
            "success": True,
            "message": (
                f"Claims journey suspended for manager sign-off — **{ref}** claims PKR {amount:,.0f}, "
                f"above the PKR {CLAIM_MANAGER_THRESHOLD:,.0f} adjuster authority limit."
            ),
        })
    elif outcome == "Declined":
        result.update({
            "success": True,
            "message": f"Claims journey complete — **{ref}** finished as **Declined**.",
        })
    else:
        payout = state.get("claim_payout") or {}
        settled = float(claim.get("settlement_amount") or payout.get("amount") or 0)
        result.update({
            "success": True,
            "message": (
                f"Claims journey complete — **{ref}** settled for **PKR {settled:,.0f}**"
                + (f" (ref `{payout.get('reference_number')}`)" if payout.get("reference_number") else "")
                + " and closed."
            ),
        })

    result["quick_actions"] = _finish_actions(state, claim)

    if claim_id:
        result["last_action"] = {
            "tool_name": "claim_journey", "entity_type": "claim",
            "entity_id": claim_id, "route": route,
            "label": f"Claim: {outcome or ('error' if error else 'done')} ({ref})",
        }
        result["navigate"] = {"route": route, "entity_id": claim_id, "highlight": True}

    return {
        "messages": [ToolMessage(
            content=json.dumps(result, default=str),
            tool_call_id=call.get("id", ""),
            name=call.get("name", "start_claim_journey"),
        )],
        "pending_call": None,
    }


def register_claims_journey(builder) -> None:
    """Attach all claims-journey nodes and edges to the main StateGraph builder."""
    for node_name, fn in [
        ("c_intake", c_intake), ("c_triage", c_triage), ("c_documents", c_documents),
        ("c_review", c_review), ("c_adjudicate", c_adjudicate), ("c_payout", c_payout),
        ("c_close", c_close), ("c_resume", c_resume), ("c_finish", c_finish),
    ]:
        builder.add_node(node_name, fn)

    builder.add_conditional_edges("c_intake", _route_error("c_triage"), {"c_triage": "c_triage", "c_finish": "c_finish"})
    builder.add_conditional_edges("c_triage", _route_error("c_documents"), {"c_documents": "c_documents", "c_finish": "c_finish"})
    builder.add_conditional_edges("c_documents", route_after_documents, {"c_review": "c_review", "c_finish": "c_finish"})
    builder.add_conditional_edges("c_review", route_after_review, {"c_adjudicate": "c_adjudicate", "c_finish": "c_finish"})
    builder.add_conditional_edges("c_adjudicate", route_after_adjudicate,
                                  {"c_payout": "c_payout", "c_close": "c_close", "c_finish": "c_finish"})
    builder.add_conditional_edges("c_payout", _route_error("c_close"), {"c_close": "c_close", "c_finish": "c_finish"})
    builder.add_edge("c_close", "c_finish")
    builder.add_conditional_edges(
        "c_resume", route_resume,
        {"c_intake": "c_intake", "c_documents": "c_documents", "c_review": "c_review",
         "c_adjudicate": "c_adjudicate", "c_close": "c_close"},
    )
    builder.add_edge("c_finish", "agent")
