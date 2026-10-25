"""Cost lines against the platform's own data (Phase 7, M3): the runs that are really stored, and a run built inside a transaction that is rolled back.

  every completed run     its cost lines add up to its recorded cost, hold every token its executions used, and record nothing twice
  the per-case records    the Evaluation Costs module's per-case records add up to the same figure
  backfill                records the lines of a run that has none, rebuilds exactly what ingestion would have written, and a second backfill adds nothing
  a rebuilt run           priced with the run's OWN price version, not today's, so changing prices later never rewrites history

Run: docker exec insurance-tenant-service python test_eval_cost_attribution.py
"""
import asyncio
import sys
import uuid
from datetime import datetime

from sqlalchemy import func
from sqlmodel import select

import database
from shared.models.core import User
from services import eval_costs
from shared.evaluation import cost_lines, cost_store
from shared.models.evaluation import EvalCaseResult, EvalComputeRate, EvalCostLine, EvalCostRecord, EvalMetricScore, EvalPricingVersion, EvalRun

FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


def tk(calls, i, o, c=0):
    return {"calls": calls, "input_tokens": i, "output_tokens": o, "cached_tokens": c}


async def main() -> int:
    async with database._session_factory() as s:
        try:
            report = await eval_costs.attribution(s)
            check("every completed run is accounted for exactly (lines = recorded cost, tokens, nothing missing or doubled)", report["checked"] > 0 and report["with_problems"] == 0,
                  str([(r["run_id"], r["problems"]) for r in report["runs"] if r["problems"]][:3]))
            total_lines = (await s.exec(select(func.coalesce(func.sum(EvalCostLine.usd), 0.0)))).one()
            total_runs = (await s.exec(select(func.coalesce(func.sum(EvalRun.known_cost_usd), 0.0)).where(EvalRun.state == "complete"))).one()
            total_records = (await s.exec(select(func.coalesce(func.sum(EvalCostRecord.total_cost_usd), 0.0)))).one()
            check(f"all money agrees across the three tables: lines ${total_lines:.6f}, runs ${total_runs:.6f}, per-case records ${total_records:.6f}",
                  abs(total_lines - total_runs) < 1e-5 and abs(total_lines - total_records) < 1e-5, f"{total_lines} {total_runs} {total_records}")
            comps = dict((await s.exec(select(EvalCostLine.component, func.count()).group_by(EvalCostLine.component))).all())
            check("the real runs are split into components (agent, judge, ocr, candidate)", {"agent_llm", "judge"} <= set(comps), str(comps))
            check("nothing already stored is double-recorded by a second backfill", (await eval_costs.backfill(s))["lines"] == 0)
            unknown_zero = (await s.exec(select(func.count()).select_from(EvalCostLine).where(EvalCostLine.cost_kind == "unknown", EvalCostLine.usd != None))).one()   # noqa: E711
            check("no line says 'unknown' and carries an amount", unknown_zero == 0)

            # a run built here, priced with its own (older) price version
            old_prices = EvalPricingVersion(label="test-old-prices", rates={"gpt-4.1": {"input": 2.0, "cached": 0.5, "output": 8.0}}, default_rate={"input": 0, "cached": 0, "output": 0},
                                            is_active=False, content_hash=uuid.uuid4().hex + uuid.uuid4().hex)
            s.add(old_prices)
            await s.flush()
            run_id = f"t-attr-{uuid.uuid4().hex[:8]}"
            run = EvalRun(run_id=run_id, state="ingesting", kind="benchmark_agent", model_id="openai/gpt-4.1", config={"mode": "agent", "model_id": "openai/gpt-4.1"}, pricing_version_id=old_prices.id,
                          started_at=datetime.utcnow(), known_cost_usd=0.0)
            s.add(run)
            await s.flush()
            usage = {"status": "attributed", "calls": 2, "input_tokens": 1_000_000, "output_tokens": 100_000, "cached_tokens": 0, "by_model": {"gpt-4.1-2025-04-14": tk(2, 1_000_000, 100_000)}}
            rows = [EvalCaseResult(run_row_id=run.id, case_key="IND-X-1", repetition=1, status="passed", operation="chat", usage=usage, llm_calls=2, judge_cost_usd=0.25, cost_usd=2.8, cost_known=True),
                    EvalCaseResult(run_row_id=run.id, case_key="IND-X-2", repetition=1, status="infrastructure_error", operation="chat",
                                   usage={"status": "missing", "calls": None}, llm_calls=None, cost_usd=None, cost_known=False),
                    EvalCaseResult(run_row_id=run.id, case_key="IND-X-3", repetition=1, status="passed", operation="rules.evaluate", usage=None, cost_usd=0.0, cost_known=True)]
            s.add_all(rows)
            await s.flush()
            s.add(EvalMetricScore(result_id=rows[0].id, metric="correctness", layer="L2", status="scored", judge_model="openai/gpt-4o-mini", input_tokens=4000, output_tokens=300, judge_cost_usd=0.25))
            await s.flush()
            run.known_cost_usd, run.unknown_cost_executions = 3.05, 1
            made = await cost_store.backfill_run(s, run)
            lines = await cost_store.stored_lines(s, run_id)
            agent = next(l for l in lines if l["component"] == "agent_llm")
            check("a stored run with no lines gets them (candidate priced with ITS version: $2.8 for 1M in, 100k out)", made == 3 and abs(agent["usd"] - 2.8) < 1e-9, str(lines))
            check("a missing ledger became one unknown line and the judge its own line", sum(1 for l in lines if l["cost_kind"] == "unknown") == 1 and any(l["component"] == "judge" and abs(l["usd"] - 0.25) < 1e-9 for l in lines))
            check("the rebuilt lines account for the run exactly", (await eval_costs.attribution(s, run_id, states=("ingesting",)))["with_problems"] == 0, str((await eval_costs.attribution(s, run_id, states=("ingesting",)))["runs"]))
            check("a second backfill of the same run adds nothing", await cost_store.backfill_run(s, run) == 0)
            run.known_cost_usd = 9.99
            check("a run whose recorded cost no longer matches its lines is reported", (await eval_costs.attribution(s, run_id, states=("ingesting",)))["with_problems"] == 1)

            # ── a self-hosted model: machine time, priced from the recorded hourly rate ─────────────────────────────────────────────
            uid = (await s.exec(select(User.id).limit(1))).first()
            s.add(EvalComputeRate(name="TEST-GPU", resource="gpu", usd_per_hour=1.8, effective_from=datetime(2001, 1, 1), source="test price list", recorded_by=uid))
            await s.flush()
            sid = f"t-self-{uuid.uuid4().hex[:8]}"
            srun = EvalRun(run_id=sid, state="ingesting", kind="benchmark_agent", model_id="self/llama", config={"mode": "agent", "model_id": "self/llama"}, pricing_version_id=old_prices.id, started_at=datetime(2001, 6, 1), known_cost_usd=0.0)
            s.add(srun)
            await s.flush()
            s.add(EvalCaseResult(run_row_id=srun.id, case_key="IND-S-1", repetition=1, status="passed", operation="chat", llm_calls=1, cost_usd=0.9, cost_known=True,
                                 usage={"status": "attributed", "calls": 1, "input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "by_model": {}, "compute": [{"resource": "gpu", "seconds": 1800, "rate": "TEST-GPU"}, {"resource": "gpu", "seconds": 60, "rate": "NOT-RECORDED"}]}))
            await s.flush()
            srun.known_cost_usd, srun.unknown_cost_executions = 0.9, 1
            made2 = await cost_store.backfill_run(s, srun)
            sl = [l for l in await cost_store.stored_lines(s, sid) if l["component"] == "self_hosted"]
            check("a stored run that used machine time gets self_hosted lines: 30 min of GPU at $1.80/h is $0.90, in seconds", made2 == 2 and any(abs((l["usd"] or 0) - 0.9) < 1e-9 and l["unit_kind"] == "gpu_seconds" and l["input_units"] == 1800 for l in sl), sl)
            check("a machine with no recorded rate is an unknown line, never free", any(l["usd"] is None and l["cost_kind"] == "unknown" and l["model"] == "NOT-RECORDED" for l in sl))
            check("the run's cost and its lines agree", (await eval_costs.attribution(s, sid, states=("ingesting",)))["with_problems"] == 0, str((await eval_costs.attribution(s, sid, states=("ingesting",)))["runs"]))
        finally:
            await s.rollback()
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
