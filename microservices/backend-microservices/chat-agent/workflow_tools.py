"""Exceptions, member journeys and operational views
(microservices/frontend-microservices/docs/agent-scenarios/chatbot-maturity-roadmap.md, P2 and the optional tools).

  resolve_insurance_record      one canonical record across every type, or a choice
  preview_application_transition what a status change would do, before doing it
  request_additional_evidence   route an incomplete underwriting result back for evidence
  refer_underwriting_review     route a disputed result to a reviewer, never past the gates
  get_member_workflow_matrix    per-member state of a family / corporate application
  resume_member_workflow        run the next step for ONE member only
  get_claim_blockers            why a claim is waiting, and the next legal move
  get_work_queue                scoped queues with owners, aging and deadlines
  get_workflow_timeline         a record's traceable history

State comes from lifecycle.application_state — the same derivation
get_case_details uses — so these views never disagree with the rest of the chat.
Registered by being imported at the foot of tool_executor.py.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from lifecycle import application_state, approval_blockers, transition_problem
from permission import is_role_allowed
from tool_executor import (
    _RECORD_SOURCES, ChoiceNeeded, Ctx, _action, _candidates, _case_id, _claim_actions, _claim_docs_missing,
    _claim_ref, _claim_status, _claims, _entity, _fetch_records, _resolve_case, _resolve_claim, _search_all,
    execute_tool, handles,
)
from evidence_tools import resolve_application


def _chips(actions: list[dict], n: int = 4) -> list[dict]:
    return [{k: a[k] for k in ("label", "actionType", "payload")} for a in actions[:n]]


def _age_days(iso: Any) -> Optional[int]:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - dt).days


def _past(deadline: Any) -> bool:
    """A deadline that has passed. No deadline is never overdue."""
    days = _age_days(deadline)
    return days is not None and days >= 0 and str(deadline) < datetime.now(timezone.utc).isoformat()


async def _comment(ctx: Ctx, case_id: str, text: str) -> None:
    try:
        await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/comments"),
                              json={"commentText": text, "commentType": "Internal", "visibilityLevel": "Team"})
    except httpx.HTTPError:
        pass


# ═══════════════════════════════════════════════════════════════════════════
# Records & transitions
# ═══════════════════════════════════════════════════════════════════════════

@handles("resolve_insurance_record")
async def _resolve_insurance_record(args: dict, ctx: Ctx) -> dict:
    ident = (args.get("identifier") or "").strip()
    if not ident:
        raise LookupError("What should I look up? Give a reference, CNIC or name.")
    kind = args.get("record_type")
    if kind:
        if kind not in _RECORD_SOURCES:
            raise LookupError(f"Unknown record type {kind}.")
        try:
            rows = await _fetch_records(kind, ctx)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in (401, 403):
                return {"success": False, "error_code": "forbidden", "retryable": False,
                        "error": f"You don't have access to {kind} records."}
            return {"success": False, "error_code": "service_unavailable", "retryable": True,
                    "error": f"{kind.title()} records can't be read right now — I can't tell whether it exists."}
        found = [{"type": kind, **_entity(kind, r, ctx.tenant_id)} for r in _candidates(kind, rows, ident)]
        unavailable: list[str] = []
    else:
        unavailable = []
        hits = await _search_all(ctx, ident, list(_RECORD_SOURCES), unavailable)
        found = [{"type": h["type"], "id": None, "tenant_id": ctx.tenant_id, "reference": h["id"], "label": h["label"]}
                 for h in hits]
    if len(found) == 1:
        return {"success": True, "entity": found[0], "result": {"status": "completed", "match": "unique"},
                "message": f"That is **{found[0]['label']}** ({found[0]['type']})."}
    if len(found) > 1:
        raise ChoiceNeeded(f'{len(found)} records match "{ident}". Which one do you mean?',
                           [{"label": f"{f['type']}: {f['label']}"[:70], "actionType": "submit",
                             "payload": f"Use the {f['type']} {f['reference']}"} for f in found[:6]])
    if unavailable:
        return {"success": False, "error_code": "service_unavailable", "retryable": True, "unavailable_types": unavailable,
                "error": f'Nothing matched "{ident}", but {", ".join(unavailable)} could not be searched — it may still exist.'}
    return {"success": True, "entity": None, "result": {"status": "completed", "match": "none"},
            "message": f'No record matches "{ident}" in anything you can access.'}


@handles("preview_application_transition")
async def _preview_application_transition(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    no, target = case.get("caseNumber"), args.get("target_status")
    state = application_state(case)
    if not target:
        return {"success": True, "state": state,
                "message": f"**{no}** is **{state['case_status']}** ({state['stage']}). It can move to: "
                           f"{', '.join(state['allowed_statuses']) or 'nothing — it is final'}.",
                "quick_actions": _chips(state["allowed_actions"])}
    problem = transition_problem(state["case_status"], target)
    if not problem and target == "Approved":
        blockers = approval_blockers(case)
        problem = f"approval is blocked: {'; '.join(blockers)}" if blockers else None
    effect = {"Approved": "the proposal is approved and moves to Policy Issuance",
              "Rejected": "the proposal is declined",
              "Closed": "the application is closed — nothing further can happen on it",
              "Pending Documents": "the application waits for the missing documents",
              "Under Review": "the application waits for an underwriter's review",
              "InProgress": "the application is back in active processing"}.get(target, "")
    return {"success": True, "state": state,
            "result": {"status": "preview", "allowed": problem is None, "target_status": target, "problem": problem},
            "message": (f"**{no}**: {state['case_status']} → {target} " + ("is allowed — " + effect + "." if not problem else
                        f"is **not** allowed: {problem}") + " (nothing has changed)"),
            "quick_actions": [] if problem else [{"label": f"Move to {target}", "actionType": "submit",
                                                  "payload": f"Set case {no} status to {target}"}]}


# ═══════════════════════════════════════════════════════════════════════════
# Underwriting exceptions — routed, never bypassed
# ═══════════════════════════════════════════════════════════════════════════

@handles("request_additional_evidence")
async def _request_additional_evidence(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id, no = _case_id(case), case.get("caseNumber")
    evidence = [e.strip() for e in (args.get("evidence") or []) if str(e).strip()]
    if not evidence:
        return {"success": False, "error_code": "validation", "needs_user_input": True, "retryable": False,
                "error": "Which evidence is needed (e.g. 'Latest bank statement', 'ECG')?"}
    current = case.get("caseStatus") or "New"
    moved = False
    if current != "Pending Documents":
        problem = transition_problem(current, "Pending Documents")
        if problem:
            return {"success": False, "error_code": "illegal_transition", "retryable": False, "error": problem}
        res = await ctx.client.patch(ctx.tsvc(f"/cases/{case_id}/status"), json={"status": "Pending Documents"})
        res.raise_for_status()
        moved = True
    await _comment(ctx, case_id, "ADDITIONAL EVIDENCE REQUESTED\n" + "\n".join(f"- {e}" for e in evidence)
                   + (f"\nReason: {args['reason']}" if args.get("reason") else ""))
    return {"success": True, "entity": {"type": "application", "id": case_id, "tenant_id": ctx.tenant_id, "reference": no},
            "result": {"status": "completed", "evidence": evidence, "status_changed": moved},
            "message": f"**{no}** {'moved to Pending Documents' if moved else 'is already waiting for documents'}; requested: "
                       + ", ".join(evidence) + ". The decision stays open until the evidence is reviewed.",
            "last_action": _action("request_additional_evidence", "case", case_id, "cases", "Evidence requested"),
            "quick_actions": [{"label": "Ask the Customer", "actionType": "submit",
                               "payload": f"Ask the customer for the missing documents for application {no}"}]}


@handles("refer_underwriting_review")
async def _refer_underwriting_review(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id, no = _case_id(case), case.get("caseNumber")
    reason = (args.get("reason") or "").strip()
    if len(reason) < 10:
        return {"success": False, "error_code": "validation", "needs_user_input": True, "retryable": False,
                "error": "Give the reason for the referral (what is disputed or incomplete) in a sentence."}
    current = case.get("caseStatus") or "New"
    moved = False
    if current != "Under Review":
        problem = transition_problem(current, "Under Review")
        if problem:
            return {"success": False, "error_code": "illegal_transition", "retryable": False, "error": problem}
        res = await ctx.client.patch(ctx.tsvc(f"/cases/{case_id}/status"), json={"status": "Under Review"})
        res.raise_for_status()
        moved = True
    await _comment(ctx, case_id, f"REFERRED FOR UNDERWRITING REVIEW\nReason: {reason}"
                   + (f"\nAI recommendation at referral: {case.get('latest_ai_decision')}" if case.get("latest_ai_decision") else ""))
    owner = "the underwriting queue"
    if args.get("reviewer_name"):
        assigned = await execute_tool("assign_case", {"case_number": no, "assigned_user_name": args["reviewer_name"],
                                                      "assigned_role": "Underwriter"}, ctx.exec_ctx)
        if not assigned.get("success"):
            return {**assigned, "error": f"Referred to the underwriting queue, but could not assign it: {assigned.get('error')}"}
        owner = args["reviewer_name"]
    return {"success": True, "entity": {"type": "application", "id": case_id, "tenant_id": ctx.tenant_id, "reference": no},
            "result": {"status": "completed", "owner": owner, "status_changed": moved},
            "message": f"**{no}** referred to {owner} for review. No decision has been made — the gates and the "
                       "approval still have to be completed by the reviewer.",
            "last_action": _action("refer_underwriting_review", "case", case_id, "cases", "Referred for review")}


# ═══════════════════════════════════════════════════════════════════════════
# Family & corporate members
# ═══════════════════════════════════════════════════════════════════════════

_SHARED = {"acr", "compliance"}   # recorded once for a family, on the head's case


async def _member_cases(args: dict, ctx: Ctx) -> tuple[str, list[dict]]:
    res = await ctx.client.get(ctx.tsvc("/cases"))
    res.raise_for_status()
    cases = res.json()
    group = (args.get("group_name") or "").strip().lower()
    if args.get("case_number") or args.get("cnic"):
        anchor = (await resolve_application(args, ctx))["case"]
        key = ("family_group_id", anchor.get("family_group_id")) if anchor.get("family_group_id") else \
              ("organization_id", anchor.get("organization_id")) if anchor.get("organization_id") else (None, None)
        if not key[0]:
            raise LookupError(f"{anchor.get('caseNumber')} is an individual application, not part of a family or company.")
        label = anchor.get("family_group_name") or "the company"
    elif group:
        fams = {c["family_group_id"]: c.get("family_group_name") for c in cases if c.get("family_group_id")
                and group in (c.get("family_group_name") or "").lower()}
        if len(fams) > 1:
            raise ChoiceNeeded("More than one family matches. Which one?",
                               [{"label": n, "actionType": "submit", "payload": f"Show the member matrix for {n}"}
                                for n in fams.values()])
        if fams:
            key, label = ("family_group_id", next(iter(fams))), next(iter(fams.values()))
        else:
            ores = await ctx.client.get(ctx.tsvc("/organizations"))
            ores.raise_for_status()
            orgs = [o for o in ores.json() if group in (o.get("name") or "").lower()]
            if not orgs:
                raise LookupError(f'No family or company called "{args.get("group_name")}".')
            if len(orgs) > 1:
                raise ChoiceNeeded("More than one company matches. Which one?",
                                   [{"label": o["name"], "actionType": "submit",
                                     "payload": f"Show the member matrix for {o['name']}"} for o in orgs[:6]])
            key, label = ("organization_id", orgs[0]["id"]), orgs[0]["name"]
    else:
        raise LookupError("Which family or company? Give its name or any member's application reference.")
    members = [c for c in cases if c.get(key[0]) == key[1]]
    return label, members


@handles("get_member_workflow_matrix")
async def _get_member_workflow_matrix(args: dict, ctx: Ctx) -> dict:
    label, members = await _member_cases(args, ctx)
    if not members:
        return {"success": True, "members": [], "message": f"No member applications exist for {label} yet."}
    rows, shared_open = [], set()
    for c in members:
        st = application_state(c)
        for g in st["gates"]:
            if g["key"] in _SHARED and not g["done"]:
                shared_open.add(g["label"])
        rows.append({"case_number": c.get("caseNumber"), "case_id": _case_id(c), "member": c.get("customer_name"),
                     "stage": st["stage"], "blockers": [b for b in st["blockers"]],
                     "next": st["next_action"]["label"] if st["next_action"] else None})
    blocked = [r for r in rows if r["blockers"]]
    table = "\n".join(f"| {r['member']} | {r['case_number']} | {r['stage']} | {'; '.join(r['blockers'][:2]) or '—'} |"
                      for r in rows)
    msg = (f"**{label}** — {len(rows)} member application(s), {len(blocked)} blocked.\n\n"
           "| Member | Application | Stage | Blocked by |\n|---|---|---|---|\n" + table)
    if shared_open:
        msg += (f"\n\nShared for the whole family: {', '.join(sorted(shared_open))} — recorded once on the head's case. "
                "Everything else is per member; one member's decision never applies to another.")
    return {"success": True, "members": rows, "state": {"blocked": len(blocked), "total": len(rows)},
            "message": msg,
            "quick_actions": [{"label": f"Resume {r['member']}"[:40], "actionType": "submit",
                               "payload": f"Resume the workflow for member application {r['case_number']}"}
                              for r in blocked[:3]]}


@handles("resume_member_workflow")
async def _resume_member_workflow(args: dict, ctx: Ctx) -> dict:
    """Run the next pending step for ONE member. Pre-underwriting gates run here;
    decisions are never taken on a member's behalf — they are offered instead."""
    case = (await resolve_application(args, ctx))["case"]
    if not (case.get("family_group_id") or case.get("organization_id")):
        raise LookupError(f"{case.get('caseNumber')} is not part of a family or company application.")
    st = application_state(case)
    nxt = st["next_action"]
    if not nxt:
        return {"success": True, "result": {"status": "skipped", "reason": "nothing_pending"},
                "message": f"Nothing is pending for **{case.get('customer_name')}** ({case.get('caseNumber')}) — {st['stage']}."}
    gate = next((g for g in st["gates"] if f"gate:{g['key']}" == nxt["id"]), None)
    if gate is None:
        # Risk assessment, a decision or issuance: offer it rather than taking it for them.
        return {"success": True, "result": {"status": "awaiting_user", "next": nxt["label"]},
                "message": f"**{case.get('customer_name')}** is at {st['stage']}. Next: **{nxt['label']}**.",
                "quick_actions": _chips(st["allowed_actions"])}
    tool = gate["tool"]
    if not is_role_allowed(tool, ctx.exec_ctx.role, ctx.exec_ctx.platform):
        return {"success": False, "error_code": "forbidden", "retryable": False,
                "error": f"The next step for {case.get('customer_name')} ({gate['label']}) isn't one your role can run.",
                "quick_actions": _chips(st["allowed_actions"])}
    result = await execute_tool(tool, {"case_number": case.get("caseNumber")}, ctx.exec_ctx)
    return {**result, "result": {"status": "completed" if result.get("success", True) else "failed",
                                 "member": case.get("customer_name"), "step": gate["label"]},
            "entity": {"type": "application", "id": _case_id(case), "tenant_id": ctx.tenant_id,
                       "reference": case.get("caseNumber"), "label": case.get("customer_name")}}


# ═══════════════════════════════════════════════════════════════════════════
# Claims
# ═══════════════════════════════════════════════════════════════════════════

@handles("get_claim_blockers")
async def _get_claim_blockers(args: dict, ctx: Ctx) -> dict:
    claim = await _resolve_claim(args, ctx)
    status, ref = _claim_status(claim), _claim_ref(claim)
    blockers: list[str] = []
    missing = _claim_docs_missing(claim)
    if missing and status not in ("Approved", "Partial Approval", "Settled", "Closed", "Declined"):
        blockers.append(f"documents missing: {', '.join(missing)}")
    waiting_on = {
        "New": "triage by an adjuster",
        "Triaged": "an adjuster to start the investigation",
        "Pending Documents": "the claimant's documents",
        "Under Investigation": "the adjuster's adjudication",
        "Referred to Manager": "a claims manager's approval (above the adjuster's limit)",
        "Re-Underwriting Required": "an underwriter's re-underwriting verdict (contestability / non-disclosure)",
        "Approved": "the payout to be disbursed",
        "Partial Approval": "the payout to be disbursed",
        "Reinsurance Referred": "the reinsurer's recovery",
    }.get(status)
    if waiting_on:
        blockers.append(f"waiting for {waiting_on}")
    if claim.get("is_contestable") and status == "Under Investigation":
        blockers.append("inside the contestability period — an underwriting referral may be required")
    paid = status in ("Settled", "Closed") and claim.get("paid_amount")
    msg = (f"Claim **{ref}** is **{status}**."
           + ("".join(f"\n- {b}" for b in blockers) if blockers else "\nNothing is blocking it.")
           + (f"\nPaid: PKR {float(claim['paid_amount']):,.0f}." if paid else ""))
    return {"success": True,
            "entity": {"type": "claim", "id": claim.get("id"), "tenant_id": ctx.tenant_id, "reference": ref},
            "state": {"status": status, "blockers": blockers, "missing_documents": missing},
            "message": msg, "quick_actions": _claim_actions(claim)[:4]}


# ═══════════════════════════════════════════════════════════════════════════
# Queues & timelines
# ═══════════════════════════════════════════════════════════════════════════

_OPEN_CLAIM = {"New", "Triaged", "Pending Documents", "Under Investigation", "Referred to Manager",
               "Re-Underwriting Required", "Approved", "Partial Approval", "Reinsurance Referred"}


async def _queue_applications(ctx: Ctx, mine: bool) -> list[dict]:
    res = await ctx.client.get(ctx.tsvc("/cases"))
    res.raise_for_status()
    me = None
    if mine:
        who = await ctx.client.get(ctx.gateway("/auth/me"))
        who.raise_for_status()   # never fall back to everyone's queue when "mine" was asked
        me = who.json().get("id")
    out = []
    for c in res.json():
        if c.get("caseStatus") in ("Closed", "Rejected"):
            continue
        if mine and str(c.get("assignedAgentId")) != str(me):
            continue
        st = application_state(c)
        out.append({"queue": "applications", "reference": c.get("caseNumber"), "label": c.get("customer_name"),
                    "status": st["stage"], "owner": "assigned" if c.get("assignedAgentId") else "unassigned",
                    "age_days": _age_days(c.get("createdAt")), "deadline": c.get("slaDeadline"),
                    "overdue": _past(c.get("slaDeadline")),
                    "blocker": st["blockers"][0] if st["blockers"] else None})
    return out


async def _queue_claims(ctx: Ctx, payouts_only: bool) -> list[dict]:
    res = await ctx.client.get(_claims(ctx))
    res.raise_for_status()
    rows = res.json()
    rows = rows if isinstance(rows, list) else rows.get("items", [])
    out = []
    for c in rows:
        st = _claim_status(c)
        if st not in _OPEN_CLAIM or (payouts_only and st not in ("Approved", "Partial Approval")):
            continue
        out.append({"queue": "claim_payouts" if payouts_only else "claims", "reference": _claim_ref(c),
                    "label": c.get("claimant_name"), "status": st, "owner": c.get("assigned_to_name") or c.get("adjuster_name"),
                    "age_days": _age_days(c.get("updated_at") or c.get("created_at")), "deadline": c.get("sla_due_at"),
                    "overdue": _past(c.get("sla_due_at")),
                    "amount": c.get("approved_amount") if payouts_only else c.get("submitted_amount")})
    return out


async def _queue_requests(ctx: Ctx) -> list[dict]:
    res = await ctx.client.get(ctx.gateway("/request-management/v1/requests"), params={"scope": "review", "page_size": 50})
    if res.status_code >= 400:
        raise httpx.HTTPStatusError("requests", request=res.request, response=res)
    return [{"queue": "service_requests", "reference": r.get("reference_no"), "label": r.get("title"),
             "status": r.get("review_status"), "owner": r.get("assignee_name") or f"{r.get('queue_role')} queue",
             "age_days": _age_days(r.get("submitted_at") or r.get("created_at")), "deadline": r.get("due_at"),
             "overdue": r.get("overdue")} for r in res.json().get("items") or []]


async def _queue_tickets(ctx: Ctx) -> list[dict]:
    res = await ctx.client.get(ctx.gateway("/customer-service/v1/tickets"), params={"page_size": 50})
    if res.status_code >= 400:
        raise httpx.HTTPStatusError("tickets", request=res.request, response=res)
    return [{"queue": "tickets", "reference": f"T-{str(t.get('id'))[:8].upper()}", "label": t.get("title"),
             "status": t.get("status"), "owner": t.get("assignee_name") or "unassigned",
             "age_days": _age_days(t.get("created_at")), "deadline": t.get("due_at"), "overdue": t.get("overdue")}
            for t in res.json().get("items") or [] if t.get("status") not in ("RESOLVED", "CLOSED", "CANCELLED")]


@handles("get_work_queue")
async def _get_work_queue(args: dict, ctx: Ctx) -> dict:
    queue = args.get("queue") or "all"
    jobs = {
        "applications": lambda: _queue_applications(ctx, bool(args.get("mine"))),
        "claims": lambda: _queue_claims(ctx, False),
        "claim_payouts": lambda: _queue_claims(ctx, True),
        "service_requests": lambda: _queue_requests(ctx),
        "tickets": lambda: _queue_tickets(ctx),
    }
    names = list(jobs) if queue == "all" else [queue]
    if any(n not in jobs for n in names):
        raise LookupError(f"queue must be one of: all, {', '.join(jobs)}.")
    results = await asyncio.gather(*(jobs[n]() for n in names), return_exceptions=True)
    items, unavailable = [], []
    for name, res in zip(names, results):
        if isinstance(res, Exception):
            unavailable.append(name)
        else:
            items += res
    min_age = int(args.get("older_than_days") or 0)
    items = [i for i in items if (i.get("age_days") or 0) >= min_age]
    items.sort(key=lambda i: (not i.get("overdue"), -(i.get("age_days") or 0)))
    lines = "\n".join(f"| {i['queue'].replace('_', ' ')} | {i['reference']} | {i.get('label') or '—'} | {i['status']} | "
                      f"{i.get('owner') or '—'} | {i.get('age_days') if i.get('age_days') is not None else '—'} days open | "
                      f"{'⚠️ yes' if i.get('overdue') else 'no'} |" for i in items[:25])
    overdue = sum(1 for i in items if i.get("overdue"))
    msg = (f"{len(items)} open item(s)" + (f" older than {min_age} days" if min_age else "")
           + f"; **{overdue} past their deadline**. \"Open\" is time since creation, not lateness."
           + ("\n\n| Queue | Reference | Subject | Status | Owner | Open for | Overdue |\n|---|---|---|---|---|---|---|\n"
              + lines if items else "")
           + (f"\n\n⚠️ Couldn't read: {', '.join(unavailable)} (unavailable or not permitted for your role) — "
              "those items are not included." if unavailable else ""))
    return {"success": True, "items": items, "overdue_count": overdue, "unavailable_queues": unavailable, "message": msg}


@handles("get_workflow_timeline")
async def _get_workflow_timeline(args: dict, ctx: Ctx) -> dict:
    events: list[dict] = []
    title = ""
    if args.get("request_reference"):
        from service_desk_tools import resolve_request
        r = await resolve_request(args, ctx)
        tl = await ctx.client.get(ctx.gateway(f"/request-management/v1/requests/{r['id']}/timeline"))
        tl.raise_for_status()
        title = f"Service request {r.get('reference_no')}"
        events = [{"at": e.get("created_at"), "event": e.get("event_type"), "by": e.get("actor_name"),
                   "detail": e.get("reason")} for e in tl.json()]
    elif args.get("claim_number"):
        claim = await _resolve_claim(args, ctx)
        title = f"Claim {_claim_ref(claim)}"
        events = [{"at": e.get("created_at") or e.get("at"), "event": e.get("event_type") or e.get("action") or e.get("status"),
                   "by": e.get("actor_name") or e.get("actor"), "detail": e.get("note") or e.get("detail")}
                  for e in claim.get("timeline") or claim.get("history") or claim.get("events") or []]
    else:
        policy_id = None
        if args.get("policy_number"):
            from servicing_tools import resolve_policy
            p = await resolve_policy(args, ctx)
            policy_id, title = p["id"], f"Policy {p.get('policy_number')}"
        else:
            case = await _resolve_case(args, ctx)
            policy_id, title = case.get("policy_id"), f"Application {case.get('caseNumber')}"
            if not policy_id:
                return {"success": True, "events": [], "message": f"{title} has no proposal yet, so there is no history to show."}
        res = await ctx.client.get(ctx.tsvc(f"/policies/{policy_id}/events"))
        res.raise_for_status()
        events = [{"at": e.get("created_at"), "event": e.get("event_type"),
                   "by": e.get("actor_name") or e.get("actor"),
                   "detail": (f"{e.get('from_status')} → {e.get('to_status')}" if e.get("to_status") else None)}
                  for e in res.json()]
    if not events:
        return {"success": True, "events": [], "message": f"No recorded history for {title}."}
    events.sort(key=lambda e: str(e.get("at") or ""))
    shown = events[-int(args.get("limit") or 15):]
    lines = "\n".join(f"- {str(e['at'])[:16].replace('T', ' ')} — **{e['event']}**"
                      + (f" by {e['by']}" if e.get("by") else "") + (f" ({e['detail']})" if e.get("detail") else "")
                      for e in shown)
    return {"success": True, "events": events, "message": f"{title} — {len(events)} event(s), latest {len(shown)}:\n{lines}"}
