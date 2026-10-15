"""The 7-step claims-management workflow (tenant-service routers/claim_workflow.py).

The older claims tools in tool_executor.py drive the claims REGISTER (/claims):
a status machine plus a payout. This module drives the workflow the claims
portal runs on top of the same Claim record:

  1 intimation      intimate_claim, adopt_claim_into_workflow
  2 eligibility     verify_claim_eligibility, override_claim_eligibility
  3 documents       update_claim_document            (request · waive · reject)
  4 investigation   record_claim_investigation       (finding · complete)
    assessment      assess_claim_benefit
  5 decision        decide_claim
  6 settlement      verify_claim_payees, authorize_claim_disbursement,
                    disburse_claim_settlement, reconcile_claim_settlement
  7 closure         close_claim_file

plus two reads: get_policy_claim_options (what a policy can claim, and was it in
force on a date) and get_claim_workflow (where one claim stands and what's next).

Every write returns the claim's workspace, and the backend enforces each gate
(cover on the event date, documents, red-flag investigation, manager limit,
payee checks, reconciliation) with a readable 4xx that execute_tool relays. So
the handlers here resolve the record, shape the request, and turn the workspace's
`can` flags into the next-step chips — they never re-implement a gate.

Registered by being imported at the foot of tool_executor.py.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import httpx

from tool_executor import ChoiceNeeded, Ctx, _action, _parse_json_arg, _resolve_claim, handles, relay_forbidden

_CATEGORIES = ("Death", "AccidentalDeath", "Disability", "Hospitalization")
_DEATH = ("Death", "AccidentalDeath")


def _pkr(value: Any) -> str:
    try:
        return f"PKR {float(value):,.0f}"
    except (TypeError, ValueError):
        return "—"


def _chip(label: str, payload: str) -> dict:
    return {"label": label, "actionType": "submit", "payload": payload}


def _open_policy(policy_id: str) -> dict:
    return {"label": "Open claims workflow", "actionType": "embed", "payload": f"post-issuance/{policy_id}"}


def _base(ctx: Ctx, policy_id: str, claim_id: Optional[str] = None) -> str:
    path = f"/policies/{policy_id}/claims-management"
    return ctx.tsvc(path + (f"/{claim_id}" if claim_id else ""))


async def _overview(ctx: Ctx, policy_id: str) -> dict:
    res = await ctx.client.get(_base(ctx, policy_id))
    res.raise_for_status()
    return res.json()


async def _claim_and_workspace(args: dict, ctx: Ctx) -> tuple[dict, Optional[dict]]:
    """The register record and its workflow workspace — None when the claim was
    registered outside the workflow and hasn't been adopted yet."""
    claim = await _resolve_claim(args, ctx)
    res = await ctx.client.get(_base(ctx, str(claim["policy_id"]), str(claim["id"])))
    if res.status_code == 409:
        return claim, None
    res.raise_for_status()
    return claim, res.json()


_CAUSES = ("Natural / illness", "Accident", "Suicide", "Other unnatural")
# Register claim types → the workflow benefit they are. The register type was already checked
# against the policy's cover when the claim was registered, so it is not asked again.
_REGISTER_TO_CATEGORY = {"death claim": "Death", "accidental death claim": "AccidentalDeath",
                         "disability claim": "Disability", "hospitalization": "Hospitalization",
                         "surgery": "Hospitalization", "reimbursement": "Hospitalization"}


def category_for(claim: dict) -> Optional[str]:
    return _REGISTER_TO_CATEGORY.get((claim.get("claim_type") or "").strip().lower())


def _not_in_workflow(claim: dict) -> dict:
    ref = claim.get("claim_number") or claim.get("claimant_name")
    category = category_for(claim)
    if category in _DEATH:
        question = (f"{ref} is a {claim.get('claim_type')} that isn't in the claims workflow yet. "
                    "What was the cause of death? It decides which documents are needed.")
        chips = [_chip(c, f"Adopt claim {ref} into the workflow as {category}, cause: {c}") for c in _CAUSES]
    elif category:
        question = f"{ref} isn't in the claims workflow yet — bring it in to run eligibility, the checklist and assessment."
        chips = [_chip("Bring into workflow", f"Adopt claim {ref} into the workflow as {category}")]
    else:
        question = (f"{ref} isn't in the claims workflow yet, and its type ({claim.get('claim_type') or 'unknown'}) "
                    "doesn't say which benefit it is — pick one.")
        chips = [_chip(f"Adopt as {label}", f"Adopt claim {ref} into the workflow as {cat}")
                 for cat, label in (("Death", "death claim"), ("AccidentalDeath", "accidental death"),
                                    ("Disability", "disability"), ("Hospitalization", "hospitalisation"))]
    return {"success": False, "error": question, "error_code": "not_in_workflow", "needs_user_input": True,
            "quick_actions": chips}


async def _post(ctx: Ctx, claim: dict, path: str, body: Optional[dict] = None) -> dict:
    res = await ctx.client.post(_base(ctx, str(claim["policy_id"]), str(claim["id"])) + path, json=body or {})
    res.raise_for_status()
    return res.json()


# ── Rendering a workspace ────────────────────────────────────────────────────

def _current_stage(ws: dict) -> Optional[dict]:
    return next((s for s in ws.get("stages") or [] if s.get("state") not in ("complete", "skipped")), None)


def _summary(ws: dict) -> str:
    c, p = ws["claim"], ws["process"]
    lines = [f"**{c['claim_number']}** — {p.get('category_label') or p.get('category')} · **{c['status']}**",
             f"Claimed {_pkr(c.get('claimed_amount'))}"
             + (f" · approved {_pkr(c['approved_amount'])}" if c.get("approved_amount") else "")
             + f" · event {p['event']['date']}"
             + (f" ({p['event']['cause']})" if p["event"].get("cause") else "")]
    stage = _current_stage(ws)
    lines.append(f"Now at: **{stage['title']} — {stage['label']}**" + (f". {stage['detail']}" if stage.get("detail") else "")
                 if stage else "All seven steps are complete.")

    elig = ws.get("eligibility") or {}
    result = elig.get("result") or {}
    if elig.get("status"):
        line = f"Eligibility: **{elig['status']}**"
        if elig.get("override_by"):
            line += f" (overridden by {elig['override_by']})"
        failed = [ch["detail"] for ch in (result.get("blockers") or []) + (result.get("reviews") or [])]
        if failed:
            line += " — " + "; ".join(failed[:3])
        lines.append(line)

    docs = ws.get("documents") or {}
    prog = docs.get("progress") or {}
    if prog.get("required"):
        outstanding = [d["label"] for d in docs.get("items") or [] if d.get("required") and d.get("status") not in ("Received", "Waived")]
        lines.append(f"Documents: {prog.get('received', 0)}/{prog['required']} required received"
                     + (f" — outstanding: {', '.join(outstanding[:5])}" if outstanding else ""))

    inv = ws.get("investigation") or {}
    high = [f["message"] for f in inv.get("flags") or [] if f.get("severity") == "high"]
    if high:
        state = f"completed ({inv.get('outcome')})" if inv.get("completed_at") else "required"
        lines.append(f"⚠️ Investigation {state}: " + "; ".join(high[:3]))

    assessed = (ws.get("assessment") or {}).get("result") or {}
    if assessed:
        lines.append(f"Assessed benefit payable: **{_pkr(assessed.get('payable'))}**")

    dec = ws.get("decision") or {}
    if dec.get("decision"):
        lines.append(f"Decision: **{dec['decision']}**" + (f" {_pkr(dec['amount'])}" if dec.get("amount") else "")
                     + (f" — {dec['reason']}" if dec.get("reason") else ""))
    elif dec.get("requires_manager"):
        lines.append(f"Above {_pkr(dec.get('manager_limit'))} — the decision needs a claims manager.")

    sla = ws.get("sla") or {}
    if sla.get("state") in ("at_risk", "breached", "on_track"):
        icon = {"breached": "🔴", "at_risk": "🟠", "on_track": "🟢"}[sla["state"]]
        lines.append(f"{icon} SLA {sla['state'].replace('_', ' ')} — {sla.get('message')}")

    st = ws.get("settlement") or {}
    payees = st.get("payees") or []
    if payees:
        lines.append("Payees: " + "; ".join(
            f"{py['name']} {_pkr(py['amount'])} {'✓ verified' if py.get('verified') else '— not verified'}" for py in payees))
    if st.get("paid_total"):
        lines.append(f"Disbursed {_pkr(st['paid_total'])}" + (" · reconciled" if st.get("reconciled_at") else " · not reconciled yet"))
    closure = ws.get("closure") or {}
    if closure.get("outcome"):
        lines.append(f"Closed: **{closure['outcome']}**")
    return "\n".join(lines)


def _actions(ws: dict, policy_id: str) -> list[dict]:
    """One chip per move the workspace says is legal right now."""
    ref = ws["claim"]["claim_number"]
    can = ws.get("can") or {}
    elig = ws.get("eligibility") or {}
    dec = ws.get("decision") or {}
    inv = ws.get("investigation") or {}
    payable = ((ws.get("assessment") or {}).get("result") or {}).get("payable")
    approved = ws["claim"].get("approved_amount")
    out: list[dict] = []
    if can.get("edit_documents"):
        # Upload straight against the checklist item: the browser holds the file, and this
        # payload tells it exactly which claim, policy and item the file is for.
        outstanding = [d for d in (ws.get("documents") or {}).get("items") or []
                       if d.get("required") and d.get("status") not in ("Received", "Waived")]
        for d in outstanding[:2]:
            out.append({"label": f"Upload {d['label'].split(' (')[0]}", "actionType": "upload",
                        "payload": json.dumps({"document_type": d["label"], "checklist_key": d["key"],
                                               "claim_id": ws["claim"]["id"], "claim_number": ref, "policy_id": policy_id})})
    if elig.get("status") == "Ineligible" and not elig.get("override_by") and can.get("verify"):
        out.append(_chip("Re-run eligibility", f"Re-verify eligibility on claim {ref}"))
        out.append(_chip("Override (manager)", f"Override eligibility on claim {ref}"))
    if can.get("investigate") and inv.get("requires_investigation") and not inv.get("completed_at"):
        # The claim card has the investigation form (red flags, findings, outcome) — open it
        # rather than asking the user to type a finding into the chat.
        out.append({"label": "Investigate red flags", "actionType": "claim_documents",
                    "payload": json.dumps({"claim_id": ws["claim"]["id"], "claim_number": ref, "policy_id": policy_id})})
    if can.get("assess"):
        out.append(_chip("Assess the benefit", f"Assess the benefit on claim {ref}"))
    if can.get("decide"):
        if dec.get("requires_manager"):
            out.append(_chip("Refer to manager", f"Decide claim {ref}: Refer to a claims manager"))
        out.append(_chip(f"Approve {_pkr(payable)}" if payable else "Approve", f"Decide claim {ref}: Approve"))
        out.append(_chip("Request information", f"Decide claim {ref}: RequestInfo"))
        out.append(_chip("Reject", f"Decide claim {ref}: Reject"))
    if can.get("verify_payees"):
        out.append(_chip("Verify payees", f"Verify the payees on claim {ref}"))
    if can.get("authorize"):
        out.append(_chip(f"Authorise {_pkr(approved)}", f"Authorise the disbursement on claim {ref}"))
    if can.get("disburse"):
        out.append(_chip(f"Disburse {_pkr(approved)}", f"Disburse the settlement on claim {ref} by Bank Transfer"))
    if can.get("reconcile"):
        out.append(_chip("Reconcile payment", f"Reconcile the settlement on claim {ref}"))
    if can.get("close"):
        out.append(_chip("Close & send letter", f"Close claim file {ref} and send the letter"))
    tail = []
    if (ws.get("documents") or {}).get("items"):
        # Opens the checklist card in the chat: view, replace, send back, request more.
        tail.append({"label": "Manage documents", "actionType": "claim_documents",
                     "payload": json.dumps({"claim_id": ws["claim"]["id"], "claim_number": ref, "policy_id": policy_id})})
    tail.append(_open_policy(policy_id))
    return out[:6 - len(tail)] + tail


def _result(ws: dict, policy_id: str, headline: str, tool: str) -> dict:
    c = ws["claim"]
    return {
        "success": True,
        "message": (headline + "\n\n" if headline else "") + _summary(ws),
        "claim_workflow": ws,
        "last_action": _action(tool, "claim", c["id"], f"post-issuance/{policy_id}", f"{c['claim_number']} · {c['status']}"),
        "quick_actions": _actions(ws, policy_id),
    }


async def _run(args: dict, ctx: Ctx, tool: str, path: str, body: Optional[dict], headline: str) -> dict:
    claim, ws = await _claim_and_workspace(args, ctx)
    if ws is None:
        return _not_in_workflow(claim)
    ws = await _post(ctx, claim, path, body)
    return _result(ws, str(claim["policy_id"]), headline, tool)


# ── Reads ────────────────────────────────────────────────────────────────────

@handles("get_policy_claim_options")
async def _get_policy_claim_options(args: dict, ctx: Ctx) -> dict:
    from servicing_tools import resolve_policy
    policy = await resolve_policy(args, ctx)
    ov = await _overview(ctx, policy["id"])
    pol, cov = ov["policy"], ov["coverage"]
    lines = [f"**{pol['policy_number']}** — {pol.get('customer_name') or '—'} · {pol.get('product_name') or '—'} · "
             f"**{pol['status']}** · sum assured {_pkr(pol.get('sum_assured'))}"]
    if pol.get("nominee_name"):
        lines.append(f"Nominee on record: {pol['nominee_name']} ({pol.get('nominee_relationship') or '—'})")
    periods = cov.get("periods") or []
    if periods:
        lines.append("Cover periods: " + "; ".join(
            f"{p.get('from')} → {p.get('to') or 'open'}" for p in periods[:4]))
    lines.append("In force today: **" + ("yes" if cov.get("in_force_today") else "no") + "**"
                 + (f" — {cov['note']}" if cov.get("note") else ""))
    benefits = ov.get("benefits") or []
    if benefits:
        lines.append("\n**Claimable benefits:**")
        for b in benefits:
            lines.append(f"- {b['label']}: " + (f"{_pkr(b.get('sum_assured'))} ({b.get('source')})" if b.get("available")
                                                 else "not covered"))
    claims = ov.get("claims") or []
    if claims:
        lines.append("\n**Claims on this policy:**")
        for c in claims[:8]:
            lines.append(f"- `{c['claim_number']}` {c.get('category') or c.get('claim_type')} · {_pkr(c.get('claimed_amount'))} · "
                         f"**{c['status']}**" + (f" · {c['stage']}" if c.get("stage") else "")
                         + ("" if c.get("has_workflow") else " · not in workflow")
                         + (f" · SLA {c['sla_state'].replace('_', ' ')}" if c.get("sla_state") in ("at_risk", "breached") else ""))
    rules = ov.get("rules") or {}
    if rules:
        lines.append(f"\nDecision SLA {rules.get('sla_working_days')} working days from complete documents · "
                     f"manager sign-off above {_pkr(rules.get('manager_limit'))} · contestable for {rules.get('contestable_days')} days.")

    qa = [_chip(f"Intimate: {b['label']}",
                f"Intimate a {b['category']} claim on policy {pol['policy_number']}")
          for b in benefits if b.get("available")][:3]
    qa += [_chip(f"Work {c['claim_number']}", f"Show the claim workflow for {c['claim_number']}")
           for c in claims if c.get("status") not in ("Closed",)][:2]
    qa.append(_open_policy(policy["id"]))
    return {"success": True, "message": "\n".join(lines), "claims_overview": ov, "quick_actions": qa[:6]}


@handles("get_claim_workflow")
async def _get_claim_workflow(args: dict, ctx: Ctx) -> dict:
    claim, ws = await _claim_and_workspace(args, ctx)
    if ws is None:
        return _not_in_workflow(claim)
    out = _result(ws, str(claim["policy_id"]), "", "get_claim_workflow")
    out.pop("last_action", None)
    timeline = ws.get("timeline") or []
    if timeline:
        out["message"] += "\n\n**Recent activity:**\n" + "\n".join(
            f"- {t['at'][:16].replace('T', ' ')} · {t['event_type']} by {t.get('actor') or '—'}" for t in timeline[:4])
    return out


# ── Step 1 — intimation ──────────────────────────────────────────────────────

@handles("intimate_claim")
@relay_forbidden
async def _intimate_claim(args: dict, ctx: Ctx) -> dict:
    from servicing_tools import resolve_policy
    policy = await resolve_policy(args, ctx)
    ov = await _overview(ctx, policy["id"])
    number = ov["policy"]["policy_number"]
    category = args.get("category")

    if category not in _CATEGORIES:
        offered = [b for b in ov.get("benefits") or [] if b.get("available")]
        raise ChoiceNeeded(
            f"Which benefit is policy {number} being claimed under?",
            [_chip(b["label"], f"Intimate a {b['category']} claim on policy {number}") for b in offered]
            or [_chip(c, f"Intimate a {c} claim on policy {number}") for c in _CATEGORIES],
        )
    if category in _DEATH and not args.get("cause"):
        causes = (ov.get("options") or {}).get("causes") or []
        raise ChoiceNeeded("What was the cause of death? It decides which documents are needed.",
                           [_chip(c, f"Intimate a {category} claim on policy {number}, cause: {c}") for c in causes])
    missing = [f for f, label in (("event_date", "the event date (YYYY-MM-DD)"), ("claimed_amount", "the amount claimed"))
               if not args.get(f)]
    if category in _DEATH and not args.get("claimant_name"):
        missing.append("claimant_name")
    if missing:
        ask = {"event_date": "the event date (YYYY-MM-DD)", "claimed_amount": "the amount claimed in PKR",
               "claimant_name": "who is claiming (the nominee or legal heir) and their relationship"}
        return {"success": False, "needs_user_input": True, "error_code": "missing_details",
                "error": f"To intimate this claim on {number} I still need " + ", ".join(ask[m] for m in missing) + "."}

    # A repeated click must not open a second claim for the same event.
    same = next((c for c in ov.get("claims") or [] if c.get("has_workflow") and c.get("category") == category
                 and c.get("event_date") == args["event_date"]), None)
    if same:
        claim, ws = await _claim_and_workspace({"claim_number": same["claim_number"]}, ctx)
        if ws is not None:
            return _result(ws, policy["id"], f"A {category} claim for {args['event_date']} is already open on {number}: "
                           f"`{same['claim_number']}`. Nothing new was registered.", "intimate_claim")

    details = (_parse_json_arg(args.get("event_details_json"), "event_details_json") or {})
    for key in ("hospital_name", "diagnosis"):
        if args.get(key):
            details[key] = args[key]
    is_self = not args.get("claimant_name") and category not in _DEATH
    body = {
        "category": category,
        "event_date": args["event_date"],
        "event_end_date": args.get("event_end_date"),
        "cause": args.get("cause"),
        "event_place": args.get("event_place"),
        "event_description": args.get("event_description"),
        "event_details": details,
        "claimed_amount": float(args["claimed_amount"]),
        "claimant_name": args.get("claimant_name") or ov["policy"].get("customer_name") or "",
        "claimant_cnic": args.get("claimant_cnic") or (ov["policy"].get("customer_cnic") if is_self else None),
        "claimant_relationship": args.get("claimant_relationship") or "Self",
        "claimant_phone": args.get("claimant_phone"),
        "claimant_email": args.get("claimant_email"),
        "covered_person_relationship": args.get("covered_person_relationship") or "Self",
        "covered_person_name": args.get("covered_person_name"),
        "channel": args.get("channel") or "Branch",
        "notes": args.get("notes"),
    }
    res = await ctx.client.post(_base(ctx, policy["id"]), json={k: v for k, v in body.items() if v is not None})
    res.raise_for_status()
    ws = res.json()
    elig = (ws.get("eligibility") or {}).get("status")
    return _result(ws, policy["id"], f"Intimated **{ws['claim']['claim_number']}** on {number}. Eligibility was checked "
                   f"against cover on the event date: **{elig}**.", "intimate_claim")


@handles("adopt_claim_into_workflow")
@relay_forbidden
async def _adopt_claim_into_workflow(args: dict, ctx: Ctx) -> dict:
    claim, ws = await _claim_and_workspace(args, ctx)
    ref = claim.get("claim_number")
    if ws is not None:
        return _result(ws, str(claim["policy_id"]), f"{ref} is already in the claims workflow.", "adopt_claim_into_workflow")
    category = args.get("category") if args.get("category") in _CATEGORIES else category_for(claim)
    if category not in _CATEGORIES or (category in _DEATH and not args.get("cause")):
        return _not_in_workflow(claim)
    body = {"category": category, "cause": args.get("cause"),
            "covered_person_relationship": args.get("covered_person_relationship") or "Self"}
    ws = await _post(ctx, claim, "/adopt", {k: v for k, v in body.items() if v is not None})
    return _result(ws, str(claim["policy_id"]), f"Brought {ref} into the claims workflow as a {category} claim. "
                   f"Eligibility: **{(ws.get('eligibility') or {}).get('status')}**.", "adopt_claim_into_workflow")


# ── Step 2 — eligibility ─────────────────────────────────────────────────────

@handles("verify_claim_eligibility")
@relay_forbidden
async def _verify_claim_eligibility(args: dict, ctx: Ctx) -> dict:
    return await _run(args, ctx, "verify_claim_eligibility", "/eligibility/verify", None, "Eligibility re-checked.")


@handles("override_claim_eligibility")
@relay_forbidden
async def _override_claim_eligibility(args: dict, ctx: Ctx) -> dict:
    note = (args.get("note") or "").strip()
    if len(note) < 15:
        return {"success": False, "needs_user_input": True, "error_code": "missing_details",
                "error": "An eligibility override is permanent — give the reason in at least 15 characters "
                         "(e.g. ex-gratia approval, contested cover decision)."}
    return await _run(args, ctx, "override_claim_eligibility", "/eligibility/override", {"note": note},
                      "Eligibility overridden — the checklist is open and the claim can proceed.")


# ── Step 3 — documents ───────────────────────────────────────────────────────

def _find_document(ws: dict, wanted: str) -> Optional[dict]:
    items = (ws.get("documents") or {}).get("items") or []
    needle = wanted.strip().casefold()
    return (next((d for d in items if d["key"].casefold() == needle), None)
            or next((d for d in items if d["label"].casefold() == needle), None)
            or next((d for d in items if needle in d["label"].casefold()), None))


@handles("update_claim_document")
@relay_forbidden
async def _update_claim_document(args: dict, ctx: Ctx) -> dict:
    claim, ws = await _claim_and_workspace(args, ctx)
    if ws is None:
        return _not_in_workflow(claim)
    action, document = args.get("action"), (args.get("document") or "").strip()
    reason = (args.get("reason") or "").strip()
    ref = ws["claim"]["claim_number"]
    if action == "request":
        if not document:
            return {"success": False, "needs_user_input": True, "error_code": "missing_details",
                    "error": "Name the document to request from the claimant."}
        body = {"label": document, "required": args.get("required", True), "reason": reason or None}
        ws = await _post(ctx, claim, "/documents", body)
        return _result(ws, str(claim["policy_id"]), f"Added **{document}** to the checklist on {ref}.", "update_claim_document")

    doc = _find_document(ws, document) if document else None
    if doc is None:
        open_items = [d for d in (ws.get("documents") or {}).get("items") or [] if d.get("status") not in ("Waived",)]
        raise ChoiceNeeded(f"Which document on {ref} should I {action}?",
                           [_chip(d["label"], f"{action.capitalize()} the {d['label']} on claim {ref}") for d in open_items[:6]])
    if not reason:
        return {"success": False, "needs_user_input": True, "error_code": "missing_details",
                "error": f"Say why the {doc['label']} is being {'waived' if action == 'waive' else 'sent back'} — it goes on the claim file."}
    ws = await _post(ctx, claim, f"/documents/{doc['key']}/{action}", {"reason": reason})
    verb = "Waived" if action == "waive" else "Sent back"
    return _result(ws, str(claim["policy_id"]), f"{verb} **{doc['label']}** on {ref}.", "update_claim_document")


# ── Step 4 — investigation & assessment ──────────────────────────────────────

@handles("record_claim_investigation")
@relay_forbidden
async def _record_claim_investigation(args: dict, ctx: Ctx) -> dict:
    note = (args.get("note") or "").strip()
    if args.get("action") == "complete":
        outcome = args.get("outcome")
        if outcome not in ("Verified", "Adverse", "Inconclusive"):
            claim = await _resolve_claim(args, ctx)
            ref = claim.get("claim_number")
            raise ChoiceNeeded("What did the investigation conclude?",
                               [_chip(o, f"Complete the investigation on claim {ref} as {o}") for o in ("Verified", "Adverse", "Inconclusive")])
        return await _run(args, ctx, "record_claim_investigation", "/investigation/complete",
                          {"outcome": outcome, "notes": note or None}, f"Investigation completed: **{outcome}**.")
    if not note:
        return {"success": False, "needs_user_input": True, "error_code": "missing_details",
                "error": "What was found, and from what source (hospital records, NADRA, field visit…)?"}
    body = {"kind": args.get("finding_kind") or "Neutral", "source": args.get("source"), "note": note}
    return await _run(args, ctx, "record_claim_investigation", "/investigation/finding", body, "Finding recorded.")


@handles("assess_claim_benefit")
@relay_forbidden
async def _assess_claim_benefit(args: dict, ctx: Ctx) -> dict:
    deductions = (_parse_json_arg(args.get("deductions_json"), "deductions_json") or [])
    if isinstance(deductions, dict):
        deductions = [deductions]
    body = {"disability_pct": args.get("disability_pct"), "copay_pct": args.get("copay_pct"),
            "deductions": [{"label": str(d.get("label") or "Deduction"), "amount": float(d.get("amount") or 0)} for d in deductions],
            "notes": args.get("notes")}
    claim, ws = await _claim_and_workspace(args, ctx)
    if ws is None:
        return _not_in_workflow(claim)
    if ws["process"]["category"] == "Disability" and body["disability_pct"] is None:
        return {"success": False, "needs_user_input": True, "error_code": "missing_details",
                "error": "A disability benefit is paid on the assessed disability percentage — what is it?"}
    ws = await _post(ctx, claim, "/assessment", {k: v for k, v in body.items() if v is not None})
    a = (ws.get("assessment") or {}).get("result") or {}
    parts = [f"{x['label']} {_pkr(x['amount'])}" for x in a.get("components") or []]
    parts += [f"less {x['label']} {_pkr(x['amount'])}" for x in a.get("deductions") or []]
    head = f"Benefit assessed: **{_pkr(a.get('payable'))} payable**" + (f" ({'; '.join(parts)})" if parts else "") + "."
    return _result(ws, str(claim["policy_id"]), head, "assess_claim_benefit")


# ── Step 5 — decision ────────────────────────────────────────────────────────

@handles("decide_claim")
@relay_forbidden
async def _decide_claim(args: dict, ctx: Ctx) -> dict:
    decision = args.get("decision")
    if decision not in ("Approve", "PartialApprove", "Reject", "RequestInfo", "Refer"):
        claim = await _resolve_claim(args, ctx)
        ref = claim.get("claim_number")
        raise ChoiceNeeded(f"What is the decision on {ref}?",
                           [_chip(label, f"Decide claim {ref}: {d}") for d, label in
                            (("Approve", "Approve"), ("PartialApprove", "Partial approval"), ("Reject", "Reject"),
                             ("RequestInfo", "Request information"), ("Refer", "Refer to manager"))])
    reason = (args.get("reason") or "").strip()
    needs = [x.strip() for x in args.get("information_needed") or [] if x and x.strip()]
    if decision in ("Reject", "PartialApprove", "Refer") and not reason:
        return {"success": False, "needs_user_input": True, "error_code": "missing_details",
                "error": {"Reject": "A rejection needs a written reason — it goes into the claimant's letter.",
                          "PartialApprove": "Say how much to approve and why only part of the benefit is paid.",
                          "Refer": "Say why the claim is being referred to a claims manager."}[decision]}
    if decision == "RequestInfo" and not needs:
        return {"success": False, "needs_user_input": True, "error_code": "missing_details",
                "error": "List the information or documents needed from the claimant."}
    body = {"decision": decision, "amount": args.get("amount"), "reason": reason or None,
            "info_requests": [{"label": n, "reason": reason or None} for n in needs]}
    head = {"Approve": "Approved", "PartialApprove": "Partially approved", "Reject": "Rejected",
            "RequestInfo": "Information requested from the claimant", "Refer": "Referred to a claims manager"}[decision]
    return await _run(args, ctx, "decide_claim", "/decision", {k: v for k, v in body.items() if v is not None}, f"{head}.")


# ── Step 6 — settlement ──────────────────────────────────────────────────────

@handles("verify_claim_payees")
@relay_forbidden
async def _verify_claim_payees(args: dict, ctx: Ctx) -> dict:
    claim, ws = await _claim_and_workspace(args, ctx)
    if ws is None:
        return _not_in_workflow(claim)
    ref = ws["claim"]["claim_number"]
    payees = (ws.get("settlement") or {}).get("payees") or []
    if not payees:
        return {"success": False, "error_code": "conflict",
                "error": f"{ref} has no payees yet — they are derived when the claim is approved."}
    name = (args.get("payee_name") or "").strip().casefold()
    match = [p for p in payees if name and name in (p.get("name") or "").casefold()] if name else payees
    if len(match) != 1:
        raise ChoiceNeeded(f"Which payee on {ref}?", [
            _chip(f"{p['name']} · {_pkr(p['amount'])}", f"Verify payee {p['name']} on claim {ref}") for p in payees])
    payee = match[0]
    update = {"id": payee["id"], "verify": args.get("verify", True)}
    for src, dst in (("cnic", "cnic"), ("bank_name", "bank_name"), ("account_title", "account_title"),
                     ("iban", "iban"), ("identity_verified_by", "method"), ("note", "note")):
        if args.get(src):
            update[dst] = args[src]
    ws = await _post(ctx, claim, "/settlement/payees", {"payees": [update]})
    now = next((p for p in (ws.get("settlement") or {}).get("payees") or [] if p["id"] == payee["id"]), payee)
    head = (f"Verified **{now['name']}** for {_pkr(now['amount'])}." if now.get("verified")
            else f"Saved details for **{now['name']}** (not verified yet).")
    return _result(ws, str(claim["policy_id"]), head, "verify_claim_payees")


@handles("authorize_claim_disbursement")
@relay_forbidden
async def _authorize_claim_disbursement(args: dict, ctx: Ctx) -> dict:
    return await _run(args, ctx, "authorize_claim_disbursement", "/settlement/authorize", None,
                      "Disbursement authorised. Nothing has been paid yet — disbursing is the next step.")


@handles("disburse_claim_settlement")
@relay_forbidden
async def _disburse_claim_settlement(args: dict, ctx: Ctx) -> dict:
    claim, ws = await _claim_and_workspace(args, ctx)
    if ws is None:
        return _not_in_workflow(claim)
    if ws["settlement"].get("disbursed_at"):
        return _result(ws, str(claim["policy_id"]), "This claim has already been paid — nothing was disbursed again.",
                       "disburse_claim_settlement")
    method = args.get("method") or "Bank Transfer"
    ws = await _post(ctx, claim, "/settlement/disburse", {"method": method})
    st = ws.get("settlement") or {}
    refs = ", ".join(f"{p['payee_name']} {_pkr(p['amount'])} ({p.get('reference_number') or 'no ref'})" for p in st.get("payouts") or [])
    return _result(ws, str(claim["policy_id"]), f"Disbursed **{_pkr(st.get('paid_total'))}** by {method}: {refs}.",
                   "disburse_claim_settlement")


@handles("reconcile_claim_settlement")
@relay_forbidden
async def _reconcile_claim_settlement(args: dict, ctx: Ctx) -> dict:
    claim, ws = await _claim_and_workspace(args, ctx)
    if ws is None:
        return _not_in_workflow(claim)
    ws = await _post(ctx, claim, "/settlement/reconcile", {"note": args.get("note")} if args.get("note") else {})
    rec = (ws.get("settlement") or {}).get("reconciliation") or {}
    failed = [c["detail"] for c in rec.get("checks") or [] if c.get("severity") == "block"]
    head = (f"Reconciliation **{rec.get('status')}** — disbursed {_pkr(rec.get('disbursed'))} against {_pkr(rec.get('approved'))} approved."
            + (" Exceptions: " + "; ".join(failed) if failed else ""))
    return _result(ws, str(claim["policy_id"]), head, "reconcile_claim_settlement")


# ── Step 7 — closure ─────────────────────────────────────────────────────────

@handles("close_claim_file")
@relay_forbidden
async def _close_claim_file(args: dict, ctx: Ctx) -> dict:
    claim, ws = await _claim_and_workspace(args, ctx)
    if ws is None:
        return _not_in_workflow(claim)
    policy_id = str(claim["policy_id"])
    head = []
    if ws["claim"]["status"] != "Closed":
        ws = await _post(ctx, claim, "/close")
        head.append(f"Closed **{ws['claim']['claim_number']}** — outcome **{(ws.get('closure') or {}).get('outcome')}**.")
    else:
        head.append(f"{ws['claim']['claim_number']} was already closed.")
    if args.get("send_letter", True):
        conf = (ws.get("closure") or {}).get("confirmation") or {}
        if conf.get("sent_at"):
            head.append(f"The closure letter already went to {conf.get('sent_to')} — not sent again.")
        else:
            try:
                sent = await _post(ctx, claim, "/confirmation/send")
                head.append(f"Closure letter emailed to {sent.get('sent_to')}." if sent.get("delivered")
                            else f"The mail provider did not accept the letter for {sent.get('sent_to')} — it was NOT sent.")
            except httpx.HTTPStatusError as exc:
                try:
                    detail = exc.response.json().get("detail")
                except ValueError:
                    detail = None
                head.append(f"The letter was not sent: {detail or exc.response.status_code}.")
            ws = (await _claim_and_workspace({"claim_number": ws["claim"]["claim_number"]}, ctx))[1] or ws
    return _result(ws, policy_id, " ".join(head), "close_claim_file")
