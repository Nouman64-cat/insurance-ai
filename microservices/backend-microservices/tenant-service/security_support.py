"""Shared helpers for the router security tests (run on the ISOLATED evaluation stack only: they call routes that must refuse, and a route that wrongly allows can then change only the throwaway database).

  w = await world()                       tokens for each role of tenant A, the admin of tenant B, a Super Admin, an expired and a garbage token
  await expect(c, w, "GET", "/x", {...})  runs one request as each caller and compares the status with what is expected for that caller

Callers: anon, garbage, expired, and <role>_a / admin_b / superadmin. `expected` maps caller -> status or a set of acceptable statuses; a caller not listed must be refused (401 for no or bad credentials, 403 otherwise)."""
import re
import uuid
from datetime import datetime, timedelta

from jose import jwt
from sqlmodel import select

import database
from routers.auth import ALGORITHM, SECRET_KEY, create_access_token
from shared.models.core import Role, Tenant, User

FAILS = 0


def check(name, ok, detail=""):
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {str(detail)[:700]}" if detail and not ok else ""))
    return ok


def fails():
    return FAILS


def fill(path, **ids):
    return re.sub(r"\{([^}:]+)(?::[^}]*)?\}", lambda m: str(ids.get(m.group(1)) or uuid.uuid4()), path)


async def world():
    async with database._session_factory() as s:
        roles = {r.id: r.name for r in (await s.exec(select(Role))).all()}
        tenants = (await s.exec(select(Tenant).order_by(Tenant.name))).all()
        users = (await s.exec(select(User).where(User.is_deleted == False))).all()                  # noqa: E712
    a, b = tenants[0], tenants[1]
    by = {}
    for u in users:
        by.setdefault((u.tenant_id, roles[u.role_id]), u)
    bearer = lambda u: {"Authorization": "Bearer " + create_access_token({"sub": str(u.id)})}
    callers = {"anon": {}, "garbage": {"Authorization": "Bearer not.a.token"},
               "expired": {"Authorization": "Bearer " + jwt.encode({"sub": str(by[(a.id, "Admin")].id), "exp": datetime.utcnow() - timedelta(minutes=5)}, SECRET_KEY, algorithm=ALGORITHM)},
               "superadmin": bearer(next(u for u in users if roles[u.role_id] == "SuperAdmin")), "admin_b": bearer(by[(b.id, "Admin")]), "agent_b": bearer(by[(b.id, "Agent")])}
    for (tid, role), u in by.items():
        if tid == a.id:
            callers[role.lower().replace(" ", "_") + "_a"] = bearer(u)
    return {"a": a.id, "b": b.id, "callers": callers, "users": by, "roles": roles}


def refused(who):
    return {401} if who in ("anon", "garbage", "expired") else {403}


async def expect(c, w, method, path, body=None, allow=None, ids=None, callers=None, label=None):
    """Runs the request as each caller. `allow` maps caller -> acceptable statuses (int or set) for callers that are permitted; every other caller must be refused. Returns the list of failures."""
    allow = allow or {}
    bad = []
    for who in callers or w["callers"]:
        r = await c.request(method, fill(path, tenant_id=w["a"], **(ids or {})), headers=w["callers"][who], json=body if method != "GET" else None)
        ok_set = allow.get(who)
        ok_set = {ok_set} if isinstance(ok_set, int) else ok_set
        if ok_set is not None:
            good = r.status_code in ok_set
        else:
            good = r.status_code in refused(who)
        if not good:
            bad.append((who, r.status_code, (ok_set or refused(who))))
    if label is not None:
        check(label, not bad, bad)
    return bad
