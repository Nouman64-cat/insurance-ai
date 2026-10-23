"""Integration tests of the evaluation environment, run against the live isolated stack, inside eval-runner:

    python evals/environment/envctl.py test            # (wraps) python -m evals.tools.test_environment_integration

They cover what the unit tests cannot: reset and cleanup, idempotent seeding, stable ids, results surviving a reset, real logins
as every fixture role, role permissions, tenant isolation, the token ledger's authentication, usage attribution against the
real ledger, and that the worker cannot reach production or the internet.

Outcomes: ok, FAIL, and DEFECT. A DEFECT is a real problem in the application that the environment has found and nobody has fixed yet:
the test asserts that the harness *detects* it and says so (the table KNOWN_DEFECTS, empty today). A defect is never reported as a pass.
The three defects found on 2026-10-22 are fixed and are now ordinary regression tests (t_policies_need_a_login..., t_claims_are_closed...,
t_unknown_customer_values_stay_unknown, t_token_usage_reads_are_authorised).
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
import time
from pathlib import Path
from typing import Callable, Dict, List

import httpx
from sqlalchemy import text

from shared.evaluation import environment as env_lib
from shared.evaluation.safety import EvaluationGuardError, assert_evaluation_database
from shared.evaluation.usage import UsageMeter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from http_runner import API, OUTPUT, Environment  # noqa: E402

KNOWN_DEFECTS: Dict[str, str] = {}        # defects found and not yet fixed: name -> description (a test then returns Result("DEFECT", ...))


class Result:
    def __init__(self, status: str, detail: str = "") -> None:
        self.status, self.detail = status, detail


class Stack:
    """A seeded stack and a client, shared by the tests that only read."""

    def __init__(self) -> None:
        self.env = Environment()
        self.client = httpx.AsyncClient(timeout=60.0)
        self.tokens: Dict[str, str] = {}

    async def fresh(self) -> None:
        await self.env.fresh()
        self.tokens.clear()

    async def headers(self, user_ref: str | None) -> Dict[str, str]:
        if user_ref is None:
            return {}
        if user_ref not in self.tokens:
            r = await self.client.post(f"{API}/auth/token", data={"username": f"{user_ref}@eval.invalid", "password": os.environ["EVAL_USER_PASSWORD"]})
            assert r.status_code == 200, f"login as {user_ref}: {r.status_code}"
            self.tokens[user_ref] = r.json()["access_token"]
        return {"Authorization": f"Bearer {self.tokens[user_ref]}"}

    def tenant(self, ref: str) -> str:
        return self.env.ids["tenant"][ref]

    async def get(self, user: str | None, tenant_ref: str, path: str) -> httpx.Response:
        return await self.client.get(f"{API}/tenants/{self.tenant(tenant_ref)}/{path}", headers=await self.headers(user))

    def canaries(self) -> List[str]:
        return list(self.env.world.canaries)

    def leaks(self, response: httpx.Response) -> bool:
        return any(c in response.text for c in self.canaries())


async def counts(stack: Stack) -> Dict[str, int]:
    from sqlalchemy import text
    async with stack.env.engine.connect() as conn:
        tables = [r[0] for r in await conn.execute(text("select tablename from pg_tables where schemaname='public' and tablename <> 'eval_environment_marker' order by 1"))]
        return {t: (await conn.execute(text(f'select count(*) from public."{t}"'))).scalar_one() for t in tables}


# ── guards and containment ───────────────────────────────────────────────────────────────────────────────────────────────

async def t_the_worker_refuses_a_production_database(stack: Stack) -> None:
    prod = "postgresql+asyncpg://postgres:x@host.docker.internal:5432/insurance_ai"
    try:
        assert_evaluation_database(prod, env={})
    except EvaluationGuardError:
        pass
    else:
        raise AssertionError("the production URL was accepted")
    # and the live process is on an allowed evaluation database
    assert_evaluation_database(os.environ["DATABASE_URL"])


async def t_the_worker_cannot_reach_production_or_the_internet(stack: Stack) -> None:
    def blocked(host: str, port: int) -> bool:
        try:
            socket.create_connection((host, port), timeout=3).close()
            return False
        except OSError:
            return True
    reachable = [t for t, (h, p) in {"internet": ("1.1.1.1", 443), "host database": ("host.docker.internal", 5432),
                                     "production tenant-service": ("insurance-tenant-service", 8001), "production kafka": ("kafka", 9092)}.items()
                 if not blocked(h, p)]
    assert not reachable, f"the evaluation worker can reach: {', '.join(reachable)}"


async def t_a_wrong_marker_token_is_refused(stack: Stack) -> None:
    async with stack.env.engine.connect() as conn:
        await env_lib.require_marker(conn)
        try:
            await env_lib.require_marker(conn, env={"EVAL_MARKER_TOKEN": "someone-elses-token"})
        except EvaluationGuardError:
            return
    raise AssertionError("a different token was accepted")


# ── reset, seeding, cleanup ──────────────────────────────────────────────────────────────────────────────────────────────

async def t_reset_returns_to_the_exact_baseline(stack: Stack) -> None:
    await stack.fresh()
    seeded = await counts(stack)
    assert seeded["users"] == 14 and seeded["tenants"] == 2, seeded
    async with stack.env.engine.begin() as conn:
        await env_lib.reset(conn)
    async with stack.env.engine.connect() as conn:
        report = await env_lib.verify_clean(conn)
    assert report.ok, report.problems
    after = await counts(stack)
    assert after["users"] == after["tenants"] == after["customers"] == after["policies"] == 0, after
    assert after["roles"] == 8 and after["rule_sets"] > 0, "the application's own reference data must survive a reset"


async def t_seeding_twice_changes_nothing(stack: Stack) -> None:
    await stack.fresh()
    first = await counts(stack)
    from sqlmodel.ext.asyncio.session import AsyncSession
    from shared.evaluation import seeding
    async with AsyncSession(stack.env.engine, expire_on_commit=False) as s:
        await seeding.seed(s, stack.env.world, password_hash=stack.env._hash)
        await s.commit()
    second = await counts(stack)
    assert first == second, {k: (first[k], second[k]) for k in first if first[k] != second[k]}


async def t_ids_are_the_same_after_a_reset(stack: Stack) -> None:
    await stack.fresh()
    before = json.dumps(stack.env.ids, sort_keys=True)
    await stack.fresh()
    assert json.dumps(stack.env.ids, sort_keys=True) == before


async def t_a_run_leaves_nothing_behind_for_the_next(stack: Stack) -> None:
    await stack.fresh()
    r = await stack.client.post(f"{API}/tenants/{stack.tenant('tenant-a')}/customers", headers=await stack.headers("agent-a1"),
                                json={"cnic": "35202-1122334-4", "date_of_birth": "1992-02-10", "declared_income": 900000, "first_name": "Leftover",
                                      "last_name": "Check", "gender": "Female", "occupation": "Teacher"})
    assert r.status_code == 201
    await stack.client.post(f"{API}/tokens/usage", headers={"X-Internal-Secret": os.environ["INTERNAL_API_SECRET"]},
                            json={"service_name": "Leftover", "input_tokens": 1, "output_tokens": 1, "total_tokens": 2})
    await stack.fresh()
    after = await counts(stack)
    assert after["customers"] == 15, "the customer created by the previous run is still there"      # only the 15 seeded ones
    assert after["token_usage"] == 0, "usage from the previous run is still in the ledger"


async def t_results_survive_a_reset(stack: Stack) -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    marker = OUTPUT / f"survives-reset-{int(time.time())}.json"
    marker.write_text(json.dumps({"cost": {"calls": 1, "input_tokens": 900}}), encoding="utf-8")
    await stack.fresh()
    assert marker.exists() and json.loads(marker.read_text())["cost"]["calls"] == 1
    marker.unlink()


# ── logins, roles, tenants ───────────────────────────────────────────────────────────────────────────────────────────────

async def t_every_fixture_user_can_log_in_with_their_role(stack: Stack) -> None:
    await stack.fresh()
    wrong = []
    for u in stack.env.world.users:
        r = await stack.client.post(f"{API}/auth/token", data={"username": f"{u['ref']}@eval.invalid", "password": os.environ["EVAL_USER_PASSWORD"]})
        if r.status_code != 200:
            wrong.append(f"{u['ref']}: {r.status_code}")
    bad = await stack.client.post(f"{API}/auth/token", data={"username": "agent-a1@eval.invalid", "password": "not-the-password"})
    assert bad.status_code == 401
    assert not wrong, wrong


async def t_roles_decide_what_a_user_may_do(stack: Stack) -> None:
    body = {"cnic": "35202-1122334-4", "date_of_birth": "1992-02-10", "declared_income": 900000, "first_name": "Role", "last_name": "Check",
            "gender": "Female", "occupation": "Teacher"}
    url = f"{API}/tenants/{stack.tenant('tenant-a')}/customers"
    await stack.fresh()
    viewer = await stack.client.post(url, json=body, headers=await stack.headers("viewer-a1"))
    assert viewer.status_code == 403, f"a Viewer must not create a customer, got {viewer.status_code}"
    agent = await stack.client.post(url, json=body, headers=await stack.headers("agent-a1"))
    assert agent.status_code == 201, f"an Agent creates a customer, got {agent.status_code}"
    assert (await stack.get("finance-a1", "tenant-a", "claims/payments")).status_code == 200
    assert (await stack.get("adjuster-a1", "tenant-a", "claims/payments")).status_code == 403, "only Finance reads the payment register"
    assert (await stack.get("admin-a1", "tenant-a", "claims/payments")).status_code == 403


async def t_tenant_data_is_protected_where_the_application_protects_it(stack: Stack) -> None:
    await stack.fresh()
    for user, path in (("admin-a1", "customers"), ("agent-a1", "customers"), ("finance-a1", "claims/payments"), ("admin-b1", "customers")):
        other = "tenant-b" if user.endswith("a1") else "tenant-a"
        r = await stack.get(user, other, path)
        assert r.status_code == 403 and not stack.leaks(r), f"{user} read {other}/{path}: {r.status_code}"
    for path in ("customers", "claims/payments", "claims"):
        r = await stack.get(None, "tenant-b", path)
        assert r.status_code == 401 and not stack.leaks(r), f"anonymous read tenant-b/{path}: {r.status_code}"
    own = await stack.get("admin-b1", "tenant-b", "customers")
    assert own.status_code == 200 and stack.leaks(own), "tenant B's own admin must see tenant B's canary customer: the canary works"
    mine = await stack.get("admin-a1", "tenant-a", "customers")
    assert mine.status_code == 200 and not stack.leaks(mine), "tenant A must never see tenant B's canaries"


# ── regression tests of the defects this environment found (fixed 2026-10-22) ────────────────────────────────────────────

async def t_policies_need_a_login_and_the_callers_own_tenant(stack: Stack) -> None:
    await stack.fresh()
    for path in ("policies", "policies/stats"):
        anonymous = await stack.get(None, "tenant-b", path)
        assert anonymous.status_code == 401 and not stack.leaks(anonymous), f"anonymous {path}: {anonymous.status_code}"
    for user in ("admin-a1", "agent-a1", "finance-a1", "viewer-a1"):
        other = await stack.get(user, "tenant-b", "policies")
        assert other.status_code == 403 and not stack.leaks(other), f"{user} read tenant B's policies: {other.status_code}"
    # tenant B's policy by id, asked by a user of tenant A, through the path of tenant B
    policy_b = stack.env.ids["policy"]["pol-canary-b1"]
    cross = await stack.get("admin-a1", "tenant-b", f"policies/{policy_b}")
    assert cross.status_code == 403 and not stack.leaks(cross), f"cross-tenant policy by id: {cross.status_code}"
    anonymous_one = await stack.get(None, "tenant-b", f"policies/{policy_b}")
    assert anonymous_one.status_code == 401, f"anonymous policy by id: {anonymous_one.status_code}"


async def t_legitimate_policy_access_still_works(stack: Stack) -> None:
    await stack.fresh()
    for user, tenant in (("admin-a1", "tenant-a"), ("agent-a1", "tenant-a"), ("uw-a1", "tenant-a"), ("admin-b1", "tenant-b"), ("superadmin-1", "tenant-a"), ("superadmin-1", "tenant-b")):
        r = await stack.get(user, tenant, "policies")
        assert r.status_code == 200 and isinstance(r.json(), list) and r.json(), f"{user} on {tenant}: {r.status_code}"
    own = await stack.get("admin-b1", "tenant-b", "policies")
    assert stack.leaks(own) or "Canary" in own.text or own.json(), "tenant B's own admin must still see tenant B's policies"
    a_view = await stack.get("admin-a1", "tenant-a", "policies")
    assert not stack.leaks(a_view), "tenant A's list must never contain tenant B's records"
    one = await stack.get("uw-a1", "tenant-a", f"policies/{stack.env.ids['policy']['pol-declined-omar']}")
    assert one.status_code == 200 and one.json()["status"] == "Declined"


async def t_claims_are_closed_to_other_tenants(stack: Stack) -> None:
    await stack.fresh()
    for user in ("admin-a1", "adjuster-a1", "claims-mgr-a1", "finance-a1"):
        other = await stack.get(user, "tenant-b", "claims")
        assert other.status_code == 403 and not stack.leaks(other), f"{user} read tenant B's claims: {other.status_code}"
    claim_b = stack.env.ids["claim"]["claim-canary-b1"]
    by_id = await stack.get("adjuster-a1", "tenant-b", f"claims/{claim_b}")
    assert by_id.status_code == 403 and not stack.leaks(by_id), f"a claim of tenant B by id, asked by tenant A's adjuster: {by_id.status_code}"
    assert (await stack.get(None, "tenant-b", "claims")).status_code == 401
    assert (await stack.get("agent-a1", "tenant-a", "claims")).status_code == 403, "an Agent has no claims access in its own tenant either"


async def t_legitimate_claims_access_still_works(stack: Stack) -> None:
    await stack.fresh()
    for user in ("admin-a1", "adjuster-a1", "claims-mgr-a1", "finance-a1"):
        r = await stack.get(user, "tenant-a", "claims")
        assert r.status_code == 200, f"{user} on their own tenant's claims: {r.status_code}"
    assert (await stack.get("superadmin-1", "tenant-b", "claims")).status_code == 200, "a SuperAdmin keeps cross-tenant reach"
    assert stack.leaks(await stack.get("admin-b1", "tenant-b", "claims")), "tenant B's own admin must still see tenant B's claims"
    own = await stack.get("adjuster-a1", "tenant-a", f"claims/{stack.env.ids['claim']['claim-hospital-faisal-500001']}")
    assert own.status_code == 200


async def t_unknown_customer_values_stay_unknown(stack: Stack) -> None:
    await stack.fresh()
    url = f"{API}/tenants/{stack.tenant('tenant-a')}/customers"
    body = {"cnic": "35202-1122334-4", "date_of_birth": "1992-02-10", "declared_income": 900000, "first_name": "Zara", "last_name": "Iqbal",
            "gender": "Female", "occupation": "Teacher"}
    created = await stack.client.post(url, json=body, headers=await stack.headers("agent-a1"))
    assert created.status_code == 201, created.text
    answer = created.json()
    assert (answer["is_smoker"], answer["height_cm"], answer["weight_kg"]) == (None, None, None), f"answer: {answer['is_smoker']}, {answer['height_cm']}, {answer['weight_kg']}"
    async with stack.env.engine.connect() as conn:
        row = (await conn.execute(text("select is_smoker, height_cm, weight_kg from customers where cnic = '35202-1122334-4'"))).one()
    assert tuple(row) == (None, None, None), f"stored: {tuple(row)}"
    # what the agent DID give is kept exactly
    given = {**body, "cnic": "35202-2233445-5", "first_name": "Given", "is_smoker": True, "height_cm": 181.5, "weight_kg": 77.25}
    kept = (await stack.client.post(url, json=given, headers=await stack.headers("agent-a1"))).json()
    assert (kept["is_smoker"], kept["height_cm"], kept["weight_kg"]) == (True, 181.5, 77.25)
    # an explicit "not a smoker" is a value, not an unknown
    no = (await stack.client.post(url, json={**body, "cnic": "35202-3344556-6", "first_name": "No", "is_smoker": False}, headers=await stack.headers("agent-a1"))).json()
    assert no["is_smoker"] is False and no["height_cm"] is None


async def t_token_usage_reads_are_authorised(stack: Stack) -> None:
    await stack.fresh()
    url, params = f"{API}/tokens/usage", {"start_date": "2020-01-01", "end_date": "2099-12-31"}
    tenant_a = stack.tenant("tenant-a")
    assert (await stack.client.get(url, params=params)).status_code == 401, "anonymous read"
    assert (await stack.client.get(url, params={**params, "tenant_id": tenant_a})).status_code == 401, "anonymous tenant read"
    for user in ("agent-a1", "admin-a1", "viewer-a1", "finance-a1"):
        r = await stack.client.get(url, params=params, headers=await stack.headers(user))
        assert r.status_code == 403, f"{user} read the platform-wide spend: {r.status_code}"
    own = await stack.client.get(url, params={**params, "tenant_id": tenant_a}, headers=await stack.headers("admin-a1"))
    assert own.status_code == 200, f"a tenant Admin reads their own tenant's spend: {own.status_code}"
    assert (await stack.client.get(url, params={**params, "tenant_id": tenant_a}, headers=await stack.headers("agent-a1"))).status_code == 403
    assert (await stack.client.get(url, params={**params, "tenant_id": stack.tenant("tenant-b")}, headers=await stack.headers("admin-a1"))).status_code == 403
    everything = await stack.client.get(url, params=params, headers=await stack.headers("superadmin-1"))
    assert everything.status_code == 200 and "data" in everything.json(), "the Token Economy page's call keeps working for SuperAdmin"
    # writing still needs the internal secret and still works with it
    payload = {"service_name": "Read Check", "input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
    assert (await stack.client.post(url, json=payload)).status_code == 401
    assert (await stack.client.post(url, json=payload, headers={"X-Internal-Secret": os.environ["INTERNAL_API_SECRET"]})).status_code == 200
    after = await stack.client.get(url, params=params, headers=await stack.headers("superadmin-1"))
    assert any("Read Check" in day for day in after.json()["data"].values()), "a recorded row shows in the SuperAdmin's read"


# ── the token ledger and usage attribution ───────────────────────────────────────────────────────────────────────────────

async def t_the_token_ledger_accepts_only_internal_callers(stack: Stack) -> None:
    await stack.fresh()
    payload = {"service_name": "Ledger Auth Test", "input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
    url = f"{API}/tokens/usage"
    assert (await stack.client.post(url, json=payload)).status_code == 401
    assert (await stack.client.post(url, json=payload, headers={"X-Internal-Secret": "wrong"})).status_code == 401
    ledger = await stack.env.ledger()
    assert not ledger, "a rejected request must not leave a row"
    assert (await stack.client.post(url, json=payload, headers={"X-Internal-Secret": os.environ["INTERNAL_API_SECRET"]})).status_code == 200
    assert len(await stack.env.ledger()) == 1


async def t_usage_is_attributed_to_the_execution_that_caused_it(stack: Stack) -> None:
    await stack.fresh()
    meter = UsageMeter(stack.env.ledger, quiet_seconds=0.4, max_wait_seconds=5.0)
    secret = {"X-Internal-Secret": os.environ["INTERNAL_API_SECRET"]}

    async def write(delay: float, model: str) -> None:
        await asyncio.sleep(delay)
        await stack.client.post(f"{API}/tokens/usage", headers=secret, json={"service_name": "OCR Engine", "model_name": model, "input_tokens": 900,
                                                                            "output_tokens": 40, "total_tokens": 940})
    mark = await meter.begin("exec-1")
    asyncio.create_task(write(0.5, "gpt-4o-mini"))                      # recorded after the caller already has its reply
    result = await meter.end(mark, expected_min_calls=1)
    assert result.status == "attributed" and result.calls == 1 and result.input_tokens == 900, result.as_dict()
    second = await meter.begin("exec-2")                                # the next execution does not inherit the first one's row
    nothing = await meter.end(second, expected_min_calls=0)
    assert nothing.status == "attributed" and nothing.calls == 0
    missing = await meter.begin("exec-3")
    unknown = await meter.end(missing, expected_min_calls=1, reported_tokens={"total": 940})
    assert unknown.status == "missing" and unknown.calls is None, "a reply with no ledger row must be unknown cost, not free"


TESTS: List[Callable] = [
    t_the_worker_refuses_a_production_database, t_the_worker_cannot_reach_production_or_the_internet, t_a_wrong_marker_token_is_refused,
    t_reset_returns_to_the_exact_baseline, t_seeding_twice_changes_nothing, t_ids_are_the_same_after_a_reset,
    t_a_run_leaves_nothing_behind_for_the_next, t_results_survive_a_reset, t_every_fixture_user_can_log_in_with_their_role,
    t_roles_decide_what_a_user_may_do, t_tenant_data_is_protected_where_the_application_protects_it,
    t_policies_need_a_login_and_the_callers_own_tenant, t_legitimate_policy_access_still_works,
    t_claims_are_closed_to_other_tenants, t_legitimate_claims_access_still_works, t_unknown_customer_values_stay_unknown,
    t_token_usage_reads_are_authorised,
    t_the_token_ledger_accepts_only_internal_callers, t_usage_is_attributed_to_the_execution_that_caused_it,
]


async def main() -> int:
    stack = Stack()
    tally = {"ok": 0, "FAIL": 0, "DEFECT": 0}
    try:
        await stack.fresh()
        for test in TESTS:
            started = time.monotonic()
            try:
                outcome = await test(stack)
                status, detail = (outcome.status, outcome.detail) if isinstance(outcome, Result) else ("ok", "")
            except AssertionError as exc:
                status, detail = "FAIL", str(exc)
            except Exception as exc:                      # noqa: BLE001 — an unexpected error is a failure of the test run, reported as such
                status, detail = "FAIL", f"{type(exc).__name__}: {exc}"
            tally[status] += 1
            print(f"{status:6} {test.__name__[2:]:68} {time.monotonic() - started:5.1f}s" + (f"\n         {detail}" if detail else ""))
        await stack.fresh()                               # leave the environment clean for whoever uses it next
    finally:
        await stack.client.aclose()
        await stack.env.close()
    print(f"\n{len(TESTS)} integration tests: {tally['ok']} ok, {tally['DEFECT']} known application defects detected, {tally['FAIL']} failed")
    return 1 if tally["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
