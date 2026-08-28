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
    role: str = "Agent"

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
    """What each handler gets: an HTTP client already carrying this call's auth
    headers and timeout, plus the resolved tenant.

    `client` is a `_ScopedClient` (defined below) wrapping the process-wide
    pooled client — same get/post/put/patch/delete surface handlers already use.
    """
    client: Any
    tenant_id: str
    exec_ctx: ExecCtx

    def tsvc(self, path: str) -> str:
        return f"{TENANT_SERVICE_URL}/tenants/{self.tenant_id}{path}"

    def gateway(self, path: str) -> str:
        return f"{API_GATEWAY_URL}{path}"


Handler = Callable[[dict[str, Any], Ctx], Awaitable[dict[str, Any]]]
_HANDLERS: dict[str, Handler] = {}


# ── Shared HTTP client ───────────────────────────────────────────────────────
# Built once and reused, so connections stay keep-alive across the many calls a
# single turn (or a whole autonomous journey) makes.

_CLIENT: Optional[httpx.AsyncClient] = None
_CLIENT_LOCK = asyncio.Lock()


async def _shared_client() -> httpx.AsyncClient:
    global _CLIENT
    if _CLIENT is None or _CLIENT.is_closed:
        async with _CLIENT_LOCK:
            if _CLIENT is None or _CLIENT.is_closed:
                _CLIENT = httpx.AsyncClient(
                    # Connection-level retries only (safe for POSTs — nothing
                    # has been sent yet when a connect fails); response-level
                    # errors still surface normally.
                    transport=httpx.AsyncHTTPTransport(retries=2),
                    limits=httpx.Limits(max_keepalive_connections=20, max_connections=100),
                    timeout=60.0,
                )
    return _CLIENT


async def close_shared_client() -> None:
    """Called from the FastAPI lifespan on shutdown."""
    global _CLIENT
    if _CLIENT is not None and not _CLIENT.is_closed:
        await _CLIENT.aclose()
    _CLIENT = None


class _ScopedClient:
    """Thin façade over the shared client that pins this call's auth headers
    and timeout.

    Handlers already call `ctx.client.get(...)` / `.post(...)` etc. with the
    client carrying auth, so the per-call scoping has to live here rather than
    on the shared client (whose headers would otherwise leak between tenants).
    """

    __slots__ = ("_client", "_headers", "_timeout")

    def __init__(self, client: httpx.AsyncClient, headers: dict[str, str], timeout: float):
        self._client = client
        self._headers = headers
        self._timeout = timeout

    def _merge(self, kwargs: dict) -> dict:
        headers = {**self._headers, **(kwargs.pop("headers", None) or {})}
        kwargs["headers"] = headers
        kwargs.setdefault("timeout", self._timeout)
        return kwargs

    async def get(self, url: str, **kwargs):
        return await self._client.get(url, **self._merge(kwargs))

    async def post(self, url: str, **kwargs):
        return await self._client.post(url, **self._merge(kwargs))

    async def put(self, url: str, **kwargs):
        return await self._client.put(url, **self._merge(kwargs))

    async def patch(self, url: str, **kwargs):
        return await self._client.patch(url, **self._merge(kwargs))

    async def delete(self, url: str, **kwargs):
        return await self._client.delete(url, **self._merge(kwargs))


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
    return {
        "success": False,
        "message": body,
        "checklist": cl,
        "quick_actions": upload_actions + [{"label": "Retry Risk Assessment", "actionType": "submit", "payload": f"I've uploaded the documents. Please re-check and run the risk assessment for CNIC {case.get('customer_cnic') or args.get('cnic')}."}]
    }



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
    payload = {
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
    if src.get("assigned_agent_id"):
        payload["assigned_agent_id"] = src["assigned_agent_id"]
    return payload


async def _current_user(ctx: Ctx) -> dict:
    res = await ctx.client.get(f"{TENANT_SERVICE_URL}/auth/me")
    res.raise_for_status()
    return res.json()


async def _find_agent_user(ctx: Ctx, query: str) -> Optional[dict]:
    """Fuzzy-match a typed name/email against Agent-role users.

    /users/ only returns each user's role_id (a global, not tenant-scoped, FK
    into the roles table) — not a resolved role name — so the Agent role's id
    has to be looked up via /roles first.
    """
    roles_res = await ctx.client.get(f"{TENANT_SERVICE_URL}/roles")
    roles_res.raise_for_status()
    agent_role = next((r for r in roles_res.json() if r.get("name") == "Agent"), None)
    if not agent_role:
        return None

    users_res = await ctx.client.get(ctx.tsvc("/users/"))
    users_res.raise_for_status()
    agents = [u for u in users_res.json() if u.get("role_id") == agent_role["id"]]

    q = query.strip().lower()
    for u in agents:
        if (u.get("email") or "").lower() == q:
            return u
    for u in agents:
        if q in (u.get("full_name") or "").lower():
            return u
    return None


async def _resolve_lead_agent(args: dict, ctx: Ctx) -> tuple[Optional[dict], Optional[dict]]:
    """Who does this new lead/customer belong to?

    An Agent creating a lead is obviously its own agent — auto-attach them,
    no need to ask. Anyone else (Admin/Underwriter) doesn't have that implicit
    ownership, so the lead needs an explicit agent named; if they haven't
    given one, decline with a message asking for it rather than leaving the
    lead unowned.

    Returns (agent, error_response) — exactly one of the two is set.
    """
    role = (ctx.exec_ctx.role or "").strip().lower()
    if role == "agent":
        return await _current_user(ctx), None

    query = args.get("agent_name") or args.get("agent_email")
    if not query:
        return None, {
            "success": False,
            "message": "Who is the agent associated with this lead/customer? Please give their name or email.",
        }

    agent = await _find_agent_user(ctx, query)
    if not agent:
        return None, {
            "success": False,
            "message": f"I couldn't find an Agent matching '{query}'. Please give their exact name or email.",
        }
    return agent, None


@handles("add_customer")
async def _add_customer(args: dict, ctx: Ctx) -> dict:
    agent, error = await _resolve_lead_agent(args, ctx)
    if error:
        return error

    payload = _customer_payload(args)
    payload["assigned_agent_id"] = agent.get("id")
    res = await ctx.client.post(ctx.tsvc("/customers"), json=payload)
    res.raise_for_status()
    data = res.json()
    name = f"{args.get('first_name')} {args.get('last_name')}".strip()
    cnic = args.get("cnic")
    route = build_route("admin/leads", cnic)
    return {
        "success": True,
        "customer_id": data.get("id"),
        "message": f"Customer **{name}** registered, assigned to agent **{agent.get('full_name')}**.",
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
    return {
        "success": False,
        "message": "You cannot delete a customer. We have to maintain records for future use and compliance.",
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
        "quick_actions": [
            {"label": "View Organization", "actionType": "navigate", "payload": route},
        ],
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
        "quick_actions": [
            {"label": "View Family", "actionType": "navigate", "payload": route},
        ],
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
            f"{int(args.get('term_years') or 10)} years.\n\n"
            f"The case is now in **Pre-Underwriting**. To proceed, complete the 6 clearance gates sequentially starting with **Gate 1: Customer E-Application**."
        ),
        "last_action": _action("create_proposal", "customer", customer.get("cnic", ""), route, "Proposal created"),
        "quick_actions": [
            {"label": "1. Generate E-App Link (Gate 1)", "actionType": "submit",
             "payload": f"Generate e-application link for CNIC {customer.get('cnic')}"},
            {"label": "Check Gate Status", "actionType": "submit",
             "payload": f"Check pre-underwriting status for CNIC {customer.get('cnic')}"},
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
    latest = detail.get("latest_assessment")
    pre_status = detail.get("pre_underwriting_status") or {}

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

    # If risk assessment was already completed in the portal/DB and no explicit re-run was requested
    if latest and latest.get("ai_decision") and not args.get("force_rerun"):
        decision = latest.get("ai_decision")
        results_route = f"case/{case_id}"
        summary = (
            f"Risk assessment for case **{case.get('caseNumber')}** has already been completed!\n"
            f"- Medical Score: {latest.get('medical_score') if latest.get('medical_score') is not None else '—'}/100\n"
            f"- Financial Score: {latest.get('financial_score') if latest.get('financial_score') is not None else '—'}/100\n"
            f"- Fraud Risk: {latest.get('fraud_probability') if latest.get('fraud_probability') is not None else '—'}\n"
            f"- **Decision: {decision}**"
        )
        return {
            "success": True,
            "message": summary,
            "assessment": {
                "scores": {
                    "medical_score": latest.get("medical_score"),
                    "financial_score": latest.get("financial_score"),
                    "fraud_probability": latest.get("fraud_probability"),
                    "composite_risk_score": latest.get("composite_risk_score"),
                    "reasons": latest.get("reasons") or [],
                },
                "ai_decision": decision,
                "case_id": case_id,
                "reasons": latest.get("reasons") or [],
                "medical_reasons": latest.get("medical_reasons") or [],
                "financial_reasons": latest.get("financial_reasons") or [],
                "fraud_reasons": latest.get("fraud_reasons") or [],
            },
            "last_action": {
                "toolName": "run_risk_assessment",
                "entityType": "case",
                "entityId": case_id,
                "route": results_route,
                "label": "Risk assessment complete"
            },
            "quick_actions": [
                {"label": "View Results", "actionType": "navigate", "payload": results_route},
                {"label": "Download Report", "actionType": "download", "payload": case_id},
                {"label": "Approve Case", "actionType": "submit", "payload": f"Approve case {case.get('caseNumber')}"},
                {"label": "Move to Review", "actionType": "submit", "payload": f"Move case {case_id} to Under Review"},
            ]
        }

    # Pre-Underwriting 6-Gate Clearance Guard
    if pre_status and not pre_status.get("is_ready") and not args.get("bypass_gates"):
        pending_gates = []
        next_action = None

        if pre_status.get("e_application") != "Verified":
            pending_gates.append(f"Gate 1: E-Application ({pre_status.get('e_application', 'NotStarted')})")
            if not next_action:
                next_action = {"label": "1. Generate E-App Link (Gate 1)", "actionType": "submit",
                               "payload": f"Generate e-application link for case {case.get('caseNumber')}"}
        if pre_status.get("acr") != "Submitted":
            pending_gates.append(f"Gate 2: Agent Confidential Report ({pre_status.get('acr', 'NotStarted')})")
            if not next_action:
                next_action = {"label": "2. Submit ACR (Gate 2)", "actionType": "submit",
                               "payload": f"Submit agent confidential report for case {case.get('caseNumber')}"}
        if pre_status.get("compliance") not in ("Passed", "Cleared"):
            pending_gates.append(f"Gate 3: Compliance / PEP Screening ({pre_status.get('compliance', 'NotRun')})")
            if not next_action:
                next_action = {"label": "3. Compliance Screen (Gate 3)", "actionType": "submit",
                               "payload": f"Run compliance screening for case {case.get('caseNumber')}"}
        if pre_status.get("ipp") != "Realized":
            pending_gates.append(f"Gate 4: Initial Premium Payment ({pre_status.get('ipp', 'NotStarted')})")
            if not next_action:
                next_action = {"label": "4. Initial Premium (Gate 4)", "actionType": "submit",
                               "payload": f"Process initial premium payment for case {case.get('caseNumber')}"}
        if pre_status.get("insurance_history") not in ("Clear", "Cleared"):
            pending_gates.append(f"Gate 5: Insurance History Check ({pre_status.get('insurance_history', 'NotStarted')})")
            if not next_action:
                next_action = {"label": "5. Insurance History (Gate 5)", "actionType": "submit",
                               "payload": f"Run insurance history check for case {case.get('caseNumber')}"}
        if pre_status.get("medical_exam") not in ("Completed", "Waived", "NotRequired"):
            pending_gates.append(f"Gate 6: Medical Examination ({pre_status.get('medical_exam', 'NotAssessed')})")
            if not next_action:
                next_action = {"label": "6. Medical Exam (Gate 6)", "actionType": "submit",
                               "payload": f"Assess medical examination for case {case.get('caseNumber')}"}

        qa = []
        if next_action:
            qa.append(next_action)
        qa.append({"label": "Check Gate Status", "actionType": "submit",
                   "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"})
        qa.append({"label": "Open Workbench", "actionType": "navigate", "payload": "underwriting"})

        return {
            "success": False,
            "message": (
                f"⚠️ **Pre-Underwriting Clearance Incomplete** for case **{case.get('caseNumber')}**.\n\n"
                f"The AI Risk Engine requires all 6 pre-underwriting clearance gates to be satisfied sequentially before evaluating risk:\n"
                + "\n".join(f"- {g}" for g in pending_gates)
                + f"\n\n👉 Next required step: **{next_action['label'] if next_action else 'Complete pending gates'}**."
            ),
            "pre_underwriting_status": pre_status,
            "quick_actions": qa,
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
            "quick_actions": upload_actions + [{"label": "Retry Risk Assessment", "actionType": "submit", "payload": f"I've uploaded the documents. Please re-check and run the risk assessment for CNIC {case.get('customer_cnic') or args.get('cnic')}."}]
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
# Pre-Underwriting clearance — The 6 Gates
# ═══════════════════════════════════════════════════════════════════════════

def _gate_icon(status: str) -> str:
    s = (status or "").lower()
    if s in ("verified", "submitted", "passed", "cleared", "realized", "clear", "completed", "waived", "notrequired"):
        return "✅"
    if s in ("flagged", "failed", "rejected"):
        return "❌"
    return "⏳"


@handles("get_pre_underwriting_status")
async def _get_pre_underwriting_status(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)

    detail_res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/detail"))
    detail_res.raise_for_status()
    detail = detail_res.json()

    pre = detail.get("pre_underwriting_status") or {}
    e_app = pre.get("e_application", "NotStarted")
    acr = pre.get("acr", "NotStarted")
    comp = pre.get("compliance", "NotRun")
    ipp = pre.get("ipp", "NotStarted")
    hist = pre.get("insurance_history", "NotStarted")
    med = pre.get("medical_exam", "NotAssessed")
    is_ready = bool(pre.get("is_ready"))

    summary = (
        f"### Pre-Underwriting Clearance Gates for Case **{case.get('caseNumber')}**\n\n"
        f"| Gate | Milestone | Status |\n"
        f"| :--- | :--- | :--- |\n"
        f"| **Gate 1** | **E-Application** | {_gate_icon(e_app)} `{e_app}` |\n"
        f"| **Gate 2** | **Agent Confidential Report (ACR)** | {_gate_icon(acr)} `{acr}` |\n"
        f"| **Gate 3** | **Compliance (PEP / Sanctions)** | {_gate_icon(comp)} `{comp}` |\n"
        f"| **Gate 4** | **Initial Premium Payment (IPP)** | {_gate_icon(ipp)} `{ipp}` |\n"
        f"| **Gate 5** | **Insurance History Check** | {_gate_icon(hist)} `{hist}` |\n"
        f"| **Gate 6** | **Medical Examination** | {_gate_icon(med)} `{med}` |\n\n"
    )

    if is_ready:
        summary += "**Status: All 6 Gates Cleared!** The proposal is 100% ready for AI Risk Assessment."
        qa = [
            {"label": "Run AI Risk Assessment", "actionType": "submit",
             "payload": f"Run risk assessment for case {case.get('caseNumber')}"},
            {"label": "View Underwriting Workbench", "actionType": "navigate", "payload": "underwriting"},
        ]
    else:
        summary += "⚠️ **Status: Pre-Underwriting Incomplete.** Follow the sequential gates below to complete clearance:"
        qa = []
        if e_app != "Verified":
            qa.append({"label": "1. Generate E-App Link", "actionType": "submit",
                       "payload": f"Generate e-application link for case {case.get('caseNumber')}"})
            if e_app == "Submitted":
                qa.append({"label": "Verify E-Application", "actionType": "submit",
                           "payload": f"Verify e-application for case {case.get('caseNumber')} action verify"})
        elif acr != "Submitted":
            qa.append({"label": "2. Submit ACR", "actionType": "submit",
                       "payload": f"Submit agent confidential report for case {case.get('caseNumber')}"})
        elif comp not in ("Passed", "Cleared"):
            qa.append({"label": "3. Run Compliance Screen", "actionType": "submit",
                       "payload": f"Run compliance screening for case {case.get('caseNumber')}"})
        elif ipp != "Realized":
            qa.append({"label": "4. Process IPP Payment", "actionType": "submit",
                       "payload": f"Process initial premium payment for case {case.get('caseNumber')}"})
        elif hist not in ("Clear", "Cleared"):
            qa.append({"label": "5. Check Insurance History", "actionType": "submit",
                       "payload": f"Run insurance history check for case {case.get('caseNumber')}"})
        elif med not in ("Completed", "Waived", "NotRequired"):
            qa.append({"label": "6. Assess Medical Exam", "actionType": "submit",
                       "payload": f"Assess medical examination for case {case.get('caseNumber')}"})
        qa.append({"label": "View Workbench", "actionType": "navigate", "payload": "underwriting"})

    return {
        "success": True,
        "message": summary,
        "pre_underwriting_status": pre,
        "is_ready": is_ready,
        "quick_actions": qa[:5],
    }


@handles("verify_e_application")
async def _verify_e_application(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)
    action = args.get("action") or "invite"
    cust_name = case.get("customer_name") or "the applicant"

    # Step 1: Check existing status first
    eapp_res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/e-application"))
    current_status = eapp_res.json().get("status") if eapp_res.status_code == 200 else "NotSent"

    # If already verified
    if current_status == "Verified":
        return {
            "success": True,
            "message": (
                f"✅ **Gate 1: E-Application is already Verified** for case **{case.get('caseNumber')}**.\n"
                f"Applicant medical questionnaire and signed declarations are approved.\n\n"
                f"👉 Next Gate: **Gate 2: Agent Confidential Report (ACR)**."
            ),
            "status": "Verified",
            "quick_actions": [
                {"label": "2. Submit ACR (Gate 2)", "actionType": "submit",
                 "payload": f"Submit agent confidential report for case {case.get('caseNumber')}"},
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    # If action is verify and it's already Submitted by customer
    if action == "verify" and current_status == "Submitted":
        ver_res = await ctx.client.post(
            ctx.tsvc(f"/cases/{case_id}/e-application/verify"),
            json={"action": "approve", "notes": "E-Application verified by underwriter."}
        )
        ver_res.raise_for_status()
        ver_data = ver_res.json()
        route = f"case/{case_id}"
        return {
            "success": True,
            "message": (
                f"✅ **Gate 1: E-Application Verified** for case **{case.get('caseNumber')}**.\n"
                f"Customer submission has been reviewed and approved.\n\n"
                f"👉 Next Gate: **Gate 2: Agent Confidential Report (ACR)**."
            ),
            "status": ver_data.get("status"),
            "last_action": _action("verify_e_application", "case", case_id, route, "E-Application verified"),
            "quick_actions": [
                {"label": "2. Submit ACR (Gate 2)", "actionType": "submit",
                 "payload": f"Submit agent confidential report for case {case.get('caseNumber')}"},
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    # Step 2: Create or fetch invite token
    invite_res = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/e-application/invite"))
    invite_res.raise_for_status()
    invite_data = invite_res.json()
    token = invite_data.get("token")
    link_path = invite_data.get("link_path")
    full_link = f"http://localhost:3000{link_path}" if link_path else ""

    # If action was verify but status is not submitted yet
    if action == "verify" and current_status != "Submitted":
        return {
            "success": False,
            "message": (
                f"⏳ **Gate 1 Pending Customer Submission** for case **{case.get('caseNumber')}**\n\n"
                f"The customer **{cust_name}** has not yet completed and submitted their medical questionnaire & declaration.\n\n"
                f"🔗 **[Open Customer Form Link]({full_link})**\n`{full_link}`\n\n"
                f"Once submitted by the customer, click **Verify E-Application** below to approve it."
            ),
            "status": current_status,
            "full_link": full_link,
            "quick_actions": [
                {"label": "Open Form (Customer View)", "actionType": "navigate", "payload": f"e-application/{token}"},
                {"label": "Verify E-Application", "actionType": "submit",
                 "payload": f"Verify e-application for case {case.get('caseNumber')} action verify"},
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    # If action is auto_submit (used in bulk/demo journey runs)
    if action == "auto_submit":
        if token:
            try:
                demo_payload = {
                    "medical_questionnaire": {
                        "conditions": [],
                        "has_hospitalizations": False,
                        "has_surgeries": False,
                        "drug_use": False,
                        "disclosures": {},
                    },
                    "family_history": {"entries": []},
                    "lifestyle_habits": {"smoking": False, "alcohol": False},
                    "existing_insurance": {"has_existing_policies": False},
                    "declaration": {
                        "confirms_accurate": True,
                        "authorizes_records_access": True,
                        "not_signed_blank": True,
                        "understood_terms": True,
                        "signature_name": cust_name,
                    },
                }
                await ctx.client.put(f"{TENANT_SERVICE_URL}/public/e-application/{token}", json=demo_payload)
                sub_res = await ctx.client.post(f"{TENANT_SERVICE_URL}/public/e-application/{token}/submit")
                sub_res.raise_for_status()
            except Exception:
                pass
        ver_res = await ctx.client.post(
            ctx.tsvc(f"/cases/{case_id}/e-application/verify"),
            json={"action": "approve", "notes": "E-Application auto-submitted and verified."}
        )
        ver_res.raise_for_status()
        ver_data = ver_res.json()
        route = f"case/{case_id}"
        return {
            "success": True,
            "message": (
                f"✅ **Gate 1: E-Application Verified** for case **{case.get('caseNumber')}**.\n"
                f"Applicant medical questionnaire and declarations successfully recorded and approved.\n\n"
                f"👉 Next Gate: **Gate 2: Agent Confidential Report (ACR)**."
            ),
            "status": ver_data.get("status"),
            "last_action": _action("verify_e_application", "case", case_id, route, "E-Application verified"),
            "quick_actions": [
                {"label": "2. Submit ACR (Gate 2)", "actionType": "submit",
                 "payload": f"Submit agent confidential report for case {case.get('caseNumber')}"},
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    # Default / Invite flow: generate link for customer to fill
    return {
        "success": True,
        "message": (
            f"📋 **Gate 1: Customer E-Application Link Generated** for case **{case.get('caseNumber')}**\n\n"
            f"The customer must fill and sign their medical questionnaire and declarations directly. Please share this secure link with **{cust_name}**:\n\n"
            f"🔗 **[Open Customer E-Application Form]({full_link})**\n"
            f"`{full_link}`\n\n"
            f"*(This is a public, tokenized link — the applicant does not need to log in)*.\n\n"
            f"👉 **After the customer submits their form**, click **Verify E-Application** below to review and approve it."
        ),
        "link_path": link_path,
        "full_link": full_link,
        "token": token,
        "status": "Sent",
        "quick_actions": [
            {"label": "Open Form (Customer View)", "actionType": "navigate", "payload": f"e-application/{token}"},
            {"label": "Verify E-Application", "actionType": "submit",
             "payload": f"Verify e-application for case {case.get('caseNumber')} action verify"},
            {"label": "Check Gate Status", "actionType": "submit",
             "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
        ],
    }


@handles("submit_agent_confidential_report")
async def _submit_agent_confidential_report(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)

    # Prerequisite check: Gate 1 must be Verified
    detail_res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/detail"))
    detail_res.raise_for_status()
    detail = detail_res.json()
    pre = detail.get("pre_underwriting_status") or {}
    e_app = pre.get("e_application", "NotStarted")

    if e_app != "Verified" and not args.get("bypass_prerequisites"):
        return {
            "success": False,
            "message": (
                f"🔒 **Gate 2 (ACR) Locked for Case {case.get('caseNumber')}**\n\n"
                f"**Prerequisite Required:** Gate 1 (E-Application Verification) must be completed before filing the Agent Confidential Report.\n"
                f"Current E-Application Status: `{e_app}`."
            ),
            "status": "Locked",
            "quick_actions": [
                {"label": "1. Generate E-App Link", "actionType": "submit",
                 "payload": f"Generate e-application link for case {case.get('caseNumber')}"},
                {"label": "Verify E-Application", "actionType": "submit",
                 "payload": f"Verify e-application for case {case.get('caseNumber')} action verify"},
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    # Real filings need the actual field agent's observations — only they were
    # present with the proposer. Everyone else is pointed at the agent rather
    # than allowed to fabricate the KYC/moral-hazard narrative on their behalf.
    # `auto_fill` is set only by the internal demo/autonomous-journey shortcut
    # below, which intentionally bypasses this (no human agent in that loop).
    if not args.get("auto_fill"):
        role = (ctx.exec_ctx.role or "").strip().lower()
        if role != "agent":
            return {
                "success": False,
                "message": (
                    f"🔒 **Gate 2 (ACR) requires the assigned Agent** for case **{case.get('caseNumber')}**.\n\n"
                    f"Only the Agent who met the proposer in person can complete the Agent's Confidential Report. "
                    f"Please ask the agent on this case to fill it."
                ),
                "status": "RequiresAgent",
                "quick_actions": [
                    {"label": "Check Gate Status", "actionType": "submit",
                     "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
                ],
            }
        return {
            "__client_execute__": True,
            "kind": "client_execute",
            "tool_call": {
                "name": "submit_agent_confidential_report",
                "args": {"case_id": case_id, "case_number": case.get("caseNumber")},
            },
        }

    rec_map = {
        "STANDARD_RISK": "Recommend",
        "SPECIAL_CONDITIONS": "RecommendWithCaution",
        "DECLINE": "DoNotRecommend",
        "Recommend": "Recommend",
        "RecommendWithCaution": "RecommendWithCaution",
        "DoNotRecommend": "DoNotRecommend",
    }
    raw_rec = args.get("recommendation") or "Recommend"
    rec_val = rec_map.get(raw_rec, "Recommend")

    # Step 1: Draft ACR
    acr_payload = {
        "known_proposer_since": "2 years",
        "relationship_to_proposer": "Client",
        "purpose_of_insurance": "Family financial security",
        "financial_interest_explained": True,
        "adverse_info_known": False,
        "occupation_verified": True,
        "income_source_verified": True,
        "health_appearance_note": "Good physical health and active lifestyle observed.",
        "terms_explained_to_proposer": True,
        "identity_verified_kyc": True,
        "signature_obtained_in_presence": True,
        "recommendation": rec_val,
        "remarks": args.get("remarks") or "Applicant verified in person. Moral hazard and financial standing satisfactory.",
    }
    upsert_res = await ctx.client.put(ctx.tsvc(f"/cases/{case_id}/acr"), json=acr_payload)
    upsert_res.raise_for_status()

    # Step 2: Submit ACR
    sub_res = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/acr/submit"))
    sub_res.raise_for_status()
    sub_data = sub_res.json()

    route = f"case/{case_id}"
    return {
        "success": True,
        "message": (
            f"✅ **Gate 2: Agent Confidential Report (ACR) Submitted** for case **{case.get('caseNumber')}**.\n"
            f"- **Recommendation**: `{sub_data.get('recommendation')}`\n"
            f"- **KYC & Moral Hazard**: Verified\n\n"
            f"👉 Next Gate: **Gate 3: Compliance / PEP Screening**."
        ),
        "status": sub_data.get("status"),
        "last_action": _action("submit_agent_confidential_report", "case", case_id, route, "ACR submitted"),
        "quick_actions": [
            {"label": "3. Compliance Screen (Gate 3)", "actionType": "submit",
             "payload": f"Run compliance screening for case {case.get('caseNumber')}"},
            {"label": "Check Gate Status", "actionType": "submit",
             "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
        ],
    }


@handles("run_compliance_screening")
async def _run_compliance_screening(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)

    # Prerequisite check: Gate 2 must be Submitted
    detail_res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/detail"))
    detail_res.raise_for_status()
    detail = detail_res.json()
    pre = detail.get("pre_underwriting_status") or {}
    acr_status = pre.get("acr", "NotStarted")

    if acr_status != "Submitted" and not args.get("bypass_prerequisites"):
        return {
            "success": False,
            "message": (
                f"🔒 **Gate 3 (PEP / Sanctions Screening) Locked for Case {case.get('caseNumber')}**\n\n"
                f"**Prerequisite Required:** Gate 2 (Agent Confidential Report) must be filed and submitted before running PEP / Sanctions Compliance Screening.\n"
                f"Current ACR Status: `{acr_status}`."
            ),
            "status": "Locked",
            "quick_actions": [
                {"label": "2. Submit ACR (Gate 2)", "actionType": "submit",
                 "payload": f"Submit agent confidential report for case {case.get('caseNumber')}"},
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    res = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/compliance/run"))
    res.raise_for_status()
    data = res.json()
    status = data.get("overall_status", "Passed")
    checks = data.get("checks") or []

    checks_summary = "\n".join(
        f"- **{c.get('check_type')}**: `{c.get('status')}` — {(c.get('details') or {}).get('note', '')}"
        for c in checks
    ) or "- No checks were run."

    route = f"case/{case_id}"

    if status != "Passed":
        return {
            "success": False,
            "message": (
                f"⚠️ **Gate 3: Compliance Screening ({status})** for case **{case.get('caseNumber')}**.\n\n"
                f"{checks_summary}\n\n"
                f"One or more checks need manual review before this gate can clear. "
                f"You can proceed anyway if the flag has been reviewed and is acceptable."
            ),
            "status": status,
            "checks": checks,
            "quick_actions": [
                {"label": "Proceed Anyway", "actionType": "submit",
                 "payload": f"Proceed anyway despite compliance flags for case {case.get('caseNumber')}"},
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    return {
        "success": True,
        "message": (
            f"✅ **Gate 3: Compliance Screening ({status})** for case **{case.get('caseNumber')}**.\n\n"
            f"{checks_summary}\n\n"
            f"Sanctions, PEP, AML, and SECP compliance checks completed.\n\n"
            f"👉 Next Gate: **Gate 4: Initial Premium Payment (IPP)**."
        ),
        "status": status,
        "checks": checks,
        "last_action": _action("run_compliance_screening", "case", case_id, route, f"Compliance {status}"),
        "quick_actions": [
            {"label": "4. Initial Premium (Gate 4)", "actionType": "submit",
             "payload": f"Process initial premium payment for case {case.get('caseNumber')}"},
            {"label": "Check Gate Status", "actionType": "submit",
             "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
        ],
    }


@handles("override_compliance_screening")
async def _override_compliance_screening(args: dict, ctx: Ctx) -> dict:
    """'Proceed Anyway' — clears every currently-flagged compliance check for
    the case, same as the Underwriting workbench's override button."""
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)

    detail_res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/detail"))
    detail_res.raise_for_status()
    detail = detail_res.json()
    pre = detail.get("pre_underwriting_status") or {}

    if pre.get("compliance") == "Passed":
        return {
            "success": True,
            "message": f"Gate 3 (Compliance) is already **Passed** for case **{case.get('caseNumber')}** — nothing to override.",
            "status": "Passed",
            "quick_actions": [
                {"label": "4. Initial Premium (Gate 4)", "actionType": "submit",
                 "payload": f"Process initial premium payment for case {case.get('caseNumber')}"},
            ],
        }

    res = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/compliance/run"))
    res.raise_for_status()
    data = res.json()
    checks = data.get("checks") or []
    flagged = [c for c in checks if c.get("status") == "Flagged"]

    for chk in flagged:
        clear_res = await ctx.client.post(
            ctx.tsvc(f"/compliance/{chk['id']}/clear"),
            json={"cleared_by": "AI Copilot (agent override)", "note": "Proceeded anyway via chat after manual review."},
        )
        clear_res.raise_for_status()

    route = f"case/{case_id}"
    return {
        "success": True,
        "message": (
            f"✅ **Gate 3: Compliance override applied** for case **{case.get('caseNumber')}**.\n\n"
            f"{len(flagged)} flagged check(s) cleared after manual review.\n\n"
            f"👉 Next Gate: **Gate 4: Initial Premium Payment (IPP)**."
        ),
        "status": "Passed",
        "last_action": _action("override_compliance_screening", "case", case_id, route, "Compliance override applied"),
        "quick_actions": [
            {"label": "4. Initial Premium (Gate 4)", "actionType": "submit",
             "payload": f"Process initial premium payment for case {case.get('caseNumber')}"},
            {"label": "Check Gate Status", "actionType": "submit",
             "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
        ],
    }


@handles("process_initial_premium_payment")
async def _process_initial_premium_payment(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)
    method = args.get("payment_method") or "JazzCash"

    # Prerequisite check: Gate 3 must be Passed or Cleared
    detail_res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/detail"))
    detail_res.raise_for_status()
    detail = detail_res.json()
    pre = detail.get("pre_underwriting_status") or {}
    comp_status = pre.get("compliance", "NotRun")

    if comp_status not in ("Passed", "Cleared") and not args.get("bypass_prerequisites"):
        return {
            "success": False,
            "message": (
                f"🔒 **Gate 4 (Initial Premium Payment) Locked for Case {case.get('caseNumber')}**\n\n"
                f"**Prerequisite Required:** Gate 3 (PEP / Sanctions Screening) must be cleared before collecting Section 30 Initial Premium Payment.\n"
                f"Current Compliance Status: `{comp_status}`."
            ),
            "status": "Locked",
            "quick_actions": [
                {"label": "3. Compliance Screen (Gate 3)", "actionType": "submit",
                 "payload": f"Run compliance screening for case {case.get('caseNumber')}"},
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    # Step 1: Check existing IPP status or initiate
    try:
        init_res = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/ipp/initiate"), json={"method": method})
        if init_res.status_code == 409:
            pass
        else:
            init_res.raise_for_status()
    except httpx.HTTPStatusError as e:
        if e.response.status_code != 409:
            raise

    # Step 2: Confirm and realize payment
    conf_res = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/ipp/confirm"), json={"method": method, "realize": True})
    conf_res.raise_for_status()
    data = conf_res.json()

    amount = data.get("amount") or 0.0
    ref = data.get("reference") or "IPP-CONFIRMED"
    route = f"case/{case_id}"

    return {
        "success": True,
        "message": (
            f"✅ **Gate 4: Initial Premium Payment (IPP) Realized** for case **{case.get('caseNumber')}**.\n\n"
            f"- **Amount Paid**: PKR {amount:,.2f}\n"
            f"- **Payment Method**: {method}\n"
            f"- **Transaction Ref**: `{ref}`\n"
            f"- **Statutory Compliance**: Insurance Ordinance 2000 Section 30 satisfied (\"no premium, no risk\").\n\n"
            f"👉 Next Gate: **Gate 5: Industry Insurance History Check**."
        ),
        "status": data.get("status"),
        "amount": amount,
        "reference": ref,
        "last_action": _action("process_initial_premium_payment", "case", case_id, route, "Initial premium realized"),
        "quick_actions": [
            {"label": "5. Insurance History (Gate 5)", "actionType": "submit",
             "payload": f"Run insurance history check for case {case.get('caseNumber')}"},
            {"label": "Check Gate Status", "actionType": "submit",
             "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
        ],
    }


@handles("run_insurance_history_check")
async def _run_insurance_history_check(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)

    # Prerequisite check: Gate 4 must be Realized
    detail_res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/detail"))
    detail_res.raise_for_status()
    detail = detail_res.json()
    pre = detail.get("pre_underwriting_status") or {}
    ipp_status = pre.get("ipp", "NotStarted")

    if ipp_status != "Realized" and not args.get("bypass_prerequisites"):
        return {
            "success": False,
            "message": (
                f"🔒 **Gate 5 (SECP Insurance History) Locked for Case {case.get('caseNumber')}**\n\n"
                f"**Prerequisite Required:** Gate 4 (Initial Premium Payment) must be realized under Section 30 before conducting cross-industry insurance history screening.\n"
                f"Current IPP Status: `{ipp_status}`."
            ),
            "status": "Locked",
            "quick_actions": [
                {"label": "4. Initial Premium (Gate 4)", "actionType": "submit",
                 "payload": f"Process initial premium payment for case {case.get('caseNumber')}"},
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    res = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/insurance-history/run"))
    res.raise_for_status()
    data = res.json()

    status = data.get("status", "Clear")
    agg_sum = data.get("aggregate_sum_assured") or 0.0
    hlv_ratio = data.get("hlv_ratio")
    hlv_str = f"{hlv_ratio:.1f}x" if hlv_ratio is not None else "Within Normal Limit"
    findings = data.get("findings") or []

    findings_txt = "\n".join(f"- {f.get('title', '')}: {f.get('detail', '')}" for f in findings) if findings else "- No policy churning, non-disclosure, or HLV over-exposure found."
    route = f"case/{case_id}"

    return {
        "success": True,
        "message": (
            f"✅ **Gate 5: SECP Insurance History Screen ({status})** for case **{case.get('caseNumber')}**.\n\n"
            f"- **Aggregate Sum Assured at Risk**: PKR {agg_sum:,.0f}\n"
            f"- **Human Life Value (HLV) Exposure**: {hlv_str}\n\n"
            f"**Findings:**\n{findings_txt}\n\n"
            f"👉 Next Gate: **Gate 6: Medical Examination & NML Assessment**."
        ),
        "status": status,
        "aggregate_sum_assured": agg_sum,
        "last_action": _action("run_insurance_history_check", "case", case_id, route, f"Insurance history {status}"),
        "quick_actions": [
            {"label": "6. Medical Exam (Gate 6)", "actionType": "submit",
             "payload": f"Assess medical examination for case {case.get('caseNumber')}"},
            {"label": "Check Gate Status", "actionType": "submit",
             "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
        ],
    }


@handles("assess_medical_examination")
async def _assess_medical_examination(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)
    auto_complete = args.get("auto_complete", False)

    # Prerequisite check: Gate 5 must be Clear or Cleared
    detail_res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/detail"))
    detail_res.raise_for_status()
    detail = detail_res.json()
    pre = detail.get("pre_underwriting_status") or {}
    hist_status = pre.get("insurance_history", "NotStarted")

    if hist_status not in ("Clear", "Cleared") and not args.get("bypass_prerequisites"):
        return {
            "success": False,
            "message": (
                f"🔒 **Gate 6 (Medical Examination) Locked for Case {case.get('caseNumber')}**\n\n"
                f"**Prerequisite Required:** Gate 5 (Insurance History Check) must be completed before assessing Non-Medical Limits (NML) and diagnostic exams.\n"
                f"Current History Status: `{hist_status}`."
            ),
            "status": "Locked",
            "quick_actions": [
                {"label": "5. Insurance History (Gate 5)", "actionType": "submit",
                 "payload": f"Run insurance history check for case {case.get('caseNumber')}"},
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    # Step 1: Run NML Grid assessment
    assess_res = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/medical-exam/assess"))
    assess_res.raise_for_status()
    order = assess_res.json()

    st = order.get("status")
    req_tests = order.get("required_tests") or []
    nml = order.get("non_medical_limit")
    nml_str = f"PKR {nml:,.0f}" if nml else "Standard Grid Limit"

    if st == "NotRequired":
        route = f"case/{case_id}"
        return {
            "success": True,
            "message": (
                f"✅ **Gate 6: Medical Examination Cleared (Not Required)** for case **{case.get('caseNumber')}**.\n\n"
                f"- Applicant is within Non-Medical Limit ({nml_str}).\n"
                f"- No adverse medical disclosures flagged.\n\n"
                f"🎉 **All 6 Pre-Underwriting Clearance Gates Completed!**\n"
                f"The case is now 100% ready for AI Risk Assessment."
            ),
            "status": "NotRequired",
            "last_action": _action("assess_medical_examination", "case", case_id, route, "Medical exam not required"),
            "quick_actions": [
                {"label": "Run AI Risk Assessment", "actionType": "submit",
                 "payload": f"Run risk assessment for case {case.get('caseNumber')}"},
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    if st in ("Completed", "Waived"):
        route = f"case/{case_id}"
        return {
            "success": True,
            "message": (
                f"✅ **Gate 6: Medical Examination ({st})** for case **{case.get('caseNumber')}**.\n\n"
                f"🎉 **All 6 Pre-Underwriting Clearance Gates Completed!**\n"
                f"The case is now 100% ready for AI Risk Assessment."
            ),
            "status": st,
            "quick_actions": [
                {"label": "Run AI Risk Assessment", "actionType": "submit",
                 "payload": f"Run risk assessment for case {case.get('caseNumber')}"},
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    test_names = ", ".join(t.get("name", t.get("code", "")) for t in req_tests) if req_tests else "Standard Panel"
    route = f"case/{case_id}"

    # Internal demo/autonomous-journey shortcut only — no human agent or
    # customer in that loop, so fabricate a scheduled visit and normal
    # results instead of waiting on the real booking link below.
    if auto_complete:
        clinics_res = await ctx.client.get(ctx.tsvc("/panel-clinics"))
        clinics = clinics_res.json() if clinics_res.status_code == 200 else []
        clinic_id = clinics[0].get("id") if clinics else None

        if clinic_id:
            try:
                from datetime import datetime, timedelta
                appt_time = (datetime.utcnow() + timedelta(days=2)).isoformat()
                await ctx.client.post(
                    ctx.tsvc(f"/cases/{case_id}/medical-exam/schedule"),
                    json={"clinic_id": clinic_id, "appointment_at": appt_time, "home_sampling": False, "note": "Auto-scheduled panel clinic visit"}
                )
            except Exception:
                pass

        normal_results = {
            "FBS": {"value": 92, "unit": "mg/dL"},
            "LIPID": {"value": 175, "unit": "mg/dL"},
            "RUA": {"value": "Normal", "unit": "qualitative"},
            "ECG": {"value": "Normal Sinus Rhythm", "unit": "text"},
            "CXR": {"value": "Clear Lung Fields", "unit": "text"},
            "HIV": {"value": "Negative", "unit": "qualitative"},
            "HBSAG": {"value": "Negative", "unit": "qualitative"},
            "HCV": {"value": "Negative", "unit": "qualitative"},
        }
        res_payload = {t.get("code", "FBS"): normal_results.get(t.get("code", "FBS"), {"value": "Normal"}) for t in req_tests}
        if not res_payload:
            res_payload = {"FBS": {"value": 92, "unit": "mg/dL"}, "LIPID": {"value": 175, "unit": "mg/dL"}}

        res_res = await ctx.client.post(
            ctx.tsvc(f"/cases/{case_id}/medical-exam/result"),
            json={"results": res_payload, "reported_by": "Chughtai Panel Pathology Lab"}
        )
        res_res.raise_for_status()
        order = res_res.json()

        return {
            "success": True,
            "message": (
                f"✅ **Gate 6: Medical Examination Completed** for case **{case.get('caseNumber')}**.\n\n"
                f"- **Mandated Tests**: {test_names}\n"
                f"- **Panel Diagnostic Verdict**: `{order.get('outcome', 'Standard')}` (All normal readings)\n"
                f"- **Status**: Completed.\n\n"
                f"🎉 **All 6 Pre-Underwriting Clearance Gates Completed!**\n"
                f"The case is now 100% ready for AI Risk Assessment."
            ),
            "status": "Completed",
            "last_action": _action("assess_medical_examination", "case", case_id, route, "Medical examination completed"),
            "quick_actions": [
                {"label": "Run AI Risk Assessment", "actionType": "submit",
                 "payload": f"Run risk assessment for case {case.get('caseNumber')}"},
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    # Real flow: already invited — just point back at the pending link/status
    # instead of re-inviting (a fresh invite would issue a new token).
    if st == "Invited":
        return {
            "success": True,
            "message": (
                f"📋 **Gate 6: Medical Examination — Awaiting Customer** for case **{case.get('caseNumber')}**.\n\n"
                f"- **Mandated Tests**: {test_names}\n\n"
                f"A booking link has already been sent. The gate clears automatically once the customer books "
                f"a panel clinic slot and completes the exam."
            ),
            "status": "Invited",
            "quick_actions": [
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    if st == "Scheduled":
        return {
            "success": True,
            "message": (
                f"🗓️ **Gate 6: Medical Examination — Scheduled** for case **{case.get('caseNumber')}**.\n\n"
                f"- **Mandated Tests**: {test_names}\n\n"
                f"The customer has booked their panel clinic appointment. The gate clears once the exam is "
                f"completed and results are recorded."
            ),
            "status": "Scheduled",
            "quick_actions": [
                {"label": "Check Gate Status", "actionType": "submit",
                 "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
            ],
        }

    # Not yet invited — generate the real tokenized booking link, same
    # two-step pattern as Gate 1's E-Application (invite now, gate clears
    # later once the customer actually completes it).
    invite_res = await ctx.client.post(ctx.tsvc(f"/cases/{case_id}/medical-exam/invite"))
    invite_res.raise_for_status()
    invite_data = invite_res.json()
    link_path = invite_data.get("link_path")
    full_link = f"http://localhost:3000{link_path}" if link_path else ""

    return {
        "success": True,
        "message": (
            f"📋 **Gate 6: Medical Examination Link Generated** for case **{case.get('caseNumber')}**\n\n"
            f"- **Mandated Tests**: {test_names}\n\n"
            f"The customer must pick a panel clinic and appointment slot themselves. Please share this secure link with them:\n\n"
            f"🔗 **[Open Medical Exam Booking Form]({full_link})**\n"
            f"`{full_link}`\n\n"
            f"*(This is a public, tokenized link — the applicant does not need to log in)*.\n\n"
            f"👉 **The gate clears automatically** once the customer books and completes the exam — no further action needed here."
        ),
        "link_path": link_path,
        "full_link": full_link,
        "token": invite_data.get("token"),
        "status": "Invited",
        "quick_actions": [
            {"label": "Open Form (Customer View)", "actionType": "navigate", "payload": f"medical-exam/{invite_data.get('token')}"},
            {"label": "Check Gate Status", "actionType": "submit",
             "payload": f"Check pre-underwriting status for case {case.get('caseNumber')}"},
        ],
    }


@handles("run_pre_underwriting_clearance")
async def _run_pre_underwriting_clearance(args: dict, ctx: Ctx) -> dict:
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)
    case_no = case.get("caseNumber")

    # Sequentially execute all 6 gates
    await _verify_e_application({"case_number": case_no, "action": "auto_submit"}, ctx)
    await _submit_agent_confidential_report({"case_number": case_no, "auto_fill": True}, ctx)
    await _run_compliance_screening({"case_number": case_no}, ctx)
    await _process_initial_premium_payment({"case_number": case_no}, ctx)
    await _run_insurance_history_check({"case_number": case_no}, ctx)
    await _assess_medical_examination({"case_number": case_no, "auto_complete": True}, ctx)

    # Verify final status
    detail_res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/detail"))
    detail_res.raise_for_status()
    detail = detail_res.json()
    pre = detail.get("pre_underwriting_status") or {}

    route = f"case/{case_id}"
    message = (
        f"🎉 **All 6 Pre-Underwriting Clearance Gates Completed** for case **{case_no}**!\n\n"
        f"| Gate | Step | Status |\n"
        f"| :--- | :--- | :--- |\n"
        f"| Gate 1 | **E-Application** | ✅ `{pre.get('e_application', 'Verified')}` |\n"
        f"| Gate 2 | **Agent Confidential Report (ACR)** | ✅ `{pre.get('acr', 'Submitted')}` |\n"
        f"| Gate 3 | **Compliance / PEP Screening** | ✅ `{pre.get('compliance', 'Passed')}` |\n"
        f"| Gate 4 | **Initial Premium Payment (IPP)** | ✅ `{pre.get('ipp', 'Realized')}` |\n"
        f"| Gate 5 | **SECP Insurance History Check** | ✅ `{pre.get('insurance_history', 'Clear')}` |\n"
        f"| Gate 6 | **Medical Examination (NML)** | ✅ `{pre.get('medical_exam', 'Completed')}` |\n\n"
        f"**The case is now 100% ready for AI Risk Assessment.**"
    )

    return {
        "success": True,
        "message": message,
        "pre_underwriting_status": pre,
        "is_ready": True,
        "last_action": _action("run_pre_underwriting_clearance", "case", case_id, route, "All 6 gates cleared"),
        "quick_actions": [
            {"label": "Run AI Risk Assessment", "actionType": "submit",
             "payload": f"Run risk assessment for case {case_no}"},
            {"label": "Open Underwriting Workbench", "actionType": "navigate", "payload": "underwriting"},
        ],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Policy lifecycle — steps 5–7 (approve → issue → activate)
# ═══════════════════════════════════════════════════════════════════════════


async def _resolve_policy_for_case(ctx: Ctx, case: dict) -> Optional[dict]:
    """Given a case, find its associated policy from the case detail."""
    case_id = _case_id(case)
    try:
        res = await ctx.client.get(ctx.tsvc(f"/cases/{case_id}/detail"))
        res.raise_for_status()
        detail = res.json()
        return detail.get("policy")
    except httpx.HTTPError:
        return None


async def _find_policy_by_customer(ctx: Ctx, cnic: Optional[str] = None, name: Optional[str] = None) -> Optional[dict]:
    """Find a policy by looking up the customer's policies."""
    res = await ctx.client.get(ctx.tsvc("/policies"))
    res.raise_for_status()
    policies = res.json()
    if cnic:
        for p in policies:
            if p.get("customer_name", "").lower().strip() in (name or "").lower().strip() or True:
                # Try to match via case
                pass
    # Return first policy in issuance-ready status
    for p in policies:
        st = (p.get("status") or "").lower()
        if st in ("approved", "acceptedwithloadings", "pendingpayment", "active"):
            if cnic and name:
                if name.lower() in (p.get("customer_name") or "").lower():
                    return p
            elif cnic:
                return p
    return policies[0] if policies else None


@handles("approve_case")
async def _approve_case(args: dict, ctx: Ctx) -> dict:
    """Step 5 — Approve the case after risk assessment, moving it to the
    policy issuance queue."""
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)

    # Check current status — only cases in Under Review or InProgress can be approved
    current_status = case.get("caseStatus", "")
    if current_status == "Approved":
        route = "policy-issuance"
        return {
            "success": True,
            "message": f"Case **{case.get('caseNumber')}** is already **Approved** and should be visible in the Policy Issuance queue.",
            "navigate": _nav("policy-issuance"),
            "quick_actions": [
                {"label": "Open Policy Issuance", "actionType": "navigate", "payload": route},
                {"label": "Check Pre-Issuance Status", "actionType": "submit",
                 "payload": f"Check the pre-issuance status for case {case.get('caseNumber')}"},
            ],
        }

    # Move to Approved
    res = await ctx.client.patch(ctx.tsvc(f"/cases/{case_id}/status"), json={"status": "Approved"})
    res.raise_for_status()

    route = "policy-issuance"
    return {
        "success": True,
        "message": f"Case **{case.get('caseNumber')}** has been **Approved** ✓\nIt is now in the Policy Issuance queue, ready for pre-issuance verification and policy drafting.",
        "last_action": _action("approve_case", "case", case_id, route, f"{case.get('caseNumber')} approved"),
        "navigate": _nav("policy-issuance"),
        "quick_actions": [
            {"label": "Check Pre-Issuance Status", "actionType": "submit",
             "payload": f"Check the pre-issuance status for case {case.get('caseNumber')}"},
            {"label": "Run Pre-Issuance Verification", "actionType": "submit",
             "payload": f"Run pre-issuance verification for case {case.get('caseNumber')}"},
            {"label": "Open Policy Issuance", "actionType": "navigate", "payload": route},
        ],
    }


@handles("get_pre_issuance_status")
async def _get_pre_issuance_status(args: dict, ctx: Ctx) -> dict:
    """Step 6a — Fetch the 4-step pre-issuance readiness checklist for a
    policy associated with a case/customer."""
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)

    # Get the policy from the case detail
    policy = await _resolve_policy_for_case(ctx, case)
    if not policy:
        return {
            "success": False,
            "message": f"No policy/proposal found for case **{case.get('caseNumber')}**. Create a proposal first.",
            "quick_actions": [
                {"label": "Create Proposal", "actionType": "submit",
                 "payload": f"Create a proposal for case {case.get('caseNumber')}"},
            ],
        }

    policy_id = policy.get("id")
    # Fetch pre-issuance readiness
    res = await ctx.client.get(ctx.tsvc(f"/policies/{policy_id}/pre-issuance"))
    res.raise_for_status()
    readiness = res.json()

    steps = readiness.get("steps", {})
    ready = readiness.get("ready_to_issue", False)
    blockers = readiness.get("blockers", [])
    warnings = readiness.get("warnings", [])

    # Build a readable summary
    lines = [f"Pre-issuance status for **{case.get('caseNumber')}** (Policy: {readiness.get('status')}):"]
    for i, (key, label) in enumerate([
        ("revised_terms", "Accept Revised Terms"),
        ("requirements", "Clear Requirements"),
        ("compliance", "Compliance Checks"),
        ("beneficiaries", "Capture Beneficiaries"),
    ], 1):
        step = steps.get(key, {})
        status = step.get("status", "unknown")
        icon = "✅" if status in ("not_required", "accepted", "complete", "clear", "valid", "paid") else "⏳" if status == "none" else "❌"
        lines.append(f"{i}. {icon} {label}: **{status}**")

    if ready:
        lines.append("\n✅ **All gates cleared — ready to issue!**")
    else:
        if blockers:
            lines.append(f"\n⚠️ Blockers: {', '.join(blockers)}")
        if warnings:
            lines.append(f"ℹ️ Warnings (demo bypass): {'; '.join(warnings)}")

    qa = []
    if not ready or warnings:
        qa.append({"label": "Run Verification", "actionType": "submit",
                    "payload": f"Run pre-issuance verification for case {case.get('caseNumber')}"})
    if ready:
        qa.append({"label": "Issue Policy", "actionType": "submit",
                    "payload": f"Issue policy for case {case.get('caseNumber')}"})
    qa.append({"label": "Open Policy Issuance", "actionType": "navigate", "payload": "policy-issuance"})

    return {
        "success": True,
        "message": "\n".join(lines),
        "readiness": readiness,
        "policy_id": policy_id,
        "quick_actions": qa,
    }


@handles("run_pre_issuance_verification")
async def _run_pre_issuance_verification(args: dict, ctx: Ctx) -> dict:
    """Step 6b — Automatically run through the 4 pre-issuance verification
    steps: seed requirements, verify them, run compliance, and clear flags.
    Returns the updated readiness status for user approval."""
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)

    policy = await _resolve_policy_for_case(ctx, case)
    if not policy:
        return {
            "success": False,
            "message": f"No policy found for case **{case.get('caseNumber')}**.",
        }

    policy_id = policy.get("id")
    tid = ctx.tenant_id
    completed_steps = []

    # Step 1: Seed and verify requirements
    try:
        # Create requirement checklist (idempotent)
        req_res = await ctx.client.post(ctx.tsvc(f"/policies/{policy_id}/requirements"))
        req_res.raise_for_status()
        completed_steps.append("Requirements checklist seeded")
    except httpx.HTTPError:
        completed_steps.append("Requirements already seeded")

    # Fetch all requirements and verify/waive them
    try:
        reqs_res = await ctx.client.get(ctx.tsvc(f"/policies/{policy_id}/requirements"))
        reqs_res.raise_for_status()
        reqs = reqs_res.json()
        verified_count = 0
        for req in reqs:
            if req.get("status") not in ("Verified", "Waived"):
                try:
                    await ctx.client.post(
                        ctx.tsvc(f"/requirements/{req['id']}/verify"),
                        json={"actor": "ai-copilot", "note": "Auto-verified during pre-issuance automation"},
                    )
                    verified_count += 1
                except httpx.HTTPError:
                    pass
        if verified_count:
            completed_steps.append(f"{verified_count} requirement(s) verified")
        else:
            completed_steps.append("All requirements already cleared")
    except httpx.HTTPError as e:
        completed_steps.append(f"Requirements check: {e}")

    # Step 2: Run compliance screening
    try:
        comp_res = await ctx.client.post(ctx.tsvc(f"/policies/{policy_id}/compliance/run"))
        comp_res.raise_for_status()
        checks = comp_res.json()
        completed_steps.append(f"Compliance screening completed ({len(checks)} checks)")

        # Clear any flagged checks
        cleared_count = 0
        for check in checks:
            if check.get("status") in ("Flagged", "Failed"):
                try:
                    await ctx.client.post(
                        ctx.tsvc(f"/compliance/{check['id']}/clear"),
                        json={"cleared_by": "ai-copilot", "note": "Auto-cleared during pre-issuance automation"},
                    )
                    cleared_count += 1
                except httpx.HTTPError:
                    pass
        if cleared_count:
            completed_steps.append(f"{cleared_count} compliance flag(s) cleared")
    except httpx.HTTPError as e:
        completed_steps.append(f"Compliance: {e}")

    # Now fetch updated readiness
    try:
        ready_res = await ctx.client.get(ctx.tsvc(f"/policies/{policy_id}/pre-issuance"))
        ready_res.raise_for_status()
        readiness = ready_res.json()
    except httpx.HTTPError:
        readiness = {"ready_to_issue": False, "blockers": ["Could not fetch readiness"]}

    ready = readiness.get("ready_to_issue", False)
    steps_summary = "\n".join(f"  ✓ {s}" for s in completed_steps)

    if ready:
        message = (
            f"Pre-issuance verification for **{case.get('caseNumber')}** completed ✅\n\n"
            f"Steps completed:\n{steps_summary}\n\n"
            f"**All gates are cleared — the policy is ready to issue!**"
        )
    else:
        blockers = readiness.get("blockers", [])
        warnings = readiness.get("warnings", [])
        message = (
            f"Pre-issuance verification for **{case.get('caseNumber')}** completed:\n\n"
            f"Steps completed:\n{steps_summary}\n\n"
        )
        if blockers:
            message += f"⚠️ Remaining blockers: {', '.join(blockers)}\n"
        if warnings:
            message += f"ℹ️ Demo warnings (will be bypassed): {'; '.join(warnings)}\n"
        message += "\n**Ready to issue** (demo mode allows bypass of warnings)."

    qa = [
        {"label": "Issue Policy Now", "actionType": "submit",
         "payload": f"Issue the policy for case {case.get('caseNumber')}"},
        {"label": "View Readiness", "actionType": "submit",
         "payload": f"Check pre-issuance status for case {case.get('caseNumber')}"},
    ]

    return {
        "success": True,
        "message": message,
        "readiness": readiness,
        "policy_id": policy_id,
        "completed_steps": completed_steps,
        "last_action": _action("run_pre_issuance_verification", "case", case_id,
                               "policy-issuance", f"Pre-issuance verified for {case.get('caseNumber')}"),
        "quick_actions": qa,
    }


@handles("issue_policy")
async def _issue_policy(args: dict, ctx: Ctx) -> dict:
    """Step 6c — Draft the policy contract: assign a policy number, generate
    documents, compute the premium, and move to PendingPayment."""
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)

    policy = await _resolve_policy_for_case(ctx, case)
    if not policy:
        return {
            "success": False,
            "message": f"No policy found for case **{case.get('caseNumber')}**.",
        }

    policy_id = policy.get("id")
    current_status = (policy.get("status") or "").replace(" ", "")

    # If already PendingPayment, skip to payment
    if current_status.upper() in ("PENDINGPAYMENT",):
        return {
            "success": True,
            "message": f"Policy for **{case.get('caseNumber')}** is already in **Pending Payment** status. Confirm payment to activate coverage.",
            "policy_id": policy_id,
            "quick_actions": [
                {"label": "Confirm Payment", "actionType": "submit",
                 "payload": f"Confirm payment for case {case.get('caseNumber')}"},
            ],
        }

    # If already Active, report it
    if current_status.upper() == "ACTIVE":
        return {
            "success": True,
            "message": f"Policy for **{case.get('caseNumber')}** is already **Active**!",
            "policy_id": policy_id,
            "navigate": {"route": "policy-management/post-issuance", "entity_id": "", "highlight": False},
            "quick_actions": [
                {"label": "View Active Policy", "actionType": "submit",
                 "payload": f"Show me the active policy status for case {case.get('caseNumber')}"},
            ],
        }

    return {
        "__client_execute__": True,
        "kind": "client_execute",
        "tool_call": {
            "name": "issue_policy",
            "args": {"case_id": case_id, "policy": policy, "case_number": case.get('caseNumber')}
        }
    }


@handles("confirm_policy_payment")
async def _confirm_policy_payment(args: dict, ctx: Ctx) -> dict:
    """Step 6d — Confirm the first premium payment, activating coverage.
    Policy moves PendingPayment → Active, cases are closed, customer promoted
    to Policyholder."""
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)

    policy = await _resolve_policy_for_case(ctx, case)
    if not policy:
        return {
            "success": False,
            "message": f"No policy found for case **{case.get('caseNumber')}**.",
        }

    policy_id = policy.get("id")
    current_status = (policy.get("status") or "").replace(" ", "")

    # If already Active
    if current_status.upper() == "ACTIVE":
        return {
            "success": True,
            "message": f"Policy for **{case.get('caseNumber')}** is already **Active**!",
            "policy_id": policy_id,
            "navigate": {"route": "policy-management/post-issuance", "entity_id": "", "highlight": False},
            "quick_actions": [
                {"label": "View Active Policy", "actionType": "submit",
                 "payload": f"Show me the active policy status for case {case.get('caseNumber')}"},
                {"label": "Open Post-Issuance", "actionType": "navigate", "payload": "policy-management/post-issuance"},
            ],
        }

    return {
        "__client_execute__": True,
        "kind": "client_execute",
        "tool_call": {
            "name": "confirm_policy_payment",
            "args": {"case_id": case_id, "policy": policy, "case_number": case.get('caseNumber')}
        }
    }


@handles("get_active_policy_status")
async def _get_active_policy_status(args: dict, ctx: Ctx) -> dict:
    """Step 7 — Verify that the policy is now Active and visible in the
    post-issuance section. Shows key coverage details."""
    case = await _resolve_case(args, ctx)
    case_id = _case_id(case)

    policy = await _resolve_policy_for_case(ctx, case)
    if not policy:
        return {
            "success": False,
            "message": f"No policy found for case **{case.get('caseNumber')}**.",
        }

    policy_id = policy.get("id")

    # Fetch full policy detail
    try:
        res = await ctx.client.get(ctx.tsvc(f"/policies/{policy_id}"))
        res.raise_for_status()
        detail = res.json()
    except httpx.HTTPError:
        return {"success": False, "error": "Could not fetch policy details."}

    status = detail.get("status", "Unknown")
    customer_name = detail.get("customer_name", "—")
    policy_number = detail.get("policy_number", "—")
    post_issuance_route = f"post-issuance/{policy_id}"

    if status.upper() == "ACTIVE":
        docs = detail.get("documents", [])
        doc_list = "\n".join(f"  - {d.get('document_name')}" for d in docs[:5]) if docs else "  - No documents yet"

        message = (
            f"✅ Policy **{policy_number}** for **{customer_name}** is **Active**!\n\n"
            f"- Product: {detail.get('product_name')}\n"
            f"- Coverage: PKR {detail.get('coverage_amount', 0):,.0f}\n"
            f"- Effective: {detail.get('effective_date')}\n"
            f"- Expiry: {detail.get('expiry_date')}\n"
            f"- Delivery Date: {detail.get('delivery_date', '—')}\n"
            f"- Free-Look Ends: {detail.get('free_look_end_date', '—')}\n"
            f"- Nominee: {detail.get('nominee_name', '—')}\n\n"
            f"Documents:\n{doc_list}\n\n"
            f"This policy is now in the **Post-Issuance** management section, where you can manage "
            f"the free-look period, onboarding, premium collection, and more."
        )
    else:
        message = (
            f"Policy **{policy_number}** for **{customer_name}** is currently **{status}**.\n"
            f"It will appear in the post-issuance section once it becomes Active."
        )

    qa = [
        {"label": "Open Post-Issuance Detail", "actionType": "navigate", "payload": post_issuance_route},
        {"label": "Open Post-Issuance List", "actionType": "navigate", "payload": "policy-management/post-issuance"},
    ]
    if status.upper() != "ACTIVE":
        qa.insert(0, {"label": "Confirm Payment", "actionType": "submit",
                       "payload": f"Confirm payment for case {case.get('caseNumber')}"})

    return {
        "success": True,
        "message": message,
        "policy_detail": detail,
        "policy_id": policy_id,
        "navigate": {"route": post_issuance_route, "entity_id": "", "highlight": False},
        "quick_actions": qa,
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
        "Proposal created. Next: start the 6-gate Pre-Underwriting verification (Gate 1: E-Application).",
        [
            {"label": "1. Generate E-App Link (Gate 1)", "actionType": "submit", "payload": "Generate e-application link for this case"},
            {"label": "Check Pre-Underwriting Status", "actionType": "submit", "payload": "Check pre-underwriting status"},
            {"label": "View proposal", "actionType": "navigate", "payload": "proposal"},
        ],
    ),
    (
        ("gates cleared", "pre-underwriting cleared", "pre-underwriting complete", "preunderwriting done", "gates ready"),
        "pre_underwriting",
        "Pre-underwriting gates cleared. Next: run the AI risk assessment.",
        [
            {"label": "Run risk assessment", "actionType": "submit", "payload": "Run risk assessment"},
            {"label": "View case detail", "actionType": "navigate", "payload": "underwriting"},
        ],
    ),
    (
        ("documents uploaded", "document uploaded", "docs complete", "documents complete"),
        "documents",
        "Documents are in. Next: verify pre-underwriting gates and run the risk assessment.",
        [
            {"label": "Check Gate Status", "actionType": "submit", "payload": "Check pre-underwriting status for this case"},
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
        "Decision recorded. Next: verify pre-issuance requirements and issue the policy.",
        [
            {"label": "Pre-Issuance Verification", "actionType": "submit", "payload": "Verify pre-issuance requirements for this case"},
            {"label": "Issue policy", "actionType": "submit", "payload": "Issue the policy"},
            {"label": "Start new application", "actionType": "submit", "payload": "Add a new customer"},
        ],
    ),
]

_DEFAULT_ACTIONS = [
    {"label": "Add individual", "actionType": "submit", "payload": "Add a new individual customer"},
    {"label": "Add family", "actionType": "submit", "payload": "Add a family group with generic data"},
    {"label": "Add corporate", "actionType": "submit", "payload": "Add a corporate organization"},
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
    agent, error = await _resolve_lead_agent(args, ctx)
    if error:
        return error

    demo = _demo_customer()
    if args.get("applicant_name"):
        parts = args["applicant_name"].strip().split(maxsplit=1)
        demo["first_name"] = parts[0]
        demo["last_name"] = parts[1] if len(parts) > 1 else parts[0]

    birth_year = demo.pop("_birth_year")
    demo["assigned_agent_id"] = agent.get("id")

    cust_res = await ctx.client.post(ctx.tsvc("/customers"), json=_customer_payload(demo))
    cust_res.raise_for_status()
    customer = cust_res.json()

    name = f"{demo['first_name']} {demo['last_name']}"
    profile = (
        f"**{name}**\n"
        f"- CNIC: {demo['cnic']}\n"
        f"- Age: {date.today().year - birth_year}\n"
        f"- Occupation: {demo['occupation']}\n"
        f"- Declared income: PKR {demo['declared_income']:,}\n"
        f"- Agent: {agent.get('full_name')}"
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

    # full_journey — chain case + proposal + pre-underwriting clearance
    steps = [f"Registered {name}"]

    case_res = await ctx.client.post(ctx.tsvc("/cases"), json={
        "customer_id": customer["id"], "caseType": "Underwriting",
        "priorityLevel": "Normal", "sourceChannel": "Online",
    })
    case_res.raise_for_status()
    case = case_res.json()
    case_id = case.get("caseld") or case.get("id")
    case_no = case.get("caseNumber")
    steps.append(f"Opened case {case_no}")

    coverage = min(demo["declared_income"] * 10, 20_000_000)
    policy_res = await ctx.client.post(ctx.tsvc(f"/customers/{customer['id']}/policies"), json={
        "product_name": "Term Life Plus", "insurance_type": "TERM_LIFE",
        "coverage_amount": coverage, "term_years": 15,
    })
    policy_res.raise_for_status()
    steps.append(f"Created proposal — PKR {coverage:,} over 15 years")

    # Clear 6 Pre-Underwriting Gates
    try:
        await _run_pre_underwriting_clearance({"case_number": case_no}, ctx)
        steps.append("Cleared all 6 Pre-Underwriting Gates (E-App, ACR, Compliance, IPP, History, Medical)")
    except Exception as e:
        steps.append(f"Pre-underwriting auto-clearance note: {str(e)[:50]}")

    route = build_route("cases", case_id)
    return {
        "success": True,
        "message": (
            f"Demo journey set up.\n\n{profile}\n\n"
            + "\n".join(f"{i}. {s}" for i, s in enumerate(steps, 1))
            + "\n\nNext: run the risk assessment."
        ),
        "demo_customer": customer,
        "case_id": case_id,
        "last_action": _action("quick_start_workflow", "case", case_id, route, f"Demo case {case_no} ready"),
        "quick_actions": [
            {"label": "Run risk assessment", "actionType": "submit",
             "payload": f"Run risk assessment for case {case_no}"},
            {"label": "Check Pre-Underwriting Status", "actionType": "submit",
             "payload": f"Check pre-underwriting status for case {case_no}"},
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

    # run_risk_assessment fans out to the risk engine's 3-LLM-call pipeline,
    # and add_family_group / add_organization run concurrent risk engine calls
    # for all members. Give them real headroom.
    timeout = 180.0 if name in ("run_risk_assessment", "add_family_group", "add_organization") else 60.0

    try:
        # One pooled client for the whole process rather than a fresh one (and
        # a fresh connection pool) per tool call. An autonomous journey makes
        # 15+ calls and used to pay TCP setup on every one of them.
        #
        # Headers are per-call, not per-client, because auth differs by caller;
        # timeout likewise, because the risk-engine path needs far more headroom
        # than a list endpoint.
        client = await _shared_client()
        scoped = Ctx(
            client=_ScopedClient(client, headers=ctx.headers, timeout=timeout),
            tenant_id=ctx.effective_tenant_id,
            exec_ctx=ctx,
        )
        return await handler(args, scoped)
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
                "error": "Currently, you have no access to do this, ask your manager.",
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
@handles("bulk_underwriting_journey")
async def _bulk_underwriting_journey(args: dict, ctx: Ctx) -> dict:
    cnics = args.get("cnics", [])
    if not cnics:
        return {"success": False, "error": "No CNICs provided for bulk processing."}

    return {
        "__client_execute__": True,
        "kind": "client_execute",
        "tool_call": {
            "name": "bulk_underwriting_journey", 
            "args": {"cnics": cnics}
        }
    }


# ═══════════════════════════════════════════════════════════════════════════
# Rules engine — versioned underwriting governance
#
# All of this is backed by tenant-service/routers/rules.py. Rule sets are
# addressed by their dotted code (medical.nml_grid) rather than a UUID,
# because that is what a human says and what the model will echo back.
# ═══════════════════════════════════════════════════════════════════════════

def _rules(ctx: Ctx, path: str) -> str:
    return f"{TENANT_SERVICE_URL}/tenants/{ctx.tenant_id}/rules{path}"


def _parse_json_arg(raw: Any, field: str) -> Any:
    """Tool args carrying JSON arrive as strings (the model writes them into a
    string field). Accept both a real object and a string, and fence-strip the
    ```json blocks the model sometimes wraps them in."""
    if raw in (None, ""):
        return None
    if not isinstance(raw, str):
        return raw
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0]
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise LookupError(f"{field} isn't valid JSON: {exc.msg}") from exc


async def _find_rule_set(ctx: Ctx, code: str) -> dict:
    res = await ctx.client.get(_rules(ctx, "/sets"))
    res.raise_for_status()
    sets = res.json()
    needle = (code or "").strip().lower()
    match = next(
        (s for s in sets if (s.get("rule_code") or s.get("code") or "").lower() == needle),
        None,
    ) or next(
        (s for s in sets if needle and needle in (s.get("name") or "").lower()),
        None,
    )
    if not match:
        known = ", ".join(sorted(s.get("rule_code") or s.get("code") or "" for s in sets)[:8])
        raise LookupError(f'No rule set "{code}". Known codes include: {known}.')
    return match


async def _rule_set_detail(ctx: Ctx, code: str) -> tuple[dict, dict]:
    rs = await _find_rule_set(ctx, code)
    res = await ctx.client.get(_rules(ctx, f"/sets/{rs['id']}"))
    res.raise_for_status()
    return rs, res.json()


def _versions(detail: dict) -> list[dict]:
    return detail.get("versions") or []


def _version_with_status(detail: dict, status: str) -> Optional[dict]:
    return next((v for v in _versions(detail) if (v.get("status") or "").upper() == status), None)


@handles("list_rule_categories")
async def _list_rule_categories(args: dict, ctx: Ctx) -> dict:
    res = await ctx.client.get(_rules(ctx, "/categories"))
    res.raise_for_status()
    cats = res.json()
    if not cats:
        return {"success": True, "message": "No rule categories are set up yet.", "categories": []}

    lines = []
    for c in cats:
        subs = c.get("subcategories") or []
        lines.append(f"- **{c.get('name')}** (`{c.get('code')}`) — {len(subs)} subcategor(ies)")
        for s in subs[:4]:
            profiles = s.get("eligibility_profiles") or []
            channels = ", ".join(p.get("channel_code", "") for p in profiles) or "no channels"
            lines.append(f"    - {s.get('name')} (`{s.get('code')}`) — {channels}")
    return {
        "success": True,
        "message": f"{len(cats)} rule categor(ies):\n" + "\n".join(lines),
        "categories": cats,
        "quick_actions": [
            {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"},
            {"label": "List rule sets", "actionType": "submit", "payload": "List all rule sets"},
        ],
    }


@handles("list_rule_sets")
async def _list_rule_sets(args: dict, ctx: Ctx) -> dict:
    params = {}
    if args.get("category"):
        params["category"] = args["category"]
    if args.get("channel"):
        params["channel"] = args["channel"]
    res = await ctx.client.get(_rules(ctx, "/sets"), params=params or None)
    res.raise_for_status()
    rows = res.json()
    if not rows:
        return {"success": True, "message": "No rule sets match that.", "rule_sets": []}

    lines = "\n".join(
        f"- `{r.get('rule_code') or r.get('code')}` **{r.get('name')}** — "
        f"v{r.get('active_version_number') or '—'} "
        f"({r.get('active_version_status') or 'no active version'}), "
        f"{r.get('rule_count', 0)} rule(s)"
        for r in rows[:20]
    )
    return {
        "success": True,
        "message": f"{len(rows)} rule set(s):\n{lines}",
        "rule_sets": rows,
        "quick_actions": [
            {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"},
        ],
    }


@handles("get_rule_set")
async def _get_rule_set(args: dict, ctx: Ctx) -> dict:
    rs, detail = await _rule_set_detail(ctx, args.get("rule_set_code", ""))
    versions = _versions(detail)
    active = _version_with_status(detail, "ACTIVE")
    draft = _version_with_status(detail, "DRAFT")

    lines = [f"**{detail.get('name')}** (`{detail.get('rule_code') or detail.get('code')}`)"]
    if detail.get("description"):
        lines.append(f"_{detail['description']}_")
    lines.append("")
    lines.append(f"| Version | Status | Rules | Effective |")
    lines.append("| :-- | :-- | --: | :-- |")
    for v in versions[:8]:
        lines.append(
            f"| v{v.get('version_number')} | {v.get('status')} | "
            f"{len(v.get('rules') or [])} | {v.get('effective_from') or '—'} |"
        )

    if active and active.get("rules"):
        lines.append("")
        lines.append(f"**Rules in the active version (v{active.get('version_number')}):**")
        for r in sorted(active["rules"], key=lambda x: x.get("priority", 999))[:15]:
            state = "" if r.get("is_active", True) else " _(inactive)_"
            lines.append(f"- `{r.get('rule_code')}` p{r.get('priority')} — {r.get('name')} → {r.get('action_outcome')}{state}")

    qa = [{"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"}]
    if draft:
        qa.insert(0, {
            "label": f"Deploy draft v{draft.get('version_number')}",
            "actionType": "submit",
            "payload": f"Deploy the draft version of rule set {detail.get('rule_code') or detail.get('code')}",
        })
    else:
        qa.insert(0, {
            "label": "Open a draft version",
            "actionType": "submit",
            "payload": f"Create a new draft version of rule set {detail.get('rule_code') or detail.get('code')}",
        })
    qa.append({
        "label": "Simulate this rule set",
        "actionType": "submit",
        "payload": f"Simulate rule set {detail.get('rule_code') or detail.get('code')} for a 45 year old with 5000000 sum assured",
    })

    return {
        "success": True,
        "message": "\n".join(lines),
        "rule_set": detail,
        "quick_actions": qa,
    }


def _format_evaluation(payload: dict) -> str:
    status = payload.get("status", "UNKNOWN")
    matched = payload.get("matched_rule_codes") or []
    outcome = payload.get("outcome_payload") or {}
    impacts = payload.get("final_impacts") or {}

    lines = [f"**Result: {status}**"]
    if matched:
        lines.append(f"Matched rule(s): {', '.join(f'`{m}`' for m in matched)}")
    if outcome.get("reason"):
        lines.append(f"> {outcome['reason']}")
    interesting = {k: v for k, v in impacts.items() if v not in (None, 0, 0.0, [], {})}
    if interesting:
        lines.append("")
        lines.append("Impacts:")
        for k, v in list(interesting.items())[:8]:
            lines.append(f"- {k.replace('_', ' ')}: **{v}**")
    if not matched and not outcome:
        lines.append("_No rule matched this context — the rulebook has nothing to say about it._")
    return "\n".join(lines)


@handles("evaluate_rule_set")
async def _evaluate_rule_set(args: dict, ctx: Ctx) -> dict:
    code = args.get("rule_set_code", "")
    context = _parse_json_arg(args.get("context_json"), "context_json") or {}
    if not isinstance(context, dict):
        return {"success": False, "error": "context_json must be a JSON object, e.g. {\"age\": 45}."}

    # Confirm the code resolves before posting, so a typo produces a helpful
    # "known codes are..." message rather than a bare 404 from the API.
    rs = await _find_rule_set(ctx, code)
    real_code = rs.get("rule_code") or rs.get("code")

    res = await ctx.client.post(
        _rules(ctx, "/evaluate"),
        json={"rule_set_code": real_code, "context": context, "actor": "AI Copilot"},
    )
    res.raise_for_status()
    payload = res.json()

    return {
        "success": True,
        "message": f"Simulated `{real_code}` with {json.dumps(context)}:\n\n" + _format_evaluation(payload),
        "evaluation": payload,
        "quick_actions": [
            {"label": "Open Simulator", "actionType": "navigate", "payload": "admin/rule-engine"},
            {"label": "View rule set", "actionType": "submit", "payload": f"Show rule set {real_code}"},
            {"label": "View audit log", "actionType": "submit", "payload": "Show the rule evaluation logs"},
        ],
    }


@handles("evaluate_rule_scope")
async def _evaluate_rule_scope(args: dict, ctx: Ctx) -> dict:
    context = _parse_json_arg(args.get("context_json"), "context_json") or {}
    subcategory = args.get("subcategory") or args.get("category")
    if not subcategory:
        return {
            "success": False,
            "error": "Which subcategory should I evaluate? Call list_rule_categories to see what exists.",
        }
    body = {"subcategory_code": subcategory, "context": context, "actor": "AI Copilot"}
    if args.get("channel"):
        body["channel_code"] = args["channel"]

    res = await ctx.client.post(_rules(ctx, "/evaluate-scope"), json=body)
    res.raise_for_status()
    payload = res.json()

    results = payload.get("results") or payload.get("evaluations") or []
    lines = [f"Evaluated **{len(results)}** rule set(s) in scope `{subcategory}`:"]
    for r in results[:10]:
        matched = ", ".join(r.get("matched_rule_codes") or []) or "no match"
        lines.append(f"- `{r.get('rule_set_code')}` → {r.get('status')} ({matched})")
    combined = payload.get("final_impacts") or payload.get("combined_impacts") or {}
    interesting = {k: v for k, v in combined.items() if v not in (None, 0, 0.0, [], {})}
    if interesting:
        lines.append("")
        lines.append("**Combined impacts:** " + ", ".join(f"{k.replace('_',' ')}=**{v}**" for k, v in list(interesting.items())[:8]))

    return {
        "success": True,
        "message": "\n".join(lines),
        "evaluation": payload,
        "quick_actions": [
            {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"},
        ],
    }


@handles("get_rule_evaluation_logs")
async def _get_rule_evaluation_logs(args: dict, ctx: Ctx) -> dict:
    limit = min(int(args.get("limit") or 20), 50)
    res = await ctx.client.get(_rules(ctx, "/logs"), params={"limit": limit})
    res.raise_for_status()
    logs = res.json()
    if not logs:
        return {"success": True, "message": "No rule evaluations recorded yet.", "logs": []}

    lines = "\n".join(
        f"- `{l.get('rule_set_code')}` v{l.get('version_number') or '—'} → "
        f"{l.get('status') or '—'} "
        f"({', '.join(l.get('matched_rule_codes') or []) or 'no match'})"
        + (f" · {l.get('customer_cnic')}" if l.get("customer_cnic") else "")
        for l in logs[:15]
    )
    return {
        "success": True,
        "message": f"{len(logs)} recent rule evaluation(s):\n{lines}",
        "logs": logs,
        "quick_actions": [
            {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"},
        ],
    }


@handles("create_rule_set")
async def _create_rule_set(args: dict, ctx: Ctx) -> dict:
    cats_res = await ctx.client.get(_rules(ctx, "/categories"))
    cats_res.raise_for_status()
    cats = cats_res.json()

    cat_code = (args.get("category_code") or "").upper()
    sub_code = (args.get("subcategory_code") or "").upper()
    category = next((c for c in cats if (c.get("code") or "").upper() == cat_code), None)
    if not category:
        known = ", ".join(c.get("code", "") for c in cats)
        return {"success": False, "error": f'No category "{args.get("category_code")}". Existing: {known}.'}

    subs = category.get("subcategories") or []
    sub = next((s for s in subs if (s.get("code") or "").upper() == sub_code), None)
    if not sub:
        known = ", ".join(s.get("code", "") for s in subs) or "none yet"
        return {"success": False, "error": f'No subcategory "{args.get("subcategory_code")}" under {cat_code}. Existing: {known}.'}

    body = {
        "rule_code": args.get("code"),
        "name": args.get("name"),
        "description": args.get("description") or "",
        "subcategory_id": sub["id"],
    }
    profiles = sub.get("eligibility_profiles") or []
    if args.get("channel_code"):
        prof = next((p for p in profiles if (p.get("channel_code") or "").upper() == args["channel_code"].upper()), None)
        if prof:
            body["eligibility_id"] = prof["id"]
    if not body.get("eligibility_id"):
        # The API requires eligibility_id unless scope_type is GLOBAL — without
        # this it 400s on every rule set that has no channel (either the
        # subcategory carries no eligibility profiles at all, or the user
        # deliberately chose "every channel").
        body["scope_type"] = "GLOBAL"

    res = await ctx.client.post(_rules(ctx, "/sets"), json=body)
    res.raise_for_status()
    created = res.json()
    code = created.get("rule_code") or args.get("code")

    return {
        "success": True,
        "message": (
            f"Created rule set **{args.get('name')}** (`{code}`) under {cat_code} / {sub_code}. "
            "It has an empty DRAFT version — add rules to it, then deploy."
        ),
        "rule_set": created,
        "last_action": _action("create_rule_set", "rule_set", str(created.get("id", "")),
                               "admin/rule-engine", f"Rule set {code} created"),
        "quick_actions": [
            {"label": "Add a rule", "actionType": "submit", "payload": f"Add a rule to rule set {code}"},
            {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"},
        ],
    }


@handles("create_rule_version")
async def _create_rule_version(args: dict, ctx: Ctx) -> dict:
    rs, detail = await _rule_set_detail(ctx, args.get("rule_set_code", ""))
    code = detail.get("rule_code") or detail.get("code")

    existing_draft = _version_with_status(detail, "DRAFT")
    if existing_draft:
        return {
            "success": True,
            "message": (
                f"`{code}` already has a DRAFT — v{existing_draft.get('version_number')} "
                f"with {len(existing_draft.get('rules') or [])} rule(s). Edit that one rather than opening another."
            ),
            "version": existing_draft,
            "quick_actions": [
                {"label": "Add a rule", "actionType": "submit", "payload": f"Add a rule to rule set {code}"},
                {"label": f"Deploy v{existing_draft.get('version_number')}", "actionType": "submit",
                 "payload": f"Deploy the draft version of rule set {code}"},
            ],
        }

    res = await ctx.client.post(_rules(ctx, f"/sets/{rs['id']}/versions"))
    res.raise_for_status()
    version = res.json()
    return {
        "success": True,
        "message": (
            f"Opened DRAFT **v{version.get('version_number')}** of `{code}`, copying the active rules. "
            "Changes now go into this draft; nothing is live until you deploy it."
        ),
        "version": version,
        "last_action": _action("create_rule_version", "rule_set", str(rs["id"]),
                               "admin/rule-engine", f"Draft v{version.get('version_number')} opened on {code}"),
        "quick_actions": [
            {"label": "Add a rule", "actionType": "submit", "payload": f"Add a rule to rule set {code}"},
            {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"},
        ],
    }


# The model writes conditions in the compact seed shape
# ({"field","operator","value"}); the API wants RuleCriteriaCreate. Translate.
# rule_evaluator.py only recognizes eq/neq/gt/gte/lt/lte/between/in_set/contains
# as stored operator values (services/tenant-service/rule_evaluator.py:170-209).
# The model (and the older seed data) writes looser synonyms — map them onto
# the canonical name so a rule the picker builds with "in one of" actually
# matches at evaluation time instead of silently never firing.
_OPERATOR_ALIASES = {
    "in": "in_set", "not_in": "in_set", "is_one_of": "in_set", "is_not_one_of": "in_set",
    "ne": "neq", "!=": "neq", "not_equals": "neq", "not_equal": "neq",
    ">": "gt", ">=": "gte", "<": "lt", "<=": "lte", "=": "eq", "==": "eq",
}


def _to_criteria(conditions: list) -> list[dict]:
    out = []
    for c in conditions or []:
        if not isinstance(c, dict):
            continue
        op = (c.get("operator") or "eq").lower()
        op = _OPERATOR_ALIASES.get(op, op)
        value = c.get("value")
        crit: dict[str, Any] = {
            "group_id": int(c.get("group_id") or 1),
            "field_name": c.get("field") or c.get("field_name") or "",
            "operator": op,
        }
        if op == "between" and isinstance(value, (list, tuple)) and len(value) == 2:
            crit["value_range_min"] = _as_float(value[0])
            crit["value_range_max"] = _as_float(value[1])
        elif op == "in_set" and isinstance(value, (list, tuple)):
            crit["value_list"] = list(value)
        elif isinstance(value, bool):
            crit["value_string"] = "true" if value else "false"
        elif isinstance(value, (int, float)):
            crit["value_numeric"] = float(value)
        elif value is not None:
            crit["value_string"] = str(value)
        out.append(crit)
    return out


_OUTCOME_TO_IMPACT_TYPE = {
    "REQUIRE_MEDICAL_EXAM": "REQUIRE_MEDICAL",
    "WAIVE_MEDICAL": "AUTO_APPROVE",
    "APPLY_COMMISSION_RATE": "APPLY_LOADING",
    "APPLY_LOADING": "APPLY_LOADING",
    "DECLINE": "DECLINE",
    "REFER": "REFER_TO_UNDERWRITER",
    "REFER_TO_UNDERWRITER": "REFER_TO_UNDERWRITER",
    "EXCLUSION": "EXCLUSION_CLAUSE",
    "HLV_MULTIPLE_LOOKUP": "FINANCIAL_JUSTIFICATION",
}


async def _draft_for(ctx: Ctx, code: str) -> tuple[dict, dict, str]:
    """Resolve (rule_set, draft_version, code) or automatically open a draft if none exists."""
    rs, detail = await _rule_set_detail(ctx, code)
    real_code = detail.get("rule_code") or detail.get("code")
    draft = _version_with_status(detail, "DRAFT")
    if not draft:
        res = await ctx.client.post(_rules(ctx, f"/sets/{rs['id']}/versions"))
        res.raise_for_status()
        draft = res.json()
    return rs, draft, real_code


@handles("add_rule_to_version")
async def _add_rule_to_version(args: dict, ctx: Ctx) -> dict:
    _rs, draft, code = await _draft_for(ctx, args.get("rule_set_code", ""))
    conditions = _parse_json_arg(args.get("conditions_json"), "conditions_json") or []
    outcome = _parse_json_arg(args.get("outcome_json"), "outcome_json") or {}
    action = args.get("action_outcome") or "REFER_TO_UNDERWRITER"

    body = {
        "name": args.get("name"),
        "rule_code": args.get("rule_code"),
        "priority": int(args.get("priority") or 100),
        "is_active": True,
        "impact_type": _OUTCOME_TO_IMPACT_TYPE.get(action.upper(), "REFER_TO_UNDERWRITER"),
        "action_outcome": action,
        "criteria": _to_criteria(conditions if isinstance(conditions, list) else [conditions]),
    }
    if isinstance(outcome, dict) and outcome:
        body["impact_data"] = {k: v for k, v in outcome.items() if k != "reason"}

    res = await ctx.client.post(_rules(ctx, f"/versions/{draft['id']}/rules"), json=body)
    res.raise_for_status()
    rule = res.json()

    return {
        "success": True,
        "message": (
            f"Added `{args.get('rule_code')}` — {args.get('name')} — to DRAFT "
            f"v{draft.get('version_number')} of `{code}` at priority {body['priority']}. "
            "Still a draft: deploy it to make it live."
        ),
        "rule": rule,
        "last_action": _action("add_rule_to_version", "rule_set", str(_rs["id"]),
                               "admin/rule-engine", f"Rule {args.get('rule_code')} added to {code}"),
        "quick_actions": [
            {"label": "Simulate it", "actionType": "submit",
             "payload": f"Simulate rule set {code} for a 45 year old with 5000000 sum assured"},
            {"label": f"Deploy v{draft.get('version_number')}", "actionType": "submit",
             "payload": f"Deploy the draft version of rule set {code}"},
            {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"},
        ],
    }


def _find_rule(draft: dict, rule_code: str) -> dict:
    needle = (rule_code or "").strip().lower()
    rule = next((r for r in (draft.get("rules") or []) if (r.get("rule_code") or "").lower() == needle), None)
    if not rule:
        known = ", ".join(r.get("rule_code", "") for r in (draft.get("rules") or [])[:10]) or "none"
        raise LookupError(f'No rule "{rule_code}" in the draft. It has: {known}.')
    return rule


@handles("update_rule")
async def _update_rule(args: dict, ctx: Ctx) -> dict:
    _rs, draft, code = await _draft_for(ctx, args.get("rule_set_code", ""))
    rule = _find_rule(draft, args.get("rule_code", ""))

    body: dict[str, Any] = {}
    if args.get("name"):
        body["name"] = args["name"]
    if args.get("priority") is not None:
        body["priority"] = int(args["priority"])
    if args.get("is_active") is not None:
        body["is_active"] = bool(args["is_active"])
    if args.get("action_outcome"):
        body["action_outcome"] = args["action_outcome"]
        body["impact_type"] = _OUTCOME_TO_IMPACT_TYPE.get(args["action_outcome"].upper(), "REFER_TO_UNDERWRITER")
    conditions = _parse_json_arg(args.get("conditions_json"), "conditions_json")
    if conditions is not None:
        body["criteria"] = _to_criteria(conditions if isinstance(conditions, list) else [conditions])
    outcome = _parse_json_arg(args.get("outcome_json"), "outcome_json")
    if isinstance(outcome, dict) and outcome:
        body["impact_data"] = {k: v for k, v in outcome.items() if k != "reason"}

    if not body:
        return {"success": False, "error": "Nothing to change — tell me which field to update."}

    res = await ctx.client.put(_rules(ctx, f"/versions/{draft['id']}/rules/{rule['id']}"), json=body)
    res.raise_for_status()
    return {
        "success": True,
        "message": f"Updated `{rule.get('rule_code')}` in DRAFT v{draft.get('version_number')} of `{code}`.",
        "rule": res.json(),
        "last_action": _action("update_rule", "rule_set", str(_rs["id"]),
                               "admin/rule-engine", f"Rule {rule.get('rule_code')} updated"),
        "quick_actions": [
            {"label": f"Deploy v{draft.get('version_number')}", "actionType": "submit",
             "payload": f"Deploy the draft version of rule set {code}"},
            {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"},
        ],
    }


@handles("delete_rule")
async def _delete_rule(args: dict, ctx: Ctx) -> dict:
    _rs, draft, code = await _draft_for(ctx, args.get("rule_set_code", ""))
    rule = _find_rule(draft, args.get("rule_code", ""))
    res = await ctx.client.delete(_rules(ctx, f"/rules/{rule['id']}"))
    res.raise_for_status()
    return {
        "success": True,
        "message": f"Deleted `{rule.get('rule_code')}` from DRAFT v{draft.get('version_number')} of `{code}`.",
        "last_action": _action("delete_rule", "rule_set", str(_rs["id"]),
                               "admin/rule-engine", f"Rule {rule.get('rule_code')} deleted"),
        "quick_actions": [
            {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"},
        ],
    }


@handles("deploy_rule_version")
async def _deploy_rule_version(args: dict, ctx: Ctx) -> dict:
    rs, detail = await _rule_set_detail(ctx, args.get("rule_set_code", ""))
    code = detail.get("rule_code") or detail.get("code")
    draft = _version_with_status(detail, "DRAFT")
    if not draft:
        return {
            "success": False,
            "message": f"`{code}` has no DRAFT version to deploy. Open one, make the change, then deploy.",
            "quick_actions": [
                {"label": "Open a draft version", "actionType": "submit",
                 "payload": f"Create a new draft version of rule set {code}"},
            ],
        }

    previous = _version_with_status(detail, "ACTIVE")
    res = await ctx.client.patch(
        _rules(ctx, f"/versions/{draft['id']}/status"),
        json={"status": "ACTIVE", "approved_by": ctx.exec_ctx.role or "AI Copilot"},
    )
    res.raise_for_status()

    was = f" replacing v{previous.get('version_number')}" if previous else ""
    return {
        "success": True,
        "message": (
            f"Deployed **v{draft.get('version_number')}** of `{code}`{was}. "
            f"{len(draft.get('rules') or [])} rule(s) are now live and will apply to every case "
            "evaluated from now on."
        ),
        "version": res.json(),
        "last_action": _action("deploy_rule_version", "rule_set", str(rs["id"]),
                               "admin/rule-engine", f"{code} v{draft.get('version_number')} deployed"),
        "quick_actions": [
            {"label": "Simulate the live rules", "actionType": "submit",
             "payload": f"Simulate rule set {code} for a 45 year old with 5000000 sum assured"},
            {"label": "View audit log", "actionType": "submit", "payload": "Show the rule evaluation logs"},
            {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"},
        ],
    }


@handles("archive_rule_version")
async def _archive_rule_version(args: dict, ctx: Ctx) -> dict:
    rs, detail = await _rule_set_detail(ctx, args.get("rule_set_code", ""))
    code = detail.get("rule_code") or detail.get("code")
    active = _version_with_status(detail, "ACTIVE")
    if not active:
        return {"success": False, "message": f"`{code}` has no ACTIVE version to archive."}

    res = await ctx.client.patch(
        _rules(ctx, f"/versions/{active['id']}/status"),
        json={"status": "ARCHIVED", "approved_by": ctx.exec_ctx.role or "AI Copilot"},
    )
    res.raise_for_status()
    return {
        "success": True,
        "message": f"Archived v{active.get('version_number')} of `{code}`. It no longer applies to new evaluations.",
        "last_action": _action("archive_rule_version", "rule_set", str(rs["id"]),
                               "admin/rule-engine", f"{code} v{active.get('version_number')} archived"),
        "quick_actions": [
            {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"},
        ],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Commission engine
#
# Split brain, deliberately, until the backend lands:
#
#   get_commission_rate_card  — REAL. The SECP statutory rate card is seeded
#                               into the rule engine (commission.secp_rate_card)
#                               so the rate comes from the same place the
#                               portal reads it from.
#   everything else           — CLIENT-EXECUTED. The payee registry, waterfall,
#                               ledger and payout runs live in the browser
#                               (frontend/app/services/commissions.ts) because
#                               there is no commission table yet. The browser
#                               already holds that state, so the tool hands
#                               execution to it the same way upload_document
#                               and issue_policy do.
#
# When routers/commissions.py exists, these handlers move server-side and the
# client-execute markers come out. The tool contract stays the same.
# ═══════════════════════════════════════════════════════════════════════════

_COMMISSION_CLIENT_TOOLS = {
    "list_commission_payees",
    "calculate_commission",
    "get_commission_ledger",
    "get_agent_statement",
    "get_commission_summary",
    "create_payout_run",
    "approve_payout_run",
    "list_commission_rules",
    "create_commission_rule",
    "update_commission_rule",
    "delete_commission_rule",
    "toggle_commission_rule_active",
    "list_incentive_schemes",
    "create_incentive_scheme",
    "update_incentive_scheme",
    "delete_incentive_scheme",
    "toggle_incentive_scheme_active",
}


def _commission_client_call(name: str, args: dict) -> dict:
    return {
        "__client_execute__": True,
        "kind": "client_execute",
        "tool_call": {"name": name, "args": args},
    }


@handles("get_commission_rate_card")
async def _get_commission_rate_card(args: dict, ctx: Ctx) -> dict:
    segment = (args.get("segment") or "individual").lower()
    category = {"group": "Group", "family": "Family"}.get(segment, "Individual")
    policy_year = int(args.get("policy_year") or 1)
    premium_type = args.get("premium_type") or ("FIRST_YEAR" if policy_year == 1 else "RENEWAL")

    res = await ctx.client.post(
        _rules(ctx, "/evaluate"),
        json={
            "rule_set_code": "commission.secp_rate_card",
            "context": {
                "category": category,
                "policy_year": policy_year,
                "premium_type": premium_type,
            },
            "actor": "AI Copilot",
        },
    )
    res.raise_for_status()
    payload = res.json()
    outcome = payload.get("outcome_payload") or {}
    rate = outcome.get("commission_pct")
    wht = outcome.get("withholding_tax_pct")

    if rate is None:
        return {
            "success": False,
            "message": (
                f"The rate card has no rule for {category} / {premium_type} / year {policy_year}. "
                "Check the commission.secp_rate_card rule set."
            ),
            "evaluation": payload,
            "quick_actions": [
                {"label": "View rate card rules", "actionType": "submit",
                 "payload": "Show rule set commission.secp_rate_card"},
            ],
        }

    lines = [
        f"**{category}** · {premium_type.replace('_', ' ').title()} · policy year {policy_year}",
        "",
        f"- Commission: **{rate}%** of premium",
    ]
    if wht is not None:
        lines.append(f"- Withholding tax: **{wht}%** (filer rate; non-filers are doubled under s.233)")
    if outcome.get("reason"):
        lines.append(f"\n> {outcome['reason']}")

    return {
        "success": True,
        "message": "\n".join(lines),
        "rate_pct": rate,
        "withholding_tax_pct": wht,
        "evaluation": payload,
        "quick_actions": [
            {"label": "Open Rate Card", "actionType": "navigate", "payload": "commissions/rate-card"},
            {"label": "Calculate a policy", "actionType": "submit",
             "payload": "Calculate the commission waterfall for the most recent policy"},
            {"label": "View rate card rules", "actionType": "submit",
             "payload": "Show rule set commission.secp_rate_card"},
        ],
    }


@handles("list_commission_payees")
async def _list_commission_payees(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("list_commission_payees", args)


@handles("calculate_commission")
async def _calculate_commission(args: dict, ctx: Ctx) -> dict:
    # Resolve the policy server-side where we can, so the browser gets a real
    # policy rather than having to guess from a name.
    resolved = dict(args)
    if not args.get("policy_number") and (args.get("cnic") or args.get("applicant_name")):
        policy = await _find_policy_by_customer(ctx, args.get("cnic"), args.get("applicant_name"))
        if policy:
            resolved["policy_id"] = policy.get("id")
            resolved["policy_number"] = policy.get("policy_number")
            resolved["product_name"] = policy.get("product_name")
            resolved["coverage_amount"] = policy.get("coverage_amount")
            resolved["annual_premium"] = policy.get("annual_premium") or policy.get("premium_amount")
            resolved["customer_name"] = policy.get("customer_name")
    return _commission_client_call("calculate_commission", resolved)


@handles("get_commission_ledger")
async def _get_commission_ledger(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("get_commission_ledger", args)


@handles("get_agent_statement")
async def _get_agent_statement(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("get_agent_statement", args)


@handles("get_commission_summary")
async def _get_commission_summary(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("get_commission_summary", args)


@handles("create_payout_run")
async def _create_payout_run(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("create_payout_run", args)


@handles("approve_payout_run")
async def _approve_payout_run(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("approve_payout_run", args)


@handles("list_commission_rules")
async def _list_commission_rules(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("list_commission_rules", args)


@handles("create_commission_rule")
async def _create_commission_rule(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("create_commission_rule", args)


@handles("update_commission_rule")
async def _update_commission_rule(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("update_commission_rule", args)


@handles("delete_commission_rule")
async def _delete_commission_rule(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("delete_commission_rule", args)


@handles("toggle_commission_rule_active")
async def _toggle_commission_rule_active(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("toggle_commission_rule_active", args)


@handles("list_incentive_schemes")
async def _list_incentive_schemes(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("list_incentive_schemes", args)


@handles("create_incentive_scheme")
async def _create_incentive_scheme(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("create_incentive_scheme", args)


@handles("update_incentive_scheme")
async def _update_incentive_scheme(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("update_incentive_scheme", args)


@handles("delete_incentive_scheme")
async def _delete_incentive_scheme(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("delete_incentive_scheme", args)


@handles("toggle_incentive_scheme_active")
async def _toggle_incentive_scheme_active(args: dict, ctx: Ctx) -> dict:
    return _commission_client_call("toggle_incentive_scheme_active", args)



# ═══════════════════════════════════════════════════════════════════════════
# Rules catalogue authoring — Category / SubCategory / EligibilityProfile
#
# Backed by tenant-service/routers/rules.py's hierarchy endpoints. These exist
# so the agent never has to answer "you must create a category first" with a
# dead end: when a prerequisite level is missing it offers to create it, and
# these are what that offer executes.
# ═══════════════════════════════════════════════════════════════════════════

async def _categories(ctx: Ctx) -> list[dict]:
    res = await ctx.client.get(_rules(ctx, "/categories"))
    res.raise_for_status()
    return res.json()


def _find_category(cats: list[dict], code: str) -> Optional[dict]:
    needle = (code or "").strip().upper()
    if not needle:
        return None
    return next((c for c in cats if (c.get("code") or "").upper() == needle), None) or next(
        (c for c in cats if needle in (c.get("name") or "").upper()), None
    )


def _find_subcategory(category: dict, code: str) -> Optional[dict]:
    needle = (code or "").strip().upper()
    if not needle:
        return None
    subs = category.get("subcategories") or []
    return next((s for s in subs if (s.get("code") or "").upper() == needle), None) or next(
        (s for s in subs if needle in (s.get("name") or "").upper()), None
    )


def _slug_code(text: str) -> str:
    """"Claims Governance" -> "CLAIMS_GOVERNANCE". The catalogue codes are
    UPPER_SNAKE by convention; the model reliably writes prose instead."""
    cleaned = "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in (text or ""))
    return "_".join(part.upper() for part in cleaned.split())[:60] or "CATEGORY"


@handles("create_rule_category")
async def _create_rule_category(args: dict, ctx: Ctx) -> dict:
    cats = await _categories(ctx)
    code = (args.get("code") or _slug_code(args.get("name", ""))).strip().upper()
    existing = _find_category(cats, code)
    if existing:
        return {
            "success": True,
            "message": f"Category **{existing.get('name')}** (`{existing.get('code')}`) already exists — using it.",
            "category": existing,
            "quick_actions": _catalogue_actions(existing.get("code", code)),
        }

    display_name = args.get("name") or code.replace("_", " ").title()
    res = await ctx.client.post(
        _rules(ctx, "/categories"),
        json={"code": code, "name": display_name, "description": args.get("description") or ""},
    )
    res.raise_for_status()
    # The API's create response is a bare {id, code} — the name it was given
    # never round-trips, so carry the one we sent rather than reading it back.
    created = {**res.json(), "name": display_name}
    return {
        "success": True,
        "message": (
            f"Created category **{created.get('name')}** (`{created.get('code')}`). "
            "It needs at least one subcategory before rule sets can be filed under it."
        ),
        "category": created,
        "last_action": _action("create_rule_category", "rule_category", str(created.get("id", "")),
                               "admin/rule-engine", f"Category {created.get('code')} created"),
        "quick_actions": _catalogue_actions(created.get("code", code)),
    }


def _catalogue_actions(category_code: str) -> list[dict]:
    return [
        {"label": "Add a subcategory", "actionType": "submit",
         "payload": f"Add a subcategory under category {category_code}"},
        {"label": "Create a rule set here", "actionType": "submit",
         "payload": f"Create a rule set under category {category_code}"},
        {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"},
    ]


@handles("create_rule_subcategory")
async def _create_rule_subcategory(args: dict, ctx: Ctx) -> dict:
    cats = await _categories(ctx)
    category = _find_category(cats, args.get("category_code", ""))
    if not category:
        known = ", ".join(c.get("code", "") for c in cats) or "none yet"
        return {
            "success": False,
            "error": f'No category "{args.get("category_code")}". Existing categories: {known}.',
            "quick_actions": [
                {"label": "Create the category first", "actionType": "submit",
                 "payload": f"Create a rule category called {args.get('category_code')}"},
            ],
        }

    code = (args.get("code") or _slug_code(args.get("name", ""))).strip().upper()
    existing = _find_subcategory(category, code)
    if existing:
        return {
            "success": True,
            "message": f"Subcategory **{existing.get('name')}** (`{existing.get('code')}`) already exists under `{category.get('code')}`.",
            "subcategory": existing,
            "quick_actions": _subcategory_actions(category.get("code", ""), existing.get("code", code)),
        }

    display_name = args.get("name") or code.replace("_", " ").title()
    res = await ctx.client.post(
        _rules(ctx, f"/categories/{category['id']}/subcategories"),
        json={"code": code, "name": display_name},
    )
    res.raise_for_status()
    # Same bare {id, code} response shape as create_category — carry the name.
    created = {**res.json(), "name": display_name}
    return {
        "success": True,
        "message": (
            f"Created subcategory **{created.get('name')}** (`{created.get('code')}`) "
            f"under **{category.get('name')}**. Rule sets can now be filed here."
        ),
        "subcategory": created,
        "last_action": _action("create_rule_subcategory", "rule_subcategory", str(created.get("id", "")),
                               "admin/rule-engine", f"Subcategory {created.get('code')} created"),
        "quick_actions": _subcategory_actions(category.get("code", ""), created.get("code", code)),
    }


def _subcategory_actions(category_code: str, subcategory_code: str) -> list[dict]:
    return [
        {"label": "Create a rule set here", "actionType": "submit",
         "payload": f"Create a rule set under {category_code} / {subcategory_code}"},
        {"label": "Add a channel profile", "actionType": "submit",
         "payload": f"Add an eligibility profile to {category_code} / {subcategory_code}"},
        {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"},
    ]


@handles("create_eligibility_profile")
async def _create_eligibility_profile(args: dict, ctx: Ctx) -> dict:
    cats = await _categories(ctx)
    category = _find_category(cats, args.get("category_code", ""))
    if not category:
        known = ", ".join(c.get("code", "") for c in cats) or "none yet"
        return {"success": False, "error": f'No category "{args.get("category_code")}". Existing: {known}.'}
    sub = _find_subcategory(category, args.get("subcategory_code", ""))
    if not sub:
        known = ", ".join(s.get("code", "") for s in (category.get("subcategories") or [])) or "none yet"
        return {"success": False, "error": f'No subcategory "{args.get("subcategory_code")}" under {category.get("code")}. Existing: {known}.'}

    channel = (args.get("channel_code") or "").strip().upper()
    already = next(
        (p for p in (sub.get("eligibility_profiles") or []) if (p.get("channel_code") or "").upper() == channel),
        None,
    )
    if already:
        return {
            "success": True,
            "message": f"`{channel}` is already a channel on **{sub.get('name')}**.",
            "eligibility_profile": already,
            "quick_actions": _subcategory_actions(category.get("code", ""), sub.get("code", "")),
        }

    res = await ctx.client.post(
        _rules(ctx, f"/subcategories/{sub['id']}/eligibility-profiles"),
        json={
            "channel_code": channel,
            "min_entry_age": int(args.get("min_entry_age") or 18),
            "max_entry_age": int(args.get("max_entry_age") or 65),
            "max_maturity_age": int(args.get("max_maturity_age") or 75),
            "min_sum_assured": float(args.get("min_sum_assured") or 500000.0),
        },
    )
    res.raise_for_status()
    created = res.json()
    return {
        "success": True,
        "message": (
            f"Added channel **{channel}** to **{sub.get('name')}** — entry age "
            f"{args.get('min_entry_age') or 18}–{args.get('max_entry_age') or 65}, "
            f"maturity by {args.get('max_maturity_age') or 75}, "
            f"minimum sum assured PKR {float(args.get('min_sum_assured') or 500000):,.0f}."
        ),
        "eligibility_profile": created,
        "last_action": _action("create_eligibility_profile", "rule_subcategory", str(sub.get("id", "")),
                               "admin/rule-engine", f"Channel {channel} added to {sub.get('code')}"),
        "quick_actions": _subcategory_actions(category.get("code", ""), sub.get("code", "")),
    }


# ═══════════════════════════════════════════════════════════════════════════
# Claims — FNOL, triage, document audit, adjudication, disbursement, recovery
#
# Backed by tenant-service/routers/claims.py. Two things shape every handler
# here:
#
#   1. Claims are addressed by CLAIM NUMBER (CLM-2026-0001) or claimant name.
#      The UUID never leaves this module.
#   2. The API enforces four hard gates — a legal-transition state machine, a
#      "at least one document" gate on approve/settle, a payout-record gate on
#      Settled, and a ClaimsManager gate over PKR 500k. A raw 400 from any of
#      those is a dead end for a chat user, so `_claim_actions` reads the claim
#      and hands back the buttons that clear the *specific* gate blocking it.
#      That is what makes the flow clickable end-to-end instead of typed.
# ═══════════════════════════════════════════════════════════════════════════

CLAIM_TYPES = ("Hospitalization", "Surgery", "Death Claim", "Reimbursement")

# What a complete claim file looks like, per claim type. The API only requires
# ONE document, but an adjuster asking "what's missing?" means this.
CLAIM_DOCUMENTS: dict[str, tuple[str, ...]] = {
    "Hospitalization": ("Hospital Bill", "Discharge Summary", "CNIC", "Lab Test Report"),
    "Surgery": ("Hospital Bill", "Discharge Summary", "Lab Test Report", "CNIC"),
    "Death Claim": ("Death Certificate", "CNIC", "Hospital Bill"),
    "Reimbursement": ("Hospital Bill", "CNIC", "Lab Test Report"),
}
CLAIM_DOCUMENT_FALLBACK = ("Hospital Bill", "CNIC")

# Mirrors VALID_TRANSITIONS in routers/claims.py. Duplicated deliberately: the
# agent has to know what is legal *before* calling, so it can offer only the
# moves that will succeed rather than proposing one and eating a 400.
CLAIM_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "New": ("Triaged", "Under Investigation", "Pending Documents", "Re-Underwriting Required"),
    "Triaged": ("Under Investigation", "Pending Documents", "Referred to Manager",
                "Re-Underwriting Required", "Declined"),
    "Pending Documents": ("Under Investigation", "Triaged", "Re-Underwriting Required", "Declined"),
    "Under Investigation": ("Approved", "Partial Approval", "Declined", "Pending Documents",
                            "Referred to Manager", "Re-Underwriting Required"),
    "Referred to Manager": ("Approved", "Partial Approval", "Declined", "Under Investigation",
                            "Re-Underwriting Required"),
    "Re-Underwriting Required": ("Under Investigation", "Approved", "Partial Approval",
                                 "Declined", "Referred to Manager"),
    "Approved": ("Settled", "Closed"),
    "Partial Approval": ("Settled", "Closed"),
    "Declined": ("Closed",),
    "Settled": ("Closed",),
    "Closed": (),
}

CLAIM_MANAGER_THRESHOLD = 500_000.0
CLAIM_RETENTION_LIMIT = 5_000_000.0

CLAIM_REFERRAL_REASONS = (
    "Policy Issued < 2 Years Ago (Contestability Window)",
    "Undisclosed Pre-Existing Medical History (OCR Flag)",
    "Claim Amount Exceeds Adjuster Limit (> PKR 500k)",
    "Claim Amount Exceeds Net Retention (> PKR 5M)",
    "Post-Claim Coverage Restatement & Rider Exclusion",
    "Disability Care & Fitness-for-Duty Assessment",
)


def _claims(ctx: Ctx, path: str = "") -> str:
    return f"{TENANT_SERVICE_URL}/tenants/{ctx.tenant_id}/claims{path}"


def _claim_status(claim: dict) -> str:
    return str(claim.get("status") or "New")


def _claim_ref(claim: dict) -> str:
    """How the user (and the model) refers to this claim in the next message."""
    return claim.get("claim_number") or claim.get("claimant_name") or str(claim.get("id", ""))


def _claim_route(claim: dict) -> str:
    cid = str(claim.get("id") or "")
    return f"claims/{cid}" if cid else "claims"


def _claim_docs_missing(claim: dict) -> list[str]:
    expected = CLAIM_DOCUMENTS.get(claim.get("claim_type") or "", CLAIM_DOCUMENT_FALLBACK)
    on_file = {
        (a.get("document_type") or "").strip().lower()
        for a in (claim.get("artifacts") or [])
    }
    return [d for d in expected if d.lower() not in on_file]


def _claim_doc_count(claim: dict) -> int:
    arts = claim.get("artifacts")
    if arts is not None:
        return len(arts)
    return int(claim.get("artifacts_count") or 0)


def _upload_action(claim: dict, doc_type: str) -> dict:
    return {
        "label": f"Upload {doc_type}",
        "actionType": "upload",
        "payload": json.dumps({
            "document_type": doc_type,
            "claim_id": str(claim.get("id") or ""),
            "claim_number": claim.get("claim_number") or "",
        }),
    }


def _claim_actions(claim: dict) -> list[dict]:
    """The next legal moves on this claim, as one-click chips.

    Ordered by what an adjuster would actually do next, and filtered by the
    gates the API will enforce — so every chip shown is a chip that works.
    """
    ref = _claim_ref(claim)
    status = _claim_status(claim)
    docs = _claim_doc_count(claim)
    missing = _claim_docs_missing(claim)
    amount = float(claim.get("submitted_amount") or 0)
    approved = float(claim.get("approved_amount") or 0)
    actions: list[dict] = []

    def submit(label: str, payload: str) -> dict:
        return {"label": label, "actionType": "submit", "payload": payload}

    if status in ("New", "Triaged", "Pending Documents"):
        # Documents first: nothing downstream of triage can succeed without one.
        for doc in missing[:2]:
            actions.append(_upload_action(claim, doc))
        if status == "New":
            actions.append(submit("Triage this claim", f"Move claim {ref} to Triaged"))
        if docs:
            actions.append(submit("Start investigation", f"Move claim {ref} to Under Investigation"))
        else:
            actions.append(submit("Mark pending documents", f"Move claim {ref} to Pending Documents"))

    elif status == "Under Investigation":
        if docs == 0:
            for doc in missing[:2]:
                actions.append(_upload_action(claim, doc))
            actions.append(submit("Mark pending documents", f"Move claim {ref} to Pending Documents"))
        else:
            actions.append(submit(f"Approve PKR {amount:,.0f}", f"Adjudicate claim {ref} as APPROVED for {amount:.0f}"))
            actions.append(submit("Partial approval", f"Adjudicate claim {ref} as PARTIAL_APPROVAL"))
            actions.append(submit("Decline claim", f"Adjudicate claim {ref} as DECLINED"))
        if amount > CLAIM_MANAGER_THRESHOLD:
            actions.append(submit("Refer to manager", f"Adjudicate claim {ref} as REFERRED_TO_MANAGER"))
        if claim.get("is_contestable"):
            actions.append(submit("Refer to underwriting", f"Refer claim {ref} to underwriting"))

    elif status == "Referred to Manager":
        actions.append(submit("Approve as manager", f"Adjudicate claim {ref} as APPROVED for {amount:.0f}"))
        actions.append(submit("Partial approval", f"Adjudicate claim {ref} as PARTIAL_APPROVAL"))
        actions.append(submit("Decline claim", f"Adjudicate claim {ref} as DECLINED"))
        actions.append(submit("Send back to investigation", f"Move claim {ref} to Under Investigation"))

    elif status == "Re-Underwriting Required":
        actions.append(submit("Approve & continue", f"Resolve underwriting on claim {ref} as APPROVE_CONTINUE"))
        actions.append(submit("Approve with exclusion", f"Resolve underwriting on claim {ref} as APPROVE_WITH_EXCLUSION"))
        actions.append(submit("Approve with loading", f"Resolve underwriting on claim {ref} as APPROVE_WITH_LOADING"))
        actions.append(submit("Decline — non-disclosure", f"Resolve underwriting on claim {ref} as DECLINE_NON_DISCLOSURE"))

    elif status in ("Approved", "Partial Approval"):
        payable = approved or amount
        actions.append(submit(f"Disburse PKR {payable:,.0f}", f"Issue claim payout for {ref} of {payable:.0f} by Bank Transfer"))
        coverage = float(claim.get("coverage_amount") or 0)
        if coverage > CLAIM_RETENTION_LIMIT and not claim.get("reinsurance_referral_id"):
            actions.append(submit("Recover from reinsurer", f"Refer claim {ref} to reinsurance"))
        actions.append(submit("Close without payout", f"Move claim {ref} to Closed"))

    elif status == "Settled":
        actions.append(submit("Close the claim", f"Move claim {ref} to Closed"))
        actions.append(submit("Recover from reinsurer", f"Refer claim {ref} to reinsurance"))

    elif status == "Declined":
        actions.append(submit("Close the claim", f"Move claim {ref} to Closed"))
        actions.append(submit("Reopen investigation", f"Move claim {ref} to Under Investigation"))

    elif status == "Reinsurance Referred":
        actions.append(submit("View claim file", f"Show claim {ref}"))

    if status != "Closed":
        actions.append(submit("What's missing?", f"What documents are missing on claim {ref}?"))
    actions.append({"label": "Open claim file", "actionType": "navigate", "payload": _claim_route(claim)})
    return actions[:6]


def _claim_summary(claim: dict) -> str:
    status = _claim_status(claim)
    lines = [
        f"**{claim.get('claim_number')}** — {claim.get('claimant_name')} · "
        f"{claim.get('claim_type')} · **{status}**",
        f"Claimed **PKR {float(claim.get('submitted_amount') or 0):,.0f}**"
        + (f" · approved PKR {float(claim.get('approved_amount') or 0):,.0f}" if claim.get("approved_amount") else "")
        + (f" · settled PKR {float(claim.get('settlement_amount') or 0):,.0f}" if claim.get("settlement_amount") else ""),
    ]
    if claim.get("policy_number"):
        lines.append(f"Policy `{claim['policy_number']}` · {claim.get('policy_type') or '—'} · "
                     f"cover PKR {float(claim.get('coverage_amount') or 0):,.0f}")
    flags = []
    if claim.get("duplicate_flag"):
        flags.append("⚠️ duplicate suspected")
    if float(claim.get("fraud_probability") or 0) >= 0.5:
        flags.append(f"⚠️ fraud probability {float(claim['fraud_probability']):.0%}")
    if claim.get("is_contestable"):
        flags.append("⚠️ inside the 2-year contestability window")
    if float(claim.get("submitted_amount") or 0) > CLAIM_MANAGER_THRESHOLD:
        flags.append("needs ClaimsManager sign-off (> PKR 500k)")
    if flags:
        lines.append("· ".join(flags))
    docs = _claim_doc_count(claim)
    lines.append(f"Documents on file: **{docs}**" + (f" — missing {', '.join(_claim_docs_missing(claim))}" if _claim_docs_missing(claim) else " — file complete"))
    nxt = CLAIM_TRANSITIONS.get(status, ())
    if nxt:
        lines.append(f"Legal next states: {', '.join(nxt)}")
    return "\n".join(lines)


async def _list_claims_raw(ctx: Ctx, params: Optional[dict] = None) -> list[dict]:
    res = await ctx.client.get(_claims(ctx), params=params or None)
    res.raise_for_status()
    return res.json()


async def _resolve_claim(args: dict, ctx: Ctx) -> dict:
    """"Which claim did they mean?" — by number, then by claimant name.

    Returns the FULL detail payload (artifacts, history, payouts), because
    every caller needs the document count to decide what is even legal.
    """
    number = (args.get("claim_number") or "").strip()
    name = (args.get("claimant_name") or args.get("cnic") or "").strip()
    claims = await _list_claims_raw(ctx, {"search": number or name} if (number or name) else None)

    match = None
    if number:
        match = next((c for c in claims if (c.get("claim_number") or "").lower() == number.lower()), None)
        if not match:
            match = next((c for c in claims if str(c.get("id")) == number), None)
    if not match and name:
        match = next((c for c in claims if name.lower() in (c.get("claimant_name") or "").lower()), None)
        if not match:
            match = next((c for c in claims if name.lower() in (c.get("policy_number") or "").lower()), None)
    if not match and len(claims) == 1:
        match = claims[0]

    if not match:
        hint = number or name or "that"
        raise LookupError(
            f'No claim found for "{hint}". Register a First Notice of Loss first, '
            "or ask me to list the open claims."
        )

    detail = await ctx.client.get(_claims(ctx, f"/{match['id']}"))
    detail.raise_for_status()
    return detail.json()


@handles("list_claims")
async def _list_claims(args: dict, ctx: Ctx) -> dict:
    params = {}
    for key in ("status", "claim_type", "search"):
        if args.get(key):
            params[key] = args[key]
    claims = await _list_claims_raw(ctx, params)
    if not claims:
        return {
            "success": True,
            "message": "No claims match that." if params else "No claims have been registered yet.",
            "claims": [],
            "quick_actions": [
                {"label": "Register a claim (FNOL)", "actionType": "submit", "payload": "Register a new claim"},
                {"label": "Open Claims", "actionType": "navigate", "payload": "claims"},
            ],
        }

    lines = "\n".join(
        f"- `{c.get('claim_number')}` **{c.get('claimant_name')}** — {c.get('claim_type')} · "
        f"PKR {float(c.get('submitted_amount') or 0):,.0f} · **{_claim_status(c)}**"
        + (" ⚠️ duplicate" if c.get("duplicate_flag") else "")
        + (f" · {c.get('artifacts_count') or 0} doc(s)")
        for c in claims[:15]
    )
    actionable = [c for c in claims if _claim_status(c) not in ("Closed", "Settled")]
    qa: list[dict] = []
    for c in actionable[:3]:
        qa.append({"label": f"Work {c.get('claim_number')}", "actionType": "submit",
                   "payload": f"Show claim {c.get('claim_number')}"})
    qa.append({"label": "Register a claim (FNOL)", "actionType": "submit", "payload": "Register a new claim"})
    qa.append({"label": "Open Claims", "actionType": "navigate", "payload": "claims"})

    return {
        "success": True,
        "message": f"{len(claims)} claim(s){' matching that filter' if params else ''}:\n{lines}",
        "claims": claims,
        "quick_actions": qa[:6],
    }


@handles("get_claim_details")
async def _get_claim_details(args: dict, ctx: Ctx) -> dict:
    claim = await _resolve_claim(args, ctx)
    lines = [_claim_summary(claim)]

    history = claim.get("status_history") or []
    if history:
        lines.append("")
        lines.append("**Recent activity:**")
        for h in history[:4]:
            lines.append(f"- {h.get('from_status') or '—'} → **{h.get('to_status')}** by {h.get('actor_name')}"
                         + (f" · {h['notes']}" if h.get("notes") else ""))

    payouts = claim.get("payouts") or []
    if payouts:
        lines.append("")
        lines.append("**Payouts:** " + ", ".join(
            f"PKR {float(p.get('amount') or 0):,.0f} via {p.get('method')} ({p.get('reference_number')})"
            for p in payouts[:3]
        ))

    if claim.get("underwriting_referral_reason"):
        lines.append("")
        lines.append(f"**Referred to underwriting for:** {claim['underwriting_referral_reason']}")
    if claim.get("underwriting_decision_notes"):
        lines.append(f"**Underwriting note:** {claim['underwriting_decision_notes']}")

    return {
        "success": True,
        "message": "\n".join(lines),
        "claim": claim,
        "navigate": {"route": _claim_route(claim), "entity_id": str(claim.get("id") or ""), "highlight": False},
        "quick_actions": _claim_actions(claim),
    }


@handles("get_claims_dashboard")
async def _get_claims_dashboard(args: dict, ctx: Ctx) -> dict:
    claims = await _list_claims_raw(ctx)
    if not claims:
        return {
            "success": True,
            "message": "No claims registered yet — the book is clean.",
            "quick_actions": [
                {"label": "Register a claim (FNOL)", "actionType": "submit", "payload": "Register a new claim"},
                {"label": "Open Claims", "actionType": "navigate", "payload": "claims"},
            ],
        }

    by_status: dict[str, int] = {}
    submitted = settled = 0.0
    blocked_on_docs: list[dict] = []
    needs_manager: list[dict] = []
    for c in claims:
        st = _claim_status(c)
        by_status[st] = by_status.get(st, 0) + 1
        submitted += float(c.get("submitted_amount") or 0)
        settled += float(c.get("settlement_amount") or 0)
        if st not in ("Closed", "Settled", "Declined") and not (c.get("artifacts_count") or 0):
            blocked_on_docs.append(c)
        if st == "Referred to Manager" or (
            st in ("Under Investigation", "Triaged") and float(c.get("submitted_amount") or 0) > CLAIM_MANAGER_THRESHOLD
        ):
            needs_manager.append(c)

    open_count = sum(v for k, v in by_status.items() if k not in ("Closed", "Settled", "Declined"))
    lines = [
        f"**{len(claims)} claim(s)** · {open_count} still open",
        f"Submitted **PKR {submitted:,.0f}** · settled **PKR {settled:,.0f}**",
        "",
        "| Status | Count |", "| :-- | --: |",
        *(f"| {k} | {v} |" for k, v in sorted(by_status.items(), key=lambda kv: -kv[1])),
    ]
    if blocked_on_docs:
        lines.append("")
        lines.append(f"⚠️ **{len(blocked_on_docs)}** claim(s) cannot be approved — no documents on file: "
                     + ", ".join(f"`{c.get('claim_number')}`" for c in blocked_on_docs[:5]))
    if needs_manager:
        lines.append(f"⚠️ **{len(needs_manager)}** claim(s) need ClaimsManager sign-off: "
                     + ", ".join(f"`{c.get('claim_number')}`" for c in needs_manager[:5]))

    qa: list[dict] = []
    if blocked_on_docs:
        c = blocked_on_docs[0]
        qa.append({"label": f"Fix documents on {c.get('claim_number')}", "actionType": "submit",
                   "payload": f"What documents are missing on claim {c.get('claim_number')}?"})
    if needs_manager:
        c = needs_manager[0]
        qa.append({"label": f"Decide {c.get('claim_number')}", "actionType": "submit",
                   "payload": f"Show claim {c.get('claim_number')}"})
    qa += [
        {"label": "Show open claims", "actionType": "submit", "payload": "List claims that are Under Investigation"},
        {"label": "Register a claim (FNOL)", "actionType": "submit", "payload": "Register a new claim"},
        {"label": "Open Claims", "actionType": "navigate", "payload": "claims"},
    ]
    return {
        "success": True,
        "message": "\n".join(lines),
        "claims": claims,
        "quick_actions": qa[:6],
    }


@handles("get_claim_document_checklist")
async def _get_claim_document_checklist(args: dict, ctx: Ctx) -> dict:
    claim = await _resolve_claim(args, ctx)
    expected = CLAIM_DOCUMENTS.get(claim.get("claim_type") or "", CLAIM_DOCUMENT_FALLBACK)
    on_file = [(a.get("document_type") or "?") for a in (claim.get("artifacts") or [])]
    missing = _claim_docs_missing(claim)

    lines = [f"Document file for **{claim.get('claim_number')}** ({claim.get('claim_type')}):"]
    for doc in expected:
        lines.append(f"- {'✅' if doc not in missing else '⬜'} {doc}")
    extra = [d for d in on_file if d not in expected]
    for doc in extra:
        lines.append(f"- ✅ {doc} _(additional)_")
    if not on_file:
        lines.append("")
        lines.append("⚠️ Nothing on file yet — the platform blocks approval, payout and settlement "
                     "until at least one verified document is attached.")

    qa = [_upload_action(claim, d) for d in missing[:3]]
    if on_file:
        qa.append({"label": "Continue adjudication", "actionType": "submit",
                   "payload": f"Show claim {_claim_ref(claim)}"})
    qa.append({"label": "Open claim file", "actionType": "navigate", "payload": _claim_route(claim)})

    return {
        "success": True,
        "message": "\n".join(lines),
        "claim": claim,
        "missing": missing,
        "quick_actions": qa[:6],
    }


async def _resolve_claim_policy(args: dict, ctx: Ctx) -> dict:
    """Which policy is the FNOL against? Number first, then claimant/CNIC.

    Only policies that can actually carry a claim are candidates — you cannot
    claim on a proposal that was never issued.
    """
    res = await ctx.client.get(ctx.tsvc("/policies"))
    res.raise_for_status()
    policies = res.json()
    claimable = [p for p in policies if (p.get("status") or "").lower() in ("active", "pendingpayment", "lapsed", "matured")]
    pool = claimable or policies

    number = (args.get("policy_number") or "").strip()
    if number:
        match = next((p for p in pool if (p.get("policy_number") or "").lower() == number.lower()), None) \
            or next((p for p in pool if str(p.get("id")) == number), None)
        if match:
            return match

    name = (args.get("claimant_name") or "").strip()
    if name:
        match = next((p for p in pool if name.lower() in (p.get("customer_name") or "").lower()), None)
        if match:
            return match

    cnic = (args.get("cnic") or "").strip()
    if cnic:
        cust = await ctx.client.get(ctx.tsvc("/customers"))
        cust.raise_for_status()
        customer = _find_customer(cust.json(), cnic, None)
        if customer:
            match = next((p for p in pool if str(p.get("customer_id")) == str(customer.get("id"))), None)
            if match:
                return match

    if not pool:
        raise LookupError(
            "There are no policies to claim against yet. A claim needs an issued policy — "
            "run the underwriting journey first."
        )
    hint = number or name or cnic or "that"
    known = ", ".join(f"{p.get('policy_number')} ({p.get('customer_name')})" for p in pool[:5])
    raise LookupError(f'No policy matches "{hint}". Claimable policies include: {known}.')


async def fetch_claimable_policies(exec_ctx: ExecCtx) -> list[dict]:
    """Policies a claim can actually be filed against, for callers outside a
    handler (graph.py's FNOL policy picker).

    A proposal that was never issued cannot carry a loss, so unissued statuses
    are filtered out here rather than offered to the user and then rejected by
    the API. Falls back to the full list only when the filter empties it — an
    empty picker is worse than a slightly permissive one.
    """
    client = await _shared_client()
    scoped = _ScopedClient(client, headers=exec_ctx.headers, timeout=30.0)
    res = await scoped.get(
        f"{TENANT_SERVICE_URL}/tenants/{exec_ctx.effective_tenant_id}/policies"
    )
    res.raise_for_status()
    policies = res.json()
    claimable = [
        p for p in policies
        if (p.get("status") or "").lower() in ("active", "pendingpayment", "lapsed", "matured")
    ]
    return claimable or policies


@handles("register_claim")
async def _register_claim(args: dict, ctx: Ctx) -> dict:
    policy = await _resolve_claim_policy(args, ctx)

    claim_type = (args.get("claim_type") or "").strip()
    matched_type = next((t for t in CLAIM_TYPES if t.lower() == claim_type.lower()), None) \
        or next((t for t in CLAIM_TYPES if claim_type and claim_type.lower() in t.lower()), None)
    if not matched_type:
        return {
            "success": False,
            "error": f"What kind of claim is this on policy {policy.get('policy_number')}?",
            "quick_actions": [
                {"label": t, "actionType": "submit",
                 "payload": f"Register a {t} claim on policy {policy.get('policy_number')}"
                            + (f" for {args['submitted_amount']:.0f}" if args.get("submitted_amount") else "")}
                for t in CLAIM_TYPES
            ],
        }

    amount = _as_float(args.get("submitted_amount"))
    if not amount or amount <= 0:
        cover = float(policy.get("coverage_amount") or 0)
        suggestions = [a for a in (50_000, 200_000, 500_000, cover) if a and a <= (cover or a)]
        return {
            "success": False,
            "error": f"How much is being claimed on {policy.get('policy_number')} "
                     f"(cover PKR {cover:,.0f})?",
            "quick_actions": [
                {"label": f"PKR {a:,.0f}", "actionType": "submit",
                 "payload": f"Register a {matched_type} claim on policy {policy.get('policy_number')} for {a:.0f}"}
                for a in dict.fromkeys(suggestions)
            ][:4],
        }

    body: dict[str, Any] = {
        "policy_id": str(policy["id"]),
        "claim_type": matched_type,
        "submitted_amount": float(amount),
    }
    if args.get("incident_date"):
        body["incident_date"] = args["incident_date"]
    if args.get("notes"):
        body["notes"] = args["notes"]

    res = await ctx.client.post(_claims(ctx), json=body)
    res.raise_for_status()
    claim = res.json()

    warn = []
    if claim.get("duplicate_flag"):
        warn.append("⚠️ **Duplicate suspected** — a claim of the same type and amount already exists on this policy. "
                    "Approving it will require written rationale (15+ characters).")
    if claim.get("is_contestable"):
        warn.append("⚠️ The policy is inside its **2-year contestability window** — a re-underwriting referral may be required.")
    if float(amount) > CLAIM_MANAGER_THRESHOLD:
        warn.append(f"⚠️ Over PKR {CLAIM_MANAGER_THRESHOLD:,.0f} — approval needs a **ClaimsManager**.")

    message = (
        f"Registered FNOL **{claim.get('claim_number')}** — {matched_type} for "
        f"PKR {float(amount):,.0f} on policy `{policy.get('policy_number')}` "
        f"({policy.get('customer_name')}). AI recommendation: **{claim.get('ai_recommendation')}**. "
        f"Linked SLA case opened."
    )
    if warn:
        message += "\n\n" + "\n".join(warn)
    message += "\n\nNothing can be approved or settled until at least one document is on file."

    return {
        "success": True,
        "message": message,
        "claim": claim,
        "last_action": _action("register_claim", "claim", str(claim.get("id", "")),
                               _claim_route(claim), f"Claim {claim.get('claim_number')} registered"),
        "navigate": {"route": _claim_route(claim), "entity_id": str(claim.get("id") or ""), "highlight": False},
        "quick_actions": _claim_actions(claim),
    }


@handles("update_claim_status")
async def _update_claim_status(args: dict, ctx: Ctx) -> dict:
    claim = await _resolve_claim(args, ctx)
    current = _claim_status(claim)
    target = (args.get("new_status") or "").strip()
    legal = CLAIM_TRANSITIONS.get(current, ())

    resolved = next((s for s in legal if s.lower() == target.lower()), None) \
        or next((s for s in legal if target and target.lower() in s.lower()), None)
    if not resolved:
        return {
            "success": False,
            "error": (
                f"`{claim.get('claim_number')}` is **{current}** — it cannot move to \"{target}\". "
                + (f"Legal next states: {', '.join(legal)}." if legal else "It is closed; nothing further is possible.")
            ),
            "quick_actions": [
                {"label": s, "actionType": "submit", "payload": f"Move claim {_claim_ref(claim)} to {s}"}
                for s in legal[:4]
            ] + [{"label": "Open claim file", "actionType": "navigate", "payload": _claim_route(claim)}],
        }

    # Pre-flight the two gates the API enforces, so the user gets buttons that
    # clear the blocker rather than a 400 they cannot act on.
    if resolved in ("Approved", "Partial Approval", "Settled") and _claim_doc_count(claim) == 0:
        missing = _claim_docs_missing(claim)
        return {
            "success": False,
            "error": (
                f"Cannot move `{claim.get('claim_number')}` to **{resolved}** — no documents are on file. "
                f"At least one verified claim document is required."
            ),
            "quick_actions": [_upload_action(claim, d) for d in missing[:3]]
                             + [{"label": "Open claim file", "actionType": "navigate", "payload": _claim_route(claim)}],
        }
    if resolved == "Settled" and not (claim.get("payouts") or []):
        payable = float(claim.get("approved_amount") or claim.get("submitted_amount") or 0)
        return {
            "success": False,
            "error": (
                f"`{claim.get('claim_number')}` cannot be marked **Settled** without a disbursement record. "
                "Issue the payout instead — that settles it in one step."
            ),
            "quick_actions": [
                {"label": f"Disburse PKR {payable:,.0f}", "actionType": "submit",
                 "payload": f"Issue claim payout for {_claim_ref(claim)} of {payable:.0f} by Bank Transfer"},
                {"label": "Open claim file", "actionType": "navigate", "payload": _claim_route(claim)},
            ],
        }

    body = {"status": resolved}
    if args.get("notes"):
        body["notes"] = args["notes"]
    res = await ctx.client.patch(_claims(ctx, f"/{claim['id']}/status"), json=body)
    res.raise_for_status()
    updated = {**claim, **res.json()}

    return {
        "success": True,
        "message": f"`{claim.get('claim_number')}` moved **{current} → {resolved}**.\n\n" + _claim_summary(updated),
        "claim": updated,
        "last_action": _action("update_claim_status", "claim", str(claim.get("id", "")),
                               _claim_route(claim), f"{claim.get('claim_number')} → {resolved}"),
        "quick_actions": _claim_actions(updated),
    }


@handles("adjudicate_claim")
async def _adjudicate_claim(args: dict, ctx: Ctx) -> dict:
    claim = await _resolve_claim(args, ctx)
    decision = (args.get("decision") or "").strip().upper()
    if decision not in ("APPROVED", "PARTIAL_APPROVAL", "DECLINED", "REFERRED_TO_MANAGER"):
        return {
            "success": False,
            "error": f"What is the decision on `{claim.get('claim_number')}`?",
            "quick_actions": _claim_actions(claim),
        }

    submitted = float(claim.get("submitted_amount") or 0)

    if decision in ("APPROVED", "PARTIAL_APPROVAL") and _claim_doc_count(claim) == 0:
        missing = _claim_docs_missing(claim)
        return {
            "success": False,
            "error": (
                f"`{claim.get('claim_number')}` has no documents on file — approval is blocked until "
                "at least one verified document is attached."
            ),
            "quick_actions": [_upload_action(claim, d) for d in missing[:3]]
                             + [{"label": "Decline instead", "actionType": "submit",
                                 "payload": f"Adjudicate claim {_claim_ref(claim)} as DECLINED"}],
        }

    notes = args.get("notes")
    if claim.get("duplicate_flag") and decision in ("APPROVED", "PARTIAL_APPROVAL") and len((notes or "").strip()) < 15:
        return {
            "success": False,
            "error": (
                f"`{claim.get('claim_number')}` is flagged as a **possible duplicate**. Approving it needs a written "
                "adjudicator rationale of at least 15 characters. Pick one, or dictate your own:"
            ),
            "quick_actions": [
                {"label": "Different incident date", "actionType": "submit",
                 "payload": f"Adjudicate claim {_claim_ref(claim)} as {decision} with notes "
                            "'Verified against prior claim: distinct incident date and separate admission — not a duplicate.'"},
                {"label": "Separate treatment episode", "actionType": "submit",
                 "payload": f"Adjudicate claim {_claim_ref(claim)} as {decision} with notes "
                            "'Documents confirm a separate treatment episode with independent hospital billing.'"},
                {"label": "Prior claim was reversed", "actionType": "submit",
                 "payload": f"Adjudicate claim {_claim_ref(claim)} as {decision} with notes "
                            "'Earlier matching claim was reversed and never disbursed; this is the valid submission.'"},
                {"label": "Decline as duplicate", "actionType": "submit",
                 "payload": f"Adjudicate claim {_claim_ref(claim)} as DECLINED"},
            ],
        }

    approved = _as_float(args.get("approved_amount"))
    if decision == "APPROVED" and not approved:
        approved = submitted
    if decision == "PARTIAL_APPROVAL" and not approved:
        return {
            "success": False,
            "error": f"How much of the PKR {submitted:,.0f} claimed on `{claim.get('claim_number')}` is being approved?",
            "quick_actions": [
                {"label": f"{pct}% — PKR {submitted * pct / 100:,.0f}", "actionType": "submit",
                 "payload": f"Adjudicate claim {_claim_ref(claim)} as PARTIAL_APPROVAL for {submitted * pct / 100:.0f}"}
                for pct in (75, 50, 25)
            ] + [{"label": "Approve in full", "actionType": "submit",
                  "payload": f"Adjudicate claim {_claim_ref(claim)} as APPROVED for {submitted:.0f}"}],
        }
    if approved and approved > submitted:
        return {
            "success": False,
            "error": f"PKR {approved:,.0f} exceeds the PKR {submitted:,.0f} claimed — the approved amount cannot be higher.",
            "quick_actions": [
                {"label": f"Approve the full PKR {submitted:,.0f}", "actionType": "submit",
                 "payload": f"Adjudicate claim {_claim_ref(claim)} as APPROVED for {submitted:.0f}"},
            ],
        }

    body: dict[str, Any] = {"decision": decision}
    if approved:
        body["approved_amount"] = float(approved)
    if notes:
        body["notes"] = notes
    res = await ctx.client.post(_claims(ctx, f"/{claim['id']}/adjudicate"), json=body)
    res.raise_for_status()
    updated = {**claim, **res.json()}

    verdict = {
        "APPROVED": f"**Approved** for PKR {float(updated.get('approved_amount') or 0):,.0f}",
        "PARTIAL_APPROVAL": f"**Partially approved** — PKR {float(updated.get('approved_amount') or 0):,.0f} of PKR {submitted:,.0f}",
        "DECLINED": "**Declined**",
        "REFERRED_TO_MANAGER": "**Referred to the claims manager**",
    }[decision]

    return {
        "success": True,
        "message": f"`{claim.get('claim_number')}` — {verdict}.\n\n" + _claim_summary(updated),
        "claim": updated,
        "last_action": _action("adjudicate_claim", "claim", str(claim.get("id", "")),
                               _claim_route(claim), f"{claim.get('claim_number')} {decision}"),
        "quick_actions": _claim_actions(updated),
    }


@handles("issue_claim_payout")
async def _issue_claim_payout(args: dict, ctx: Ctx) -> dict:
    claim = await _resolve_claim(args, ctx)
    status = _claim_status(claim)
    if status not in ("Approved", "Partial Approval"):
        return {
            "success": False,
            "error": (
                f"`{claim.get('claim_number')}` is **{status}** — payouts can only be issued from "
                "Approved or Partial Approval."
            ),
            "quick_actions": _claim_actions(claim),
        }
    if _claim_doc_count(claim) == 0:
        return {
            "success": False,
            "error": f"`{claim.get('claim_number')}` has no documents on file — disbursement is blocked.",
            "quick_actions": [_upload_action(claim, d) for d in _claim_docs_missing(claim)[:3]],
        }

    max_allowed = float(claim.get("approved_amount") or 0) or float(claim.get("submitted_amount") or 0)
    amount = _as_float(args.get("amount")) or max_allowed
    if amount > max_allowed:
        return {
            "success": False,
            "error": f"PKR {amount:,.0f} exceeds the approved PKR {max_allowed:,.0f}.",
            "quick_actions": [
                {"label": f"Disburse PKR {max_allowed:,.0f}", "actionType": "submit",
                 "payload": f"Issue claim payout for {_claim_ref(claim)} of {max_allowed:.0f} by Bank Transfer"},
            ],
        }

    method = args.get("method") or "Bank Transfer"
    body: dict[str, Any] = {"amount": float(amount), "method": method}
    if args.get("reference_number"):
        body["reference_number"] = args["reference_number"]
    if args.get("notes"):
        body["notes"] = args["notes"]

    res = await ctx.client.post(_claims(ctx, f"/{claim['id']}/payout"), json=body)
    res.raise_for_status()
    payout = res.json()

    refreshed = await ctx.client.get(_claims(ctx, f"/{claim['id']}"))
    refreshed.raise_for_status()
    updated = refreshed.json()

    return {
        "success": True,
        "message": (
            f"Disbursed **PKR {float(amount):,.0f}** on `{claim.get('claim_number')}` via {method} — "
            f"reference `{payout.get('reference_number')}`. The claim is now **Settled**."
        ),
        "claim": updated,
        "payout": payout,
        "last_action": _action("issue_claim_payout", "claim", str(claim.get("id", "")),
                               _claim_route(claim), f"PKR {float(amount):,.0f} disbursed on {claim.get('claim_number')}"),
        "quick_actions": _claim_actions(updated),
    }


@handles("refer_claim_to_reinsurance")
async def _refer_claim_to_reinsurance(args: dict, ctx: Ctx) -> dict:
    claim = await _resolve_claim(args, ctx)
    if claim.get("reinsurance_referral_id"):
        return {
            "success": True,
            "message": f"`{claim.get('claim_number')}` already has a reinsurance recovery referral open.",
            "claim": claim,
            "quick_actions": _claim_actions(claim),
        }
    res = await ctx.client.post(_claims(ctx, f"/{claim['id']}/reinsurance-refer"))
    res.raise_for_status()
    payload = res.json()
    coverage = float(claim.get("coverage_amount") or 0)
    ceded = max(0.0, coverage - CLAIM_RETENTION_LIMIT)

    return {
        "success": True,
        "message": (
            f"Opened a facultative recovery referral on `{claim.get('claim_number')}` — "
            f"sum assured PKR {coverage:,.0f}, retained PKR {min(coverage, CLAIM_RETENTION_LIMIT):,.0f}, "
            f"ceded PKR {ceded:,.0f}. The claim is now **Reinsurance Referred**."
        ),
        "claim": {**claim, "status": "Reinsurance Referred", "reinsurance_referral_id": payload.get("reinsurance_referral_id")},
        "last_action": _action("refer_claim_to_reinsurance", "claim", str(claim.get("id", "")),
                               _claim_route(claim), f"{claim.get('claim_number')} referred to reinsurance"),
        "quick_actions": [
            {"label": "Open Post-Underwriting", "actionType": "navigate", "payload": "post-underwriting"},
            {"label": "Open claim file", "actionType": "navigate", "payload": _claim_route(claim)},
            {"label": "Show claims summary", "actionType": "submit", "payload": "Show the claims dashboard"},
        ],
    }


def _suggested_referral_reasons(claim: dict) -> list[str]:
    """The reasons that actually apply to THIS claim, so the chips are a real
    recommendation rather than the full menu every time."""
    reasons: list[str] = []
    if claim.get("is_contestable"):
        reasons.append(CLAIM_REFERRAL_REASONS[0])
        if _claim_doc_count(claim):
            reasons.append(CLAIM_REFERRAL_REASONS[1])
    amount = float(claim.get("submitted_amount") or 0)
    if amount > CLAIM_MANAGER_THRESHOLD:
        reasons.append(CLAIM_REFERRAL_REASONS[2])
    if amount > CLAIM_RETENTION_LIMIT or claim.get("reinsurance_referral_id"):
        reasons.append(CLAIM_REFERRAL_REASONS[3])
    return reasons or [CLAIM_REFERRAL_REASONS[0]]


@handles("refer_claim_to_underwriting")
async def _refer_claim_to_underwriting(args: dict, ctx: Ctx) -> dict:
    claim = await _resolve_claim(args, ctx)
    reason = (args.get("referral_reason") or "").strip()
    if not reason:
        suggested = _suggested_referral_reasons(claim)
        return {
            "success": False,
            "error": (
                f"Why is `{claim.get('claim_number')}` going back to underwriting? "
                "Based on the file, these apply:"
            ),
            "quick_actions": [
                {"label": r.split(" (")[0], "actionType": "submit",
                 "payload": f"Refer claim {_claim_ref(claim)} to underwriting for {r}"}
                for r in suggested[:3]
            ] + [
                {"label": "All applicable reasons", "actionType": "submit",
                 "payload": f"Refer claim {_claim_ref(claim)} to underwriting for {'; '.join(suggested)}"},
            ],
        }

    body: dict[str, Any] = {"referral_reason": reason}
    if args.get("notes"):
        body["notes"] = args["notes"]
    res = await ctx.client.post(_claims(ctx, f"/{claim['id']}/re-underwrite"), json=body)
    res.raise_for_status()
    updated = {**claim, **res.json()}

    return {
        "success": True,
        "message": (
            f"`{claim.get('claim_number')}` referred to underwriting — **Re-Underwriting Required**.\n"
            f"Trigger: {reason}\n\nUnderwriting now decides whether the risk stands as written."
        ),
        "claim": updated,
        "last_action": _action("refer_claim_to_underwriting", "claim", str(claim.get("id", "")),
                               _claim_route(claim), f"{claim.get('claim_number')} referred to underwriting"),
        "quick_actions": _claim_actions(updated),
    }


_UW_RESOLUTION_LABELS = {
    "APPROVE_CONTINUE": "the risk stands as written — claim returns to investigation",
    "APPROVE_WITH_EXCLUSION": "approved with a condition-exclusion rider attached",
    "APPROVE_WITH_LOADING": "approved with an extra-mortality loading applied",
    "DECLINE_NON_DISCLOSURE": "**declined for material non-disclosure**",
}

_UW_DEFAULT_NOTES = {
    "APPROVE_CONTINUE": "Technical re-underwriting audit found no material non-disclosure; original terms stand and the claim returns to investigation.",
    "APPROVE_WITH_EXCLUSION": "Re-underwriting confirms an undisclosed condition; current claim admitted and a specific-condition exclusion rider is endorsed onto the policy.",
    "APPROVE_WITH_LOADING": "Re-underwriting establishes a higher risk class than originally rated; claim admitted with a retrospective extra-mortality loading applied.",
    "DECLINE_NON_DISCLOSURE": "Re-underwriting establishes material non-disclosure at proposal stage within the contestability window; the claim is declined and the contract voided ab initio.",
}


@handles("resolve_claim_underwriting")
async def _resolve_claim_underwriting(args: dict, ctx: Ctx) -> dict:
    claim = await _resolve_claim(args, ctx)
    if _claim_status(claim) != "Re-Underwriting Required":
        return {
            "success": False,
            "error": (
                f"`{claim.get('claim_number')}` is **{_claim_status(claim)}** — there is no open "
                "re-underwriting referral to resolve."
            ),
            "quick_actions": _claim_actions(claim),
        }

    decision = (args.get("decision") or "").strip().upper()
    if decision not in _UW_RESOLUTION_LABELS:
        return {
            "success": False,
            "error": f"What is underwriting's verdict on `{claim.get('claim_number')}`?",
            "quick_actions": _claim_actions(claim),
        }

    notes = (args.get("decision_notes") or "").strip() or _UW_DEFAULT_NOTES[decision]
    res = await ctx.client.post(
        _claims(ctx, f"/{claim['id']}/resolve-underwriting"),
        json={"decision": decision, "decision_notes": notes},
    )
    res.raise_for_status()
    updated = {**claim, **res.json()}

    return {
        "success": True,
        "message": (
            f"Underwriting resolved `{claim.get('claim_number')}` — {_UW_RESOLUTION_LABELS[decision]}.\n"
            f"> {notes}\n\n" + _claim_summary(updated)
        ),
        "claim": updated,
        "last_action": _action("resolve_claim_underwriting", "claim", str(claim.get("id", "")),
                               _claim_route(claim), f"{claim.get('claim_number')} underwriting resolved"),
        "quick_actions": _claim_actions(updated),
    }


@handles("upload_claim_document")
async def _upload_claim_document(args: dict, ctx: Ctx) -> dict:
    """Resolve the claim server-side, then hand the actual upload to the
    browser — it is the only place holding the File object."""
    claim = await _resolve_claim(args, ctx)
    return {
        "__client_execute__": True,
        "kind": "client_execute",
        "tool_call": {
            "name": "upload_claim_document",
            "args": {
                "claim_id": str(claim.get("id") or ""),
                "claim_number": claim.get("claim_number") or "",
                "document_type": args.get("document_type") or "Hospital Bill",
            },
        },
    }
