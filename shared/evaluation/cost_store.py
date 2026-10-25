"""Writing cost lines to the database, and reading a run back as the lines' checker needs it. The lines themselves are made by cost_lines.py.

A line is recorded once: the insert names the unique index on (usage_ref, component) and does nothing when the line is already there, so ingesting a run again
(or ingesting one that crashed half way) never counts anything twice. The table is append-only in the database itself (shared/evaluation/ddl.py).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlmodel import select

from shared.evaluation import cost_lines
from shared.evaluation.pricing import PriceTable


async def store_lines(session, lines: Sequence[Dict[str, Any]], *, job_id: Optional[uuid.UUID], incurred_at: Optional[datetime]) -> int:
    """Insert the lines that are not already recorded; returns how many were new. Commit is the caller's."""
    from shared.models.evaluation import EvalCostLine
    if not lines:
        return 0
    when = incurred_at or datetime.utcnow()
    rows = [{"id": uuid.uuid4(), "run_id": l["run_id"], "case_id": l["case_id"], "repetition": l["repetition"], "job_id": job_id, "component": l["component"], "provider": l["provider"],
             "model": l["model"], "unit_kind": l["unit_kind"], "input_units": l["input_units"], "output_units": l["output_units"], "cached_units": l["cached_units"], "usd": l["usd"],
             "cost_kind": l["cost_kind"], "source": l["source"], "usage_ref": l["usage_ref"], "pricing_version_id": l["pricing_version_id"], "incurred_at": when,
             "created_at": datetime.utcnow()} for l in lines]
    result = await session.execute(pg_insert(EvalCostLine).values(rows).on_conflict_do_nothing(index_elements=["usage_ref", "component"], index_where=text("usage_ref IS NOT NULL")))
    return int(result.rowcount or 0)


def _row(l) -> Dict[str, Any]:
    return {"run_id": l.run_id, "case_id": l.case_id, "repetition": l.repetition, "component": l.component, "provider": l.provider, "model": l.model, "unit_kind": l.unit_kind,
            "input_units": l.input_units, "output_units": l.output_units, "cached_units": l.cached_units, "usd": l.usd, "cost_kind": l.cost_kind, "source": l.source,
            "usage_ref": l.usage_ref, "pricing_version_id": l.pricing_version_id}


async def stored_lines(session, run_id: str) -> List[Dict[str, Any]]:
    from shared.models.evaluation import EvalCostLine
    return [_row(l) for l in (await session.exec(select(EvalCostLine).where(EvalCostLine.run_id == run_id))).all()]


async def stored_results(session, run) -> List[Dict[str, Any]]:
    """The run's executions as the runner wrote them (results.jsonl shape), rebuilt from the database rows."""
    from shared.models.evaluation import EvalCaseResult, EvalMetricScore
    out: List[Dict[str, Any]] = []
    for r in (await session.exec(select(EvalCaseResult).where(EvalCaseResult.run_row_id == run.id).order_by(EvalCaseResult.case_key, EvalCaseResult.repetition))).all():
        scores = (await session.exec(select(EvalMetricScore).where(EvalMetricScore.result_id == r.id))).all()
        out.append({"case_id": r.case_key, "repetition": r.repetition, "status": r.status, "operation": r.operation, "usage": r.usage, "llm_calls": r.llm_calls,
                    "judge_cost_usd": r.judge_cost_usd, "retry_usage": r.retry_usage or [],
                    "metric_scores": [{"judge_model": m.judge_model, "input_tokens": m.input_tokens, "output_tokens": m.output_tokens, "judge_cost_usd": m.judge_cost_usd} for m in scores]})
    return out


async def price_table_of(session, run) -> PriceTable:
    """The prices the run was priced with at ingestion (its own pricing version), so rebuilt lines reproduce the stored totals even if prices changed since."""
    from shared.models.evaluation import EvalPricingVersion
    row = await session.get(EvalPricingVersion, run.pricing_version_id) if run.pricing_version_id else None
    return PriceTable.from_rates(row.label, row.rates, fallback=PriceTable.builtin()) if row is not None else PriceTable.builtin()


def run_facts(run) -> Dict[str, Any]:
    cfg = run.config or {}
    return {"candidate": run.model_id or cfg.get("model_id"), "mode": cfg.get("mode") or ("direct" if run.kind == "benchmark_direct" else "agent"), "synthetic": bool(run.synthetic_model or cfg.get("synthetic_model"))}


async def build_lines(session, run) -> List[Dict[str, Any]]:
    """The cost lines of a stored run, from its stored results. Used for runs ingested before cost lines existed; it cannot know what the original run
    did not record (the ledger's service names, the usage of failed attempts), and the lines say so in their source."""
    from shared.evaluation.runs import _compute_rates
    table = await price_table_of(session, run)
    facts = run_facts(run)
    rates = await _compute_rates(session)
    lines: List[Dict[str, Any]] = []
    for r in await stored_results(session, run):
        lines += cost_lines.lines_for_result(run.run_id, r, table=table, candidate=facts["candidate"], mode=facts["mode"], synthetic=facts["synthetic"], pricing_version_id=run.pricing_version_id, compute_rates=rates, at=run.started_at)
    return lines


async def backfill_run(session, run) -> int:
    """Record the cost lines of a stored run that has none. Idempotent. Returns the number of new lines. Commit is the caller's."""
    return await store_lines(session, await build_lines(session, run), job_id=run.job_id, incurred_at=run.started_at or run.finished_at)
