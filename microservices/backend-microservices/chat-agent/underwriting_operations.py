"""Underwriting decisions the workbench offers beyond the gate-by-gate journey:
counter-offers, holds, waivers, plan changes, pre-issuance requirements, the
claim re-underwriting queue and facultative reinsurance.

Each wraps one tenant-service endpoint (pre_issuance.py, cases.py,
agent_confidential_report.py, medical_exam.py, underwriting_tracks.py,
reinsurance.py). A waiver, hold or counter-offer always carries the human's own
reason; a customer's answer is recorded only when the user says the customer
gave it. Registered by being imported at the foot of tool_executor.py.
"""
from __future__ import annotations

from typing import Optional

from role_operations import operation
from tool_executor import ChoiceNeeded, Ctx, _action, _case_id, _resolve_case, _resolve_policy_for_case


def _pkr(value) -> str:
    try:
        return f"PKR {float(value):,.0f}"
    except (TypeError, ValueError):
        return "—"


def _chip(label: str, payload: str) -> dict:
    return {"label": label, "actionType": "submit", "payload": payload}


def _need(message: str, **extra) -> dict:
    return {"success": False, "error_code": "missing_details", "needs_user_input": True, "retryable": False,
            "error": message, **extra}


def _ref(case: dict) -> str:
    return case.get("caseNumber") or _case_id(case)


def _entity(case: dict, ctx: Ctx) -> dict:
    return {"type": "case", "id": _case_id(case), "tenant_id": ctx.tenant_id, "reference": case.get("caseNumber"),
            "label": f"{case.get('caseNumber')} — {case.get('applicant_name') or case.get('customer_name') or '—'}"}


def _open(case: dict) -> dict:
    return {"label": "View Application", "actionType": "embed", "payload": f"case/{_case_id(case)}"}


def _done(tool: str, case: dict, ctx: Ctx, message: str, label: str, **extra) -> dict:
    return {"success": True, "entity": _entity(case, ctx), "message": message,
            "last_action": _action(tool, "case", _case_id(case), f"case/{_case_id(case)}", label),
            "quick_actions": [_open(case)], **extra}


async def _case_and_policy(a, ctx: Ctx) -> tuple[dict, dict]:
    case = await _resolve_case(a.model_dump(), ctx)
    policy = await _resolve_policy_for_case(ctx, case)
    if not policy or not policy.get("id"):
        raise LookupError(f"{_ref(case)} has no proposal policy yet — create the proposal first.")
    return case, policy


async def _read(ctx: Ctx, path: str, **params):
    res = await ctx.client.get(ctx.tsvc(path), params=params or None)
    res.raise_for_status()
    return res.json()


async def _write(ctx: Ctx, path: str, body: Optional[dict] = None):
    res = await ctx.client.post(ctx.tsvc(path), json=body or {})
    res.raise_for_status()
    return res.json()


# ── Counter-offers ───────────────────────────────────────────────────────────

def _offer_line(o: dict) -> str:
    detail = {"Loading": f"+{o.get('revised_loading_pct')}% loading",
              "ReducedSumAssured": f"cover reduced to {_pkr(o.get('revised_coverage_amount'))}",
              "PlanSubstitution": f"plan changed to {o.get('revised_product_name')}",
              "Exclusion": "exclusions: " + ", ".join(((o.get("exclusions") or {}).get("items") if isinstance(o.get("exclusions"), dict)
                                                       else o.get("exclusions")) or [])}.get(o.get("offer_type"), o.get("offer_type"))
    return (f"**{o.get('offer_type')}** counter-offer — {o.get('status')}: {detail}. Premium {_pkr(o.get('original_premium'))} → "
            f"{_pkr(o.get('revised_premium'))}, valid until {o.get('valid_until')}"
            + (f". Reason: {o['reason']}" if o.get("reason") else "")
            + (f". Customer responded {str(o['responded_at'])[:10]}" if o.get("responded_at") else "") + ".")


@operation("get_counter_offer")
async def _get_counter_offer(a, ctx: Ctx) -> dict:
    case, policy = await _case_and_policy(a, ctx)
    offer = await _read(ctx, f"/policies/{policy['id']}/counter-offer")
    if not offer:
        return {"success": True, "entity": _entity(case, ctx), "counter_offer": None,
                "message": f"No counter-offer has been made on {_ref(case)}."}
    chips = [_chip("Customer accepts", f"Record that the customer accepts the counter-offer on {_ref(case)}"),
             _chip("Customer declines", f"Record that the customer declines the counter-offer on {_ref(case)}")] \
        if offer.get("status") == "Pending" else []
    return {"success": True, "entity": _entity(case, ctx), "counter_offer": offer,
            "message": f"{_ref(case)}: {_offer_line(offer)}", "quick_actions": chips + [_open(case)]}


@operation("make_counter_offer")
async def _make_counter_offer(a, ctx: Ctx) -> dict:
    case, policy = await _case_and_policy(a, ctx)
    missing = {"Loading": not a.revised_loading_pct, "ReducedSumAssured": not a.revised_coverage_amount,
               "PlanSubstitution": not (a.revised_product_name or "").strip(), "Exclusion": not a.exclusions}[a.offer_type]
    if missing:
        what = {"Loading": "the loading percentage", "ReducedSumAssured": "the reduced sum assured",
                "PlanSubstitution": "the substitute plan", "Exclusion": "the exclusions"}[a.offer_type]
        return _need(f"What is {what} for this counter-offer?")
    if not (a.reason or "").strip():
        return _need("Give the underwriting reason for the revised terms; the customer and the file both see it.")
    current = await _read(ctx, f"/policies/{policy['id']}/counter-offer")
    if current and current.get("status") == "Pending" and not a.replace_existing:
        return _need(f"{_ref(case)} already has a pending offer — {_offer_line(current)} Should the new terms replace it?",
                     quick_actions=[_chip("Replace it", f"Replace the pending counter-offer on {_ref(case)}")])
    body = {"offer_type": a.offer_type, "revised_loading_pct": a.revised_loading_pct,
            "revised_coverage_amount": a.revised_coverage_amount, "revised_product_name": a.revised_product_name,
            "exclusions": a.exclusions, "reason": a.reason.strip()}
    if a.valid_days:
        body["valid_days"] = a.valid_days
    offer = await _write(ctx, f"/policies/{policy['id']}/counter-offer", body)
    offer = offer.get("counter_offer", offer) if isinstance(offer, dict) else offer
    return _done("make_counter_offer", case, ctx, f"Counter-offer issued on {_ref(case)}: {_offer_line(offer)} "
                 "The policy can't be issued until the customer accepts.", "Counter-offer issued", counter_offer=offer)


@operation("record_counter_offer_response")
async def _record_counter_offer_response(a, ctx: Ctx) -> dict:
    case, policy = await _case_and_policy(a, ctx)
    if not a.customer_confirmed:
        return _need("Did the customer give this answer themselves? I only record a counter-offer response the "
                     "customer actually gave.")
    offer = await _read(ctx, f"/policies/{policy['id']}/counter-offer")
    if not offer or offer.get("status") != "Pending":
        return {"success": True, "entity": _entity(case, ctx), "result": {"status": "skipped", "reason": "no_pending_offer"},
                "message": f"There's no pending counter-offer on {_ref(case)}"
                           + (f" (the last one is {offer.get('status')})" if offer else "") + " — nothing was recorded."}
    out = await _write(ctx, f"/policies/{policy['id']}/counter-offer/{'accept' if a.accepted else 'decline'}", {"note": a.note})
    verdict = (f"accepted — the application moves to {out.get('status')}" if a.accepted
               else "declined — the application is closed as Not Taken Up")
    return _done("record_counter_offer_response", case, ctx, f"The customer {verdict} on {_ref(case)}.",
                 "Counter-offer " + ("accepted" if a.accepted else "declined"))


# ── Holds, waivers, plan change ──────────────────────────────────────────────

@operation("hold_underwriting_case")
async def _hold_underwriting_case(a, ctx: Ctx) -> dict:
    case = await _resolve_case(a.model_dump(), ctx)
    if case.get("on_hold"):
        return {"success": True, "entity": _entity(case, ctx), "result": {"status": "skipped", "reason": "already_on_hold"},
                "message": f"{_ref(case)} is already on hold ({case.get('hold_reason') or 'no reason given'})."}
    if len((a.reason or "").strip()) < 3:
        return _need(f"Why should {_ref(case)} be put on hold? The reason is shown to everyone working the case.")
    await _write(ctx, f"/cases/{_case_id(case)}/hold", {"reason": a.reason.strip()})
    return _done("hold_underwriting_case", case, ctx, f"{_ref(case)} is on hold where it stands: {a.reason.strip()}. "
                 "Nothing on the case can move until it's released.", "Underwriting on hold",
                 quick_actions=[_chip("Release hold", f"Release the hold on {_ref(case)}"), _open(case)])


@operation("release_underwriting_case")
async def _release_underwriting_case(a, ctx: Ctx) -> dict:
    case = await _resolve_case(a.model_dump(), ctx)
    if not case.get("on_hold"):
        return {"success": True, "entity": _entity(case, ctx), "result": {"status": "skipped", "reason": "not_on_hold"},
                "message": f"{_ref(case)} isn't on hold — nothing changed."}
    await _write(ctx, f"/cases/{_case_id(case)}/release", {"note": a.note})
    return _done("release_underwriting_case", case, ctx, f"Released {_ref(case)}; underwriting carries on from the same step.",
                 "Hold released")


@operation("waive_case_requirement")
async def _waive_case_requirement(a, ctx: Ctx) -> dict:
    case = await _resolve_case(a.model_dump(), ctx)
    rows = await _read(ctx, f"/cases/{_case_id(case)}/requirements")
    open_rows = [r for r in rows if r.get("status") not in ("Waived", "Satisfied")]
    needle = (a.requirement or "").strip().casefold()
    row = next((r for r in rows if needle and needle in f"{r.get('code')} {r.get('category')}".casefold()), None)
    if row is None:
        if not open_rows:
            return {"success": True, "entity": _entity(case, ctx), "message": f"{_ref(case)} has no open requirements to waive."}
        raise ChoiceNeeded(f"Which requirement on {_ref(case)} should I waive?",
                           [_chip(f"{r.get('code')} ({r.get('category')})", f"Waive requirement {r.get('code')} on {_ref(case)}")
                            for r in open_rows[:6]])
    if row.get("status") == "Waived":
        return {"success": True, "entity": _entity(case, ctx), "result": {"status": "skipped", "reason": "already_waived"},
                "message": f"{row.get('code')} is already waived on {_ref(case)}."}
    if not (a.reason or "").strip():
        return _need(f"Why is {row.get('code')} being waived? The reason goes on the case.")
    await _write(ctx, f"/cases/{_case_id(case)}/requirements/{row['id']}/waive", {"note": a.reason.strip()})
    return _done("waive_case_requirement", case, ctx, f"Waived **{row.get('code')}** on {_ref(case)}: {a.reason.strip()}.",
                 "Requirement waived")


@operation("change_case_plan")
async def _change_case_plan(a, ctx: Ctx) -> dict:
    case = await _resolve_case(a.model_dump(), ctx)
    plans = await _read(ctx, "/insurance-plans")
    needle = (a.plan_name or "").strip().casefold()
    plan = next((p for p in plans if needle and needle in f"{p.get('name')} {p.get('product_name')}".casefold()), None)
    if plan is None:
        raise ChoiceNeeded(f"Which plan should {_ref(case)} move to?",
                           [_chip(p.get("name") or p.get("product_name"), f"Change the plan on {_ref(case)} to {p.get('name')}")
                            for p in plans[:8]])
    if not a.coverage_amount or not a.term_years:
        return _need(f"What sum assured and term (years) should {_ref(case)} have on {plan.get('name')}?")
    if a.apply and len((a.reason or "").strip()) < 5:
        return _need("Give the reason for changing the plan; it goes on the case.")
    body = {"plan_id": plan["id"], "coverage_amount": a.coverage_amount, "term_years": a.term_years,
            "dependent_name": a.dependent_name, "dependent_dob": a.dependent_dob.isoformat() if a.dependent_dob else None,
            "reason": a.reason, "dry_run": not a.apply}
    out = await _write(ctx, f"/cases/{_case_id(case)}/change-plan", body)
    pr, docs = out.get("premium") or {}, out.get("documents") or {}
    lines = [f"{'Changed' if out.get('applied') else 'Preview (nothing changed)'} — {_ref(case)}: "
             f"{(out.get('plan') or {}).get('from')} → {(out.get('plan') or {}).get('to')}, cover "
             f"{_pkr((out.get('coverage') or {}).get('to'))}, {(out.get('term') or {}).get('to')} years, premium "
             f"{_pkr(pr.get('from'))} → {_pkr(pr.get('to'))}."]
    if docs.get("added"):
        lines.append("New documents needed: " + ", ".join(map(str, docs["added"])))
    for item in out.get("resets") or []:
        lines.append(f"- Resets: {item.get('label')} — {item.get('detail')}")
    for item in out.get("review") or []:
        lines.append(f"- Check: {item.get('label')} — {item.get('detail')}")
    if not out.get("applied"):
        return {"success": True, "entity": _entity(case, ctx), "result": {"status": "preview", **out},
                "message": "\n".join(lines), "quick_actions": [_chip("Apply this change",
                    f"Apply the plan change on {_ref(case)} to {plan.get('name')}, cover {a.coverage_amount:.0f}, {a.term_years} years")]}
    return _done("change_case_plan", case, ctx, "\n".join(lines), "Plan changed", result={"status": "completed", **out})


@operation("resolve_issuance_requirement")
async def _resolve_issuance_requirement(a, ctx: Ctx) -> dict:
    case, policy = await _case_and_policy(a, ctx)
    rows = await _read(ctx, f"/policies/{policy['id']}/requirements")
    open_rows = [r for r in rows if r.get("status") not in ("Verified", "Waived")]
    needle = (a.requirement or "").strip().casefold()
    row = next((r for r in rows if needle and needle in f"{r.get('label')} {r.get('requirement_type')}".casefold()), None)
    if row is None:
        if not open_rows:
            return {"success": True, "entity": _entity(case, ctx), "message": f"Every pre-issuance requirement on {_ref(case)} is resolved."}
        raise ChoiceNeeded(f"Which requirement on {_ref(case)} should I {a.action}?",
                           [_chip(f"{r.get('label')} — {r.get('status')}", f"{a.action.capitalize()} the {r.get('label')} requirement on {_ref(case)}")
                            for r in open_rows[:6]])
    if row.get("status") in ("Verified", "Waived"):
        return {"success": True, "entity": _entity(case, ctx), "result": {"status": "skipped", "reason": "already_resolved"},
                "message": f"{row.get('label')} is already {row.get('status').lower()} on {_ref(case)}."}
    if a.action == "waive" and not (a.note or "").strip():
        return _need(f"Why is {row.get('label')} being waived? The reason goes on the policy file.")
    await _write(ctx, f"/requirements/{row['id']}/{a.action}", {"note": a.note})
    return _done("resolve_issuance_requirement", case, ctx,
                 f"{'Verified' if a.action == 'verify' else 'Waived'} **{row.get('label')}** on {_ref(case)}.",
                 "Requirement verified" if a.action == "verify" else "Requirement waived")


async def _waive_gate(a, ctx: Ctx, tool: str, path: str, what: str) -> dict:
    case = await _resolve_case(a.model_dump(), ctx)
    if len((a.reason or "").strip()) < 5:
        return _need(f"Why is the {what} being waived on {_ref(case)}? Give at least a short sentence; it is recorded.")
    await _write(ctx, f"/cases/{_case_id(case)}/{path}", {"reason": a.reason.strip()})
    return _done(tool, case, ctx, f"Waived the {what} on {_ref(case)}: {a.reason.strip()}.", f"{what.capitalize()} waived")


@operation("waive_agent_confidential_report")
async def _waive_agent_confidential_report(a, ctx: Ctx) -> dict:
    return await _waive_gate(a, ctx, "waive_agent_confidential_report", "acr/waive", "agent's confidential report")


@operation("waive_medical_examination")
async def _waive_medical_examination(a, ctx: Ctx) -> dict:
    return await _waive_gate(a, ctx, "waive_medical_examination", "medical-exam/waive", "medical examination")


@operation("list_claim_underwriting_referrals")
async def _list_claim_underwriting_referrals(a, ctx: Ctx) -> dict:
    rows = await _read(ctx, "/underwriting/claim-referrals")
    if not rows:
        return {"success": True, "referrals": [], "message": "No claims are waiting on an underwriting verdict."}
    lines = "\n".join(f"- **{r.get('claim_number')}** — {r.get('customer_name')}, {r.get('claim_type')} "
                      f"{_pkr(r.get('submitted_amount'))} on {r.get('policy_number')}"
                      + (" (contestable)" if r.get("is_contestable") else "")
                      + (f": {r['referral_reason']}" if r.get("referral_reason") else "") for r in rows[:20])
    return {"success": True, "referrals": rows, "message": f"{len(rows)} claim(s) referred to underwriting, oldest first:\n{lines}"}


# ── Reinsurance ──────────────────────────────────────────────────────────────

def _reinsurance_message(case: dict, ri: dict) -> str:
    cession, referral = ri.get("cession") or {}, ri.get("referral") or {}
    lines = [f"Reinsurance — {_ref(case)} ({ri.get('policy_status')}): "
             + ("a facultative referral is **required**." if ri.get("referral_required") else "within treaty; no referral required.")]
    for key, label in (("retained_amount", "Retained"), ("treaty_ceded_amount", "Treaty"),
                       ("facultative_ceded_amount", "Facultative")):
        if cession.get(key) is not None:
            lines.append(f"- {label}: {_pkr(cession[key])}")
    if referral:
        lines.append(f"- Referral to {(referral.get('reinsurer') or {}).get('name') or 'reinsurer'}: {referral.get('status')}"
                     + (f", reinsurer decision {referral['reinsurer_decision']}" if referral.get("reinsurer_decision") else ""))
    return "\n".join(lines)


_LIVE_REFERRAL = ("Submitted", "Quoted")


@operation("get_policy_reinsurance")
async def _get_policy_reinsurance(a, ctx: Ctx) -> dict:
    case, policy = await _case_and_policy(a, ctx)
    ri = await _read(ctx, f"/policies/{policy['id']}/reinsurance")
    chips = [] if (ri.get("referral") or {}).get("status") in _LIVE_REFERRAL or not ri.get("can_refer") else [
        _chip(f"Refer to {r.get('name')}", f"Refer {_ref(case)} to reinsurer {r.get('code')}")
        for r in (ri.get("panel") or []) if r.get("is_active", True)][:3]
    return {"success": True, "entity": _entity(case, ctx), "reinsurance": ri,
            "message": _reinsurance_message(case, ri), "quick_actions": chips + [_open(case)]}


@operation("refer_policy_to_reinsurer")
async def _refer_policy_to_reinsurer(a, ctx: Ctx) -> dict:
    case, policy = await _case_and_policy(a, ctx)
    ri = await _read(ctx, f"/policies/{policy['id']}/reinsurance")
    if (ri.get("referral") or {}).get("status") in _LIVE_REFERRAL:
        return {"success": True, "entity": _entity(case, ctx), "result": {"status": "skipped", "reason": "already_referred"},
                "message": _reinsurance_message(case, ri) + "\nA referral is already open — nothing new was sent."}
    panel = [r for r in ri.get("panel") or [] if r.get("is_active", True)]
    needle = (a.reinsurer or "").strip().casefold()
    target = next((r for r in panel if needle and needle in f"{r.get('code')} {r.get('name')}".casefold()), None)
    if target is None:
        raise ChoiceNeeded(f"Which reinsurer should {_ref(case)} go to?",
                           [_chip(f"{r.get('name')} ({r.get('code')})", f"Refer {_ref(case)} to reinsurer {r.get('code')}") for r in panel[:6]])
    await _write(ctx, f"/policies/{policy['id']}/reinsurance/refer", {"reinsurer_id": target["id"], "underwriter_note": a.note})
    return _done("refer_policy_to_reinsurer", case, ctx, f"{_ref(case)} referred to **{target.get('name')}** "
                 f"(typical reply {target.get('typical_response_days')} days). Record their answer when it arrives.",
                 "Referred to reinsurer")


@operation("record_reinsurer_response")
async def _record_reinsurer_response(a, ctx: Ctx) -> dict:
    case, policy = await _case_and_policy(a, ctx)
    if a.decision == "AcceptWithLoading" and not (a.extra_mortality_pct or a.extra_premium_per_mille):
        return _need("What loading did the reinsurer set — extra mortality % or extra premium per mille?")
    if a.decision == "AcceptWithExclusion" and not a.exclusions:
        return _need("Which exclusions did the reinsurer impose?")
    body = a.model_dump(include={"decision", "reinsurer_reference", "extra_mortality_pct", "extra_premium_per_mille",
                                 "exclusions", "conditions"})
    await _write(ctx, f"/policies/{policy['id']}/reinsurance/response", body)
    return _done("record_reinsurer_response", case, ctx, f"Recorded the reinsurer's **{a.decision}** on {_ref(case)}."
                 + (" Apply the terms to carry them onto the application." if a.decision.startswith("Accept") else ""),
                 "Reinsurer response recorded",
                 quick_actions=[_chip("Apply reinsurer terms", f"Apply the reinsurer's terms on {_ref(case)}"), _open(case)]
                 if a.decision.startswith("Accept") else [_open(case)])


@operation("apply_reinsurer_terms")
async def _apply_reinsurer_terms(a, ctx: Ctx) -> dict:
    case, policy = await _case_and_policy(a, ctx)
    body = {"note": a.note, **({"valid_days": a.valid_days} if a.valid_days else {})}
    out = await _write(ctx, f"/policies/{policy['id']}/reinsurance/apply", body)
    offer = out.get("counter_offer") if isinstance(out, dict) else None
    return _done("apply_reinsurer_terms", case, ctx, f"Applied the reinsurer's terms on {_ref(case)}."
                 + (f" {_offer_line(offer)} The customer must accept it." if offer else ""), "Reinsurer terms applied")


@operation("withdraw_reinsurance_referral")
async def _withdraw_reinsurance_referral(a, ctx: Ctx) -> dict:
    case, policy = await _case_and_policy(a, ctx)
    await _write(ctx, f"/policies/{policy['id']}/reinsurance/withdraw", {"reason": a.reason})
    return _done("withdraw_reinsurance_referral", case, ctx, f"Withdrew the reinsurance referral on {_ref(case)}.",
                 "Referral withdrawn")
