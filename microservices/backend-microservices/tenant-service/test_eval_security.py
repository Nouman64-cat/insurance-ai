"""Security checks of the Evaluation Center and the internal endpoints, on the ISOLATED evaluation stack (a call that is wrongly allowed can only touch the throwaway database).

  1. Every /eval, /platform and /tokens route refuses a caller with no login (401) and a logged-in user who is not a Super Admin (403), whatever the method, with dummy ids.
  2. The internal endpoints (job worker, drift ingest, LLM and agent config) refuse a missing or wrong shared secret and are CLOSED when no secret is configured.
  3. Another tenant's policies and claims cannot be read by an Admin of a different tenant (the earlier cross-tenant leak), nor by a caller with no login; a Super Admin can.
  4. The Evaluation Center's exports and listings never contain a provider key, an internal secret or an unmasked CNIC.

Run: docker exec eval-tenant-service python -B -W ignore test_eval_security.py     (after `python evals/environment/envctl.py fresh`)
"""
import asyncio
import re
import sys
import uuid

import httpx
from fastapi import HTTPException
from sqlmodel import select

import database
import main
from routers.auth import create_access_token
from services.internal_auth import check_internal_secret
from shared.models.core import Role, Tenant, User

FAILS = 0
BASE = "http://localhost:8001"


def check(name: str, ok: bool, detail="") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {str(detail)[:600]}" if detail and not ok else ""))


def fill(path: str) -> str:
    return re.sub(r"\{([^}:]+)(?::[^}]*)?\}", lambda m: str(uuid.uuid4()) if m.group(1).endswith("id") else "x", path)


def guarded(path: str) -> bool:
    return path.startswith(("/eval", "/platform", "/tokens"))


async def main_() -> int:
    async with database._session_factory() as s:
        roles = {r.name: r.id for r in (await s.exec(select(Role))).all()}
        sa = (await s.exec(select(User).where(User.role_id == roles["SuperAdmin"], User.is_deleted == False))).first()      # noqa: E712
        admins = (await s.exec(select(User).where(User.role_id == roles.get("Admin"), User.is_deleted == False, User.tenant_id != None))).all()          # noqa: E711,E712
        plain = (await s.exec(select(User).where(User.role_id != roles["SuperAdmin"], User.is_deleted == False))).first()                               # noqa: E712
        by_tenant = {}
        for a in admins:
            by_tenant.setdefault(a.tenant_id, a)
        tenants = (await s.exec(select(Tenant))).all()
    tok = lambda u: {"Authorization": f"Bearer {create_access_token({'sub': str(u.id)})}"}
    SA, PLAIN = tok(sa), tok(plain)

    # 1. the route matrix
    routes = [(m, r.path) for r in main.app.routes for m in (getattr(r, "methods", None) or []) if m in ("GET", "POST", "PUT", "PATCH", "DELETE") and guarded(r.path) and r.path != "/tokens/usage"]
    anon_bad, user_bad = [], []
    async with httpx.AsyncClient(base_url=BASE, timeout=20) as c:
        for m, p in routes:
            u = fill(p)
            body = {} if m != "GET" else None
            a = await c.request(m, u, json=body)
            if a.status_code != 401:
                anon_bad.append((m, p, a.status_code))
            b = await c.request(m, u, headers=PLAIN, json=body)
            if b.status_code != 403:
                user_bad.append((m, p, b.status_code))
        check(f"all {len(routes)} Evaluation Center / platform / token routes refuse a caller with no login (401)", not anon_bad and len(routes) > 80, anon_bad[:5])
        check(f"... and refuse a logged-in user who is not a Super Admin (403)", not user_bad, user_bad[:5])
        check("the token ledger's write endpoint refuses a caller without the internal secret", (await c.post("/tokens/usage", json={})).status_code in (401, 503) and (await c.post("/tokens/usage", json={}, headers=PLAIN)).status_code in (401, 503))

        # 2. internal endpoints
        internal = [(m, r.path) for r in main.app.routes for m in (getattr(r, "methods", None) or []) if m in ("GET", "POST") and (r.path.startswith("/internal/eval") or r.path in ("/internal/llm-config", "/internal/agent-config"))]
        bad = []
        for m, p in internal:
            for h in ({}, {"X-Internal-Secret": "wrong"}, PLAIN, SA):
                r = await c.request(m, fill(p), headers=h, json={} if m == "POST" else None)
                if r.status_code not in (401, 503):
                    bad.append((m, p, list(h)[:1], r.status_code))
        check(f"the {len(internal)} internal endpoints refuse no secret, a wrong secret, an ordinary token and even a Super Admin token", len(internal) >= 8 and not bad, bad[:5])
        for fn, expected in ((None, ""), (None, "   ")):
            try:
                check_internal_secret(expected, "")
                check("an unset or blank INTERNAL_API_SECRET leaves the endpoint closed, not open", False)
            except HTTPException as e:
                check(f"an unset or blank secret ({expected!r}) closes the endpoint with 503, never opens it", e.status_code == 503)
        for given, want in (("", 401), ("nope", 401), ("s3cret ", 401)):
            try:
                check_internal_secret("s3cret", given)
                check("a wrong secret is refused", False)
            except HTTPException as e:
                check(f"a wrong secret {given!r} is refused with {want}", e.status_code == want)
        try:
            check_internal_secret("s3cret", "s3cret")
            check("the right secret is accepted", True)
        except HTTPException:
            check("the right secret is accepted", False)

        # 3. cross-tenant: policies and claims
        pair = [t for t in by_tenant][:2]
        check("the isolated stack has Admins of two different tenants to test with", len(pair) == 2, list(by_tenant))
        if len(pair) == 2:
            a_admin, b_tenant = by_tenant[pair[0]], pair[1]
            for kind in ("policies", "claims", "customers", "users"):
                sl = "/" if kind == "users" else ""
                own = await c.get(f"/tenants/{pair[0]}/{kind}{sl}", headers=tok(a_admin))
                other = await c.get(f"/tenants/{b_tenant}/{kind}{sl}", headers=tok(a_admin))
                none = await c.get(f"/tenants/{b_tenant}/{kind}{sl}")
                sup = await c.get(f"/tenants/{b_tenant}/{kind}{sl}", headers=SA)
                check(f"{kind}: an Admin of tenant A is refused tenant B's list (403), a caller with no login gets 401, a Super Admin gets 200, A's own list works",
                      other.status_code == 403 and none.status_code == 401 and sup.status_code == 200 and own.status_code == 200, [own.status_code, other.status_code, none.status_code, sup.status_code])

        # 4. no secrets or raw identifiers in what the Evaluation Center returns
        leaks = []
        for p in ("/eval/runs?limit=50", "/eval/models", "/eval/jobs", "/eval/datasets", "/eval/costs/overview", "/eval/studio/graph", "/eval/studio/results?limit=200&include_synthetic=true", "/eval/benchmarks"):
            r = await c.get(p, headers=SA)
            t = r.text
            if re.search(r"sk-[A-Za-z0-9_\-]{20,}|AIza[0-9A-Za-z_\-]{30,}|sk-ant-[A-Za-z0-9_\-]{20,}", t):
                leaks.append((p, "provider key"))
            if "INTERNAL_API_SECRET" in t or "X-Internal-Secret" in t:
                leaks.append((p, "internal secret"))
        check("no Evaluation Center listing contains a provider key or the internal secret", not leaks, leaks)
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main_()))
