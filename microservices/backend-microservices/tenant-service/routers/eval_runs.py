"""Evaluation results for the Super Admin: runs, one execution with its trace, and the views a benchmark page needs.

  GET /eval/runs[?kind=&model=&dataset=&state=&group_id=&job_id=]       the runs, newest first
  GET /eval/runs/{run_id}                                       one run: counts, configuration, reliability, gate, judge calibration
  GET /eval/runs/{run_id}/results[?status=&stage=&case=&...]    its executions, filtered, with counts for the filter choices
  GET /eval/runs/{run_id}/export?format=csv|json                every execution of the run as a file
  GET /eval/results/{result_id}                                 one execution: assertions, judge scores and reasons, the model's answer, the trace

  GET /eval/benchmarks/history[?model=]                         every benchmark a model took part in, for a trend
  GET /eval/benchmarks/{id}/breakdown[?model=&stage=&case=&status=]   per model and workflow stage, and a case-by-model grid
  GET /eval/benchmarks/{id}/export?format=csv|json              every execution of every model of a benchmark

All of it is SuperAdmin only. The router is included BEFORE the benchmark routes of eval_models so that /history is not read as a benchmark id.
"""
import csv
import io
import json
from collections import defaultdict
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import verify_superadmin
from services.eval_lake import get_lake
from shared.evaluation import stats
from shared.evaluation.object_store import LakeError
from shared.models.evaluation import EvalAssertionResult, EvalBenchmark, EvalCaseResult, EvalMetricScore, EvalRun

runs = APIRouter(prefix="/eval/runs", tags=["Evaluation runs"], dependencies=[Depends(verify_superadmin)])
results = APIRouter(prefix="/eval/results", tags=["Evaluation runs"], dependencies=[Depends(verify_superadmin)])
benchmark_views = APIRouter(prefix="/eval/benchmarks", tags=["Evaluation benchmarks"], dependencies=[Depends(verify_superadmin)])

RAN = ("passed", "failed")
EXPORT_COLUMNS = ["run_id", "model", "kind", "case", "stage", "repetition", "status", "reason", "critical_failed", "latency_ms", "ttft_ms", "input_tokens", "output_tokens",
                  "cached_tokens", "llm_calls", "turns", "cost_usd", "cost_known", "judge_cost_usd", "score"]
MAX_TEXT = 20000


def _run_out(r: EvalRun) -> Dict[str, Any]:
    return {"run_id": r.run_id, "kind": r.kind, "group_id": r.group_id, "job_id": str(r.job_id) if r.job_id else None, "dataset": r.dataset_slug, "version": r.dataset_version,
            "model": r.model_label, "synthetic": r.synthetic_model, "skills_enabled": r.skills_enabled, "prompt_version": r.prompt_version, "judge_model": r.judge_model,
            "state": r.state, "cancelled": r.cancelled, "repetitions": r.repetitions, "selected_cases": r.selected_cases, "executions": r.executions, "passed": r.passed,
            "failed": r.failed, "blocked": r.blocked, "skipped": r.skipped, "infrastructure_errors": r.infrastructure_errors, "pass_rate": r.pass_rate,
            "known_cost_usd": r.known_cost_usd, "unknown_cost_executions": r.unknown_cost_executions, "estimated_usd": r.estimated_usd, "budget_usd": r.budget_usd,
            "data_verified": r.data_verified, "started_at": r.started_at, "finished_at": r.finished_at}


def _result_out(x: EvalCaseResult) -> Dict[str, Any]:
    verdict = x.verdict or {}
    return {"result_id": str(x.id), "case": x.case_key, "stage": x.category, "operation": x.operation, "repetition": x.repetition, "status": x.status, "reason": x.reason,
            "critical_failed": x.critical_failed, "latency_ms": x.latency_ms, "ttft_ms": x.ttft_ms, "score": x.score, "input_tokens": x.input_tokens, "output_tokens": x.output_tokens,
            "cached_tokens": x.cached_tokens, "llm_calls": x.llm_calls, "turns": x.turns, "cost_usd": x.cost_usd, "cost_known": x.cost_known, "judge_cost_usd": x.judge_cost_usd,
            "assertions": x.assertion_counts, "failing_layers": verdict.get("failing_layers"), "layers": {k: v.get("status") for k, v in (x.layer_scores or {}).items()},
            "model": x.model_id, "has_trace": bool(x.trace_key)}


async def _run(session: AsyncSession, run_id: str) -> EvalRun:
    r = (await session.exec(select(EvalRun).where(EvalRun.run_id == run_id))).first()
    if r is None:
        raise HTTPException(404, "No such run.")
    return r


def _filters(stmt, *, status: Optional[str], stage: Optional[str], case: Optional[str], repetition: Optional[int], critical: Optional[bool]):
    if status:
        stmt = stmt.where(EvalCaseResult.status.in_([s for s in status.split(",") if s]))
    if stage:
        stmt = stmt.where(EvalCaseResult.category.in_([s for s in stage.split(",") if s]))
    if case:
        stmt = stmt.where(EvalCaseResult.case_key.ilike(f"%{case}%"))
    if repetition:
        stmt = stmt.where(EvalCaseResult.repetition == repetition)
    if critical is not None:
        stmt = stmt.where(EvalCaseResult.critical_failed.is_(critical))
    return stmt


def _csv(rows: List[Dict[str, Any]]) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=EXPORT_COLUMNS, extrasaction="ignore")
    writer.writeheader()
    for r in rows:
        writer.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in EXPORT_COLUMNS})
    return buf.getvalue()


def _export_row(run: EvalRun, x: EvalCaseResult) -> Dict[str, Any]:
    return {"run_id": run.run_id, "model": run.model_label, "kind": run.kind, "case": x.case_key, "stage": x.category, "repetition": x.repetition, "status": x.status,
            "reason": x.reason, "critical_failed": x.critical_failed, "latency_ms": x.latency_ms, "ttft_ms": x.ttft_ms, "input_tokens": x.input_tokens,
            "output_tokens": x.output_tokens, "cached_tokens": x.cached_tokens, "llm_calls": x.llm_calls, "turns": x.turns, "cost_usd": x.cost_usd, "cost_known": x.cost_known,
            "judge_cost_usd": x.judge_cost_usd, "score": x.score}


def _file(rows: List[Dict[str, Any]], fmt: str, name: str, extra: Optional[Dict[str, Any]] = None) -> Response:
    if fmt == "csv":
        return Response(content=_csv(rows), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})
    body = json.dumps({**(extra or {}), "results": rows}, default=str, indent=1)
    return Response(content=body, media_type="application/json", headers={"Content-Disposition": f'attachment; filename="{name}.json"'})


def _trim(value: Any) -> Any:
    """The same JSON with any very long text cut, so one execution never makes a response of megabytes."""
    if isinstance(value, str):
        return value if len(value) <= MAX_TEXT else value[:MAX_TEXT] + f"... [{len(value) - MAX_TEXT} more characters not shown]"
    if isinstance(value, list):
        return [_trim(v) for v in value]
    if isinstance(value, dict):
        return {k: _trim(v) for k, v in value.items()}
    return value


async def _object(key: Optional[str]) -> Optional[Dict[str, Any]]:
    if not key:
        return None
    lake = get_lake()
    try:
        return json.loads(await lake._io(lake.store.get, key))
    except (LakeError, ValueError):
        return None


# ── runs ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

@runs.get("")
async def list_runs(kind: Optional[str] = None, model: Optional[str] = None, dataset: Optional[str] = None, state: Optional[str] = None, group_id: Optional[str] = None,
                    job_id: Optional[UUID] = None, limit: int = Query(default=50, ge=1, le=200), offset: int = Query(default=0, ge=0), session: AsyncSession = Depends(get_session)):
    stmt = select(EvalRun)
    if job_id:
        stmt = stmt.where(EvalRun.job_id == job_id)
    for column, value in ((EvalRun.kind, kind), (EvalRun.model_label, model), (EvalRun.dataset_slug, dataset), (EvalRun.state, state), (EvalRun.group_id, group_id)):
        if value:
            stmt = stmt.where(column == value)
    total = (await session.exec(select(func.count()).select_from(stmt.subquery()))).one()
    rows = (await session.exec(stmt.order_by(EvalRun.created_at.desc()).offset(offset).limit(limit))).all()
    return {"total": total, "runs": [_run_out(r) for r in rows]}


@runs.get("/{run_id}")
async def get_run(run_id: str, session: AsyncSession = Depends(get_session)):
    r = await _run(session, run_id)
    s = r.summary or {}
    return {**_run_out(r), "config": r.config, "reliability": s.get("reliability"), "per_case": s.get("per_case"), "gate": s.get("gate"),
            "judge_calibration": s.get("judge_calibration"), "unscored_l2": s.get("unscored_l2"), "stop_reason": s.get("stop_reason"), "estimate": s.get("estimate"),
            "by_category": s.get("by_category")}


@runs.get("/{run_id}/results")
async def run_results(run_id: str, status: Optional[str] = None, stage: Optional[str] = None, case: Optional[str] = None, repetition: Optional[int] = None,
                      critical: Optional[bool] = None, limit: int = Query(default=100, ge=1, le=500), offset: int = Query(default=0, ge=0),
                      session: AsyncSession = Depends(get_session)):
    r = await _run(session, run_id)
    base = select(EvalCaseResult).where(EvalCaseResult.run_row_id == r.id)
    filtered = _filters(base, status=status, stage=stage, case=case, repetition=repetition, critical=critical)
    total = (await session.exec(select(func.count()).select_from(filtered.subquery()))).one()
    rows = (await session.exec(filtered.order_by(EvalCaseResult.case_key, EvalCaseResult.repetition).offset(offset).limit(limit))).all()
    facet_status = (await session.exec(select(EvalCaseResult.status, func.count()).where(EvalCaseResult.run_row_id == r.id).group_by(EvalCaseResult.status))).all()
    facet_stage = (await session.exec(select(EvalCaseResult.category, func.count()).where(EvalCaseResult.run_row_id == r.id).group_by(EvalCaseResult.category))).all()
    return {"run_id": r.run_id, "model": r.model_label, "total": total, "results": [_result_out(x) for x in rows],
            "facets": {"status": {k: n for k, n in facet_status}, "stage": {(k or "unclassified"): n for k, n in facet_stage}}}


@runs.get("/{run_id}/export")
async def export_run(run_id: str, format: str = Query(default="csv", pattern="^(csv|json)$"), session: AsyncSession = Depends(get_session)):
    r = await _run(session, run_id)
    rows = (await session.exec(select(EvalCaseResult).where(EvalCaseResult.run_row_id == r.id).order_by(EvalCaseResult.case_key, EvalCaseResult.repetition))).all()
    return _file([_export_row(r, x) for x in rows], format, f"run-{r.run_id}", {"run": _run_out(r)})


# ── one execution ──────────────────────────────────────────────────────────────────────────────────────────────────────

@results.get("/{result_id}")
async def get_result(result_id: UUID, session: AsyncSession = Depends(get_session)):
    x = await session.get(EvalCaseResult, result_id)
    if x is None:
        raise HTTPException(404, "No such execution.")
    run = await session.get(EvalRun, x.run_row_id)
    assertions = (await session.exec(select(EvalAssertionResult).where(EvalAssertionResult.result_id == x.id).order_by(EvalAssertionResult.assertion_id))).all()
    metrics = (await session.exec(select(EvalMetricScore).where(EvalMetricScore.result_id == x.id).order_by(EvalMetricScore.metric))).all()
    artifact = await _object(x.artifact_key)
    trace = await _object(x.trace_key)
    observation = (artifact or {}).get("observation") or {}
    answer = (observation.get("response") or {}).get("text")
    return {**_result_out(x), "run": _run_out(run) if run else None, "verdict": x.verdict, "layer_scores": x.layer_scores, "usage": x.usage, "error": x.error, "trace_summary": x.trace_summary,
            "assertion_results": [{"id": a.assertion_id, "kind": a.kind, "target": a.target, "severity": a.severity, "status": a.status, "message": a.message,
                                   "expected": a.expected, "actual": a.actual} for a in assertions],
            "judge_scores": [{"metric": m.metric, "criterion": m.criterion_id, "score": m.score, "threshold": m.threshold, "passed": m.passed, "status": m.status,
                              "reason": m.reason, "judge_model": m.judge_model, "judge_cost_usd": m.judge_cost_usd} for m in metrics],
            "response_text": _trim(answer), "trace": _trim(trace),
            "artifact_available": artifact is not None}


# ── benchmark views ────────────────────────────────────────────────────────────────────────────────────────────────────

@benchmark_views.get("/history")
async def benchmark_history(model: Optional[str] = None, limit: int = Query(default=100, ge=1, le=300), session: AsyncSession = Depends(get_session)):
    """One point per (benchmark, model) with the figures a trend chart needs, oldest first."""
    rows = (await session.exec(select(EvalBenchmark).order_by(EvalBenchmark.created_at.desc()).limit(limit))).all()
    points: List[Dict[str, Any]] = []
    for b in rows:
        for label, m in ((b.summary or {}).get("models") or {}).items():
            if model and label != model:
                continue
            if m.get("status") != "measured":
                points.append({"benchmark_id": b.benchmark_id, "at": b.created_at, "model": label, "mode": b.mode, "synthetic": b.synthetic, "status": m.get("status")})
                continue
            lat = m.get("latency_ms") or {}
            cost = m.get("cost") or {}
            tokens = m.get("tokens") or {}
            points.append({"benchmark_id": b.benchmark_id, "at": b.created_at, "model": label, "mode": b.mode, "synthetic": b.synthetic, "status": "measured",
                           "dataset": b.dataset_slug, "version": b.dataset_version, "repetitions": b.repetitions, "pass_rate": m.get("pass_rate"), "ci_low": m.get("ci_low"),
                           "ci_high": m.get("ci_high"), "critical_failures": m.get("critical_failures"), "p50_ms": lat.get("p50"), "p95_ms": lat.get("p95"),
                           "total_usd": cost.get("total_usd"), "cost_per_passed_usd": cost.get("per_passed_usd"), "input_tokens": tokens.get("input"),
                           "output_tokens": tokens.get("output")})
    return {"points": sorted(points, key=lambda p: p["at"])}


async def _benchmark(session: AsyncSession, benchmark_id: str) -> EvalBenchmark:
    b = (await session.exec(select(EvalBenchmark).where(EvalBenchmark.benchmark_id == benchmark_id))).first()
    if b is None:
        raise HTTPException(404, "No such benchmark.")
    return b


def _rate(passed: int, ran: int) -> Optional[float]:
    return passed / ran if ran else None


@benchmark_views.get("/{benchmark_id}/breakdown")
async def benchmark_breakdown(benchmark_id: str, model: Optional[str] = None, stage: Optional[str] = None, case: Optional[str] = None, status: Optional[str] = None,
                              session: AsyncSession = Depends(get_session)):
    """Per model and workflow stage (pass rate with its interval) and a grid of cases by model. The filters apply to both."""
    b = await _benchmark(session, benchmark_id)
    run_rows = (await session.exec(select(EvalRun).where(EvalRun.group_id == b.benchmark_id))).all()
    by_run = {r.id: r for r in run_rows}
    if not by_run:
        return {"benchmark_id": b.benchmark_id, "models": [], "stages": [], "cases": [], "facets": {"model": [], "stage": [], "status": []}}
    stmt = select(EvalCaseResult).where(EvalCaseResult.run_row_id.in_(list(by_run)))
    all_rows = (await session.exec(stmt)).all()
    facets = {"model": sorted({by_run[x.run_row_id].model_label or "?" for x in all_rows}), "stage": sorted({x.category or "unclassified" for x in all_rows}),
              "status": sorted({x.status for x in all_rows})}
    wanted_status = {s for s in (status or "").split(",") if s}
    wanted_stage = {s for s in (stage or "").split(",") if s}
    wanted_model = {s for s in (model or "").split(",") if s}
    rows = [x for x in all_rows
            if (not wanted_model or by_run[x.run_row_id].model_label in wanted_model) and (not wanted_stage or (x.category or "unclassified") in wanted_stage)
            and (not wanted_status or x.status in wanted_status) and (not case or case.lower() in x.case_key.lower())]

    stage_cells: Dict[str, Dict[str, Dict[str, int]]] = defaultdict(lambda: defaultdict(lambda: {"passed": 0, "failed": 0, "other": 0, "critical": 0}))
    grid: Dict[str, Dict[str, Any]] = {}
    for x in rows:
        label = by_run[x.run_row_id].model_label or "?"
        st = x.category or "unclassified"
        cell = stage_cells[st][label]
        cell["passed" if x.status == "passed" else "failed" if x.status == "failed" else "other"] += 1
        cell["critical"] += 1 if x.critical_failed else 0
        entry = grid.setdefault(x.case_key, {"case": x.case_key, "stage": st, "models": {}})
        m = entry["models"].setdefault(label, {"runs": 0, "passed": 0, "failed": 0, "other": 0, "latency_ms": [], "cost_usd": 0.0, "cost_known": True, "critical": 0, "result_ids": []})
        m["runs"] += 1
        m["passed" if x.status == "passed" else "failed" if x.status == "failed" else "other"] += 1
        m["critical"] += 1 if x.critical_failed else 0
        if x.latency_ms is not None:
            m["latency_ms"].append(x.latency_ms)
        if x.cost_usd is not None:
            m["cost_usd"] += x.cost_usd
        m["cost_known"] = m["cost_known"] and x.cost_known
        m["result_ids"].append(str(x.id))
    stages = []
    for st, per_model in sorted(stage_cells.items()):
        cells = {}
        for label, c in per_model.items():
            ran = c["passed"] + c["failed"]
            ci = stats.wilson(c["passed"], ran)
            cells[label] = {**c, "ran": ran, "pass_rate": _rate(c["passed"], ran), "ci_low": ci[0] if ci else None, "ci_high": ci[1] if ci else None}
        stages.append({"stage": st, "models": cells})
    cases = []
    for key in sorted(grid):
        entry = grid[key]
        for label, m in entry["models"].items():
            lat = stats.describe(m.pop("latency_ms"))
            m["p50_ms"], m["p95_ms"] = lat["p50"], lat["p95"]
            m["pass_rate"] = _rate(m["passed"], m["passed"] + m["failed"])
        cases.append(entry)
    return {"benchmark_id": b.benchmark_id, "mode": b.mode, "models": sorted({lbl for e in cases for lbl in e["models"]}), "stages": stages, "cases": cases, "facets": facets,
            "filtered": bool(wanted_status or wanted_stage or wanted_model or case)}


@benchmark_views.get("/{benchmark_id}/export")
async def export_benchmark(benchmark_id: str, format: str = Query(default="csv", pattern="^(csv|json)$"), session: AsyncSession = Depends(get_session)):
    b = await _benchmark(session, benchmark_id)
    run_rows = (await session.exec(select(EvalRun).where(EvalRun.group_id == b.benchmark_id))).all()
    out: List[Dict[str, Any]] = []
    for r in run_rows:
        for x in (await session.exec(select(EvalCaseResult).where(EvalCaseResult.run_row_id == r.id).order_by(EvalCaseResult.case_key, EvalCaseResult.repetition))).all():
            out.append(_export_row(r, x))
    return _file(out, format, f"benchmark-{b.benchmark_id}", {"benchmark": {"benchmark_id": b.benchmark_id, "mode": b.mode, "dataset": b.dataset_slug, "version": b.dataset_version,
                                                                              "models": [m.get("label") for m in (b.models or [])], "synthetic": b.synthetic, "summary": b.summary}})
