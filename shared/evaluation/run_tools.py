"""Work on stored runs (the database and the lake; no web framework): put two side by side, and check that what is stored for one still matches the fingerprints recorded when it was ingested.

The comparison itself is pure (`shared/evaluation/run_compare.py`); this reads the rows and the stored objects. A run is read, never changed.
"""
import hashlib
from typing import Any, Dict, List

from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.evaluation import run_compare
from shared.evaluation.object_store import LakeError
from shared.models.evaluation import EvalCaseResult, EvalRun, EvalStorageObject


class RunToolError(Exception):
    """A request about stored runs that cannot be met; `status` is the HTTP code a caller should answer with."""

    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


async def get_run(session: AsyncSession, run_id: str) -> EvalRun:
    r = (await session.exec(select(EvalRun).where(EvalRun.run_id == run_id))).first()
    if r is None:
        raise RunToolError(f"No such run: {run_id}.", 404)
    return r


def _meta(r: EvalRun) -> Dict[str, Any]:
    return {"run_id": r.run_id, "dataset": r.dataset_slug, "version": r.dataset_version, "model": r.model_label, "judge_model": r.judge_model, "kind": r.kind, "started_at": r.started_at,
            "synthetic": r.synthetic_model, "repetitions": r.repetitions}


async def _rows(session: AsyncSession, r: EvalRun) -> List[Dict[str, Any]]:
    xs = (await session.exec(select(EvalCaseResult).where(EvalCaseResult.run_row_id == r.id))).all()
    return [{"case": x.case_key, "repetition": x.repetition, "status": x.status, "latency_ms": x.latency_ms, "cost_usd": x.cost_usd, "cost_known": x.cost_known} for x in xs]


async def compare(session: AsyncSession, a: str, b: str) -> Dict[str, Any]:
    """Run `a` (the baseline) against run `b` (the candidate). Both must be complete: a run still being ingested has rows that are not final."""
    if a == b:
        raise RunToolError("Choose two different runs to compare.", 422)
    ra, rb = await get_run(session, a), await get_run(session, b)
    for r in (ra, rb):
        if r.state != "complete":
            raise RunToolError(f"Run {r.run_id} is not complete yet.", 409)
    out = run_compare.compare_runs(await _rows(session, ra), await _rows(session, rb), meta_a=_meta(ra), meta_b=_meta(rb))
    return {"a_run": _meta(ra), "b_run": _meta(rb), **out}


async def verify(session: AsyncSession, lake, run_id: str) -> Dict[str, Any]:
    """Re-read every object stored for a run and compare it with the checksum and size recorded when it was ingested; confirm the rows are all there."""
    r = await get_run(session, run_id)
    prefix = f"artifacts/{r.id}/"
    objs = (await session.exec(select(EvalStorageObject).where(EvalStorageObject.object_key.like(f"{prefix}%")))).all()
    problems: List[str] = []
    if not objs:
        problems.append("no stored objects are registered for this run")
    for o in objs:
        try:
            data = await lake._io(lake.store.get, o.object_key)
        except LakeError as exc:
            problems.append(f"{o.object_key}: cannot be read ({exc})")
            continue
        if hashlib.sha256(data).hexdigest() != o.sha256:
            problems.append(f"{o.object_key}: the bytes no longer match the recorded checksum")
        elif len(data) != o.size_bytes:
            problems.append(f"{o.object_key}: the size differs from the recorded size")
    rows = (await session.exec(select(func.count()).select_from(EvalCaseResult).where(EvalCaseResult.run_row_id == r.id))).one()
    if rows != r.executions:
        problems.append(f"the run says {r.executions} executions but {rows} result rows are stored")
    for label, key in (("summary", r.summary_key), ("report", r.report_key), ("results", r.results_key)):
        if not key:
            problems.append(f"the run has no {label} object")
    if r.state != "complete":
        problems.append(f"the run is {r.state}, not complete")
    return {"run_id": r.run_id, "ok": not problems, "objects_checked": len(objs), "result_rows": rows, "executions": r.executions, "problems": problems}
