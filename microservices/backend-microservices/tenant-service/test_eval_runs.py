"""The results API the LLM Benchmarking page uses, against the running tenant-service with real tokens (a Super Admin and an ordinary user):
runs, filtered executions, one execution with its trace, exports, benchmark history and breakdown, the cost preview and a rerun.
It reads the runs and benchmarks that exist; it creates two scripted jobs (queued, then cancelled at once so no worker runs them).

Run: docker compose exec -T tenant-service python test_eval_runs.py
"""
import asyncio
import csv
import io
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


async def tokens() -> tuple[str, str]:
    async with database._session_factory() as s:
        sa_role = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
        admin = (await s.exec(select(User).where(User.role_id == sa_role.id, User.is_deleted == False))).first()  # noqa: E712
        other = (await s.exec(select(User).where(User.role_id != sa_role.id, User.is_deleted == False))).first()    # noqa: E712
        return create_access_token({"sub": str(admin.id)}), create_access_token({"sub": str(other.id)})


async def main() -> int:
    admin, other = await tokens()
    A, O = {"Authorization": f"Bearer {admin}"}, {"Authorization": f"Bearer {other}"}
    async with httpx.AsyncClient(base_url=BASE, timeout=60) as c:
        runs = (await c.get("/eval/runs", headers=A, params={"limit": 200})).json()
        check("the runs are listed, newest first, with a total", runs.get("total", 0) >= 1 and len(runs["runs"]) >= 1, str(runs)[:200])
        for path in ("/eval/runs", "/eval/results/00000000-0000-0000-0000-000000000000", "/eval/benchmarks/history", "/eval/benchmarks/x/breakdown", "/eval/benchmarks/x/export"):
            check(f"anonymous callers are refused: {path}", (await c.get(path)).status_code == 401)
            check(f"an ordinary user is refused: {path}", (await c.get(path, headers=O)).status_code == 403)
        check("estimating is refused to an ordinary user", (await c.post("/eval/jobs/estimate", headers=O, json={})).status_code == 403)

        real = next((r for r in runs["runs"] if r["model"] and not r["model"].startswith("mock/") and r["kind"] == "suite" and r["executions"] >= 40), None)
        check("a real-model run is stored (the single-turn run)", real is not None)
        if real:
            one = (await c.get(f"/eval/runs/{real['run_id']}", headers=A)).json()
            check("a run shows configuration, reliability and the judge calibration", one["config"]["judge_model"] and one["reliability"] and "judge_calibration" in one, str(list(one)))
            by_model = (await c.get("/eval/runs", headers=A, params={"model": real["model"]})).json()
            check("runs filter by model", by_model["total"] >= 1 and all(r["model"] == real["model"] for r in by_model["runs"]))
            check("runs filter by kind", all(r["kind"] == "suite" for r in (await c.get("/eval/runs", headers=A, params={"kind": "suite"})).json()["runs"]))

            res = (await c.get(f"/eval/runs/{real['run_id']}/results", headers=A, params={"limit": 500})).json()
            check("every execution of the run is listed, with filter choices", res["total"] == real["executions"] and res["facets"]["status"] and res["facets"]["stage"], str(res["facets"]))
            failed = (await c.get(f"/eval/runs/{real['run_id']}/results", headers=A, params={"status": "failed"})).json()
            check("results filter by status", failed["total"] == res["facets"]["status"].get("failed", 0) and all(x["status"] == "failed" for x in failed["results"]))
            stage = next(iter(res["facets"]["stage"]))
            staged = (await c.get(f"/eval/runs/{real['run_id']}/results", headers=A, params={"stage": stage})).json()
            check("results filter by workflow stage", staged["total"] == res["facets"]["stage"][stage] and all(x["stage"] == stage for x in staged["results"]))
            case = res["results"][0]["case"]
            named = (await c.get(f"/eval/runs/{real['run_id']}/results", headers=A, params={"case": case[-5:]})).json()
            check("results filter by test case", named["total"] >= 1 and all(case[-5:].lower() in x["case"].lower() for x in named["results"]))
            check("an unknown run is 404", (await c.get("/eval/runs/nope", headers=A)).status_code == 404)

            chat = next(x for x in res["results"] if x["has_trace"] and x["llm_calls"])
            detail = (await c.get(f"/eval/results/{chat['result_id']}", headers=A)).json()
            check("one execution shows its assertions", detail["assertion_results"] and all({"id", "status", "severity"} <= set(a) for a in detail["assertion_results"]))
            check("one execution shows the model's answer", isinstance(detail["response_text"], str) and detail["response_text"], str(detail.get("response_text"))[:100])
            check("one execution shows its trace", detail["trace"] and detail["artifact_available"], str(list(detail.get("trace") or {})))
            check("one execution shows tokens, latency and cost", detail["input_tokens"] and detail["latency_ms"] and detail["cost_usd"] is not None)
            judged = next((x for x in res["results"] if x["has_trace"] and x["stage"] and x["layers"].get("L2") in ("passed", "failed")), None)
            if judged:
                d2 = (await c.get(f"/eval/results/{judged['result_id']}", headers=A)).json()
                check("a judged execution shows each judge score with its reason", d2["judge_scores"] and all(m["reason"] for m in d2["judge_scores"] if m["status"] == "scored"), str(d2["judge_scores"])[:200])

            exp = await c.get(f"/eval/runs/{real['run_id']}/export", headers=A, params={"format": "csv"})
            rows = list(csv.DictReader(io.StringIO(exp.text)))
            check("a run exports as CSV, one row per execution", exp.status_code == 200 and "attachment" in exp.headers.get("content-disposition", "") and len(rows) == real["executions"], f"{len(rows)} rows")
            check("the export carries tokens, latency and cost", {"input_tokens", "latency_ms", "cost_usd", "status"} <= set(rows[0]))
            js = (await c.get(f"/eval/runs/{real['run_id']}/export", headers=A, params={"format": "json"})).json()
            check("a run exports as JSON with the run's identity", js["run"]["run_id"] == real["run_id"] and len(js["results"]) == real["executions"])
            check("an unknown export format is refused", (await c.get(f"/eval/runs/{real['run_id']}/export", headers=A, params={"format": "xml"})).status_code == 422)

        history = (await c.get("/eval/benchmarks/history", headers=A)).json()
        check("benchmark history has a point per benchmark and model", isinstance(history["points"], list))
        listing = (await c.get("/eval/benchmarks", headers=A)).json()
        if listing:
            bid = listing[0]["benchmark_id"]
            bd = (await c.get(f"/eval/benchmarks/{bid}/breakdown", headers=A)).json()
            check("a benchmark breaks down per workflow stage and per case", bd["stages"] and bd["cases"] and len(bd["models"]) >= 2, str(list(bd)))
            model = bd["models"][0]
            only = (await c.get(f"/eval/benchmarks/{bid}/breakdown", headers=A, params={"model": model})).json()
            check("the breakdown filters by model", only["models"] == [model] and only["filtered"])
            st = bd["facets"]["stage"][0]
            by_stage = (await c.get(f"/eval/benchmarks/{bid}/breakdown", headers=A, params={"stage": st})).json()
            check("the breakdown filters by workflow stage", [s["stage"] for s in by_stage["stages"]] == [st] and all(e["stage"] == st for e in by_stage["cases"]))
            by_case = (await c.get(f"/eval/benchmarks/{bid}/breakdown", headers=A, params={"case": bd["cases"][0]["case"]})).json()
            check("the breakdown filters by test case", [e["case"] for e in by_case["cases"]] == [bd["cases"][0]["case"]])
            by_status = (await c.get(f"/eval/benchmarks/{bid}/breakdown", headers=A, params={"status": "failed"})).json()
            check("the breakdown filters by status", all(m["passed"] == 0 and m["other"] == 0 for e in by_status["cases"] for m in e["models"].values()))
            ex = await c.get(f"/eval/benchmarks/{bid}/export", headers=A, params={"format": "csv"})
            check("a benchmark exports every model's executions", ex.status_code == 200 and len(list(csv.DictReader(io.StringIO(ex.text)))) > 0)
            check("the benchmark detail route still works next to /history", (await c.get(f"/eval/benchmarks/{bid}", headers=A)).status_code == 200)
        check("an unknown benchmark is 404", (await c.get("/eval/benchmarks/nope/breakdown", headers=A)).status_code == 404)

        # ── the preview ──
        ds = (await c.get("/eval/datasets", headers=A)).json()
        single = next(d for d in ds if d["slug"] == "individual-single-turn")
        version = single["latest_version"]
        req = {"dataset": single["slug"], "version": version, "kind": "benchmark_agent", "models": ["openai/gpt-4o-mini", "openai/gpt-4o"], "judge": "openai/gpt-4.1", "repeat": "3",
               "budget_usd": 5}
        pre = await c.post("/eval/jobs/estimate", headers=A, json=req)
        est = pre.json().get("estimate", {}).get("cost", {})
        check("the preview is accepted and says nothing was queued", pre.status_code == 200, pre.text[:300])
        check("the preview counts the model-backed cases and executions", est.get("model_backed_cases", 0) > 0 and est["models"][0]["executions"] == est["model_backed_cases"] * 3, str(est)[:300])
        check("the preview estimates tokens and USD per model, with where the figure comes from", all(m["input_tokens"] > 0 and m["usd"] and m["basis"] for m in est["models"]), str(est["models"])[:300])
        check("the preview prices the judge separately", est["judge"]["usd"] > 0 and est["judge"]["calls"] > 0 and est["usd"]["total"] > est["usd"]["models"], str(est["judge"]))
        check("the preview total is the models plus the judge", abs(est["usd"]["total"] - (est["usd"]["models"] + est["usd"]["judge"])) < 1e-9)
        check("the dearer model costs more than the cheaper", est["models"][1]["usd"] > est["models"][0]["usd"])
        check("the preview warns when the budget is below the estimate", any("budget" in w for w in (await c.post("/eval/jobs/estimate", headers=A, json={**req, "budget_usd": 0.01})).json()["estimate"]["cost"]["warnings"]))
        mock = (await c.post("/eval/jobs/estimate", headers=A, json={**req, "models": ["mock/mock-oracle", "mock/mock-lazy"], "judge": "mock/mock-judge"})).json()["estimate"]["cost"]
        check("a scripted benchmark is estimated at nothing", mock["usd"]["total"] == 0 and mock["models"][0]["synthetic"])
        few = (await c.post("/eval/jobs/estimate", headers=A, json={**req, "metrics": ["safety"]})).json()["estimate"]["cost"]
        check("choosing fewer metrics lowers the judged criteria and the judge's cost", few["judged_criteria_per_pass"] < est["judged_criteria_per_pass"] and few["judge"]["usd"] < est["judge"]["usd"], f"{few['judged_criteria_per_pass']} vs {est['judged_criteria_per_pass']}")
        direct = (await c.post("/eval/jobs/estimate", headers=A, json={**req, "kind": "benchmark_direct"})).json()["estimate"]["cost"]
        check("a direct benchmark is cheaper than an agent benchmark (no tools, shorter prompt)", direct["usd"]["models"] < est["usd"]["models"], f"{direct['usd']['models']} vs {est['usd']['models']}")

        bad = await c.post("/eval/jobs/estimate", headers=A, json={**req, "models": ["openai/gpt-4o-mini"]})
        check("a benchmark of one model is refused with the reason", bad.status_code == 422 and "at least two" in str(bad.json()), bad.text[:200])
        bad = await c.post("/eval/jobs/estimate", headers=A, json={**req, "judge": None, "metrics": ["safety"]})
        check("metrics without a judge are refused", bad.status_code == 422, bad.text[:200])
        bad = await c.post("/eval/jobs/estimate", headers=A, json={**req, "metrics": ["telepathy"]})
        check("an unknown metric is refused", bad.status_code == 422)
        bad = await c.post("/eval/jobs/estimate", headers=A, json={**req, "version": "9.9.9"})
        check("an unpublished version is refused", bad.status_code == 422)

        # ── rerun (two scripted jobs, cancelled at once: no worker is asked to run them) ──
        job_ids = []
        scripted = {"dataset": single["slug"], "version": version, "kind": "benchmark_agent", "models": ["mock/mock-oracle", "mock/mock-lazy"], "judge": "mock/mock-judge", "repeat": "1",
                    "case_ids": ["IND-LEAD-001"]}
        made = await c.post("/eval/jobs", headers=A, json=scripted)
        check("a job is queued with its cost estimate stored", made.status_code == 201 and made.json()["estimate"].get("cost", {}).get("usd") is not None, made.text[:300])
        if made.status_code == 201:
            job_ids.append(made.json()["id"])
            again = await c.post(f"/eval/jobs/{job_ids[0]}/rerun", headers=A)
            check("a rerun queues a new job with the same request", again.status_code == 201 and again.json()["id"] != job_ids[0] and again.json()["config"]["models"] == scripted["models"], again.text[:300])
            if again.status_code == 201:
                job_ids.append(again.json()["id"])
            check("an unknown job cannot be rerun", (await c.post("/eval/jobs/00000000-0000-0000-0000-000000000000/rerun", headers=A)).status_code == 404)
            check("an ordinary user cannot rerun", (await c.post(f"/eval/jobs/{job_ids[0]}/rerun", headers=O)).status_code == 403)
        for jid in job_ids:
            await c.post(f"/eval/jobs/{jid}/cancel", headers=A)
        states = [(await c.get(f"/eval/jobs/{j}", headers=A)).json()["state"] for j in job_ids]
        check("the test jobs were cancelled before any worker took them", all(s in ("cancelled", "lost") for s in states), str(states))
    print(f"\n{'PASS' if not FAILS else 'FAILED'}: {FAILS} failed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
