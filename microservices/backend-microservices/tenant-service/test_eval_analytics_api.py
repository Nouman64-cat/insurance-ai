"""The cost analytics API against a running tenant-service with real tokens: who may read it, what it refuses, and the numbers it returns for runs this test builds.
Runs can never be deleted, so run this against the ISOLATED evaluation stack; it uses a random past year and datasets of its own.

Run: docker exec eval-tenant-service python test_eval_analytics_api.py
"""
import asyncio
import random
import sys
import uuid
from datetime import date, datetime, timedelta

import httpx
from sqlmodel import select

import database
from routers.auth import create_access_token
from shared.models.core import Role, User
from shared.models.evaluation import EvalCostLine, EvalRun
from test_eval_analytics import make_run

BASE = "http://localhost:8001"
FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


async def setup():
    ds = f"t-anapi-{uuid.uuid4().hex[:6]}"
    async with database._session_factory() as s:
        used = {d.year for d in (await s.exec(select(EvalRun.started_at))).all() if d} | {d.year for d in (await s.exec(select(EvalCostLine.incurred_at))).all()}
        year = random.choice([y for y in range(1960, 2000) if y not in used])          # runs and lines are permanent: a year this test used before is not used again
        sa = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
        admin = (await s.exec(select(User).where(User.role_id == sa.id, User.is_deleted == False))).first()  # noqa: E712
        other = (await s.exec(select(User).where(User.role_id != sa.id, User.is_deleted == False))).first()    # noqa: E712
        tokens = create_access_token({"sub": str(admin.id)}), create_access_token({"sub": str(other.id)})
        t0 = datetime(year, 4, 10, 9)
        await make_run(s, model="openai/gpt-4.1", dataset=ds, passed=36, failed=4, at=t0, group=f"bench-{ds}", lines=[("agent_llm", 0.80, None), ("judge", 0.20, "openai/gpt-4o")])
        await make_run(s, model="openai/gpt-4o-mini", dataset=ds, passed=45, failed=5, at=t0 + timedelta(minutes=4), group=f"bench-{ds}", lines=[("agent_llm", 0.30, None), ("judge", 0.20, "openai/gpt-4o")])
        for i, usd in enumerate((0.10, 0.10, 0.11, 0.09)):
            await make_run(s, model="openai/gpt-4o-mini", dataset=ds + "-b", passed=18, failed=2, at=datetime(year, 4, 20 + i, 9), lines=[("agent_llm", usd, None)])
        await make_run(s, model="openai/gpt-4o-mini", dataset=ds + "-b", passed=18, failed=2, at=datetime(year, 4, 25, 9), lines=[("agent_llm", 0.55, None)])
        await s.commit()
    return tokens, year, ds


async def main() -> int:
    (admin, other), year, ds = await setup()
    A, O = {"Authorization": f"Bearer {admin}"}, {"Authorization": f"Bearer {other}"}
    frm, to = f"{year}-04-01", f"{year}-04-30"
    async with httpx.AsyncClient(base_url=BASE, timeout=90) as c:
        for path in ("/eval/costs/trends", "/eval/costs/models", "/eval/costs/benchmarks", "/eval/costs/anomalies", "/eval/costs/recommendations"):
            check(f"anonymous callers are refused ({path})", (await c.get(path)).status_code == 401)
            check(f"an ordinary user is refused ({path})", (await c.get(path, headers=O)).status_code == 403)
        for what, path, params in (("an unknown bucket", "/eval/costs/trends", {"bucket": "year"}), ("an unknown grouping", "/eval/costs/trends", {"group_by": "colour"}), ("a window that ends first", "/eval/costs/trends", {"from": "2001-05-10", "to": "2001-05-01"}),
                                   ("a window of many years", "/eval/costs/anomalies", {"from": "1990-01-01", "to": "2026-01-01"}), ("an unknown mode", "/eval/costs/models", {"mode": "magic"})):
            check(f"refused: {what}", (await c.get(path, headers=A, params=params)).status_code == 422)

        m = (await c.get("/eval/costs/models", headers=A, params={"dataset": ds})).json()
        g = {x["model"]: x for x in m["sets"][0]["models"]}
        check("the comparison has one set for the dataset with both models, cheapest per passed test first", len(m["sets"]) == 1 and [x["model"] for x in m["sets"][0]["models"]] == ["openai/gpt-4o-mini", "openai/gpt-4.1"], m["sets"][0]["models"][0]["label"] if m["sets"] else m)
        check("cost per passed test is all-in over the tests passed", abs(g["openai/gpt-4.1"]["per_passed_usd"] - 1.0 / 36) < 1e-9 and abs(g["openai/gpt-4o-mini"]["per_passed_usd"] - 0.5 / 45) < 1e-9)
        check("each configuration carries quality with its interval, reliability, latency and error rate", all(k in g["openai/gpt-4.1"] for k in ("pass_rate", "ci_low", "ci_high", "consistency", "latency_p50_ms", "latency_p95_ms", "error_rate", "total_usd", "judge_usd")))
        check("the cheaper equal model is recommended with its evidence", any(r["kind"] == "cheaper_equivalent" and r["evidence"]["runs"] and r["estimated_saving_usd"] > 0 for r in m["sets"][0]["recommendations"]), m["sets"][0]["recommendations"])
        check("the reply explains how to read cost per passed test", "divided by the tests it passed" in m["how_to_read"])

        b = (await c.get("/eval/costs/benchmarks", headers=A)).json()
        mine = next(x for x in b["benchmarks"] if x["benchmark_id"] == f"bench-{ds}")
        check("a benchmark's total spending is listed with each model's share", abs(mine["total_usd"] - 1.5) < 1e-9 and len(mine["models"]) == 2 and b["total_usd"] >= 1.5)

        t = (await c.get("/eval/costs/trends", headers=A, params={"from": frm, "to": to, "group_by": "component"})).json()
        day10 = next(p for p in t["points"] if p["start"] == f"{year}-04-10")
        check("trends: a day's money by component, every day of the window present", len(t["points"]) == 30 and abs(day10["total_usd"] - 1.5) < 1e-9 and day10["by_group"]["judge"] == 0.4 and t["groups"] == ["agent_llm", "judge"], day10)
        w = (await c.get("/eval/costs/trends", headers=A, params={"from": frm, "to": to, "bucket": "week"})).json()
        check("by week the same money adds up", abs(w["total_usd"] - t["total_usd"]) < 1e-9 and len(w["points"]) >= 4)

        a = (await c.get("/eval/costs/anomalies", headers=A, params={"from": frm, "to": to})).json()
        flagged = [x for x in a["anomalies"] if x["kind"] == "run_cost"]
        check("the run that cost far more than its four earlier runs is flagged, with the numbers it was compared with", len(flagged) == 1 and flagged[0]["ratio"] >= 4 and flagged[0]["baseline"] and "earlier runs" in flagged[0]["message"], a["anomalies"][:2])
        check("the reply says by which rules and what it looked at", a["checked"]["runs"] >= 6 and "run_cost" in a["rules"])

        r = (await c.get("/eval/costs/recommendations", headers=A, params={"from": frm, "to": to})).json()
        check("recommendations list their evidence and caveats, and change nothing", r["count"] == len(r["recommendations"]) and all("evidence" in x and "caveats" in x for x in r["recommendations"]) and "Nothing here changes" in r["principle"])
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
