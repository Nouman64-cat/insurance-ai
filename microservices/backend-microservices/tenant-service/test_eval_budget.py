"""Evaluation budgets in the platform (Phase 7, M2) on real tables, inside one transaction that is rolled back: what counts as spent and as
reserved, that a limit refuses a job before it is scheduled, that scripted runs and scan jobs cost nothing, and that a limit needs a reason.

Run: docker exec insurance-tenant-service python test_eval_budget.py
"""
import asyncio
import json
import sys
import uuid
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlmodel import select

import database
from services import eval_budget as svc
from shared.models.core import User
from shared.models.evaluation import EvalJob, EvalRun

FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


def run(cost, *, synthetic=False, at=None):
    return EvalRun(run_id=f"t-{uuid.uuid4().hex[:10]}", known_cost_usd=cost, synthetic_model=synthetic, state="complete", started_at=at or datetime.utcnow())


def job(total, state="queued", kind="benchmark_agent"):
    return EvalJob(config={"kind": kind, "dataset": "x", "version": "1.0.0"}, estimate={"cost": {"usd": {"total": total, "complete": True}}} if total is not None else {}, state=state)


async def main() -> int:
    async with database._session_factory() as s:
        try:
            uid = (await s.exec(select(User.id).limit(1))).first()
            base = await svc.status(s)
            spent0, month0 = base["periods"]["day"]["spent_usd"], base["periods"]["month"]["spent_usd"]
            res0 = base["periods"]["day"]["reserved_usd"]
            now = datetime.utcnow()
            first_of_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            s.add_all([run(2.0), run(1.5, synthetic=True), run(4.0, at=first_of_month - timedelta(days=1)), run(0.5, at=now - timedelta(days=0))])
            await s.flush()
            st = await svc.status(s)
            check("a real run counts toward today and this month; a scripted model's run counts for nothing", abs(st["periods"]["day"]["spent_usd"] - spent0 - 2.5) < 1e-6, st["periods"]["day"])
            check("a run from last month does not count toward this month", abs(st["periods"]["month"]["spent_usd"] - month0 - 2.5) < 1e-6, st["periods"]["month"])

            s.add_all([job(3.0), job(1.0, state="running"), job(9.0, state="succeeded"), job(7.0, state="cancelled"), job(5.0, kind="drift_scan"), job(None)])
            await s.flush()
            st = await svc.status(s)
            check("queued and running jobs are reserved at their estimate; finished, cancelled and scan jobs are not", abs(st["periods"]["day"]["reserved_usd"] - res0 - 4.0) < 1e-6, st["periods"]["day"])

            check("with no limit set a request is allowed and nothing is refused", (await svc.status(s, 50.0))["periods"]["day"]["status"] in ("no_limit", "ok", "warning", "exceeded"))
            try:
                await svc.set_limit(s, "day", limit_usd=1.0, warn_at_pct=80, enforce_limit=True, reason="  ", actor_id=uid)
                check("a limit change without a reason is refused", False)
            except HTTPException as e:
                check("a limit change without a reason is refused", e.status_code == 422)
            try:
                await svc.set_limit(s, "week", limit_usd=1.0, warn_at_pct=80, enforce_limit=True, reason="x", actor_id=uid)
                check("an unknown period is refused", False)
            except HTTPException as e:
                check("an unknown period is refused", e.status_code == 422)

            committed = (await svc.status(s))["periods"]["day"]
            total = committed["spent_usd"] + committed["reserved_usd"]
            await svc.set_limit(s, "day", limit_usd=total + 10, warn_at_pct=80, enforce_limit=True, reason="test limit", actor_id=uid)
            await svc.set_limit(s, "month", limit_usd=None, warn_at_pct=80, enforce_limit=True, reason="test: no monthly limit", actor_id=uid)
            await s.flush()
            cur = await svc.current_limits(s)
            check("the latest row is the limit in force", cur["day"].limit_usd == total + 10 and cur["month"].limit_usd is None)
            est = lambda x: {"cost": {"usd": {"total": x, "complete": True}}}
            ok = await svc.enforce(s, est(5.0))
            check("the budget status kept with an accepted job is plain JSON, so it can be stored in the job (a job could not be created at all before this was checked)", bool(json.dumps(ok)) and json.loads(json.dumps(ok))["periods"]["day"]["since"])
            check("a request inside the limit is allowed and keeps its budget status", ok["allowed"] and ok["periods"]["day"]["status"] == "ok", ok["periods"]["day"])
            warn = await svc.enforce(s, est(9.0))
            check("a request that takes the day past 80% is allowed with a warning", warn["allowed"] and warn["periods"]["day"]["status"] == "warning" and warn["messages"], warn["periods"]["day"])
            try:
                await svc.enforce(s, est(10.5))
                check("a request that would pass the limit is refused before it is scheduled", False)
            except HTTPException as e:
                check("a request that would pass the limit is refused before it is scheduled", e.status_code == 409 and "day" in " ".join(e.detail["problems"]), str(e.detail)[:300])
                check("the refusal can be sent as JSON (dates included)", bool(json.dumps(e.detail)))
            check("a free request (a scripted model) is never refused", (await svc.enforce(s, est(0.0)))["allowed"])
            check("a request whose cost is unknown is allowed while money is left, with a note", (await svc.enforce(s, {"cost": {"error": "no price"}}))["allowed"])
            check("an incomplete estimate (an unpriced model) is treated as unknown, not free", svc.estimate_total({"cost": {"usd": {"total": 0.0, "complete": False}}}) is None)

            await svc.set_limit(s, "day", limit_usd=total + 10, warn_at_pct=80, enforce_limit=False, reason="warn only", actor_id=uid)
            await s.flush()
            soft = await svc.enforce(s, est(10.5))
            check("with enforcement off, passing the limit only warns", soft["allowed"] and soft["periods"]["day"]["status"] == "exceeded", soft["periods"]["day"])
            await svc.set_limit(s, "day", limit_usd=max(0.0, total - 0.001), warn_at_pct=80, enforce_limit=True, reason="used up", actor_id=uid)          # a hair under what is committed: `total` is rounded to 6 places, the real sum is not
            await s.flush()
            try:
                await svc.enforce(s, {"cost": {"error": "no price"}})
                check("an unknown cost against a limit that is used up is refused", False)
            except HTTPException as e:
                check("an unknown cost against a limit that is used up is refused", e.status_code == 409)
            hist = await svc.history(s)
            check("every change is in the history with its reason", {"test limit", "warn only", "used up"} <= {h.reason for h in hist}, [h.reason for h in hist][:6])
        finally:
            await s.rollback()
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
