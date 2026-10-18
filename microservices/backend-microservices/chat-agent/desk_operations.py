"""Desk work outside the policy lifecycle: walk-in lead acknowledgement and
routing, the agent's ACR request inbox, the delegated claims authority matrix,
and branch records.

Backed by tenant-service walk_in_leads.py, agent_confidential_report.py,
claims.py (/claims/authority) and branches.py. Registered by being imported at
the foot of tool_executor.py.
"""
from __future__ import annotations

from typing import Optional

from role_operations import operation
from tool_executor import TENANT_SERVICE_URL, ChoiceNeeded, Ctx, _action, _users_with_roles


def _pkr(value) -> str:
    if value is None:
        return "no ceiling"
    try:
        return f"PKR {float(value):,.0f}"
    except (TypeError, ValueError):
        return "—"


def _chip(label: str, payload: str) -> dict:
    return {"label": label, "actionType": "submit", "payload": payload}


async def _read(ctx: Ctx, path: str, **params):
    res = await ctx.client.get(ctx.tsvc(path), params=params or None)
    res.raise_for_status()
    return res.json()


# ── Walk-in leads ────────────────────────────────────────────────────────────

def _lead_line(r: dict) -> str:
    state = ("⚠️ escalated" + (f" ({r['escalation_reason']})" if r.get("escalation_reason") else "") if r.get("escalated") else
             "❌ acknowledgement overdue" if r.get("overdue") else
             f"⏳ acknowledge by {str(r.get('ack_due_at'))[:16].replace('T', ' ')}" if r.get("awaiting_acknowledgement") else
             r.get("routing_status") or "—")
    return (f"- **{r.get('reference')}** — {r.get('customer_name') or '—'}, {r.get('plan_label') or r.get('applicant_type') or ''}"
            f" ({r.get('city') or '—'}); {r.get('assigned_agent_name') or 'unassigned'} · {state}")


@operation("list_walk_in_leads")
async def _list_walk_in_leads(a, ctx: Ctx) -> dict:
    rows = await _read(ctx, "/walk-in-leads", queue=a.queue)
    if not rows:
        return {"success": True, "leads": [], "message": f"No walk-in leads in the {a.queue} queue."}
    chips = [_chip(f"Acknowledge {r['reference']}", f"Acknowledge walk-in lead {r['reference']}")
             for r in rows if r.get("awaiting_acknowledgement")][:3]
    return {"success": True, "leads": rows, "quick_actions": chips,
            "message": f"{len(rows)} walk-in lead(s) — {a.queue}:\n" + "\n".join(_lead_line(r) for r in rows[:20])}


async def _lead(a, ctx: Ctx) -> dict:
    rows = await _read(ctx, "/walk-in-leads", queue="all")
    needle = a.lead_reference.strip().casefold()
    exact = [r for r in rows if (r.get("reference") or "").casefold() == needle]
    found = exact or [r for r in rows if needle in (r.get("customer_name") or "").casefold()]
    if not found:
        raise LookupError(f'No walk-in lead "{a.lead_reference}" is visible to you. No other lead was used.')
    if len(found) > 1:
        raise ChoiceNeeded(f'{len(found)} walk-in leads match "{a.lead_reference}". Which one?',
                           [_chip(f"{r['reference']} — {r.get('customer_name')}", f"Use walk-in lead {r['reference']}") for r in found[:6]])
    return found[0]


@operation("acknowledge_walk_in_lead")
async def _acknowledge_walk_in_lead(a, ctx: Ctx) -> dict:
    lead = await _lead(a, ctx)
    if lead.get("acknowledged_at"):
        return {"success": True, "result": {"status": "skipped", "reason": "already_acknowledged"},
                "message": f"{lead['reference']} was already acknowledged {str(lead['acknowledged_at'])[:10]}."}
    res = await ctx.client.post(ctx.tsvc(f"/walk-in-leads/{lead['id']}/acknowledge"))
    res.raise_for_status()
    row = res.json()
    return {"success": True, "lead": row, "message": f"Acknowledged **{row.get('reference')}** ({row.get('customer_name')}). "
            "Contact the customer next.",
            "last_action": _action("acknowledge_walk_in_lead", "lead", lead["id"], "admin/leads", "Walk-in lead acknowledged")}


@operation("reassign_walk_in_lead")
async def _reassign_walk_in_lead(a, ctx: Ctx) -> dict:
    lead = await _lead(a, ctx)
    agents = [u for u in await _users_with_roles(ctx) if u.get("role_name") == "Agent" and u.get("is_active", True)]
    needle = a.agent_name.strip().casefold()
    match = [u for u in agents if needle in (u.get("full_name") or "").casefold()]
    if len(match) != 1:
        raise ChoiceNeeded(f'Which agent should take {lead["reference"]}?' if match else f'No active agent matches "{a.agent_name}".',
                           [_chip(u.get("full_name"), f"Reassign walk-in lead {lead['reference']} to {u.get('full_name')}")
                            for u in (match or agents)[:6]])
    if lead.get("assigned_agent_id") == match[0]["id"]:
        return {"success": True, "result": {"status": "skipped", "reason": "already_assigned"},
                "message": f"{lead['reference']} is already with {match[0].get('full_name')}."}
    res = await ctx.client.post(ctx.tsvc(f"/walk-in-leads/{lead['id']}/reassign"), json={"agent_id": match[0]["id"]})
    res.raise_for_status()
    row = res.json()
    return {"success": True, "lead": row, "message": f"**{row.get('reference')}** reassigned to {row.get('assigned_agent_name')}; "
            f"they have been notified and must acknowledge by {str(row.get('ack_due_at'))[:16].replace('T', ' ')}.",
            "last_action": _action("reassign_walk_in_lead", "lead", lead["id"], "admin/leads", "Walk-in lead reassigned")}


# ── ACR requests ─────────────────────────────────────────────────────────────

@operation("list_my_acr_requests")
async def _list_my_acr_requests(a, ctx: Ctx) -> dict:
    rows = await _read(ctx, "/acr-requests", include_submitted=str(a.include_submitted).lower())
    if not rows:
        return {"success": True, "requests": [], "message": "No agent confidential reports are waiting on you."}
    lines = "\n".join(f"- **{r.get('case_number')}** — {r.get('applicant_name') or '—'}"
                      + (f" ({r['group_name']})" if r.get("group_name") else "")
                      + f": {r.get('status')}, asked by {r.get('requested_by_name') or '—'} on {str(r.get('requested_at'))[:10]}"
                      for r in rows[:20])
    chips = [_chip(f"File ACR — {r['case_number']}", f"Submit the agent confidential report for case {r['case_number']}")
             for r in rows if r.get("status") != "Submitted" and r.get("case_number")][:3]
    return {"success": True, "requests": rows, "quick_actions": chips,
            "message": f"{len(rows)} confidential report request(s):\n{lines}"}


# ── Claims authority ─────────────────────────────────────────────────────────

def _authority_lines(view: dict) -> str:
    return "\n".join(f"- **{r['role_name']}**: approves up to {_pkr(r.get('approve_limit'))}, authorises settlement up to "
                     f"{_pkr(r.get('authorize_limit'))}" + (" (default)" if r.get("is_default") else
                                                            f" (set by {r.get('updated_by')})") for r in view.get("limits") or []) \
        + f"\nPayment itself is executed by {view.get('payment_execution_role') or 'Finance'}."


@operation("get_claim_authority_limits")
async def _get_claim_authority_limits(a, ctx: Ctx) -> dict:
    view = await _read(ctx, "/claims/authority")
    return {"success": True, "authority": view, "message": "Delegated claims authority:\n" + _authority_lines(view)}


@operation("set_claim_authority_limit")
async def _set_claim_authority_limit(a, ctx: Ctx) -> dict:
    if a.approve_limit is None and a.authorize_limit is None:
        return {"success": False, "error_code": "missing_details", "needs_user_input": True, "retryable": False,
                "error": f"What should the {a.role_name} approval limit and/or settlement-authorisation limit be (PKR, or unlimited)?"}
    view = await _read(ctx, "/claims/authority")
    current = next((r for r in view.get("limits") or [] if r["role_name"] == a.role_name), {})

    def pick(new, old: Optional[float]):
        return old if new is None else (None if new == "unlimited" else float(new))
    body = {"role_name": a.role_name, "approve_limit": pick(a.approve_limit, current.get("approve_limit")),
            "authorize_limit": pick(a.authorize_limit, current.get("authorize_limit"))}
    if body["approve_limit"] == current.get("approve_limit") and body["authorize_limit"] == current.get("authorize_limit"):
        return {"success": True, "result": {"status": "skipped", "reason": "unchanged"},
                "message": f"{a.role_name} limits are already {_pkr(body['approve_limit'])} / {_pkr(body['authorize_limit'])} — nothing changed."}
    res = await ctx.client.put(ctx.tsvc("/claims/authority"), json=body)
    res.raise_for_status()
    view = res.json()
    return {"success": True, "authority": view, "message": f"Updated {a.role_name} authority. Now:\n" + _authority_lines(view),
            "last_action": _action("set_claim_authority_limit", "claims_authority", a.role_name, "claims", "Claims authority updated")}


# ── Branches ─────────────────────────────────────────────────────────────────

@operation("list_branches")
async def _list_branches(a, ctx: Ctx) -> dict:
    rows = await _read(ctx, "/branches")
    if not rows:
        return {"success": True, "branches": [], "message": "No branches are set up yet."}
    lines = "\n".join(f"- **{b.get('branch_code')}** — {b.get('name')} ({str(b.get('branch_type') or '').replace('_', ' ').title()}, "
                      f"{b.get('city')}{', ' + b['region'] if b.get('region') else ''})" + ("" if b.get("is_active", True) else " · inactive")
                      for b in rows)
    return {"success": True, "branches": rows, "message": f"{len(rows)} branch(es):\n{lines}"}


_BRANCH_FIELDS = ("name", "city", "branch_type", "region", "address", "contact_person", "contact_phone", "contact_email")


@operation("manage_branch")
async def _manage_branch(a, ctx: Ctx) -> dict:
    fields = {k: v for k, v in a.model_dump(include=set(_BRANCH_FIELDS)).items() if v not in (None, "")}
    rows = await _read(ctx, "/branches")
    existing = next((b for b in rows if (b.get("branch_code") or "").casefold() == a.branch_code.strip().casefold()), None)
    if a.action == "create":
        if existing:
            return {"success": False, "error_code": "conflict", "retryable": False,
                    "error": f"Branch {a.branch_code} already exists — update it instead."}
        if not fields.get("name") or not fields.get("city"):
            return {"success": False, "error_code": "missing_details", "needs_user_input": True, "retryable": False,
                    "error": "What is the new branch's name and city?"}
        res = await ctx.client.post(ctx.tsvc("/branches"), json={"branch_code": a.branch_code.strip(), **fields})
    else:
        if not existing:
            raise ChoiceNeeded(f"No branch {a.branch_code}. Which one did you mean?",
                               [_chip(f"{b.get('branch_code')} — {b.get('name')}", f"Update branch {b.get('branch_code')}") for b in rows[:6]])
        if not fields:
            return {"success": False, "error_code": "missing_details", "needs_user_input": True, "retryable": False,
                    "error": f"What should change on branch {existing['branch_code']}?"}
        res = await ctx.client.patch(f"{TENANT_SERVICE_URL}/branches/{existing['id']}", json=fields)
    res.raise_for_status()
    branch = res.json()
    return {"success": True, "branch": branch,
            "message": f"Branch **{branch.get('branch_code')}** — {branch.get('name')} ({branch.get('city')}) "
                       f"{'created' if a.action == 'create' else 'updated'}.",
            "last_action": _action("manage_branch", "branch", str(branch.get("id")), "super-admin/branches", f"Branch {a.action}d")}
