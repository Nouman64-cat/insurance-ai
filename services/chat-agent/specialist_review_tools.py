"""Specialist underwriting — the medical and financial reviews, and the final compile.

An application is underwritten in two specialist reviews and one compile:

  Medical Underwriter    medical e-application, examination reports, AI medical
                         underwriting, then a Cleared / Referred / Declined review
  Financial Underwriter  financial e-application, insurance history, income
                         documents, AI financial underwriting, then a review
  Final underwriting     both reviews + the Agent's Confidential Report + PEP
                         screening, compiled with the AI risk assessment

Every call runs as the signed-in user (ctx.client carries their token), so the
tenant service's own rules decide what a specialist may touch. The agent
prepares — reads, checks readiness, runs AI analysis, previews — and anything a
human owns (recording AI results, a review decision, the final compile) needs
confirm=true, which the user gives by clicking the confirm chip.
"""
from __future__ import annotations

import base64
import json
import re
from typing import Any, Optional

from tool_executor import ChoiceNeeded, Ctx, _HANDLERS, _action, _case_id, _resolve_case, _same_cnic, handles

TRACK_FOR_ROLE = {"Medical Underwriter": "medical", "Financial Underwriter": "financial"}
STATUS_LABEL = {"PENDING": "Not started", "IN_REVIEW": "In review", "CLEARED": "Cleared", "REFERRED": "Referred", "DECLINED": "Declined"}
FINAL = ("CLEARED", "REFERRED", "DECLINED")
_PART_DONE = ("Submitted", "Verified")


def _chip(label: str, payload: str) -> dict:
    return {"label": label, "actionType": "submit", "payload": payload}


def _open(case_id: str, label: str = "Open the application") -> dict:
    return {"label": label, "actionType": "embed", "payload": f"case/{case_id}"}


def _track(ctx: Ctx) -> Optional[str]:
    return TRACK_FOR_ROLE.get(ctx.exec_ctx.role)


def _my_user_id(ctx: Ctx) -> Optional[str]:
    """The signed-in user's id, from their own token (the backend verifies it on every call)."""
    try:
        payload = ctx.exec_ctx.jwt_token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).get("sub")
    except Exception:
        return None


def _ref(value: Optional[str]) -> str:
    """APP-2026-19A187 and CASE-2026-19A187 name the same application."""
    return re.sub(r"^(?:APP|CASE)-", "", str(value or "").strip().upper())


def _label(row: dict) -> str:
    return f"{row.get('customer_name')} ({str(row.get('reference', '')).replace('CASE-', 'APP-')})"


def _detail_text(response, fallback: str) -> str:
    """The backend's own explanation of a refusal, when it gave one."""
    try:
        detail = response.json().get("detail")
        return detail if isinstance(detail, str) else fallback
    except Exception:
        return fallback


def _specialist_only(ctx: Ctx) -> Optional[dict]:
    if _track(ctx):
        return None
    return {"success": False, "message": "That is a Medical or Financial Underwriter's tool. For an application's specialist "
                                         "reviews use get_specialist_reviews, or assign them with assign_underwriting_track."}


async def _resolve_review(args: dict, ctx: Ctx, rows: Optional[list] = None) -> dict:
    """Which of my assigned applications did they mean? By reference, CNIC or name; asks when ambiguous."""
    if rows is None:
        res = await ctx.client.get(ctx.tsvc("/underwriting/reviews"))
        res.raise_for_status()
        rows = res.json()
    ref, cnic, name = _ref(args.get("case_number")), args.get("cnic"), str(args.get("applicant_name") or "").strip().casefold()
    if ref:
        hits = [r for r in rows if _ref(r.get("reference")) == ref]
    elif cnic:
        hits = [r for r in rows if _same_cnic(r.get("customer_cnic"), cnic)]
    elif name:
        hits = [r for r in rows if str(r.get("customer_name", "")).casefold() == name] or \
               [r for r in rows if name in str(r.get("customer_name", "")).casefold()]
    else:
        hits = [r for r in rows if not r.get("closed")]
        if len(hits) == 1:
            return hits[0]
    if not hits:
        raise LookupError("I couldn't find that application among the ones assigned to you. "
                          "Ask an admin to assign it, or check the name or reference.")
    if len(hits) > 1:
        raise ChoiceNeeded("Which application?", [
            _chip(_label(r), f"Show my underwriting review for case {r.get('reference')}") for r in hits[:6]])
    return hits[0]


async def _workspace(ctx: Ctx, case_id: str) -> dict:
    res = await ctx.client.get(ctx.tsvc(f"/underwriting/reviews/{case_id}"))
    res.raise_for_status()
    return res.json()


# ── A specialist's own work ──────────────────────────────────────────────────

@handles("list_my_underwriting_reviews")
async def _list_my_underwriting_reviews(args: dict, ctx: Ctx) -> dict:
    if (denied := _specialist_only(ctx)):
        return denied
    res = await ctx.client.get(ctx.tsvc("/underwriting/reviews"))
    res.raise_for_status()
    rows = res.json()
    wanted = args.get("status")
    if wanted == "open":
        rows = [r for r in rows if not r.get("closed")]
    elif wanted == "closed":
        rows = [r for r in rows if r.get("closed")]
    elif wanted:
        rows = [r for r in rows if r["review"]["status"] == wanted]
    track = _track(ctx)
    if not rows:
        return {"success": True, "count": 0, "message": f"No {track} reviews{' matching that' if wanted else ''} are assigned to you right now."}
    lines = [f"- **{_label(r)}** — {r.get('product_name') or 'no plan linked'} · "
             f"{STATUS_LABEL.get(r['review']['status'], r['review']['status'])}"
             + (" · application closed" if r.get("closed") else "") + (" · on hold" if r.get("on_hold") else "")
             for r in rows]
    open_rows = [r for r in rows if not r.get("closed")]
    return {
        "success": True, "count": len(rows),
        "message": f"**Your {track} reviews** ({len(rows)}):\n" + "\n".join(lines),
        "reviews": [{"id": r["id"], "reference": r["reference"], "customer": r["customer_name"], "status": r["review"]["status"],
                     "closed": bool(r.get("closed"))} for r in rows],
        "quick_actions": [_chip(f"Open {r['customer_name']}", f"Show my underwriting review for case {r['reference']}") for r in open_rows[:4]],
    }


def _next_steps(track: str, ws: dict, exam: Optional[dict]) -> tuple[list[str], list[dict]]:
    """What the specialist should do next on this application, in order, with chips."""
    ref = ws["reference"]
    steps: list[str] = []
    chips: list[dict] = []
    review = ws["review"]
    if not review.get("assigned_user_id"):
        return ["Start your review to use the tools for this application."], [_chip("Start my review", f"Start my review for case {ref}")]
    if ws.get("read_only"):
        return ["This application is closed for specialist review."], []
    eapp = next((r for r in ws["requirements"] if r["key"] == "e_application"), None)
    if eapp and eapp["status"] not in _PART_DONE:
        steps.append(f"The customer hasn't submitted the {track} e-application ({eapp['status']}).")
        if eapp["status"] in ("NotSent", "Sent", "InProgress", "Expired"):
            chips.append(_chip("Email the e-application" if eapp["status"] == "NotSent" else "Resend the e-application",
                               f"Send the {track} e-application questionnaire for case {ref}"))
    mine = [o for o in ws.get("application_outstanding") or [] if o.get("can_upload")]
    if mine:
        steps.append("Still needed for the application: " + ", ".join(o["document_type"] for o in mine) + " — upload on the Documents tab.")
    if track == "medical":
        tests = (exam or {}).get("required_tests") or []
        reports = (exam or {}).get("reports") or []
        accepted = [t for t in tests if any(r.get("test_code") == t.get("code") and r.get("status") == "Accepted" for r in reports)]
        if exam and exam.get("status") == "NotAssessed":
            steps.append("Medical requirements haven't been worked out yet.")
            chips.append(_chip("Run AI medical underwriting", f"Run AI medical underwriting for case {ref}"))
        elif tests and len(accepted) < len(tests):
            missing = [t.get("name") or t.get("code") for t in tests if t not in accepted]
            steps.append(f"{len(accepted)} of {len(tests)} examination reports accepted — still needed: {', '.join(missing)}.")
        elif tests and not (exam or {}).get("outcome"):
            steps.append("All examination reports are in — AI medical underwriting can run.")
            chips.append(_chip("Run AI medical underwriting", f"Run AI medical underwriting for case {ref}"))
    else:
        ai = ws.get("ai_underwriting") or {}
        history = next((r for r in ws["requirements"] if r["key"] == "insurance_history"), None)
        if history and history["status"] != "Clear":
            steps.append(f"Insurance history check: {history['status']}.")
            chips.append(_chip("Run the insurance history check", f"Run insurance history check for case {ref}"))
        if ai.get("ready") and not ai.get("result"):
            steps.append("All financial requirements are in — AI financial underwriting can run.")
            chips.append(_chip("Run AI financial underwriting", f"Run AI financial underwriting for case {ref}"))
        elif not ai.get("ready"):
            steps.extend(b for b in ai.get("blockers") or [] if "insurance history" not in b.lower() and "e-application" not in b.lower())
    if review["status"] not in FINAL:
        rated = bool((exam or {}).get("outcome")) if track == "medical" else bool((ws.get("ai_underwriting") or {}).get("result"))
        if rated:
            steps.append("When you're satisfied, record your decision with your rationale.")
            chips.append(_chip("Record my review", f"I want to record my {track} review for case {ref}"))
    return steps or ["Your review is recorded. Nothing else is needed from you."], chips


@handles("get_underwriting_review")
async def _get_underwriting_review(args: dict, ctx: Ctx) -> dict:
    if (denied := _specialist_only(ctx)):
        return denied
    track = _track(ctx)
    row = await _resolve_review(args, ctx)
    ws = await _workspace(ctx, row["id"])
    exam = None
    if track == "medical":
        res = await ctx.client.get(ctx.tsvc(f"/cases/{row['id']}/medical-exam"))
        exam = res.json() if res.status_code < 400 else None
    review = ws["review"]
    reqs = "\n".join(f"- {r['label']}: **{r['status']}**" + (f" ({r['detail']})" if r.get("detail") else "") for r in ws["requirements"])
    steps, chips = _next_steps(track, ws, exam)
    ai_line = ""
    if track == "financial" and (ai := (ws.get("ai_underwriting") or {}).get("result")):
        ai_line = (f"\n\n**AI financial underwriting:** risk {ai.get('score')}/100 · cover "
                   f"{'justified' if ai.get('financially_justified') else 'not justified'} by income · referral "
                   f"{'suggested' if ai.get('referral_required') else 'not needed'}.")
    if track == "medical" and exam and exam.get("outcome"):
        ai_line = f"\n\n**AI medical underwriting:** outcome {exam['outcome']} · loading {exam.get('suggested_loading_pct') or 0}%."
    return {
        "success": True,
        "message": (f"**{_label(ws)}** — your {track} review: **{STATUS_LABEL.get(review['status'], review['status'])}**"
                    + (f"\n> {review['note']}" if review.get("note") else "")
                    + f"\n\n**Requirements**\n{reqs}{ai_line}\n\n**Next**\n" + "\n".join(f"- {s}" for s in steps)),
        "review_status": review["status"], "requirements": ws["requirements"],
        "quick_actions": [*chips[:3], _open(row["id"])],
        "last_action": _action("get_underwriting_review", "case", row["id"], f"case/{row['id']}", f"{track.title()} review"),
    }


@handles("start_my_review")
async def _start_my_review(args: dict, ctx: Ctx) -> dict:
    if (denied := _specialist_only(ctx)):
        return denied
    track = _track(ctx)
    res = await ctx.client.get(ctx.tsvc("/underwriting/reviews"))
    res.raise_for_status()
    row = await _resolve_review(args, ctx, res.json())
    if row["review"].get("assigned_user_id"):
        return {"success": True, "message": f"**{_label(row)}** is already on your desk.",
                "quick_actions": [_chip("What's next?", f"Show my underwriting review for case {row['reference']}")]}
    put = await ctx.client.put(ctx.tsvc(f"/cases/{row['id']}/underwriting-tracks/{track}"), json={"assigned_user_id": _my_user_id(ctx)})
    if put.status_code >= 400:
        return {"success": False, "message": _detail_text(put, "Could not start this review.")}
    return {"success": True, "message": f"✅ You've started the {track} review of **{_label(row)}**.",
            "quick_actions": [_chip("What's next?", f"Show my underwriting review for case {row['reference']}"), _open(row["id"])]}


@handles("send_e_application_questionnaire")
async def _send_e_application_questionnaire(args: dict, ctx: Ctx) -> dict:
    track = _track(ctx)
    if track:
        if args.get("part") not in (None, track):
            return {"success": False, "message": f"You can send only the {track} e-application; the other questionnaire is the "
                                                 f"{'financial' if track == 'medical' else 'medical'} underwriter's."}
        row = await _resolve_review(args, ctx)
        case_id, label, part = row["id"], _label(row), track
    else:
        case = await _resolve_case(args, ctx)
        case_id, label, part = _case_id(case), f"{case.get('customer_name')} ({case.get('caseNumber')})", args.get("part") or "both"
    path = f"/cases/{case_id}/e-application/invite" if part == "both" else f"/cases/{case_id}/e-application/{part}/invite"
    res = await ctx.client.post(ctx.tsvc(path))
    if res.status_code >= 400:
        return {"success": False, "message": _detail_text(res, "Could not send the e-application.")}
    data = res.json()
    sent = data.get("parts") or [data]
    names = " and ".join(p.get("part") or "customer" for p in sent)
    delivery = (f"emailed to **{data['emailed_to']}**" if data.get("email_status") == "sent"
                else "**not emailed** — no customer email is on record; add one, then resend" if data.get("email_status") == "no_email"
                else "created, but the email **failed** — resend it")
    return {
        "success": True, "status": data.get("status"),
        "message": f"📨 The {names} e-application for **{label}** was {delivery}. The link is valid for 14 days; "
                   "you'll see it here as soon as the customer submits.",
        "quick_actions": [_open(case_id)],
        "last_action": _action("send_e_application_questionnaire", "case", case_id, f"case/{case_id}", f"{names.title()} e-application sent"),
    }


# ── AI underwriting ──────────────────────────────────────────────────────────

@handles("run_ai_medical_underwriting")
async def _run_ai_medical_underwriting(args: dict, ctx: Ctx) -> dict:
    if _track(ctx) != "medical":
        return {"success": False, "message": "AI medical underwriting is the Medical Underwriter's tool."}
    row = await _resolve_review(args, ctx)
    case_id, ref = row["id"], row["reference"]
    exam_res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/medical-exam"))
    exam_res.raise_for_status()
    exam = exam_res.json()
    if exam.get("status") == "NotAssessed":
        assess = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/medical-exam/assess"))
        if assess.status_code >= 400:
            return {"success": False, "message": _detail_text(assess, "Could not work out the medical requirements.")}
        exam = (await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/medical-exam"))).json()
    if exam.get("status") in ("NotRequired", "Waived"):
        return {"success": True, "message": f"No medical examination is needed for **{_label(row)}** ({exam['status']}). "
                                            "Record your medical review when ready.",
                "quick_actions": [_chip("Record my review", f"I want to record my medical review for case {ref}")]}
    tests = exam.get("required_tests") or []
    reports = exam.get("reports") or []
    pending = [t.get("name") or t.get("code") for t in tests
               if not any(r.get("test_code") == t.get("code") and r.get("status") == "Accepted" for r in reports)]
    if pending:
        return {"success": False, "status": "WaitingForReports",
                "message": (f"⏳ AI medical underwriting can't run yet for **{_label(row)}** — "
                            f"{len(tests) - len(pending)} of {len(tests)} reports accepted. Still needed: {', '.join(pending)}.\n\n"
                            "Upload them on the application's Documents tab (each is read and accepted automatically)."),
                "quick_actions": [_open(case_id, "Open the Documents tab")]}

    review_res = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/medical-exam/ai-review"), timeout=180.0)
    if review_res.status_code >= 400:
        return {"success": False, "message": _detail_text(review_res, "The AI could not read the reports.")}
    read = review_res.json().get("tests") or {}
    names = {t.get("code"): t.get("name") or t.get("code") for t in tests}
    values = {code: r["value"] for code, r in read.items() if r and r.get("readable") and r.get("value")}
    unreadable = [names.get(c, c) for c in names if c not in values]
    rows = "\n".join(
        f"| {names.get(code, code)} | {r.get('value') or '—'} | {'⚠️ abnormal' if r.get('abnormal') else 'normal' if r.get('readable') else 'not readable'} |"
        for code, r in read.items() if r)

    if not args.get("confirm"):
        return {
            "success": True, "status": "Preview",
            "message": (f"🩺 **AI read {len(values)} of {len(tests)} results for {_label(row)}** — check them before recording:\n\n"
                        f"| Test | Result | AI finding |\n|---|---|---|\n{rows}\n\n"
                        + (f"Not readable, enter by hand on the application: {', '.join(unreadable)}.\n\n" if unreadable else "")
                        + "Recording rates the results (clinical outcome and loading). It is not your review decision."),
            "quick_actions": [*([_chip("Record these results", f"Run AI medical underwriting for case {ref} — confirm=true")] if values else []),
                              _open(case_id, "Check them on the application")],
        }
    if not values:
        return {"success": False, "message": "The AI couldn't read any result, so there is nothing to record. Enter them on the application."}
    rec = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/medical-exam/result"), json={"results": values})
    if rec.status_code >= 400:
        return {"success": False, "message": _detail_text(rec, "Could not record the results.")}
    order = rec.json()
    findings = "\n".join(f"- {f.get('finding')} ({f.get('loading_pct')}%)" for f in order.get("abnormal_findings") or []) or "- No abnormal findings."
    return {
        "success": True, "status": "Recorded",
        "message": (f"✅ **AI medical underwriting recorded** for {_label(row)}: outcome **{order.get('outcome')}**, "
                    f"suggested loading **{order.get('suggested_loading_pct') or 0}%**.\n\n{findings}"
                    + (f"\n\nStill to enter by hand: {', '.join(unreadable)}." if unreadable else "")
                    + "\n\nNext: record your medical review."),
        "quick_actions": [_chip("Record my review", f"I want to record my medical review for case {ref}"), _open(case_id)],
        "last_action": _action("run_ai_medical_underwriting", "case", case_id, f"case/{case_id}", "AI medical underwriting recorded"),
    }


@handles("run_ai_financial_underwriting")
async def _run_ai_financial_underwriting(args: dict, ctx: Ctx) -> dict:
    if _track(ctx) != "financial":
        return {"success": False, "message": "AI financial underwriting is the Financial Underwriter's tool."}
    row = await _resolve_review(args, ctx)
    case_id, ref = row["id"], row["reference"]
    res = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/financial-underwriting/run"), timeout=180.0)
    if res.status_code == 409:
        detail = _detail_text(res, "")
        blockers = detail.split(": ", 1)[-1]
        return {"success": False, "status": "NotReady",
                "message": f"⏳ AI financial underwriting can't run yet for **{_label(row)}**. {blockers}",
                "quick_actions": [_chip("What's next?", f"Show my underwriting review for case {ref}"), _open(case_id)]}
    if res.status_code >= 400:
        return {"success": False, "message": _detail_text(res, "AI financial underwriting failed. Try again in a minute.")}
    r = res.json().get("result") or {}
    reasons = "\n".join(f"- **{x.get('parameter')}** ({x.get('risk_rating')}): {x.get('observation')}"
                        for x in (r.get("reasons") or [])[:8] if isinstance(x, dict))
    cover = f"PKR {r['maximum_supported_cover']:,.0f}" if r.get("maximum_supported_cover") else "—"
    return {
        "success": True,
        "message": (f"💼 **AI financial underwriting — {_label(row)}**\n\n"
                    f"- Financial risk: **{r.get('score')}/100**\n"
                    f"- Cover justified by income: **{'Yes' if r.get('financially_justified') else 'No'}**"
                    f" (cover ÷ income {r.get('coverage_to_income_ratio') or 0:.1f}×, maximum supported {cover})\n"
                    f"- Referral: **{'suggested' if r.get('referral_required') else 'not needed'}**\n\n{reasons}\n\n"
                    "This is analysis only — record your financial review when ready."),
        "result": r,
        "quick_actions": [_chip("Record my review", f"I want to record my financial review for case {ref}"), _open(case_id)],
        "last_action": _action("run_ai_financial_underwriting", "case", case_id, f"case/{case_id}", "AI financial underwriting"),
    }


# ── The review decision ──────────────────────────────────────────────────────

@handles("record_underwriting_review")
async def _record_underwriting_review(args: dict, ctx: Ctx) -> dict:
    track = _track(ctx) or args.get("track")
    if not track:
        return {"success": False, "message": "Which review — medical or financial?"}
    decision, rationale = args["decision"], (args.get("rationale") or "").strip()
    if _track(ctx):
        row = await _resolve_review(args, ctx)
        case_id, ref, label = row["id"], row["reference"], _label(row)
    else:
        case = await _resolve_case(args, ctx)
        case_id, ref, label = _case_id(case), case.get("caseNumber"), f"{case.get('customer_name')} ({case.get('caseNumber')})"
    if decision in FINAL and not rationale:
        return {"success": False, "status": "NeedsRationale",
                "message": f"What is your rationale for **{STATUS_LABEL[decision].lower()}** on {label}? "
                           "It is recorded with your decision and compiled into the final underwriting."}
    if not args.get("confirm"):
        return {
            "success": True, "status": "Preview",
            "message": (f"Ready to record your **{track}** review of **{label}**:\n\n"
                        f"- Decision: **{STATUS_LABEL[decision]}**\n- Rationale: {rationale or '—'}\n\n"
                        "This records your specialist review; final approval is a separate step."),
            "quick_actions": [
                _chip(f"Confirm: {STATUS_LABEL[decision]}",
                      f"Record my {track} review for case {ref} as {decision} with rationale \"{rationale}\" — confirm=true"),
                _open(case_id, "Review the application first"),
            ],
        }
    body: dict[str, Any] = {"status": decision, "note": rationale or None}
    if _track(ctx):
        body["assigned_user_id"] = _my_user_id(ctx)
    res = await ctx.client.put(ctx.tsvc(f"/cases/{case_id}/underwriting-tracks/{track}"), json=body)
    if res.status_code >= 400:
        return {"success": False, "message": _detail_text(res, "Could not record the review.")}
    return {
        "success": True, "status": decision,
        "message": f"✅ Your {track} review of **{label}** is recorded: **{STATUS_LABEL[decision]}**. "
                   "It is now part of the final underwriting compile.",
        "quick_actions": [_open(case_id)],
        "last_action": _action("record_underwriting_review", "case", case_id, f"case/{case_id}", f"{track.title()} review {STATUS_LABEL[decision]}"),
    }


# ── Final underwriting (admin / underwriter) ─────────────────────────────────

async def _underwriters(ctx: Ctx, track: Optional[str]) -> list[dict]:
    res = await ctx.client.get(ctx.tsvc("/underwriting/underwriters"))
    res.raise_for_status()
    return [u for u in res.json() if not track or track in u.get("tracks", [])]


@handles("list_track_underwriters")
async def _list_track_underwriters(args: dict, ctx: Ctx) -> dict:
    people = await _underwriters(ctx, args.get("track"))
    if not people:
        return {"success": True, "message": "No active underwriters can take that review. Add a Medical or Financial Underwriter user first."}
    lines = "\n".join(f"- **{u['full_name']}** ({u['role']}) — {', '.join(u['tracks'])}" for u in people)
    return {"success": True, "underwriters": people, "message": f"**Underwriters{' for the ' + args['track'] + ' review' if args.get('track') else ''}:**\n{lines}"}


@handles("assign_underwriting_track")
async def _assign_underwriting_track(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id, ref, track = _case_id(case), case.get("caseNumber"), args["track"]
    people = await _underwriters(ctx, track)
    chosen = None
    if args.get("underwriter_id"):
        chosen = next((u for u in people if u["id"] == args["underwriter_id"]), None)
    elif args.get("underwriter_name"):
        needle = args["underwriter_name"].strip().casefold()
        hits = [u for u in people if needle in (u["full_name"] or "").casefold() or needle == (u.get("email") or "").casefold()]
        chosen = hits[0] if len(hits) == 1 else None
        if len(hits) > 1:
            people = hits
    if not chosen:
        if not people:
            return {"success": False, "message": f"No active underwriter can take the {track} review."}
        raise ChoiceNeeded(f"Who should take the {track} review of {case.get('customer_name')}?", [
            _chip(f"{u['full_name']} ({u['role']})", f"Assign the {track} review of case {ref} to underwriter_id {u['id']}") for u in people[:6]])
    res = await ctx.client.put(ctx.tsvc(f"/cases/{case_id}/underwriting-tracks/{track}"), json={"assigned_user_id": chosen["id"]})
    if res.status_code >= 400:
        return {"success": False, "message": _detail_text(res, "Could not assign the review.")}
    return {"success": True, "message": f"✅ The {track} review of **{case.get('customer_name')}** ({ref}) is assigned to **{chosen['full_name']}**.",
            "quick_actions": [_chip("Show specialist reviews", f"Show the specialist reviews for case {ref}")],
            "last_action": _action("assign_underwriting_track", "case", case_id, f"case/{case_id}", f"{track.title()} review assigned")}


async def _compile_state(case: dict, ctx: Ctx) -> dict:
    case_id = _case_id(case)
    tracks = (await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/underwriting-tracks"))).json()
    detail = (await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/detail"))).json()
    pre = detail.get("pre_underwriting_status") or {}
    acr, pep = pre.get("acr", "NotStarted"), pre.get("compliance", "NotRun")
    ref = case.get("caseNumber")
    inputs = [
        ("Medical review", tracks["medical"]["submitted"], STATUS_LABEL.get(tracks["medical"]["status"], tracks["medical"]["status"]),
         None if tracks["medical"]["submitted"] else (
             _chip("Assign the medical review", f"Assign the medical review of case {ref}") if not tracks["medical"]["reviewer"] else None)),
        ("Financial review", tracks["financial"]["submitted"], STATUS_LABEL.get(tracks["financial"]["status"], tracks["financial"]["status"]),
         None if tracks["financial"]["submitted"] else (
             _chip("Assign the financial review", f"Assign the financial review of case {ref}") if not tracks["financial"]["reviewer"] else None)),
        ("Agent's Confidential Report", acr in ("Submitted", "Waived"), acr,
         None if acr in ("Submitted", "Waived", "Requested") else _chip("Request the ACR", f"Submit agent confidential report for case {ref}")),
        ("PEP & sanctions screening", pep in ("Passed", "Cleared"), pep,
         None if pep in ("Passed", "Cleared") else _chip("Run PEP screening", f"Run compliance screening for case {ref}")),
    ]
    return {"tracks": tracks, "detail": detail, "inputs": inputs, "ready": all(done for _, done, _, _ in inputs)}


def _review_line(name: str, r: dict) -> str:
    ai = r.get("ai") or {}
    extra = (f" · AI: outcome {ai.get('outcome') or '—'}, loading {ai.get('suggested_loading_pct') or 0}%" if name == "Medical" and ai
             else f" · AI: risk {ai.get('score')}/100, referral {'suggested' if ai.get('referral_required') else 'not needed'}" if ai else "")
    who = r.get("reviewer") or "not assigned"
    return f"- **{name}** ({who}): **{STATUS_LABEL.get(r['status'], r['status'])}**{extra}" + (f"\n  > {r['note']}" if r.get("note") else "")


@handles("get_specialist_reviews")
async def _get_specialist_reviews(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    st = await _compile_state(case, ctx)
    ref = case.get("caseNumber")
    checklist = "\n".join(f"- {'✅' if done else '⏳'} {name}: {status}" for name, done, status, _ in st["inputs"])
    chips = [c for _, done, _, c in st["inputs"] if not done and c]
    if st["ready"]:
        chips.insert(0, _chip("Compile final underwriting", f"Compile final underwriting for case {ref}"))
    return {
        "success": True, "ready": st["ready"], "case_id": _case_id(case), "tracks": st["tracks"],
        "inputs": [{"name": name, "done": done, "status": status} for name, done, status, _ in st["inputs"]],
        "message": (f"**Final underwriting — {case.get('customer_name')} ({ref})**\n\n"
                    f"{_review_line('Medical', st['tracks']['medical'])}\n{_review_line('Financial', st['tracks']['financial'])}\n\n"
                    f"**Inputs to compile**\n{checklist}\n\n"
                    + ("Everything is in — ready to compile." if st["ready"] else "Waiting on the items marked ⏳.")),
        "quick_actions": [*chips[:3], _open(_case_id(case))],
    }


@handles("compile_final_underwriting")
async def _compile_final_underwriting(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    st = await _compile_state(case, ctx)
    ref = case.get("caseNumber")
    if not st["ready"]:
        missing = [f"{name} ({status})" for name, done, status, _ in st["inputs"] if not done]
        return {"success": False, "status": "NotReady",
                "message": f"⏳ Final underwriting for **{case.get('customer_name')}** isn't ready to compile. Waiting on: {', '.join(missing)}.",
                "quick_actions": [c for _, done, _, c in st["inputs"] if not done and c][:3]}
    if not args.get("confirm"):
        declined = [n for n in ("medical", "financial") if st["tracks"][n]["status"] == "DECLINED"]
        referred = [n for n in ("medical", "financial") if st["tracks"][n]["status"] == "REFERRED"]
        expect = ("It will be **declined** — a specialist declined it." if declined
                  else "It will go to **human review** — a specialist referred it." if referred
                  else "Both specialists cleared it; the AI's own recommendation stands.")
        return {
            "success": True, "status": "Preview",
            "message": (f"**Ready to compile final underwriting — {case.get('customer_name')} ({ref})**\n\n"
                        f"{_review_line('Medical', st['tracks']['medical'])}\n{_review_line('Financial', st['tracks']['financial'])}\n\n"
                        f"{expect} The run checks remaining document requirements and discrepancies before producing a recommendation; approving is a separate step."),
            "quick_actions": [_chip("Compile and run final underwriting", f"Compile final underwriting for case {ref} — confirm=true"),
                              _open(_case_id(case))],
        }
    # The four compile inputs replace the old five pre-underwriting gates, which the specialists now own.
    return await _HANDLERS["run_risk_assessment"]({**args, "case_number": ref, "bypass_gates": True}, ctx)
