"""Service requests (Request Management) and support tickets (Customer Service)
— microservices/frontend-microservices/docs/agent-scenarios/chatbot-maturity-roadmap.md, P1.

Both services already own their workflow and enforce their own permissions:
the chat forwards the caller's token through the API gateway
(/request-management/v1/…, /customer-service/v1/…) and never decides on their
behalf. What this module adds is the conversation's view of them:

  - one request / ticket resolved by reference, or a choice;
  - an idempotency key derived from the content, so a repeated click or a
    resumed step returns the same request instead of a duplicate;
  - status kept apart from the policy it concerns: an approved request is not
    an applied change until its execution has SUCCEEDED, and a resolved ticket
    says nothing about the application or policy it is linked to.

Registered by being imported at the foot of tool_executor.py.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from typing import Any, Optional

import httpx

from tool_executor import ChoiceNeeded, Ctx, _action, _full_name, _parse_json_arg, handles

_RM = "/request-management/v1"
_CS = "/customer-service/v1"


def _key(*parts: Any) -> str:
    """A stable idempotency key for this content (64 hex chars)."""
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


def _uuid_key(*parts: Any) -> str:
    return str(uuid.UUID(_key(*parts)[:32]))


def _service_error(res: httpx.Response) -> Optional[dict]:
    """These services answer {"error": {"code", "message", "fields"}} or FastAPI's {"detail"}."""
    if res.status_code < 400:
        return None
    try:
        body = res.json()
    except ValueError:
        body = {}
    err = body.get("error") if isinstance(body.get("error"), dict) else {}
    message = err.get("message") or body.get("detail") or f"The service answered {res.status_code}."
    if isinstance(message, list):
        message = "; ".join(str(m.get("msg") if isinstance(m, dict) else m) for m in message)
    fields = "; ".join(f"{f.get('field')}: {f.get('message')}" for f in err.get("fields") or [])
    return {"success": False, "error": f"{message}{' — ' + fields if fields else ''}",
            "error_code": (err.get("code") or {401: "forbidden", 403: "forbidden", 404: "not_found",
                                               409: "conflict", 422: "validation"}.get(res.status_code, "rejected")).lower(),
            "retryable": res.status_code >= 500, "needs_user_input": res.status_code in (400, 422)}


# ═══════════════════════════════════════════════════════════════════════════
# Request Management
# ═══════════════════════════════════════════════════════════════════════════

_REVIEW = {"DRAFT": "draft — not submitted", "SUBMITTED": "submitted, waiting for a reviewer",
           "IN_REVIEW": "in review", "NEEDS_INFORMATION": "waiting for more information from you",
           "APPROVED": "approved", "REJECTED": "rejected", "CANCELLED": "cancelled"}
_EXEC = {"NOT_APPLICABLE": None, "PENDING": "the change is queued", "RUNNING": "the change is being applied",
         "SUCCEEDED": "the change has been applied", "FAILED": "applying the change failed"}


def _request_entity(r: dict, ctx: Ctx) -> dict:
    return {"type": "service_request", "id": r.get("id"), "tenant_id": ctx.tenant_id,
            "reference": r.get("reference_no"), "label": r.get("title")}


def _request_line(r: dict) -> str:
    owner = r.get("assignee_name") or (f"{r.get('queue_role')} queue" if r.get("queue_role") else None)
    exe = _EXEC.get(r.get("execution_status") or "NOT_APPLICABLE")
    return (f"**{r.get('reference_no')}** — {r.get('title')}: {_REVIEW.get(r.get('review_status'), r.get('review_status'))}"
            + (f"; {exe}" if exe else "") + (f"; with {owner}" if owner else "")
            + (" — ⚠️ overdue" if r.get("overdue") else ""))


async def _rm(ctx: Ctx, method: str, path: str, **kw) -> httpx.Response:
    return await getattr(ctx.client, method)(ctx.gateway(_RM + path), **kw)


async def resolve_request(args: dict, ctx: Ctx) -> dict:
    ref = (args.get("request_reference") or "").strip()
    if not ref:
        raise LookupError("Which request? Give its reference number.")
    if re.fullmatch(r"[0-9a-fA-F-]{36}", ref):
        res = await _rm(ctx, "get", f"/requests/{ref}")
        if (err := _service_error(res)):
            raise LookupError(f'Request "{ref}" was not found or is not visible to you.') if res.status_code == 404 else RuntimeError(err["error"])
        return res.json()
    found: list[dict] = []
    for scope in ("mine", "review"):
        res = await _rm(ctx, "get", "/requests", params={"scope": scope, "q": ref, "page_size": 20})
        if res.status_code < 400:
            found += [r for r in res.json().get("items") or [] if r.get("id") not in {f.get("id") for f in found}]
    exact = [r for r in found if (r.get("reference_no") or "").upper() == ref.upper()]
    found = exact or found
    if not found:
        raise LookupError(f'No service request "{ref}" that you can see.')
    if len(found) > 1:
        raise ChoiceNeeded(f'{len(found)} requests match "{ref}". Which one?',
                           [{"label": f"{r.get('reference_no')} — {r.get('title')}"[:70], "actionType": "submit",
                             "payload": f"Show service request {r.get('reference_no')}"} for r in found[:6]])
    res = await _rm(ctx, "get", f"/requests/{found[0]['id']}")
    if (err := _service_error(res)):
        raise RuntimeError(err["error"])
    return res.json()


async def _customer_id(args: dict, ctx: Ctx) -> dict:
    res = await ctx.client.get(ctx.tsvc("/customers"))
    res.raise_for_status()
    cnic, name = (args.get("customer_cnic") or "").strip(), (args.get("customer_name") or "").strip().lower()
    digits = re.sub(r"\D", "", cnic)
    rows = res.json()
    found = [c for c in rows if digits and re.sub(r"\D", "", str(c.get("cnic") or "")) == digits] if cnic else \
            ([c for c in rows if _full_name(c).strip().lower() == name] or [c for c in rows if name and name in _full_name(c).lower()])
    if not found:
        raise LookupError("Which customer is this correction for? Give their CNIC or name.")
    if len(found) > 1:
        raise ChoiceNeeded("More than one customer matches. Which one?",
                           [{"label": f"{_full_name(c)} — {c.get('cnic')}", "actionType": "submit",
                             "payload": f"The customer with CNIC {c.get('cnic')}"} for c in found[:6]])
    return found[0]


@handles("create_service_request")
async def _create_service_request(args: dict, ctx: Ctx) -> dict:
    rtype = args.get("request_type") or "general"
    title = (args.get("title") or "").strip()
    if rtype == "customer_profile_correction":
        customer = await _customer_id(args, ctx)
        changes = _parse_json_arg(args.get("changes_json"), "changes_json") or {}
        payload = {"customer_id": customer["id"], "changes": changes, "reason": args.get("description")}
        title = title or f"Correct {_full_name(customer)}'s details"
    elif rtype == "general":
        payload = {"category": args.get("category") or "OTHER", "description": args.get("description"),
                   "desired_outcome": args.get("desired_outcome")}
    else:
        raise LookupError("request_type must be general or customer_profile_correction. Commission disputes are raised "
                          "from the commission statement.")
    payload = {k: v for k, v in payload.items() if v not in (None, "", {})}
    body = {"request_type": rtype, "title": title or "Service request", "priority": args.get("priority") or "NORMAL",
            "payload": payload}
    res = await _rm(ctx, "post", "/requests", json=body,
                    headers={"Idempotency-Key": _key("rm-create", ctx.exec_ctx.jwt_token[-24:], body)[:100]})
    if (err := _service_error(res)):
        return err
    r = res.json()
    preview = await _rm(ctx, "get", "/route-preview", params={"request_type": rtype})
    route = preview.json() if preview.status_code < 400 else {}
    route = route if isinstance(route, dict) else {}
    target = route.get("target_label")
    return {"success": True, "entity": _request_entity(r, ctx),
            "result": {"status": "accepted", "review_status": r.get("review_status")},
            "message": f"Draft request **{r.get('reference_no')}** created — {r.get('title')}. It is **not submitted** yet"
                       + (f"; once submitted it goes to {target}" if target else "")
                       + ". Add any supporting document, then submit it.",
            "last_action": _action("create_service_request", "service_request", r.get("id"), "requests", "Request drafted"),
            "quick_actions": [{"label": "Submit Request", "actionType": "submit",
                               "payload": f"Submit service request {r.get('reference_no')}"}]}


@handles("get_service_request")
async def _get_service_request(args: dict, ctx: Ctx) -> dict:
    if not args.get("request_reference"):
        res = await _rm(ctx, "get", "/requests", params={"scope": "mine", "page_size": 10, "sort": "-updated_at"})
        if (err := _service_error(res)):
            return err
        items = res.json().get("items") or []
        if not items:
            return {"success": True, "requests": [], "message": "You have no service requests."}
        return {"success": True, "requests": items,
                "message": "Your recent requests:\n" + "\n".join(f"- {_request_line(r)}" for r in items)}
    r = await resolve_request(args, ctx)
    tl = await _rm(ctx, "get", f"/requests/{r['id']}/timeline")
    timeline = tl.json() if tl.status_code < 400 else []
    lines = [f"- {_request_line(r)}"]
    if r.get("review_status") == "NEEDS_INFORMATION":
        ask = next((e for e in reversed(timeline) if "INFORMATION" in str(e.get("event_type", "")).upper()), None)
        lines.append(f"- Reviewer asked: {ask.get('reason') or 'more information'}" if ask else
                     "- The reviewer needs more information — reply or attach evidence, then resubmit.")
    if r.get("decision"):
        d = r["decision"]
        lines.append(f"- Decision: {d.get('decision')} by {d.get('decided_by_name')}"
                     + (f" — {d.get('reason')}" if d.get("reason") else ""))
    execution = r.get("execution") or {}
    if r.get("type", {}).get("executes") and r.get("review_status") == "APPROVED" and r.get("execution_status") != "SUCCEEDED":
        lines.append("- Approved, but the change is **not applied yet**"
                     + (f": {execution.get('last_error')}" if execution.get("last_error") else "."))
    lines += [f"- {str(e.get('created_at'))[:16]} {e.get('event_type')} by {e.get('actor_name')}" for e in timeline[-5:]]
    actions = [{"label": a.replace("-", " ").title(), "actionType": "submit",
                "payload": f"{a.replace('-', ' ')} service request {r.get('reference_no')}"}
               for a in (r.get("allowed_actions") or []) if a in ("submit", "resubmit", "cancel")]
    return {"success": True, "entity": _request_entity(r, ctx),
            "state": {"review_status": r.get("review_status"), "execution_status": r.get("execution_status"),
                      "assignee": r.get("assignee_name"), "queue_role": r.get("queue_role"), "due_at": r.get("due_at"),
                      "allowed_actions": r.get("allowed_actions")},
            "message": "\n".join(lines), "quick_actions": actions}


@handles("add_request_attachment")
async def _add_request_attachment(args: dict, ctx: Ctx) -> dict:
    """Attach a document the platform already holds (a customer's uploaded file).
    A new file from the user's device is attached on the request's own page."""
    r = await resolve_request(args, ctx)
    if r.get("review_status") not in ("DRAFT", "NEEDS_INFORMATION", "SUBMITTED", "IN_REVIEW"):
        return {"success": False, "error_code": "closed", "retryable": False,
                "error": f"**{r.get('reference_no')}** is {r.get('review_status')} — attachments are closed."}
    art_id = (args.get("artifact_id") or "").strip()
    if not art_id:
        return {"success": False, "error_code": "needs_file", "needs_user_input": True, "retryable": False,
                "error": "Which document? Give the id of a document already on the platform (from list_artifacts), "
                         "or attach a new file on the request's page in Request Management."}
    meta = await ctx.client.get(ctx.tsvc(f"/artifacts/{art_id}"))
    meta.raise_for_status()
    info = meta.json()
    if any((a.get("file_name") == info.get("file_name")) for a in r.get("attachments") or []):
        return {"success": True, "entity": _request_entity(r, ctx), "result": {"status": "skipped", "reason": "already_attached"},
                "message": f"**{info.get('file_name')}** is already attached to {r.get('reference_no')}."}
    view = await ctx.client.get(ctx.tsvc(f"/artifacts/{art_id}/view"))
    if view.status_code in (301, 302, 307, 308):
        # A presigned storage URL: fetch it without the platform's Authorization header.
        async with httpx.AsyncClient(timeout=60) as bare:
            view = await bare.get(view.headers["location"])
    view.raise_for_status()
    res = await _rm(ctx, "post", f"/requests/{r['id']}/attachments",
                    files={"file": (info.get("file_name") or "document", view.content, info.get("file_type") or "application/octet-stream")},
                    data={"visibility": "REQUESTER"})
    if (err := _service_error(res)):
        return err
    return {"success": True, "entity": _request_entity(r, ctx), "result": {"status": "completed"},
            "message": f"Attached **{info.get('file_name')}** to **{r.get('reference_no')}**."}


@handles("submit_service_request")
async def _submit_service_request(args: dict, ctx: Ctx) -> dict:
    r = await resolve_request(args, ctx)
    status = r.get("review_status")
    action = "resubmit" if status == "NEEDS_INFORMATION" else "submit"
    if status not in ("DRAFT", "NEEDS_INFORMATION"):
        return {"success": True, "entity": _request_entity(r, ctx), "result": {"status": "skipped", "reason": "already_submitted"},
                "message": f"**{r.get('reference_no')}** is already {_REVIEW.get(status, status)} — nothing was resubmitted."}
    body = {"expected_version": r.get("version")}
    if args.get("reviewer_id"):
        body["reviewer_id"] = args["reviewer_id"]
    res = await _rm(ctx, "post", f"/requests/{r['id']}/{action}", json=body,
                    headers={"Idempotency-Key": _key(action, r["id"], r.get("current_revision_no"))[:100]})
    if (err := _service_error(res)):
        return err
    done = res.json()
    owner = done.get("assignee_name") or (f"the {done.get('queue_role')} queue" if done.get("queue_role") else "the reviewing team")
    return {"success": True, "entity": _request_entity(done, ctx),
            "result": {"status": "accepted", "review_status": done.get("review_status")},
            "message": f"**{done.get('reference_no')}** {'re' if action == 'resubmit' else ''}submitted to {owner}"
                       + (f", due {str(done.get('due_at'))[:10]}" if done.get("due_at") else "")
                       + ". Nothing changes until it is approved"
                       + (" and the change has been applied." if (done.get("type") or {}).get("executes") else "."),
            "last_action": _action("submit_service_request", "service_request", done.get("id"), "requests", "Request submitted")}


# ═══════════════════════════════════════════════════════════════════════════
# Customer Service tickets
# ═══════════════════════════════════════════════════════════════════════════

def _ticket_ref(t: dict) -> str:
    return f"T-{str(t.get('id'))[:8].upper()}"


def _ticket_entity(t: dict, ctx: Ctx) -> dict:
    return {"type": "support_ticket", "id": t.get("id"), "tenant_id": ctx.tenant_id, "reference": _ticket_ref(t),
            "label": t.get("title"), "linked": {"customer_id": t.get("customer_id"), "policy_id": t.get("policy_id")}}


async def _cs(ctx: Ctx, method: str, path: str, **kw) -> httpx.Response:
    return await getattr(ctx.client, method)(ctx.gateway(_CS + path), **kw)


async def resolve_ticket(args: dict, ctx: Ctx) -> dict:
    ref = (args.get("ticket_reference") or "").strip()
    if not ref:
        raise LookupError("Which ticket? Give its reference (T-XXXXXXXX) or title.")
    if re.fullmatch(r"[0-9a-fA-F-]{36}", ref):
        tid = ref
    else:
        res = await _cs(ctx, "get", "/tickets", params={"page_size": 100})
        if (err := _service_error(res)):
            raise RuntimeError(err["error"])
        items = res.json().get("items") or []
        short = ref.upper().removeprefix("T-")
        found = [t for t in items if str(t.get("id")).upper().startswith(short)] or \
                [t for t in items if ref.lower() in (t.get("title") or "").lower()]
        if not found:
            raise LookupError(f'No support ticket "{ref}" that you can see.')
        if len(found) > 1:
            raise ChoiceNeeded(f'{len(found)} tickets match "{ref}". Which one?',
                               [{"label": f"{_ticket_ref(t)} — {t.get('title')}"[:70], "actionType": "submit",
                                 "payload": f"Show support ticket {_ticket_ref(t)}"} for t in found[:6]])
        tid = found[0]["id"]
    res = await _cs(ctx, "get", f"/tickets/{tid}")
    if res.status_code == 404:
        raise LookupError(f'Ticket "{ref}" was not found or is not visible to you.')
    if (err := _service_error(res)):
        raise RuntimeError(err["error"])
    return res.json()


@handles("create_support_ticket")
async def _create_support_ticket(args: dict, ctx: Ctx) -> dict:
    body: dict[str, Any] = {"title": (args.get("title") or "").strip(), "description": (args.get("description") or "").strip(),
                            "category": args.get("category") or "GENERAL", "priority": args.get("priority") or "NORMAL"}
    # Link the record it is about — by canonical id, validated by Customer Service itself.
    if args.get("policy_number"):
        from servicing_tools import resolve_policy
        policy = await resolve_policy({"policy_number": args["policy_number"]}, ctx)
        body.update(policy_id=policy["id"], customer_id=policy.get("customer_id"))
    elif args.get("customer_cnic") or args.get("customer_name"):
        body["customer_id"] = (await _customer_id(args, ctx))["id"]
    if args.get("conversation_summary"):
        body["description"] += f"\n\nConversation summary:\n{args['conversation_summary']}"
    body["idempotency_key"] = _uuid_key("cs-create", ctx.exec_ctx.jwt_token[-24:], body)
    res = await _cs(ctx, "post", "/tickets", json=body)
    if (err := _service_error(res)):
        return err
    t = res.json()
    return {"success": True, "entity": _ticket_entity(t, ctx),
            "result": {"status": "accepted", "ticket_status": t.get("status")},
            "message": f"Support ticket **{_ticket_ref(t)}** opened ({t.get('category')}, {t.get('priority')}) — "
                       f"{t.get('title')}. Response due {str(t.get('due_at'))[:16].replace('T', ' ')}. "
                       "The ticket's status is separate from the policy or application it mentions.",
            "last_action": _action("create_support_ticket", "support_ticket", str(t.get("id")), "customer-service", "Ticket opened")}


@handles("get_support_ticket")
async def _get_support_ticket(args: dict, ctx: Ctx) -> dict:
    if not args.get("ticket_reference"):
        res = await _cs(ctx, "get", "/tickets", params={"page_size": 10, **({"status": args["status"]} if args.get("status") else {})})
        if (err := _service_error(res)):
            return err
        items = res.json().get("items") or []
        if not items:
            return {"success": True, "tickets": [], "message": "No support tickets."}
        return {"success": True, "tickets": items, "message": "Recent tickets:\n" + "\n".join(
            f"- **{_ticket_ref(t)}** — {t.get('title')}: {t.get('status')}"
            + (f" (with {t.get('assignee_name')})" if t.get("assignee_name") else " (unassigned)")
            + (" ⚠️ overdue" if t.get("overdue") else "") for t in items)}
    t = await resolve_ticket(args, ctx)
    events = t.get("events") or []
    lines = [f"**{_ticket_ref(t)}** — {t.get('title')}: **{t.get('status')}**, {t.get('priority')} priority, "
             + (f"with {t.get('assignee_name')}" if t.get("assignee_name") else "unassigned")
             + f", due {str(t.get('due_at'))[:16].replace('T', ' ')}"]
    if t.get("resolution"):
        lines.append(f"Resolution: {t['resolution']}")
    lines += [f"- {str(e.get('created_at'))[:16].replace('T', ' ')} {e.get('kind')} by {e.get('actor_name')}: "
              f"{str(e.get('body'))[:160]}" for e in events[-6:]]
    return {"success": True, "entity": _ticket_entity(t, ctx),
            "state": {"status": t.get("status"), "version": t.get("version"), "assignee": t.get("assignee_name")},
            "message": "\n".join(lines)}


@handles("add_ticket_comment")
async def _add_ticket_comment(args: dict, ctx: Ctx) -> dict:
    t = await resolve_ticket(args, ctx)
    text = (args.get("comment") or "").strip()
    if not text:
        return {"success": False, "error_code": "validation", "needs_user_input": True, "error": "What should the comment say?"}
    if any(e.get("body") == text for e in (t.get("events") or [])[-5:]):
        return {"success": True, "entity": _ticket_entity(t, ctx), "result": {"status": "skipped", "reason": "duplicate"},
                "message": "That exact comment is already on the ticket — it wasn't posted twice."}
    res = await _cs(ctx, "post", f"/tickets/{t['id']}/comments", json={"body": text, "internal": bool(args.get("internal"))})
    if (err := _service_error(res)):
        return err
    return {"success": True, "entity": _ticket_entity(t, ctx), "result": {"status": "completed"},
            "message": f"{'Internal note' if args.get('internal') else 'Reply'} added to **{_ticket_ref(t)}**."}


@handles("assign_support_ticket")
async def _assign_support_ticket(args: dict, ctx: Ctx) -> dict:
    """Customer Service only lets staff claim a ticket for themselves or release it."""
    t = await resolve_ticket(args, ctx)
    release = bool(args.get("release"))
    me = await _cs(ctx, "get", "/me")
    if (err := _service_error(me)):
        return err
    my_id = me.json().get("id")
    if not release and str(t.get("assignee_id")) == str(my_id):
        return {"success": True, "entity": _ticket_entity(t, ctx), "result": {"status": "skipped", "reason": "already_yours"},
                "message": f"**{_ticket_ref(t)}** is already assigned to you."}
    res = await _cs(ctx, "post", f"/tickets/{t['id']}/assignment",
                    json={"version": t.get("version"), "user_id": None if release else my_id})
    if (err := _service_error(res)):
        if res.status_code == 409:
            err["error"] += " Re-read the ticket and try again."
        return err
    return {"success": True, "entity": _ticket_entity(t, ctx), "result": {"status": "completed"},
            "message": f"**{_ticket_ref(t)}** {'released back to the queue' if release else 'is now assigned to you'}."}
