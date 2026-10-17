"""Operation status and safe resume (get_operation_status / resume_operation).

Every tool call already has a durable identity: its tool_call id, checkpointed
with the thread together with the ToolMessage that answered it. So an operation
log needs no table of its own — it is read straight out of the thread, which
also means it survives refreshes and device switches exactly as the
conversation does.

  operation_id   the tool_call id
  status         completed | failed | cancelled | pending
  retryable      failed for a transient reason (timeout, unreachable, 5xx)
  outcome_unknown  the request may have reached the service (timeout) — the
                 state must be re-read before the step is retried

Both tools are answered inside permission_gate (graph.py) because they need the
thread's messages, which tool handlers never see. resume_operation re-runs only
the one failed step, through the same RBAC check as the original call; steps
that completed are never repeated.
"""

from __future__ import annotations

import json
from typing import Any, Iterable, Optional

from langchain_core.messages import AIMessage, ToolMessage

from permission import MUTATING_TOOLS, STEP_LABELS

OPERATION_TOOLS = {"get_operation_status", "resume_operation"}

# A journey suspends rather than fails; it is resumed by its own continue tool.
_JOURNEY_RESUME = {
    "start_underwriting_journey": "continue_underwriting_journey",
    "continue_underwriting_journey": "continue_underwriting_journey",
    "start_claim_journey": "continue_claim_journey",
    "continue_claim_journey": "continue_claim_journey",
    "start_group_journey": "continue_group_journey",
    "continue_group_journey": "continue_group_journey",
}


def _parse(content: Any) -> dict:
    if isinstance(content, dict):
        return content
    try:
        parsed = json.loads(content) if isinstance(content, str) else {}
    except (TypeError, ValueError):
        return {"message": str(content)[:300]}
    return parsed if isinstance(parsed, dict) else {}


def _status(result: Optional[dict]) -> str:
    if result is None:
        return "pending"
    if result.get("cancelled"):
        return "cancelled"
    if result.get("success") is False or (result.get("error") and result.get("success") is not True):
        return "failed"
    return "completed"


def operations_from_messages(messages: Iterable[Any]) -> list[dict]:
    """Every tool call in the thread, oldest first, with its outcome."""
    ops: list[dict] = []
    by_id: dict[str, dict] = {}
    for msg in messages:
        if isinstance(msg, AIMessage):
            for call in msg.tool_calls or []:
                if call.get("name") in OPERATION_TOOLS:
                    continue
                op = {
                    "operation_id": call.get("id") or "",
                    "tool": call.get("name") or "",
                    "label": STEP_LABELS.get(call.get("name") or "", call.get("name") or ""),
                    "args": call.get("args") or {},
                    "kind": "mutation" if call.get("name") in MUTATING_TOOLS else "read",
                    "result": None,
                }
                ops.append(op)
                if op["operation_id"]:
                    by_id[op["operation_id"]] = op
        elif isinstance(msg, ToolMessage) and msg.tool_call_id in by_id:
            by_id[msg.tool_call_id]["result"] = _parse(msg.content)

    for op in ops:
        result = op.pop("result")
        op["status"] = _status(result)
        if op["status"] == "failed":
            op["error"] = (result or {}).get("error") or "The step did not complete."
            op["error_code"] = (result or {}).get("error_code") or "unknown"
            op["retryable"] = bool((result or {}).get("retryable"))
            op["outcome_unknown"] = bool((result or {}).get("outcome_unknown"))
        elif op["status"] == "completed":
            op["summary"] = str((result or {}).get("message") or "")[:200]
    return ops


def _superseded(op: dict, later: list[dict]) -> bool:
    """A later call of the same tool with the same arguments completed — the
    failure was already recovered, so retrying it would duplicate the work."""
    return any(o["tool"] == op["tool"] and o["args"] == op["args"] and o["status"] == "completed" for o in later)


def resumable_failures(ops: list[dict]) -> list[dict]:
    out = []
    for i, op in enumerate(ops):
        if op["status"] == "failed" and not _superseded(op, ops[i + 1:]):
            out.append(op)
    return out


def _journeys(state: dict) -> list[dict]:
    """Suspended autonomous pipelines in this thread."""
    rows = []
    stage = state.get("journey_stage")
    if stage and stage != "completed":
        rows.append({"journey": "underwriting", "stage": stage, "case_number": state.get("journey_case_number"),
                     "outcome": state.get("journey_outcome"), "error": state.get("journey_error"),
                     "resume_tool": "continue_underwriting_journey"})
    stage = state.get("claim_stage")
    if stage and stage != "completed":
        rows.append({"journey": "claim", "stage": stage, "claim_number": state.get("claim_number"),
                     "resume_tool": "continue_claim_journey"})
    stage = state.get("group_stage")
    if stage and stage != "completed":
        rows.append({"journey": "group", "stage": stage, "organization": state.get("group_organization_name"),
                     "resume_tool": "continue_group_journey"})
    return rows


_ICON = {"completed": "✅", "failed": "❌", "cancelled": "⏹️", "pending": "⏳"}


def operation_status_result(state: dict, args: dict) -> dict:
    ops = operations_from_messages(state.get("messages") or [])
    wanted = (args.get("operation_id") or "").strip()
    if wanted:
        op = next((o for o in ops if o["operation_id"] == wanted), None)
        if op is None:
            return {"success": False, "error": f'No operation "{wanted}" in this conversation.',
                    "error_code": "not_found", "retryable": False}
        ops_shown = [op]
    else:
        limit = max(1, min(int(args.get("limit") or 8), 25))
        ops_shown = ops[-limit:]

    failures = resumable_failures(ops)
    journeys = _journeys(state)
    if not ops_shown and not journeys:
        return {"success": True, "operations": [], "journeys": [],
                "message": "Nothing has run in this conversation yet."}

    lines = [f"- {_ICON[o['status']]} **{o['label']}** — {o['status']}"
             + (f": {o['error']}" if o["status"] == "failed" else "")
             + (" (outcome unknown — check the record before retrying)" if o.get("outcome_unknown") else "")
             for o in ops_shown]
    for j in journeys:
        lines.append(f"- ⏸️ **{j['journey'].title()} journey** suspended at {j['stage'].replace('_', ' ')}")

    quick_actions = []
    if failures:
        last = failures[-1]
        quick_actions.append({"label": f"Retry: {last['label']}", "actionType": "submit",
                              "payload": f"Resume the failed operation {last['operation_id']}"})
    for j in journeys:
        quick_actions.append({"label": f"Continue {j['journey']} journey", "actionType": "submit",
                              "payload": f"Continue the {j['journey']} journey"})

    return {
        "success": True,
        "operations": ops_shown,
        "journeys": journeys,
        "resumable": [{"operation_id": f["operation_id"], "tool": f["tool"], "label": f["label"],
                       "outcome_unknown": f.get("outcome_unknown", False)} for f in failures],
        "message": "Recent operations in this conversation:\n" + "\n".join(lines),
        "quick_actions": quick_actions,
    }


def plan_resume(state: dict, args: dict) -> dict:
    """Which single step to re-run. Returns either {"error": ...result dict...}
    or {"tool", "args", "operation"} for permission_gate to execute."""
    ops = operations_from_messages(state.get("messages") or [])
    failures = resumable_failures(ops)
    wanted = (args.get("operation_id") or "").strip()

    if wanted:
        op = next((o for o in ops if o["operation_id"] == wanted), None)
        if op is None:
            return {"error": {"success": False, "error": f'No operation "{wanted}" in this conversation.',
                              "error_code": "not_found", "retryable": False}}
        if op["status"] == "completed":
            return {"error": {"success": True, "skipped": True, "operation": {"id": wanted, "status": "completed"},
                              "message": f"**{op['label']}** already completed — nothing to resume, so it was not run again."}}
        if op not in failures:
            return {"error": {"success": True, "skipped": True, "operation": {"id": wanted, "status": op["status"]},
                              "message": f"**{op['label']}** was already completed by a later retry — it was not run again."}}
    else:
        journeys = _journeys(state)
        if not failures:
            if journeys:
                j = journeys[-1]
                return {"error": {"success": True, "next_tool": j["resume_tool"],
                                  "message": f"No step failed. The {j['journey']} journey is suspended at "
                                             f"{j['stage'].replace('_', ' ')} — call {j['resume_tool']} to continue it.",
                                  "quick_actions": [{"label": f"Continue {j['journey']} journey", "actionType": "submit",
                                                     "payload": f"Continue the {j['journey']} journey"}]}}
            return {"error": {"success": True, "skipped": True,
                              "message": "Nothing in this conversation failed, so there is nothing to resume."}}
        op = failures[-1]

    if op["tool"] in _JOURNEY_RESUME:
        tool = _JOURNEY_RESUME[op["tool"]]
        return {"error": {"success": True, "next_tool": tool,
                          "message": f"That journey resumes from where it stopped — call {tool}; completed stages are kept."}}

    if op.get("outcome_unknown") and op["kind"] == "mutation" and not args.get("state_verified"):
        return {"error": {
            "success": False, "error_code": "outcome_unknown", "retryable": True, "needs_user_input": True,
            "error": (f"**{op['label']}** timed out, so it may already have been applied. Check the record's current "
                      "state first (e.g. get_case_details); call resume_operation again with state_verified=true only "
                      "if it was not applied."),
        }}
    return {"tool": op["tool"], "args": dict(op["args"]), "operation": op}
