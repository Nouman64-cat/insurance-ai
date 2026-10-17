"""Workflow planning over existing tools. Execution remains in LangGraph's gate.

No second workflow engine: checkpoints, interrupts, audit and resume belong to
existing graph nodes and operations.py, including member/claim/group journeys.
"""
from .loader import metadata
from .registry import authorized


def plan(skill_ids: list[str], role: str, platform: str = "web") -> dict:
    permitted = authorized(role, platform)
    steps, blockers = [], []
    for skill in metadata():
        if skill.id not in skill_ids:
            continue
        for step in skill.steps:
            if step.capability not in permitted:
                blockers.append({"skill": skill.id, "capability": step.capability, "reason": "authorized_handoff_required"})
            steps.append({"id": f"{skill.id}:{step.id}", "capability": step.capability,
                          "depends_on": [f"{skill.id}:{dep}" for dep in step.depends_on],
                          "status": "pending" if step.capability in permitted else "blocked"})
    return {"steps": steps, "blockers": blockers, "execution": "existing_permission_gate",
            "message": "Workflow template only. Execute only actions the user actually requested. Read-only queries do not authorize mutations. Resolve live prerequisites and arguments at each step; never infer completion from this plan."}


def recovery(result: dict, mutating: bool) -> str:
    if result.get("success") is True:
        return "verify_result"
    if result.get("outcome_unknown") and mutating:
        return "verify_state_before_retry"
    code = result.get("error_code")
    return {"forbidden": "authorized_handoff_required", "choice_needed": "present_verified_choices",
            "validation": "request_missing_or_corrected_parameters", "conflict": "refresh_workflow_state", "prerequisite_missing": "complete_backend_prerequisite",
            "not_found": "resolve_verified_record", "unavailable_capability": "supported_alternative_or_manual_handoff"}.get(
                code, "bounded_read_retry" if result.get("retryable") and not mutating else "report_blocker")
