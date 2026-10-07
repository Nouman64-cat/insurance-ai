"""Group Life / Group Family Takaful tools (GROUP_LIFE_PLAN.md Phase 3).

The granular tools behind the group journey (group_journey.py) and the ones the
user can call on their own: create the scheme, define benefit classes, load a
census, quote, accept, issue, record the employer's payment, and read the
scheme's status. All of it runs against the Phase 1–2 endpoints in
tenant-service (routers/organizations.py, routers/group_policies.py,
routers/group_census_upload.py); nothing here talks to a database.

Kept in its own module (isolation rule 2 of the plan) and registered by being
imported at the foot of tool_executor.py, so the handlers land in the same
`_HANDLERS` table every other tool uses.

Every handler returns the usual dict — `message`, `quick_actions`, `last_action`
— plus a few structured keys (`scheme`, `quote`, `pending_members`, …) that the
journey nodes read instead of parsing prose.
"""

from __future__ import annotations

import random
import secrets
from datetime import date, timedelta
from typing import Any, Optional

import httpx

from env_mode import is_demo
from tool_executor import ChoiceNeeded, Ctx, _action, _parse_json_arg, handles

GROUP_PLAN_CODES = ("GROUP_LIFE", "GROUP_LIFE_SME", "GROUP_FAMILY_TAKAFUL")
DEFAULT_DEMO_EMPLOYEES = 12
_ACTIVE_BLOCKING = {"Pending", "Proposed", "Quoted", "Accepted", "PendingPayment", "Declined"}


# ═══════════════════════════════════════════════════════════════════════════
# Small helpers
# ═══════════════════════════════════════════════════════════════════════════

def _pkr(value: Any) -> str:
    try:
        return f"PKR {float(value):,.0f}"
    except (TypeError, ValueError):
        return "PKR —"


def _word(business_type: Optional[str]) -> str:
    """Takaful pays a contribution, not a premium."""
    return "contribution" if business_type == "Takaful" else "premium"


def _org_route(org_id: str, tab: Optional[str] = None) -> str:
    return f"admin/organizations/{org_id}" + (f"?tab={tab}" if tab else "")


def _gurl(ctx: Ctx, org_id: str, mp_id: str, tail: str = "") -> str:
    return ctx.tsvc(f"/organizations/{org_id}/master-policies/{mp_id}{tail}")


def _error_text(resp: httpx.Response) -> str:
    """A plain sentence from a failed tenant-service call, including the
    structured detail the quote endpoint returns for undecided members."""
    try:
        detail = resp.json().get("detail")
    except Exception:  # noqa: BLE001
        detail = None
    if isinstance(detail, dict):
        if detail.get("pending_members"):
            names = ", ".join(detail["pending_members"][:8])
            more = len(detail["pending_members"]) - 8
            return f"{detail.get('message', 'Members are awaiting an underwriting decision.')} ({names}{f' and {more} more' if more > 0 else ''})"
        if detail.get("errors") or detail.get("missing_fields"):
            return _census_problems(detail)
        return str(detail.get("message") or detail)
    if isinstance(detail, list):
        return "; ".join((d.get("msg") or str(d)).replace("Value error, ", "") if isinstance(d, dict) else str(d) for d in detail)
    return str(detail or f"The platform returned {resp.status_code}.")


def _census_problems(result: dict, limit: int = 8) -> str:
    lines = list(result.get("missing_fields") or []) + list(result.get("errors") or [])
    shown = lines[:limit]
    extra = len(lines) - len(shown)
    return "; ".join(shown) + (f"; …and {extra} more" if extra > 0 else "")


# ═══════════════════════════════════════════════════════════════════════════
# Resolving the organization / scheme
# ═══════════════════════════════════════════════════════════════════════════

async def find_organization(args: dict, ctx: Ctx) -> Optional[dict]:
    """The organization the user means, by id or (case-insensitive) name.
    None when there is no such organization; ChoiceNeeded when several match."""
    res = await ctx.client.get(ctx.tsvc("/organizations"))
    res.raise_for_status()
    orgs = res.json()
    wanted_id = (args.get("organization_id") or "").strip()
    if wanted_id:
        return next((o for o in orgs if str(o.get("id")) == wanted_id), None)
    current = getattr(ctx.exec_ctx, "current_org_id", None)
    name = (args.get("organization_name") or args.get("name") or "").strip().lower()
    if not name:
        # "upload the census" with no company named means the one this conversation is working on.
        working_on = next((o for o in orgs if current and str(o.get("id")) == str(current)), None)
        if working_on is not None:
            return working_on
        raise LookupError("Which organization? Give me the company name.")
    exact = [o for o in orgs if (o.get("name") or "").strip().lower() == name]
    if len(exact) == 1:
        return exact[0]
    matches = exact or [o for o in orgs if name in (o.get("name") or "").lower()]
    if len(matches) == 1:
        return matches[0]
    # Several companies share this name. The one being worked on in this conversation is the answer.
    working_on = next((o for o in matches if current and str(o.get("id")) == str(current)), None)
    if working_on is not None:
        return working_on
    if len(matches) > 1:
        raise ChoiceNeeded(
            f"More than one organization matches “{args.get('organization_name') or args.get('name')}”. Which one?",
            # Same-named organizations need telling apart: a short slice of the id (not the whole thing) in the label.
            [{"label": f"{o['name']} · #{str(o['id'])[:8]}", "actionType": "submit",
              "payload": f"Use organization {o['name']} (id {o['id']})"} for o in matches[:6]],
        )
    return None


async def require_organization(args: dict, ctx: Ctx) -> dict:
    org = await find_organization(args, ctx)
    if org is None:
        label = args.get("organization_name") or args.get("name") or args.get("organization_id")
        raise ChoiceNeeded(
            f"I couldn't find an organization called “{label}”.",
            [{"label": f"Create {label}", "actionType": "submit",
              "payload": f"Start a group scheme for {label} and create the organization"},
             {"label": "Show organizations", "actionType": "navigate", "payload": "admin/organizations"}]
            if label else [{"label": "Show organizations", "actionType": "navigate", "payload": "admin/organizations"}],
        )
    return org


async def list_schemes(org_id: str, ctx: Ctx) -> list[dict]:
    res = await ctx.client.get(ctx.tsvc(f"/organizations/{org_id}/master-policies"))
    res.raise_for_status()
    return sorted(res.json(), key=lambda m: m.get("created_at") or "", reverse=True)


async def find_scheme(org: dict, args: dict, ctx: Ctx) -> Optional[dict]:
    """The scheme to work on: the one named by id, else the organization's newest."""
    schemes = await list_schemes(org["id"], ctx)
    wanted = (args.get("master_policy_id") or "").strip()
    if wanted:
        return next((m for m in schemes if str(m.get("id")) == wanted), None)
    return schemes[0] if schemes else None


async def require_scheme(args: dict, ctx: Ctx) -> tuple[dict, dict]:
    org = await require_organization(args, ctx)
    mp = await find_scheme(org, args, ctx)
    if mp is None:
        raise ChoiceNeeded(
            f"**{org['name']}** has no group scheme yet.",
            [{"label": "Start the group scheme", "actionType": "submit",
              "payload": f"Start a group scheme for {org['name']}"}],
        )
    return org, mp


async def scheme_snapshot(org: dict, mp: dict, ctx: Ctx) -> dict:
    """One read of everything the journey and the status tool need to decide
    what comes next."""
    org_id, mp_id = org["id"], mp["id"]
    classes_res = await ctx.client.get(_gurl(ctx, org_id, mp_id, "/benefit-classes"))
    classes_res.raise_for_status()
    members_res = await ctx.client.get(_gurl(ctx, org_id, mp_id, "/members"))
    members_res.raise_for_status()
    quotes_res = await ctx.client.get(_gurl(ctx, org_id, mp_id, "/quotes"))
    quotes_res.raise_for_status()

    members = members_res.json()
    quotes = quotes_res.json()
    active = [m for m in members if m.get("status") != "Removed"]
    return {
        "organization_id": org_id,
        "organization_name": org.get("name"),
        "master_policy_id": mp_id,
        "status": mp.get("status"),
        "plan_code": mp.get("plan_code"),
        "plan_label": mp.get("plan_label"),
        "business_type": mp.get("business_type") or "Conventional",
        "policy_number": mp.get("policy_number"),
        "effective_date": mp.get("effective_date"),
        "expiry_date": mp.get("expiry_date"),
        "free_cover_limit": mp.get("free_cover_limit"),
        "classes": [c.get("name") for c in classes_res.json()],
        "member_count": len(active),
        "pending_members": [m["name"] for m in active if m.get("underwriting_basis") == "Pending"],
        "missing_nominations": [m["name"] for m in active if not m.get("nominations")],
        "total_cover": sum(float(m.get("coverage_amount") or 0) for m in active),
        "quote": quotes[0] if quotes else None,          # newest first
        "accepted_quote": next((q for q in quotes if q.get("status") == "Accepted"), None),
    }


def next_step_chips(s: dict) -> list[dict]:
    """The one or two clicks that move this scheme forward from where it is."""
    org = s["organization_name"]
    status = s["status"]
    chip = lambda label, text: {"label": label, "actionType": "submit", "payload": text}  # noqa: E731
    out: list[dict] = []
    if status in ("Pending", "Proposed", "Declined") and s["member_count"] == 0:
        if not s["classes"]:
            out.append(chip("Add benefit classes", f"Add benefit classes to the group scheme for {org}"))
        out.append(chip("Upload census", f"Upload the employee census for {org}"))
        if is_demo():
            out.append(chip("Generate demo census", f"Generate a demo census for {org}"))
    elif status in ("Proposed", "Declined", "Quoted") and s["pending_members"]:
        out.append(chip("Check again", f"Check the group scheme status for {org}"))
        out.append({"label": "Open members", "actionType": "navigate", "payload": _org_route(s["organization_id"], "members")})
    elif status in ("Proposed", "Declined"):
        out.append(chip("Generate quote", f"Generate the group quote for {org}"))
    elif status == "Quoted":
        out += [chip("Accept quote", f"Accept the group quote for {org}"),
                chip("Revise quote", f"Generate a revised group quote for {org}"),
                chip("Decline quote", f"Decline the group quote for {org}")]
    elif status == "Accepted":
        out.append(chip("Issue master policy", f"Issue the group policy for {org}"))
    elif status == "PendingPayment":
        out.append(chip("Record payment", f"Record the group payment for {org}"))
    elif status == "Active":
        out.append({"label": "View members", "actionType": "navigate", "payload": _org_route(s["organization_id"], "members")})
        out.append({"label": "Endorsements", "actionType": "navigate", "payload": _org_route(s["organization_id"], "endorsements")})
    out.append({"label": "Open scheme", "actionType": "navigate", "payload": _org_route(s["organization_id"], "scheme")})
    return out[:5]


def _status_message(s: dict) -> str:
    word = _word(s["business_type"])
    lines = [f"**{s['organization_name']}** — {s.get('plan_label') or 'Group scheme'} ({s['business_type']})",
             f"- Status: **{s['status']}**" + (f" · policy no. `{s['policy_number']}`" if s.get("policy_number") else ""),
             f"- Benefit classes: {', '.join(s['classes']) if s['classes'] else 'none yet'}",
             f"- Members: {s['member_count']}" + (f" · total cover {_pkr(s['total_cover'])}" if s["member_count"] else "")]
    if s.get("free_cover_limit") is not None:
        lines.append(f"- Free Cover Limit: {_pkr(s['free_cover_limit'])}")
    if s["pending_members"]:
        lines.append(f"- Awaiting an underwriting decision: {', '.join(s['pending_members'][:6])}"
                     + (f" and {len(s['pending_members']) - 6} more" if len(s["pending_members"]) > 6 else ""))
    q = s.get("quote")
    if q:
        lines.append(f"- Latest quote: v{q['version']} **{q['status']}** — annual {word} {_pkr(q['total_premium'])}")
    if s["status"] == "Active" and s["missing_nominations"]:
        lines.append(f"- {len(s['missing_nominations'])} member(s) have no nominee recorded yet.")
    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════════════════
# Demo templates (demo mode only — callers gate on is_demo())
# ═══════════════════════════════════════════════════════════════════════════

# Covers sit below the smallest Free Cover Limit a demo-sized group can get
# (1,000,000 × size factor × age factor ≥ 0.6M for the ages generated below), so a
# demo scheme is guaranteed-issue end to end and never calls the risk engine.
def demo_benefit_classes(above_fcl: bool = False) -> list[dict]:
    classes = [
        {"name": "Management", "basis": "Flat", "flat_amount": 600_000, "grades": ["M1", "M2"]},
        {"name": "Staff", "basis": "SalaryMultiple", "salary_multiple": 12, "max_cover": 450_000, "is_default": True},
        {"name": "Support", "basis": "Flat", "flat_amount": 300_000, "grades": ["S1"]},
    ]
    if above_fcl:
        classes.append({"name": "Executive", "basis": "Flat", "flat_amount": 3_000_000, "grades": ["E1"]})
    return classes


_FIRST = ["Ayesha", "Bilal", "Hira", "Usman", "Sana", "Imran", "Maryam", "Hamza", "Zainab", "Faisal", "Nida", "Kamran",
          "Rabia", "Tariq", "Sadia", "Adeel", "Mehwish", "Junaid", "Farah", "Salman", "Amna", "Danish", "Iqra", "Shahid",
          "Komal", "Yasir", "Bushra", "Naveed", "Laiba", "Omar", "Anum", "Rizwan", "Saima", "Asad", "Mahnoor", "Fahad"]
_LAST = ["Khan", "Ahmed", "Malik", "Hussain", "Raza", "Sheikh", "Qureshi", "Siddiqui", "Butt", "Chaudhry", "Mirza", "Baig",
         "Ansari", "Javed", "Rana", "Farooq", "Iqbal", "Naqvi", "Abbasi", "Gill", "Shah", "Bhatti", "Memon", "Lodhi"]
_ROLES = [("Accountant", "Accountant"), ("Software Engineer", "Software Engineer"), ("HR Executive", "Clerk"),
          ("Sales Officer", "Sales Executive"), ("Operations Analyst", "Analyst"), ("Customer Support Agent", "Clerk"),
          ("Marketing Executive", "Marketing Executive"), ("Procurement Officer", "Clerk")]
_RNG = random.SystemRandom()


def _random_cnic(used: set[str]) -> str:
    while True:
        digits = f"{_RNG.choice('1234567')}{''.join(_RNG.choices('0123456789', k=12))}"
        cnic = f"{digits[:5]}-{digits[5:12]}-{digits[12]}"
        if cnic not in used:
            used.add(cnic)
            return cnic


def generate_demo_census(count: int, classes: list[str], above_fcl: int = 0, used_cnics: Optional[set[str]] = None) -> list[dict]:
    """Random employees — different names, CNICs, ages and pay on every call.
    Ages are 24–52 and skew younger so the group's average age keeps a demo
    scheme on the higher Free Cover Limit band. Only classes the scheme actually
    has are assigned; `above_fcl` senior staff go to Executive when it exists."""
    used = used_cnics if used_cnics is not None else set()
    today = date.today()
    has = set(classes)
    rows: list[dict] = []
    seniors = min(above_fcl, count) if "Executive" in has else 0
    for i in range(count):
        grade = "E1" if i < seniors else _RNG.choices(["M1", "M2", "S1", None], weights=[1, 1, 2, 6])[0]
        cls = {"E1": "Executive", "M1": "Management", "M2": "Management", "S1": "Support"}.get(grade, "Staff")
        if cls not in has:
            cls, grade = None, None
        monthly = _RNG.randrange(180_000, 320_000, 5_000) if cls == "Executive" else \
            _RNG.randrange(120_000, 220_000, 5_000) if cls == "Management" else _RNG.randrange(45_000, 140_000, 2_500)
        age = int(min(52, max(24, _RNG.gauss(34, 7))))
        dob = today - timedelta(days=age * 365 + _RNG.randrange(0, 364))
        role, occupation = _RNG.choice(_ROLES)
        rows.append({
            "cnic": _random_cnic(used),
            "name": f"{_RNG.choice(_FIRST)} {_RNG.choice(_LAST)}",
            "dob": dob.isoformat(),
            "gender": _RNG.choice(["Male", "Female"]),
            "occupation": occupation,
            "declared_income": int(monthly * 12 * _RNG.uniform(1.0, 1.15)),
            "employee_id": f"E{secrets.token_hex(2).upper()}{i + 1:02d}",
            "designation": "Director" if cls == "Executive" else "Manager" if cls == "Management" else role,
            "joining_date": (today - timedelta(days=_RNG.randrange(90, 365 * 11))).isoformat(),
            "basic_monthly_salary": monthly,
            **({"grade": grade} if grade else {}),
            **({"benefit_class": cls} if cls else {}),
        })
    return rows


# ═══════════════════════════════════════════════════════════════════════════
# Handlers
# ═══════════════════════════════════════════════════════════════════════════

def _plan_code(args: dict) -> str:
    code = (args.get("plan_code") or "").strip().upper()
    if code:
        return code
    if (args.get("business_type") or "").strip().lower() == "takaful":
        return "GROUP_FAMILY_TAKAFUL"
    return "GROUP_LIFE"


@handles("create_group_scheme")
async def _create_group_scheme(args: dict, ctx: Ctx) -> dict:
    org = await find_organization(args, ctx)
    created_org = False
    if org is None:
        if not args.get("create_if_missing"):
            org = await require_organization(args, ctx)        # raises ChoiceNeeded with a "create it" chip
        from tool_executor import _HANDLERS   # late: add_organization is registered by tool_executor itself
        made = await _HANDLERS["add_organization"]({
            "name": args.get("organization_name") or args.get("name"),
            "contact_person": args.get("contact_person"), "contact_email": args.get("contact_email"),
            "contact_phone": args.get("contact_phone"), "agent_name": args.get("agent_name"),
            "agent_id": args.get("agent_id"), "no_agent": args.get("no_agent"),
        }, ctx)
        if not made.get("success"):
            return made                                        # e.g. the "which agent owns this lead?" picker
        res = await ctx.client.get(ctx.tsvc(f"/organizations/{made['organization_id']}"))
        res.raise_for_status()
        org, created_org = res.json(), True

    existing = await find_scheme(org, args, ctx)
    if existing is not None and existing.get("status") in _ACTIVE_BLOCKING and not args.get("new_scheme"):
        return {
            "success": True, "attached": True, "organization_id": org["id"], "organization_name": org["name"],
            "master_policy_id": existing["id"], "master_policy": existing, "created_organization": created_org,
            "message": f"**{org['name']}** already has a group scheme in progress (**{existing['status']}**) — continuing with that one.",
            "quick_actions": [{"label": "Check status", "actionType": "submit", "payload": f"Check the group scheme status for {org['name']}"}],
        }

    plan_code = _plan_code(args)
    if plan_code not in GROUP_PLAN_CODES:
        return {"success": False, "error": f"{plan_code} isn't a group plan. Choose one of: {', '.join(GROUP_PLAN_CODES)}."}
    payload = {
        "plan_code": plan_code,
        "sum_assured_multiple": float(args.get("sum_assured_multiple") or 24),
        "term_years": int(args.get("term_years") or 1),
        "effective_date": args.get("effective_date") or date.today().isoformat(),
    }
    res = await ctx.client.post(ctx.tsvc(f"/organizations/{org['id']}/master-policies"), json=payload)
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    mp = res.json()
    route = _org_route(org["id"], "scheme")
    return {
        "success": True, "organization_id": org["id"], "organization_name": org["name"],
        "master_policy_id": mp["id"], "master_policy": mp, "created_organization": created_org,
        "message": (f"Created organization **{org['name']}** and a " if created_org else f"Created a ")
                   + f"**{mp.get('plan_label') or plan_code}** scheme ({mp.get('business_type') or 'Conventional'}), "
                     f"{payload['term_years']}-year term from {payload['effective_date']}.",
        "last_action": _action("create_group_scheme", "organization", org["id"], route, f"Group scheme for {org['name']}"),
        "quick_actions": [
            {"label": "Add benefit classes", "actionType": "submit", "payload": f"Add benefit classes to the group scheme for {org['name']}"},
            {"label": "Upload census", "actionType": "submit", "payload": f"Upload the employee census for {org['name']}"},
            {"label": "Open scheme", "actionType": "navigate", "payload": route},
        ],
    }


@handles("add_group_benefit_class")
async def _add_group_benefit_class(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    classes = _parse_json_arg(args.get("classes_json"), "classes_json")
    if args.get("use_demo_template"):
        if not is_demo():
            return {"success": False, "error": "The demo benefit-class template is only available in demo mode."}
        classes = demo_benefit_classes(bool(args.get("include_above_fcl")))
    elif classes is None:
        body = {k: args[k] for k in ("name", "basis", "flat_amount", "salary_multiple", "service_bands", "grades",
                                     "min_cover", "max_cover", "coverages", "is_default") if args.get(k) is not None}
        classes = [body] if body.get("name") and body.get("basis") else None
    if not classes:
        return {"success": False, "error": "Tell me the class name and basis (Flat, SalaryMultiple, ServiceBanded or LoanBalance) and its amount or multiple."}
    if isinstance(classes, dict):
        classes = [classes]

    made, skipped = [], []
    existing = {c["name"].lower() for c in (await ctx.client.get(_gurl(ctx, org["id"], mp["id"], "/benefit-classes"))).json()}
    for body in classes:
        if str(body.get("name", "")).lower() in existing:
            skipped.append(body["name"])
            continue
        res = await ctx.client.post(_gurl(ctx, org["id"], mp["id"], "/benefit-classes"), json=body)
        if res.status_code >= 400:
            return {"success": False, "error": f"Couldn't add “{body.get('name')}”: {_error_text(res)}",
                    "classes_added": made}
        made.append(res.json()["name"])
        existing.add(body["name"].lower())
    parts = []
    if made:
        parts.append(f"Added benefit class{'es' if len(made) > 1 else ''}: **{', '.join(made)}**.")
    if skipped:
        parts.append(f"Already had: {', '.join(skipped)}.")
    return {
        "success": True, "organization_id": org["id"], "master_policy_id": mp["id"],
        "classes_added": made, "classes_skipped": skipped,
        "message": " ".join(parts) or "No new classes to add.",
        "last_action": _action("add_group_benefit_class", "organization", org["id"], _org_route(org["id"], "classes"),
                               f"Benefit classes for {org['name']}"),
        "quick_actions": [
            {"label": "Upload census", "actionType": "submit", "payload": f"Upload the employee census for {org['name']}"},
            {"label": "Open classes", "actionType": "navigate", "payload": _org_route(org["id"], "classes")},
        ],
    }


async def _already_enrolled(org: dict, mp: dict, ctx: Ctx) -> Optional[dict]:
    """The census is the one-time enrolment of the workforce. When it is already done — typically because the
    corporate was entered in full, with its employees, in the form — don't ask for it again."""
    snap = await scheme_snapshot(org, mp, ctx)
    if not snap["member_count"]:
        return None
    return {
        "success": True, "already_enrolled": True, "enrolled": snap["member_count"], "scheme": snap,
        "message": f"**{org['name']}** already has its census — **{snap['member_count']} employees** are enrolled, so there is nothing to upload.\n"
                   + _status_message(snap),
        "quick_actions": next_step_chips(snap),
    }


@handles("submit_group_census")
async def _submit_group_census(args: dict, ctx: Ctx) -> dict:
    """Validate, then enrol, a census given as rows (or a generated demo one)."""
    org, mp = await require_scheme(args, ctx)
    done = await _already_enrolled(org, mp, ctx)
    if done is not None:
        return done
    rows = _parse_json_arg(args.get("employees_json"), "employees_json")
    demo_generated = False
    if not rows:
        if not args.get("use_demo_data"):
            return {"success": False, "error": "I need the employee rows (employees_json), a census file upload, or demo data."}
        if not is_demo():
            return {"success": False, "error": "Generated census data is only available in demo mode — upload the real census instead."}
        demo_generated = True

    base = _gurl(ctx, org["id"], mp["id"])
    classes = [c["name"] for c in (await ctx.client.get(f"{base}/benefit-classes")).json()]
    used: set[str] = set()
    count = int(args.get("employee_count") or DEFAULT_DEMO_EMPLOYEES)
    above = int(args.get("above_fcl_count") or 0)

    verdict: dict = {}
    for attempt in range(4):
        if demo_generated:
            rows = generate_demo_census(count, classes, above, used)
        res = await ctx.client.post(f"{base}/census/validate", json={"employees": rows})
        if res.status_code >= 400:
            return {"success": False, "error": _error_text(res)}
        verdict = res.json()
        # A random CNIC can in theory collide with an existing customer; draw again.
        if verdict.get("is_valid") or not (demo_generated and verdict.get("duplicate_cnics")):
            break
    if not verdict.get("is_valid"):
        problems = _census_problems(verdict)
        return {
            "success": False, "census_invalid": True, "census_errors": (verdict.get("missing_fields") or []) + (verdict.get("errors") or []),
            "error": f"The census has problems and nothing was enrolled: {problems}",
            "quick_actions": [{"label": "Upload corrected census", "actionType": "submit", "payload": f"Upload the employee census for {org['name']}"},
                              {"label": "Open members", "actionType": "navigate", "payload": _org_route(org["id"], "members")}],
        }

    res = await ctx.client.post(f"{base}/census/confirm", json={"employees": rows})
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    result = res.json()
    employees = result.get("employees") or []
    reused = sum(1 for e in employees if e.get("reused_existing_customer"))
    mp_now = next((m for m in await list_schemes(org["id"], ctx) if m["id"] == mp["id"]), mp)   # status / FCL moved
    snap = await scheme_snapshot(org, mp_now, ctx)
    msg = (f"Enrolled **{len(employees)}** employees" + (" (demo data)" if demo_generated else "") +
           f". Free Cover Limit {_pkr(result.get('free_cover_limit'))}"
           + (f"; {reused} already existed as customers and were linked, not duplicated" if reused else "") + ".")
    if snap["pending_members"]:
        msg += f"\n{len(snap['pending_members'])} member(s) are above the Free Cover Limit and need an underwriting decision before a quote."
    return {
        "success": True, "enrolled": len(employees), "free_cover_limit": result.get("free_cover_limit"),
        "scheme": snap, "pending_members": snap["pending_members"], "message": msg,
        "last_action": _action("submit_group_census", "organization", org["id"], _org_route(org["id"], "members"),
                               f"{len(employees)} employees enrolled for {org['name']}"),
        "quick_actions": next_step_chips(snap),
    }


@handles("upload_group_census")
async def _upload_group_census(args: dict, ctx: Ctx) -> dict:
    """Resolve the scheme server-side, then hand the file picker to the browser
    with real ids — the browser holds the file, and can't turn a company name
    into a master policy id."""
    org, mp = await require_scheme(args, ctx)
    done = await _already_enrolled(org, mp, ctx)
    if done is not None:
        return done
    return {
        "__client_execute__": True,
        "kind": "client_execute",
        "tool_call": {
            "name": "upload_group_census",
            "args": {"organization_id": org["id"], "organization_name": org["name"], "master_policy_id": mp["id"],
                     "confirm": args.get("confirm", True)},
        },
    }


@handles("get_group_scheme_status")
async def _get_group_scheme_status(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    snap = await scheme_snapshot(org, mp, ctx)
    return {"success": True, "scheme": snap, "message": _status_message(snap), "quick_actions": next_step_chips(snap)}


@handles("list_group_members")
async def _list_group_members(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    res = await ctx.client.get(_gurl(ctx, org["id"], mp["id"], "/members"))
    res.raise_for_status()
    members = [m for m in res.json() if m.get("status") != "Removed"]
    limit = int(args.get("limit") or 15)
    head = [f"- {m['name']} — {m.get('benefit_class') or 'Standard'} · {_pkr(m['coverage_amount'])}"
            + (f" · `{m['certificate_number']}`" if m.get("certificate_number") else "")
            + (f" · {m['underwriting_basis']}" if m.get("underwriting_basis") not in (None, "Guaranteed") else "")
            for m in members[:limit]]
    more = len(members) - len(head)
    return {
        "success": True, "member_count": len(members),
        "message": f"**{org['name']}** has **{len(members)}** members.\n" + "\n".join(head) + (f"\n…and {more} more." if more > 0 else ""),
        "quick_actions": [{"label": "Open members", "actionType": "navigate", "payload": _org_route(org["id"], "members")}],
    }


async def _quote_result(org: dict, mp: dict, quote: dict, ctx: Ctx, headline: str) -> dict:
    word = _word(quote.get("business_type"))
    lines = [headline,
             f"- {quote['member_count']} members" + (f" + {quote['dependent_count']} dependants" if quote.get("dependent_count") else "")
             + f" · total sum assured {_pkr(quote['total_sum_assured'])}",
             f"- Rate: PKR {quote['rate_per_mille']:g} per 1,000 sum assured",
             f"- Risk {word}: {_pkr(quote['risk_premium'])} · policy fee {_pkr(quote['policy_fee'])} · stamp duty {_pkr(quote['stamp_duty'])}",
             f"- **Annual {word}: {_pkr(quote['total_premium'])}** (valid until {quote['valid_until']})"]
    if quote.get("wakala_fee_pct") is not None:
        lines.append(f"- Wakala fee ({quote['wakala_fee_pct']:g}%): {_pkr(quote['wakala_fee'])} · "
                     f"Participants' Takaful Fund: {_pkr(quote['ptf_allocation'])}")
    if quote.get("breakdown", {}).get("adjusted_members"):
        lines.append(f"- {len(quote['breakdown']['adjusted_members'])} member(s) carry underwriting adjustments (loading or restricted cover).")
    snap = await scheme_snapshot(org, {**mp, "status": "Quoted"}, ctx)
    return {"success": True, "quote": quote, "scheme": snap, "message": "\n".join(lines),
            "last_action": _action("generate_group_quote", "organization", org["id"], _org_route(org["id"], "quote"),
                                   f"Group quote v{quote['version']} for {org['name']}"),
            "quick_actions": next_step_chips(snap)}


@handles("generate_group_quote")
async def _generate_group_quote(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    res = await ctx.client.post(_gurl(ctx, org["id"], mp["id"], "/quotes"))
    if res.status_code >= 400:
        pending = []
        try:
            pending = (res.json().get("detail") or {}).get("pending_members") or []
        except Exception:  # noqa: BLE001
            pass
        out = {"success": False, "error": _error_text(res), "pending_members": pending}
        if pending:
            out["quick_actions"] = [
                {"label": "Check again", "actionType": "submit", "payload": f"Check the group scheme status for {org['name']}"},
                {"label": "Open members", "actionType": "navigate", "payload": _org_route(org["id"], "members")}]
        return out
    quote = res.json()
    return await _quote_result(org, mp, quote, ctx,
                               f"Quote **v{quote['version']}** for **{org['name']}** is ready"
                               + (" (the previous one is superseded)." if quote["version"] > 1 else "."))


async def _open_quote(org: dict, mp: dict, ctx: Ctx) -> Optional[dict]:
    res = await ctx.client.get(_gurl(ctx, org["id"], mp["id"], "/quotes"))
    res.raise_for_status()
    return next((q for q in res.json() if q.get("status") == "Open"), None)


@handles("accept_group_quote")
async def _accept_group_quote(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    quote = await _open_quote(org, mp, ctx)
    if quote is None:
        return {"success": False, "error": "There's no open quote to accept — generate one first.",
                "quick_actions": [{"label": "Generate quote", "actionType": "submit", "payload": f"Generate the group quote for {org['name']}"}]}
    res = await ctx.client.post(_gurl(ctx, org["id"], mp["id"], f"/quotes/{quote['id']}/accept"), json={
        "decided_by": args.get("decided_by") or "Recorded in chat by an administrator", "notes": args.get("notes")})
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    snap = await scheme_snapshot(org, {**mp, "status": "Accepted"}, ctx)
    return {"success": True, "quote": res.json(), "scheme": snap,
            "message": f"Quote v{quote['version']} accepted for **{org['name']}** — annual {_word(quote.get('business_type'))} "
                       f"{_pkr(quote['total_premium'])}. Next: issue the master policy.",
            "last_action": _action("accept_group_quote", "organization", org["id"], _org_route(org["id"], "quote"),
                                   f"Quote accepted for {org['name']}"),
            "quick_actions": next_step_chips(snap)}


@handles("decline_group_quote")
async def _decline_group_quote(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    quote = await _open_quote(org, mp, ctx)
    if quote is None:
        return {"success": False, "error": "There's no open quote to decline."}
    res = await ctx.client.post(_gurl(ctx, org["id"], mp["id"], f"/quotes/{quote['id']}/decline"), json={
        "decided_by": args.get("decided_by") or "Recorded in chat by an administrator", "notes": args.get("notes")})
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    snap = await scheme_snapshot(org, {**mp, "status": "Declined"}, ctx)
    return {"success": True, "quote": res.json(), "scheme": snap,
            "message": f"Quote v{quote['version']} declined for **{org['name']}**. You can generate a revised quote any time.",
            "last_action": _action("decline_group_quote", "organization", org["id"], _org_route(org["id"], "quote"),
                                   f"Quote declined for {org['name']}"),
            "quick_actions": [{"label": "Generate revised quote", "actionType": "submit", "payload": f"Generate a revised group quote for {org['name']}"},
                              {"label": "Open scheme", "actionType": "navigate", "payload": _org_route(org["id"], "scheme")}]}


@handles("issue_group_policy")
async def _issue_group_policy(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    res = await ctx.client.post(_gurl(ctx, org["id"], mp["id"], "/issue"))
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    out = res.json()
    mp_now = out["master_policy"]
    snap = await scheme_snapshot(org, mp_now, ctx)
    word = _word(mp_now.get("business_type"))
    return {"success": True, "issued": out, "scheme": snap, "amount_due": out["amount_due"],
            "message": f"Master policy **{mp_now['policy_number']}** issued with **{out['certificates_issued']}** certificates. "
                       f"Cover starts once the employer's {word} of {_pkr(out['amount_due'])} is recorded.",
            "last_action": _action("issue_group_policy", "organization", org["id"], _org_route(org["id"], "scheme"),
                                   f"Master policy {mp_now['policy_number']} issued"),
            "quick_actions": next_step_chips(snap)}


@handles("record_group_payment")
async def _record_group_payment(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    quote = None
    snap = await scheme_snapshot(org, mp, ctx)
    quote = snap.get("accepted_quote")
    amount = args.get("amount") or (quote or {}).get("total_premium")
    if not amount:
        return {"success": False, "error": "I don't know the amount due — there's no accepted quote on this scheme."}
    reference = (args.get("reference") or "").strip()
    if not reference:
        if not is_demo():
            return {"success": False, "error": "A payment reference is required (the bank or transfer reference for the employer's payment)."}
        reference = f"DEMO-PAY-{secrets.token_hex(3).upper()}"
    res = await ctx.client.post(_gurl(ctx, org["id"], mp["id"], "/payments"), json={"reference": reference, "amount": float(amount)})
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    out = res.json()
    mp_now = out["master_policy"]
    snap = await scheme_snapshot(org, mp_now, ctx)
    return {"success": True, "paid": out, "reference": reference, "scheme": snap,
            "message": f"Payment of {_pkr(amount)} recorded (ref `{reference}`). **{org['name']}**'s scheme is now **Active** — "
                       f"{out['certificates_issued']} members are covered.",
            "last_action": _action("record_group_payment", "organization", org["id"], _org_route(org["id"], "members"),
                                   f"Group cover active for {org['name']}"),
            "quick_actions": next_step_chips(snap)}


# ═══════════════════════════════════════════════════════════════════════════
# Endorsements (GROUP_LIFE_PLAN.md Phase 4) — mid-term changes to an in-force scheme
# ═══════════════════════════════════════════════════════════════════════════

def _eurl(ctx: Ctx, org_id: str, mp_id: str, tail: str = "") -> str:
    return _gurl(ctx, org_id, mp_id, f"/endorsements{tail}")


def _effective(args: dict, mp: dict) -> str:
    """The effective date: what the user said, else today — clipped into the cover period."""
    wanted = (args.get("effective_date") or date.today().isoformat())
    start, end = mp.get("effective_date"), mp.get("expiry_date")
    if start and wanted < start:
        return start
    if end and wanted > end:
        return end
    return wanted


async def _roster(org: dict, mp: dict, ctx: Ctx) -> list[dict]:
    res = await ctx.client.get(_gurl(ctx, org["id"], mp["id"], "/members"))
    res.raise_for_status()
    return [m for m in res.json() if m.get("status") != "Removed"]


def _member_ref(roster: list[dict], query: str) -> dict:
    """One roster member from a name, CNIC or employee id; ChoiceNeeded when several match."""
    q = query.strip().lower()
    exact = [m for m in roster if q in ((m.get("cnic") or "").lower(), (m.get("employee_id") or "").lower(), m["name"].lower())]
    matches = exact or [m for m in roster if q in m["name"].lower()]
    if not matches:
        raise LookupError(f"No member matches “{query}”.")
    if len(matches) > 1:
        raise ChoiceNeeded(
            f"More than one member matches “{query}”. Which one?",
            [{"label": f"{m['name']} · {m.get('cnic') or m.get('employee_id') or ''}".strip(" ·"), "actionType": "submit",
              "payload": f"Use member {m['name']} (CNIC {m.get('cnic')})"} for m in matches[:6]],
        )
    return {"member_id": matches[0]["id"]}


def _endorsement_lines_text(lines: list[dict], limit: int = 8) -> str:
    out = []
    for l in lines[:limit]:
        b, a = (l.get("before") or {}).get("cover"), (l.get("after") or {}).get("cover")
        cover = (f"{_pkr(b)} → {_pkr(a)}" if l["action"] == "CHANGE" else _pkr(a if l["action"] == "ADD" else b))
        tail = "" if l["status"] == "Applied" else f" — **{l['status']}**"
        out.append(f"- {l['action'].title()}: {l['name']} · {cover}{tail}")
    return "\n".join(out) + (f"\n…and {len(lines) - limit} more." if len(lines) > limit else "")


def _delta_text(e: dict, business_type: Optional[str]) -> str:
    word = _word(business_type)
    amount = _pkr(abs(e["premium_delta"]))
    if abs(e["premium_delta"]) < 0.01:
        return f"No {word} change."
    return (f"Additional {word} to collect: **{amount}**" if e["premium_delta"] > 0 else f"{word.title()} to refund: **{amount}**") \
        + f" (pro rata {e['days_remaining']}/{e['period_days']} days, stamp duty included)"


def _endorsement_body(args: dict, mp: dict, kind: str, members: list[dict]) -> dict:
    return {"endorsement_type": kind, "effective_date": _effective(args, mp), "members": members,
            "reason": args.get("reason"), "requested_by": args.get("requested_by") or "Recorded in chat by an administrator"}


def _members_from_args(args: dict) -> Optional[list[dict]]:
    rows = _parse_json_arg(args.get("employees_json"), "employees_json")
    return [rows] if isinstance(rows, dict) else rows


async def _members_for(kind: str, args: dict, org: dict, mp: dict, ctx: Ctx) -> list[dict]:
    """The `members` payload for a request, built from whatever shape the tool was given."""
    if kind == "ADD":
        rows = _members_from_args(args)
        if not rows and args.get("use_demo_data"):
            if not is_demo():
                raise LookupError("Generated people are only available in demo mode — give me the real employees.")
            classes = [c["name"] for c in (await ctx.client.get(_gurl(ctx, org["id"], mp["id"], "/benefit-classes"))).json()]
            rows = generate_demo_census(int(args.get("employee_count") or 2), classes, 0)
        if not rows:
            raise LookupError("Who is joining? Give me their details (employees_json) — cnic, name, dob, gender, occupation, declared_income.")
        return rows
    roster = await _roster(org, mp, ctx)
    names = list(args.get("member_names") or [])
    if args.get("member_name"):
        names.append(args["member_name"])
    names += [c for c in (args.get("cnics") or [])]
    if not names:
        raise LookupError("Which member(s)? Give me their names or CNICs.")
    refs = [_member_ref(roster, n) for n in names]
    if kind == "CHANGE":
        change = {k: args[k] for k in ("basic_monthly_salary", "grade", "designation", "benefit_class", "employee_id", "joining_date")
                  if args.get(k) not in (None, "")}
        if args.get("new_salary") not in (None, ""):
            change["basic_monthly_salary"] = args["new_salary"]
        return [{**r, **change} for r in refs]
    return [{**r, "reason": args.get("reason")} for r in refs]


async def _endorse(kind: str, args: dict, ctx: Ctx, *, preview: bool) -> dict:
    org, mp = await require_scheme(args, ctx)
    members = await _members_for(kind, args, org, mp, ctx)
    body = _endorsement_body(args, mp, kind, members)
    res = await ctx.client.post(_eurl(ctx, org["id"], mp["id"], "/preview" if preview else ""), json=body)
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    e = res.json()
    btype = mp.get("business_type")
    tab = _org_route(org["id"], "endorsements")
    if preview:
        pend = [l for l in e["lines"] if l["status"] != "Applied"]
        return {
            "success": True, "preview": e,
            "message": f"Preview of the {kind.lower()} endorsement for **{org['name']}**, effective {e['effective_date']}:\n"
                       f"{_endorsement_lines_text(e['lines'])}\n{_delta_text(e, btype)}"
                       + (f"\n{len(pend)} line(s) need an underwriting decision before they take effect." if pend else "")
                       + "\nNothing has been changed yet.",
            "quick_actions": [{"label": "Apply this endorsement", "actionType": "submit",
                               "payload": f"Go ahead and apply the {kind.lower()} endorsement for {org['name']}"}],
        }
    verb = {"ADD": "added", "DELETE": "removed", "CHANGE": "changed"}[kind]
    pend = [l for l in e["lines"] if l["status"] == "PendingUnderwriting"]
    chips = [{"label": "Open endorsements", "actionType": "navigate", "payload": tab}]
    if pend:
        chips.insert(0, {"label": "Re-check underwriting", "actionType": "submit", "payload": f"Resolve endorsement {e['number']} for {org['name']}"})
    return {
        "success": True, "endorsement": e,
        "message": f"Endorsement **{e['number']}** applied — members {verb}, effective {e['effective_date']}.\n"
                   f"{_endorsement_lines_text(e['lines'])}\n{_delta_text(e, btype)}"
                   + (f"\n{len(pend)} member(s) wait on an underwriting decision." if pend else ""),
        "last_action": _action(f"{kind.lower()}_group_endorsement", "organization", org["id"], tab, f"Endorsement {e['number']} for {org['name']}"),
        "quick_actions": chips,
    }


@handles("preview_group_endorsement")
async def _preview_group_endorsement(args: dict, ctx: Ctx) -> dict:
    kind = (args.get("endorsement_type") or "").upper()
    if kind not in ("ADD", "DELETE", "CHANGE"):
        return {"success": False, "error": "endorsement_type must be ADD, DELETE or CHANGE."}
    return await _endorse(kind, args, ctx, preview=True)


@handles("apply_group_endorsement")
async def _apply_group_endorsement(args: dict, ctx: Ctx) -> dict:
    kind = (args.get("endorsement_type") or "").upper()
    if kind not in ("ADD", "DELETE", "CHANGE"):
        return {"success": False, "error": "endorsement_type must be ADD, DELETE or CHANGE."}
    return await _endorse(kind, args, ctx, preview=False)


async def _find_endorsement(args: dict, org: dict, mp: dict, ctx: Ctx) -> dict:
    res = await ctx.client.get(_eurl(ctx, org["id"], mp["id"]))
    res.raise_for_status()
    items = res.json()
    number = (args.get("endorsement_number") or "").strip().lower()
    if number:
        found = next((e for e in items if e["number"].lower() == number or e["number"].lower().endswith(number)), None)
        if found:
            return found
        raise LookupError(f"No endorsement “{args['endorsement_number']}” on this scheme.")
    if not items:
        raise LookupError("This scheme has no endorsements yet.")
    return items[0]


@handles("list_group_endorsements")
async def _list_group_endorsements(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    res = await ctx.client.get(_eurl(ctx, org["id"], mp["id"]))
    res.raise_for_status()
    items = res.json()
    if not items:
        return {"success": True, "endorsements": [], "message": f"**{org['name']}** has no endorsements yet.",
                "quick_actions": [{"label": "Open endorsements", "actionType": "navigate", "payload": _org_route(org["id"], "endorsements")}]}
    word = _word(mp.get("business_type"))
    lines = [f"- **{e['number']}** · {e['endorsement_type'].title()} · effective {e['effective_date']} · {e['status']} · "
             f"{word} {'+' if e['premium_delta'] >= 0 else '−'}{_pkr(abs(e['premium_delta']))} · {e['settlement_status']}" for e in items[:10]]
    return {"success": True, "endorsements": items, "message": f"Endorsements for **{org['name']}**:\n" + "\n".join(lines),
            "quick_actions": [{"label": "Open endorsements", "actionType": "navigate", "payload": _org_route(org["id"], "endorsements")}]}


@handles("resolve_group_endorsement")
async def _resolve_group_endorsement(args: dict, ctx: Ctx) -> dict:
    """Apply the lines that were waiting on an underwriting decision."""
    org, mp = await require_scheme(args, ctx)
    e = await _find_endorsement(args, org, mp, ctx)
    res = await ctx.client.post(_eurl(ctx, org["id"], mp["id"], f"/{e['id']}/resolve"))
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    out = res.json()
    still = [l for l in out["lines"] if l["status"] == "PendingUnderwriting"]
    return {"success": True, "endorsement": out,
            "message": f"Endorsement **{out['number']}** is **{out['status']}**.\n{_endorsement_lines_text(out['lines'])}\n"
                       f"{_delta_text(out, mp.get('business_type'))}" + (f"\n{len(still)} still waiting on underwriting." if still else ""),
            "quick_actions": [{"label": "Open endorsements", "actionType": "navigate", "payload": _org_route(org["id"], "endorsements")}]}


@handles("settle_group_endorsement")
async def _settle_group_endorsement(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    e = await _find_endorsement(args, org, mp, ctx)
    reference = (args.get("reference") or "").strip()
    if not reference:
        if not is_demo():
            return {"success": False, "error": "A payment/refund reference is required."}
        reference = f"DEMO-END-{secrets.token_hex(3).upper()}"
    amount = args.get("amount") or abs(e["premium_delta"])
    res = await ctx.client.post(_eurl(ctx, org["id"], mp["id"], f"/{e['id']}/settle"), json={"reference": reference, "amount": float(amount)})
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    out = res.json()
    return {"success": True, "endorsement": out,
            "message": f"Endorsement **{out['number']}** settled ({_pkr(abs(out['premium_delta']))}, ref `{reference}`).",
            "quick_actions": [{"label": "Open endorsements", "actionType": "navigate", "payload": _org_route(org["id"], "endorsements")}]}


# ═══════════════════════════════════════════════════════════════════════════
# Renewals, claims and the Takaful fund (GROUP_LIFE_PLAN.md Phases 5–6)
# ═══════════════════════════════════════════════════════════════════════════

def _rurl(ctx: Ctx, org_id: str, mp_id: str, tail: str = "") -> str:
    return _gurl(ctx, org_id, mp_id, f"/renewals{tail}")


def _renewal_text(r: dict, business_type: Optional[str]) -> str:
    word = _word(business_type)
    exp = r.get("experience") or {}
    lines = [f"Renewal for **{r['new_period_start']} → {r['new_period_end']}** is **{r['status']}**."]
    if exp.get("claims_ratio") is not None:
        lines.append(f"Last period: {_pkr(exp.get('claims_incurred', 0))} claims on {_pkr(exp.get('premium_earned', 0))} {word} "
                     f"({exp['claims_ratio'] * 100:.0f}% loss ratio) → rate factor **{r['experience_factor']:g}x**.")
    q = (r.get("quotes") or [None])[0]
    if q:
        lines.append(f"Renewal {word}: **{_pkr(q['total_premium'])}** for {q['member_count']} members.")
    return "\n".join(lines)


async def _current_renewal(args: dict, org: dict, mp: dict, ctx: Ctx, *, open_only: bool = True) -> dict:
    res = await ctx.client.get(_rurl(ctx, org["id"], mp["id"]))
    res.raise_for_status()
    items = [r for r in res.json() if r["status"] not in ("Renewed", "Declined", "Lapsed", "Cancelled")] if open_only else res.json()
    if not items:
        raise LookupError("This scheme has no renewal in progress — start one first.")
    detail = await ctx.client.get(_rurl(ctx, org["id"], mp["id"], f"/{items[0]['id']}"))
    detail.raise_for_status()
    return detail.json()


@handles("start_group_renewal")
async def _start_group_renewal(args: dict, ctx: Ctx) -> dict:
    """Open the renewal, optionally apply a refreshed census, and price the new period."""
    org, mp = await require_scheme(args, ctx)
    tab = _org_route(org["id"], "renewals")
    res = await ctx.client.get(_rurl(ctx, org["id"], mp["id"]))
    res.raise_for_status()
    open_ones = [r for r in res.json() if r["status"] not in ("Renewed", "Declined", "Lapsed", "Cancelled")]
    if open_ones:
        renewal_id = open_ones[0]["id"]
    else:
        made = await ctx.client.post(_rurl(ctx, org["id"], mp["id"]), json={"notes": args.get("notes")})
        if made.status_code >= 400:
            return {"success": False, "error": _error_text(made)}
        renewal_id = made.json()["id"]
    refresh_note = ""
    rows = _members_from_args(args)
    if rows:
        r = await ctx.client.post(_rurl(ctx, org["id"], mp["id"], f"/{renewal_id}/census-refresh"),
                                  json={"employees": rows, "remove_missing": bool(args.get("remove_missing")), "requested_by": "Recorded in chat"})
        if r.status_code >= 400:
            return {"success": False, "error": _error_text(r)}
        refresh_note = "\nThe refreshed census was applied."
    q = await ctx.client.post(_rurl(ctx, org["id"], mp["id"], f"/{renewal_id}/quote"))
    if q.status_code >= 400:
        return {"success": False, "error": _error_text(q)}
    detail = (await ctx.client.get(_rurl(ctx, org["id"], mp["id"], f"/{renewal_id}"))).json()
    return {"success": True, "renewal": detail, "message": _renewal_text(detail, mp.get("business_type")) + refresh_note,
            "last_action": _action("start_group_renewal", "organization", org["id"], tab, f"Renewal for {org['name']}"),
            "quick_actions": [{"label": "Employer accepts", "actionType": "submit", "payload": f"Record that {org['name']} accepted the renewal"},
                              {"label": "Employer declines", "actionType": "submit", "payload": f"Record that {org['name']} declined the renewal"},
                              {"label": "Open renewals", "actionType": "navigate", "payload": tab}]}


@handles("get_group_renewal")
async def _get_group_renewal(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    r = await _current_renewal(args, org, mp, ctx, open_only=False)
    return {"success": True, "renewal": r, "message": _renewal_text(r, mp.get("business_type")),
            "quick_actions": [{"label": "Open renewals", "actionType": "navigate", "payload": _org_route(org["id"], "renewals")}]}


async def _decide_renewal(args: dict, ctx: Ctx, verb: str) -> dict:
    org, mp = await require_scheme(args, ctx)
    r = await _current_renewal(args, org, mp, ctx)
    res = await ctx.client.post(_rurl(ctx, org["id"], mp["id"], f"/{r['id']}/{verb}"),
                                json={"decided_by": args.get("decided_by") or "Recorded in chat", "notes": args.get("notes")})
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    out = res.json()
    word = _word(mp.get("business_type"))
    nxt = [{"label": "Record the payment", "actionType": "submit", "payload": f"Record the renewal {word} payment for {org['name']}"}] if verb == "accept" else []
    return {"success": True, "renewal": out,
            "message": f"Renewal for **{org['name']}** {'accepted' if verb == 'accept' else 'declined'}. "
                       + (f"The new period starts {out['new_period_start']}; cover continues once the {word} is paid." if verb == "accept"
                          else "The scheme will lapse at the end of the current period."),
            "quick_actions": nxt + [{"label": "Open renewals", "actionType": "navigate", "payload": _org_route(org["id"], "renewals")}]}


@handles("decide_group_renewal")
async def _decide_group_renewal(args: dict, ctx: Ctx) -> dict:
    verb = (args.get("decision") or "").lower()
    if verb not in ("accept", "decline"):
        return {"success": False, "error": "decision must be accept or decline."}
    return await _decide_renewal(args, ctx, verb)


@handles("record_group_renewal_payment")
async def _record_group_renewal_payment(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    r = await _current_renewal(args, org, mp, ctx)
    q = (r.get("quotes") or [None])[0]
    reference = (args.get("reference") or "").strip()
    if not reference:
        if not is_demo():
            return {"success": False, "error": "A payment reference is required."}
        reference = f"DEMO-REN-{secrets.token_hex(3).upper()}"
    amount = args.get("amount") or (q or {}).get("total_premium")
    if not amount:
        return {"success": False, "error": "There is no renewal quote to pay against yet."}
    res = await ctx.client.post(_rurl(ctx, org["id"], mp["id"], f"/{r['id']}/payments"), json={"reference": reference, "amount": float(amount)})
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    out = res.json()
    return {"success": True, "renewal": out,
            "message": f"Renewal payment of {_pkr(float(amount))} recorded (ref `{reference}`). Renewal is **{out['status']}**; the scheme now runs "
                       f"{out['new_period_start']} → {out['new_period_end']}.",
            "quick_actions": [{"label": "Open renewals", "actionType": "navigate", "payload": _org_route(org["id"], "renewals")}]}


# ── group claims ────────────────────────────────────────────────────────────

def _curl(ctx: Ctx, org_id: str, mp_id: str, tail: str = "") -> str:
    return _gurl(ctx, org_id, mp_id, f"/claims{tail}")


async def _scheme_claims(org: dict, mp: dict, ctx: Ctx) -> list[dict]:
    res = await ctx.client.get(_curl(ctx, org["id"], mp["id"]))
    res.raise_for_status()
    return res.json()["claims"]


async def _find_group_claim(args: dict, org: dict, mp: dict, ctx: Ctx) -> dict:
    claims = await _scheme_claims(org, mp, ctx)
    number = (args.get("claim_number") or "").strip().lower()
    who = (args.get("member_name") or "").strip().lower()
    if number:
        found = next((c for c in claims if (c.get("claim_number") or "").lower() == number), None)
        if found:
            return found
        raise LookupError(f"No claim “{args['claim_number']}” on this scheme.")
    matches = [c for c in claims if who and who in ((c.get("member") or "").lower())] if who else claims
    if not matches:
        raise LookupError("No matching claim on this scheme.")
    if len(matches) > 1:
        raise ChoiceNeeded("Which claim?", [{"label": f"{c['claim_number']} · {c.get('member')} · {c['claim_type']} · {c['status']}", "actionType": "submit",
                                             "payload": f"Use claim {c['claim_number']}"} for c in matches[:6]])
    return matches[0]


@handles("register_group_claim")
async def _register_group_claim(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    roster = await _roster(org, mp, ctx)
    if not args.get("member_name"):
        raise LookupError("Whose claim is it? Give me the member's name or CNIC.")
    member = _member_ref(roster, args["member_name"])
    full = next(m for m in roster if m["id"] == member["member_id"])
    body = {"member_id": member["member_id"], "claim_type": args.get("claim_type") or "Death Claim", "coverage_type": args.get("coverage_type"),
            "submitted_amount": float(args["submitted_amount"]) if args.get("submitted_amount") else float(full.get("coverage_amount") or 0),
            "incident_date": args.get("incident_date"), "notes": args.get("notes")}
    if args.get("dependent_name"):
        detail = await ctx.client.get(_gurl(ctx, org["id"], mp["id"], f"/members/{member['member_id']}/dependents"))
        if detail.status_code < 400:
            deps = [d for d in detail.json() if args["dependent_name"].lower() in d["name"].lower()]
            if not deps:
                return {"success": False, "error": f"{full['name']} has no dependant called “{args['dependent_name']}”."}
            body["dependent_id"] = deps[0]["id"]
    if body["submitted_amount"] <= 0:
        return {"success": False, "error": "What amount is being claimed?"}
    res = await ctx.client.post(_curl(ctx, org["id"], mp["id"]), json=body)
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    out = res.json()
    c, g = out["claim"], out["group"]
    missing = g.get("missing_documents") or []
    return {"success": True, "claim": c, "group": g,
            "message": f"Registered **{c['claim_number']}** for {full['name']} ({body['claim_type']}, {_pkr(body['submitted_amount'])}).\n"
                       + (f"Documents still needed: {', '.join(missing)}." if missing else "All required documents are on file."),
            "last_action": _action("register_group_claim", "claim", c["id"], f"claims/{c['id']}", f"Claim {c['claim_number']}"),
            "quick_actions": [{"label": "Open claims", "actionType": "navigate", "payload": _org_route(org["id"], "claims")}]}


@handles("list_group_claims")
async def _list_group_claims(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    res = await ctx.client.get(_curl(ctx, org["id"], mp["id"]))
    res.raise_for_status()
    data = res.json()
    s = data["summary"]
    lines = [f"- `{c['claim_number']}` {c.get('member')} · {c['claim_type']} · {_pkr(c['submitted_amount'])} · {c['status']}" for c in data["claims"][:10]]
    return {"success": True, **data, "message": f"**{org['name']}** has {s['count']} claim(s), {s['open']} open; paid {_pkr(s['paid'])}.\n" + "\n".join(lines),
            "quick_actions": [{"label": "Open claims", "actionType": "navigate", "payload": _org_route(org["id"], "claims")}]}


def _split_text(split: dict) -> str:
    rows = [f"- {s['payee_name']} ({s.get('relationship') or 'payee'}) · {s['share_pct']:g}% · {_pkr(s['amount'])}"
            + (" · minor — paid to guardian " + s["guardian_name"] if s.get("is_minor") and s.get("guardian_name") else "") for s in split["shares"]]
    return "\n".join(rows + [f"⚠ {w}" for w in split.get("warnings") or []])


@handles("preview_group_claim_payout")
async def _preview_group_claim_payout(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    claim = await _find_group_claim(args, org, mp, ctx)
    res = await ctx.client.post(ctx.tsvc(f"/claims/{claim['id']}/payout-split"), json={"amount": args.get("amount")})
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    split = res.json()
    return {"success": True, "split": split,
            "message": f"Payout split for **{claim['claim_number']}** ({_pkr(split['amount'])}):\n{_split_text(split)}\nNothing has been paid.",
            "quick_actions": [{"label": "Pay it", "actionType": "submit", "payload": f"Pay group claim {claim['claim_number']}"}]}


@handles("pay_group_claim")
async def _pay_group_claim(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    claim = await _find_group_claim(args, org, mp, ctx)
    body = {"amount": args.get("amount"), "reference_number": args.get("reference") or (f"DEMO-CLM-{secrets.token_hex(3).upper()}" if is_demo() else None),
            "confirm_no_nominee": bool(args.get("confirm_no_nominee"))}
    if not body["reference_number"]:
        return {"success": False, "error": "A bank reference for the payout is required."}
    res = await ctx.client.post(ctx.tsvc(f"/claims/{claim['id']}/group-payout"), json=body)
    if res.status_code >= 400:
        err = _error_text(res)
        if "confirm_no_nominee" in err:
            return {"success": False, "error": "There is no nominee on file, so the full amount would go to the claimant. Say “pay the claimant anyway” to confirm."}
        return {"success": False, "error": err}
    out = res.json()
    rows = "\n".join(f"- {p['payee']} · {p.get('share_pct') or 100:g}% · {_pkr(p['amount'])}" for p in out["payouts"])
    return {"success": True, "payout": out, "message": f"Claim **{out['claim_number']}** paid: {_pkr(out['total'])}.\n{rows}",
            "quick_actions": [{"label": "Open claims", "actionType": "navigate", "payload": _org_route(org["id"], "claims")}]}


# ── Takaful fund and extra coverages ────────────────────────────────────────

@handles("get_group_ptf_report")
async def _get_group_ptf_report(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    res = await ctx.client.get(_gurl(ctx, org["id"], mp["id"], "/ptf-report"))
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    rep = res.json()
    rows = [f"- {p['label']}: contributions {_pkr(p['ptf_gross'])} (Wakala {_pkr(p['wakala_fee'])}), retakaful {_pkr(p['retakaful_contribution'])}, "
            f"claims {_pkr(p['claims_incurred'])} → **{p['position']} {_pkr(abs(p['result']))}**" for p in rep["periods"]]
    return {"success": True, "report": rep, "message": f"Participants' Takaful Fund for **{org['name']}**:\n" + "\n".join(rows) + f"\n{rep['note']}",
            "quick_actions": [{"label": "Open scheme", "actionType": "navigate", "payload": _org_route(org["id"], "scheme")}]}


@handles("add_group_class_coverage")
async def _add_group_class_coverage(args: dict, ctx: Ctx) -> dict:
    org, mp = await require_scheme(args, ctx)
    classes = (await ctx.client.get(_gurl(ctx, org["id"], mp["id"], "/benefit-classes"))).json()
    name = (args.get("class_name") or "").strip().lower()
    cls = next((c for c in classes if c["name"].lower() == name), None) or (classes[0] if len(classes) == 1 and not name else None)
    if cls is None:
        raise LookupError("Which benefit class? " + ", ".join(c["name"] for c in classes))
    body = {"coverage_type": args["coverage_type"], "percent_of_base": float(args["percent_of_base"]),
            "max_amount": float(args["max_amount"]) if args.get("max_amount") else None}
    res = await ctx.client.post(_gurl(ctx, org["id"], mp["id"], f"/benefit-classes/{cls['id']}/coverages"), json=body)
    if res.status_code >= 400:
        return {"success": False, "error": _error_text(res)}
    return {"success": True, "benefit_class": res.json(),
            "message": f"Added {body['coverage_type']} ({body['percent_of_base']:g}% of life cover) to **{cls['name']}**. Any open quote was withdrawn — generate a new one.",
            "quick_actions": [{"label": "Re-quote", "actionType": "submit", "payload": f"Generate a new quote for {org['name']}"}]}
