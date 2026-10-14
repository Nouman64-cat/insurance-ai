"""Authoritative application state: stage, blockers and the legal next actions.

One function, `application_state`, derived from the case row tenant-service
already returns (it carries every pre-underwriting gate status, the latest AI
decision and the initial-premium status). get_case_details,
get_workflow_recommendation, approve_case, preview_application_transition, the
member matrix and the work queue all read it, so they can never disagree about
where an application is or what may happen next.

Every action names the application's canonical reference; nothing here infers
state from conversation text.
"""

from __future__ import annotations

from typing import Optional

# (status key, label, satisfied statuses, next-step chip label, chip prompt, tool)
GATES = (
    ("e_application", "Customer E-Application", ("Verified",), "Generate E-App Link",
     "Generate e-application link for case {no}", "verify_e_application"),
    ("acr", "Agent's Confidential Report", ("Submitted",), "File ACR",
     "Submit agent confidential report for case {no}", "submit_agent_confidential_report"),
    ("compliance", "PEP & Sanctions Screening", ("Passed", "Cleared"), "Run PEP Check",
     "Run compliance screening for case {no}", "run_compliance_screening"),
    ("insurance_history", "Insurance History Clearance", ("Clear", "Cleared"), "Run History Check",
     "Run insurance history check for case {no}", "run_insurance_history_check"),
    ("medical_exam", "Medical Examination", ("Completed", "Waived", "NotRequired"), "Assess Medical",
     "Assess medical examination for case {no}", "assess_medical_examination"),
)

# Legal case-status moves. tenant-service accepts any PATCH, so the chat guards it.
CASE_TRANSITIONS: dict[str, set[str]] = {
    "New": {"InProgress", "Pending Documents", "Under Review", "Rejected", "Closed"},
    "InProgress": {"Pending Documents", "Under Review", "Approved", "Rejected", "Closed"},
    "Pending Documents": {"InProgress", "Under Review", "Rejected", "Closed"},
    "Under Review": {"InProgress", "Pending Documents", "Approved", "Rejected", "Closed"},
    "Approved": {"Closed"},
    "Rejected": {"Closed", "Under Review"},
    "Closed": set(),
}

_DECIDED = {"Approved", "Rejected", "Closed"}


def _gate_status(case: dict, key: str) -> Optional[str]:
    return case.get(f"{key}_status")


def gate_rows(case: dict) -> list[dict]:
    return [{"key": key, "label": label, "status": _gate_status(case, key) or "NotStarted",
             "done": (_gate_status(case, key) or "") in done, "tool": tool}
            for key, label, done, _chip, _prompt, tool in GATES]


def _chip(label: str, payload: str, action_id: str) -> dict:
    return {"id": action_id, "label": label, "actionType": "submit", "payload": payload}


def application_state(case: dict) -> dict:
    """Stage, blockers and allowed actions for one underwriting application."""
    no = case.get("caseNumber") or ""
    status = case.get("caseStatus") or "New"
    gates = gate_rows(case)
    open_gates = [g for g in gates if not g["done"]]
    decision = case.get("latest_ai_decision")
    ipp = case.get("ipp_status") or "NotStarted"
    blockers: list[str] = []
    actions: list[dict] = []

    if status == "Closed":
        stage = "Active Policy" if ipp == "Realized" else "Closed"
    elif status == "Rejected":
        stage = "Declined"
        actions.append(_chip("Refer for Review", f"Refer application {no} for underwriting review", "refer_review"))
    elif status == "Approved":
        stage = "Policy Issuance"
        if ipp == "Realized":
            blockers.append("First premium received — activation pending.")
        elif ipp == "Initiated":
            blockers.append("First premium payment started — awaiting gateway confirmation.")
        actions += [_chip("Check Pre-Issuance", f"Check the pre-issuance status for case {no}", "pre_issuance"),
                    _chip("Issue Policy", f"Run pre-issuance verification and issue the policy for case {no}", "issue")]
    elif open_gates:
        stage = "Pre-Underwriting"
        nxt = open_gates[0]
        blockers += [f"{g['label']}: {g['status']}" for g in open_gates]
        meta = next(x for x in GATES if x[0] == nxt["key"])
        actions.append(_chip(meta[3], meta[4].format(no=no), f"gate:{nxt['key']}"))
    elif not decision:
        stage = "Underwriting"
        blockers.append("AI risk assessment has not run.")
        actions.append(_chip("Run AI Underwriting", f"Run risk assessment for case {no}", "risk_assessment"))
    else:
        stage = "Underwriting Decision"
        blockers.append(f"Awaiting an underwriter's decision (AI recommendation: {decision}).")
        actions += [_chip("Approve", f"Approve case {no}", "approve"),
                    _chip("Decline", f"Set case {no} status to Rejected", "decline"),
                    _chip("Request Evidence", f"Request additional evidence for application {no}", "request_evidence"),
                    _chip("Refer for Review", f"Refer application {no} for underwriting review", "refer_review")]

    return {
        "stage": stage,
        "case_status": status,
        "gates": gates,
        "ai_decision": decision,
        "initial_premium": ipp,
        "blockers": blockers,
        "allowed_actions": actions,
        "allowed_statuses": sorted(CASE_TRANSITIONS.get(status, set())),
        "next_action": actions[0] if actions else None,
    }


def approval_blockers(case: dict) -> list[str]:
    """Why an application cannot be approved yet; empty when it can."""
    status = case.get("caseStatus") or "New"
    if status in _DECIDED:
        return [f"The application is already {status}."]
    out = [f"{g['label']} is {g['status']}" for g in gate_rows(case) if not g["done"]]
    if not case.get("latest_ai_decision"):
        out.append("the AI risk assessment has not run")
    return out


def transition_problem(current: str, target: str) -> Optional[str]:
    if current == target:
        return f"The application is already {target}."
    allowed = CASE_TRANSITIONS.get(current)
    if allowed is None or target in allowed:
        return None
    if not allowed:
        return f"A {current} application can't change status."
    return f"An application in {current} can't move to {target}. Allowed: {', '.join(sorted(allowed))}."
