"""Commission administration on the persistent commission engine
(tenant-service routers/commissions.py, services/commission_engine.py).

The engine posts against explicit policy producers or automatically allocates the
assigned agent under an approved plan agreement. Missing configuration becomes a
durable exception. The administration tools support:

  agreements    list_commission_agreements, create_commission_agreement,
                approve_commission_agreement   (maker-checker: a different admin approves)
  allocation    get_policy_commission_split, assign_policy_producers
  exceptions    list_commission_exceptions, reconcile_commission_receipts
  explanation   explain_commission_earning     (agents see only their own)

Disbursement batch approval and manual external-payment recording live in the
portal. These chat tools do not transfer money. Tax and clawback are not automated.

Registered by being imported at the foot of tool_executor.py.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from tool_executor import ChoiceNeeded, Ctx, _action, _parse_json_arg, _full_name, handles, relay_forbidden

_NAV = {"label": "Open commissions", "actionType": "navigate", "payload": "commissions"}


def _pkr(value: Any) -> str:
    try:
        return f"PKR {float(value):,.2f}"
    except (TypeError, ValueError):
        return "—"


def _pct(value: Any) -> str:
    try:
        return f"{Decimal(str(value)).normalize():f}%"
    except (InvalidOperation, ValueError):
        return f"{value}%"


def _chip(label: str, payload: str) -> dict:
    return {"label": label, "actionType": "submit", "payload": payload}


# ── Lookups ──────────────────────────────────────────────────────────────────

async def _agreements(ctx: Ctx) -> list[dict]:
    res = await ctx.client.get(ctx.tsvc("/commissions/agreements"))
    res.raise_for_status()
    return res.json()


async def _payees(ctx: Ctx) -> list[dict]:
    res = await ctx.client.get(ctx.tsvc("/commissions/payees"))
    res.raise_for_status()
    return res.json()


def _agreement_label(a: dict) -> str:
    return (f"`{a['code']}` v{a['version']} — {a['name']} · first year {_pct(a['first_year_pct'])}, "
            f"renewal {_pct(a['renewal_pct'])} · {a['effective_from']} → {a.get('effective_to') or 'open'} · **{a['status']}**")


def _pick_agreement(rows: list[dict], code: str, version: Optional[int] = None, status: Optional[str] = None) -> list[dict]:
    hits = [a for a in rows if a["code"].casefold() == code.strip().casefold()]
    if version:
        hits = [a for a in hits if int(a["version"]) == int(version)]
    if status:
        hits = [a for a in hits if a["status"] == status]
    return sorted(hits, key=lambda a: int(a["version"]), reverse=True)


def _pick_payee(rows: list[dict], needle: str) -> dict:
    n = needle.strip().casefold()
    exact = [p for p in rows if n in (p["name"].casefold(), p["code"].casefold())]
    hits = exact or [p for p in rows if n in p["name"].casefold()]
    hits = [p for p in hits if p.get("active", True)] or hits
    if len(hits) == 1:
        return hits[0]
    if not hits:
        raise LookupError(f'No registered producer matches "{needle}". Producers are acquisition sources — '
                          "ask me to list the commission payees.")
    raise ChoiceNeeded(f'"{needle}" matches several producers — which one?',
                       [_chip(f"{p['name']} ({p['code']})", f"Use producer {p['code']}") for p in hits[:6]])


async def _policy_numbers(ctx: Ctx) -> dict[str, str]:
    res = await ctx.client.get(ctx.tsvc("/policies"))
    res.raise_for_status()
    rows = res.json()
    rows = rows if isinstance(rows, list) else rows.get("items", [])
    return {str(p["id"]): p.get("policy_number") or str(p["id"]) for p in rows}


# ── Agreements ───────────────────────────────────────────────────────────────

@handles("get_customer_commission_setup")
async def _get_customer_commission_setup(args: dict, ctx: Ctx) -> dict:
    """Use UUIDs as UUIDs. Quick leads do not need a CNIC for a read."""
    needle = str(args.get('customer_id') or args.get('customer_name') or '').strip()
    if not needle:
        return {'success': False, 'message': 'Which customer should I check? Give their name or customer ID.'}
    response = await ctx.client.get(ctx.tsvc('/customers'))
    response.raise_for_status()
    rows = response.json()
    exact = [c for c in rows if needle.casefold() in (str(c.get('id', '')).casefold(), _full_name(c).casefold())]
    hits = exact or [c for c in rows if needle.casefold() in _full_name(c).casefold()]
    if not hits:
        return {'success': False, 'message': f'No customer matches {needle}.'}
    if len(hits) > 1:
        raise ChoiceNeeded('Which customer should I check?', [
            _chip(f"{_full_name(c)} ({c.get('cnic') or c['id']})",
                  f"Check customer commission setup for customer_id {c['id']}") for c in hits[:6]])
    response = await ctx.client.get(ctx.tsvc('/commissions/setup'), params={'customer_id': hits[0]['id']})
    if response.status_code == 403:
        return {'success': False, 'error_code': 'forbidden', 'message': 'Commission setup requires an administrator.'}
    response.raise_for_status()
    data = response.json()
    customer = data['customer']
    lines = [f"**{customer['name']}** · customer ID {customer['id']}",
             f"Assigned agent: {customer.get('assigned_agent_name') or 'Unassigned'}.",
             f"Acquisition source: {customer.get('acquisition_source_name') or 'Unassigned'}.",
             f"Approved agreements effective today: {data['approved_agreement_count']}."]
    if not data['policies']:
        lines.append('No individual policy exists yet. Customer ownership alone does not accrue commission.')
    for p in data['policies']:
        lines.append(f"- {p.get('policy_number') or p['id']} · {p['product_name']}: " +
                     ('configured for receipts dated today' if p['ready'] else '; '.join(p['blocking_reasons'])) +
                     ('; producer assignment frozen after posting' if p['frozen'] else ''))
    if data['has_more']:
        lines.append('Only the first 50 policies are shown; narrow the selection in Commission earnings.')
    lines.append('Link an approved agreement to the plan once: the next premium receipt allocates 100% to the assigned agent automatically. Explicit policy splits override plan allocation. Disbursement batches require independent approval and recorded external payment confirmation; bank transfers and tax calculations are not automated.')
    return {'success': True, 'message': '\n\n'.join(lines), 'setup': data,
            'quick_actions': [{'label': 'Configure commissions', 'actionType': 'navigate',
                               'payload': f"commissions?customer_id={customer['id']}"}]}

@handles("list_commission_agreements")
async def _list_commission_agreements(args: dict, ctx: Ctx) -> dict:
    rows = await _agreements(ctx)
    if args.get("status"):
        rows = [a for a in rows if a["status"] == args["status"]]
    if args.get("search"):
        n = args["search"].casefold()
        rows = [a for a in rows if n in a["code"].casefold() or n in a["name"].casefold()]
    if not rows:
        return {"success": True, "agreements": [], "message": "No commission agreements match. Producers earn nothing "
                "until an agreement is created, approved by a second administrator, and assigned to their policies.",
                "quick_actions": [_chip("Draft an agreement", "Create a commission agreement"), _NAV]}
    drafts = [a for a in rows if a["status"] == "DRAFT"]
    qa = [_chip(f"Approve {a['code']} v{a['version']}", f"Approve commission agreement {a['code']} version {a['version']}")
          for a in drafts[:3]]
    qa += [_chip("Draft an agreement", "Create a commission agreement"), _NAV]
    return {"success": True, "agreements": rows,
            "message": f"{len(rows)} agreement(s):\n" + "\n".join(f"- {_agreement_label(a)}" for a in rows[:15])
                       + ("\n\nApproved agreements are immutable — change terms by drafting a new version." if rows else ""),
            "quick_actions": qa[:6]}


@handles("create_commission_agreement")
@relay_forbidden
async def _create_commission_agreement(args: dict, ctx: Ctx) -> dict:
    missing = [f for f in ("code", "name", "first_year_pct", "renewal_pct") if args.get(f) in (None, "")]
    if missing:
        return {"success": False, "needs_user_input": True, "error_code": "missing_details",
                "error": "A commission agreement needs a code, a name, the first-year % and the renewal % "
                         f"(missing: {', '.join(missing)}). Rates are contractual — never assume a statutory default."}
    rows = await _agreements(ctx)
    same_code = _pick_agreement(rows, args["code"])
    latest = same_code[0] if same_code else None
    effective_from = args.get("effective_from") or date.today().isoformat()
    # A repeated click re-finds the identical draft instead of minting v+1.
    if latest and latest["status"] == "DRAFT" and Decimal(str(latest["first_year_pct"])) == Decimal(str(args["first_year_pct"])) \
            and Decimal(str(latest["renewal_pct"])) == Decimal(str(args["renewal_pct"])) and str(latest["effective_from"]) == effective_from:
        return {"success": True, "agreement": latest,
                "message": f"That draft already exists: {_agreement_label(latest)}. Nothing new was created.",
                "quick_actions": [_chip("Approve it (other admin)", f"Approve commission agreement {latest['code']} version {latest['version']}"), _NAV]}
    body = {"code": args["code"].strip(), "version": int(args.get("version") or ((int(latest["version"]) + 1) if latest else 1)),
            "name": args["name"].strip(), "first_year_pct": str(args["first_year_pct"]), "renewal_pct": str(args["renewal_pct"]),
            "effective_from": effective_from, "effective_to": args.get("effective_to")}
    res = await ctx.client.post(ctx.tsvc("/commissions/agreements"), json={k: v for k, v in body.items() if v is not None})
    res.raise_for_status()
    a = res.json()
    return {"success": True, "agreement": a,
            "message": f"Drafted {_agreement_label(a)}.\nIt earns nothing until a **different administrator** approves it "
                       "and it is assigned to policies.",
            "last_action": _action("create_commission_agreement", "commission_agreement", str(a["id"]), "commissions", f"{a['code']} v{a['version']}"),
            "quick_actions": [_chip("List agreements", "List commission agreements"), _NAV]}


@handles("approve_commission_agreement")
@relay_forbidden
async def _approve_commission_agreement(args: dict, ctx: Ctx) -> dict:
    rows = await _agreements(ctx)
    if not args.get("code"):
        drafts = [a for a in rows if a["status"] == "DRAFT"]
        if not drafts:
            return {"success": True, "message": "There are no draft agreements waiting for approval.", "quick_actions": [_NAV]}
        raise ChoiceNeeded("Which draft agreement should be approved?",
                           [_chip(f"{a['code']} v{a['version']}", f"Approve commission agreement {a['code']} version {a['version']}") for a in drafts[:6]])
    hits = _pick_agreement(rows, args["code"], args.get("version"))
    if not hits:
        raise LookupError(f"No agreement with code {args['code']}" + (f" version {args['version']}" if args.get("version") else "") + ".")
    target = next((a for a in hits if a["status"] == "DRAFT"), hits[0])
    if target["status"] != "DRAFT":
        return {"success": True, "agreement": target,
                "message": f"{target['code']} v{target['version']} is already approved — nothing changed.", "quick_actions": [_NAV]}
    res = await ctx.client.post(ctx.tsvc(f"/commissions/agreements/{target['id']}/approve"))
    res.raise_for_status()
    a = res.json()
    return {"success": True, "agreement": a,
            "message": f"Approved {_agreement_label(a)}. It is now immutable and can be assigned to policies.",
            "last_action": _action("approve_commission_agreement", "commission_agreement", str(a["id"]), "commissions", f"{a['code']} v{a['version']} approved"),
            "quick_actions": [_chip("Assign to a policy", f"Assign producers on a policy under agreement {a['code']}"), _NAV]}


# ── Policy allocation ────────────────────────────────────────────────────────

async def _split_view(ctx: Ctx, policy: dict) -> tuple[list[dict], str]:
    res = await ctx.client.get(ctx.tsvc(f"/commissions/policies/{policy['id']}/assignments"))
    res.raise_for_status()
    rows = res.json()
    if not rows:
        return rows, f"No explicit producers are assigned on {policy.get('policy_number')}. Approved plan rates can automatically allocate to the customer's assigned agent on the next premium receipt. Check customer commission setup to verify readiness."
    payees = {str(p["id"]): p for p in await _payees(ctx)}
    agreements = {str(a["id"]): a for a in await _agreements(ctx)}
    lines = [f"Producer split on **{policy.get('policy_number')}**:"]
    for r in rows:
        p, a = payees.get(str(r["source_id"]), {}), agreements.get(str(r["agreement_id"]), {})
        lines.append(f"- {p.get('name', r['source_id'])} ({p.get('code', '—')}) · **{_pct(r['split_pct'])}** under "
                     f"`{a.get('code', '?')}` v{a.get('version', '?')} (first year {_pct(a.get('first_year_pct'))}, renewal {_pct(a.get('renewal_pct'))})")
    return rows, "\n".join(lines)


@handles("get_policy_commission_split")
async def _get_policy_commission_split(args: dict, ctx: Ctx) -> dict:
    from servicing_tools import resolve_policy
    policy = await resolve_policy(args, ctx)
    rows, text = await _split_view(ctx, policy)
    qa = [] if rows else [_chip("Assign producers", f"Assign producers on policy {policy.get('policy_number')}")]
    return {"success": True, "assignments": rows, "message": text, "quick_actions": qa + [_NAV]}


@handles("assign_policy_producers")
@relay_forbidden
async def _assign_policy_producers(args: dict, ctx: Ctx) -> dict:
    from servicing_tools import resolve_policy
    policy = await resolve_policy(args, ctx)
    number = policy.get("policy_number")
    wanted = _parse_json_arg(args.get("producers_json"), "producers_json") if args.get("producers_json") else None
    if wanted is None and args.get("payee_name"):
        wanted = [{"payee": args["payee_name"], "agreement_code": args.get("agreement_code"), "split_pct": 100}]
    if not wanted:
        return {"success": False, "needs_user_input": True, "error_code": "missing_details",
                "error": f"Who produced {number}, under which agreement code, and (if shared) what split? Splits must total 100%."}
    if isinstance(wanted, dict):
        wanted = [wanted]
    payees, agreements = await _payees(ctx), await _agreements(ctx)
    producers, described = [], []
    for w in wanted:
        payee = _pick_payee(payees, str(w.get("payee") or w.get("payee_name") or ""))
        code = w.get("agreement_code")
        approved = _pick_agreement(agreements, code, w.get("agreement_version"), "APPROVED") if code else []
        if not approved:
            ready = sorted({a["code"] for a in agreements if a["status"] == "APPROVED"})
            raise ChoiceNeeded(f"Which approved agreement does {payee['name']} earn under on {number}?",
                               [_chip(c, f"Assign {payee['code']} on policy {number} under agreement {c}") for c in ready[:6]]
                               or [_chip("List agreements", "List commission agreements")])
        producers.append({"source_id": payee["id"], "agreement_id": approved[0]["id"], "split_pct": str(w.get("split_pct") or 100)})
        described.append(f"{payee['name']} {_pct(w.get('split_pct') or 100)} under {approved[0]['code']} v{approved[0]['version']}")

    total = sum(Decimal(p["split_pct"]) for p in producers)
    if total != 100:
        return {"success": False, "needs_user_input": True, "error_code": "validation",
                "error": f"The splits add up to {_pct(total)} — they must total exactly 100%."}
    current, _ = await _split_view(ctx, policy)
    if sorted((str(r["source_id"]), str(r["agreement_id"]), Decimal(str(r["split_pct"]))) for r in current) == \
            sorted((str(p["source_id"]), str(p["agreement_id"]), Decimal(p["split_pct"])) for p in producers):
        return {"success": True, "message": f"{number} already has exactly that split — nothing changed.", "quick_actions": [_NAV]}
    res = await ctx.client.put(ctx.tsvc(f"/commissions/policies/{policy['id']}/assignments"), json={"producers": producers})
    res.raise_for_status()
    rows, text = await _split_view(ctx, policy)
    return {"success": True, "assignments": rows,
            "message": f"Assigned on {number}: " + "; ".join(described) + ".\n\n" + text
                       + "\n\nReceipts already sitting in exceptions are not re-posted automatically — reconcile them.",
            "last_action": _action("assign_policy_producers", "policy", str(policy["id"]), "commissions", f"{number} producers"),
            "quick_actions": [_chip("Reconcile this policy", f"Reconcile commission receipts on policy {number}"), _NAV]}


# ── Exceptions & reconciliation ──────────────────────────────────────────────

async def _exceptions(ctx: Ctx, limit: int = 500) -> list[dict]:
    res = await ctx.client.get(ctx.tsvc("/commissions/exceptions"), params={"limit": limit})
    res.raise_for_status()
    return res.json()


@handles("list_commission_exceptions")
async def _list_commission_exceptions(args: dict, ctx: Ctx) -> dict:
    rows = await _exceptions(ctx)
    if not rows:
        return {"success": True, "exceptions": [], "message": "No commission exceptions — every recorded receipt has posted.",
                "quick_actions": [_NAV]}
    numbers = await _policy_numbers(ctx)
    by_reason: dict[str, list[str]] = {}
    for r in rows:
        by_reason.setdefault(r.get("reason") or "Unspecified", []).append(numbers.get(str(r["policy_id"]), str(r["policy_id"])))
    lines = [f"**{len(rows)}** premium receipt(s) did not post commission:"]
    for reason, pols in sorted(by_reason.items(), key=lambda kv: -len(kv[1])):
        uniq = sorted(set(pols))
        lines.append(f"- {reason} — {len(pols)} receipt(s) on {', '.join(uniq[:5])}" + (f" +{len(uniq) - 5} more" if len(uniq) > 5 else ""))
    unassigned = sorted({numbers.get(str(r["policy_id"])) for r in rows if "No producer agreement assigned" in (r.get("reason") or "")} - {None})
    qa = [_chip(f"Assign producers on {n}", f"Assign producers on policy {n}") for n in unassigned[:3]]
    qa.append(_chip("Reconcile all", "Reconcile all commission exceptions"))
    qa.append(_NAV)
    return {"success": True, "exceptions": rows, "message": "\n".join(lines), "quick_actions": qa[:6]}


@handles("reconcile_commission_receipts")
@relay_forbidden
async def _reconcile_commission_receipts(args: dict, ctx: Ctx) -> dict:
    rows = await _exceptions(ctx)
    scope = "all open exceptions"
    if args.get("policy_number") or args.get("policyholder_name") or args.get("cnic"):
        from servicing_tools import resolve_policy
        policy = await resolve_policy(args, ctx)
        rows = [r for r in rows if str(r["policy_id"]) == str(policy["id"])]
        scope = f"policy {policy.get('policy_number')}"
    if not rows:
        return {"success": True, "message": f"Nothing to reconcile for {scope} — no receipts are in exception.", "quick_actions": [_NAV]}
    receipt_ids = list(dict.fromkeys(str(r["receipt_id"]) for r in rows))[:100]
    res = await ctx.client.post(ctx.tsvc("/commissions/reconcile"), json={"receipt_ids": receipt_ids})
    res.raise_for_status()
    results = res.json()
    posted = [r for r in results if r.get("status") == "POSTED"]
    still = [r for r in results if r.get("status") != "POSTED"]
    lines = [f"Re-ran accrual for {len(results)} receipt(s) in {scope}: **{len(posted)} posted**, {len(still)} still in exception."]
    reasons: dict[str, int] = {}
    for r in still:
        reasons[r.get("reason") or "Unspecified"] = reasons.get(r.get("reason") or "Unspecified", 0) + 1
    lines += [f"- {reason} ({n})" for reason, n in reasons.items()]
    if len(dict.fromkeys(str(r["receipt_id"]) for r in rows)) > 100:
        lines.append("Only the first 100 receipts were processed — run it again for the rest.")
    return {"success": True, "results": results, "message": "\n".join(lines),
            "last_action": _action("reconcile_commission_receipts", "commission", "", "commissions", f"{len(posted)} posted"),
            "quick_actions": [_chip("Show remaining exceptions", "List commission exceptions"), _NAV] if still else [_NAV]}


# ── Explanation (any commission reader; an agent sees only their own) ────────

@handles("explain_commission_earning")
async def _explain_commission_earning(args: dict, ctx: Ctx) -> dict:
    if args.get("earning_id"):
        res = await ctx.client.get(ctx.tsvc(f"/commissions/earnings/{args['earning_id']}"))
        res.raise_for_status()
        rows = [res.json()]
    else:
        number = (args.get("policy_number") or "").strip().upper()
        if not number:
            return {"success": False, "needs_user_input": True, "error_code": "missing_details",
                    "error": "Which policy number (or earning id) should I explain?"}
        res = await ctx.client.get(ctx.tsvc("/commissions/earnings"), params={"limit": 500})
        res.raise_for_status()
        rows = [e for e in res.json().get("items", []) if ((e.get("snapshot") or {}).get("policy_number") or "").upper() == number]
        if not rows:
            return {"success": True, "earnings": [], "quick_actions": [_NAV],
                    "message": f"No earnings you can see were posted on {number}. Either no premium receipt has been "
                               "recorded yet, or it is sitting in a commission exception (an administrator can check)."}
    lines = []
    total = Decimal(0)
    for e in rows:
        s = e.get("snapshot") or {}
        total += Decimal(str(e["gross_amount"]))
        lines.append(
            f"- **{s.get('payee_name', '—')}** on `{s.get('policy_number', '—')}` receipt {s.get('receipt_no', '—')} "
            f"({str(s.get('receipt_date', ''))[:10]}), policy year {e['policy_year']}: "
            f"{_pkr(e['basis_amount'])} × {_pct(e['rate_pct'])} × {_pct(e['split_pct'])} split = **{_pkr(e['gross_amount'])}** "
            f"under `{s.get('agreement_code', '?')}` v{s.get('agreement_version', '?')}")
    return {"success": True, "earnings": rows,
            "message": "\n".join(lines) + f"\n\nTotal accrued gross: **{_pkr(total)}**. Basis is the receipt base "
                       "(fees and duty included, surcharge excluded). This is an accrual — no tax or payment is implied.",
            "quick_actions": [_NAV]}
