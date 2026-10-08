"""Group-scheme journey (GROUP_LIFE_PLAN.md Phase 3) against an in-memory
stand-in for the tenant-service group API.

The real graph edges and routing functions are exercised: `register_group_journey`
is attached to a fresh StateGraph (with a stub `agent` node where g_finish hands
back), and the nodes run the real group tools through `execute_tool`. Only the
HTTP layer is faked, so this needs no database, no LLM and no running services.

Run with:  docker compose exec chat-agent python test_group_journey.py
      or:  python -m pytest services/chat-agent/test_group_journey.py -q
"""

from __future__ import annotations

import asyncio
import functools
import json
import os
import re
import uuid
from contextlib import contextmanager

from langgraph.graph import END, START, StateGraph

import group_journey
import group_tools
import permission
import tool_executor
from state import ChatState

TENANT = "00000000-0000-0000-0000-0000000000aa"
BASE = f"http://tenant-service:8001/tenants/{TENANT}"


# ═══════════════════════════════════════════════════════════════════════════
# In-memory tenant-service
# ═══════════════════════════════════════════════════════════════════════════

class _Resp:
    def __init__(self, status_code: int, body):
        self.status_code, self._body = status_code, body

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            import httpx
            raise httpx.HTTPStatusError("error", request=None, response=self)  # type: ignore[arg-type]


class FakeTenantService:
    """Just enough of /organizations/**/master-policies/** to drive the journey —
    same status machine and status codes as routers/group_policies.py."""

    def __init__(self):
        self.orgs: dict = {}
        self.schemes: dict = {}
        self.classes: dict = {}
        self.members: dict = {}
        self.quotes: dict = {}
        self.endorsements: dict = {}
        self.renewals: dict = {}
        self.fail_paths: set = set()          # paths ending in one of these answer 500
        self.claims: dict = {}
        self.calls: list[tuple[str, str]] = []
        self.fcl = 1_000_000.0

    # -- helpers the tests use to play the human parts --------------------------
    def add_org(self, name: str) -> str:
        oid = str(uuid.uuid4())
        self.orgs[oid] = {"id": oid, "name": name}
        return oid

    def decide_pending(self):
        for rows in self.members.values():
            for m in rows:
                if m["underwriting_basis"] == "Pending":
                    m["underwriting_basis"] = "Approved"

    def only_scheme(self) -> dict:
        return next(iter(self.schemes.values()))

    def _endorsements(self, mid, mp, method, tail, body):
        store = self.endorsements.setdefault(mid, [])
        if mp["status"] != "Active":
            return _Resp(409, {"detail": f"Endorsements change a scheme that is in force; this one is {mp['status']}."})
        if tail == "/endorsements/preview" or (tail == "/endorsements" and method == "POST"):
            kind, members = body["endorsement_type"], body["members"]
            lines, roster = [], {m["id"]: m for m in self.members[mid]}
            for ref in members:
                if kind == "ADD":
                    lines.append({"action": "ADD", "name": ref["name"], "status": "Applied", "before": {"cover": None}, "after": {"cover": 450000}, "risk_delta": 1000.0})
                else:
                    m = roster.get(ref.get("member_id"))
                    if m is None:
                        return _Resp(404, {"detail": "No member of this scheme matches."})
                    after = {"cover": m["coverage_amount"] * 2} if kind == "CHANGE" else {"cover": 0}
                    lines.append({"action": kind, "name": m["name"], "status": "Applied", "before": {"cover": m["coverage_amount"]}, "after": after,
                                  "risk_delta": 1500.0 if kind == "CHANGE" else -2000.0})
            risk = sum(l["risk_delta"] for l in lines)
            e = {"id": str(uuid.uuid4()), "number": f"END-{mp['policy_number']}-{len(store) + 1:03d}", "endorsement_type": kind,
                 "status": "Applied", "effective_date": body["effective_date"], "lines": lines, "days_remaining": 90, "period_days": 365,
                 "pro_rata_factor": 0.25, "risk_delta": risk, "stamp_duty_delta": round(risk * .01, 2), "premium_delta": round(risk * 1.01, 2),
                 "settlement_status": "Due", "settlement_reference": None}
            if tail.endswith("/preview"):
                return _Resp(200, e)
            store.insert(0, e)
            return _Resp(201, e)
        if method == "GET" and tail == "/endorsements":
            return _Resp(200, store)
        m = re.fullmatch(r"/endorsements/([^/]+)/(resolve|settle)", tail)
        if m:
            e = next(x for x in store if x["id"] == m.group(1))
            if m.group(2) == "settle":
                if abs(body["amount"] - abs(e["premium_delta"])) > 0.01:
                    return _Resp(422, {"detail": "Settle the exact adjustment."})
                e["settlement_status"], e["settlement_reference"] = "Settled", body["reference"]
            return _Resp(200, e)
        return _Resp(404, {"detail": f"unhandled {method} {tail}"})

    def _renewals(self, mid, mp, method, tail, body):
        store = self.renewals.setdefault(mid, [])
        if tail == "/renewals" and method == "POST":
            if mp["status"] != "Active":
                return _Resp(409, {"detail": "Only an in-force scheme can be renewed."})
            r = {"id": str(uuid.uuid4()), "status": "Open", "new_period_start": "2027-10-06", "new_period_end": "2028-10-05", "experience_factor": 1.0,
                 "experience": {}, "quotes": []}
            store.insert(0, r)
            return _Resp(201, r)
        if tail == "/renewals":
            return _Resp(200, store)
        m = re.fullmatch(r"/renewals/([^/]+)(?:/(census-refresh|quote|accept|decline|payments))?", tail)
        r = next((x for x in store if x["id"] == m.group(1)), None) if m else None
        if r is None:
            return _Resp(404, {"detail": "no renewal"})
        action = m.group(2)
        if action is None:
            return _Resp(200, r)
        if action == "census-refresh":
            r["refreshed"] = len(body["employees"])
            return _Resp(200, {"applied": True})
        if action == "quote":
            r["status"], r["experience_factor"] = "Quoted", 1.12
            r["experience"] = {"claims_ratio": 0.7, "claims_incurred": 70.0, "premium_earned": 100.0}
            q = {"total_premium": 123456.0, "member_count": len(self.members[mid])}
            r["quotes"] = [q]
            return _Resp(201, q)
        if action in ("accept", "decline"):
            if r["status"] != "Quoted":
                return _Resp(409, {"detail": "Nothing to decide yet."})
            r["status"] = "Accepted" if action == "accept" else "Declined"
            return _Resp(200, r)
        if r["status"] != "Accepted":
            return _Resp(409, {"detail": "Accept the renewal first."})
        r["status"] = "Renewed"
        return _Resp(200, r)

    def _scheme_claims(self, mid, mp, method, body):
        store = self.claims.setdefault(mid, [])
        if method == "GET":
            return _Resp(200, {"claims": store, "summary": {"count": len(store), "open": len(store), "paid": 0.0}})
        member = next((m for m in self.members[mid] if m["id"] == body["member_id"]), None)
        c = {"id": str(uuid.uuid4()), "claim_number": f"CLM-{len(store) + 1:04d}", "claim_type": body["claim_type"], "status": "Submitted",
             "submitted_amount": body["submitted_amount"], "member": member["name"]}
        store.append(c)
        return _Resp(201, {"claim": c, "group": {"missing_documents": ["Death certificate", "Nominee CNIC"]}})

    def _claim_money(self, claim_id, what, body):
        claim = next((c for rows in self.claims.values() for c in rows if c["id"] == claim_id), None)
        if claim is None:
            return _Resp(404, {"detail": "no claim"})
        split = {"amount": claim["submitted_amount"], "source": "nominees", "warnings": [],
                 "shares": [{"payee_name": "Nominee A", "relationship": "Spouse", "share_pct": 60.0, "amount": claim["submitted_amount"] * .6, "is_minor": False},
                            {"payee_name": "Nominee B", "relationship": "Child", "share_pct": 40.0, "amount": claim["submitted_amount"] * .4, "is_minor": False}]}
        if what == "payout-split":
            return _Resp(200, split)
        claim["status"] = "Settled"
        return _Resp(201, {"claim_number": claim["claim_number"], "total": claim["submitted_amount"],
                           "payouts": [{"payee": s["payee_name"], "share_pct": s["share_pct"], "amount": s["amount"]} for s in split["shares"]]})

    # -- the HTTP surface --------------------------------------------------------
    async def get(self, url, **kw):
        return self._dispatch("GET", url, None)

    async def post(self, url, **kw):
        return self._dispatch("POST", url, kw.get("json"))

    async def put(self, url, **kw):
        return self._dispatch("PUT", url, kw.get("json"))

    async def patch(self, url, **kw):
        return self._dispatch("PATCH", url, kw.get("json"))

    async def delete(self, url, **kw):
        return self._dispatch("DELETE", url, None)

    def _dispatch(self, method: str, url: str, body):
        path = url.replace(BASE, "")
        self.calls.append((method, path))
        if any(path.endswith(f) for f in self.fail_paths):
            return _Resp(500, {"detail": "boom"})
        dm = re.fullmatch(r"/organizations/([^/]+)", path)
        if method == "DELETE" and dm:
            self.orgs.pop(dm.group(1), None)
            for mid in [m for m, sc in self.schemes.items() if sc["organization_id"] == dm.group(1)]:
                self.schemes.pop(mid)
            return _Resp(204, None)
        if path == "/organizations":
            if method == "GET":
                return _Resp(200, list(self.orgs.values()))
            oid = self.add_org(body["name"])
            return _Resp(201, self.orgs[oid])
        m = re.fullmatch(r"/claims/([^/]+)/(payout-split|group-payout)", path)
        if m:
            return self._claim_money(m.group(1), m.group(2), body)
        m = re.fullmatch(r"/organizations/([^/]+)", path)
        if m:
            return _Resp(200, self.orgs[m.group(1)]) if m.group(1) in self.orgs else _Resp(404, {"detail": "no org"})
        m = re.fullmatch(r"/organizations/([^/]+)/master-policies", path)
        if m:
            oid = m.group(1)
            if method == "GET":
                return _Resp(200, [s for s in self.schemes.values() if s["organization_id"] == oid])
            takaful = body.get("plan_code") == "GROUP_FAMILY_TAKAFUL"
            mid = str(uuid.uuid4())
            self.schemes[mid] = {
                "id": mid, "organization_id": oid, "status": "Pending", "plan_code": body.get("plan_code") or "GROUP_LIFE",
                "plan_label": "Group Family Takaful" if takaful else "Group Life",
                "business_type": "Takaful" if takaful else "Conventional", "free_cover_limit": None,
                "policy_number": None, "effective_date": body["effective_date"], "expiry_date": None,
                "created_at": f"2026-10-06T00:00:0{len(self.schemes)}",
            }
            self.classes[mid], self.members[mid], self.quotes[mid] = [], [], []
            return _Resp(201, self.schemes[mid])
        m = re.fullmatch(r"/organizations/([^/]+)/master-policies/([^/]+)(/.*)", path)
        if not m:
            return _Resp(404, {"detail": f"unhandled {method} {path}"})
        mid, tail = m.group(2), m.group(3)
        mp = self.schemes[mid]
        if tail == "/benefit-classes":
            if method == "GET":
                return _Resp(200, self.classes[mid])
            if self.members[mid]:
                return _Resp(409, {"detail": "Benefit classes are frozen once members are enrolled."})
            self.classes[mid].append({"id": str(uuid.uuid4()), **body})
            return _Resp(201, body)
        if tail == "/members":
            return _Resp(200, self.members[mid])
        if tail == "/census/validate":
            rows = body["employees"]
            cnics = [r.get("cnic") for r in rows]
            errors = [] if len(rows) >= 5 and len(set(cnics)) == len(cnics) else ["Census needs at least 5 unique employees."]
            return _Resp(200, {"is_valid": not errors, "total": len(rows), "duplicate_cnics": [], "missing_fields": [], "errors": errors})
        if tail == "/census/confirm":
            mp["status"], mp["free_cover_limit"] = "Proposed", self.fcl
            for r in body["employees"]:
                self.members[mid].append({
                    "id": str(uuid.uuid4()), "name": r["name"], "benefit_class": r.get("benefit_class"),
                    "coverage_amount": 3_000_000 if r.get("benefit_class") == "Executive" else 450_000,
                    "status": "Quoted", "underwriting_basis": "Pending" if r.get("benefit_class") == "Executive" else "Guaranteed",
                    "certificate_number": None, "nominations": 0,
                })
            return _Resp(201, {"free_cover_limit": self.fcl, "employees": [{"coverage_amount": 1} for _ in body["employees"]]})
        if tail == "/quotes":
            if method == "GET":
                return _Resp(200, sorted(self.quotes[mid], key=lambda q: -q["version"]))
            pending = [x["name"] for x in self.members[mid] if x["underwriting_basis"] == "Pending"]
            if pending:
                return _Resp(409, {"detail": {"message": "Some members are above the Free Cover Limit and still need an underwriting decision.",
                                              "pending_members": pending}})
            for q in self.quotes[mid]:
                if q["status"] == "Open":
                    q["status"] = "Superseded"
            risk = round(sum(x["coverage_amount"] for x in self.members[mid]) / 1000 * 3.2, 2)
            takaful = mp["business_type"] == "Takaful"
            q = {"id": str(uuid.uuid4()), "version": len(self.quotes[mid]) + 1, "status": "Open", "business_type": mp["business_type"],
                 "valid_until": "2026-11-05", "member_count": len(self.members[mid]), "dependent_count": 0,
                 "total_sum_assured": sum(x["coverage_amount"] for x in self.members[mid]), "rate_per_mille": 3.2,
                 "risk_premium": risk, "policy_fee": 500.0, "stamp_duty": 12.0, "total_premium": risk + 512.0,
                 "wakala_fee_pct": 30.0 if takaful else None, "wakala_fee": round(risk * .3, 2) if takaful else None,
                 "ptf_allocation": round(risk * .7, 2) if takaful else None, "breakdown": {"adjusted_members": []}}
            self.quotes[mid].append(q)
            mp["status"] = "Quoted"
            return _Resp(201, q)
        if tail.startswith("/endorsements"):
            return self._endorsements(mid, mp, method, tail, body)
        if tail.startswith("/renewals"):
            return self._renewals(mid, mp, method, tail, body)
        if tail.startswith("/claims"):
            return self._scheme_claims(mid, mp, method, body)
        if tail == "/ptf-report":
            if mp["business_type"] != "Takaful":
                return _Resp(409, {"detail": "Only Takaful schemes have a Participants' Takaful Fund."})
            return _Resp(200, {"periods": [{"label": "Initial term", "ptf_gross": 700.0, "wakala_fee": 300.0, "retakaful_contribution": 140.0,
                                            "claims_incurred": 100.0, "position": "Surplus", "result": 460.0}], "note": "Qard Hassan covers any deficit."})
        m3 = re.fullmatch(r"/benefit-classes/([^/]+)/coverages", tail)
        if m3:
            if mp["status"] in ("Accepted", "PendingPayment", "Active"):
                return _Resp(409, {"detail": "Benefits are fixed once the quote is accepted."})
            cls = next(c for c in self.classes[mid] if c["id"] == m3.group(1))
            cls.setdefault("coverages", []).append(dict(body))
            return _Resp(201, cls)
        m2 = re.fullmatch(r"/quotes/([^/]+)/(accept|decline)", tail)
        if m2:
            q = next(x for x in self.quotes[mid] if x["id"] == m2.group(1))
            if q["status"] != "Open":
                return _Resp(409, {"detail": "Quote is not open."})
            q["status"] = "Accepted" if m2.group(2) == "accept" else "Declined"
            mp["status"] = "Accepted" if m2.group(2) == "accept" else "Declined"
            return _Resp(200, q)
        if tail == "/issue":
            if mp["status"] != "Accepted":
                return _Resp(409, {"detail": f"Only an Accepted master policy can be issued (current: {mp['status']})."})
            mp["status"], mp["policy_number"], mp["expiry_date"] = "PendingPayment", f"{'GT' if mp['business_type'] == 'Takaful' else 'GL'}-2026-0001", "2027-10-05"
            for i, x in enumerate(self.members[mid], 1):
                x["certificate_number"] = f"{mp['policy_number']}/{i:04d}"
            q = next(x for x in self.quotes[mid] if x["status"] == "Accepted")
            return _Resp(200, {"master_policy": dict(mp), "certificates_issued": len(self.members[mid]),
                               "total_premium": q["total_premium"], "amount_due": q["total_premium"]})
        if tail == "/payments":
            q = next(x for x in self.quotes[mid] if x["status"] == "Accepted")
            if mp["status"] != "PendingPayment":
                return _Resp(409, {"detail": f"Master policy is not awaiting payment (current: {mp['status']})."})
            if body["amount"] + 0.01 < q["total_premium"]:
                return _Resp(422, {"detail": "Payment is less than the annual amount due."})
            mp["status"] = "Active"
            for x in self.members[mid]:
                x["status"] = "Active"
            return _Resp(200, {"master_policy": dict(mp), "certificates_issued": len(self.members[mid]),
                               "total_premium": q["total_premium"], "amount_due": 0.0})
        return _Resp(404, {"detail": f"unhandled {method} {path}"})


@contextmanager
def backend(mode: str):
    """Fake tenant-service + ENV_VAR for the duration of a test."""
    fake = FakeTenantService()
    saved_env, saved_client = os.environ.get("ENV_VAR"), tool_executor._shared_client

    async def _client():
        return fake

    os.environ["ENV_VAR"] = mode
    tool_executor._shared_client = _client
    try:
        yield fake
    finally:
        tool_executor._shared_client = saved_client
        if saved_env is None:
            os.environ.pop("ENV_VAR", None)
        else:
            os.environ["ENV_VAR"] = saved_env


# ═══════════════════════════════════════════════════════════════════════════
# Graph harness
# ═══════════════════════════════════════════════════════════════════════════

def _graph(entry: str):
    """The real group nodes and edges, with a stub where g_finish hands back to the agent."""
    builder = StateGraph(ChatState)
    builder.add_node("agent", lambda state: {})
    group_journey.register_group_journey(builder)
    builder.add_edge(START, entry)
    builder.add_edge("agent", END)
    return builder.compile()


def _state(name: str, **args) -> dict:
    # no_agent: an organization the journey creates would otherwise first ask which Agent owns it.
    args = {"organization_name": name, "no_agent": True, **args}
    return {"tenant_id": TENANT, "jwt_token": "", "user_role": "Admin",
            "pending_call": {"name": "start_group_journey", "id": "call-1", "args": args},
            "group_audit": [], "group_blocking_actions": []}


async def _start(name: str, **args) -> dict:
    return await _graph("g_scheme").ainvoke(_state(name, **args))


async def _resume(fake_state: dict, name: str) -> dict:
    s = {**fake_state, "pending_call": {"name": "continue_group_journey", "id": "call-2", "args": {"organization_name": name}},
         "group_blocking_actions": []}
    return await _graph("g_resume").ainvoke(s)


def _result(state: dict) -> dict:
    return json.loads(state["messages"][-1].content)


def _labels(result: dict) -> list[str]:
    return [a["label"] for a in result["quick_actions"]]


async def _call(tool: str, **args) -> dict:
    return await tool_executor.execute_tool(
        tool, args, tool_executor.ExecCtx(tenant_id=TENANT, jwt_token="", role="Admin"))


# ═══════════════════════════════════════════════════════════════════════════
# Tests
# ═══════════════════════════════════════════════════════════════════════════

def _sync(fn):
    """Run an async test to completion, so plain pytest (no asyncio plugin) and the
    __main__ runner below both just call it."""
    @functools.wraps(fn)
    def run():
        return asyncio.run(fn())
    return run


@_sync
async def test_demo_journey_runs_to_acceptance_then_completes():
    with backend("demo") as fake:
        end = await _start("Meridian Textiles", use_demo_data=True)
        res = _result(end)
        assert res["success"] and res["outcome"] == "Awaiting_Acceptance", res
        stages = [e for e in end["group_audit"]]
        assert any("Scheme created" in e for e in stages) and any("Demo census enrolled" in e for e in stages)
        assert any("Group underwriting cleared" in e for e in stages) and any("Quote v1 generated" in e for e in stages)
        assert _labels(res)[:3] == ["Accept quote", "Revise quote", "Decline quote"]
        assert "won't accept it for them" in res["message"]
        assert fake.only_scheme()["status"] == "Quoted"                        # it did NOT accept for the employer
        assert [c["name"] for c in fake.classes[fake.only_scheme()["id"]]] == ["Management", "Staff", "Support"]

        # The employer accepts; the resumed journey issues, takes the demo payment, enrols.
        assert (await _call("accept_group_quote", organization_name="Meridian Textiles"))["success"]
        done = _result(await _resume(end, "Meridian Textiles"))
        assert done["success"] and done["outcome"] == "Completed", done
        assert fake.only_scheme()["status"] == "Active" and fake.only_scheme()["policy_number"].startswith("GL-")
        assert "have no nominee yet" in done["message"]                        # nominations are listed, not blocking
        assert "View members" in _labels(done)
        print("PASS test_demo_journey_runs_to_acceptance_then_completes")


@_sync
async def test_demo_census_is_random_each_time():
    with backend("demo"):
        a = group_tools.generate_demo_census(12, ["Management", "Staff", "Support"])
        b = group_tools.generate_demo_census(12, ["Management", "Staff", "Support"])
        assert len({r["cnic"] for r in a + b}) == 24                           # never repeats a CNIC
        assert [r["name"] for r in a] != [r["name"] for r in b]
        assert {r.get("benefit_class", "Staff") for r in a} <= {"Management", "Staff", "Support"}
        only_staff = group_tools.generate_demo_census(20, ["Staff"])
        assert all("benefit_class" not in r or r["benefit_class"] == "Staff" for r in only_staff)
        print("PASS test_demo_census_is_random_each_time")


@_sync
async def test_prod_has_no_shortcuts():
    with backend("prod") as fake:
        # use_demo_data is ignored: the journey stops for the real census.
        end = await _start("Real Employer Ltd", use_demo_data=True)
        res = _result(end)
        assert res["outcome"] == "Census_Needed" and "Generate demo census" not in _labels(res), res
        assert "Upload census file" in _labels(res)
        assert not fake.classes[fake.only_scheme()["id"]]                      # no demo classes either
        assert any("No benefit classes defined" in e for e in end["group_audit"])

        refused = await _call("submit_group_census", organization_name="Real Employer Ltd", use_demo_data=True)
        assert not refused["success"] and "demo mode" in refused["error"]
        refused = await _call("add_group_benefit_class", organization_name="Real Employer Ltd", use_demo_template=True)
        assert not refused["success"]

        rows = [{"cnic": f"3520100000{i:03d}-1", "name": f"Emp {i}", "dob": "1990-01-01", "gender": "Male",
                 "occupation": "Clerk", "declared_income": 1_200_000} for i in range(6)]
        enrolled = await _call("submit_group_census", organization_name="Real Employer Ltd", employees_json=json.dumps(rows))
        assert enrolled["success"] and enrolled["enrolled"] == 6, enrolled

        quoted = _result(await _resume(end, "Real Employer Ltd"))
        assert quoted["outcome"] == "Awaiting_Acceptance"
        assert (await _call("accept_group_quote", organization_name="Real Employer Ltd"))["success"]

        # Issues, then holds at the billing gate — no auto-payment outside demo.
        issued = await _resume(end, "Real Employer Ltd")
        res = _result(issued)
        assert res["outcome"] == "Awaiting_Payment" and "Record payment" in _labels(res), res
        assert not [c for c in fake.calls if c[1].endswith("/payments")]
        assert fake.only_scheme()["status"] == "PendingPayment"

        no_ref = await _call("record_group_payment", organization_name="Real Employer Ltd")
        assert not no_ref["success"] and "reference" in no_ref["error"]
        assert (await _call("record_group_payment", organization_name="Real Employer Ltd", reference="IBFT-778812"))["success"]
        assert _result(await _resume(issued, "Real Employer Ltd"))["outcome"] == "Completed"
        print("PASS test_prod_has_no_shortcuts")


@_sync
async def test_payment_reference_is_required_by_the_gate_only_outside_demo():
    with backend("prod"):
        assert permission.missing_args("record_group_payment", {}) == ["reference"]
    with backend("demo"):
        assert permission.missing_args("record_group_payment", {}) == []
    print("PASS test_payment_reference_is_required_by_the_gate_only_outside_demo")


@_sync
async def test_above_fcl_members_hold_the_journey_until_decided():
    with backend("demo") as fake:
        end = await _start("Executive Heavy Co", use_demo_data=True, above_fcl_count=2)
        res = _result(end)
        assert res["outcome"] == "Underwriting_Pending", res
        assert "2" in res["message"] and "Free Cover Limit" in res["message"]
        assert any("Review undecided members" == l for l in _labels(res))
        assert fake.only_scheme()["status"] == "Proposed" and not fake.quotes[fake.only_scheme()["id"]]

        blocked = await _call("generate_group_quote", organization_name="Executive Heavy Co")
        assert not blocked["success"] and len(blocked["pending_members"]) == 2

        fake.decide_pending()                                                  # the underwriters rule
        res = _result(await _resume(end, "Executive Heavy Co"))
        assert res["outcome"] == "Awaiting_Acceptance", res
        print("PASS test_above_fcl_members_hold_the_journey_until_decided")


@_sync
async def test_takaful_uses_contribution_wording_and_shows_the_split():
    with backend("demo"):
        res = _result(await _start("Halal Foods", use_demo_data=True, plan_code="GROUP_FAMILY_TAKAFUL"))
        assert res["outcome"] == "Awaiting_Acceptance"
        assert "contribution" in res["message"] and "Wakala fee (30%)" in res["message"] and "Takaful Fund" in res["message"]
        print("PASS test_takaful_uses_contribution_wording_and_shows_the_split")


@_sync
async def test_decline_then_revise():
    with backend("demo") as fake:
        end = await _start("Fussy Employer", use_demo_data=True)
        assert (await _call("decline_group_quote", organization_name="Fussy Employer"))["success"]
        res = _result(await _resume(end, "Fussy Employer"))
        assert res["outcome"] == "Declined" and "Generate revised quote" in _labels(res)

        revised = await _call("generate_group_quote", organization_name="Fussy Employer")
        assert revised["success"] and revised["quote"]["version"] == 2 and "superseded" in revised["message"]
        assert _result(await _resume(end, "Fussy Employer"))["outcome"] == "Awaiting_Acceptance"
        print("PASS test_decline_then_revise")


@_sync
async def test_start_on_an_existing_scheme_continues_it():
    with backend("demo") as fake:
        await _start("Already Started Ltd", use_demo_data=True)
        before = len(fake.schemes)
        again = await _start("Already Started Ltd", use_demo_data=True)
        assert len(fake.schemes) == before                                     # no second scheme
        assert any("attached to the in-progress scheme" in e for e in again["group_audit"])
        assert any("Census on file" in e for e in again["group_audit"])
        assert _result(again)["outcome"] == "Awaiting_Acceptance"
        print("PASS test_start_on_an_existing_scheme_continues_it")


@_sync
async def test_missing_agent_is_a_question_not_a_crash():
    with backend("demo"):
        # No such organization and no agent given: add_organization asks which agent
        # owns the lead; the journey carries that picker out instead of failing blind.
        async def picker(args, ctx):
            return {"success": False, "error": "Who is the agent associated with this lead?",
                    "quick_actions": [{"label": "Agent One", "actionType": "submit", "payload": "agent one"}]}

        original = tool_executor._HANDLERS["add_organization"]
        tool_executor._HANDLERS["add_organization"] = picker
        try:
            res = _result(await _start("Brand New Co", no_agent=False))
        finally:
            tool_executor._HANDLERS["add_organization"] = original
        assert not res["success"] and "agent" in res["error"].lower() and _labels(res) == ["Agent One"], res
        print("PASS test_missing_agent_is_a_question_not_a_crash")


@_sync
async def test_resume_without_a_scheme_says_so():
    with backend("demo"):
        res = _result(await _resume({"tenant_id": TENANT, "jwt_token": "", "user_role": "Admin", "group_audit": []}, "Nobody Ltd"))
        assert not res["success"] and "couldn't find" in res["error"].lower(), res
        print("PASS test_resume_without_a_scheme_says_so")


def test_resume_routing_follows_the_schemes_real_status():
    route = group_journey.route_resume
    base = {"group_master_policy_id": "m1"}
    scheme = lambda **kw: {**base, "group_scheme": {"status": "Proposed", "member_count": 5, "pending_members": [], **kw}}  # noqa: E731
    assert route({}) == "g_scheme"
    assert route({"group_error": "x"}) == "g_finish"
    assert route(scheme(status="Pending", member_count=0)) == "g_benefits"
    assert route(scheme(pending_members=["A"])) == "g_underwrite"
    assert route(scheme(status="Proposed")) == "g_quote"
    assert route(scheme(status="Declined")) == "g_acceptance"
    assert route(scheme(status="Declined", pending_members=["A"])) == "g_acceptance"
    assert route(scheme(status="Quoted")) == "g_acceptance"
    assert route(scheme(status="Accepted")) == "g_issue"
    assert route(scheme(status="PendingPayment")) == "g_issue"
    assert route(scheme(status="Active")) == "g_enroll"
    print("PASS test_resume_routing_follows_the_schemes_real_status")


@_sync
async def test_census_upload_hands_the_browser_real_ids():
    with backend("demo") as fake:
        fake.add_org("Upload Co")
        await _call("create_group_scheme", organization_name="Upload Co")
        res = await _call("upload_group_census", organization_name="Upload Co")
        marker = res["tool_call"]
        assert res["__client_execute__"] and marker["name"] == "upload_group_census"
        assert marker["args"]["master_policy_id"] == fake.only_scheme()["id"] and marker["args"]["organization_name"] == "Upload Co"
        print("PASS test_census_upload_hands_the_browser_real_ids")


@_sync
async def test_scheme_creation_guards():
    with backend("demo") as fake:
        res = await _call("create_group_scheme", organization_name="Ghost Corp")
        assert not res["success"] and "couldn't find" in res["error"] and "Create Ghost Corp" in _labels(res)
        fake.add_org("Real Corp")
        bad = await _call("create_group_scheme", organization_name="Real Corp", plan_code="TERM_LIFE")
        assert not bad["success"] and "isn't a group plan" in bad["error"]
        ok = await _call("create_group_scheme", organization_name="Real Corp", business_type="Takaful")
        assert ok["success"] and ok["master_policy"]["plan_code"] == "GROUP_FAMILY_TAKAFUL"
        again = await _call("create_group_scheme", organization_name="Real Corp")
        assert again["attached"], again                                        # one scheme in progress at a time
        print("PASS test_scheme_creation_guards")


@_sync
async def test_every_stage_reports_itself_to_the_process_graph():
    """routers/chat.py turns journey_done / journey_next into the UI's animated
    process graph — each node must announce its own stage and the next one."""
    with backend("demo"):
        s = _state("Graph Co", use_demo_data=True)
        expected = [("g_scheme", "g_benefits"), ("g_benefits", "g_census"), ("g_census", "g_underwrite"),
                    ("g_underwrite", "g_quote"), ("g_quote", "g_acceptance")]
        for node, nxt in expected:
            out = await getattr(group_journey, node)(s)
            sid, label = group_journey.STAGES[node]
            assert out["journey_done"] == {"id": f"stage:{sid}", "label": label, "status": "done"}, (node, out.get("journey_done"))
            assert out["journey_next"]["id"] == f"stage:{group_journey.STAGES[nxt][0]}", node
            s = {**s, **out}
        # g_acceptance always waits: it reports an error-status stop, no next stage.
        out = await group_journey.g_acceptance(s)
        assert out["journey_done"]["status"] == "error" and "journey_next" not in out
        print("PASS test_every_stage_reports_itself_to_the_process_graph")


@_sync
async def test_add_organization_offers_the_group_scheme_to_admins_only():
    with backend("demo"):
        for role, expect in (("Admin", True), ("SuperAdmin", True), ("Underwriter", False)):
            res = await tool_executor.execute_tool(
                "add_organization", {"name": f"Offer Co {role}", "no_agent": True},
                tool_executor.ExecCtx(tenant_id=TENANT, jwt_token="", role=role))
            assert res["success"], res
            assert ("Start group scheme" in _labels(res)) is expect, (role, _labels(res))
        print("PASS test_add_organization_offers_the_group_scheme_to_admins_only")


async def _live_scheme(fake, name="Endorse Co"):
    """A finished demo scheme to endorse."""
    end = await _start(name, use_demo_data=True)
    assert (await _call("accept_group_quote", organization_name=name))["success"]
    await _resume(end, name)
    assert fake.only_scheme()["status"] == "Active"


@_sync
async def test_endorsements_are_previewed_then_applied_by_name():
    with backend("demo") as fake:
        await _live_scheme(fake)
        name = fake.members[fake.only_scheme()["id"]][3]["name"]

        pre = await _call("preview_group_endorsement", organization_name="Endorse Co", endorsement_type="DELETE", member_names=[name],
                          effective_date="2026-10-15")
        assert pre["success"] and "Nothing has been changed yet" in pre["message"] and "refund" in pre["message"]
        assert "Apply this endorsement" in _labels(pre)
        assert not fake.endorsements.get(fake.only_scheme()["id"])             # a preview writes nothing

        done = await _call("apply_group_endorsement", endorsement_type="DELETE", organization_name="Endorse Co", member_names=[name], effective_date="2026-10-15")
        assert done["success"] and "END-GT" not in done["message"] and "applied" in done["message"] and "removed" in done["message"]
        assert done["endorsement"]["number"].endswith("-001")

        chg = await _call("apply_group_endorsement", endorsement_type="CHANGE", organization_name="Endorse Co", member_name=fake.members[fake.only_scheme()["id"]][5]["name"], new_salary=250000)
        assert chg["success"] and "to collect" in chg["message"]
        sent = fake.calls[-1]
        assert sent[0] == "POST" and sent[1].endswith("/endorsements")

        add = await _call("apply_group_endorsement", endorsement_type="ADD", organization_name="Endorse Co", use_demo_data=True, employee_count=2)
        assert add["success"] and add["endorsement"]["endorsement_type"] == "ADD" and len(add["endorsement"]["lines"]) == 2

        listed = await _call("list_group_endorsements", organization_name="Endorse Co")
        assert len(listed["endorsements"]) == 3 and "Open endorsements" in _labels(listed)
        print("PASS test_endorsements_are_previewed_then_applied_by_name")


@_sync
async def test_endorsement_member_lookup_is_forgiving_but_never_guesses():
    with backend("demo") as fake:
        await _live_scheme(fake)
        members = fake.members[fake.only_scheme()["id"]]
        twin = members[0]["name"].split()[0]                                    # a first name shared by several demo hires, if any
        fake.members[fake.only_scheme()["id"]].append({**members[1], "id": "dup", "name": members[0]["name"]})
        ambiguous = await _call("apply_group_endorsement", endorsement_type="DELETE", organization_name="Endorse Co", member_names=[members[0]["name"]])
        assert not ambiguous["success"] and "More than one member" in ambiguous["error"] and ambiguous["quick_actions"]
        missing = await _call("apply_group_endorsement", endorsement_type="DELETE", organization_name="Endorse Co", member_names=["Nobody Atall"])
        assert not missing["success"] and "No member matches" in missing["error"]
        none = await _call("apply_group_endorsement", endorsement_type="DELETE", organization_name="Endorse Co")
        assert not none["success"] and "Which member" in none["error"]
        print("PASS test_endorsement_member_lookup_is_forgiving_but_never_guesses")


@_sync
async def test_endorsing_needs_a_live_scheme_and_real_joiners():
    with backend("demo") as fake:
        end = await _start("Not Live Co", use_demo_data=True)                  # stops at acceptance: Quoted, not Active
        res = await _call("apply_group_endorsement", endorsement_type="ADD", organization_name="Not Live Co", use_demo_data=True)
        assert not res["success"] and "in force" in res["error"]
    with backend("prod") as fake:
        await _start("Prod Co")
        res = await _call("apply_group_endorsement", endorsement_type="ADD", organization_name="Prod Co", use_demo_data=True)
        assert not res["success"]                                               # no generated people outside demo
        res = await _call("apply_group_endorsement", endorsement_type="ADD", organization_name="Prod Co")
        assert not res["success"] and "Who is joining" in res["error"]
        print("PASS test_endorsing_needs_a_live_scheme_and_real_joiners")


@_sync
async def test_endorsement_settlement_needs_a_reference_outside_demo():
    with backend("demo") as fake:
        await _live_scheme(fake)
        name = fake.members[fake.only_scheme()["id"]][2]["name"]
        await _call("apply_group_endorsement", endorsement_type="DELETE", organization_name="Endorse Co", member_names=[name])
        ok = await _call("settle_group_endorsement", organization_name="Endorse Co")      # demo: generated reference
        assert ok["success"] and "DEMO-END-" in ok["message"]
    with backend("prod") as fake:
        assert permission.missing_args("settle_group_endorsement", {}) == ["reference"]
        print("PASS test_endorsement_settlement_needs_a_reference_outside_demo")


@_sync
async def test_renewal_runs_from_quote_to_payment_by_chat():
    with backend("demo") as fake:
        await _live_scheme(fake, "Renew Co")
        started = await _call("start_group_renewal", organization_name="Renew Co")
        assert started["success"] and "Quoted" in started["message"] and "1.12x" in started["message"] and "123,456" in started["message"]
        assert {"Employer accepts", "Employer declines"} <= set(_labels(started))
        again = await _call("start_group_renewal", organization_name="Renew Co")             # idempotent: reuses the open renewal
        assert again["success"] and len(fake.renewals[fake.only_scheme()["id"]]) == 1
        assert (await _call("get_group_renewal", organization_name="Renew Co"))["success"]
        ok = await _call("decide_group_renewal", decision="accept", organization_name="Renew Co")
        assert ok["success"] and "accepted" in ok["message"] and "Record the payment" in _labels(ok)
        paid = await _call("record_group_renewal_payment", organization_name="Renew Co")      # demo: generated reference
        assert paid["success"] and "DEMO-REN-" in paid["message"]
        none = await _call("decide_group_renewal", decision="accept", organization_name="Renew Co")
        assert not none["success"] and "no renewal in progress" in none["error"]
        print("PASS test_renewal_runs_from_quote_to_payment_by_chat")


@_sync
async def test_renewal_decline_and_a_scheme_not_in_force():
    with backend("demo") as fake:
        await _live_scheme(fake, "Decline Co")
        await _call("start_group_renewal", organization_name="Decline Co")
        out = await _call("decide_group_renewal", decision="decline", organization_name="Decline Co")
        assert out["success"] and "declined" in out["message"] and "lapse" in out["message"]
    with backend("demo") as fake:
        await _start("Early Co", use_demo_data=True)
        res = await _call("start_group_renewal", organization_name="Early Co")
        assert not res["success"] and "in-force" in res["error"]
    with backend("prod") as fake:
        assert permission.missing_args("record_group_renewal_payment", {}) == []                # the handler asks for the reference itself
        print("PASS test_renewal_decline_and_a_scheme_not_in_force")


@_sync
async def test_group_claims_register_preview_and_pay():
    with backend("demo") as fake:
        await _live_scheme(fake, "Claims Co")
        member = fake.members[fake.only_scheme()["id"]][2]["name"]
        reg = await _call("register_group_claim", organization_name="Claims Co", member_name=member)
        assert reg["success"] and "Death certificate" in reg["message"] and "CLM-0001" in reg["message"]
        pre = await _call("preview_group_claim_payout", organization_name="Claims Co", claim_number="CLM-0001")
        assert pre["success"] and "Nominee A" in pre["message"] and "60%" in pre["message"] and "Nothing has been paid" in pre["message"]
        assert fake.claims[fake.only_scheme()["id"]][0]["status"] == "Submitted"              # a preview pays nothing
        paid = await _call("pay_group_claim", organization_name="Claims Co", member_name=member)
        assert paid["success"] and "paid" in paid["message"] and fake.claims[fake.only_scheme()["id"]][0]["status"] == "Settled"
        listed = await _call("list_group_claims", organization_name="Claims Co")
        assert listed["success"] and listed["summary"]["count"] == 1
        miss = await _call("pay_group_claim", organization_name="Claims Co", claim_number="CLM-9999")
        assert not miss["success"] and "No claim" in miss["error"]
        nobody = await _call("register_group_claim", organization_name="Claims Co")
        assert not nobody["success"] and "Whose claim" in nobody["error"]
        print("PASS test_group_claims_register_preview_and_pay")


@_sync
async def test_group_claim_payout_needs_a_reference_outside_demo():
    with backend("prod") as fake:
        await _start("Prod Claims Co")
        fake.schemes[fake.only_scheme()["id"]]["status"] = "Active"
        fake.members[fake.only_scheme()["id"]].append({"id": "m1", "name": "A Member", "coverage_amount": 100_000})
        await _call("register_group_claim", organization_name="Prod Claims Co", member_name="A Member")
        res = await _call("pay_group_claim", organization_name="Prod Claims Co", claim_number="CLM-0001")
        assert not res["success"] and "reference" in res["error"]
        assert fake.claims[fake.only_scheme()["id"]][0]["status"] == "Submitted"
        print("PASS test_group_claim_payout_needs_a_reference_outside_demo")


@_sync
async def test_ptf_report_is_takaful_only_and_coverages_lock_after_acceptance():
    with backend("demo") as fake:
        await _live_scheme(fake, "Conv Co")
        res = await _call("get_group_ptf_report", organization_name="Conv Co")
        assert not res["success"] and "Takaful" in res["error"]
    with backend("demo") as fake:
        end = await _start("Rider Co", use_demo_data=True)
        added = await _call("add_group_class_coverage", organization_name="Rider Co", class_name="Staff", coverage_type="Disability", percent_of_base=100)
        assert added["success"] and "Re-quote" in _labels(added)
        unknown = await _call("add_group_class_coverage", organization_name="Rider Co", class_name="Nonexistent", coverage_type="Disability", percent_of_base=100)
        assert not unknown["success"] and "Which benefit class" in unknown["error"]
        assert (await _call("accept_group_quote", organization_name="Rider Co"))["success"]
        locked = await _call("add_group_class_coverage", organization_name="Rider Co", class_name="Staff", coverage_type="AccidentalDeath", percent_of_base=50)
        assert not locked["success"] and "fixed" in locked["error"]
        print("PASS test_ptf_report_is_takaful_only_and_coverages_lock_after_acceptance")


def test_phase5_6_tools_are_registered_gated_and_routed():
    import toolsets
    from tools import ALL_TOOLS
    new = {"start_group_renewal", "get_group_renewal", "decide_group_renewal", "record_group_renewal_payment",
           "register_group_claim", "list_group_claims", "preview_group_claim_payout", "pay_group_claim", "get_group_ptf_report", "add_group_class_coverage", "apply_group_endorsement"}
    assert new <= {t.name for t in ALL_TOOLS} and new <= permission.GROUP_TOOLS and new <= toolsets.DOMAIN_TOOLS["group"]
    reads = {"get_group_renewal", "list_group_claims", "preview_group_claim_payout", "get_group_ptf_report"}
    for name in new:
        assert permission.requires_confirmation(name) == (name not in reads), name
        assert name in permission.STEP_LABELS, name
    print("PASS test_phase5_6_tools_are_registered_gated_and_routed")


@_sync
async def test_an_organization_id_settles_which_of_several_same_named_companies():
    """Companies can share a name. The chip after a corporate is saved carries its id, and the id —
    not a question — decides which one the journey continues."""
    with backend("demo") as fake:
        first, second = fake.add_org("Twin Textiles"), fake.add_org("Twin Textiles")
        ambiguous = await _call("get_group_scheme_status", organization_name="Twin Textiles")
        assert not ambiguous["success"] and "More than one organization" in ambiguous["error"]
        for wanted in (first, second):
            res = await _call("get_group_scheme_status", organization_name="Twin Textiles", organization_id=wanted)
            assert "More than one organization" not in str(res.get("error", "")), res
            assert res.get("organization_id", wanted) == wanted
        print("PASS test_an_organization_id_settles_which_of_several_same_named_companies")


@_sync
async def test_the_corporate_being_worked_on_settles_same_named_companies_without_asking():
    """Once a corporate has been saved or chosen, later requests that only say its name — or nothing — mean it."""
    with backend("demo") as fake:
        first, second = fake.add_org("Twin Textiles"), fake.add_org("Twin Textiles")

        async def call(tool, current=None, **args):
            return await tool_executor.execute_tool(
                tool, args, tool_executor.ExecCtx(tenant_id=TENANT, jwt_token="", role="Admin", current_org_id=current))

        asked = await call("get_group_scheme_status", organization_name="Twin Textiles")
        assert not asked["success"] and "More than one organization" in asked["error"]            # nothing chosen yet → ask
        for current in (first, second):
            res = await call("get_group_scheme_status", current=current, organization_name="Twin Textiles")
            assert "More than one organization" not in str(res.get("error", "")), res             # chosen → no question
            assert res.get("scheme", {}).get("organization_id", current) == current or res["success"] is False
        # No name at all also means the corporate being worked on.
        nameless = await call("get_group_scheme_status", current=second)
        assert "Which organization" not in str(nameless.get("error", "")) and "More than one" not in str(nameless.get("error", ""))
        # A current corporate that doesn't match the name does not hijack it.
        other = fake.add_org("Other Co")
        res = await call("get_group_scheme_status", current=first, organization_name="Other Co")
        assert "More than one" not in str(res.get("error", ""))
        print("PASS test_the_corporate_being_worked_on_settles_same_named_companies_without_asking")


@_sync
async def test_a_census_that_is_already_enrolled_is_not_asked_for_again():
    with backend("demo") as fake:
        await _live_scheme(fake, "Enrolled Co")                         # a finished scheme: its employees are enrolled
        for tool in ("upload_group_census", "submit_group_census"):
            res = await _call(tool, organization_name="Enrolled Co", use_demo_data=True)
            assert res["success"] and res.get("already_enrolled"), (tool, res)
            assert "already has its census" in res["message"] and not res.get("__client_execute__")
        n_before = len(fake.members[fake.only_scheme()["id"]])
        assert n_before > 0 and not any(c[1].endswith("/census/confirm") for c in fake.calls[-6:])
        print("PASS test_a_census_that_is_already_enrolled_is_not_asked_for_again")


@_sync
async def test_demo_data_for_a_corporate_builds_the_whole_scheme_and_hands_the_ui_its_summary():
    """Chat → Corporate → Add demo data: a company, its policy, classes and 10 enrolled employees, and the same
    organization_enrolled summary (with the id the Continue button needs) the full-detail form produces."""
    with backend("demo") as fake:
        res = await _call("add_organization", use_demo_data=True, no_agent=True)
        assert res["success"] and res["employees_enrolled"] == 10, res
        scheme = fake.only_scheme()
        assert len(fake.members[scheme["id"]]) == 10 and len(fake.classes[scheme["id"]]) == 3
        assert scheme["organization_id"] == res["organization_id"] and scheme["plan_code"] == "GROUP_LIFE"
        summary = res["organization_enrolled"]
        assert summary["organization_id"] == res["organization_id"] and summary["employee_count"] == 10 and summary["demo"] is True
        assert summary["name"] == fake.orgs[res["organization_id"]]["name"]
        roster = summary["employees"]          # the table the page shows under the summary
        assert len(roster) == 10 and all(r["name"] and r["benefit_class"] and r["coverage_amount"] for r in roster), roster
        assert {r["name"] for r in roster} == {m["name"] for m in fake.members[scheme["id"]]}
        assert "quick_actions" not in res or not res["quick_actions"]      # the buttons come from the UI summary, once
        assert "do NOT describe next steps" in res["message"]
        # A second call is a different company.
        again = await _call("add_organization", use_demo_data=True, no_agent=True)
        assert again["organization_id"] != res["organization_id"] and again["organization_name"] != res["organization_name"]
        print("PASS test_demo_data_for_a_corporate_builds_the_whole_scheme_and_hands_the_ui_its_summary")


@_sync
async def test_demo_corporate_is_all_or_nothing_and_demo_only():
    with backend("demo") as fake:
        fake.fail_paths.add("/census/confirm")
        res = await _call("add_organization", use_demo_data=True, no_agent=True)
        assert not res["success"] and "Nothing was saved" in res["error"]
        assert not fake.orgs and not fake.schemes, "the half-built company must be deleted again"
    with backend("prod") as fake:
        res = await _call("add_organization", use_demo_data=True, no_agent=True)
        assert not res["success"] and "demo mode" in res["error"] and not fake.orgs
        assert permission.missing_args("add_organization", {"use_demo_data": True}) == []     # no name is asked for
        assert permission.missing_args("add_organization", {}) == ["name"]
        print("PASS test_demo_corporate_is_all_or_nothing_and_demo_only")


def test_the_continue_button_calls_the_journey_directly_for_that_exact_company():
    """The button after a corporate is saved must not depend on the model: it resolves to a continue_group_journey
    call carrying the organization id, so a stale earlier answer can never stand in for the scheme's real status."""
    from langchain_core.messages import AIMessage, HumanMessage
    import graph
    oid = "62be3df6-029f-4c8c-a9be-9845922e7150"
    out = graph._direct_group_continue({"messages": [HumanMessage(content=f"Continue the group scheme journey for Meridian Textiles Ltd (organization id {oid})")]})
    call = out["messages"][0].tool_calls[0]
    assert isinstance(out["messages"][0], AIMessage) and call["name"] == "continue_group_journey"
    assert call["args"] == {"organization_name": "Meridian Textiles Ltd", "organization_id": oid}
    assert out["group_current_org_id"] == oid          # remembered for the rest of the conversation
    # Anything else goes to the model as usual.
    assert graph._direct_group_continue({"messages": [HumanMessage(content="Continue the group journey for Meridian Textiles Ltd")]}) is None
    assert graph._direct_group_continue({"messages": []}) is None
    print("PASS test_the_continue_button_calls_the_journey_directly_for_that_exact_company")


def test_group_tools_are_admin_only_even_the_read_ones():
    for tool in sorted(permission.GROUP_TOOLS):
        assert permission.is_role_allowed(tool, "Admin") and permission.is_role_allowed(tool, "SuperAdmin"), tool
        for role in ("Underwriter", "Agent", "Viewer", "ClaimsManager", "ClaimsAdjuster", "NobodyDefined"):
            assert not permission.is_role_allowed(tool, role), f"{role} may run {tool}"
    print("PASS test_group_tools_are_admin_only_even_the_read_ones")


def test_launch_tools_and_state_namespace():
    import graph
    assert graph.GROUP_JOURNEY_TOOLS == {"start_group_journey", "continue_group_journey"}
    assert [sid for sid, _ in group_journey.STAGES.values()] == [
        "group_scheme", "group_benefits", "group_census", "group_underwriting",
        "group_quote", "group_acceptance", "group_issuance", "group_enrolment"]
    keys = {k for k in ChatState.__annotations__ if k.startswith("group_")} | {"requires_group_intervention"}
    assert {"group_stage", "group_outcome", "group_audit", "group_error", "group_scheme"} <= keys
    print("PASS test_launch_tools_and_state_namespace")


def main():
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()


if __name__ == "__main__":
    main()


def test_a_picked_organization_id_stands_in_for_the_name():
    """After "which Demo Corporation?" the answer is an id — it must not be met with "missing organization_name"."""
    assert permission.missing_args("start_group_journey", {}) == ["organization_name"]
    assert permission.missing_args("start_group_journey", {"organization_id": "1691dc5f-af21"}) == []
    assert permission.missing_args("create_group_scheme", {"organization_id": "1691dc5f-af21"}) == []
    assert permission.missing_args("start_group_journey", {"organization_name": "Demo Corporation"}) == []
    # Other tools' requirements are untouched.
    assert permission.missing_args("add_organization", {"organization_id": "x"}) == ["name"]


@_sync
async def test_organizations_with_the_same_name_get_distinguishable_chips():
    with backend("demo") as fake:
        a, b = fake.add_org("Twin Corp"), fake.add_org("Twin Corp")
        res = await _call("get_group_scheme_status", organization_name="Twin Corp")
        labels = [x["label"] for x in res["quick_actions"]]
        assert len(labels) == 2 and len(set(labels)) == 2, labels                      # not two identical buttons
        assert labels[0] == f"Twin Corp · #{a[:8]}" and labels[1] == f"Twin Corp · #{b[:8]}"
        assert a not in "".join(labels)                                                # the short slice, never the whole id
        assert f"id {a}" in res["quick_actions"][0]["payload"]                         # the full id still travels in the answer
        print("PASS test_organizations_with_the_same_name_get_distinguishable_chips")
