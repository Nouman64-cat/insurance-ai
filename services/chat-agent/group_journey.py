"""The autonomous group-scheme journey — Group Life / Group Family Takaful from
scheme to enrolled members (GROUP_LIFE_PLAN.md Phase 3).

The group mirror of `claims_journey.py`. Once the user confirms
`start_group_journey`, the graph drives

    Scheme → Benefit classes → Census → Group underwriting → Quote →
    Employer acceptance → Issuance & payment → Member enrolment

deterministically. It suspends in exactly the places a person has to act:

  - No census yet / census rejected      → outcome "Census_Needed"
  - Above-FCL members undecided          → outcome "Underwriting_Pending"
  - Quote waiting on the employer        → outcome "Awaiting_Acceptance"   (always)
  - Employer's payment not recorded      → outcome "Awaiting_Payment"
  - Employer turned the quote down       → outcome "Declined"

`continue_group_journey` re-enters through `g_resume`, which reads the scheme's
real status and routes to the right stage — so an upload, an underwriting
decision, an acceptance or a payment made through the portal, a chip or a
standalone tool all pick the pipeline up exactly where it stopped. Every stage
also skips itself when the scheme is already past it, so starting a journey on a
half-finished scheme simply continues it.

Nodes reuse the group tools in group_tools.py through `execute_tool` (same
handlers the user can call one at a time), append to the immutable `group_audit`
trail, and report themselves to the UI through the same `journey_done` /
`journey_next` markers routers/chat.py already turns into process-graph steps.
Its state lives under `group_*` keys; journey.py and claims_journey.py are not
touched (isolation rules 2 and 3).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from langchain_core.messages import ToolMessage

from env_mode import is_demo
from group_tools import _org_route, _pkr, _word
from state import ChatState
from tool_executor import ExecCtx, execute_tool

# Stage metadata: node -> (stage id, UI label). Order matters for the
# "what comes next" markers.
STAGES: dict[str, tuple[str, str]] = {
    "g_scheme":      ("group_scheme",        "Stage 1 · Scheme & Master Policy"),
    "g_benefits":    ("group_benefits",      "Stage 2 · Benefit Classes"),
    "g_census":      ("group_census",        "Stage 3 · Employee Census"),
    "g_underwrite":  ("group_underwriting",  "Stage 4 · Group Underwriting"),
    "g_quote":       ("group_quote",         "Stage 5 · Scheme Quote"),
    "g_acceptance":  ("group_acceptance",    "Stage 6 · Employer Acceptance"),
    "g_issue":       ("group_issuance",      "Stage 7 · Issuance & Payment"),
    "g_enroll":      ("group_enrolment",     "Stage 8 · Member Enrolment"),
}

# Args the launching tool call carries that describe the scheme.
_SCHEME_ARGS = ("organization_name", "organization_id", "master_policy_id", "plan_code", "business_type",
                "effective_date", "term_years", "sum_assured_multiple", "contact_person", "contact_email",
                "contact_phone", "agent_name", "agent_id", "no_agent")


def _ctx(state: ChatState) -> ExecCtx:
    return ExecCtx(
        tenant_id=state.get("tenant_id", ""),
        jwt_token=state.get("jwt_token", ""),
        role=state.get("user_role") or "Admin",
        current_org_id=state.get("group_current_org_id"),
    )


def _log(state: ChatState, entry: str) -> list[str]:
    stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
    return [*state.get("group_audit", []), f"[{stamp}] {entry}"]


def _mark(node: str, *, next_node: str | None, status: str = "done") -> dict[str, Any]:
    """UI process-graph markers consumed by routers/chat.py."""
    sid, label = STAGES[node]
    out: dict[str, Any] = {"journey_done": {"id": f"stage:{sid}", "label": label, "status": status}}
    if next_node and next_node in STAGES:
        nid, nlabel = STAGES[next_node]
        out["journey_next"] = {"id": f"stage:{nid}", "label": nlabel}
    return out


def _fail(state: ChatState, node: str, error: str, chips: list | None = None) -> dict[str, Any]:
    return {
        "group_error": error,
        "group_blocking_actions": chips or [],
        "group_audit": _log(state, f"ERROR at {STAGES[node][1]}: {error}"),
        **_mark(node, next_node=None, status="error"),
    }


def _suspend(state: ChatState, node: str, outcome: str, entry: str, **extra: Any) -> dict[str, Any]:
    return {
        "group_stage": STAGES[node][0],
        "group_outcome": outcome,
        "requires_group_intervention": True,
        "group_audit": _log(state, entry),
        **extra,
        **_mark(node, next_node=None, status="error"),
    }


def _advance(state: ChatState, node: str, next_node: str, entry: str, **extra: Any) -> dict[str, Any]:
    """Forward progress clears whatever suspension stopped the last run —
    leaving it set would route the resumed journey straight back to g_finish."""
    return {
        "group_stage": STAGES[next_node][0],
        "group_outcome": None,
        "requires_group_intervention": False,
        "group_error": None,
        "group_audit": _log(state, entry),
        **extra,
        **_mark(node, next_node=next_node),
    }


def _launch_args(state: ChatState) -> dict[str, Any]:
    return (state.get("pending_call") or {}).get("args", {}) or {}


def _lookup(state: ChatState) -> dict[str, Any]:
    """How every downstream tool addresses the scheme: ids once known, else
    whatever the user named."""
    if state.get("group_master_policy_id") and state.get("group_organization_id"):
        return {"organization_id": state["group_organization_id"], "master_policy_id": state["group_master_policy_id"]}
    args = _launch_args(state)
    return {k: args[k] for k in ("organization_id", "organization_name", "master_policy_id") if args.get(k)}


async def _snapshot(state: ChatState) -> dict[str, Any]:
    """Re-read the scheme so a stage decides on current truth, not stale state —
    the user may have uploaded a census, decided a case or accepted a quote in
    the portal between suspensions."""
    res = await execute_tool("get_group_scheme_status", _lookup(state), _ctx(state))
    if not res.get("success"):
        raise _Stop(res.get("error") or "Could not read the group scheme.", res.get("quick_actions"))
    return res["scheme"]


class _Stop(Exception):
    def __init__(self, message: str, chips: list | None = None):
        super().__init__(message)
        self.chips = chips or []


def _scheme_update(scheme: dict) -> dict[str, Any]:
    return {
        "group_scheme": scheme,
        "group_organization_id": scheme["organization_id"],
        "group_organization_name": scheme["organization_name"],
        "group_current_org_id": scheme["organization_id"],
        "group_current_org_name": scheme["organization_name"],
        "group_master_policy_id": scheme["master_policy_id"],
        "group_plan_code": scheme.get("plan_code"),
        "group_business_type": scheme.get("business_type"),
        "group_pending_members": scheme.get("pending_members") or [],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Stage nodes
# ═══════════════════════════════════════════════════════════════════════════

async def g_scheme(state: ChatState) -> dict:
    """Stage 1 — create or attach the organization and its master policy."""
    args = _launch_args(state)
    scheme_args = {k: args[k] for k in _SCHEME_ARGS if args.get(k) is not None}
    res = await execute_tool("create_group_scheme", {**scheme_args, "create_if_missing": True}, _ctx(state))
    if not res.get("success"):
        # create_group_scheme answers a missing agent / name with its own chips —
        # carry them out so the suspension is still one click to fix.
        return _fail(state, "g_scheme", res.get("error") or res.get("message") or "Could not create the group scheme.",
                     res.get("quick_actions"))
    try:
        scheme = await _snapshot({**state, "group_organization_id": res["organization_id"],
                                  "group_master_policy_id": res["master_policy_id"]})
    except _Stop as stop:
        return _fail(state, "g_scheme", str(stop), stop.chips)
    verb = "attached to the in-progress scheme" if res.get("attached") else "created"
    return _advance(
        state, "g_scheme", "g_benefits",
        f"Scheme {verb}: {scheme['organization_name']} — {scheme.get('plan_label') or scheme.get('plan_code')} "
        f"({scheme['business_type']}), status {scheme['status']}"
        + (" · organization created" if res.get("created_organization") else ""),
        **_scheme_update(scheme),
        group_census_errors=[], group_missing_nominations=[], group_blocking_actions=[],
    )


async def g_benefits(state: ChatState) -> dict:
    """Stage 2 — benefit classes. Never a stop: a scheme with no classes covers
    everyone at its default salary multiple, which is what it did before classes
    existed. Demo mode fills in a ready-made set."""
    try:
        scheme = await _snapshot(state)
    except _Stop as stop:
        return _fail(state, "g_benefits", str(stop), stop.chips)

    if scheme["classes"] or scheme["member_count"] or scheme["status"] not in ("Pending", "Proposed"):
        why = f"{len(scheme['classes'])} class(es) defined" if scheme["classes"] else "scheme already past enrolment"
        return _advance(state, "g_benefits", "g_census", f"Benefit classes: {why} — nothing to add", **_scheme_update(scheme))

    args = _launch_args(state)
    if args.get("use_demo_data") and is_demo():
        res = await execute_tool(
            "add_group_benefit_class",
            {**_lookup(state), "use_demo_template": True, "include_above_fcl": int(args.get("above_fcl_count") or 0) > 0},
            _ctx(state),
        )
        if not res.get("success"):
            return _fail(state, "g_benefits", res.get("error") or "Could not add the demo benefit classes.")
        scheme = await _snapshot(state)
        return _advance(state, "g_benefits", "g_census",
                        f"Benefit classes added from the demo template: {', '.join(res.get('classes_added') or [])}",
                        **_scheme_update(scheme))

    return _advance(state, "g_benefits", "g_census",
                    "No benefit classes defined — every member will be covered at the scheme's default salary multiple",
                    **_scheme_update(scheme))


async def g_census(state: ChatState) -> dict:
    """Stage 3 — the employee census. Real schemes always wait for a person to
    supply it; demo mode can generate one."""
    try:
        scheme = await _snapshot(state)
    except _Stop as stop:
        return _fail(state, "g_census", str(stop), stop.chips)

    if scheme["member_count"] or scheme["status"] not in ("Pending", "Proposed", "Declined"):
        return _advance(state, "g_census", "g_underwrite",
                        f"Census on file: {scheme['member_count']} member(s)", **_scheme_update(scheme))

    args = _launch_args(state)
    if args.get("use_demo_data") and is_demo():
        res = await execute_tool(
            "submit_group_census",
            {**_lookup(state), "use_demo_data": True, "employee_count": args.get("employee_count"),
             "above_fcl_count": args.get("above_fcl_count") or 0},
            _ctx(state),
        )
        if not res.get("success"):
            return _suspend(state, "g_census", "Census_Needed", f"Demo census rejected: {res.get('error')}",
                            group_scheme=scheme, group_census_errors=res.get("census_errors") or [res.get("error") or ""])
        return _advance(state, "g_census", "g_underwrite",
                        f"Demo census enrolled: {res.get('enrolled')} employees, Free Cover Limit {_pkr(res.get('free_cover_limit'))}",
                        **_scheme_update(res["scheme"]), group_census_errors=[])

    return _suspend(state, "g_census", "Census_Needed",
                    "No census on file — waiting for the employee list", group_scheme=scheme, group_census_errors=[])


async def g_underwrite(state: ChatState) -> dict:
    """Stage 4 — group underwriting. Size, plan minimum and the Free Cover Limit
    are applied when the census is confirmed; what is left here is the above-limit
    members, who each need an underwriter's decision before the scheme can be
    priced."""
    try:
        scheme = await _snapshot(state)
    except _Stop as stop:
        return _fail(state, "g_underwrite", str(stop), stop.chips)
    pending = scheme["pending_members"]
    if pending:
        return _suspend(
            state, "g_underwrite", "Underwriting_Pending",
            f"{len(pending)} member(s) above the Free Cover Limit await an underwriting decision — suspended",
            **_scheme_update(scheme),
        )
    return _advance(
        state, "g_underwrite", "g_quote",
        f"Group underwriting cleared: {scheme['member_count']} member(s), Free Cover Limit {_pkr(scheme.get('free_cover_limit'))}"
        f", total cover {_pkr(scheme['total_cover'])}",
        **_scheme_update(scheme),
    )


async def g_quote(state: ChatState) -> dict:
    """Stage 5 — price the scheme as one pool and raise the quote."""
    try:
        scheme = await _snapshot(state)
    except _Stop as stop:
        return _fail(state, "g_quote", str(stop), stop.chips)

    # Already past quoting (quoted, accepted, issued, active): reuse what exists.
    if scheme["status"] in ("Quoted", "Accepted", "PendingPayment", "Active") and scheme.get("quote"):
        return _advance(state, "g_quote", "g_acceptance", f"Quote v{scheme['quote']['version']} already on file ({scheme['quote']['status']})",
                        **_scheme_update(scheme), group_quote=scheme["quote"])

    res = await execute_tool("generate_group_quote", _lookup(state), _ctx(state))
    if not res.get("success"):
        if res.get("pending_members"):
            return _suspend(state, "g_quote", "Underwriting_Pending",
                            f"Quote blocked: {len(res['pending_members'])} member(s) still need an underwriting decision",
                            group_scheme=scheme, group_pending_members=res["pending_members"])
        return _fail(state, "g_quote", res.get("error") or "Could not generate the quote.", res.get("quick_actions"))
    quote = res["quote"]
    return _advance(
        state, "g_quote", "g_acceptance",
        f"Quote v{quote['version']} generated — annual {_word(quote['business_type'])} {_pkr(quote['total_premium'])} "
        f"for {quote['member_count']} member(s)",
        **_scheme_update(res["scheme"]), group_quote=quote,
    )


async def g_acceptance(state: ChatState) -> dict:
    """Stage 6 — the employer decides. This stage ALWAYS waits for a person: a
    quote is an offer, and nothing here may accept it on the employer's behalf."""
    try:
        scheme = await _snapshot(state)
    except _Stop as stop:
        return _fail(state, "g_acceptance", str(stop), stop.chips)
    status = scheme["status"]

    if status in ("Accepted", "PendingPayment", "Active"):
        return _advance(state, "g_acceptance", "g_issue", "Quote accepted by the employer", **_scheme_update(scheme))
    if status == "Declined":
        return _suspend(state, "g_acceptance", "Declined", "The employer declined the quote — journey paused",
                        **_scheme_update(scheme), group_quote=scheme.get("quote"))
    return _suspend(
        state, "g_acceptance", "Awaiting_Acceptance",
        f"Quote v{(scheme.get('quote') or {}).get('version', '?')} sent — waiting for the employer to accept, revise or decline",
        **_scheme_update(scheme), group_quote=scheme.get("quote"),
    )


async def g_issue(state: ChatState) -> dict:
    """Stage 7 — issue the master policy and its certificates, then hold at the
    billing gate until the employer's payment is recorded. A demo employer pays
    with a generated reference; a real one has to supply the bank's."""
    ctx = _ctx(state)
    try:
        scheme = await _snapshot(state)
    except _Stop as stop:
        return _fail(state, "g_issue", str(stop), stop.chips)

    entries: list[str] = []
    if scheme["status"] == "Accepted":
        res = await execute_tool("issue_group_policy", _lookup(state), ctx)
        if not res.get("success"):
            return _fail(state, "g_issue", res.get("error") or "Could not issue the master policy.", res.get("quick_actions"))
        scheme = res["scheme"]
        entries.append(f"Master policy {scheme.get('policy_number')} issued with {res['issued']['certificates_issued']} certificate(s)")

    if scheme["status"] == "PendingPayment":
        if is_demo():
            res = await execute_tool("record_group_payment", _lookup(state), ctx)
            if not res.get("success"):
                return _fail(state, "g_issue", res.get("error") or "Could not record the payment.", res.get("quick_actions"))
            scheme = res["scheme"]
            entries.append(f"Demo payment recorded (ref {res.get('reference')})")
        else:
            return _suspend(
                state, "g_issue", "Awaiting_Payment",
                "; ".join([*entries, "Awaiting the employer's payment — suspended"]),
                **_scheme_update(scheme),
            )

    if scheme["status"] != "Active":
        return _fail(state, "g_issue", f"The scheme is {scheme['status']}, so it can't be issued yet.")
    entries.append("Cover is in force")
    return _advance(state, "g_issue", "g_enroll", "; ".join(entries), **_scheme_update(scheme))


async def g_enroll(state: ChatState) -> dict:
    """Stage 8 — members are Active with the scheme. Missing nominations are
    listed for follow-up; they never block."""
    try:
        scheme = await _snapshot(state)
    except _Stop as stop:
        return _fail(state, "g_enroll", str(stop), stop.chips)
    missing = scheme["missing_nominations"]
    update = {
        **_scheme_update(scheme),
        "group_stage": "completed",
        "group_outcome": "Completed",
        "requires_group_intervention": False,
        "group_error": None,
        "group_missing_nominations": missing,
        "group_audit": _log(
            state,
            f"Enrolment complete: {scheme['member_count']} member(s) active"
            + (f"; {len(missing)} without a nominee recorded" if missing else "; every member has a nominee"),
        ),
    }
    return {**update, **_mark("g_enroll", next_node=None)}


async def g_resume(state: ChatState) -> dict:
    """Router for continue_group_journey: re-read the scheme and let
    route_resume pick the stage from its real status."""
    update: dict[str, Any] = {"group_audit": _log(state, "Journey resumed"), "group_error": None,
                              "group_blocking_actions": [], "group_outcome": None, "requires_group_intervention": False}
    try:
        scheme = await _snapshot(state)
    except _Stop as stop:
        return {**update, "group_error": f"I couldn't find a group scheme to resume: {stop}",
                "group_blocking_actions": stop.chips or [
                    {"label": "Start a group scheme", "actionType": "submit", "payload": "Start a group scheme"}],
                "group_audit": _log(state, f"Resume found no scheme: {stop}")}
    return {**update, **_scheme_update(scheme)}


# ═══════════════════════════════════════════════════════════════════════════
# Routing + final summary
# ═══════════════════════════════════════════════════════════════════════════

def _route_error(next_node: str):
    def _route(state: ChatState) -> str:
        return "g_finish" if state.get("group_error") else next_node
    return _route


def _route_unless_suspended(next_node: str):
    def _route(state: ChatState) -> str:
        if state.get("group_error") or state.get("requires_group_intervention"):
            return "g_finish"
        return next_node
    return _route


def route_resume(state: ChatState) -> str:
    """Re-enter where the scheme actually is, per the snapshot g_resume just took."""
    if state.get("group_error"):
        return "g_finish"
    scheme = state.get("group_scheme") or {}
    status = scheme.get("status")
    if not scheme or not state.get("group_master_policy_id"):
        return "g_scheme"
    if status == "Active":
        return "g_enroll"
    if status in ("Accepted", "PendingPayment"):
        return "g_issue"
    if status in ("Quoted", "Declined"):
        return "g_acceptance"            # a declined quote waits for a revised one; it is never re-quoted on its own
    if scheme.get("member_count", 0) == 0:
        return "g_benefits"
    if scheme.get("pending_members"):
        return "g_underwrite"
    return "g_quote"                      # Proposed with a clean roster


def _finish_actions(state: ChatState) -> list[dict]:
    """The chips that clear whatever the pipeline stopped on."""
    if state.get("group_blocking_actions"):
        return state["group_blocking_actions"][:5]
    org = state.get("group_organization_name") or ""
    oid = state.get("group_organization_id") or ""
    outcome = state.get("group_outcome")
    scheme = state.get("group_scheme") or {}
    chip = lambda label, text: {"label": label, "actionType": "submit", "payload": text}  # noqa: E731
    nav = lambda label, tab: {"label": label, "actionType": "navigate", "payload": _org_route(oid, tab)}  # noqa: E731
    resume = chip("Resume the scheme", f"Continue the group journey for {org}")

    if outcome == "Census_Needed":
        out = [chip("Upload census file", f"Upload the employee census for {org}, then continue the group journey")]
        if is_demo():
            out.append(chip("Generate demo census", f"Generate a demo census for {org}, then continue the group journey"))
        if not scheme.get("classes"):
            out.append(chip("Add benefit classes", f"Add benefit classes to the group scheme for {org}"))
        return [*out, resume]
    if outcome == "Underwriting_Pending":
        return [nav("Review undecided members", "members"), chip("Check again", f"Continue the group journey for {org}")]
    if outcome == "Awaiting_Acceptance":
        return [chip("Accept quote", f"Accept the group quote for {org}"),
                chip("Revise quote", f"Generate a revised group quote for {org}"),
                chip("Decline quote", f"Decline the group quote for {org}"),
                nav("Open quote", "quote")]
    if outcome == "Awaiting_Payment":
        return [chip("Record payment", f"Record the group payment for {org}"), nav("Open scheme", "scheme"), resume]
    if outcome == "Declined":
        return [chip("Generate revised quote", f"Generate a revised group quote for {org}"), nav("Open scheme", "scheme")]
    if outcome == "Completed":
        return [nav("View members", "members"), nav("Open scheme", "scheme"),
                chip("Start another scheme", "Start a group scheme")]
    return [nav("Open scheme", "scheme") if oid else {"label": "Organizations", "actionType": "navigate", "payload": "admin/organizations"}]


def _finish_message(state: ChatState) -> str:
    outcome = state.get("group_outcome")
    scheme = state.get("group_scheme") or {}
    org = state.get("group_organization_name") or "the employer"
    btype = state.get("group_business_type") or scheme.get("business_type") or "Conventional"
    word = _word(btype)
    quote = state.get("group_quote") or scheme.get("quote") or {}

    if outcome == "Census_Needed":
        errors = state.get("group_census_errors") or []
        classes = scheme.get("classes") or []
        return (
            f"Group scheme for **{org}** is set up and waiting for the **employee census**."
            + (f"\nThe last census was rejected: {'; '.join(errors[:4])}" if errors else "")
            + f"\nBenefit classes: {', '.join(classes) if classes else 'none defined — everyone is covered at the scheme multiple. Add classes first if you want different cover.'}"
            + "\nUpload a CSV or Excel file (cnic, name, dob, gender, occupation, declared_income, plus optional employee_id, grade, benefit_class, joining_date)."
        )
    if outcome == "Underwriting_Pending":
        pending = state.get("group_pending_members") or []
        return (
            f"Journey paused — **{len(pending)}** member(s) of **{org}** are above the Free Cover Limit and need an underwriting "
            f"decision before the scheme can be priced: {', '.join(pending[:6])}{'…' if len(pending) > 6 else ''}."
        )
    if outcome == "Awaiting_Acceptance":
        extra = (f"\nWakala fee ({quote.get('wakala_fee_pct'):g}%): {_pkr(quote.get('wakala_fee'))} · Participants' Takaful Fund: {_pkr(quote.get('ptf_allocation'))}"
                 if quote.get("wakala_fee_pct") is not None else "")
        return (
            f"The quote for **{org}** is ready and waiting for the **employer's decision**.\n"
            f"- {quote.get('member_count', scheme.get('member_count', 0))} members · total sum assured {_pkr(quote.get('total_sum_assured'))}\n"
            f"- **Annual {word}: {_pkr(quote.get('total_premium'))}** (valid until {quote.get('valid_until')}){extra}\n"
            "Accept, revise or decline once the employer has answered — I won't accept it for them."
        )
    if outcome == "Awaiting_Payment":
        return (
            f"Master policy **{scheme.get('policy_number')}** is issued for **{org}**. Cover starts when the employer's "
            f"{word} of **{_pkr((scheme.get('accepted_quote') or quote).get('total_premium'))}** is recorded — give me the bank reference."
        )
    if outcome == "Declined":
        return f"The employer declined the quote for **{org}**. You can generate a revised quote whenever they're ready."
    missing = state.get("group_missing_nominations") or []
    return (
        f"Group scheme for **{org}** is complete — master policy **{scheme.get('policy_number')}**, "
        f"**{scheme.get('member_count', 0)}** members covered for {_pkr(scheme.get('total_cover'))} ({btype})."
        + (f"\n{len(missing)} member(s) have no nominee yet — add them from the Members tab." if missing else "")
    )


async def g_finish(state: ChatState) -> dict:
    """Answer the launching tool_call with one consolidated ToolMessage —
    outcome, audit trail, navigation and the exact next-step chips."""
    call = state.get("pending_call") or {}
    error = state.get("group_error")
    outcome = state.get("group_outcome")
    org_id = state.get("group_organization_id")
    tab = {"Census_Needed": "members", "Underwriting_Pending": "members", "Awaiting_Acceptance": "quote",
           "Awaiting_Payment": "scheme", "Declined": "quote"}.get(outcome or "", "scheme")
    route = _org_route(org_id, tab) if org_id else "admin/organizations"

    result: dict[str, Any] = {
        "audit_trail": state.get("group_audit", []),
        "organization": state.get("group_organization_name"),
        "outcome": outcome,
    }
    if error:
        result.update({"success": False, "error": error})
    else:
        result.update({"success": True, "message": _finish_message(state)})
    result["quick_actions"] = _finish_actions(state)

    if org_id:
        result["last_action"] = {
            "tool_name": "group_journey", "entity_type": "organization", "entity_id": org_id, "route": route,
            "label": f"Group scheme: {outcome or ('error' if error else 'done')} ({state.get('group_organization_name')})",
        }
        # No "navigate" here: the frontend opens that in a new browser tab. The individual and family journeys stay
        # in the chat, and the "Open scheme" button in quick_actions is how a user chooses to leave it.

    return {
        "messages": [ToolMessage(
            content=json.dumps(result, default=str),
            tool_call_id=call.get("id", ""),
            name=call.get("name", "start_group_journey"),
        )],
        "pending_call": None,
    }


def register_group_journey(builder) -> None:
    """Attach all group-journey nodes and edges to the main StateGraph builder."""
    for node_name, fn in [
        ("g_scheme", g_scheme), ("g_benefits", g_benefits), ("g_census", g_census),
        ("g_underwrite", g_underwrite), ("g_quote", g_quote), ("g_acceptance", g_acceptance),
        ("g_issue", g_issue), ("g_enroll", g_enroll), ("g_resume", g_resume), ("g_finish", g_finish),
    ]:
        builder.add_node(node_name, fn)

    builder.add_conditional_edges("g_scheme", _route_error("g_benefits"), {"g_benefits": "g_benefits", "g_finish": "g_finish"})
    builder.add_conditional_edges("g_benefits", _route_error("g_census"), {"g_census": "g_census", "g_finish": "g_finish"})
    builder.add_conditional_edges("g_census", _route_unless_suspended("g_underwrite"),
                                  {"g_underwrite": "g_underwrite", "g_finish": "g_finish"})
    builder.add_conditional_edges("g_underwrite", _route_unless_suspended("g_quote"),
                                  {"g_quote": "g_quote", "g_finish": "g_finish"})
    builder.add_conditional_edges("g_quote", _route_unless_suspended("g_acceptance"),
                                  {"g_acceptance": "g_acceptance", "g_finish": "g_finish"})
    builder.add_conditional_edges("g_acceptance", _route_unless_suspended("g_issue"),
                                  {"g_issue": "g_issue", "g_finish": "g_finish"})
    builder.add_conditional_edges("g_issue", _route_unless_suspended("g_enroll"),
                                  {"g_enroll": "g_enroll", "g_finish": "g_finish"})
    builder.add_edge("g_enroll", "g_finish")
    builder.add_conditional_edges(
        "g_resume", route_resume,
        {"g_scheme": "g_scheme", "g_benefits": "g_benefits", "g_underwrite": "g_underwrite", "g_quote": "g_quote",
         "g_acceptance": "g_acceptance", "g_issue": "g_issue", "g_enroll": "g_enroll", "g_finish": "g_finish"},
    )
    builder.add_edge("g_finish", "agent")
