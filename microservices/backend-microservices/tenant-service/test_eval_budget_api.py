"""The budget API against a running tenant-service with real tokens (a Super Admin and an ordinary user). Limit changes are append-only, so run this
against the ISOLATED evaluation stack; it leaves both limits removed (with a reason) at the end.

Run: docker exec eval-tenant-service python test_eval_budget_api.py
"""
import asyncio
import sys

import httpx
from sqlmodel import select

import database
from routers.auth import create_access_token
from shared.models.core import Role, User

BASE = "http://localhost:8001"
FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


async def tokens():
    async with database._session_factory() as s:
        sa = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
        admin = (await s.exec(select(User).where(User.role_id == sa.id, User.is_deleted == False))).first()  # noqa: E712
        other = (await s.exec(select(User).where(User.role_id != sa.id, User.is_deleted == False))).first()    # noqa: E712
        return create_access_token({"sub": str(admin.id)}), create_access_token({"sub": str(other.id)}), str(admin.id)


async def main() -> int:
    admin, other, admin_id = await tokens()
    A, O = {"Authorization": f"Bearer {admin}"}, {"Authorization": f"Bearer {other}"}
    async with httpx.AsyncClient(base_url=BASE, timeout=30) as c:
        check("anonymous callers are refused", (await c.get("/eval/budget")).status_code == 401)
        check("an ordinary user cannot read the budget", (await c.get("/eval/budget", headers=O)).status_code == 403)
        check("an ordinary user cannot change it", (await c.put("/eval/budget/day", headers=O, json={"limit_usd": 1, "reason": "x"})).status_code == 403)
        r = await c.get("/eval/budget", headers=A)
        check("the budget shows both periods with spent, reserved and status", r.status_code == 200 and set(r.json()["periods"]) == {"day", "month"} and {"spent_usd", "reserved_usd", "status", "limit_usd"} <= set(r.json()["periods"]["day"]), r.text[:300])
        for what, body in (("no reason", {"limit_usd": 1}), ("a blank reason", {"limit_usd": 1, "reason": "  "}), ("a negative limit", {"limit_usd": -1, "reason": "x"}), ("a warning level of 0", {"limit_usd": 1, "warn_at_pct": 0, "reason": "x"}), ("a warning level over 100", {"limit_usd": 1, "warn_at_pct": 101, "reason": "x"})):
            check(f"refused: {what}", (await c.put("/eval/budget/day", headers=A, json=body)).status_code == 422)
        check("refused: an unknown period", (await c.put("/eval/budget/week", headers=A, json={"limit_usd": 1, "reason": "x"})).status_code == 422)
        r = await c.put("/eval/budget/day", headers=A, json={"limit_usd": 5.0, "warn_at_pct": 70, "enforce": True, "reason": "api test: daily limit"})
        d = r.json()
        check("a limit is set with its reason, and the status shows it at once", r.status_code == 200 and d["status"]["periods"]["day"]["limit_usd"] == 5.0 and d["status"]["periods"]["day"]["warn_at_pct"] == 70 and d["status"]["periods"]["day"]["reason"] == "api test: daily limit", r.text[:300])
        check("the month is untouched by a day change", d["status"]["periods"]["month"]["limit_usd"] != 5.0)
        check("the status records who set it", d["status"]["periods"]["day"]["set_by"] == admin_id)
        await c.put("/eval/budget/month", headers=A, json={"limit_usd": 20, "reason": "api test: monthly limit", "enforce": False})
        h = (await c.get("/eval/budget/history", headers=A)).json()["changes"]
        check("the history lists each change, newest first, with who and why", len(h) >= 2 and h[0]["reason"] == "api test: monthly limit" and h[0]["set_by"] == admin_id and any(x["reason"] == "api test: daily limit" for x in h), h[:3])
        r = await c.put("/eval/budget/day", headers=A, json={"limit_usd": None, "reason": "api test: removed"})
        check("a limit can be removed (history keeps it)", r.status_code == 200 and r.json()["status"]["periods"]["day"]["limit_usd"] is None and r.json()["status"]["periods"]["day"]["status"] == "no_limit")
        await c.put("/eval/budget/month", headers=A, json={"limit_usd": None, "reason": "api test: removed"})
        check("after removing both, nothing is limited", (await c.get("/eval/budget", headers=A)).json()["status"] == "no_limit")
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
