"""Cost analytics on real tables (Phase 7, M5), inside one transaction that is rolled back. The runs built here use datasets of their own and dates in 2001, so nothing
depends on or touches the real spending; the real runs are only used by the last checks, which read them without changing anything.

Run: docker exec insurance-tenant-service python test_eval_analytics.py
"""
import asyncio
import sys
import uuid
from datetime import date, datetime, timedelta

from sqlmodel import select

import database
from services import eval_analytics as an
from services import eval_budget
from shared.models.core import User
from shared.models.evaluation import EvalBudgetLimit, EvalCaseResult, EvalCostLine, EvalMetricScore, EvalRun

FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


async def make_run(s, *, model, dataset, version="9.9.9", passed, failed, lines, at, synthetic=False, group=None, tokens=None, unknown_exec=0, judge="openai/gpt-4o", repetitions=1, mode="agent",
                   infra=0, case_prefix="C"):
    """A completed run with its results and cost lines. `lines`: [(component, usd or None, model_or_None)]."""
    run_id = f"t-an-{uuid.uuid4().hex[:10]}"
    run = EvalRun(run_id=run_id, state="ingesting", kind="benchmark_agent" if group else "suite", model_id=model, provider=model.split("/")[0], synthetic_model=synthetic, dataset_slug=dataset, dataset_version=version,
                  repetitions=repetitions, executions=passed + failed + infra, passed=passed, failed=failed, infrastructure_errors=infra, known_cost_usd=sum(u for _, u, _ in lines if u is not None),
                  unknown_cost_executions=unknown_exec, started_at=at, finished_at=at, config={"mode": mode, "model_id": model}, group_id=group, judge_model=judge, skills_enabled=None)
    s.add(run)
    await s.flush()
    n = passed + failed
    for i in range(n):
        s.add(EvalCaseResult(run_row_id=run.id, case_key=f"{case_prefix}-{i:03d}", repetition=1, status="passed" if i < passed else "failed", latency_ms=1000 + 10 * i, cost_usd=0.001, cost_known=True,
                             input_tokens=(tokens or 1000), output_tokens=100, cached_tokens=0, model_id=model, operation="chat", usage={"status": "attributed", "calls": 1}))
    for i in range(infra):
        s.add(EvalCaseResult(run_row_id=run.id, case_key=f"{case_prefix}-x{i:03d}", repetition=1, status="infrastructure_error", reason="timeout", cost_known=True, operation="chat"))
    await s.flush()
    run.state = "complete"
    s.add(run)
    await s.flush()
    for comp, usd, m in lines:
        s.add(EvalCostLine(run_id=run_id, case_id=None, component=comp, provider=model.split("/")[0], model=m or model.split("/")[1], unit_kind="tokens", input_units=1000, output_units=100, cached_units=0, usd=usd,
                           cost_kind="unknown" if usd is None else "estimated", source="test", usage_ref=uuid.uuid4().hex[:40], incurred_at=at))
    await s.flush()
    return run_id


async def main() -> int:
    async with database._session_factory() as s:
        try:
            uid = (await s.exec(select(User.id).limit(1))).first()
            ds = f"t-an-{uuid.uuid4().hex[:6]}"
            t0 = datetime(2001, 3, 5, 10)
            a = await make_run(s, model="openai/gpt-4.1", dataset=ds, passed=36, failed=4, at=t0, group="bench-t-1", lines=[("agent_llm", 0.80, None), ("judge", 0.20, "openai/gpt-4o"), ("retry", 0.10, None)], infra=1)
            b = await make_run(s, model="openai/gpt-4o-mini", dataset=ds, passed=45, failed=5, at=t0 + timedelta(minutes=5), group="bench-t-1", lines=[("agent_llm", 0.30, None), ("judge", 0.20, "openai/gpt-4o")])
            c = await make_run(s, model="openai/gpt-4o", dataset=ds, passed=12, failed=28, at=t0 + timedelta(minutes=9), group="bench-t-1", lines=[("agent_llm", 2.0, None)])
            d = await make_run(s, model="gemini/gemini-2.5-flash", dataset=ds, passed=30, failed=10, at=t0 + timedelta(minutes=12), group="bench-t-1", lines=[("agent_llm", 0.4, None), ("agent_llm", None, "gemini-9-future")], unknown_exec=3)
            m = await make_run(s, model="mock/mock-oracle", dataset=ds, passed=40, failed=0, at=t0 + timedelta(minutes=15), synthetic=True, lines=[("agent_llm", 0.0, None)])
            res = await an.models(s, dataset=ds)
            check("one comparison set per dataset version and mode, with only real models", len(res["sets"]) == 1 and res["sets"][0]["mode"] == "agent" and {g["model"] for g in res["sets"][0]["models"]} == {"openai/gpt-4.1", "openai/gpt-4o-mini", "openai/gpt-4o", "gemini/gemini-2.5-flash"})
            g = {x["model"]: x for x in res["sets"][0]["models"]}
            check("scripted models are left out unless asked for", all("mock" not in x["model"] for x in res["sets"][0]["models"]) and any("mock" in x["model"] for x in (await an.models(s, dataset=ds, include_synthetic=True))["sets"][0]["models"]))
            check("quality is the pass rate over executions that ran, with its interval", abs(g["openai/gpt-4.1"]["pass_rate"] - 0.9) < 1e-9 and g["openai/gpt-4.1"]["ran"] == 40 and 0.76 < g["openai/gpt-4.1"]["ci_low"] < 0.78 and 0.95 < g["openai/gpt-4.1"]["ci_high"] < 0.97, g["openai/gpt-4.1"])
            check("what a PASSED test cost is everything the configuration cost (model, judge AND retries) over the tests it passed", abs(g["openai/gpt-4.1"]["total_usd"] - 1.10) < 1e-9 and abs(g["openai/gpt-4.1"]["per_passed_usd"] - 1.10 / 36) < 1e-9, g["openai/gpt-4.1"])
            check("the judge's share and the model's own cost are shown separately", abs(g["openai/gpt-4.1"]["judge_usd"] - 0.20) < 1e-9 and abs(g["openai/gpt-4.1"]["candidate_usd"] - 0.90) < 1e-9 and g["openai/gpt-4.1"]["by_component"]["retry"]["usd"] == 0.1)
            check("executions that failed with an infrastructure error are an error rate, not a failed test", g["openai/gpt-4.1"]["infrastructure_errors"] == 1 and g["openai/gpt-4.1"]["error_rate"] is not None and g["openai/gpt-4.1"]["ran"] == 40)
            check("latency percentiles come from the executions that ran", g["openai/gpt-4.1"]["latency_p50_ms"] and g["openai/gpt-4.1"]["latency_p95_ms"] > g["openai/gpt-4.1"]["latency_p50_ms"])
            check("a configuration with an unpriced line has NO cost per passed test (never a figure that hides it) and says how many lines", g["gemini/gemini-2.5-flash"]["per_passed_usd"] is None and g["gemini/gemini-2.5-flash"]["unknown_lines"] == 1)
            fr = set(res["sets"][0]["frontier"])
            check("the frontier holds the cheap good model; the dear one and the poor one are dominated", "openai/gpt-4o-mini" in fr and "openai/gpt-4.1" not in fr and "openai/gpt-4o" not in fr and g["openai/gpt-4o"]["dominated_by"], res["sets"][0]["frontier"])
            recs_ = {r["id"].split(":", 3)[0] + ":" + r["id"].split(":", 3)[-1]: r for r in res["sets"][0]["recommendations"]}
            cheaper = next((r for r in res["sets"][0]["recommendations"] if r["kind"] == "cheaper_equivalent"), None)
            check("it recommends the cheaper model that cannot be told apart, with the saving worked out", cheaper is not None and "openai/gpt-4o-mini gave comparable results to openai/gpt-4.1" in cheaper["title"]
                  and abs(cheaper["estimated_saving_usd"] - round((1.10 / 36 - 0.50 / 45) * 36, 4)) < 1e-9, res["sets"][0]["recommendations"])
            dom = [r for r in res["sets"][0]["recommendations"] if r["kind"] == "dominated_model"]
            check("and flags the model that is clearly worse and no cheaper, once", len(dom) == 1 and dom[0]["title"].startswith("openai/gpt-4o is worse"), dom)
            check("no recommendation rests on the unpriced configuration", all("gemini" not in r["title"] for r in res["sets"][0]["recommendations"]))
            check("a different dataset is a different comparison set", (await an.models(s, dataset="no-such-dataset"))["sets"] == [])

            bs = await an.benchmark_spending(s)
            mine = next(x for x in bs["benchmarks"] if x["benchmark_id"] == "bench-t-1")
            check("a benchmark's cost is the sum of its models' runs, listed per model", abs(mine["total_usd"] - (1.10 + 0.50 + 2.0 + 0.4)) < 1e-9 and len(mine["models"]) == 4 and mine["unknown_lines"] == 1, mine)
            check("the benchmark spending across all benchmarks includes it", bs["total_usd"] >= mine["total_usd"] and bs["count"] >= 1)

            tr = await an.trends(s, start=date(2001, 3, 4), end=date(2001, 3, 7), bucket="day", group_by="component")
            check("trends: the day's money by component, empty days filled, scripted models left out, the unpriced line counted", [p["start"] for p in tr["points"]] == ["2001-03-04", "2001-03-05", "2001-03-06", "2001-03-07"]
                  and abs(tr["points"][1]["total_usd"] - (1.10 + 0.50 + 2.0 + 0.4)) < 1e-9 and tr["points"][1]["by_group"]["judge"] == 0.4 and tr["points"][0]["total_usd"] == 0.0 and tr["unknown_lines"] == 1, tr["points"][1])
            check("trends by provider split the day between the providers", (await an.trends(s, start=date(2001, 3, 5), end=date(2001, 3, 5), group_by="provider"))["points"][0]["by_group"] == {"gemini": 0.4, "openai": 3.6})
            wk = await an.trends(s, start=date(2001, 3, 1), end=date(2001, 3, 31), bucket="week")
            check("trends by week and month add the same money up", abs(wk["total_usd"] - tr["total_usd"]) < 1e-9 and abs((await an.trends(s, start=date(2001, 3, 1), end=date(2001, 3, 31), bucket="month"))["total_usd"] - tr["total_usd"]) < 1e-9)

            # anomalies: five runs of one configuration, the last far dearer, with waste, an unpriced run and a runaway execution
            ds2 = f"t-an2-{uuid.uuid4().hex[:6]}"
            ids = []
            for i, usd in enumerate((0.10, 0.10, 0.11, 0.09)):
                ids.append(await make_run(s, model="openai/gpt-4o-mini", dataset=ds2, passed=18, failed=2, at=datetime(2001, 6, 1 + i, 9), lines=[("agent_llm", usd, None)], tokens=8000))
            bad = await make_run(s, model="openai/gpt-4o-mini", dataset=ds2, passed=18, failed=2, at=datetime(2001, 6, 8, 9), lines=[("agent_llm", 0.45, None), ("retry", 0.20, None)], tokens=90000)
            unp = await make_run(s, model="openai/gpt-4.1", dataset=ds2, passed=9, failed=1, at=datetime(2001, 6, 9, 9), lines=[("agent_llm", None, "gpt-9")], unknown_exec=4)
            an_ = await an.anomalies(s, start=date(2001, 6, 1), end=date(2001, 6, 30))
            by_kind = {}
            for x in an_["anomalies"]:
                by_kind.setdefault(x["kind"], []).append(x)
            check("a run costing several times its earlier runs is flagged with the numbers", [x["subject"]["run_id"] for x in by_kind.get("run_cost", [])] == [bad] and by_kind["run_cost"][0]["ratio"] >= 5, by_kind.get("run_cost"))
            check("the cheap runs before it are not flagged", not any(x["subject"].get("run_id") in ids for x in an_["anomalies"]))
            check("retries that are a large share of a run are flagged as waste", [x["subject"]["run_id"] for x in by_kind.get("waste", [])] == [bad], by_kind.get("waste"))
            check("a run whose executions could not be priced is flagged", [x["subject"]["run_id"] for x in by_kind.get("unpriced", [])] == [unp])
            check("an execution using far more tokens than the same case did before is flagged", any(x["subject"]["run_id"] == bad and x["observed"] == 90100 and x["baseline"] == 8100 for x in by_kind.get("token_outlier", [])), by_kind.get("token_outlier", [])[:1])
            check("the anomaly check says what it looked at and by which rules", an_["checked"]["runs"] >= 6 and "run_cost" in an_["rules"])
            quiet = await an.anomalies(s, start=date(2001, 9, 1), end=date(2001, 9, 30))
            check("a window with no activity has no anomalies", quiet["anomalies"] == [] and quiet["checked"]["runs"] == 0)

            # recommendations: waste, the judge, a budget that will be passed
            spend_start = date(2001, 3, 1)
            lim = EvalBudgetLimit(period="month", limit_usd=1.0, warn_at_pct=80, enforce=True, set_by=uid, reason="test limit", effective_from=datetime(2001, 1, 1))
            s.add(lim)
            await s.flush()
            recs = await an.recommendations(s, start=date(2001, 3, 1), end=date(2001, 6, 30), today=date(2001, 6, 10))
            ids_ = {r["id"] for r in recs["recommendations"]}
            check("recommendations gather the model advice and the spending advice, each with evidence and caveats", any(i.startswith("cheaper:") for i in ids_) and "waste" in ids_ and all("evidence" in r and "caveats" in r for r in recs["recommendations"]))
            check("they carry a saving only where one can be worked out, and say how", all((r["estimated_saving_usd"] is None) or r["saving_basis"] for r in recs["recommendations"]))
            check("they never change anything: the principle is stated", "Nothing here changes" in recs["principle"])
            ordered = [r.get("estimated_saving_usd") or 0.0 for r in recs["recommendations"]]
            check("the biggest saving comes first", ordered == sorted(ordered, reverse=True))
        finally:
            await s.rollback()
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
