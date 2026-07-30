"""The single consolidated tool-execution point.

Every REST call a tool makes lives here exactly once, called both by the
graph's permission_gate (graph.py) and by the non-streaming
/chat/execute-tool endpoint VoiceOverlay uses (routers/chat.py).

Handlers are registered in `_HANDLERS` rather than a single if-chain so each
tool stays independently readable and the dispatch cost stays flat as the
toolset grows.

Every handler returns a dict; three keys are special and consumed by the
frontend rather than the LLM:

  last_action   {tool_name, entity_type, entity_id, route, label}
                -> toast + navigate + highlight once a mutation lands
  quick_actions [{label, actionType, payload}]
                -> the recommendation chips under the chat input
  navigate      {route, entity_id, highlight}
                -> an explicit "go here now and pop this row" instruction,
                   used by show_record/navigate_to_page where navigating IS
                   the result rather than a side effect of a mutation
"""

from __future__ import annotations

import asyncio
import json
import os
import random
from dataclasses import dataclass
from datetime import date
from typing import Any, Awaitable, Callable, Optional

import httpx

from pages import build_route, page_for_record, page_for_route
from langgraph.types import interrupt
from langgraph.errors import GraphInterrupt

TENANT_SERVICE_URL = os.environ.get("TENANT_SERVICE_URL", "http://tenant-service:8001")
API_GATEWAY_URL = os.environ.get("API_GATEWAY_URL", "http://api-gateway:8000")

DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001"


@dataclass
class ExecCtx:
    tenant_id: str
    jwt_token: str

    @property
    def headers(self) -> dict[str, str]:
        h = {"X-Tenant-Id": self.tenant_id or DEFAULT_TENANT_ID}
        if self.jwt_token:
            h["Authorization"] = f"Bearer {self.jwt_token}"
        return h

    @property
    def effective_tenant_id(self) -> str:
        return self.tenant_id or DEFAULT_TENANT_ID


@dataclass
class Ctx:
    """What each handler gets: an open HTTP client already carrying auth
    headers, plus the resolved tenant."""
    client: httpx.AsyncClient
    tenant_id: str
    exec_ctx: ExecCtx

    def tsvc(self, path: str) -> str:
        return f"{TENANT_SERVICE_URL}/tenants/{self.tenant_id}{path}"

    def gateway(self, path: str) -> str:
        return f"{API_GATEWAY_URL}{path}"


Handler = Callable[[dict[str, Any], Ctx], Awaitable[dict[str, Any]]]
_HANDLERS: dict[str, Handler] = {}


def handles(name: str):
    def register(fn: Handler) -> Handler:
        _HANDLERS[name] = fn
        return fn
    return register


# ═══════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════

def _title_case(value: Optional[str]) -> str:
    return value.strip().title() if value else "Other"


def _as_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _full_name(record: dict) -> str:
    explicit = record.get("name")
    if explicit:
        return str(explicit)
    return f"{record.get('first_name') or ''} {record.get('last_name') or ''}".strip()


def _matches(record: dict, needle: str, fields: tuple[str, ...]) -> bool:
    n = needle.lower().strip()
    if not n:
        return False
    for f in fields:
        v = record.get(f)
        if v and n in str(v).lower():
            return True
    return n in _full_name(record).lower()


def _find_customer(customers: list[dict], cnic: Optional[str], name: Optional[str]) -> Optional[dict]:
    if cnic:
        exact = next((c for c in customers if c.get("cnic") == cnic), None)
        if exact:
            return exact
    if name:
        return next((c for c in customers if _matches(c, name, ("first_name", "last_name", "cnic"))), None)
    return None


def _find_case(
    cases: list[dict],
    case_number: Optional[str] = None,
    cnic: Optional[str] = None,
    applicant_name: Optional[str] = None,
) -> Optional[dict]:
    if case_number:
        # The model sometimes hands back the raw case id it saw in an earlier
        # tool result instead of the human-facing CASE-YYYY-XXXXXX number —
        # accept either.
        exact = next(
            (c for c in cases if c.get("caseNumber") == case_number or _case_id(c) == case_number),
            None,
        )
        if exact:
            return exact
    if cnic:
        exact = next((c for c in cases if c.get("customer_cnic") == cnic), None)
        if exact:
            return exact
    if applicant_name:
        return next(
            (c for c in cases if _matches(c, applicant_name, ("applicant_name", "customer_name", "caseNumber"))),
            None,
        )
    return None


def _case_id(case: dict) -> str:
    return case.get("caseld") or case.get("id") or ""


async def _resolve_case(args: dict, ctx: Ctx) -> dict:
    """Shared "which case did they mean?" lookup. Raises with an actionable
    message rather than returning None, so every caller doesn't repeat it."""
    res = await ctx.client.get(ctx.tsvc("/cases"))
    res.raise_for_status()
    case = _find_case(res.json(), args.get("case_number"), args.get("cnic"), args.get("applicant_name"))
    if not case:
        hint = args.get("case_number") or args.get("applicant_name") or args.get("cnic") or "that"
        raise LookupError(f'No case found for "{hint}". Create a case first, or check the spelling.')
    return case


def _nav(route: str, entity_id: Optional[str] = None) -> dict:
    """A "take the user here and pop the row" instruction for the frontend."""
    return {"route": build_route(route, entity_id), "entity_id": entity_id or "", "highlight": bool(entity_id)}


def _action(tool: str, entity_type: str, entity_id: str, route: str, label: str) -> dict:
    return {
        "tool_name": tool,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "route": route,
        "label": label,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Navigation & discovery
# ═══════════════════════════════════════════════════════════════════════════

@handles("navigate_to_page")
async def _navigate(args: dict, ctx: Ctx) -> dict:
    route = (args.get("page_name") or "").strip().lstrip("/")
    page = page_for_route(route)
    if not page:
        return {"success": False, "error": f'"{route}" is not a page in this application.'}
    entity_id = args.get("entity_id")
    return {
        "success": True,
        "message": f"Opening {page.label}.",
        "navigate": _nav(route, entity_id),
    }


# Which list endpoint + identifying fields each record type is found through.
# Raw ids are included everywhere: the model frequently echoes back the id a
# create_* tool just returned ("show the case you just created" → the case's
# UUID), and that must resolve just as well as a human-friendly name.
_RECORD_SOURCES: dict[str, dict[str, Any]] = {
    "customer":     {"path": "/customers",        "fields": ("id", "cnic", "first_name", "last_name", "email")},
    "case":         {"path": "/cases",            "fields": ("caseld", "id", "caseNumber", "applicant_name", "customer_name", "customer_cnic")},
    "user":         {"path": "/users/",           "fields": ("id", "full_name", "email")},
    "organization": {"path": "/organizations",    "fields": ("id", "name", "contact_person", "contact_email")},
    "family":       {"path": "/families",         "fields": ("id", "name", "contact_person")},
    "plan":         {"path": "/insurance-plans",  "fields": ("id", "name", "product_name", "insurance_type")},
}


def _record_id(record_type: str, record: dict) -> str:
    """The value the destination page's highlight param expects — CNIC for the
    customer pages, the case id for the case pages, otherwise the row id."""
    if record_type == "customer":
        return str(record.get("cnic") or record.get("id") or "")
    if record_type == "case":
        return _case_id(record)
    return str(record.get("id") or "")


def _describe(record_type: str, record: dict) -> str:
    if record_type == "case":
        return f"{record.get('caseNumber')} — {record.get('applicant_name') or record.get('customer_name') or 'unknown applicant'}"
    if record_type == "customer":
        return f"{_full_name(record)} ({record.get('cnic')})"
    if record_type == "user":
        return f"{record.get('full_name')} <{record.get('email')}>"
    return _full_name(record) or str(record.get("id"))


@handles("show_record")
async def _show_record(args: dict, ctx: Ctx) -> dict:
    record_type = (args.get("record_type") or "").strip()
    identifier = (args.get("identifier") or "").strip()

    source = _RECORD_SOURCES.get(record_type)
    page = page_for_record(record_type)
    if not source or not page:
        return {"success": False, "error": f"I can't look up '{record_type}' records yet."}

    res = await ctx.client.get(ctx.tsvc(source["path"]))
    res.raise_for_status()
    rows = res.json()

    match = next((r for r in rows if _matches(r, identifier, source["fields"])), None)
    if not match:
        return {
            "success": False,
            "message": f'No {record_type} matching "{identifier}". It may not exist yet.',
            "quick_actions": [
                {"label": f"View all {page.label}", "actionType": "navigate", "payload": page.route},
            ],
        }

    entity_id = _record_id(record_type, match)
    label = _describe(record_type, match)
    return {
        "success": True,
        "message": f"Found **{label}** — opening {page.label} and highlighting it.",
        "record": match,
        "navigate": _nav(page.route, entity_id),
        "last_action": _action("show_record", record_type, entity_id, build_route(page.route, entity_id), f"Showing {label}"),
    }


@handles("search_records")
async def _search_records(args: dict, ctx: Ctx) -> dict:
    query = (args.get("query") or "").strip()
    only = args.get("record_type")
    targets = [only] if only else list(_RECORD_SOURCES)

    hits: list[dict] = []
    for record_type in targets:
        source = _RECORD_SOURCES.get(record_type)
        if not source:
            continue
        try:
            res = await ctx.client.get(ctx.tsvc(source["path"]))
            res.raise_for_status()
        except httpx.HTTPError:
            continue  # one unavailable collection shouldn't sink the whole search
        for row in res.json():
            if _matches(row, query, source["fields"]):
                hits.append({"type": record_type, "label": _describe(record_type, row), "id": _record_id(record_type, row)})
            if len(hits) >= 20:
                break

    if not hits:
        return {"success": True, "message": f'Nothing matched "{query}".', "results": []}

    lines = "\n".join(f"- **{h['type']}** — {h['label']}" for h in hits[:10])
    return {
        "success": True,
        "message": f"Found {len(hits)} match(es) for \"{query}\":\n{lines}",
        "results": hits,
        "quick_actions": [
            {"label": f"Show {h['label'][:28]}", "actionType": "submit",
             "payload": f"Show me the {h['type']} {h['label']}"}
            for h in hits[:3]
        ],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Read / list
# ═══════════════════════════════════════════════════════════════════════════

@handles("list_customers")
async def _list_customers(args: dict, ctx: Ctx) -> dict:
    res = await ctx.client.get(ctx.tsvc("/customers"))
    res.raise_for_status()
    rows = res.json()

    if args.get("search"):
        rows = [r for r in rows if _matches(r, args["search"], ("cnic", "first_name", "last_name"))]
    if args.get("segment"):
        rows = [r for r in rows if (r.get("segment") or "individual") == args["segment"]]

    limit = int(args.get("limit") or 10)
    shown = rows[:limit]
    if not shown:
        return {"success": True, "message": "No customers match that.", "customers": []}

    lines = "\n".join(f"- **{_full_name(r)}** — {r.get('cnic')} · {r.get('occupation') or 'n/a'}" for r in shown)
    return {
        "success": True,
        "message": f"{len(rows)} customer(s):\n{lines}" + ("\n…" if len(rows) > limit else ""),
        "customers": shown,
        "quick_actions": [{"label": "Open Leads", "actionType": "navigate", "payload": "admin/leads"}],
    }


@handles("list_cases")
async def _list_cases(args: dict, ctx: Ctx) -> dict:
    res = await ctx.client.get(ctx.tsvc("/cases"))
    res.raise_for_status()
    rows = res.json()

    if args.get("status"):
        rows = [r for r in rows if r.get("caseStatus") == args["status"]]
    if args.get("case_type"):
        rows = [r for r in rows if r.get("caseType") == args["case_type"]]

    limit = int(args.get("limit") or 10)
    shown = rows[:limit]
    if not shown:
        return {"success": True, "message": "No cases match that filter.", "cases": []}

    lines = "\n".join(
        f"- **{r.get('caseNumber')}** — {r.get('applicant_name') or r.get('customer_name') or '—'} · {r.get('caseStatus')}"
        for r in shown
    )
    return {
        "success": True,
        "message": f"{len(rows)} case(s):\n{lines}" + ("\n…" if len(rows) > limit else ""),
        "cases": shown,
        "quick_actions": [{"label": "Open Underwriting", "actionType": "navigate", "payload": "underwriting"}],
    }


@handles("get_case_details")
async def _get_case_details(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)
    res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/detail"))
    res.raise_for_status()
    detail = res.json()
    customer = detail.get("customer") or {}
    policy = detail.get("policy") or {}
    assessment = detail.get("latest_assessment") or {}

    return {
        "success": True,
        "message": (
            f"**{case.get('caseNumber')}** — {_full_name(customer) or '—'}\n"
            f"- Status: {case.get('caseStatus')}\n"
            f"- Type: {case.get('caseType')} · Priority: {case.get('priorityLevel')}\n"
            f"- Product: {policy.get('product_name') or 'no proposal yet'}\n"
            f"- AI decision: {assessment.get('ai_decision') or 'not assessed yet'}"
        ),
        "case": detail,
        "navigate": _nav("cases", case_id),
        "quick_actions": [
            {"label": "View Case", "actionType": "navigate", "payload": build_route("cases", case_id)},
        ],
    }


@handles("get_document_checklist")
async def _get_document_checklist(args: dict, ctx: Ctx) -> dict:
    while True:
        case = await _resolve_case(args, ctx)
        case_id = _case_id(case)
        res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/document-checklist"))
        res.raise_for_status()
        cl = res.json()
        missing = cl.get("missing") or []
        received = cl.get("received") or []

        body = f"Documents for **{case.get('caseNumber')}**:\n"
        body += "".join(f"- ✅ {d}\n" for d in received)
        body += "".join(f"- ❌ {d} (missing)\n" for d in missing)
        body += "\nAll required documents are in — the assessment can run." if not missing else \
                f"\n{len(missing)} document(s) still needed before the assessment can run."

        if not missing:
            return {
                "success": True,
                "message": body,
                "checklist": cl,
                "quick_actions": [
                    {"label": "Run Risk Assessment", "actionType": "submit",
                     "payload": f"Run risk assessment for case {case.get('caseNumber')}"}
                ],
            }

        upload_actions = [
            {"label": f"Upload {doc}", "actionType": "upload",
             "payload": json.dumps({"document_type": doc, "cnic": case.get("customer_cnic") or args.get("cnic") or ""})}
            for doc in missing[:3]
        ]
        answer = interrupt({
            "kind": "clarify",
            "tool_call": {"name": "get_document_checklist", "args": args},
            "question": body,
            "custom_actions": upload_actions + [{"label": "Proceed", "actionType": "submit", "payload": "Proceed"}]
        })
        if str(answer).lower() not in ("proceed", "yes", "true"):
            return {"success": True, "message": "Document check completed."}
        # Brief pause to let the backend fully persist the uploaded document
        await asyncio.sleep(1.5)


@handles("list_artifacts")
async def _list_artifacts(args: dict, ctx: Ctx) -> dict:
    # Artifacts are exposed per-case, so fan out across cases and flatten.
    cases_res = await ctx.client.get(ctx.tsvc("/cases"))
    cases_res.raise_for_status()

    artifacts: list[dict] = []
    for case in cases_res.json()[:25]:
        try:
            r = await ctx.client.get(ctx.tsvc(f"/cases/{_case_id(case)}/artifacts"))
            r.raise_for_status()
        except httpx.HTTPError:
            continue
        for a in r.json():
            a["case_number"] = case.get("caseNumber")
            artifacts.append(a)

    if args.get("status"):
        artifacts = [a for a in artifacts if a.get("status") == args["status"]]

    limit = int(args.get("limit") or 10)
    shown = artifacts[:limit]
    if not shown:
        return {"success": True, "message": "No documents found.", "artifacts": []}

    lines = "\n".join(f"- **{a.get('name') or a.get('file_name')}** — {a.get('status')} ({a.get('case_number')})" for a in shown)
    return {
        "success": True,
        "message": f"{len(artifacts)} document(s):\n{lines}",
        "artifacts": shown,
        "quick_actions": [{"label": "Open Artifacts", "actionType": "navigate", "payload": "artifacts"}],
    }


@handles("list_users")
async def _list_users(args: dict, ctx: Ctx) -> dict:
    res = await ctx.client.get(ctx.tsvc("/users/"))
    res.raise_for_status()
    rows = res.json()
    if args.get("role"):
        rows = [u for u in rows if (u.get("role") or {}).get("name") == args["role"] or u.get("role_name") == args["role"]]
    if not rows:
        return {"success": True, "message": "No users match that.", "users": []}

    lines = "\n".join(
        f"- **{u.get('full_name')}** — {u.get('email')} · {(u.get('role') or {}).get('name') or u.get('role_name') or '—'}"
        for u in rows[:15]
    )
    return {
        "success": True,
        "message": f"{len(rows)} user(s):\n{lines}",
        "users": rows,
        "quick_actions": [{"label": "Open Users", "actionType": "navigate", "payload": "admin/users"}],
    }


def _simple_list(path: str, route: str, noun: str):
    """Most list endpoints only differ by URL and noun — build the handler."""
    async def handler(args: dict, ctx: Ctx) -> dict:
        res = await ctx.client.get(ctx.tsvc(path))
        res.raise_for_status()
        rows = res.json()
        if not rows:
            return {"success": True, "message": f"No {noun} yet.", "items": []}
        lines = "\n".join(f"- **{_full_name(r) or r.get('product_name') or r.get('id')}**" for r in rows[:15])
        return {
            "success": True,
            "message": f"{len(rows)} {noun}:\n{lines}",
            "items": rows,
            "quick_actions": [{"label": f"Open {noun.title()}", "actionType": "navigate", "payload": route}],
        }
    return handler


_HANDLERS["list_organizations"] = _simple_list("/organizations", "admin/organizations", "organizations")
_HANDLERS["list_family_groups"] = _simple_list("/families", "admin/families", "family groups")
_HANDLERS["list_insurance_plans"] = _simple_list("/insurance-plans", "plans", "insurance plans")


@handles("list_quotes")
async def _list_quotes(args: dict, ctx: Ctx) -> dict:
    res = await ctx.client.get(ctx.gateway("/quotes"))
    res.raise_for_status()
    rows = res.json()
    if not rows:
        return {"success": True, "message": "No quotations generated yet.", "quotes": []}
    lines = "\n".join(
        f"- **{q.get('customer_name') or q.get('customer_id')}** — PKR {(q.get('annual_premium') or 0):,.0f}/yr"
        for q in rows[:10]
    )
    return {
        "success": True,
        "message": f"{len(rows)} quotation(s):\n{lines}",
        "quotes": rows,
        "quick_actions": [{"label": "Open Proposals", "actionType": "navigate", "payload": "proposal"}],
    }


@handles("get_risk_assessment")
async def _get_risk_assessment(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)
    res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/detail"))
    res.raise_for_status()
    a = (res.json() or {}).get("latest_assessment")
    if not a:
        return {
            "success": True,
            "message": f"**{case.get('caseNumber')}** hasn't been assessed yet.",
            "quick_actions": [{"label": "Run Risk Assessment", "actionType": "submit",
                               "payload": f"Run risk assessment for case {case.get('caseNumber')}"}],
        }

    reasons = "\n".join(f"  - {r}" for r in (a.get("reasons") or [])[:5])
    results_route = f"case/{case_id}"  # detail page with scores, not the documents view
    return {
        "success": True,
        "message": (
            f"Assessment for **{case.get('caseNumber')}**\n"
            f"- Medical: {a.get('medical_score')}/100\n"
            f"- Financial: {a.get('financial_score')}/100\n"
            f"- Fraud probability: {a.get('fraud_probability')}\n"
            f"- Composite: {a.get('composite_risk_score')}/100\n"
            f"- **Decision: {a.get('ai_decision')}**\n"
            + (f"\nReasons:\n{reasons}" if reasons else "")
        ),
        "assessment": {
            "scores": a,
            "case_id": case_id,
            "ai_decision": a.get("ai_decision"),
            "reasons": a.get("reasons", []),
            "medical_reasons": a.get("medical_reasons", []),
            "financial_reasons": a.get("financial_reasons", []),
            "fraud_reasons": a.get("fraud_reasons", []),
        },
        "navigate": {"route": results_route, "entity_id": "", "highlight": False},
        "quick_actions": [{"label": "View Full Results", "actionType": "navigate", "payload": results_route}],
    }


@handles("get_dashboard_stats")
async def _get_dashboard_stats(args: dict, ctx: Ctx) -> dict:
    cases_res = await ctx.client.get(ctx.tsvc("/cases"))
    cases_res.raise_for_status()
    cases = cases_res.json()

    by_status: dict[str, int] = {}
    for c in cases:
        by_status[c.get("caseStatus") or "Unknown"] = by_status.get(c.get("caseStatus") or "Unknown", 0) + 1

    try:
        cust_res = await ctx.client.get(ctx.tsvc("/customers"))
        cust_res.raise_for_status()
        customer_count = len(cust_res.json())
    except httpx.HTTPError:
        customer_count = 0

    breakdown = "\n".join(f"  - {k}: {v}" for k, v in sorted(by_status.items(), key=lambda kv: -kv[1]))
    return {
        "success": True,
        "message": f"**Platform snapshot**\n- Customers: {customer_count}\n- Cases: {len(cases)}\n{breakdown}",
        "stats": {"customers": customer_count, "cases": len(cases), "by_status": by_status},
        "quick_actions": [{"label": "Open Dashboard", "actionType": "navigate", "payload": build_route("dashboard")}],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Write — customers
# ═══════════════════════════════════════════════════════════════════════════

def _customer_payload(src: dict) -> dict:
    dob = src.get("date_of_birth") or src.get("dob")
    if dob and len(str(dob)) > 10:
        dob = str(dob)[:10]
    return {
        "first_name": src.get("first_name"),
        "last_name": src.get("last_name"),
        "cnic": src.get("cnic"),
        "date_of_birth": dob,
        "gender": _title_case(src.get("gender")),
        "occupation": src.get("occupation"),
        "declared_income": _as_float(src.get("declared_income")) or 0,
        "is_smoker": bool(src.get("is_smoker", False)),
        "height_cm": _as_float(src.get("height_cm")) or 170,
        "weight_kg": _as_float(src.get("weight_kg")) or 70,
        "details": {},
    }


@handles("add_customer")
async def _add_customer(args: dict, ctx: Ctx) -> dict:
    res = await ctx.client.post(ctx.tsvc("/customers"), json=_customer_payload(args))
    res.raise_for_status()
    data = res.json()
    name = f"{args.get('first_name')} {args.get('last_name')}".strip()
    cnic = args.get("cnic")
    route = build_route("admin/leads", cnic)
    return {
        "success": True,
        "customer_id": data.get("id"),
        "message": f"Customer **{name}** registered.",
        "last_action": _action("add_customer", "customer", cnic or data.get("id", ""), route, f"Customer {name} added"),
        "quick_actions": [
            {"label": "View Lead", "actionType": "navigate", "payload": route},
            {"label": "Create Case", "actionType": "submit", "payload": f"Create an underwriting case for CNIC {cnic}"},
        ],
    }


@handles("update_customer")
async def _update_customer(args: dict, ctx: Ctx) -> dict:
    res = await ctx.client.get(ctx.tsvc("/customers"))
    res.raise_for_status()
    customer = _find_customer(res.json(), args.get("cnic"), args.get("name"))
    if not customer:
        raise LookupError(f"No customer found for \"{args.get('name') or args.get('cnic')}\".")

    updates = {k: v for k, v in {
        "occupation": args.get("occupation"),
        "declared_income": _as_float(args.get("declared_income")),
        "is_smoker": args.get("is_smoker"),
        "height_cm": _as_float(args.get("height_cm")),
        "weight_kg": _as_float(args.get("weight_kg")),
    }.items() if v is not None}
    if not updates:
        return {"success": False, "message": "Nothing to update — tell me which field to change."}

    merged = {**customer, **updates}
    put = await ctx.client.put(ctx.tsvc(f"/customers/{customer['id']}"), json=_customer_payload(merged))
    put.raise_for_status()

    name = _full_name(customer)
    route = build_route("admin/leads", customer.get("cnic"))
    return {
        "success": True,
        "message": f"Updated **{name}** — {', '.join(updates)}.",
        "last_action": _action("update_customer", "customer", customer.get("cnic", ""), route, f"{name} updated"),
        "quick_actions": [{"label": "View Lead", "actionType": "navigate", "payload": route}],
    }


@handles("delete_customer")
async def _delete_customer(args: dict, ctx: Ctx) -> dict:
    res = await ctx.client.get(ctx.tsvc("/customers"))
    res.raise_for_status()
    customer = _find_customer(res.json(), args.get("cnic"), args.get("name"))
    if not customer:
        raise LookupError(f"No customer found for \"{args.get('name') or args.get('cnic')}\".")

    delete = await ctx.client.delete(ctx.tsvc(f"/customers/{customer['id']}"))
    delete.raise_for_status()
    return {
        "success": True,
        "message": f"Deleted **{_full_name(customer)}**.",
        "quick_actions": [{"label": "View Leads", "actionType": "navigate", "payload": "admin/leads"}],
    }


@handles("bulk_add_customers")
async def _bulk_add_customers(args: dict, ctx: Ctx) -> dict:
    raw = args.get("customers_json") or args.get("customers")
    if isinstance(raw, str):
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1].rsplit("```", 1)[0]
        try:
            customers = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            raise ValueError(f"That customer list isn't valid JSON: {exc}")
    else:
        customers = raw
    if not isinstance(customers, list):
        raise ValueError("Expected an array of customers.")

    ok, failed, first_error = 0, 0, None
    for c in customers:
        try:
            r = await ctx.client.post(ctx.tsvc("/customers"), json=_customer_payload(c))
            r.raise_for_status()
            ok += 1
        except httpx.HTTPError as exc:
            failed += 1
            first_error = first_error or str(exc)

    if ok == 0 and failed:
        raise ValueError(f"Every customer failed to import. First error: {first_error}")

    return {
        "success": True,
        "message": f"Imported **{ok}** customer(s)" + (f", {failed} failed." if failed else "."),
        "last_action": _action("bulk_add_customers", "customer", "", "admin/leads", f"{ok} customers added"),
        "quick_actions": [{"label": "View Leads", "actionType": "navigate", "payload": "admin/leads"}],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Write — users, organizations, families
# ═══════════════════════════════════════════════════════════════════════════

@handles("add_user")
async def _add_user(args: dict, ctx: Ctx) -> dict:
    roles_res = await ctx.client.get(f"{TENANT_SERVICE_URL}/roles")
    roles_res.raise_for_status()
    role = next((r for r in roles_res.json() if r["name"].lower() == args["role_name"].lower()), None)
    if not role:
        raise LookupError(f"Role {args['role_name']} doesn't exist.")

    res = await ctx.client.post(
        ctx.tsvc("/users/"),
        json={"full_name": args["full_name"], "email": args["email"], "role_id": role["id"]},
    )
    res.raise_for_status()
    data = res.json()
    route = build_route("admin/users", data["id"])
    return {
        "success": True,
        "user_id": data["id"],
        "message": f"**{args['full_name']}** added as {args['role_name']}.",
        "last_action": _action("add_user", "user", data["id"], route, f"User {args['full_name']} added"),
        "quick_actions": [{"label": "View User", "actionType": "navigate", "payload": route}],
    }


@handles("delete_user")
async def _delete_user(args: dict, ctx: Ctx) -> dict:
    res = await ctx.client.get(ctx.tsvc("/users/"))
    res.raise_for_status()
    needle = args.get("email") or args.get("full_name") or ""
    user = next((u for u in res.json() if _matches(u, needle, ("email", "full_name"))), None)
    if not user:
        raise LookupError(f'No user found for "{needle}".')

    delete = await ctx.client.delete(ctx.tsvc(f"/users/{user['id']}"))
    delete.raise_for_status()
    return {
        "success": True,
        "message": f"Removed **{user.get('full_name')}**.",
        "quick_actions": [{"label": "View Users", "actionType": "navigate", "payload": "admin/users"}],
    }


@handles("add_organization")
async def _add_organization(args: dict, ctx: Ctx) -> dict:
    res = await ctx.client.post(ctx.tsvc("/organizations"), json={
        "name": args["name"],
        "contact_person": args.get("contact_person"),
        "contact_email": args.get("contact_email"),
        "contact_phone": args.get("contact_phone"),
    })
    res.raise_for_status()
    data = res.json()
    route = build_route("admin/organizations", data["id"])
    return {
        "success": True,
        "organization_id": data["id"],
        "message": f"Organization **{args['name']}** created.",
        "last_action": _action("add_organization", "organization", data["id"], route, f"Organization {args['name']} added"),
        "quick_actions": [{"label": "View Organization", "actionType": "navigate", "payload": route}],
    }


@handles("add_family_group")
async def _add_family_group(args: dict, ctx: Ctx) -> dict:
    res = await ctx.client.post(ctx.tsvc("/families"), json={
        "name": args["name"],
        "contact_person": args.get("contact_person"),
        "contact_email": args.get("contact_email"),
        "contact_phone": args.get("contact_phone"),
        "household_declared_income": _as_float(args.get("household_declared_income")),
    })
    res.raise_for_status()
    family_id = res.json()["id"]
    message = f"Family group **{args['name']}** created."

    members = args.get("members")
    if members:
        fp = await ctx.client.post(
            ctx.tsvc(f"/families/{family_id}/floater-policies"),
            json={"total_sum_insured": 5_000_000, "term_years": 1, "effective_date": date.today().isoformat()},
        )
        fp.raise_for_status()
        confirm = await ctx.client.post(
            ctx.tsvc(f"/families/{family_id}/floater-policies/{fp.json()['id']}/members/confirm"),
            json={"members": members},
        )
        confirm.raise_for_status()
        message += f" Enrolled {len(members)} member(s)."

    route = build_route("admin/families", family_id)
    return {
        "success": True,
        "family_group_id": family_id,
        "message": message,
        "last_action": _action("add_family_group", "family", family_id, route, f"Family {args['name']} added"),
        "quick_actions": [{"label": "View Family", "actionType": "navigate", "payload": route}],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Write — cases & policies
# ═══════════════════════════════════════════════════════════════════════════

@handles("create_case")
async def _create_case(args: dict, ctx: Ctx) -> dict:
    cust_res = await ctx.client.get(ctx.tsvc("/customers"))
    cust_res.raise_for_status()
    customer = _find_customer(cust_res.json(), args.get("cnic"), args.get("applicant_name"))
    if not customer:
        raise LookupError(
            f"No customer found for \"{args.get('applicant_name') or args.get('cnic')}\". Register them first."
        )

    res = await ctx.client.post(ctx.tsvc("/cases"), json={
        "customer_id": customer["id"],
        "caseType": args.get("case_type") or "Underwriting",
        "priorityLevel": args.get("priority_level") or "Normal",
        "sourceChannel": "Online",
    })
    res.raise_for_status()
    data = res.json()
    case_id = data.get("caseld") or data.get("id")
    case_no = data.get("caseNumber") or case_id
    route = build_route("cases", case_id)
    return {
        "success": True,
        "case_id": case_id,
        "message": f"Case **{case_no}** opened for {_full_name(customer)}.",
        "last_action": _action("create_case", "case", case_id, route, f"Case {case_no} created"),
        "quick_actions": [
            {"label": "View Case", "actionType": "navigate", "payload": route},
            {"label": "Create Proposal", "actionType": "submit",
             "payload": f"Create a proposal for CNIC {customer.get('cnic')}"},
        ],
    }


@handles("update_case_status")
async def _update_case_status(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)
    res = await ctx.client.patch(ctx.tsvc(f"/cases/{case_id}/status"), json={"status": args["new_status"]})
    res.raise_for_status()

    if args.get("notes"):
        try:
            await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/comments"), json={
                "commentText": args["notes"], "commentType": "Internal", "visibilityLevel": "Team",
            })
        except httpx.HTTPError:
            pass  # the status change is what matters; a failed note isn't worth failing the call

    route = build_route("cases", case_id)
    status = args["new_status"]
    view_case = {"label": "View Case", "actionType": "navigate", "payload": route}
    follow_up = {
        "Under Review": [
            {"label": "Approve", "actionType": "submit", "payload": f"Approve case {case.get('caseNumber')}"},
            {"label": "Reject", "actionType": "submit", "payload": f"Reject case {case.get('caseNumber')}"},
            view_case,
        ],
        "Approved": [
            {"label": "Close Case", "actionType": "submit", "payload": f"Close case {case.get('caseNumber')}"},
            view_case,
        ],
        "Rejected": [
            {"label": "Close Case", "actionType": "submit", "payload": f"Close case {case.get('caseNumber')}"},
            view_case,
        ],
    }.get(status, [view_case])

    return {
        "success": True,
        "message": f"**{case.get('caseNumber')}** moved to **{status}**.",
        "last_action": _action("update_case_status", "case", case_id, route, f"{case.get('caseNumber')} → {status}"),
        "quick_actions": follow_up,
    }


@handles("assign_case")
async def _assign_case(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)

    users_res = await ctx.client.get(ctx.tsvc("/users/"))
    users_res.raise_for_status()
    needle = args.get("assigned_user_name") or ""
    user = next((u for u in users_res.json() if _matches(u, needle, ("full_name", "email"))), None)
    if not user:
        raise LookupError(f'No user named "{needle}". Try list_users to see who is available.')

    res = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/assignments"), json={
        "assignedToUserld": user["id"],
        "assignedRole": args.get("assigned_role") or "Underwriter",
    })
    res.raise_for_status()

    route = build_route("cases", case_id)
    return {
        "success": True,
        "message": f"**{case.get('caseNumber')}** assigned to **{user.get('full_name')}**.",
        "last_action": _action("assign_case", "case", case_id, route, f"Assigned to {user.get('full_name')}"),
        "quick_actions": [
            {"label": "View Case", "actionType": "navigate", "payload": route},
            {"label": "Start Work", "actionType": "submit",
             "payload": f"Move case {case.get('caseNumber')} to InProgress"},
        ],
    }


@handles("add_case_comment")
async def _add_case_comment(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)
    res = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/comments"), json={
        "commentText": args["comment_text"],
        "commentType": args.get("comment_type") or "Internal",
        "visibilityLevel": "Team",
    })
    res.raise_for_status()
    route = build_route("cases", case_id)
    return {
        "success": True,
        "message": f"Note added to **{case.get('caseNumber')}**.",
        "last_action": _action("add_case_comment", "case", case_id, route, "Comment added"),
        "quick_actions": [{"label": "View Case", "actionType": "navigate", "payload": route}],
    }


@handles("delete_case")
async def _delete_case(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    res = await ctx.client.delete(ctx.tsvc(f"/cases/{_case_id(case)}"))
    res.raise_for_status()
    return {
        "success": True,
        "message": f"Deleted case **{case.get('caseNumber')}** and its history.",
        "quick_actions": [{"label": "View Cases", "actionType": "navigate", "payload": "cases"}],
    }


@handles("create_proposal")
async def _create_proposal(args: dict, ctx: Ctx) -> dict:
    cust_res = await ctx.client.get(ctx.tsvc("/customers"))
    cust_res.raise_for_status()
    customer = _find_customer(cust_res.json(), args.get("cnic"), args.get("applicant_name"))
    if not customer:
        raise LookupError(f"No customer found for \"{args.get('applicant_name') or args.get('cnic')}\".")

    coverage = _as_float(args.get("coverage_amount")) or 5_000_000
    res = await ctx.client.post(ctx.tsvc(f"/customers/{customer['id']}/policies"), json={
        "product_name": args.get("product_name") or "Term Life Plus",
        "insurance_type": args.get("insurance_type") or "TERM_LIFE",
        "coverage_amount": coverage,
        "term_years": int(args.get("term_years") or 10),
    })
    res.raise_for_status()
    data = res.json()

    route = build_route("admin/leads", customer.get("cnic"))
    return {
        "success": True,
        "policy_id": data.get("id"),
        "message": (
            f"Proposal created for **{_full_name(customer)}** — "
            f"{args.get('product_name') or 'Term Life Plus'}, PKR {coverage:,.0f} over "
            f"{int(args.get('term_years') or 10)} years."
        ),
        "last_action": _action("create_proposal", "customer", customer.get("cnic", ""), route, "Proposal created"),
        "quick_actions": [
            {"label": "Check Documents", "actionType": "submit",
             "payload": f"What documents are needed for CNIC {customer.get('cnic')}?"},
            {"label": "Run Risk Assessment", "actionType": "submit",
             "payload": f"Run risk assessment for CNIC {customer.get('cnic')}"},
            {"label": "View Lead", "actionType": "navigate", "payload": route},
        ],
    }


@handles("run_risk_assessment")
async def _run_risk_assessment(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)

    detail_res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/detail"))
    detail_res.raise_for_status()
    detail = detail_res.json()
    customer, policy = detail.get("customer"), detail.get("policy")
    checklist = detail.get("document_checklist") or {}

    if not customer:
        raise LookupError("That case has no applicant attached.")

    if not policy:
        return {
            "success": False,
            "message": "This case has no proposal yet, so there's nothing to assess.",
            "quick_actions": [{
                "label": "Create Proposal", "actionType": "submit",
                "payload": f"Create a Term Life proposal for CNIC {case.get('customer_cnic') or args.get('cnic')}",
            }],
        }

    missing = checklist.get("missing") or []
    if missing:
        upload_actions = [
            {"label": f"Upload {doc}", "actionType": "upload",
             "payload": json.dumps({"document_type": doc, "cnic": case.get("customer_cnic") or args.get("cnic") or ""})}
            for doc in missing[:3]
        ]
        return {
            "success": False,
            "message": f"Missing {len(missing)} required document(s): {', '.join(missing)}.",
            "quick_actions": upload_actions + [{"label": "Retry Risk Assessment", "actionType": "submit", "payload": f"Run risk assessment for CNIC {case.get('customer_cnic') or args.get('cnic')}"}]
        }

    # Offload the execution to the client so it can stream the live steps to the UI.
    # Return a special marker so graph.py routes to the client_executor node
    # to avoid the LangGraph multiple-interrupt broadcast bug.
    return {
        "__client_execute__": True,
        "kind": "client_execute",
        "tool_call": {
            "name": "run_risk_assessment", 
            "args": {"case_id": case_id, "customer": customer, "policy": policy}
        }
    }


# ═══════════════════════════════════════════════════════════════════════════
# Workflow guidance & demo data
# ═══════════════════════════════════════════════════════════════════════════

_STAGES: list[tuple[tuple[str, ...], str, str, list[dict]]] = [
    (
        ("customer added", "added customer", "new customer", "registered", "customer created"),
        "customer",
        "Customer registered. Next: open an underwriting case so they can be evaluated.",
        [
            {"label": "Create case now", "actionType": "submit", "payload": "Create an underwriting case for the customer"},
            {"label": "Add another customer", "actionType": "submit", "payload": "Add another customer"},
            {"label": "View leads", "actionType": "navigate", "payload": "admin/leads"},
        ],
    ),
    (
        ("case created", "case opened", "have a case", "case ready"),
        "case",
        "Case opened. Next: create the proposal that defines product, coverage and term.",
        [
            {"label": "Create proposal now", "actionType": "submit", "payload": "Create a proposal for the customer"},
            {"label": "Assign underwriter", "actionType": "submit", "payload": "Assign this case to an underwriter"},
            {"label": "View case", "actionType": "navigate", "payload": "cases"},
        ],
    ),
    (
        ("proposal created", "policy created", "proposal ready", "policy ready"),
        "proposal",
        "Proposal in place. Next: confirm the required documents are uploaded, then run the assessment.",
        [
            {"label": "Check documents", "actionType": "submit", "payload": "What documents are needed?"},
            {"label": "Run risk assessment", "actionType": "submit", "payload": "Run risk assessment"},
            {"label": "View proposal", "actionType": "navigate", "payload": "proposal"},
        ],
    ),
    (
        ("documents uploaded", "document uploaded", "docs complete", "documents complete"),
        "documents",
        "Documents are in. Next: run the AI risk assessment.",
        [
            {"label": "Run risk assessment", "actionType": "submit", "payload": "Run risk assessment"},
            {"label": "View artifacts", "actionType": "navigate", "payload": "artifacts"},
        ],
    ),
    (
        ("assessment complete", "assessment done", "scores ready", "evaluation complete", "assessment triggered"),
        "assessment",
        "Assessment finished. Next: review the scores and move the case to Under Review.",
        [
            {"label": "Move to review", "actionType": "submit", "payload": "Update case status to Under Review"},
            {"label": "View results", "actionType": "navigate", "payload": "underwriting"},
        ],
    ),
    (
        ("under review", "ready for review", "reviewing"),
        "review",
        "Ready for a decision. Approve or decline based on the composite score.",
        [
            {"label": "Approve case", "actionType": "submit", "payload": "Approve the case"},
            {"label": "Decline case", "actionType": "submit", "payload": "Decline the case"},
            {"label": "Request documents", "actionType": "submit", "payload": "Request more documents"},
        ],
    ),
    (
        ("approved", "rejected", "declined", "decision made"),
        "close",
        "Decision recorded. Close the case to finish the application.",
        [
            {"label": "Close the case", "actionType": "submit", "payload": "Close the case"},
            {"label": "Add internal note", "actionType": "submit", "payload": "Add a comment to the case"},
            {"label": "Start new application", "actionType": "submit", "payload": "Add a new customer"},
        ],
    ),
]

_DEFAULT_ACTIONS = [
    {"label": "Add new customer", "actionType": "submit", "payload": "Add a new customer"},
    {"label": "Try demo data", "actionType": "submit", "payload": "Run the full workflow with demo data"},
    {"label": "View all cases", "actionType": "navigate", "payload": "underwriting"},
]


@handles("get_workflow_recommendation")
async def _get_workflow_recommendation(args: dict, ctx: Ctx) -> dict:
    context = (args.get("action_context") or "").lower()
    for keywords, stage, recommendation, actions in _STAGES:
        if any(k in context for k in keywords):
            return {
                "success": True,
                "workflow_stage": stage,
                "recommendation": recommendation,
                "message": recommendation,
                "quick_actions": actions,
            }
    return {
        "success": True,
        "workflow_stage": None,
        "recommendation": "Tell me where you are — added a customer, opened a case, ran an assessment — and I'll take the next step.",
        "message": "Tell me where you are in the process and I'll take the next step.",
        "quick_actions": _DEFAULT_ACTIONS,
    }


_FIRST_NAMES = ["Ahmed", "Sara", "Fatima", "Hassan", "Aisha", "Muhammad", "Zainab", "Ali", "Bilal", "Hina"]
_LAST_NAMES = ["Khan", "Ahmed", "Hassan", "Shah", "Malik", "Ali", "Hussain", "Iqbal", "Raza"]
_OCCUPATIONS = ["Software Engineer", "Doctor", "Teacher", "Bank Manager", "Accountant", "Architect", "Consultant"]


def _demo_customer() -> dict:
    year = random.randint(1975, 2003)
    return {
        "first_name": random.choice(_FIRST_NAMES),
        "last_name": random.choice(_LAST_NAMES),
        "cnic": f"{random.randint(10000, 99999)}-{random.randint(1000000, 9999999)}-{random.randint(1, 9)}",
        "date_of_birth": f"{year}-{random.randint(1, 12):02d}-{random.randint(1, 28):02d}",
        "gender": random.choice(["Male", "Female"]),
        "occupation": random.choice(_OCCUPATIONS),
        "declared_income": random.randrange(400_000, 3_000_000, 50_000),
        "is_smoker": random.random() < 0.25,
        "height_cm": random.randint(155, 190),
        "weight_kg": random.randint(55, 95),
        "_birth_year": year,
    }


@handles("quick_start_workflow")
async def _quick_start_workflow(args: dict, ctx: Ctx) -> dict:
    if not ctx.exec_ctx.jwt_token:
        return {
            "success": False,
            "error": "Your session has expired — sign in again and I'll run the demo.",
        }

    demo = _demo_customer()
    if args.get("applicant_name"):
        parts = args["applicant_name"].strip().split(maxsplit=1)
        demo["first_name"] = parts[0]
        demo["last_name"] = parts[1] if len(parts) > 1 else parts[0]
        
    birth_year = demo.pop("_birth_year")

    cust_res = await ctx.client.post(ctx.tsvc("/customers"), json=_customer_payload(demo))
    cust_res.raise_for_status()
    customer = cust_res.json()

    name = f"{demo['first_name']} {demo['last_name']}"
    profile = (
        f"**{name}**\n"
        f"- CNIC: {demo['cnic']}\n"
        f"- Age: {date.today().year - birth_year}\n"
        f"- Occupation: {demo['occupation']}\n"
        f"- Declared income: PKR {demo['declared_income']:,}"
    )

    if not args.get("full_journey"):
        return {
            "success": True,
            "message": f"Demo applicant created.\n\n{profile}\n\nNext: run the autonomous journey, or step through manually.",
            "demo_customer": customer,
            "last_action": _action("quick_start_workflow", "customer", demo["cnic"],
                                   build_route("admin/leads", demo["cnic"]), f"Demo customer {name} created"),
            "quick_actions": [
                {"label": "Run autonomous journey", "actionType": "submit",
                 "payload": f"Start the underwriting journey for CNIC {demo['cnic']}"},
                {"label": "Create case (manual)", "actionType": "submit",
                 "payload": f"Create an underwriting case for CNIC {demo['cnic']}"},
                {"label": "View lead", "actionType": "navigate", "payload": build_route("admin/leads", demo["cnic"])},
            ],
        }

    # full_journey — chain case + proposal so the user lands on something assessable.
    steps = [f"Registered {name}"]

    case_res = await ctx.client.post(ctx.tsvc("/cases"), json={
        "customer_id": customer["id"], "caseType": "Underwriting",
        "priorityLevel": "Normal", "sourceChannel": "Online",
    })
    case_res.raise_for_status()
    case = case_res.json()
    case_id = case.get("caseld") or case.get("id")
    steps.append(f"Opened case {case.get('caseNumber')}")

    coverage = min(demo["declared_income"] * 10, 20_000_000)
    policy_res = await ctx.client.post(ctx.tsvc(f"/customers/{customer['id']}/policies"), json={
        "product_name": "Term Life Plus", "insurance_type": "TERM_LIFE",
        "coverage_amount": coverage, "term_years": 15,
    })
    policy_res.raise_for_status()
    steps.append(f"Created proposal — PKR {coverage:,} over 15 years")

    route = build_route("cases", case_id)
    return {
        "success": True,
        "message": (
            f"Demo journey set up.\n\n{profile}\n\n"
            + "\n".join(f"{i}. {s}" for i, s in enumerate(steps, 1))
            + "\n\nNext: run the risk assessment (documents permitting)."
        ),
        "demo_customer": customer,
        "case_id": case_id,
        "last_action": _action("quick_start_workflow", "case", case_id, route, f"Demo case {case.get('caseNumber')} ready"),
        "quick_actions": [
            {"label": "Run risk assessment", "actionType": "submit",
             "payload": f"Run risk assessment for case {case.get('caseNumber')}"},
            {"label": "Check documents", "actionType": "submit",
             "payload": f"What documents are needed for case {case.get('caseNumber')}?"},
            {"label": "View case", "actionType": "navigate", "payload": route},
        ],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Dispatch
# ═══════════════════════════════════════════════════════════════════════════

async def execute_tool(name: str, args: dict[str, Any], ctx: ExecCtx) -> dict[str, Any]:
    handler = _HANDLERS.get(name)
    if handler is None:
        return {"success": False, "error": f"Unknown function: {name}"}

    # run_risk_assessment fans out to the risk engine's 3-LLM-call pipeline —
    # give it real headroom instead of racing a general-purpose timeout.
    timeout = 180.0 if name == "run_risk_assessment" else 60.0
    # Connection-level retries only (safe for POSTs — nothing has been sent
    # yet when a connect fails); response-level errors still surface normally.
    transport = httpx.AsyncHTTPTransport(retries=2)

    try:
        async with httpx.AsyncClient(timeout=timeout, headers=ctx.headers, transport=transport) as client:
            return await handler(args, Ctx(client=client, tenant_id=ctx.effective_tenant_id, exec_ctx=ctx))
    except LookupError as exc:
        # Expected "couldn't find it" paths — surfaced verbatim so the model can
        # relay a useful sentence instead of an HTTP trace.
        return {"success": False, "error": str(exc)}
    except GraphInterrupt:
        # Allow LangGraph interrupts to bubble up and pause execution
        raise
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in (401, 403):
            return {
                "success": False,
                "error": "Your session has expired — sign in again and I'll pick up right where we left off.",
                "quick_actions": [{"label": "Sign in again", "actionType": "navigate", "payload": "login"}],
            }
        detail = None
        try:
            detail = exc.response.json().get("detail")
        except Exception:
            pass
        return {"success": False, "error": _readable_detail(detail) or str(exc)}
    except httpx.RequestError:
        return {"success": False, "error": "The platform service is unreachable right now."}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def _readable_detail(detail) -> Optional[str]:
    """Flatten FastAPI/Pydantic error details into a plain sentence. Their raw
    422 body is a list of {type, loc, msg, ...} dicts — dumping that straight
    into the chat is exactly the noise we want to avoid."""
    if detail is None:
        return None
    if isinstance(detail, str):
        return detail
    if isinstance(detail, list):
        msgs = []
        for d in detail:
            if isinstance(d, dict):
                msg = (d.get("msg") or "").replace("Value error, ", "").strip()
                msgs.append(msg or str(d))
            else:
                msgs.append(str(d))
        return "; ".join(m for m in msgs if m)
    return str(detail)
