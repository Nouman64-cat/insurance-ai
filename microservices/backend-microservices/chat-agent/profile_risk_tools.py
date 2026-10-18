"""Lead profile previews and persisted assessments using the lead-page API."""
from __future__ import annotations

from tool_executor import ChoiceNeeded, Ctx, _action, _full_name, _same_cnic, handles


def _chip(label: str, payload: str) -> dict:
    return {"label": label, "actionType": "submit", "payload": payload}


async def _customer(args: dict, ctx: Ctx, action: str = "Assess the risk profile of"):
    """Resolve one scoped customer without creating any underwriting records."""
    cnic, cid = args.get("cnic"), str(args.get("customer_id") or "").strip()
    name = str(args.get("customer_name") or "").strip()
    if not (cnic or cid or name):
        return {"success": False, "message": "Which customer should I assess? Give their name or CNIC."}
    res = await ctx.client.get(ctx.tsvc("/customers"))
    res.raise_for_status()
    rows = res.json()
    rows = rows if isinstance(rows, list) else rows.get("items", [])
    if cid:
        hits = [c for c in rows if str(c.get("id")) == cid]
    elif cnic and any(ch.isdigit() for ch in str(cnic)):
        hits = [c for c in rows if _same_cnic(c.get("cnic"), cnic)]
    else:
        needle = (name or str(cnic)).casefold()
        exact = [c for c in rows if _full_name(c).casefold() == needle]
        hits = exact or [c for c in rows if needle in _full_name(c).casefold()]
    if not hits:
        return {"success": False, "message": "I couldn't find that customer."}
    if len(hits) > 1:
        raise ChoiceNeeded("Which customer should I assess?", [
            _chip(f"{_full_name(c)} ({c.get('cnic') or c['id']})",
                  f"{action} customer_id {c['id']}") for c in hits[:6]])
    return hits[0]


@handles("assess_customer_risk_profile")
async def _assess_customer_risk_profile(args: dict, ctx: Ctx) -> dict:
    customer = await _customer(args, ctx)
    if "success" in customer:
        return customer
    params = {"coverage": args["coverage_amount"]} if args.get("coverage_amount") else None
    res = await ctx.client.get(ctx.tsvc(f"/customers/{customer['id']}/risk-profile"), params=params)
    if res.status_code == 404:
        return {"success": False, "message": "That customer isn't in your scope."}
    res.raise_for_status()
    return _format_profile(customer, res.json())


def _format_profile(customer: dict, r: dict) -> dict:
    cover = (f" for **PKR {r['cover_considered']:,.0f}**" + (f" ({r['plan_considered']})" if r.get("plan_considered") else "")
             if r.get("cover_considered") else "")
    parts = [f"**Risk profile — {r['name']}**{cover}",
             f"**{r['band']} risk** · Safe **{r['safe_pct']}%** · Risk **{r['risk_pct']}%** (together 100%)"]
    for cat in r.get("categories") or []:
        if not cat["share_pct"]:
            parts.append(f"**{cat['label']}** — not recorded ({', '.join(cat['missing'])}).")
            continue
        factors: dict[str, dict] = {}
        for side in ("safe", "risk"):
            for f in cat[f"{side}_factors"]:
                row = factors.setdefault(f["key"], {"label": f["label"], "detail": f["detail"], "safe": 0.0, "risk": 0.0})
                row[side] = f["contribution_pct"]
        table = "\n".join(f"| {f['label']} | {f['detail']} | {f['safe']:.1f}% | {f['risk']:.1f}% |" for f in factors.values())
        why = [f"- **{f['label']}**: {rule['reason']} _({rule['code']})_"
               for f in cat["risk_factors"] for rule in f.get("rules") or [] if rule.get("reason")]
        parts.append(
            f"**{cat['label']}** — {cat['band']} · {cat['share_pct']}% of the profile "
            f"(safe {cat['safe_pct']}%, risk {cat['risk_pct']}%)\n\n"
            "| Factor | Finding | Safe | Risk |\n|---|---|---|---|\n" + table
            + ("\n\nWhy:\n" + "\n".join(why) if why else ""))
    if r["missing"]:
        parts.append(f"Not recorded (left out, profile {r['completeness_pct']}% complete): " + ", ".join(r["missing"]) + ".")
    uw = r.get("underwriting") or {}
    implications = (["refer to an underwriter"] if uw.get("referral") else []) \
        + ([f"expected loading +{uw['extra_mortality_pct']:g}%"] if uw.get("extra_mortality_pct") else []) \
        + ([f"tests: {', '.join(uw['medical_tests'])}"] if uw.get("medical_tests") else [])
    if implications:
        parts.append("Underwriting implications: " + "; ".join(implications) + ".")
    rs = r.get("rule_set") or {}
    parts.append(f"_Risks decided by rule set {rs.get('code', 'RS-RISK-001')} v{rs.get('version', '')} (Rule Engine). "
                 "Screening view from the profile; the underwriting decision is made on the proposal._")
    actions = []
    if (customer.get("details") or {}).get("pending_plan") or r.get("plan_considered"):
        actions.append(_chip("Create proposal", f"Create the proposal for {_full_name(customer)} (customer_id {customer['id']})"))
    actions.append({"label": "Open customer", "actionType": "navigate", "payload": "admin/leads"})
    return {"success": True, "message": "\n\n".join(parts), "risk_profile": r, "quick_actions": actions}


@handles("run_customer_risk_assessment")
async def _run_customer_risk_assessment(args: dict, ctx: Ctx) -> dict:
    customer = await _customer(args, ctx, "Run and save the lead risk assessment for")
    if "success" in customer:
        return customer
    # Same operation as the lead's Risk Assessment button. No proposal, case or
    # document gates: this is profile screening, not case underwriting.
    res = await ctx.client.post(ctx.tsvc(f"/customers/{customer['id']}/risk-profile"))
    res.raise_for_status()
    r = res.json()
    result = _format_profile(customer, r)
    result["message"] = "Lead risk assessment saved.\n\n" + result["message"]
    result["last_action"] = _action("run_customer_risk_assessment", "customer",
                                    customer.get("cnic") or customer["id"], "admin/leads",
                                    f"Lead risk assessment saved for {_full_name(customer)}")
    return result


@handles("get_customer_risk_assessment")
async def _get_customer_risk_assessment(args: dict, ctx: Ctx) -> dict:
    customer = await _customer(args, ctx, "Show the saved lead risk assessment for")
    if "success" in customer:
        return customer
    res = await ctx.client.get(ctx.tsvc(f"/customers/{customer['id']}/risk-profile/latest"))
    res.raise_for_status()
    r = res.json().get("assessment")
    if r is None:
        return {"success": True, "assessment": None,
                "message": f"No saved lead risk assessment for {_full_name(customer)}. You can run one without creating a proposal or underwriting case."}
    result = _format_profile(customer, r)
    status = "Saved lead risk assessment"
    if r.get("assessed_at"):
        status += f" ({r['assessed_at']})"
    if r.get("stale"):
        status += " — outdated; rerun needed to refresh"
        if r.get("stale_reasons"):
            status += ": " + "; ".join(r["stale_reasons"])
    result["message"] = status + ".\n\n" + result["message"]
    return result
