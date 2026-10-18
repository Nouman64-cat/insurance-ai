"""Commission administration on the persistent commission engine
(tenant-service routers/commissions.py, services/commission_engine.py).

The engine posts against explicit policy producers or automatically allocates the
customer's assigned agent; the rate comes from rule set RS-COM-002 in the rule
engine. Missing configuration becomes a durable exception. The tools support:

  rules         list_commission_rules, get_commission_rate_card, create/update/delete/
                toggle_commission_rule, deploy_commission_rules  (edits go to a draft)
  preview       calculate_commission           (same path as posting; writes nothing)
  allocation    get_policy_commission_split, assign_policy_producers, set_producer_start_date
  exceptions    list_commission_exceptions, reconcile_commission_receipts
  explanation   explain_commission_earning     (agents see only their own)
  payouts       list_payable_commissions, list_payout_runs, create_payout_run,
                approve_payout_run             (maker-checker: a different admin approves)
  agreements    list/create/approve_commission_agreement  (legacy: no longer set rates)

Recording the external payment stays in the portal: the chat never confirms that
money moved. Tax and clawback are not automated.

Registered by being imported at the foot of tool_executor.py.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

import httpx

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
    if not n:
        raise LookupError("Name a registered producer or provide their exact code.")
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
             f"Commission rates come from rule set {data.get('commission_rule_set_code', 'RS-COM-002')} in the Rule Engine."]
    if not data['policies']:
        lines.append('No individual policy exists yet. Customer ownership alone does not accrue commission.')
    for p in data['policies']:
        lines.append(f"- {p.get('policy_number') or p['id']} · {p['product_name']}: " +
                     ('configured for receipts dated today' if p['ready'] else '; '.join(p['blocking_reasons'])) +
                     ('; producer assignment frozen after posting' if p['frozen'] else ''))
    if data['has_more']:
        lines.append('Only the first 50 policies are shown; narrow the selection in Commission earnings.')
    lines.append('The first premium after issuance allocates 100% to the assigned agent automatically, at the rate the Rule Engine sets; later premiums earn only if that rule is recurring. Explicit policy splits override automatic allocation. Each earning is payable from the agent\'s start day in the following month. Disbursement batches require independent approval and recorded external payment confirmation; bank transfers and tax calculations are not automated.')
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
        return {"success": True, "agreements": [], "message": "No legacy commission agreements match. Live rates come from "
                "RS-COM-002; agreements do not control current earnings.",
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
            "message": f"Drafted legacy agreement {_agreement_label(a)}. A different administrator may approve the historical record. "
                       "Current commission rates still come from RS-COM-002; this agreement does not change earnings.",
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
            "message": f"Approved legacy agreement {_agreement_label(a)}. It is now immutable. Live commission rates still come from RS-COM-002.",
            "last_action": _action("approve_commission_agreement", "commission_agreement", str(a["id"]), "commissions", f"{a['code']} v{a['version']} approved"),
            "quick_actions": [_chip("Show live commission rules", "List commission rules"), _NAV]}


# ── Policy allocation ────────────────────────────────────────────────────────

async def _split_view(ctx: Ctx, policy: dict) -> tuple[list[dict], str]:
    res = await ctx.client.get(ctx.tsvc(f"/commissions/policies/{policy['id']}/assignments"))
    res.raise_for_status()
    rows = res.json()
    if not rows:
        return rows, f"No explicit producers are assigned on {policy.get('policy_number')}. The next premium receipt can automatically allocate to the customer's assigned agent. Check customer commission setup to verify readiness."
    payees = {str(p["id"]): p for p in await _payees(ctx)}
    lines = [f"Producer split on **{policy.get('policy_number')}** (rates set by the Rule Engine):"]
    for r in rows:
        p = payees.get(str(r["source_id"]), {})
        lines.append(f"- {p.get('name', r['source_id'])} ({p.get('code', '—')}) · **{_pct(r['split_pct'])}**")
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
        wanted = [{"payee": args["payee_name"], "split_pct": 100}]
    if not wanted:
        return {"success": False, "needs_user_input": True, "error_code": "missing_details",
                "error": f"Who produced {number}, and (if shared) what split? Splits must total 100%."}
    if isinstance(wanted, dict):
        wanted = [wanted]
    payees = await _payees(ctx)
    producers, described = [], []
    for w in wanted:
        if not isinstance(w, dict):
            raise ValueError("Each producer needs a name/code and positive split percentage.")
        payee = _pick_payee(payees, str(w.get("payee") or w.get("payee_name") or ""))
        split = Decimal(str(w["split_pct"] if w.get("split_pct") is not None else 100))
        if not split.is_finite() or not 0 < split <= 100:
            return {"success": False, "needs_user_input": True, "error_code": "validation",
                    "error": "Every producer split must be greater than zero and no more than 100%. Nothing was assigned."}
        producers.append({"source_id": payee["id"], "split_pct": str(split)})
        described.append(f"{payee['name']} {_pct(split)}")

    total = sum(Decimal(p["split_pct"]) for p in producers)
    if total != 100:
        return {"success": False, "needs_user_input": True, "error_code": "validation",
                "error": f"The splits add up to {_pct(total)} — they must total exactly 100%."}
    current, _ = await _split_view(ctx, policy)
    if sorted((str(r["source_id"]), Decimal(str(r["split_pct"]))) for r in current) == \
            sorted((str(p["source_id"]), Decimal(p["split_pct"])) for p in producers):
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
            + (f"under rule `{s['rule_code']}` v{s.get('rule_version', '?')}, payable from {e.get('disburse_date') or '—'}"
               if s.get('rule_code') else f"under `{s.get('agreement_code', '?')}` v{s.get('agreement_version', '?')}"))
    return {"success": True, "earnings": rows,
            "message": "\n".join(lines) + f"\n\nTotal accrued gross: **{_pkr(total)}**. Basis is the receipt base "
                       "(fees and duty included, surcharge excluded). This is an accrual — no tax or payment is implied.",
            "quick_actions": [_NAV]}


# ── Agent commission rules (RS-COM-002 in the rule engine) ───────────────────
#
# Rates live in the rule engine: the matched rule's commission % is paid on the
# first premium after issuance; later premiums earn only when it is recurring.
# Edits go into a DRAFT version and are live only after deploy_commission_rules.

_COMMISSION_RULE_SET = "RS-COM-002"
_RULES_NAV = {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"}
_RULE_FIELDS = ("commission_pct", "commission_recurring", "recurring_commission_pct", "recurring_years", "withholding_tax_pct")


def _criterion_text(c: dict) -> str:
    value = c.get("value_list") or c.get("value_string")
    if value is None:
        value = c.get("value_numeric")
    if c.get("operator") == "between":
        value = f"{c.get('value_range_min')}–{c.get('value_range_max')}"
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return f"{c.get('field_name')} {c.get('operator')} {value}"


def _commission_rule_text(r: dict) -> str:
    d = r.get("impact_data") or {}
    groups: dict[int, list[str]] = {}
    for c in r.get("criteria") or []:
        groups.setdefault(c.get("group_id") or 1, []).append(_criterion_text(c))
    when = " or ".join("(" + " and ".join(g) + ")" for g in groups.values()) or "every premium"
    if d.get("commission_pct") is None:
        pays = "no commission rate set"
    else:
        pays = f"**{_pct(d['commission_pct'])}** of the first premium"
        if d.get("commission_recurring"):
            rate = d.get("recurring_commission_pct")
            pays += f"; recurring at **{_pct(d['commission_pct'] if rate is None else rate)}**"
            pays += f" through policy year {d['recurring_years']}" if d.get("recurring_years") else " with no year limit"
        else:
            pays += "; not recurring"
    if d.get("withholding_tax_pct") is not None:
        pays += f"; WHT {_pct(d['withholding_tax_pct'])}"
    state = "" if r.get("is_active", True) else " _(off)_"
    return f"- `{r.get('rule_code')}` p{r.get('priority')} **{r.get('name')}**{state} — when {when}: {pays}"


async def _commission_rule_set(ctx: Ctx) -> tuple[dict, dict, Optional[dict], Optional[dict]]:
    from tool_executor import _rule_set_detail, _version_with_status
    rs, detail = await _rule_set_detail(ctx, _COMMISSION_RULE_SET)
    return rs, detail, _version_with_status(detail, "ACTIVE"), _version_with_status(detail, "DRAFT")


def _deploy_chip(draft: dict) -> dict:
    return _chip(f"Deploy draft v{draft.get('version_number')}", "Deploy the commission rules draft")


@handles("list_commission_rules")
async def _list_commission_rules(args: dict, ctx: Ctx) -> dict:
    _rs, detail, active, draft = await _commission_rule_set(ctx)
    needle = (args.get("search") or "").strip().casefold()
    def pick(version):
        rules = sorted((version or {}).get("rules") or [], key=lambda r: r.get("priority", 999))
        return [r for r in rules if not needle or needle in (r.get("rule_code") or "").casefold() or needle in (r.get("name") or "").casefold()]
    lines = [f"**{detail.get('name')}** (`{_COMMISSION_RULE_SET}`). The first matching rule by priority decides the rate."]
    if active:
        lines.append(f"\n**Live — v{active.get('version_number')}:**")
        lines += [_commission_rule_text(r) for r in pick(active)] or ["- No matching rules."]
    else:
        lines.append("\nNo version is live: every premium is held as a commission exception.")
    qa = [_RULES_NAV]
    if draft:
        lines.append(f"\n**Draft v{draft.get('version_number')} (not live yet):**")
        lines += [_commission_rule_text(r) for r in pick(draft)] or ["- No matching rules."]
        qa.insert(0, _deploy_chip(draft))
    return {"success": True, "message": "\n".join(lines), "active_version": active, "draft_version": draft, "quick_actions": qa}


@handles("get_commission_rate_card")
async def _get_commission_rate_card(args: dict, ctx: Ctx) -> dict:
    if (args.get("segment") or "individual").lower() != "individual":
        return {"success": True, "message": "Agent commission is posted for individual policies only. Group and family "
                                            "premiums are held as commission exceptions; no rate applies to them yet.",
                "quick_actions": [_NAV]}
    year = int(args.get("policy_year") or 1)
    number = int(args.get("premium_number") or (1 if year == 1 else 2))
    amount = args.get("premium_amount")
    channel = (args.get("channel") or "AGENT").strip().upper()
    channel = {"DIRECT_AGENCY": "AGENT", "DIGITAL_DIRECT": "DIGITAL"}.get(channel, channel)
    body = {"policy_year": year, "installment_number": number, "premium_amount": str(amount or 0),
            "source_type": channel, "channel_code": channel,
            "insurance_type": args.get("insurance_type"), "product_name": args.get("product_name")}
    res = await ctx.client.post(ctx.tsvc("/commissions/rate-preview"), json=body)
    res.raise_for_status()
    data = res.json()
    which = "the first premium after issuance" if number == 1 else f"premium {number} (policy year {year})"
    if not data["matched"]:
        return {"success": True, "preview": data, "quick_actions": [_chip("Show commission rules", "List the commission rules"), _RULES_NAV],
                "message": f"No commission applies to {which}: {data['reason']}. Such a premium is held as a commission exception."}
    lines = [f"On {which} through {channel}: rule `{data['rule_code']}` v{data['rule_version']}."]
    if data["payable"]:
        lines.append(f"Rate **{_pct(data['rate_pct'])}**" + (f" → **{_pkr(data['gross_amount'])}** on {_pkr(amount)}" if amount else "") + ".")
    else:
        lines.append(f"**No commission** — {data['reason']}.")
    lines.append("The rule is recurring; its eligibility and year limits still apply." if data["recurring"] else "Later premiums earn nothing under this rule (not recurring).")
    if data.get("withholding_tax_pct") is not None:
        lines.append(f"Withholding tax {_pct(data['withholding_tax_pct'])} is recorded on the earning; net amounts are not calculated.")
    lines.append("Each earning is payable on the agent's start day in the month after the premium is collected.")
    return {"success": True, "preview": data, "message": " ".join(lines),
            "quick_actions": [_chip("Show commission rules", "List the commission rules"), _NAV]}


@handles("calculate_commission")
async def _calculate_commission(args: dict, ctx: Ctx) -> dict:
    from servicing_tools import resolve_policy
    policy = await resolve_policy(args, ctx)
    params: dict[str, Any] = {}
    if args.get("collected_premium") is not None:
        params["amount"] = str(args["collected_premium"])
    if args.get("premium_number"):
        params["installment"] = int(args["premium_number"])
    res = await ctx.client.get(ctx.tsvc(f"/commissions/policies/{policy['id']}/preview"), params=params)
    if res.status_code == 404 and params.get("installment"):
        return {"success": False, "message": f"{policy.get('policy_number')} has no premium {params['installment']}."}
    res.raise_for_status()
    data = res.json()
    number = data.get("policy_number") or policy.get("policy_number")
    if not data["ready"]:
        return {"success": True, "preview": data, "quick_actions": [_chip("Check commission setup", f"Check commission setup for policy {number}"), _NAV],
                "message": f"A premium on {number} would not post commission: {data['reason']}."}
    which = "first premium after issuance" if data["is_first_premium"] else f"installment {data['installment_number']} (policy year {data['policy_year']})"
    lines = [f"Commission preview for **{number}** — {which} due {data['due_date']}, basis {_pkr(data['basis_amount'])}:"]
    for p in data["producers"]:
        if p["payable"]:
            lines.append(f"- **{p['payee_name']}** ({p['payee_code']}) · {_pct(p['split_pct'])} split × {_pct(p['rate_pct'])} under "
                         f"`{p['rule_code']}` v{p['rule_version']} = **{_pkr(p['gross_amount'])}**, payable from "
                         f"{p['disburse_date_if_collected_today']} if collected today")
        else:
            lines.append(f"- **{p['payee_name']}** ({p['payee_code']}) · no commission — {p['reason']}")
    lines.append("Preview only — nothing was posted. Gross amounts; withholding tax is not deducted.")
    return {"success": True, "preview": data, "message": "\n".join(lines), "quick_actions": [_NAV]}


def _commission_impact(existing: dict, args: dict) -> dict:
    data = {**(existing or {})}
    for key in _RULE_FIELDS:
        if args.get(key) is not None:
            data[key] = args[key]
    if data.get("recurring_years") == 0:
        data["recurring_years"] = None   # 0 means "no year limit"
    if args.get("reason"):
        data["reason"] = args["reason"]
    data["is_terminal"] = True   # the first matching commission rule decides
    return data


def _commission_conditions(raw):
    parsed = _parse_json_arg(raw, "conditions_json")
    if parsed is None:
        return None
    conditions = parsed if isinstance(parsed, list) else [parsed]
    fields = {"category", "insurance_type", "product_name", "policy_year", "premium_type",
              "installment_number", "is_first_premium", "premium_amount", "coverage_amount",
              "term_years", "source_type", "source_code", "channel_code"}
    for condition in conditions:
        if not isinstance(condition, dict) or (condition.get("field") or condition.get("field_name")) not in fields:
            raise ValueError("Each commission condition needs a supported field and value; no draft was changed.")
        if condition.get("operator", "eq").lower() not in {"eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "in_set", "contains"}:
            raise ValueError("Unsupported commission condition operator; no draft was changed.")
        if "value" not in condition or condition["value"] is None:
            raise ValueError("Each commission condition needs a value; no draft was changed.")
        if condition.get("operator") == "between" and (not isinstance(condition["value"], list) or len(condition["value"]) != 2):
            raise ValueError("A between condition needs two bounds; no draft was changed.")
        if condition.get("operator") in {"in", "in_set"} and not isinstance(condition["value"], list):
            raise ValueError("An in condition needs a list of values; no draft was changed.")
    return conditions


@handles("create_commission_rule")
@relay_forbidden
async def _create_commission_rule(args: dict, ctx: Ctx) -> dict:
    from tool_executor import _draft_for, _rules, _to_criteria
    conditions = _commission_conditions(args.get("conditions_json")) or []
    rs, draft, _code = await _draft_for(ctx, _COMMISSION_RULE_SET)
    code = args["rule_code"].strip().upper()
    if any((r.get("rule_code") or "").upper() == code for r in draft.get("rules") or []):
        return {"success": False, "error_code": "validation",
                "message": f"`{code}` already exists in the draft — update it instead, or choose another code."}
    body = {"name": args["name"], "rule_code": code, "priority": int(args["priority"] if args.get("priority") is not None else 50), "is_active": True,
            "impact_type": "AUTO_APPROVE", "action_outcome": "APPLY_COMMISSION_RATE",
            "impact_data": _commission_impact({"commission_recurring": False}, args),
            "criteria": _to_criteria([{"field": "category", "operator": "eq", "value": "Individual"},
                                      *(conditions if isinstance(conditions, list) else [conditions])])}
    res = await ctx.client.post(_rules(ctx, f"/versions/{draft['id']}/rules"), json=body)
    res.raise_for_status()
    return {"success": True, "rule": res.json(),
            "message": f"Added to DRAFT v{draft.get('version_number')} (not live yet):\n{_commission_rule_text(body)}",
            "last_action": _action("create_commission_rule", "rule_set", str(rs["id"]), "admin/rule-engine", f"Commission rule {code} drafted"),
            "quick_actions": [_deploy_chip(draft), _RULES_NAV]}


async def _draft_rule(ctx: Ctx, rule_code: str) -> tuple[dict, dict, dict]:
    from tool_executor import _draft_for, _find_rule
    rs, draft, _code = await _draft_for(ctx, _COMMISSION_RULE_SET)
    return rs, draft, _find_rule(draft, rule_code)


async def _put_rule(ctx: Ctx, draft: dict, rule: dict, body: dict) -> None:
    from tool_executor import _rules
    res = await ctx.client.put(_rules(ctx, f"/versions/{draft['id']}/rules/{rule['id']}"), json=body)
    res.raise_for_status()


@handles("update_commission_rule")
@relay_forbidden
async def _update_commission_rule(args: dict, ctx: Ctx) -> dict:
    from tool_executor import _to_criteria
    if not any(args.get(key) is not None for key in (*_RULE_FIELDS, "reason", "name", "priority", "conditions_json")):
        return {"success": False, "needs_user_input": True, "error_code": "missing_details",
                "error": "What should change — rate, recurring, recurring years, name, priority or conditions?"}
    conditions = _commission_conditions(args.get("conditions_json"))
    rs, draft, rule = await _draft_rule(ctx, args["rule_code"])
    body: dict[str, Any] = {}
    if any(args.get(k) is not None for k in _RULE_FIELDS) or args.get("reason"):
        body["impact_data"] = _commission_impact(rule.get("impact_data"), args)
    for key in ("name", "priority"):
        if args.get(key) is not None:
            body[key] = args[key]
    if conditions is not None:
        body["criteria"] = _to_criteria(conditions if isinstance(conditions, list) else [conditions])
    if not body:
        return {"success": False, "needs_user_input": True, "error_code": "missing_details",
                "error": f"What should change on `{rule.get('rule_code')}` — the rate, recurring, recurring rate or years, or its conditions?"}
    await _put_rule(ctx, draft, rule, body)
    updated = {**rule, **{k: v for k, v in body.items() if k != "criteria"}}
    if "criteria" in body:
        updated["criteria"] = body["criteria"]
    return {"success": True,
            "message": f"Updated in DRAFT v{draft.get('version_number')} (not live yet):\n{_commission_rule_text(updated)}",
            "last_action": _action("update_commission_rule", "rule_set", str(rs["id"]), "admin/rule-engine", f"Commission rule {rule.get('rule_code')} updated"),
            "quick_actions": [_deploy_chip(draft), _RULES_NAV]}


@handles("toggle_commission_rule_active")
@relay_forbidden
async def _toggle_commission_rule_active(args: dict, ctx: Ctx) -> dict:
    rs, draft, rule = await _draft_rule(ctx, args["rule_code"])
    active = not rule.get("is_active", True)
    await _put_rule(ctx, draft, rule, {"is_active": active})
    return {"success": True,
            "message": f"`{rule.get('rule_code')}` switched **{'on' if active else 'off'}** in DRAFT v{draft.get('version_number')} (not live yet).",
            "last_action": _action("toggle_commission_rule_active", "rule_set", str(rs["id"]), "admin/rule-engine", f"Commission rule {rule.get('rule_code')} toggled"),
            "quick_actions": [_deploy_chip(draft), _RULES_NAV]}


@handles("delete_commission_rule")
@relay_forbidden
async def _delete_commission_rule(args: dict, ctx: Ctx) -> dict:
    from tool_executor import _rules
    rs, draft, rule = await _draft_rule(ctx, args["rule_code"])
    res = await ctx.client.delete(_rules(ctx, f"/rules/{rule['id']}"))
    res.raise_for_status()
    left = len(draft.get("rules") or []) - 1
    warn = " With no rules left, every premium would be held as a commission exception once deployed." if left <= 0 else ""
    return {"success": True,
            "message": f"Removed `{rule.get('rule_code')}` from DRAFT v{draft.get('version_number')} (not live yet).{warn}",
            "last_action": _action("delete_commission_rule", "rule_set", str(rs["id"]), "admin/rule-engine", f"Commission rule {rule.get('rule_code')} removed"),
            "quick_actions": [_deploy_chip(draft), _RULES_NAV]}


@handles("deploy_commission_rules")
@relay_forbidden
async def _deploy_commission_rules(args: dict, ctx: Ctx) -> dict:
    from tool_executor import _rules
    rs, _detail, active, draft = await _commission_rule_set(ctx)
    if not draft:
        return {"success": False, "message": "There is no commission rules draft to deploy. Change a rule first; that opens a draft.",
                "quick_actions": [_chip("Show commission rules", "List the commission rules")]}
    res = await ctx.client.patch(_rules(ctx, f"/versions/{draft['id']}/status"),
                                 json={"status": "ACTIVE", "approved_by": ctx.exec_ctx.role or "AI Copilot"})
    res.raise_for_status()
    was = f", replacing v{active.get('version_number')}" if active else ""
    rules = sorted(draft.get("rules") or [], key=lambda r: r.get("priority", 999))
    return {"success": True,
            "message": f"Commission rules v{draft.get('version_number')} are live{was}. Premiums posted from now on use:\n"
                       + ("\n".join(_commission_rule_text(r) for r in rules) or "- no rules (every premium will be held as an exception)")
                       + "\n\nEarnings already posted keep their original rate.",
            "last_action": _action("deploy_commission_rules", "rule_set", str(rs["id"]), "admin/rule-engine", f"Commission rules v{draft.get('version_number')} deployed"),
            "quick_actions": [_chip("Preview a rate", "What commission does an agent get on the first premium?"), _RULES_NAV]}


# ── Producer payout day ──────────────────────────────────────────────────────

@handles("set_producer_start_date")
@relay_forbidden
async def _set_producer_start_date(args: dict, ctx: Ctx) -> dict:
    try:
        start = date.fromisoformat(str(args["start_date"]).strip())
    except ValueError:
        return {"success": False, "needs_user_input": True, "error_code": "validation",
                "error": "Give the start date as YYYY-MM-DD, e.g. 2024-03-15."}
    if start > date.today():
        return {"success": False, "error_code": "validation", "error": "The start date cannot be in the future."}
    payee = _pick_payee(await _payees(ctx), str(args["payee_name"]))
    res = await ctx.client.put(ctx.tsvc(f"/acquisition-sources/{payee['id']}"), json={"start_date": start.isoformat()})
    res.raise_for_status()
    return {"success": True,
            "message": f"{payee['name']} ({payee['code']}) started on {start.isoformat()}: commission earned in a month is now payable on "
                       f"day {start.day} of the following month (the month's last day when it is shorter). Earnings already posted keep their payout date.",
            "last_action": _action("set_producer_start_date", "acquisition_source", str(payee["id"]), "admin/acquisition-sources", f"{payee['code']} start date set"),
            "quick_actions": [{"label": "Open acquisition sources", "actionType": "navigate", "payload": "admin/acquisition-sources"}]}


# ── Disbursement batches (payout runs) ──────────────────────────────────────
#
# Maker-checker stays with tenant-service: a different administrator approves,
# and payment is recorded in the portal only after the external transfer — the
# chat never confirms that money moved.

async def _candidates(ctx: Ctx) -> list[dict]:
    rows, offset = [], 0
    while True:
        res = await ctx.client.get(ctx.tsvc("/commissions/disbursements/eligible"), params={"offset": offset})
        res.raise_for_status()
        page = res.json()
        rows += page["items"]
        if not page.get("has_more") or len(rows) >= 1000:
            return rows
        offset += len(page["items"])


def _earning_line(e: dict, hold: Optional[str] = None) -> str:
    s = e.get("snapshot") or {}
    when = f", payable from {e['disburse_date']}" if e.get("disburse_date") else ""
    return (f"- {s.get('payee_name', '—')} · {s.get('policy_number') or e.get('policy_id')} · receipt {s.get('receipt_no', '—')}: "
            f"**{_pkr(e['gross_amount'])}**{when}" + (f" — held: {hold}" if hold else ""))


async def _payee_filter(ctx: Ctx, args: dict) -> Optional[dict]:
    return _pick_payee(await _payees(ctx), str(args["payee_name"])) if args.get("payee_name") else None


@handles("list_payable_commissions")
@relay_forbidden
async def _list_payable_commissions(args: dict, ctx: Ctx) -> dict:
    payee = await _payee_filter(ctx, args)
    rows = [r for r in await _candidates(ctx) if not payee or str(r["earning"]["source_id"]) == str(payee["id"])]
    ready = [r["earning"] for r in rows if not r["hold_reason"]]
    held = [r for r in rows if r["hold_reason"]]
    who = f" for {payee['name']}" if payee else ""
    if not rows:
        return {"success": True, "message": f"No commission earnings{who} are waiting for a disbursement batch.", "quick_actions": [_NAV]}
    lines = [f"**Payable now{who}: {len(ready)} earning(s), {_pkr(sum(Decimal(str(e['gross_amount'])) for e in ready))}**"]
    lines += [_earning_line(e) for e in ready[:15]]
    if held:
        lines.append(f"\n**Held: {len(held)}**")
        lines += [_earning_line(r["earning"], r["hold_reason"]) for r in held[:15]]
    if len(ready) > 15 or len(held) > 15:
        lines.append("Showing the first 15 of each; the rest are in Commission earnings.")
    if len(rows) >= 1000:
        lines.append("This scan is limited to the first 1,000 queued earnings; inspect the full queue in Commission earnings.")
    qa = [_chip("Create payout run", "Create a commission payout run" + (f" for {payee['code']}" if payee else ""))] if ready else []
    return {"success": True, "payable": ready, "held": held, "message": "\n".join(lines), "quick_actions": qa + [_NAV]}


@handles("create_payout_run")
@relay_forbidden
async def _create_payout_run(args: dict, ctx: Ctx) -> dict:
    payee = await _payee_filter(ctx, args)
    ready = [r["earning"] for r in await _candidates(ctx) if not r["hold_reason"]
             and (not payee or str(r["earning"]["source_id"]) == str(payee["id"]))]
    if args.get("period"):
        ready = [e for e in ready if str(e.get("created_at", ""))[:7] == args["period"]]
    if not ready:
        return {"success": False, "message": "No commission earnings are payable now for that selection — nothing was created. "
                                             "Ask which commissions are due to see what is held and why.",
                "quick_actions": [_chip("Show payable commissions", "Which commissions are payable?")]}
    selected_count = len(ready)
    ready = ready[:100]   # one batch holds at most 100 earnings
    res = await ctx.client.post(ctx.tsvc("/commissions/disbursements"), json={"earning_ids": [e["id"] for e in ready]})
    res.raise_for_status()
    batch = res.json()
    short = str(batch["id"])[:8]
    try:
        submitted = await ctx.client.post(ctx.tsvc(f"/commissions/disbursements/{batch['id']}/submit"))
        if submitted.is_success:
            batch = submitted.json()
            state = "submitted for approval"
        else:
            state = f"saved as a DRAFT — submission failed (HTTP {submitted.status_code}); submit this existing batch in Commission earnings"
    except httpx.HTTPError:
        # Creation already succeeded. A submit timeout must not lose its reference
        # or encourage another batch. Its outcome may be unknown until re-read.
        state = "created; submission could not be confirmed. Check this existing batch in Commission earnings before retrying"
    limit_note = (f" Only the first 100 of {selected_count} eligible earnings in the inspected queue were selected."
                  if selected_count > 100 else "")
    return {"success": True, "batch": batch,
            "message": f"Payout run `{short}` with {len(ready)} earning(s), gross **{_pkr(batch['gross_amount'])}**, {state}. "
                       f"A different administrator must approve it; payment is recorded in the portal after the transfer is made. No money has moved.{limit_note}",
            "last_action": _action("create_payout_run", "commission_disbursement", str(batch["id"]), "commissions", f"Payout run {short} created"),
            "quick_actions": [_NAV]}


async def _find_batch(ctx: Ctx, run_id: str) -> dict:
    needle = (run_id or "").strip().lower()
    res = await ctx.client.get(ctx.tsvc("/commissions/disbursements"))
    res.raise_for_status()
    hits = [b for b in res.json() if str(b["id"]).lower() == needle or str(b["id"]).lower().startswith(needle)] if needle else []
    if len(hits) != 1:
        raise LookupError(f'No single payout run matches "{run_id}". Ask me to list payout runs.')
    return hits[0]


@handles("list_payout_runs")
@relay_forbidden
async def _list_payout_runs(args: dict, ctx: Ctx) -> dict:
    res = await ctx.client.get(ctx.tsvc("/commissions/disbursements"))
    res.raise_for_status()
    rows = [b for b in res.json() if not args.get("status") or b["status"] == args["status"]]
    if not rows:
        return {"success": True, "runs": [], "message": "No commission payout runs match.", "quick_actions": [_NAV]}
    lines = [f"- `{str(b['id'])[:8]}` · **{b['status']}** · {_pkr(b['gross_amount'])} · created {str(b['created_at'])[:10]}"
             + (f" · paid ref {b['payment_reference']}" if b.get("payment_reference") else "") for b in rows[:20]]
    qa = [_chip(f"Approve {str(b['id'])[:8]}", f"Approve commission payout run {str(b['id'])[:8]}") for b in rows if b["status"] == "SUBMITTED"][:3]
    return {"success": True, "runs": rows, "message": "Commission payout runs:\n" + "\n".join(lines), "quick_actions": qa + [_NAV]}


@handles("approve_payout_run")
@relay_forbidden
async def _approve_payout_run(args: dict, ctx: Ctx) -> dict:
    batch = await _find_batch(ctx, args["run_id"])
    short = str(batch["id"])[:8]
    if batch["status"] != "SUBMITTED":
        return {"success": False, "message": f"Payout run `{short}` is {batch['status']}; only a submitted run can be approved."}
    res = await ctx.client.post(ctx.tsvc(f"/commissions/disbursements/{batch['id']}/approve"))
    if res.status_code in (403, 409):
        return {"success": False, "error_code": "forbidden" if res.status_code == 403 else "conflict",
                "message": f"Payout run `{short}` was not approved: {res.json().get('detail')}."}
    res.raise_for_status()
    return {"success": True, "batch": res.json(),
            "message": f"Approved payout run `{short}` ({_pkr(batch['gross_amount'])}). It is not paid yet: make the transfer, then record "
                       "the payment reference in Commission earnings.",
            "last_action": _action("approve_payout_run", "commission_disbursement", str(batch["id"]), "commissions", f"Payout run {short} approved"),
            "quick_actions": [_NAV]}
