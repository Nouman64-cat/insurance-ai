"""A job that is already running is stopped when a daily or monthly limit would be passed (Phase 7 gap 2). On real tables, in one transaction that is rolled back, then through
the worker's own events endpoint on the ISOLATED stack (limit changes are append-only, so the HTTP part leaves both limits removed with a reason).

Run: docker exec insurance-tenant-service python test_eval_budget_running.py        (the database part)
     docker exec eval-tenant-service python test_eval_budget_running.py --http      (the endpoint part)
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime

import httpx
from sqlmodel import select

import database
from services import eval_budget as svc
from shared.models.core import Role, User
from shared.models.evaluation import EvalBudgetLimit, EvalJob, EvalJobEvent

FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


def job(state="running", estimate=2.0, kind="benchmark_agent"):
    return EvalJob(config={"kind": kind, "dataset": "x", "version": "1.0.0"}, estimate={"cost": {"usd": {"total": estimate, "complete": True}}}, state=state, worker_id="w-test", started_at=datetime.utcnow())


def case(j, seq, **data):
    return EvalJobEvent(job_id=j.id, seq=seq, kind="case", message="c", data=data)


async def database_part() -> None:
    async with database._session_factory() as s:
        try:
            uid = (await s.exec(select(User.id).limit(1))).first()
            base = await svc.status(s)
            used = base["periods"]["day"]["spent_usd"] + base["periods"]["day"]["reserved_usd"]
            j = job(estimate=2.0)
            s.add(j)
            await s.flush()
            s.add_all([case(j, 1, cost_usd=0.10, judge_cost_usd=0.05, total_cost_usd=0.40), case(j, 2, cost_usd=0.20), case(j, 3, status="passed")])      # the first carries the full total; the second an older event with the model cost only
            await s.flush()
            check("what a job has spent is added up from its own case events: the full total when the event has one, the model's cost otherwise", abs(await svc.running_spend(s, j.id) - 0.60) < 1e-9, str(await svc.running_spend(s, j.id)))
            v = await svc.check_running(s, j)
            check("with no limit set a running job is never stopped", v["allowed"] is True and v["job_spent_usd"] == 0.6)
            await svc.set_limit(s, "day", limit_usd=used + 0.3, warn_at_pct=80, enforce_limit=True, reason="test: a limit the job will pass", actor_id=uid)
            await s.flush()
            v = await svc.check_running(s, j)
            check("a job is stopped when its REAL spend (not its estimate) takes the day past an enforced limit", v["allowed"] is False and "day" in v["refused_by"], str(v["messages"]))
            check("the message says which limit and why", any("day" in m and "above" in m for m in v["messages"]), str(v["messages"]))
            await svc.set_limit(s, "day", limit_usd=used + 5.0, warn_at_pct=80, enforce_limit=True, reason="test: a roomy limit", actor_id=uid)
            await s.flush()
            check("a job well inside the limit keeps running (its estimate of 2.0 is not counted on top of what it really spent)", (await svc.check_running(s, j))["allowed"] is True)
            await svc.set_limit(s, "day", limit_usd=used + 0.1, warn_at_pct=80, enforce_limit=False, reason="test: warn only", actor_id=uid)
            await s.flush()
            soft = await svc.check_running(s, j)
            check("with enforcement off, passing the limit only warns: the job keeps running", soft["allowed"] is True and soft["periods"]["day"]["status"] == "exceeded")
            await svc.set_limit(s, "day", limit_usd=used + 0.1, warn_at_pct=80, enforce_limit=True, reason="test: enforced again", actor_id=uid)
            other = job(state="queued", estimate=3.0)
            s.add(other)
            await s.flush()
            await s.flush()
            both = await svc.check_running(s, j)
            check("other queued or running jobs' estimates stay reserved against the limit while this one runs", both["periods"]["day"]["reserved_usd"] >= 3.0, str(both["periods"]["day"]))
            free = job(estimate=0.0)
            s.add(free)
            await s.flush()
            check("a job that has spent nothing (a scripted model) is never stopped, even past a limit", (await svc.check_running(s, free))["allowed"] is True)
            scan = job(kind="drift_scan")
            s.add(scan)
            await s.flush()
            s.add(case(scan, 1, total_cost_usd=99.0))
            await s.flush()
            check("a drift scan is not an evaluation spend and is never stopped by a budget", (await svc.check_running(s, scan))["allowed"] is True)
        finally:
            await s.rollback()


async def http_part() -> None:
    secret = os.environ.get("INTERNAL_API_SECRET", "")
    async with database._session_factory() as s:
        sa = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
        admin = (await s.exec(select(User).where(User.role_id == sa.id, User.is_deleted == False))).first()      # noqa: E712
        from routers.auth import create_access_token
        token = create_access_token({"sub": str(admin.id)})
        j = job(estimate=1.0)
        s.add(j)
        await s.commit()
        job_id = str(j.id)
    A, S = {"Authorization": f"Bearer {token}"}, {"X-Internal-Secret": secret}
    async with httpx.AsyncClient(base_url="http://localhost:8001", timeout=60) as c:
        try:
            st = (await c.get("/eval/budget", headers=A)).json()
            used = st["periods"]["day"]["spent_usd"] + st["periods"]["day"]["reserved_usd"]       # includes this job's own 1.0 estimate, which is replaced by what it really spent
            r = await c.put("/eval/budget/day", headers=A, json={"limit_usd": used - 1.0 + 0.5, "reason": "http test: a limit the running job will pass", "enforce": True})
            check("a daily limit is set", r.status_code == 200)
            ok = await c.post(f"/internal/eval/jobs/{job_id}/events", headers=S, json={"worker_id": "w-test", "events": [{"kind": "case", "message": "a", "data": {"model": "openai/gpt-4o-mini", "status": "passed", "total_cost_usd": 0.10}}]})
            check("a case under the limit leaves the job running", ok.status_code == 200 and ok.json()["cancel_requested"] is False, ok.text)
            over = await c.post(f"/internal/eval/jobs/{job_id}/events", headers=S, json={"worker_id": "w-test", "events": [{"kind": "case", "message": "b", "data": {"model": "openai/gpt-4o-mini", "status": "passed", "total_cost_usd": 0.60}}]})
            check("the case that takes the spending past the limit makes the platform ask the worker to stop (the worker acts on this at its next heartbeat)", over.status_code == 200 and over.json()["cancel_requested"] is True, over.text)
            ev = (await c.get(f"/eval/jobs/{job_id}/events", headers=A, params={"after": 0})).json()
            check("the job's log says it was stopped by the spending limit, and why", any("stopped by the spending limit" in (e.get("message") or "") and e["data"].get("stopped_by") == "budget" for e in ev), str(ev)[-400:])
            again = await c.post(f"/internal/eval/jobs/{job_id}/events", headers=S, json={"worker_id": "w-test", "events": [{"kind": "case", "message": "c", "data": {"status": "passed", "total_cost_usd": 0.05}}]})
            after = (await c.get(f"/eval/jobs/{job_id}/events", headers=A, params={"after": 0})).json()
            n = sum(1 for e in after if "stopped by the spending limit" in (e.get("message") or ""))
            check("it is asked to stop once, not on every later event", again.json()["cancel_requested"] is True and n == 1, str(n))
        finally:
            await c.post(f"/internal/eval/jobs/{job_id}/finish", headers=S, json={"worker_id": "w-test", "state": "cancelled"})
            await c.put("/eval/budget/day", headers=A, json={"limit_usd": None, "reason": "http test finished: limit removed"})


async def main() -> int:
    await (http_part() if "--http" in sys.argv else database_part())
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
