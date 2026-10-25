"""Evaluation cost lines in the platform: bring older runs up to date, and check that every run's spending is attributed exactly once.

The lines themselves are made and stored by shared/evaluation/cost_lines.py and cost_store.py (at run ingestion). This module adds what needs the database:
  backfill       record the lines of runs that were ingested before cost lines existed (idempotent; a run that already has lines is left alone)
  attribution    for each run: do the lines add up to the run's cost, do they hold every token the ledger showed, does every execution that used a model have a
                 line, is anything recorded twice. An empty list of problems means the run's spending is accounted for exactly.
"""
from typing import Any, Dict, List, Optional

from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.evaluation import cost_lines, cost_store
from shared.models.evaluation import EvalCostLine, EvalRun


async def runs_without_lines(session: AsyncSession) -> List[EvalRun]:
    have = select(EvalCostLine.run_id).distinct()
    runs = (await session.exec(select(EvalRun).where(EvalRun.state == "complete").where(EvalRun.run_id.not_in(have)).order_by(EvalRun.started_at))).all()
    # a run in which nothing used a model has no lines and needs none: building them finds that out and writes nothing
    return list(runs)


async def backfill(session: AsyncSession, run_id: Optional[str] = None) -> Dict[str, Any]:
    """Record lines for completed runs that have none. Returns {runs, lines, per_run}. Commit is the caller's."""
    stmt = select(EvalRun).where(EvalRun.state == "complete")
    if run_id:
        stmt = stmt.where(EvalRun.run_id == run_id)
    per_run: Dict[str, int] = {}
    for run in (await session.exec(stmt.order_by(EvalRun.started_at))).all():
        if run_id is None and (await session.exec(select(func.count()).select_from(EvalCostLine).where(EvalCostLine.run_id == run.run_id))).one():
            continue
        per_run[run.run_id] = await cost_store.backfill_run(session, run)
    return {"runs": len(per_run), "lines": sum(per_run.values()), "per_run": per_run}


async def attribution(session: AsyncSession, run_id: Optional[str] = None, *, states: tuple = ("complete",)) -> Dict[str, Any]:
    """Check how every completed run's spending was attributed. `problems` is empty for a run whose lines account for it exactly."""
    stmt = select(EvalRun).where(EvalRun.state.in_(list(states)))
    if run_id:
        stmt = stmt.where(EvalRun.run_id == run_id)
    out: List[Dict[str, Any]] = []
    for run in (await session.exec(stmt.order_by(EvalRun.started_at))).all():
        lines = await cost_store.stored_lines(session, run.run_id)
        results = await cost_store.stored_results(session, run)
        problems = cost_lines.check_run({"known_cost_usd": run.known_cost_usd, "unknown_cost_executions": run.unknown_cost_executions}, results, lines)
        out.append({"run_id": run.run_id, "kind": run.kind, "model": run.model_id, "synthetic": run.synthetic_model, "lines": len(lines), "known_usd": round(cost_lines.known_total(lines), 6),
                    "recorded_usd": run.known_cost_usd, "by_component": cost_lines.by_component(lines), "problems": problems})
    return {"runs": out, "checked": len(out), "with_problems": sum(1 for r in out if r["problems"])}
