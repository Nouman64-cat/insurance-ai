"""Individual policy servicing (microservices/frontend-microservices/docs/agent-scenarios/chatbot-maturity-roadmap.md, P1):
delivery, onboarding, premium collection, endorsements, renewal, reinstatement
and exit.

Every tool wraps an existing tenant-service post-issuance endpoint
(routers/post_issuance.py, renewals.py, reinstatement.py, policy_exit.py) and
resolves exactly ONE policy first — several matches come back as a choice.

The rules the roadmap sets for this area, enforced here:
  - read real records: schedules, receipts and delivery jobs, never a chat claim;
  - say "queued" for work a worker will do, and "sent" only when it was;
  - keep request, approval, applied change and settlement distinct — opening a
    renewal, reinstatement or surrender is not the renewal, restoration or payout;
  - a mutation re-reads state first, so a repeated click doesn't apply it twice.

Registered by being imported at the foot of tool_executor.py.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any, Optional

from tool_executor import ChoiceNeeded, Ctx, _action, _created_key, _parse_json_arg, handles

# Statuses of a contract that exists (issued at some point) — servicing never targets a quote.
_ISSUED = {"Issued", "PendingPayment", "Active", "GracePeriod", "Lapsed", "Cancelled", "Matured",
           "Surrendered", "Terminated", "Expired", "Reinstated", "Paid-Up", "PaidUp"}


def _pkr(value: Any) -> str:
    try:
        return f"PKR {float(value):,.0f}"
    except (TypeError, ValueError):
        return "—"


def _ref(value: Any) -> str:
    return re.sub(r"^CASE-", "APP-", str(value or "").strip().upper())


def _digits(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def _label(p: dict) -> str:
    return f"{p.get('policy_number') or 'unnumbered'} — {p.get('customer_name') or '—'} · {p.get('product_name') or '—'}"


def _entity(p: dict, ctx: Ctx) -> dict:
    return {"type": "policy", "id": p["id"], "tenant_id": ctx.tenant_id, "reference": p.get("policy_number"),
            "label": _label(p), "customer_id": p.get("customer_id"), "status": p.get("status")}


def _open_action(p: dict) -> dict:
    return {"label": "Open Policy", "actionType": "embed", "payload": f"post-issuance/{p['id']}"}


async def resolve_policy(args: dict, ctx: Ctx) -> dict:
    """Exactly one issued policy, or LookupError / ChoiceNeeded."""
    res = await ctx.client.get(ctx.tsvc("/policies"))
    res.raise_for_status()
    rows = res.json()
    rows = rows if isinstance(rows, list) else rows.get("items", [])
    issued = [p for p in rows if p.get("status") in _ISSUED or p.get("policy_number")]
    number, case_no = (args.get("policy_number") or "").strip(), (args.get("case_number") or "").strip()
    cnic, name = (args.get("cnic") or "").strip(), (args.get("policyholder_name") or "").strip().lower()

    if number:
        found = [p for p in rows if (p.get("policy_number") or "").upper() == number.upper() or p.get("id") == number]
        what = number
    elif case_no:
        found = [p for p in issued if _ref(p.get("case_number")) == _ref(case_no)]
        what = case_no
    elif cnic:
        cres = await ctx.client.get(ctx.tsvc("/customers"))
        cres.raise_for_status()
        ids = {c["id"] for c in cres.json() if _digits(c.get("cnic")) == _digits(cnic)}
        found = [p for p in issued if p.get("customer_id") in ids]
        what = f"CNIC {cnic}"
    elif name:
        found = [p for p in issued if (p.get("customer_name") or "").strip().lower() == name] or \
                [p for p in issued if name in (p.get("customer_name") or "").lower()]
        what = f'"{args.get("policyholder_name")}"'
    else:
        raise LookupError("Which policy? Give the policy number, the policyholder's CNIC or name.")

    if not found:
        raise LookupError(f"No issued policy found for {what}, or it is not accessible to you. "
                          "No other policy was used instead.")
    if len(found) > 1:
        found = sorted(found, key=_created_key, reverse=True)
        raise ChoiceNeeded(f"{len(found)} policies match {what}. Which one do you mean?",
                           [{"label": _label(p)[:70], "actionType": "submit",
                             "payload": f"Use policy {p.get('policy_number') or p['id']}"} for p in found[:6]])
    return found[0]


async def _get(ctx: Ctx, policy: dict, path: str, **params) -> dict:
    res = await ctx.client.get(ctx.tsvc(f"/policies/{policy['id']}{path}"), params=params or None)
    res.raise_for_status()
    return res.json()


async def _post(ctx: Ctx, policy: dict, path: str, body: Optional[dict] = None) -> dict:
    res = await ctx.client.post(ctx.tsvc(f"/policies/{policy['id']}{path}"), json=body or {})
    res.raise_for_status()
    return res.json()


def _case_summary(case: Optional[dict]) -> dict:
    """The common shape of a renewal / reinstatement / exit case."""
    if not case:
        return {}
    steps = case.get("stages") or case.get("workflow") or case.get("steps") or []
    if isinstance(steps, dict):
        steps = list(steps.values())
    rows = [{"title": s.get("title") or s.get("label") or s.get("key"),
             "state": s.get("state") or s.get("status")} for s in steps if isinstance(s, dict)]
    return {"id": case.get("id"), "reference": case.get("reference") or case.get("renewal_no") or case.get("exit_no"),
            "status": case.get("status"), "is_open": case.get("is_open"), "steps": rows}


def _step_lines(summary: dict) -> str:
    icon = {"complete": "✅", "completed": "✅", "done": "✅", "pending": "⏳", "awaiting": "⏳", "in_progress": "⏳",
            "blocked": "⛔", "failed": "❌", "not_started": "▫️"}
    return "\n".join(f"- {icon.get(str(s['state']).lower(), '▫️')} {s['title']} — {s['state']}"
                     for s in summary.get("steps") or [])


# ═══════════════════════════════════════════════════════════════════════════
# Delivery
# ═══════════════════════════════════════════════════════════════════════════

_DELIVERY_LABEL = {"WelcomeKit": "Welcome kit", "WelcomeEmail": "Welcome email", "IssuanceEmail": "Policy issuance email"}


def _delivery_lines(jobs: dict) -> tuple[str, list[str]]:
    lines, failed = [], []
    for kind in ("WelcomeKit", "IssuanceEmail", "WelcomeEmail"):
        job = jobs.get(kind)
        label = _DELIVERY_LABEL[kind]
        if not job:
            lines.append(f"- ▫️ {label} — not queued")
            continue
        st = job.get("status")
        if st == "Completed":
            lines.append(f"- ✅ {label} — {'generated' if kind == 'WelcomeKit' else 'delivered'}")
        elif st == "Retry":
            failed.append(kind)
            lines.append(f"- ❌ {label} — not delivered: {job.get('error') or 'failed'} (attempt {job.get('attempts')})")
        elif st == "Skipped":
            lines.append(f"- ⏹️ {label} — skipped: {job.get('error') or 'no longer needed'}")
        else:
            lines.append(f"- ⏳ {label} — queued")
    return "\n".join(lines), failed


@handles("get_policy_delivery_status")
async def _get_policy_delivery_status(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    ob = await _get(ctx, p, "/onboarding")
    jobs = ob.get("automatic_delivery") or {}
    lines, failed = _delivery_lines(jobs)
    contact = ob.get("contact") or {}
    msg = f"Delivery for **{p.get('policy_number')}**:\n{lines}"
    if not contact.get("email"):
        msg += "\n\n⚠️ No email address on record — emails can't be delivered until one is added."
    actions = [_open_action(p)]
    if failed and contact.get("email"):
        actions.insert(0, {"label": "Retry Failed Delivery", "actionType": "submit",
                           "payload": f"Retry the failed delivery for policy {p.get('policy_number')}"})
    return {"success": True, "entity": _entity(p, ctx), "state": {"delivery": jobs, "contact": contact},
            "message": msg, "quick_actions": actions}


@handles("retry_failed_delivery")
async def _retry_failed_delivery(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    ob = await _get(ctx, p, "/onboarding")
    jobs = ob.get("automatic_delivery") or {}
    failed = [k for k, j in jobs.items() if j.get("status") == "Retry"]
    if not failed:
        lines, _ = _delivery_lines(jobs)
        return {"success": True, "entity": _entity(p, ctx), "result": {"status": "skipped", "reason": "nothing_failed"},
                "message": f"Nothing failed for **{p.get('policy_number')}** — nothing was re-sent.\n{lines}"}
    emails = [k for k in failed if k != "WelcomeKit"]
    if emails and not (ob.get("contact") or {}).get("email"):
        return {"success": False, "entity": _entity(p, ctx), "error_code": "missing_contact", "retryable": False,
                "needs_user_input": True,
                "error": f"**{p.get('policy_number')}** has no email address on record, so a retry would fail again. "
                         "Add the customer's email first (an endorsement of their contact details)."}
    done = await _post(ctx, p, "/onboarding/delivery/retry")
    names = ", ".join(_DELIVERY_LABEL.get(k, k) for k in done.get("requeued") or failed)
    return {"success": True, "entity": _entity(p, ctx),
            "result": {"status": "queued", "requeued": done.get("requeued") or failed},
            "message": f"Queued a retry of: {names}. Delivery runs automatically within a few seconds — check the "
                       "delivery status to confirm it went; nothing is reported as sent until it has.",
            "quick_actions": [{"label": "Check Delivery", "actionType": "submit",
                               "payload": f"Was the welcome kit delivered for policy {p.get('policy_number')}?"}]}


# ═══════════════════════════════════════════════════════════════════════════
# Onboarding & portal access
# ═══════════════════════════════════════════════════════════════════════════

_STEP_NAMES = {"policyholder_id": "Policyholder ID", "welcome_kit": "Welcome kit", "portal": "Portal account",
               "welcome_sent": "Welcome pack sent", "acknowledged": "Customer acknowledged"}


@handles("get_onboarding_status")
async def _get_onboarding_status(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    ob = await _get(ctx, p, "/onboarding")
    steps = ob.get("steps") or {}
    lines = []
    for key, name in _STEP_NAMES.items():
        st = steps.get(key) or {}
        extra = ""
        if key == "portal" and st.get("done"):
            extra = f" ({st.get('status')}{', must set a password' if st.get('must_reset') else ''})"
        if key == "policyholder_id" and st.get("value"):
            extra = f" ({st['value']})"
        lines.append(f"- {'✅' if st.get('done') else '▫️'} {name}{extra}")
    progress = ob.get("progress") or {}
    msg = (f"Onboarding for **{p.get('policy_number')}** — {progress.get('done', 0)} of {progress.get('total', 0)} "
           "required steps done:\n"
           + "\n".join(lines) + "".join(f"\n⚠️ {w}" for w in ob.get("warnings") or []))
    actions = []
    if not (steps.get("portal") or {}).get("done"):
        actions.append({"label": "Give Portal Access", "actionType": "submit",
                        "payload": f"Give the customer portal access for policy {p.get('policy_number')}"})
    elif not (steps.get("welcome_sent") or {}).get("done"):
        actions.append({"label": "Send Portal Invitation", "actionType": "submit",
                        "payload": f"Send the portal invitation for policy {p.get('policy_number')}"})
    return {"success": True, "entity": _entity(p, ctx), "state": {"onboarding": steps, "status": ob.get("status"),
            "can_onboard": ob.get("can_onboard")}, "message": msg, "quick_actions": actions + [_open_action(p)]}


@handles("provision_portal_access")
async def _provision_portal_access(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    ob = await _get(ctx, p, "/onboarding")
    portal = (ob.get("steps") or {}).get("portal") or {}
    reset = bool(args.get("reset_password"))
    if reset and not (args.get("reason") or "").strip():
        return {"success": False, "error_code": "reason_required", "needs_user_input": True, "retryable": False,
                "error": "Resetting a customer's portal password needs a reason (e.g. 'customer locked out')."}
    if portal.get("done") and portal.get("status") == "Active" and not portal.get("must_reset") and not reset:
        return {"success": True, "entity": _entity(p, ctx), "result": {"status": "skipped", "reason": "already_active"},
                "message": f"The customer already has an active portal account (**{portal.get('username')}**) and has "
                           "signed in — it was left untouched. Ask for a reset only if they are locked out."}
    body = {"reset": reset, "reason": args.get("reason")} if reset else {}
    done = await _post(ctx, p, "/onboarding/portal", body)
    if done.get("already_active"):
        return {"success": True, "entity": _entity(p, ctx), "result": {"status": "skipped", "reason": "already_active"},
                "message": f"The customer's portal account (**{done.get('username')}**) is already active"
                           + (" but suspended — contact support to lift it." if done.get("suspended") else
                              " — it was left untouched.")}
    msg = (f"Portal access {'reset' if done.get('reset') else 'created'} for **{p.get('customer_name')}** — "
           f"username **{done.get('username')}**.")
    if done.get("temp_password"):
        msg += (f"\nOne-time password: `{done['temp_password']}` (shown once; the customer must change it at first "
                f"sign-in{', and it expires ' + str(done.get('invite_expires_at'))[:10] if done.get('invite_expires_at') else ''}).")
    msg += "\nThe customer has not been notified yet — send the portal invitation next."
    return {"success": True, "entity": _entity(p, ctx), "result": {"status": "completed", "username": done.get("username")},
            "message": msg,
            "last_action": _action("provision_portal_access", "policy", p["id"], f"post-issuance/{p['id']}", "Portal access created"),
            "quick_actions": [{"label": "Send Portal Invitation", "actionType": "submit",
                               "payload": f"Send the portal invitation for policy {p.get('policy_number')}"}]}


@handles("send_portal_invitation")
async def _send_portal_invitation(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    ob = await _get(ctx, p, "/onboarding")
    steps, contact = ob.get("steps") or {}, ob.get("contact") or {}
    if not (steps.get("portal") or {}).get("done"):
        return {"success": False, "error_code": "blocked", "retryable": False,
                "error": "The customer has no portal account yet — give portal access first.",
                "quick_actions": [{"label": "Give Portal Access", "actionType": "submit",
                                   "payload": f"Give the customer portal access for policy {p.get('policy_number')}"}]}
    channel = args.get("channel") or ("Email" if contact.get("email") else "SMS" if contact.get("phone") else None)
    if channel is None:
        return {"success": False, "error_code": "missing_contact", "retryable": False, "needs_user_input": True,
                "error": "No email or phone is on record, so the invitation has nowhere to go. Add a contact first."}
    if (steps.get("welcome_sent") or {}).get("done") and not args.get("resend"):
        at = (steps.get("welcome_sent") or {}).get("at")
        return {"success": True, "entity": _entity(p, ctx), "result": {"status": "skipped", "reason": "already_sent"},
                "message": f"The welcome pack with portal details was already sent ({str(at)[:10]}). Nothing was re-sent.",
                "quick_actions": [{"label": "Send Again", "actionType": "submit",
                                   "payload": f"Resend the portal invitation for policy {p.get('policy_number')} (resend true)"}]}
    await _post(ctx, p, "/onboarding/send-welcome", {"channel": channel})   # 502 when the email didn't go
    to = contact.get("email") if channel == "Email" else contact.get("phone")
    return {"success": True, "entity": _entity(p, ctx), "result": {"status": "completed", "channel": channel},
            "message": f"Portal invitation and welcome pack sent by **{channel}** to {to}."
                       + ("" if channel == "Email" else " (SMS hand-off is logged; it isn't delivery-confirmed.)"),
            "last_action": _action("send_portal_invitation", "policy", p["id"], f"post-issuance/{p['id']}", "Invitation sent")}


# ═══════════════════════════════════════════════════════════════════════════
# Premium collection
# ═══════════════════════════════════════════════════════════════════════════

_INSTALMENT_ICON = {"paid": "✅", "upcoming": "▫️", "due_soon": "⏳", "due_today": "⏳", "grace": "⚠️",
                    "past_grace": "❌", "waived": "⏹️"}


@handles("get_premium_schedule")
async def _get_premium_schedule(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    billing = await _get(ctx, p, "/premiums")
    rows = billing.get("installments") or []
    summary = billing.get("summary") or {}
    if args.get("only_outstanding"):
        rows = [r for r in rows if r.get("outstanding", 0) > 0]
    lines = "\n".join(
        f"| {r.get('installment_no')} | {r.get('due_date')} | {_pkr(r.get('amount_due'))} | {_pkr(r.get('amount_paid'))} | "
        f"{_INSTALMENT_ICON.get(r.get('state'), '')} {r.get('status')} | {r.get('payment_reference') or '—'} |"
        for r in rows[:24])
    head = (f"**{p.get('policy_number')}** — {summary.get('paid', 0)} of {summary.get('total', 0)} instalment(s) paid; "
            f"outstanding {_pkr(summary.get('total_outstanding'))}"
            + (f", {summary.get('arrears_count')} overdue" if summary.get("arrears_count") else "")
            + (f". In grace until {summary.get('grace_until')}" if summary.get("in_grace") else "")
            + (". ⚠️ Lapse is due" if summary.get("lapse_due") else "") + ".")
    table = ("\n\n| # | Due | Amount | Paid | Status | Reference |\n|---|---|---|---|---|---|\n" + lines) if rows else \
            "\n\nNo instalments to show."
    actions = []
    if summary.get("arrears_count") or summary.get("in_grace"):
        actions.append({"label": "Send Premium Reminder", "actionType": "submit",
                        "payload": f"Send a premium reminder for policy {p.get('policy_number')}"})
    return {"success": True, "entity": _entity(p, ctx), "state": {"summary": summary},
            "installments": rows, "message": head + table, "quick_actions": actions + [_open_action(p)]}


@handles("get_payment_receipt")
async def _get_payment_receipt(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    res = await ctx.client.get(ctx.tsvc(f"/policies/{p['id']}/premiums/receipts"))
    res.raise_for_status()
    receipts = res.json()
    wanted = (args.get("receipt_no") or args.get("payment_reference") or "").strip().upper()
    if wanted:
        receipts = [r for r in receipts if wanted in (str(r.get("receipt_no")) + " " + str(r.get("payment_reference"))).upper()]
    if not receipts:
        return {"success": True, "entity": _entity(p, ctx), "receipts": [],
                "message": f"No {'matching ' if wanted else ''}premium receipts on **{p.get('policy_number')}**. "
                           "A payment only gets a receipt once the gateway has settled it."}
    lines = "\n".join(f"- **{r.get('receipt_no')}** — {_pkr(r.get('total_amount'))} via {r.get('method') or '—'}, "
                      f"ref {r.get('payment_reference') or '—'} ({str(r.get('created_at'))[:10]})"
                      + (f", incl. late surcharge {_pkr(r.get('surcharge_amount'))}" if r.get("surcharge_amount") else "")
                      for r in receipts[:10])
    return {"success": True, "entity": _entity(p, ctx), "receipts": receipts,
            "message": f"Receipts for **{p.get('policy_number')}**:\n{lines}\n\nDownload them from the policy's "
                       "Premiums tab.", "quick_actions": [_open_action(p)]}


@handles("send_premium_reminder")
async def _send_premium_reminder(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    billing = await _get(ctx, p, "/premiums")
    unpaid = sorted([r for r in billing.get("installments") or [] if r.get("outstanding", 0) > 0],
                    key=lambda r: r.get("due_date") or "")
    if args.get("installment_no"):
        unpaid = [r for r in unpaid if r.get("installment_no") == int(args["installment_no"])]
    if not unpaid:
        return {"success": True, "entity": _entity(p, ctx), "result": {"status": "skipped", "reason": "nothing_due"},
                "message": f"Nothing is outstanding on **{p.get('policy_number')}** — no reminder was sent."}
    row = unpaid[0]
    kind = {"past_grace": "FinalNotice", "grace": "GraceWarning", "due_today": "Due"}.get(row.get("state"), "Upcoming")
    done = await _post(ctx, p, f"/premiums/{row['id']}/remind", {"channel": args.get("channel") or "Email", "kind": kind})
    rem = done.get("reminder") or {}
    if rem.get("delivered") is False:
        return {"success": False, "entity": _entity(p, ctx), "error_code": "delivery_failed", "retryable": True,
                "error": f"The reminder email to {rem.get('to')} could not be delivered — it was not counted as sent."}
    sent = "sent" if rem.get("delivered") else "logged for dispatch"
    return {"success": True, "entity": _entity(p, ctx),
            "result": {"status": "completed", "delivered": rem.get("delivered"), "channel": rem.get("channel")},
            "message": f"{kind} reminder for instalment {row.get('installment_no')} ({_pkr(row.get('payable'))}, due "
                       f"{row.get('due_date')}) {sent} by {rem.get('channel') or 'Email'}"
                       + (f" to {rem.get('to')}" if rem.get("to") and rem.get("to") != "postal" else "") + "."}


# ═══════════════════════════════════════════════════════════════════════════
# Endorsements — an applied contractual change, not a request
# ═══════════════════════════════════════════════════════════════════════════

_ENDORSEMENTS = ("nominees", "address", "contact", "sum_assured", "rider_add", "rider_remove")


def _nominees(args: dict) -> list[dict]:
    raw = _parse_json_arg(args.get("beneficiaries_json"), "beneficiaries_json") or []
    if not isinstance(raw, list) or not raw:
        raise LookupError('beneficiaries_json must be a list, e.g. [{"name": "Sara", "relationship": "Spouse", "share_pct": 100}].')
    return raw


async def _plan_endorsement(args: dict, ctx: Ctx, p: dict) -> dict:
    """What would change: current vs proposed, the premium impact, and what is missing."""
    kind = args.get("endorsement_type")
    if kind not in _ENDORSEMENTS:
        raise LookupError(f"endorsement_type must be one of: {', '.join(_ENDORSEMENTS)}.")
    ov = await _get(ctx, p, "/endorsements")
    if not ov.get("can_endorse"):
        return {"blocked": f"Endorsements need an in-force policy — **{p.get('policy_number')}** is {ov.get('policy_status')}."}
    plan: dict[str, Any] = {"kind": kind, "missing": [], "unchanged": False, "premium": None}
    if kind == "nominees":
        new = _nominees(args)
        total = round(sum(float(n.get("share_pct") or 0) for n in new), 2)
        if abs(total - 100) > 0.01:
            plan["missing"].append(f"nominee shares must total 100% (they total {total}%)")
        for n in new:
            if not n.get("name") or not n.get("relationship"):
                plan["missing"].append("every nominee needs a name and relationship")
                break
        plan.update(current=ov.get("beneficiaries"), proposed=new, path="/endorsements/nominees",
                    body={"beneficiaries": new})
        plan["unchanged"] = sorted((b["name"], float(b["share_pct"])) for b in ov.get("beneficiaries") or []) == \
            sorted((n.get("name"), float(n.get("share_pct") or 0)) for n in new)
    elif kind == "address":
        proposed = {k: args.get(k) for k in ("address", "city", "province") if args.get(k)}
        if not proposed:
            plan["missing"].append("the new address, city or province")
        plan.update(current=ov.get("address"), proposed=proposed, path="/endorsements/address", body=proposed)
        plan["unchanged"] = bool(proposed) and all((ov.get("address") or {}).get(k) == v for k, v in proposed.items())
    elif kind == "contact":
        proposed = {k: args.get(k) for k in ("email", "phone") if args.get(k)}
        if not proposed:
            plan["missing"].append("the new email or phone")
        plan.update(current=ov.get("contact"), proposed=proposed, path="/endorsements/contact", body=proposed)
        plan["unchanged"] = bool(proposed) and all((ov.get("contact") or {}).get(k) == v for k, v in proposed.items())
    elif kind == "sum_assured":
        new = float(args.get("new_sum_assured") or 0)
        if new <= 0:
            plan["missing"].append("the new sum assured")
        else:
            plan["premium"] = await _get(ctx, p, "/endorsements/quote", sum_assured=new)
        plan.update(current=ov.get("sum_assured"), proposed=new, path="/endorsements/sum-assured",
                    body={"new_sum_assured": new})
        plan["unchanged"] = new == ov.get("sum_assured")
    elif kind == "rider_add":
        if not args.get("rider_name") or not args.get("rider_annual_premium"):
            plan["missing"].append("the rider's name and annual premium")
        else:
            plan["premium"] = await _get(ctx, p, "/endorsements/quote", rider_premium=float(args["rider_annual_premium"]))
        plan.update(current=ov.get("riders"), proposed=args.get("rider_name"), path="/endorsements/riders",
                    body={"action": "add", "name": args.get("rider_name"), "sum_assured": args.get("rider_sum_assured"),
                          "annual_premium": args.get("rider_annual_premium")})
        plan["unchanged"] = any(r.get("name") == args.get("rider_name") for r in ov.get("riders") or [])
    else:  # rider_remove
        riders = ov.get("riders") or []
        want = (args.get("rider_name") or "").strip().lower()
        rider = next((r for r in riders if r.get("id") == args.get("rider_id") or (want and r.get("name", "").lower() == want)), None)
        if rider is None:
            plan["missing"].append("which rider to remove" + (f" (riders: {', '.join(r['name'] for r in riders)})" if riders else " — the policy has no riders"))
        plan.update(current=riders, proposed=f"remove {rider.get('name')}" if rider else None, path="/endorsements/riders",
                    body={"action": "remove", "rider_id": rider.get("id") if rider else None})
        plan["unchanged"] = False
    return plan


@handles("preview_policy_endorsement")
async def _preview_policy_endorsement(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    plan = await _plan_endorsement(args, ctx, p)
    if plan.get("blocked"):
        return {"success": False, "error_code": "blocked", "retryable": False, "error": plan["blocked"]}
    msg = f"**Preview — {plan['kind'].replace('_', ' ')} change on {p.get('policy_number')}** (nothing has changed)\n"
    msg += f"- Current: {plan.get('current')}\n- Proposed: {plan.get('proposed')}\n"
    if plan.get("premium"):
        q = plan["premium"]
        msg += f"- Premium: {_pkr(q.get('current_premium'))} → {_pkr(q.get('new_premium'))} ({'+' if q.get('delta', 0) >= 0 else ''}{_pkr(q.get('delta'))} a year)\n"
    else:
        msg += "- Premium: no change\n"
    msg += "- Effective: on the day it is applied\n"
    if plan["missing"]:
        msg += "\nStill needed: " + "; ".join(plan["missing"])
    elif plan["unchanged"]:
        msg += "\nThis matches what is already on the policy — applying it would change nothing."
    else:
        msg += ("\nApplying this changes the contract immediately and issues an endorsement letter (underwriting staff). "
                "If the customer is only asking, record it as a service request instead.")
    return {"success": True, "entity": _entity(p, ctx),
            "result": {"status": "preview", "kind": plan["kind"], "current": plan.get("current"),
                       "proposed": plan.get("proposed"), "premium_impact": plan.get("premium"),
                       "missing": plan["missing"], "unchanged": plan["unchanged"]},
            "message": msg}


@handles("submit_policy_endorsement")
async def _submit_policy_endorsement(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    plan = await _plan_endorsement(args, ctx, p)
    if plan.get("blocked"):
        return {"success": False, "error_code": "blocked", "retryable": False, "error": plan["blocked"]}
    if plan["missing"]:
        return {"success": False, "error_code": "validation", "needs_user_input": True, "retryable": False,
                "error": "Can't apply this yet: " + "; ".join(plan["missing"]) + "."}
    if plan["unchanged"]:
        return {"success": True, "entity": _entity(p, ctx), "result": {"status": "skipped", "reason": "already_applied"},
                "message": "That is already what the policy says — nothing was changed and no endorsement was issued."}
    ov = await _post(ctx, p, plan["path"], plan["body"])
    latest = max(ov.get("history") or [{}], key=lambda e: e.get("created_at") or "")
    return {"success": True, "entity": _entity(p, ctx),
            "result": {"status": "completed", "endorsement_no": latest.get("endorsement_no"),
                       "premium_delta": latest.get("premium_delta")},
            "message": f"Endorsement **{latest.get('endorsement_no')}** applied to **{p.get('policy_number')}**: "
                       f"{latest.get('summary')}" + (f" — premium change {_pkr(latest.get('premium_delta'))} a year"
                                                    if latest.get("premium_delta") else "") + ".",
            "last_action": _action("submit_policy_endorsement", "policy", p["id"], f"post-issuance/{p['id']}",
                                   f"Endorsement {latest.get('endorsement_no')}")}


@handles("get_endorsement_status")
async def _get_endorsement_status(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    ov = await _get(ctx, p, "/endorsements")
    history = sorted(ov.get("history") or [], key=lambda e: e.get("created_at") or "", reverse=True)
    if args.get("endorsement_no"):
        history = [e for e in history if (e.get("endorsement_no") or "").upper() == args["endorsement_no"].upper()]
    if not history:
        return {"success": True, "entity": _entity(p, ctx), "endorsements": [],
                "message": f"No {'matching ' if args.get('endorsement_no') else ''}endorsements have been applied to "
                           f"**{p.get('policy_number')}**. A change the customer asked for may still be an open service "
                           "request — check Request Management."}
    lines = "\n".join(f"- **{e.get('endorsement_no')}** ({e.get('type')}) — {e.get('summary')}, effective "
                      f"{e.get('effective_date')}" + (f", premium {_pkr(e.get('premium_delta'))}" if e.get("premium_delta") else "")
                      for e in history[:10])
    return {"success": True, "entity": _entity(p, ctx), "endorsements": history,
            "message": f"Applied endorsements on **{p.get('policy_number')}**:\n{lines}"}


# ═══════════════════════════════════════════════════════════════════════════
# Renewal
# ═══════════════════════════════════════════════════════════════════════════

def _checks(eligibility: dict) -> str:
    return "\n".join(f"- {'✅' if c.get('passed') else ('ℹ️' if c.get('severity') == 'info' else '❌')} "
                     f"{c.get('label')}: {c.get('detail')}" for c in eligibility.get("checks") or [])


@handles("get_renewal_readiness")
async def _get_renewal_readiness(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    ov = await _get(ctx, p, "/renewals")
    nxt, elig, case = ov.get("next") or {}, ov.get("eligibility") or {}, _case_summary(ov.get("case"))
    msg = (f"**{p.get('policy_number')}** — next {nxt.get('renewal_type_label') or 'renewal'} due **{nxt.get('due_date')}** "
           f"({nxt.get('days_until')} days), {_pkr(nxt.get('payable'))}. {elig.get('message') or ''}\n{_checks(elig)}")
    if case:
        msg += f"\n\nOpen renewal case **{case.get('reference')}** — {case.get('status')}:\n{_step_lines(case)}"
    actions = [] if case or not elig.get("eligible") else [
        {"label": "Preview Renewal", "actionType": "submit", "payload": f"Preview the renewal of policy {p.get('policy_number')}"}]
    return {"success": True, "entity": _entity(p, ctx), "state": {"next": nxt, "eligibility": elig, "case": case},
            "message": msg, "quick_actions": actions + [_open_action(p)]}


@handles("preview_policy_renewal")
async def _preview_policy_renewal(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    ov = await _get(ctx, p, "/renewals")
    nxt, elig, raw_case = ov.get("next") or {}, ov.get("eligibility") or {}, ov.get("case") or {}
    quote = raw_case.get("quote") or {}
    msg = (f"**Renewal preview — {p.get('policy_number')}** (nothing has been opened)\n"
           f"- Type: {nxt.get('renewal_type_label') or '—'} · due {nxt.get('due_date')}\n"
           f"- Amount: {_pkr(quote.get('instalment') or nxt.get('payable'))}"
           + (f" (includes late surcharge {_pkr(nxt.get('surcharge'))})" if nxt.get("surcharge") else "") + "\n"
           + (f"- New period: {quote.get('period_start')} → {quote.get('period_end')}\n" if quote.get("period_start") else "")
           + f"- Eligibility: {elig.get('message')}\n"
           "\nRenewing means: open the renewal, send the notice, collect and reconcile the premium, then confirm. "
           "Cover continues only once the premium is reconciled.")
    actions = [{"label": "Start Renewal", "actionType": "submit",
                "payload": f"Start the renewal for policy {p.get('policy_number')}"}] if elig.get("eligible") and not raw_case.get("is_open") else []
    return {"success": True, "entity": _entity(p, ctx),
            "result": {"status": "preview", "next": nxt, "eligible": elig.get("eligible"), "quote": quote or None},
            "message": msg, "quick_actions": actions}


@handles("submit_policy_renewal")
async def _submit_policy_renewal(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    ov = await _get(ctx, p, "/renewals")
    open_case = ov.get("case") if (ov.get("case") or {}).get("is_open") else None
    if open_case:
        case = _case_summary(open_case)
        return {"success": True, "entity": _entity(p, ctx), "result": {"status": "skipped", "reason": "already_open"},
                "message": f"A renewal is already open for **{p.get('policy_number')}** ({case.get('reference')}) — "
                           f"nothing new was opened.\n{_step_lines(case)}"}
    elig = ov.get("eligibility") or {}
    if not elig.get("eligible"):
        return {"success": False, "error_code": "not_eligible", "retryable": False,
                "error": f"**{p.get('policy_number')}** can't be renewed: {elig.get('message')}\n{_checks(elig)}"}
    done = await _post(ctx, p, "/renewals", {})
    case = _case_summary(done.get("case"))
    return {"success": True, "entity": _entity(p, ctx), "result": {"status": "accepted", "case": case},
            "message": f"Renewal **{case.get('reference')}** opened for **{p.get('policy_number')}**. The policy is not "
                       f"renewed yet — the premium still has to be collected and reconciled.\n{_step_lines(case)}",
            "last_action": _action("submit_policy_renewal", "policy", p["id"], f"post-issuance/{p['id']}", "Renewal opened"),
            "quick_actions": [_open_action(p)]}


# ═══════════════════════════════════════════════════════════════════════════
# Reinstatement — a request is not restored cover
# ═══════════════════════════════════════════════════════════════════════════

@handles("get_reinstatement_requirements")
async def _get_reinstatement_requirements(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    ov = await _get(ctx, p, "/reinstatement")
    elig = ov.get("eligibility") or {}
    rules = elig.get("rules") or {}
    msg = f"**{p.get('policy_number')}** ({elig.get('policy_status')}) — {elig.get('message')}\n{_checks(elig)}"
    if elig.get("lapse_date"):
        msg += (f"\n\nLapsed {elig['lapse_date']} ({elig.get('days_lapsed')} days ago); the reinstatement window ends "
                f"{elig.get('window_ends_on')} ({elig.get('window_days_left')} days left).")
    if rules:
        msg += (f"\nEvidence: a health declaration within {rules.get('declaration_only_days')} days of lapse; medical "
                f"evidence after {rules.get('medical_evidence_days')} days. All arrears must be paid"
                + (f", plus a {_pkr(rules.get('fee_amount'))} fee" if rules.get("fee_amount") else "") + ".")
    for key in ("blockers", "reviews"):
        if elig.get(key):
            msg += f"\n{key.title()}: " + "; ".join(str(x.get('label') if isinstance(x, dict) else x) for x in elig[key])
    actions = [{"label": "Request Reinstatement", "actionType": "submit",
                "payload": f"Submit a reinstatement request for policy {p.get('policy_number')}"}] if elig.get("eligible") else []
    return {"success": True, "entity": _entity(p, ctx), "state": {"eligibility": elig}, "message": msg,
            "quick_actions": actions}


@handles("submit_reinstatement_request")
async def _submit_reinstatement_request(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    ov = await _get(ctx, p, "/reinstatement")
    if (ov.get("case") or {}).get("is_open"):
        case = _case_summary(ov["case"])
        return {"success": True, "entity": _entity(p, ctx), "result": {"status": "skipped", "reason": "already_open"},
                "message": f"A reinstatement request is already open ({case.get('reference')}) — nothing new was opened."}
    elig = ov.get("eligibility") or {}
    if not elig.get("eligible") and elig.get("outcome") != "resume":
        return {"success": False, "error_code": "not_eligible", "retryable": False,
                "error": f"**{p.get('policy_number')}** can't be reinstated: {elig.get('message')}"}
    body = {"applicant_relationship": args.get("applicant_relationship") or "Policyholder",
            "request_channel": args.get("request_channel") or "Branch",
            "reason": args.get("reason"), "applicant_name": args.get("applicant_name")}
    done = await _post(ctx, p, "/reinstatement", {k: v for k, v in body.items() if v})
    case = done.get("case") or {}
    arrears = case.get("arrears") or {}
    return {"success": True, "entity": _entity(p, ctx),
            "result": {"status": "accepted", "case": _case_summary(case)},
            "message": f"Reinstatement request **{case.get('reference')}** registered for **{p.get('policy_number')}**. "
                       "Cover is **not** restored yet: the declaration, any medical evidence, an underwriting decision and "
                       "payment of arrears come first."
                       + (f" Arrears due: {_pkr(arrears.get('total') or arrears.get('amount'))}." if arrears else ""),
            "last_action": _action("submit_reinstatement_request", "policy", p["id"], f"post-issuance/{p['id']}",
                                   "Reinstatement requested"),
            "quick_actions": [_open_action(p)]}


@handles("get_reinstatement_status")
async def _get_reinstatement_status(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    ov = await _get(ctx, p, "/reinstatement")
    raw = ov.get("case")
    if not raw:
        return {"success": True, "entity": _entity(p, ctx), "message": f"No reinstatement request exists for **{p.get('policy_number')}**."}
    case = _case_summary(raw)
    restored = bool(raw.get("reinstated_at"))
    msg = (f"Reinstatement **{case.get('reference')}** — {case.get('status')}"
           + (f"; cover restored {str(raw['reinstated_at'])[:10]}." if restored else "; cover is not restored yet.")
           + (f"\n{_step_lines(case)}" if case.get("steps") else ""))
    if raw.get("terms") and not raw.get("terms_response"):
        msg += "\n⏳ Revised terms are waiting for the customer's acceptance."
    return {"success": True, "entity": _entity(p, ctx), "state": {"case": case, "restored": restored},
            "message": msg, "quick_actions": [_open_action(p)]}


# ═══════════════════════════════════════════════════════════════════════════
# Exit — free-look cancellation and surrender
# ═══════════════════════════════════════════════════════════════════════════

@handles("preview_policy_exit")
async def _preview_policy_exit(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    fl = await _get(ctx, p, "/free-look")
    ex = await _get(ctx, p, "/exit")
    surrender = (ex.get("indicative") or {}).get("surrender") or {}
    natural = ex.get("natural") or {}
    lines = [f"**Exit options — {p.get('policy_number')}** (estimates only; nothing has been requested)"]
    if fl.get("is_open"):
        lines.append(f"- **Free-look cancellation**: open until {fl.get('free_look_end_date')} ({fl.get('days_remaining')} "
                     f"days left). Refund of the {_pkr(fl.get('premium_paid'))} paid, less any medical examination "
                     "expenses incurred on issuing the policy; cover ends.")
    else:
        lines.append(f"- Free-look cancellation: closed{' (ended ' + str(fl.get('free_look_end_date')) + ')' if fl.get('free_look_end_date') else ''}.")
    if surrender.get("available"):
        lines.append(f"- **Surrender**: indicative value {_pkr(surrender.get('net') or surrender.get('value') or surrender.get('amount'))} "
                     "before loans and charges — the settlement is calculated only after a surrender is requested and verified.")
    else:
        lines.append(f"- Surrender: not available — {(surrender.get('reason') or 'no surrender value').rstrip('.')}."
                     + (" Cancelling after the free-look period returns nothing; cover simply runs to the end of the "
                        "paid term, and the customer can choose not to renew." if not fl.get("is_open") else ""))
    if natural:
        lines.append(f"- Natural end: {natural.get('label')} on {natural.get('term_ends')}.")
    lines.append("\nRequest → verification → settlement → payment are separate steps; an estimate is not an approval.")
    return {"success": True, "entity": _entity(p, ctx),
            "result": {"status": "preview", "free_look": fl, "surrender": surrender, "natural": natural},
            "message": "\n".join(lines)}


@handles("submit_policy_exit_request")
async def _submit_policy_exit_request(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    kind = args.get("exit_type")
    if not args.get("customer_confirmed"):
        return {"success": False, "error_code": "confirmation_required", "needs_user_input": True, "retryable": False,
                "error": "Ending a policy needs the customer's explicit instruction. Confirm the customer asked for it, "
                         "then submit again with customer_confirmed=true."}
    if kind == "free_look_cancellation":
        fl = await _get(ctx, p, "/free-look")
        if fl.get("cancelled"):
            return {"success": True, "entity": _entity(p, ctx), "result": {"status": "skipped", "reason": "already_cancelled"},
                    "message": f"**{p.get('policy_number')}** was already cancelled in its free-look period — nothing changed."}
        if not fl.get("is_open"):
            ex = await _get(ctx, p, "/exit")
            surrender = ((ex if isinstance(ex, dict) else {}).get("indicative") or {}).get("surrender") or {}
            if surrender.get("reason") and not surrender.get("available"):
                route = (f"{surrender['reason'].rstrip('.')}, so ending it now returns nothing — cover runs to the end of "
                         "the paid term and the customer can choose not to renew.")
            else:
                route = "a surrender is the route now."
            return {"success": False, "error_code": "window_closed", "retryable": False,
                    "error": f"The free-look period ended {fl.get('free_look_end_date')} — {route}"}
        body = {"reason": args.get("reason")}
        if args.get("medical_exam_deduction"):
            body.update(medical_exam_deduction=float(args["medical_exam_deduction"]), medical_exam_note=args.get("medical_exam_note"))
        done = await _post(ctx, p, "/free-look/cancel", body)
        refund = done.get("refund_amount") if done.get("refund_amount") is not None else fl.get("refund_amount")
        deducted = float(done.get("medical_exam_deduction") or 0)
        return {"success": True, "entity": _entity(p, ctx), "result": {"status": "completed", "refund_amount": refund,
                                                                      "medical_exam_deduction": deducted},
                "message": f"**{p.get('policy_number')}** is cancelled under free-look. A refund of {_pkr(refund)} is due"
                           + (f" ({_pkr(done.get('premium_paid'))} paid less {_pkr(deducted)} medical examination expenses)" if deducted else "")
                           + " — the refund is settled separately and has not been paid yet.",
                "last_action": _action("submit_policy_exit_request", "policy", p["id"], f"post-issuance/{p['id']}",
                                       "Free-look cancellation")}
    if kind != "surrender":
        raise LookupError("exit_type must be free_look_cancellation or surrender. Maturity, expiry and death exits are "
                          "detected by the platform rather than requested.")
    ex = await _get(ctx, p, "/exit")
    surrender = (ex.get("indicative") or {}).get("surrender") or {}
    if ex.get("indicative") is not None and not surrender.get("available") and not (ex.get("case") or {}).get("is_open"):
        # A pure protection plan (e.g. Life Protection Plus, one-year term) builds no cash value: opening a
        # surrender case would only end in "no surrender value". Say so, and offer what the customer can do.
        fl = await _get(ctx, p, "/free-look")
        options = (f"It is still inside its free-look period (until {fl.get('free_look_end_date')}): cancelling under free-look "
                   "refunds the premium paid, less any medical examination expenses." if fl.get("is_open") else
                   "Cancelling now returns nothing; cover runs to the end of the paid term and the customer can choose not to renew.")
        return {"success": False, "error_code": "no_surrender_value", "retryable": False, "entity": _entity(p, ctx),
                "error": f"**{p.get('policy_number')}** cannot be surrendered for value — "
                         f"{(surrender.get('reason') or 'it has no surrender value').rstrip('.')}. {options}",
                "quick_actions": ([{"label": "Cancel under free-look", "actionType": "submit",
                                    "payload": f"Cancel policy {p.get('policy_number')} under free-look"}] if fl.get("is_open") else [])
                                 + [_open_action(p)]}
    if (ex.get("case") or {}).get("is_open"):
        case = ex["case"]
        return {"success": True, "entity": _entity(p, ctx), "result": {"status": "skipped", "reason": "already_open"},
                "message": f"An exit request is already open ({case.get('exit_no')}, {case.get('exit_type_label')}) — "
                           "nothing new was opened."}
    done = await _post(ctx, p, "/exit", {"exit_type": "Surrender", "reason": args.get("reason"),
                                         "relationship": args.get("relationship") or "Policyholder",
                                         "channel": args.get("channel") or "Branch"})
    case = done.get("case") or {}
    return {"success": True, "entity": _entity(p, ctx), "result": {"status": "accepted", "exit_no": case.get("exit_no")},
            "message": f"Surrender request **{case.get('exit_no')}** opened for **{p.get('policy_number')}**. The policy is "
                       "still in force: eligibility verification, consent, settlement calculation and authorisation come "
                       "before any payout.",
            "last_action": _action("submit_policy_exit_request", "policy", p["id"], f"post-issuance/{p['id']}", "Surrender requested"),
            "quick_actions": [_open_action(p)]}


@handles("get_exit_status")
async def _get_exit_status(args: dict, ctx: Ctx) -> dict:
    p = await resolve_policy(args, ctx)
    fl = await _get(ctx, p, "/free-look")
    ex = await _get(ctx, p, "/exit")
    case = ex.get("case")
    if fl.get("cancelled"):
        c = fl.get("cancellation") or {}
        return {"success": True, "entity": _entity(p, ctx), "state": {"free_look": fl},
                "message": f"**{p.get('policy_number')}** was cancelled under free-look"
                           + (f" on {str(c.get('cancelled_at') or c.get('at'))[:10]}" if c else "")
                           + f"; refund {_pkr(c.get('refund_amount') or fl.get('refund_amount'))}."}
    if not case:
        return {"success": True, "entity": _entity(p, ctx), "message": f"No exit has been requested for **{p.get('policy_number')}**."}
    settlement = case.get("settlement") or {}
    disbursed = (case.get("disbursement") or {}).get("disbursed_at")
    msg = (f"Exit **{case.get('exit_no')}** ({case.get('exit_type_label')}) — {case.get('status')}"
           + (f", progress {case['progress']}" if isinstance(case.get("progress"), (str, int)) else "")
           + (f"\n- Settlement: {_pkr(settlement.get('net'))}" if settlement.get("net") is not None else "\n- Settlement: not calculated yet")
           + (f"\n- Paid out {str(disbursed)[:10]}" if disbursed else "\n- Payout: not made"))
    return {"success": True, "entity": _entity(p, ctx), "state": {"case": case}, "message": msg,
            "quick_actions": [_open_action(p)]}
