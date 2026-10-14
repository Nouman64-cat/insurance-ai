"""Evidence tools: missing documents, linking a file to a requirement, and the
medical report review (docs/agent-scenarios/chatbot-maturity-roadmap.md, P0).

Registered by being imported at the foot of tool_executor.py, like
group_tools.py. Every handler resolves ONE application and refuses to guess:
several matching applications come back as choices, never as the first match —
a document bound to the wrong person's application is the failure these tools
exist to prevent. Results carry the roadmap's structured contract (`entity`,
`requirements`, `result`) next to the usual message and quick actions, and every
upload/review action names its canonical case id.

The medical review mirrors the portal's: the AI reading is a pre-fill only;
nothing clears the medical gate until staff save values they have reviewed.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Optional

from tool_executor import (
    ChoiceNeeded,
    Ctx,
    _action,
    _case_id,
    _created_key,
    _full_name,
    _parse_json_arg,
    handles,
    upload_documents_action,
)

PORTAL_PUBLIC_URL = os.environ.get("PORTAL_PUBLIC_URL", "http://localhost:3000").rstrip("/")

# Roles that may see medical values and findings (mirrors the portal review screen).
_MEDICAL_STAFF = {"Admin", "SuperAdmin", "Underwriter"}
_REJECTED = {"Rejected", "Re-submission Requested"}
_GATE_CLEARED = {"NotRequired", "Waived", "Completed"}


# ═══════════════════════════════════════════════════════════════════════════
# Resolving the application — exactly one, or a choice
# ═══════════════════════════════════════════════════════════════════════════

def _ref(value: Any) -> str:
    """APP-2026-X and the legacy CASE-2026-X name the same application."""
    return re.sub(r"^CASE-", "APP-", str(value or "").strip().upper())


def _digits(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def _case_label(case: dict) -> str:
    return case.get("applicant_name") or case.get("customer_name") or "—"


def entity_of(case: dict, ctx: Ctx) -> dict:
    return {
        "type": "application",
        "id": _case_id(case),
        "tenant_id": ctx.tenant_id,
        "reference": case.get("caseNumber"),
        "label": _case_label(case),
        "customer_id": case.get("customer_id"),
        "policy_id": case.get("policy_id"),
    }


def _choose(matches: list[dict], what: str) -> ChoiceNeeded:
    return ChoiceNeeded(
        f"More than one application matches {what}. Which one do you mean?",
        [{"label": f"{c.get('caseNumber')} — {_case_label(c)}", "actionType": "submit",
          "payload": f"Use application {c.get('caseNumber')}"} for c in matches[:6]],
    )


async def resolve_application(args: dict, ctx: Ctx, *, require_case: bool = True) -> dict:
    """{"case": dict|None, "customer_id", "policy_id"} for the application the
    user named. Raises LookupError (nothing / not accessible) or ChoiceNeeded
    (several). With require_case=False an application still in Proposals —
    customer and proposal, no underwriting case yet — is also accepted."""
    res = await ctx.client.get(ctx.tsvc("/cases"))
    res.raise_for_status()
    cases = res.json()
    ref, cnic = (args.get("case_number") or "").strip(), (args.get("cnic") or "").strip()
    name = (args.get("applicant_name") or "").strip().lower()

    if ref:
        matches = [c for c in cases if _ref(c.get("caseNumber")) == _ref(ref) or _case_id(c) == ref]
        if not matches:
            raise LookupError(f'Application "{ref}" was not found or is not accessible to you. '
                              "Check the reference — no other application was used instead.")
        what = ref
    elif cnic:
        matches = [c for c in cases if _digits(c.get("customer_cnic")) == _digits(cnic)]
        what = f"CNIC {cnic}"
    elif name:
        exact = [c for c in cases if _case_label(c).strip().lower() == name]
        matches = exact or [c for c in cases if name in _case_label(c).lower()]
        what = f'"{args.get("applicant_name")}"'
    else:
        raise LookupError("Which application? Give its reference (APP-…), the applicant's CNIC or their name.")

    if len(matches) > 1:
        raise _choose(matches, what)
    if matches:
        case = matches[0]
        return {"case": case, "customer_id": case.get("customer_id"), "policy_id": case.get("policy_id")}
    if require_case:
        raise LookupError(f"No underwriting application found for {what}. If it is still a proposal, "
                          "it has no application to attach this to yet.")

    # Still in Proposals: the customer and their latest proposal.
    res = await ctx.client.get(ctx.tsvc("/customers"))
    res.raise_for_status()
    customers = res.json()
    if cnic:
        found = [c for c in customers if _digits(c.get("cnic")) == _digits(cnic)]
    else:
        found = [c for c in customers if _full_name(c).strip().lower() == name] or \
                [c for c in customers if name in _full_name(c).lower()]
    if not found:
        raise LookupError(f"No applicant found for {what}.")
    if len(found) > 1:
        raise ChoiceNeeded(f"More than one applicant matches {what}. Which one do you mean?",
                           [{"label": f"{_full_name(c)} — {c.get('cnic') or 'no CNIC'}", "actionType": "submit",
                             "payload": f"Use the applicant with CNIC {c.get('cnic')}"} for c in found[:6]])
    customer = found[0]
    res = await ctx.client.get(ctx.tsvc(f"/customers/{customer['id']}/policies"))
    res.raise_for_status()
    policies = sorted(res.json(), key=_created_key, reverse=True)
    return {"case": None, "customer": customer, "customer_id": customer["id"],
            "policy_id": policies[0]["id"] if policies else None}


def _review_action(case: dict) -> dict:
    """Opens the application's requirements panel, where the side-by-side review lives."""
    return {"label": "Review Medical Reports", "actionType": "uw_requirements",
            "payload": json.dumps({"caseId": _case_id(case), "caseNo": case.get("caseNumber") or ""})}


# ═══════════════════════════════════════════════════════════════════════════
# Missing documents
# ═══════════════════════════════════════════════════════════════════════════

@handles("request_missing_documents")
async def _request_missing_documents(args: dict, ctx: Ctx) -> dict:
    app = await resolve_application(args, ctx, require_case=False)
    customer_id, policy_id, case = app["customer_id"], app["policy_id"], app["case"]
    if not policy_id:
        raise LookupError("This applicant has no proposal yet, so there is no document list to request. "
                          "Create the proposal first.")
    base = ctx.tsvc(f"/customers/{customer_id}/policies/{policy_id}/document-request")
    if args.get("send_email", True):
        res = await ctx.client.post(f"{base}/send")
        res.raise_for_status()
        data = res.json()
    else:
        res = await ctx.client.get(base)
        res.raise_for_status()
        data = res.json()
        if data.get("expired"):
            res = await ctx.client.post(f"{base}/renew")
            res.raise_for_status()
            data = res.json()
        data["url"] = f"{PORTAL_PUBLIC_URL}{data['link_path']}"
        data["email_status"] = "not_requested"

    items = data.get("requirements") or []
    outstanding = [i for i in items if i.get("state") != "received"]
    requirements = [{"code": i["document_type"], "state": i["state"],
                     "files": [f.get("file_name") for f in i.get("files") or []]} for i in items]
    entity = entity_of(case, ctx) if case else {
        "type": "proposal", "id": policy_id, "tenant_id": ctx.tenant_id,
        "reference": None, "label": _full_name(app.get("customer") or {}), "customer_id": customer_id,
    }

    if not outstanding:
        return {"success": True, "entity": entity, "requirements": requirements,
                "result": {"status": "skipped", "reason": "nothing_outstanding"},
                "message": f"Every required document for **{entity['label']}** has already been received — "
                           "nothing to request."}

    lines = "\n".join(f"- {'🔁' if i['state'] == 'reupload' else '❌'} {i['document_type']}"
                      + (" — needs a clearer re-upload" if i["state"] == "reupload" else "") for i in outstanding)
    email = {
        "sent": f"Emailed the upload link to **{data.get('emailed_to')}**.",
        "failed": f"⚠️ The email to {data.get('emailed_to')} could not be sent — share the link below instead.",
        "no_email": "⚠️ No email address is on file for this customer — share the link below with them.",
        "not_requested": "Share this link with the customer:",
    }[data.get("email_status") or "not_requested"]
    # Staff can also upload on the customer's behalf — bound to this application's id.
    actions = [upload_documents_action(_case_id(case), case.get("caseNumber") or "", case.get("customer_cnic") or "",
                                       [i["document_type"] for i in outstanding])] if case else []
    return {
        "success": True,
        "entity": entity,
        "requirements": requirements,
        "result": {"status": "completed", "email_status": data.get("email_status"),
                   "link": data["url"], "expires_at": data.get("expires_at")},
        "message": f"**{entity['label']}** still needs {len(outstanding)} document(s):\n{lines}\n\n"
                   f"{email}\n{data['url']}",
        "quick_actions": actions,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Link an uploaded file to a required document
# ═══════════════════════════════════════════════════════════════════════════

@handles("link_document_to_requirement")
async def _link_document_to_requirement(args: dict, ctx: Ctx) -> dict:
    case = (await resolve_application(args, ctx))["case"]
    case_id, case_no = _case_id(case), case.get("caseNumber") or ""

    res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/document-checklist"))
    res.raise_for_status()
    required = res.json().get("required") or []
    wanted = (args.get("document_type") or "").strip().lower()
    target = next((d for d in required if d.lower() == wanted), None)
    if target is None:
        raise ChoiceNeeded(f'"{args.get("document_type")}" is not one of this application\'s required documents.',
                           [{"label": d, "actionType": "submit",
                             "payload": f"Link the file to {d} for application {case_no}"} for d in required])

    res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/artifacts"))
    res.raise_for_status()
    files = [a for a in res.json() if not a.get("claim_id")]
    if args.get("artifact_id"):
        found = [a for a in files if a.get("id") == args["artifact_id"]]
    elif args.get("file_name"):
        fname = args["file_name"].strip().lower()
        found = [a for a in files if (a.get("file_name") or "").lower() == fname] or \
                [a for a in files if fname in (a.get("file_name") or "").lower()]
    else:
        found = []
    if not found:
        if not files:
            raise LookupError(f"No files have been uploaded for {case_no} yet.")
        raise ChoiceNeeded(f"Which uploaded file is the {target}?",
                           [{"label": f"{a.get('file_name')} ({a.get('document_type')})", "actionType": "submit",
                             "payload": f"Link file {a.get('file_name')} as {target} for application {case_no}"}
                            for a in files[:8]])
    if len(found) > 1:
        raise ChoiceNeeded(f"Several files match — which one is the {target}?",
                           [{"label": f"{a.get('file_name')} ({a.get('created_at', '')[:10]})", "actionType": "submit",
                             "payload": f"Link file id {a.get('id')} as {target} for application {case_no}"}
                            for a in found[:8]])
    artifact = found[0]
    entity = entity_of(case, ctx)

    if artifact.get("status") in _REJECTED:
        return {"success": False, "entity": entity, "error_code": "evidence_rejected", "retryable": False,
                "needs_user_input": True,
                "error": f"**{artifact.get('file_name')}** could not be read and was marked for re-submission, "
                         f"so it cannot count as the {target}. Upload a clearer copy.",
                "quick_actions": [upload_documents_action(case_id, case_no, case.get("customer_cnic") or "", [target])]}
    if artifact.get("document_type") == target:
        return {"success": True, "entity": entity, "result": {"status": "skipped", "reason": "already_linked"},
                "message": f"**{artifact.get('file_name')}** already counts as the {target} — nothing changed."}

    res = await ctx.client.patch(ctx.tsvc(f"/artifacts/{artifact['id']}"), json={"document_type": target})
    res.raise_for_status()
    try:  # refresh the underwriting requirements this evidence may now satisfy
        await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/requirements/determine"))
    except Exception:
        pass

    res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/document-checklist"))
    res.raise_for_status()
    missing = res.json().get("missing") or []
    pending = artifact.get("status") != "Accepted"
    msg = f"Linked **{artifact.get('file_name')}** to **{target}** on {case_no}."
    if pending:
        msg += " It is still being processed, so it counts once the read completes."
    msg += f"\n\n{len(missing)} document(s) still missing." if missing else "\n\nAll required documents are now in."
    return {
        "success": True,
        "entity": entity,
        "requirements": [{"code": target, "state": "processing" if pending else "accepted",
                          "evidence_ids": [artifact["id"]]}],
        "result": {"status": "completed"},
        "message": msg,
        "last_action": _action("link_document_to_requirement", "case", case_id, "cases", f"{target} linked"),
        "quick_actions": [upload_documents_action(case_id, case_no, case.get("customer_cnic") or "", missing)]
        if missing else [{"label": "Check Documents", "actionType": "submit",
                          "payload": f"Show the document checklist for application {case_no}"}],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Medical reports
# ═══════════════════════════════════════════════════════════════════════════

async def _medical_order(case: dict, ctx: Ctx) -> dict:
    res = await ctx.client.get(ctx.tsvc(f"/cases/{_case_id(case)}/medical-exam"))
    res.raise_for_status()
    return res.json()


def report_rows(order: dict) -> list[dict]:
    """One row per required test: accepted | processing | rejected | missing."""
    reports = order.get("reports") or []
    rows = []
    for test in order.get("required_tests") or []:
        code = test.get("code")
        files = [r for r in reports if r.get("test_code") == code]
        accepted = [f for f in files if f.get("status") == "Accepted"]
        processing = [f for f in files if f.get("status") not in _REJECTED and f.get("status") != "Accepted"]
        state = "accepted" if accepted else "processing" if processing else "rejected" if files else "missing"
        rows.append({
            "code": code, "label": test.get("name") or code, "state": state,
            "evidence_ids": [f["id"] for f in accepted],
            "files": [{"id": f["id"], "file_name": f.get("file_name"), "status": f.get("status")} for f in files],
        })
    return rows


_STATE_LINE = {
    "accepted": "✅ {label} — report processed",
    "processing": "⏳ {label} — report still processing",
    "rejected": "🔁 {label} — report unreadable, needs re-upload",
    "missing": "❌ {label} — no report yet",
    "reviewed": "✅ {label} — reviewed",
}


@handles("get_medical_report_status")
async def _get_medical_report_status(args: dict, ctx: Ctx) -> dict:
    case = (await resolve_application(args, ctx))["case"]
    case_no, staff = case.get("caseNumber"), ctx.exec_ctx.role in _MEDICAL_STAFF
    order = await _medical_order(case, ctx)
    status = order.get("status") or "NotAssessed"
    entity = entity_of(case, ctx)
    base = {"success": True, "entity": entity,
            "state": {"medical_exam_status": status, "gate_satisfied": status in _GATE_CLEARED}}

    if status == "NotAssessed":
        return {**base, "requirements": [],
                "message": f"The medical requirement for **{case_no}** has not been assessed yet.",
                "quick_actions": [{"label": "Assess Medical Requirement", "actionType": "submit",
                                   "payload": f"Assess the medical examination for application {case_no}"}]}
    if status in ("NotRequired", "Waived"):
        why = "is not required at this sum assured" if status == "NotRequired" else \
              f"was waived{': ' + order['waiver_reason'] if order.get('waiver_reason') else ''}"
        return {**base, "requirements": [], "message": f"A medical examination for **{case_no}** {why}. The gate is satisfied."}

    rows = report_rows(order)
    if status == "Completed":
        # The review was recorded for the examination as a whole (older records key results by panel,
        # not by test code), so every test is satisfied regardless of which files were uploaded.
        for r in rows:
            r["state"] = "reviewed"
    ready = bool(rows) and all(r["state"] == "accepted" for r in rows)
    lines = "\n".join("- " + _STATE_LINE[r["state"]].format(label=r["label"]) for r in rows)
    base["state"]["ready_for_review"] = ready and status != "Completed"
    base["requirements"] = rows

    if status == "Completed":
        msg = f"The medical review for **{case_no}** is complete."
        if staff:
            findings = order.get("abnormal_findings") or []
            msg += f" Outcome: **{order.get('outcome')}**"
            msg += f", suggested loading {order.get('suggested_loading_pct')}%." if order.get("suggested_loading_pct") else "."
            msg += "".join(f"\n- {f.get('label')}: {f.get('value')} — {f.get('finding')}" for f in findings)
            base["result"] = {"outcome": order.get("outcome"), "abnormal_findings": findings,
                              "suggested_loading_pct": order.get("suggested_loading_pct")}
        return {**base, "message": msg, "quick_actions": [_review_action(case)] if staff else []}

    actions: list[dict] = []
    if ready:
        head = f"Every required report for **{case_no}** is processed — ready for staff review."
        if staff:
            actions = [_review_action(case), {"label": "Read Reports with AI", "actionType": "submit",
                                              "payload": f"Read the medical reports for application {case_no}"}]
    else:
        waiting = sum(r["state"] != "accepted" for r in rows)
        head = f"Medical examination for **{case_no}** ({status}): {waiting} of {len(rows)} report(s) outstanding."
        if any(r["state"] in ("missing", "rejected") for r in rows):
            actions.append({"label": "Resend Medical Exam Link", "actionType": "submit",
                            "payload": f"Assess the medical examination for application {case_no} and resend the link"})
        if staff:
            actions.append(_review_action(case))
    return {**base, "message": f"{head}\n{lines}", "quick_actions": actions}


@handles("read_medical_reports")
async def _read_medical_reports(args: dict, ctx: Ctx) -> dict:
    case = (await resolve_application(args, ctx))["case"]
    case_no = case.get("caseNumber")
    order = await _medical_order(case, ctx)
    names = {t.get("code"): t.get("name") or t.get("code") for t in order.get("required_tests") or []}
    params: dict[str, Any] = {}
    if args.get("test_code"):
        params["test_code"] = args["test_code"]
    if args.get("refresh"):
        params["refresh"] = "true"
    res = await ctx.client.post(ctx.tsvc(f"/cases/{_case_id(case)}/medical-exam/ai-review"), params=params)
    res.raise_for_status()
    tests = res.json().get("tests") or {}

    lines, unreadable = [], []
    for code, read in tests.items():
        label = names.get(code, code)
        if not read or not read.get("readable") or read.get("value") in (None, ""):
            unreadable.append(label)
            lines.append(f"- ⚠️ **{label}** — could not be read from the report")
            continue
        flag = " — ⚠️ flagged abnormal" if read.get("abnormal") else ""
        evidence = f'\n  > "{read["evidence"]}"' if read.get("evidence") else ""
        lines.append(f"- **{label}**: {read['value']}{flag}{evidence}")

    msg = (f"AI reading of the medical reports for **{case_no}** — a pre-fill for your review; "
           "**nothing has been recorded**.\n" + "\n".join(lines))
    if unreadable:
        msg += f"\n\n{len(unreadable)} test(s) need a value entered by hand."
    msg += "\n\nConfirm or correct each value, then save the review."
    return {
        "success": True,
        "entity": entity_of(case, ctx),
        "result": {"status": "completed", "kind": "ai_prefill", "recorded": False,
                   "tests": tests, "unreadable": unreadable},
        "message": msg,
        "quick_actions": [_review_action(case)],
    }


@handles("record_medical_review")
async def _record_medical_review(args: dict, ctx: Ctx) -> dict:
    if not args.get("staff_reviewed"):
        return {"success": False, "error_code": "review_required", "retryable": False, "needs_user_input": True,
                "error": "Medical results can only be saved once staff have reviewed every value. Confirm or "
                         "correct each value first — an AI reading alone never completes the medical review."}
    results = _parse_json_arg(args.get("results_json"), "results_json")
    if not isinstance(results, dict) or not results:
        raise LookupError('results_json must be an object of test -> value, e.g. {"FBS": "92 mg/dL"}.')

    case = (await resolve_application(args, ctx))["case"]
    case_id, case_no = _case_id(case), case.get("caseNumber")
    order = await _medical_order(case, ctx)
    tests = order.get("required_tests") or []
    by_key = {}
    for t in tests:
        by_key[str(t.get("code")).lower()] = t.get("code")
        by_key[str(t.get("name") or "").lower()] = t.get("code")

    mapped, unknown = {}, []
    for key, value in results.items():
        code = by_key.get(str(key).strip().lower())
        if code is None:
            unknown.append(key)
        else:
            mapped[code] = value
    if unknown:
        raise LookupError(f"Not part of this examination: {', '.join(map(str, unknown))}. "
                          f"Required tests: {', '.join(t.get('code') for t in tests)}.")
    missing = [t.get("name") or t.get("code") for t in tests
               if str(mapped.get(t.get("code"), "")).strip() == ""]
    if missing:
        return {"success": False, "error_code": "incomplete_results", "retryable": False, "needs_user_input": True,
                "error": f"Every required test needs a reviewed value. Still missing: {', '.join(missing)}.",
                "quick_actions": [_review_action(case)]}

    body: dict[str, Any] = {"results": mapped}
    if args.get("artifact_id"):
        body["artifact_id"] = args["artifact_id"]
    res = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/medical-exam/result"), json=body)
    res.raise_for_status()
    done = res.json()

    findings = done.get("abnormal_findings") or []
    msg = f"Medical review saved for **{case_no}** — outcome **{done.get('outcome')}**"
    msg += f", suggested loading {done.get('suggested_loading_pct')}%." if done.get("suggested_loading_pct") else "."
    msg += "".join(f"\n- {f.get('label')}: {f.get('value')} — {f.get('finding')}" for f in findings)
    if done.get("uninsurable"):
        msg += "\n\n⚠️ A result is outside insurable limits — this needs an underwriting decision."
    if done.get("unrated_tests"):
        msg += f"\n\nNot automatically rated (review manually): {', '.join(done['unrated_tests'])}."
    return {
        "success": True,
        "entity": entity_of(case, ctx),
        "state": {"medical_exam_status": done.get("status"), "gate_satisfied": done.get("status") in _GATE_CLEARED},
        "result": {"status": "completed", "outcome": done.get("outcome"), "abnormal_findings": findings,
                   "suggested_loading_pct": done.get("suggested_loading_pct"),
                   "uninsurable": bool(done.get("uninsurable")), "unrated_tests": done.get("unrated_tests") or []},
        "message": msg,
        "last_action": _action("record_medical_review", "case", case_id, "cases", "Medical review recorded"),
        "quick_actions": [{"label": "Check Gate Status", "actionType": "submit",
                           "payload": f"Check pre-underwriting status for case {case_no}"}],
    }
