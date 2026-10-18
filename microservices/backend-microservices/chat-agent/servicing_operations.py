"""Back-office servicing stages that follow a request: renewal, reinstatement and
exit processing, and premium collection operations.

servicing_tools.py opens the renewal / reinstatement / surrender; these handlers
work the open case through tenant-service renewals.py, reinstatement.py,
policy_exit.py and post_issuance.py. Each action reads the live case first and
runs only when the case's own `can` flags (or status) allow it, so a repeated
click reports the current state instead of applying a step twice. The backend
remains the authority for every gate; nothing here re-implements one.

Payments are recorded only as already received (manual=True with the user's real
reference and confirmation). The mock gateway is never driven from chat.

Registered by being imported at the foot of tool_executor.py.
"""
from __future__ import annotations

from typing import Optional

from role_operations import EXIT_MANAGERS, operation
from servicing_tools import _case_summary, _entity, _get, _open_action, _pkr, _post, _step_lines, resolve_policy
from tool_executor import ChoiceNeeded, Ctx, _action


def _chip(label: str, payload: str) -> dict:
    return {"label": label, "actionType": "submit", "payload": payload}


def _need(message: str, **extra) -> dict:
    return {"success": False, "error_code": "missing_details", "needs_user_input": True, "retryable": False,
            "error": message, **extra}


def _payment_problem(a) -> Optional[dict]:
    """A received payment needs the user's real method, reference and confirmation — never a placeholder."""
    if not a.payment_method or not (a.payment_reference or "").strip():
        return _need("Which payment method was used, and what is the payment's actual reference (receipt, bank or "
                     "wallet transaction number)? I won't record a payment without them.")
    if not a.payment_confirmed:
        return _need(f"Please confirm the funds for reference {a.payment_reference} were actually received. "
                     "Recording a payment does not collect one.")
    return None


def _received(a) -> dict:
    return {"method": a.payment_method, "reference": a.payment_reference.strip(), "manual": True}


async def _policy(a, ctx: Ctx) -> dict:
    return await resolve_policy(a.model_dump(), ctx)


# ═══════════════════════════════════════════════════════════════════════════
# Renewal
# ═══════════════════════════════════════════════════════════════════════════

# action → (the case's `can` flag, the backend path, the next-step chip label)
_RENEWAL_STEPS = {
    "send_notice": ("notice", "notice", "Send renewal notice"),
    "evaluate_risk": (None, "risk/evaluate", None),
    "record_risk_decision": ("risk_decide", "risk/decision", "Record risk decision"),
    "record_acceptance": ("accept", "acceptance", "Record customer acceptance"),
    "record_payment": ("pay", "payment", "Record renewal premium received"),
    "reconcile_payment": ("reconcile", "reconcile", "Reconcile renewal premium"),
    "complete": ("complete", "complete", "Complete renewal"),
    "cancel": ("cancel", "cancel", None),
}


def _renewal_view(p: dict, ctx: Ctx, case: dict, headline: str, tool: Optional[str] = None) -> dict:
    can = case.get("can") or {}
    number = p.get("policy_number")
    chips = [_chip(label, f"{label} for policy {number}") for action, (flag, _, label) in _RENEWAL_STEPS.items()
             if label and flag and can.get(flag) and action != "send_notice"]
    if can.get("notice") and not (case.get("notice") or {}).get("sent_at"):
        chips.insert(0, _chip("Send renewal notice", f"Send the renewal notice for policy {number}"))
    payment = case.get("payment") or {}
    lines = [headline, f"Renewal **{case.get('renewal_no')}** ({case.get('renewal_type_label') or 'renewal'}) — "
             f"{case.get('status')}, due {case.get('due_date')}"
             + (f", premium {_pkr(payment.get('amount') or case.get('quoted_amount'))}" if payment or case.get("quoted_amount") else "")]
    steps = _step_lines(_case_summary({**case, "reference": case.get("renewal_no")}))
    if steps:
        lines.append(steps)
    out = {"success": True, "entity": _entity(p, ctx), "state": {"case": {k: case.get(k) for k in
           ("id", "renewal_no", "status", "is_open", "can", "risk", "acceptance", "payment", "reconciliation")}},
           "message": "\n".join(lines), "quick_actions": chips[:4] + [_open_action(p)]}
    if tool:
        out["last_action"] = _action(tool, "policy", p["id"], f"post-issuance/{p['id']}", headline.strip("*"))
    return out


@operation("progress_policy_renewal")
async def _progress_policy_renewal(a, ctx: Ctx) -> dict:
    p = await _policy(a, ctx)
    ov = await _get(ctx, p, "/renewals")
    case = ov.get("case") or {}
    number = p.get("policy_number")
    if not case.get("is_open"):
        if a.action == "status" and case:
            return _renewal_view(p, ctx, case, f"The last renewal on **{number}** is closed.")
        eligible = (ov.get("eligibility") or {}).get("eligible")
        return {"success": False, "error_code": "no_open_case", "retryable": False,
                "error": f"No renewal is open on **{number}** — open one first. Nothing was changed.",
                "quick_actions": [_chip("Start renewal", f"Start the renewal for policy {number}")] if eligible else []}
    if a.action == "status":
        return _renewal_view(p, ctx, case, f"Renewal status for **{number}**.")

    flag, path, _ = _RENEWAL_STEPS[a.action]
    if flag and not (case.get("can") or {}).get(flag):
        view = _renewal_view(p, ctx, case, f"That step isn't available on **{number}** right now — nothing was changed.")
        return {**view, "success": False, "error_code": "not_ready"}
    body: dict = {}
    if a.action == "send_notice":
        body = {"channel": a.channel} if a.channel else {}
    elif a.action == "record_risk_decision":
        if not a.decision:
            return _need("What is the risk decision: approve, approve with a loading, or decline?",
                         quick_actions=[_chip(d, f"Record renewal risk decision {d} for policy {number}")
                                        for d in ("Approve", "ApproveWithLoading", "Decline")])
        if a.decision == "ApproveWithLoading" and not a.loading_pct:
            return _need("What loading percentage applies?")
        if a.decision != "Approve" and not (a.note or "").strip():
            return _need("Give the underwriting rationale for this decision; it goes on the renewal file.")
        body = {"decision": a.decision, "loading_pct": a.loading_pct, "notes": a.note}
    elif a.action == "record_acceptance":
        if a.accepted is None:
            return _need("Did the customer accept the renewal terms or refuse them?")
        body = {"accepted": a.accepted, "note": a.note}
        if a.acceptance_method:
            body["method"] = a.acceptance_method
    elif a.action == "record_payment":
        problem = _payment_problem(a)
        if problem:
            return problem
        body = _received(a)
    elif a.action == "reconcile_payment":
        body = {"note": a.note}
    elif a.action == "cancel":
        if not (a.note or "").strip():
            return _need("Why is this renewal being cancelled? The reason goes on the file.")
        body = {"reason": a.note}
    ov = await _post(ctx, p, f"/renewals/{case['id']}/{path}", body)
    done = {"send_notice": "Renewal notice issued", "evaluate_risk": "Renewal risk re-evaluated",
            "record_risk_decision": f"Risk decision **{a.decision}** recorded", "record_acceptance":
            f"Customer {'acceptance' if a.accepted else 'refusal'} recorded",
            "record_payment": f"Renewal premium received (ref {a.payment_reference}) recorded — reconciliation is next",
            "reconcile_payment": "Renewal premium reconciliation run", "complete": "Renewal completed — cover continues",
            "cancel": "Renewal cancelled"}[a.action]
    return _renewal_view(p, ctx, ov.get("case") or case, f"**{done}** on {number}.", "progress_policy_renewal")


# ═══════════════════════════════════════════════════════════════════════════
# Reinstatement
# ═══════════════════════════════════════════════════════════════════════════

_REINSTATEMENT_OPEN = ("Open", "EvidenceRequested", "TermsOffered", "Approved")
_REINSTATEMENT_PATHS = {
    "recalculate_arrears": "arrears/recalculate", "record_declaration": "declaration", "rerun_assessment": "assessment",
    "record_decision": "decision", "record_terms_response": "terms/respond", "record_payment": "payment",
    "restore_cover": "restore", "withdraw": "withdraw",
}


def _reinstatement_view(p: dict, ctx: Ctx, case: dict, headline: str, tool: Optional[str] = None) -> dict:
    number = p.get("policy_number")
    status = case.get("status")
    arrears = case.get("arrears") or {}
    lines = [headline, f"Reinstatement **{case.get('case_no')}** — {status}"
             + (f"; payable {_pkr(case.get('total_payable') or arrears.get('total'))}" if case.get("total_payable") or arrears else "")]
    pending = [e.get("label") for e in case.get("evidence") or [] if e.get("required") and e.get("status") not in ("Received", "Waived")]
    if pending:
        lines.append("Evidence outstanding: " + ", ".join(pending))
    if case.get("restore_blockers"):
        lines.append("Restore blocked: " + "; ".join(case["restore_blockers"]))
    chips = []
    if status in ("Open", "EvidenceRequested") and not case.get("declaration_signed_at"):
        chips.append(_chip("Record declaration", f"Record the reinstatement declaration for policy {number}"))
    elif status in ("Open", "EvidenceRequested"):
        chips.append(_chip("Record decision", f"Record the reinstatement decision for policy {number}"))
    if status == "TermsOffered":
        chips.append(_chip("Record terms response", f"Record the customer's response to the reinstatement terms for policy {number}"))
    if status == "Approved" and not (case.get("payment") or {}).get("realized_at"):
        chips.append(_chip("Record arrears received", f"Record the reinstatement payment for policy {number}"))
    if case.get("can_restore"):
        chips.append(_chip("Restore cover", f"Restore cover on policy {number}"))
    out = {"success": True, "entity": _entity(p, ctx),
           "state": {"case": {k: case.get(k) for k in ("id", "case_no", "status", "decision", "total_payable", "can_restore")}},
           "message": "\n".join(lines), "quick_actions": chips + [_open_action(p)]}
    if tool:
        out["last_action"] = _action(tool, "policy", p["id"], f"post-issuance/{p['id']}", headline.strip("*"))
    return out


@operation("progress_reinstatement")
async def _progress_reinstatement(a, ctx: Ctx) -> dict:
    p = await _policy(a, ctx)
    ov = await _get(ctx, p, "/reinstatement")
    case = ov.get("case") or {}
    number = p.get("policy_number")
    if case.get("status") not in _REINSTATEMENT_OPEN:
        if a.action == "status" and case:
            return _reinstatement_view(p, ctx, case, f"The last reinstatement on **{number}** is closed.")
        return {"success": False, "error_code": "no_open_case", "retryable": False,
                "error": f"No reinstatement request is open on **{number}** — submit one first. Nothing was changed."}
    if a.action == "status":
        return _reinstatement_view(p, ctx, case, f"Reinstatement status for **{number}**.")

    body: dict = {}
    if a.action == "record_declaration":
        questions = ov.get("declaration_questions") or []
        missing = [q for q in questions if q["key"] not in (a.answers or {})]
        if missing:
            return _need("Read each declaration question to the signer and give me their answer (yes/no) to every one — "
                         "I won't answer any on their behalf:\n" + "\n".join(f"- `{q['key']}`: {q['text']}" for q in missing),
                         questions=questions)
        if not (a.signed_by or "").strip() or not a.signature_confirmed:
            return _need("Who signed the declaration, how (wet, e-sign or portal), and do you confirm it is signed?")
        body = {"answers": a.answers, "details": a.answer_details or {}, "signed_by": a.signed_by.strip(),
                "signature_method": a.signature_method or "Wet", "confirm_signed": True}
    elif a.action == "record_decision":
        if not a.decision:
            return _need("What is the underwriting decision: approve, approve with terms, request evidence, or decline?")
        if a.decision != "Approve" and not (a.note or "").strip():
            return _need("Give the underwriting rationale; it is required for this decision.")
        if a.decision == "RequestEvidence" and not a.evidence_requested:
            return _need("Which evidence should the customer provide?")
        body = {"decision": a.decision, "notes": a.note, "loading_pct": a.loading_pct, "exclusions": a.exclusions,
                "evidence": [{"label": label} for label in a.evidence_requested or []]}
    elif a.action == "record_terms_response":
        if a.accepted is None:
            return _need("Did the customer accept the revised terms or reject them?")
        body = {"accepted": a.accepted, "note": a.note}
    elif a.action == "record_payment":
        problem = _payment_problem(a)
        if problem:
            return problem
        body = _received(a)
    elif a.action == "restore_cover":
        if not case.get("can_restore"):
            view = _reinstatement_view(p, ctx, case, f"Cover on **{number}** can't be restored yet — nothing was changed.")
            return {**view, "success": False, "error_code": "not_ready"}
    elif a.action == "withdraw":
        if not (a.note or "").strip():
            return _need("Why is the reinstatement being withdrawn? The reason goes on the file.")
        body = {"reason": a.note}
    ov = await _post(ctx, p, f"/reinstatement/{case['id']}/{_REINSTATEMENT_PATHS[a.action]}", body)
    done = {"recalculate_arrears": "Arrears recalculated", "record_declaration": "Declaration recorded and assessed",
            "rerun_assessment": "Assessment re-run", "record_decision": f"Decision **{a.decision}** recorded",
            "record_terms_response": f"Customer {'accepted' if a.accepted else 'rejected'} the revised terms",
            "record_payment": f"Arrears received (ref {a.payment_reference}) recorded — cover is restored separately",
            "restore_cover": "Cover restored", "withdraw": "Reinstatement withdrawn"}[a.action]
    return _reinstatement_view(p, ctx, ov.get("case") or case, f"**{done}** on {number}.", "progress_reinstatement")


# ═══════════════════════════════════════════════════════════════════════════
# Exit — surrender, maturity, expiry
# ═══════════════════════════════════════════════════════════════════════════

_EXIT_STEPS = {
    "reverify_eligibility": ("verify", "eligibility/verify", "Re-verify eligibility"),
    "decide_extension": ("extension", "extension", "Decide extension"),
    "waive_document": ("documents", None, None),
    "record_consent": ("consent", "consent", "Record consent"),
    "calculate_settlement": ("calculate", "settlement/calculate", "Calculate settlement"),
    "record_settlement_response": ("accept", "settlement/accept", "Record settlement response"),
    "verify_payee": ("verify_payee", "settlement/payee", "Verify payee"),
    "authorize_settlement": ("authorize", "settlement/authorize", "Authorise settlement"),
    "disburse_settlement": ("disburse", "settlement/disburse", "Disburse settlement"),
    "reconcile_settlement": ("reconcile", "settlement/reconcile", "Reconcile payout"),
    "close": ("close", "close", "Close exit"),
    "cancel": ("cancel", "cancel", None),
}


def _exit_view(p: dict, ctx: Ctx, ws: dict, headline: str, tool: Optional[str] = None) -> dict:
    case, can = ws.get("case") or {}, ws.get("can") or {}
    number = p.get("policy_number")
    settlement, payout = ws.get("settlement") or {}, ws.get("disbursement") or {}
    lines = [headline, f"Exit **{case.get('exit_no')}** ({case.get('exit_type_label')}) — {case.get('status')}"]
    if settlement.get("net") is not None:
        lines.append(f"- Settlement {_pkr(settlement['net'])}" + (", accepted" if settlement.get("accepted_at") else ""))
    if payout.get("authorized_at"):
        lines.append("- Authorised" + (f", paid {str(payout['disbursed_at'])[:10]}" if payout.get("disbursed_at") else ", not paid yet"))
    steps = _step_lines(_case_summary({"stages": ws.get("stages")}))
    if steps:
        lines.append(steps)
    chips = [_chip(label, f"{label} for policy {number}") for action, (flag, _, label) in _EXIT_STEPS.items()
             if label and can.get(flag) and (action != "authorize_settlement" or ctx.exec_ctx.role in EXIT_MANAGERS)]
    out = {"success": True, "entity": _entity(p, ctx),
           "state": {"case": {"id": case.get("id"), "exit_no": case.get("exit_no"), "status": case.get("status"),
                              "can": can, "net": settlement.get("net")}},
           "message": "\n".join(lines), "quick_actions": chips[:4] + [_open_action(p)]}
    if tool:
        out["last_action"] = _action(tool, "policy", p["id"], f"post-issuance/{p['id']}", headline.strip("*"))
    return out


@operation("progress_policy_exit")
async def _progress_policy_exit(a, ctx: Ctx) -> dict:
    p = await _policy(a, ctx)
    ov = await _get(ctx, p, "/exit")
    ws = ov.get("case") or {}
    case = ws.get("case") or {}
    number = p.get("policy_number")
    if not case.get("is_open"):
        if a.action == "status" and case:
            return _exit_view(p, ctx, ws, f"The last exit on **{number}** is closed.")
        return {"success": False, "error_code": "no_open_case", "retryable": False,
                "error": f"No exit is open on **{number}**. A surrender is requested with submit_policy_exit_request; "
                         "maturity and expiry exits open automatically. Nothing was changed."}
    if a.action == "status":
        return _exit_view(p, ctx, ws, f"Exit status for **{number}**.")

    flag, path, _ = _EXIT_STEPS[a.action]
    if a.action in ("authorize_settlement", "waive_document") and ctx.exec_ctx.role not in EXIT_MANAGERS:
        return {"success": False, "error_code": "forbidden", "retryable": False,
                "error": "Authorising an exit settlement or waiving an exit document needs a Claims Manager or Admin."}
    if not (ws.get("can") or {}).get(flag):
        view = _exit_view(p, ctx, ws, f"That step isn't available on **{number}** right now — nothing was changed.")
        return {**view, "success": False, "error_code": "not_ready"}
    body: dict = {}
    if a.action == "decide_extension":
        if not a.extension_decision:
            return _need("Did the customer decline the extension, or should they be redirected to a renewal?")
        body = {"decision": a.extension_decision, "note": a.note}
    elif a.action == "waive_document":
        items = (ws.get("documents") or {}).get("items") or []
        needle = (a.document or "").strip().casefold()
        doc = next((d for d in items if needle and needle in (d.get("key", "") + " " + d.get("label", "")).casefold()), None)
        if doc is None:
            raise ChoiceNeeded(f"Which document on {case.get('exit_no')} should I waive?",
                               [_chip(d["label"], f"Waive the {d['label']} on the exit for policy {number}")
                                for d in items if d.get("status") not in ("Received", "Waived")][:6])
        path = f"documents/{doc['key']}/waive"
        body = {"note": a.note}
    elif a.action == "record_consent":
        if not a.consent_confirmed or not (a.consent_given_by or "").strip() or not a.consent_method:
            declarations = (ws.get("consent") or {}).get("declarations") or []
            return _need("Who gave consent, how was it given, and do you confirm they accepted every declaration?\n"
                         + "\n".join(f"- {d.get('text') or d.get('label') or d.get('key')}" for d in declarations))
        body = {"accepted": [d["key"] for d in (ws.get("consent") or {}).get("declarations") or []],
                "by": a.consent_given_by.strip(), "method": a.consent_method}
    elif a.action == "calculate_settlement":
        body = {"recoverables": [r.model_dump() for r in a.recoverables or []], "notes": a.note}
    elif a.action == "record_settlement_response":
        if a.accepted is None:
            return _need("Did the customer accept the settlement quote or reject it?")
        body = {"accepted": a.accepted, "by": a.consent_given_by, "method": a.consent_method, "note": a.note}
    elif a.action == "verify_payee":
        if not (a.account_title or "").strip() or not (a.iban or a.payout_method in ("Pay Order", "JazzCash", "Easypaisa")):
            return _need("Give the payee's account title and IBAN (or the wallet / pay-order method) exactly as on the "
                         "customer's evidence. I won't fill in bank details.")
        body = {"cnic": a.payee_cnic, "bank_name": a.bank_name, "account_title": a.account_title.strip(), "iban": a.iban,
                "method": a.payout_method, "note": a.note, "verify": a.payee_verified}
    elif a.action == "disburse_settlement":
        methods = (ws.get("disbursement") or {}).get("methods") or []
        if not a.payout_method or a.payout_method not in methods:
            return _need("Which payout method should be used?", quick_actions=[
                _chip(m, f"Disburse the exit settlement for policy {number} by {m}") for m in methods])
        body = {"method": a.payout_method}
    elif a.action == "reconcile_settlement":
        body = {"note": a.note}
    elif a.action == "cancel":
        if not (a.note or "").strip():
            return _need("Why is the exit being cancelled? The reason goes on the file.")
        body = {"reason": a.note}
    ov = await _post(ctx, p, f"/exit/{case['id']}/{path}", body)
    done = {"reverify_eligibility": "Eligibility re-verified", "decide_extension": "Extension decision recorded",
            "waive_document": "Document waived", "record_consent": "Consent recorded",
            "calculate_settlement": "Settlement calculated", "record_settlement_response":
            f"Customer {'accepted' if a.accepted else 'rejected'} the settlement",
            "verify_payee": "Payee " + ("verified" if a.payee_verified else "saved (not yet verified)"),
            "authorize_settlement": "Settlement authorised — not paid yet",
            "disburse_settlement": f"Settlement payout recorded by {a.payout_method} — reconciliation is next",
            "reconcile_settlement": "Payout reconciliation run", "close": "Exit closed", "cancel": "Exit cancelled"}[a.action]
    return _exit_view(p, ctx, ov.get("case") or ws, f"**{done}** on {number}.", "progress_policy_exit")


# ═══════════════════════════════════════════════════════════════════════════
# Premium operations
# ═══════════════════════════════════════════════════════════════════════════

async def _instalment(a, ctx: Ctx, p: dict, verb: str) -> tuple[dict, dict]:
    billing = await _get(ctx, p, "/premiums")
    rows = billing.get("installments") or []
    if a.installment_no:
        row = next((r for r in rows if r.get("installment_no") == a.installment_no), None)
        if row is None:
            raise LookupError(f"Policy {p.get('policy_number')} has no instalment {a.installment_no}.")
        return billing, row
    unpaid = sorted((r for r in rows if (r.get("outstanding") or 0) > 0), key=lambda r: r.get("due_date") or "")
    if not unpaid:
        raise LookupError(f"Nothing is outstanding on {p.get('policy_number')}.")
    raise ChoiceNeeded(f"Which instalment on {p.get('policy_number')} should I {verb}?",
                       [_chip(f"#{r['installment_no']} — {_pkr(r.get('payable') or r.get('outstanding'))} due {r.get('due_date')}",
                              f"{verb.capitalize()} instalment {r['installment_no']} on policy {p.get('policy_number')}")
                        for r in unpaid[:6]])


def _billing_line(billing: dict) -> str:
    s = billing.get("summary") or {}
    return (f"{s.get('paid', 0)} of {s.get('total', 0)} instalment(s) paid; outstanding {_pkr(s.get('total_outstanding'))}"
            + (f", {s.get('arrears_count')} overdue" if s.get("arrears_count") else "") + ".")


@operation("record_premium_collection")
async def _record_premium_collection(a, ctx: Ctx) -> dict:
    p = await _policy(a, ctx)
    _, row = await _instalment(a, ctx, p, "record payment for")
    if row.get("status") in ("Paid", "Waived") or not (row.get("outstanding") or 0) > 0:
        return {"success": True, "entity": _entity(p, ctx), "result": {"status": "skipped", "reason": "not_outstanding"},
                "message": f"Instalment {row.get('installment_no')} on **{p.get('policy_number')}** is already "
                           f"{str(row.get('status')).lower()} — nothing was recorded."}
    problem = _payment_problem(a)
    if problem:
        return problem
    billing = await _post(ctx, p, f"/premiums/{row['id']}/collect", _received(a))
    return {"success": True, "entity": _entity(p, ctx), "result": {"status": "completed", "installment_no": row.get("installment_no"),
                                                                  "reference": a.payment_reference},
            "message": f"Recorded {_pkr(row.get('payable') or row.get('outstanding'))} received for instalment "
                       f"{row.get('installment_no')} on **{p.get('policy_number')}** (ref {a.payment_reference}); a receipt "
                       f"was issued. {_billing_line(billing)}",
            "last_action": _action("record_premium_collection", "policy", p["id"], f"post-issuance/{p['id']}", "Premium recorded"),
            "quick_actions": [_open_action(p)]}


@operation("waive_premium_installment")
async def _waive_premium_installment(a, ctx: Ctx) -> dict:
    p = await _policy(a, ctx)
    _, row = await _instalment(a, ctx, p, "waive")
    if row.get("status") in ("Paid", "Waived"):
        return {"success": True, "entity": _entity(p, ctx), "result": {"status": "skipped", "reason": "not_outstanding"},
                "message": f"Instalment {row.get('installment_no')} is already {str(row.get('status')).lower()} — nothing changed."}
    if not (a.reason or "").strip():
        return _need(f"Why is instalment {row.get('installment_no')} being waived? The reason goes on the policy file.")
    billing = await _post(ctx, p, f"/premiums/{row['id']}/waive", {"note": a.reason.strip()})
    return {"success": True, "entity": _entity(p, ctx), "result": {"status": "completed", "installment_no": row.get("installment_no")},
            "message": f"Waived instalment {row.get('installment_no')} on **{p.get('policy_number')}**. {_billing_line(billing)}",
            "last_action": _action("waive_premium_installment", "policy", p["id"], f"post-issuance/{p['id']}", "Instalment waived")}


def _plan_lines(plan: dict) -> str:
    rows = "\n".join(f"| {r.get('installment_no')} | {r.get('due_date')} | {_pkr(r.get('amount'))} |" for r in (plan.get("rows") or [])[:12])
    return (f"{plan.get('installments')} instalment(s), {_pkr(plan.get('remaining'))} outstanding.\n\n"
            "| # | Due | Amount |\n|---|---|---|\n" + rows) if rows else "No outstanding instalments to rebuild."


@operation("preview_premium_restructure")
async def _preview_premium_restructure(a, ctx: Ctx) -> dict:
    p = await _policy(a, ctx)
    plan = await _get(ctx, p, "/premiums/restructure-preview", frequency=a.frequency)
    return {"success": True, "entity": _entity(p, ctx), "result": {"status": "preview", "plan": plan},
            "message": f"**{a.frequency} plan preview — {p.get('policy_number')}** (nothing changed): {_plan_lines(plan)}",
            "quick_actions": [_chip("Apply this plan", f"Restructure policy {p.get('policy_number')} to {a.frequency} payments")]}


@operation("restructure_premium_plan")
async def _restructure_premium_plan(a, ctx: Ctx) -> dict:
    p = await _policy(a, ctx)
    plan = await _get(ctx, p, "/premiums/restructure-preview", frequency=a.frequency)
    billing = await _post(ctx, p, "/premiums/restructure", {"frequency": a.frequency})
    return {"success": True, "entity": _entity(p, ctx), "result": {"status": "completed", "frequency": a.frequency},
            "message": f"**{p.get('policy_number')}** now pays {a.frequency}: {_plan_lines(plan)}\n\n{_billing_line(billing)}",
            "last_action": _action("restructure_premium_plan", "policy", p["id"], f"post-issuance/{p['id']}", "Plan restructured"),
            "quick_actions": [_open_action(p)]}


@operation("issue_lapse_warning")
async def _issue_lapse_warning(a, ctx: Ctx) -> dict:
    p = await _policy(a, ctx)
    summary = (await _get(ctx, p, "/premiums")).get("summary") or {}
    if not summary.get("in_grace") or not (summary.get("total_outstanding") or 0) > 0:
        return {"success": False, "error_code": "not_in_grace", "retryable": False,
                "error": f"**{p.get('policy_number')}** isn't in grace with unpaid arrears, so no lapse warning applies."}
    # The response is the PDF itself; success is the 2xx.
    res = await ctx.client.post(ctx.tsvc(f"/policies/{p['id']}/premiums/lapse-warning"))
    res.raise_for_status()
    return {"success": True, "entity": _entity(p, ctx), "result": {"status": "completed"},
            "message": f"Lapse-warning letter generated for **{p.get('policy_number')}** ({_pkr(summary.get('total_outstanding'))} "
                       f"due, grace until {summary.get('grace_until')}) and logged as a final notice. It still has to be "
                       "posted or handed over — download it from the policy's Premiums tab.",
            "last_action": _action("issue_lapse_warning", "policy", p["id"], f"post-issuance/{p['id']}", "Lapse warning issued"),
            "quick_actions": [_open_action(p)]}


@operation("set_premium_autopay")
async def _set_premium_autopay(a, ctx: Ctx) -> dict:
    p = await _policy(a, ctx)
    billing = await _get(ctx, p, "/premiums")
    state = "on" if a.enabled else "off"
    if bool(billing.get("autopay_enabled")) == a.enabled:
        return {"success": True, "entity": _entity(p, ctx), "result": {"status": "skipped", "reason": "unchanged"},
                "message": f"Auto-debit is already {state} for **{p.get('policy_number')}** — nothing changed."}
    await _post(ctx, p, "/premiums/autopay", {"enabled": a.enabled})
    return {"success": True, "entity": _entity(p, ctx), "result": {"status": "completed", "autopay_enabled": a.enabled},
            "message": f"Auto-debit turned {state} for **{p.get('policy_number')}**.",
            "last_action": _action("set_premium_autopay", "policy", p["id"], f"post-issuance/{p['id']}", f"Auto-debit {state}")}


@operation("list_upcoming_renewals")
async def _list_upcoming_renewals(a, ctx: Ctx) -> dict:
    res = await ctx.client.get(ctx.tsvc("/policies/renewals/upcoming"), params={"days": a.days})
    res.raise_for_status()
    rows = res.json()
    if not rows:
        return {"success": True, "policies": [], "message": f"No individual policies expire in the next {a.days} days."}
    table = "\n".join(f"| {r.get('policy_number')} | {r.get('customer_name')} | {r.get('expiry_date')} | {r.get('days_to_expiry')} | "
                      f"{r.get('status')} |" for r in rows[:25])
    return {"success": True, "policies": rows,
            "message": f"{len(rows)} polic{'y' if len(rows) == 1 else 'ies'} renew within {a.days} days:\n\n"
                       "| Policy | Customer | Expires | Days | Status |\n|---|---|---|---|---|\n" + table,
            "quick_actions": [_chip(f"Renewal readiness — {r.get('policy_number')}",
                                    f"Check renewal readiness for policy {r.get('policy_number')}") for r in rows[:3]]}
