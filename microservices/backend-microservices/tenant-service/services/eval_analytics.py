"""Cost analytics in the platform: the numbers behind the Evaluation Costs and Benchmarking dashboards. The logic is shared/evaluation/cost_analytics.py (pure);
this module reads the recorded cost lines and run results and hands them over.

  trends           money over time (day / week / month), split by component, provider or model
  models           per dataset version and mode: each configuration's quality (with its interval), reliability, latency and what a PASSED test cost, all-in
  benchmarks       what each benchmark cost in total and per model
  anomalies        unusual runs, days and executions, each with the numbers it was compared with
  recommendations  only what the comparison and the spending support, with evidence and caveats
Money always comes from the cost lines, so it includes retries, fallbacks, unattributed calls and the judge; scripted models are left out unless asked for.
"""
from datetime import date, datetime, time, timedelta
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from services import eval_budget, eval_rates
from services.eval_reconcile import provider_expr
from shared.evaluation import benchmark as benchmark_lib
from shared.evaluation import cost_analytics as ca
from shared.models.evaluation import EvalBenchmark, EvalCaseResult, EvalCostLine, EvalMetricScore, EvalRun

RAN = ("passed", "failed")


def _mode(run: EvalRun) -> str:
    return (run.config or {}).get("mode") or ("direct" if run.kind == "benchmark_direct" else "agent")


def _label(run: EvalRun) -> str:
    return run.model_id or "no model"


async def run_facts(session: AsyncSession, *, include_synthetic: bool = False, start: Optional[datetime] = None, end: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Every completed run with what it cost, from the lines: total, split by component, unpriced lines."""
    stmt = select(EvalRun).where(EvalRun.state == "complete")
    if not include_synthetic:
        stmt = stmt.where(EvalRun.synthetic_model == False)           # noqa: E712
    if start:
        stmt = stmt.where(EvalRun.started_at >= start)
    if end:
        stmt = stmt.where(EvalRun.started_at <= end)
    runs = (await session.exec(stmt.order_by(EvalRun.started_at))).all()
    if not runs:
        return []
    ids = [r.run_id for r in runs]
    agg: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for run_id, comp, usd, n, unknown in (await session.exec(select(EvalCostLine.run_id, EvalCostLine.component, func.coalesce(func.sum(EvalCostLine.usd), 0.0), func.count(),
                                                                    func.count().filter(EvalCostLine.usd == None)).where(EvalCostLine.run_id.in_(ids))     # noqa: E711
                                                             .group_by(EvalCostLine.run_id, EvalCostLine.component))).all():
        agg.setdefault(run_id, {})[comp] = {"usd": float(usd), "lines": int(n), "unknown_lines": int(unknown)}
    out = []
    for r in runs:
        comps = agg.get(r.run_id, {})
        out.append({"run_id": r.run_id, "started_at": r.started_at or r.finished_at, "model": _label(r), "kind": r.kind, "mode": _mode(r), "dataset": r.dataset_slug, "version": r.dataset_version,
                    "synthetic": bool(r.synthetic_model), "executions": r.executions, "ran": r.passed + r.failed, "passed": r.passed, "infrastructure_errors": r.infrastructure_errors,
                    "total_usd": sum(c["usd"] for c in comps.values()), "by_component": comps, "unknown_lines": sum(c["unknown_lines"] for c in comps.values()),
                    "unknown_executions": r.unknown_cost_executions, "judge_model": r.judge_model, "skills_enabled": r.skills_enabled, "prompt_version": r.prompt_version,
                    "repetitions": r.repetitions, "group_id": r.group_id, "label": f"{_label(r)} on {r.dataset_slug} {r.dataset_version}", "_row_id": r.id, "_config": r.config or {}})
    return out


async def result_rows(session: AsyncSession, run_row_ids: List[Any]) -> Dict[Any, List[Dict[str, Any]]]:
    """The executions of the given runs in the shape the benchmark aggregation reads (results.jsonl), rebuilt from the database."""
    if not run_row_ids:
        return {}
    results = (await session.exec(select(EvalCaseResult).where(EvalCaseResult.run_row_id.in_(run_row_ids)))).all()
    scores: Dict[Any, List[Dict[str, Any]]] = {}
    ids = [r.id for r in results]
    for i in range(0, len(ids), 500):
        for m in (await session.exec(select(EvalMetricScore).where(EvalMetricScore.result_id.in_(ids[i:i + 500])))).all():
            scores.setdefault(m.result_id, []).append({"metric": m.metric, "layer": m.layer, "score": m.score, "passed": m.passed, "status": m.status, "judge_model": m.judge_model,
                                                       "judge_cost_usd": m.judge_cost_usd, "input_tokens": m.input_tokens, "output_tokens": m.output_tokens})
    out: Dict[Any, List[Dict[str, Any]]] = {}
    for r in results:
        out.setdefault(r.run_row_id, []).append({
            "case_id": r.case_key, "repetition": r.repetition, "status": r.status, "reason": r.reason, "latency_ms": r.latency_ms, "ttft_ms": r.ttft_ms, "score": r.score, "cost_usd": r.cost_usd,
            "cost_known": r.cost_known, "judge_cost_usd": r.judge_cost_usd, "input_tokens": r.input_tokens, "output_tokens": r.output_tokens, "cached_tokens": r.cached_tokens, "critical_failed": r.critical_failed,
            "layer_scores": r.layer_scores or {}, "trace_summary": r.trace_summary or {}, "metric_scores": scores.get(r.id, []), "model_id": r.model_id, "operation": r.operation})
    return out


def _config_key(f: Dict[str, Any]) -> Tuple:
    return (f["model"], f["mode"], f["skills_enabled"], f["prompt_version"], f["judge_model"])


def _suffix(f: Dict[str, Any], differing: set) -> str:
    bits = []
    if "skills" in differing and f["skills_enabled"] is not None:
        bits.append("skills on" if f["skills_enabled"] else "skills off")
    if "prompt" in differing and f["prompt_version"]:
        bits.append(f"prompt {f['prompt_version']}")
    if "judge" in differing and f["judge_model"]:
        bits.append(f"judge {f['judge_model']}")
    return f" ({', '.join(bits)})" if bits else ""


async def models(session: AsyncSession, *, dataset: Optional[str] = None, version: Optional[str] = None, mode: Optional[str] = None, include_synthetic: bool = False) -> Dict[str, Any]:
    """One comparison set per dataset version and mode with real runs: every configuration's quality, reliability, latency and cost per PASSED test (all-in: the model,
    the judge, retries, fallbacks and anything unattributed), which are on the quality/cost frontier, and the model advice the numbers support."""
    facts = [f for f in await run_facts(session, include_synthetic=include_synthetic) if f["ran"] and f["model"] != "no model" and (not dataset or f["dataset"] == dataset) and (not version or f["version"] == version) and (not mode or f["mode"] == mode)]
    sets: Dict[Tuple, List[Dict[str, Any]]] = {}
    for f in facts:
        sets.setdefault((f["dataset"], f["version"], f["mode"]), []).append(f)
    rows_by_run = await result_rows(session, [f["_row_id"] for f in facts])
    out_sets = []
    for (ds, ver, md), fs in sorted(sets.items(), key=lambda kv: (str(kv[0][0]), str(kv[0][1]), kv[0][2])):
        by_cfg: Dict[Tuple, List[Dict[str, Any]]] = {}
        for f in fs:
            by_cfg.setdefault(_config_key(f), []).append(f)
        differing = set()
        for idx, name in ((2, "skills"), (3, "prompt"), (4, "judge")):
            if len({k[idx] for k in by_cfg}) > 1:
                differing.add(name)
        groups = []
        for key, members in by_cfg.items():
            rows = [r for f in members for r in rows_by_run.get(f["_row_id"], [])]
            agg = benchmark_lib.aggregate_model(key[0], rows, {"config": members[0]["_config"], "synthetic_model": members[0]["synthetic"]})
            comps: Dict[str, Dict[str, Any]] = {}
            for f in members:
                for c, v in f["by_component"].items():
                    t = comps.setdefault(c, {"usd": 0.0, "lines": 0, "unknown_lines": 0})
                    for k2 in t:
                        t[k2] += v[k2]
            total = sum(c["usd"] for c in comps.values())
            unknown = sum(c["unknown_lines"] for c in comps.values())
            passes = agg.get("passes") or 0
            measured = agg.get("status") == "measured"
            judge = (comps.get("judge") or {}).get("usd", 0.0)
            groups.append({"label": key[0] + _suffix(members[0], differing), "model": key[0], "synthetic": members[0]["synthetic"], "run_ids": [f["run_id"] for f in members], "runs": len(members),
                           "repetitions": sorted({f["repetitions"] for f in members}), "judge_model": key[4], "skills_enabled": key[2], "prompt_version": key[3],
                           "status": agg.get("status"), "ran": agg.get("ran", 0), "passes": passes, "pass_rate": agg.get("pass_rate") if measured else None,
                           "ci_low": agg.get("ci_low") if measured else None, "ci_high": agg.get("ci_high") if measured else None, "consistency": agg.get("consistency") if measured else None,
                           "flaky_cases": len(agg.get("flaky_cases") or []), "critical_failures": agg.get("critical_failures", 0) if measured else 0,
                           "latency_p50_ms": ((agg.get("latency_ms") or {}).get("p50") if measured else None), "latency_p95_ms": ((agg.get("latency_ms") or {}).get("p95") if measured else None),
                           "error_rate": agg.get("error_rate") if measured else None, "infrastructure_errors": agg.get("infrastructure_errors", 0),
                           "tokens": agg.get("tokens") if measured else None, "total_usd": round(total, 6), "judge_usd": round(judge, 6), "candidate_usd": round(total - judge, 6), "by_component": comps,
                           "unknown_lines": unknown, "per_passed_usd": (total / passes) if measured and passes and not unknown else None,
                           "candidate_per_passed_usd": ((total - judge) / passes) if measured and passes and not unknown else None,
                           "per_execution_usd": (total / agg["ran"]) if measured and agg.get("ran") and not unknown else None})
        cmp_ = ca.compare_models(groups)
        warnings = []
        if len({g["judge_model"] for g in groups}) > 1:
            warnings.append("the judge differs between these configurations, so their quality scores are not strictly comparable")
        if len({tuple(g["repetitions"]) for g in groups}) > 1:
            warnings.append("the configurations were run with different repetition counts; pass rates are still per execution, but reliability is measured over different numbers of repetitions")
        for g in cmp_["models"]:
            if not g["enough_evidence"]:
                warnings.append(f"{g['label']} has only {g['ran']} executions here (fewer than {ca.MIN_EVIDENCE_EXECUTIONS}): no model is called better or cheaper on that")
        out_sets.append({"dataset": ds, "version": ver, "mode": md, **cmp_, "warnings": warnings, "recommendations": ca.recommend_models(cmp_["models"], dataset=f"{ds} {ver}", mode=md)})
    return {"sets": out_sets, "include_synthetic": include_synthetic,
            "how_to_read": "Cost per passed test is everything the configuration cost in these runs (model, judge, retries, fallbacks, unattributed calls) divided by the tests it passed. "
                           "It is empty when any of the spending could not be priced. The interval is the 95% Wilson interval of the pass rate."}


async def benchmark_spending(session: AsyncSession, *, include_synthetic: bool = False, benchmark_id: Optional[str] = None) -> Dict[str, Any]:
    """What each benchmark cost in total and per model (one benchmark when `benchmark_id` is given), and all of them together."""
    facts = [f for f in await run_facts(session, include_synthetic=include_synthetic) if f["group_id"] and (not benchmark_id or f["group_id"] == benchmark_id)]
    by_group: Dict[str, List[Dict[str, Any]]] = {}
    for f in facts:
        by_group.setdefault(f["group_id"], []).append(f)
    meta = {b.benchmark_id: b for b in (await session.exec(select(EvalBenchmark).where(EvalBenchmark.benchmark_id.in_(list(by_group))))).all()} if by_group else {}
    items = []
    for gid, fs in by_group.items():
        b = meta.get(gid)
        items.append({"benchmark_id": gid, "mode": b.mode if b else fs[0]["mode"], "dataset": fs[0]["dataset"], "version": fs[0]["version"], "created_at": (b.created_at if b else fs[0]["started_at"]),
                      "repetitions": b.repetitions if b else fs[0]["repetitions"], "total_usd": round(sum(f["total_usd"] for f in fs), 6), "unknown_lines": sum(f["unknown_lines"] for f in fs),
                      "by_component": {c: round(sum((f["by_component"].get(c) or {}).get("usd", 0.0) for f in fs), 6) for c in sorted({c for f in fs for c in f["by_component"]})},
                      "models": [{"label": f["model"], "run_id": f["run_id"], "total_usd": round(f["total_usd"], 6), "judge_usd": round((f["by_component"].get("judge") or {}).get("usd", 0.0), 6),
                                  "by_component": {c: round(v["usd"], 6) for c, v in sorted(f["by_component"].items())},
                                  "passed": f["passed"], "ran": f["ran"], "per_passed_usd": (f["total_usd"] / f["passed"]) if f["passed"] and not f["unknown_lines"] else None} for f in fs]})
    items.sort(key=lambda i: i["created_at"] or datetime.min, reverse=True)
    return {"benchmarks": items, "total_usd": round(sum(i["total_usd"] for i in items), 6), "count": len(items)}


async def _series_lines(session: AsyncSession, start: datetime, end: datetime) -> List[Dict[str, Any]]:
    """The cost lines of the window, summed by the database per day, component, provider and model (the series does the rest)."""
    day = func.date_trunc("day", EvalCostLine.incurred_at)
    prov = provider_expr()
    rows = (await session.exec(select(day, EvalCostLine.component, prov, EvalCostLine.model, func.sum(EvalCostLine.usd), func.count(), func.count().filter(EvalCostLine.usd == None))     # noqa: E711
                               .where(EvalCostLine.incurred_at >= start, EvalCostLine.incurred_at <= end).group_by(day, EvalCostLine.component, prov, EvalCostLine.model))).all()
    return [{"incurred_at": d, "component": c, "provider": p, "model": m, "usd": (float(u) if u is not None else None), "n": int(n), "unknown_n": int(un)} for d, c, p, m, u, n, un in rows]


async def trends(session: AsyncSession, *, start: date, end: date, bucket: str = "day", group_by: Optional[str] = None, include_synthetic: bool = False,
                 currency: Optional[str] = None) -> Dict[str, Any]:
    """Money over time. With `currency`, every day is also shown in it at the rate in force that day; a day with no recorded rate is reported as unconverted dollars."""
    lo, hi = datetime.combine(start, time.min), datetime.combine(end, time.max)
    code = (currency or "").upper() or None
    rate_for = await eval_rates.rate_function(session, code) if code and code != "USD" else None
    out = ca.spend_series(await _series_lines(session, lo, hi), bucket=bucket, group_by=group_by, start=start, end=end, real_only=not include_synthetic, rate_for=rate_for)
    out["window"] = {"from": start.isoformat(), "to": end.isoformat()}
    if rate_for is not None:
        out["currency"] = code
        out["rate_now"] = await eval_rates.current(session, code)
    return out


async def anomalies(session: AsyncSession, *, start: date, end: date) -> Dict[str, Any]:
    """Unusual spending in the window. Runs and executions are judged against EARLIER ones (all history, not only the window), days against the month before them."""
    lo, hi = datetime.combine(start, time.min), datetime.combine(end, time.max)
    facts = await run_facts(session)                                    # real runs, all history: the baselines
    for f in facts:
        f["group"] = (f["model"], f["mode"], f["dataset"], f["version"])
    in_window = [f for f in facts if f["started_at"] and lo <= f["started_at"] <= hi]
    found: List[Dict[str, Any]] = []
    flagged = ca.run_anomalies(facts)
    found += [a for a in flagged if lo <= a["at"] <= hi]
    found += ca.waste_anomalies(in_window) + ca.unpriced_anomalies(in_window)
    series = ca.spend_series(await _series_lines(session, lo - timedelta(days=30), hi), bucket="day", start=(lo - timedelta(days=30)).date(), end=end)
    found += [a for a in ca.daily_spike_anomalies(series["points"]) if lo <= a["at"] <= hi]
    ids = {f["_row_id"]: f for f in facts}
    tok_rows: List[Dict[str, Any]] = []
    if ids:
        for rid, case, inp, out, model in (await session.exec(select(EvalCaseResult.run_row_id, EvalCaseResult.case_key, EvalCaseResult.input_tokens, EvalCaseResult.output_tokens, EvalCaseResult.model_id)
                                                              .where(EvalCaseResult.run_row_id.in_(list(ids)), EvalCaseResult.input_tokens != None))).all():           # noqa: E711
            f = ids[rid]
            tok_rows.append({"run_id": f["run_id"], "case_id": case, "model": model or f["model"], "tokens": int(inp or 0) + int(out or 0), "at": f["started_at"]})
    found += [a for a in ca.token_outliers(tok_rows) if lo <= a["at"] <= hi]
    ordered = ca.order_anomalies(found)
    counts: Dict[str, int] = {}
    for a in ordered:
        counts[a["kind"]] = counts.get(a["kind"], 0) + 1
    return {"window": {"from": start.isoformat(), "to": end.isoformat()}, "anomalies": ordered, "counts": counts,
            "checked": {"runs": len(in_window), "days": len(series["points"]), "executions": len(tok_rows)},
            "rules": {"run_cost": "more than 2x the median cost per execution of at least 3 earlier runs of the same model, mode, dataset and version, and $0.05 more than usual",
                      "daily_spike": "more than 3x the median of the previous active days in the last 30 (at least 4 of them), and $0.25 more",
                      "token_outlier": "more than 4x the median tokens of at least 4 earlier executions of the same case on the same model, and 20,000 more tokens",
                      "waste": "retries, fallbacks and unattributed calls are 10% or more of a run's cost", "unpriced": "executions whose cost could not be priced"}}


async def recommendations(session: AsyncSession, *, start: date, end: date, today: Optional[date] = None) -> Dict[str, Any]:
    today = today or datetime.utcnow().date()
    lo, hi = datetime.combine(start, time.min), datetime.combine(end, time.max)
    recs: List[Dict[str, Any]] = []
    for s in (await models(session))["sets"]:
        recs += s["recommendations"]
    prov = func.coalesce(provider_expr(), "")
    comps = {c: {"usd": float(u), "lines": int(n)} for c, u, n in (await session.exec(select(EvalCostLine.component, func.coalesce(func.sum(EvalCostLine.usd), 0.0), func.count())
                                                                                         .where(EvalCostLine.incurred_at >= lo, EvalCostLine.incurred_at <= hi, prov != "mock").group_by(EvalCostLine.component))).all()}
    total = sum(c["usd"] for c in comps.values())
    unknown = (await session.exec(select(func.count()).select_from(EvalCostLine).where(EvalCostLine.incurred_at >= lo, EvalCostLine.incurred_at <= hi, EvalCostLine.usd == None, prov != "mock"))).one()    # noqa: E711
    unpriced = [m for m in (await session.exec(select(EvalCostLine.model).where(EvalCostLine.usd == None, EvalCostLine.model != None, prov != "mock").distinct())).all()]                  # noqa: E711
    facts = [f for f in await run_facts(session) if f["started_at"] and lo <= f["started_at"] <= hi]
    reasons: Dict[str, int] = {}
    judged = 0
    if facts:
        for status, reason, judge_cost in (await session.exec(select(EvalCaseResult.status, EvalCaseResult.reason, EvalCaseResult.judge_cost_usd).where(EvalCaseResult.run_row_id.in_([f["_row_id"] for f in facts])))).all():
            if status == "infrastructure_error" and reason:
                reasons[reason] = reasons.get(reason, 0) + 1
            if judge_cost:
                judged += 1
    recs += ca.recommend_spending(by_component=comps, total_usd=total, retry_reasons=reasons, unknown_lines=int(unknown), unpriced_models=unpriced, judged_executions=judged, window=f"{start} to {end}")
    month_start = datetime.combine(today.replace(day=1), time.min)
    mtd = float((await session.exec(select(func.coalesce(func.sum(EvalCostLine.usd), 0.0)).where(EvalCostLine.incurred_at >= month_start, prov != "mock"))).one())
    limits = await eval_budget.current_limits(session)
    recs += ca.recommend_budget(ca.month_projection(mtd, today, limit_usd=limits["month"].limit_usd if limits.get("month") else None))
    recs.sort(key=lambda r: (-(r.get("estimated_saving_usd") or 0.0), ca.SEVERITY_ORDER.get(r["severity"], 9), r["id"]))
    return {"window": {"from": start.isoformat(), "to": end.isoformat()}, "recommendations": recs, "count": len(recs),
            "principle": "Every recommendation comes from recorded numbers and lists them. Nothing here changes a model, a judge or a budget; a person decides."}


async def overview(session: AsyncSession, *, currency: Optional[str] = None, today: Optional[date] = None) -> Dict[str, Any]:
    """Everything the Evaluation Costs page opens with, from one consistent read: this month and today against the budgets, what is running and has been committed, how sure the money is,
    the last 30 days by component, the provider statements that need a look, the attribution check, and what the analytics found."""
    from services import eval_costs, eval_reconcile
    today = today or datetime.utcnow().date()
    month_start, month_end = today.replace(day=1), today
    code = (currency or "").upper() or None
    budget = await eval_budget.status(session)
    certainty = await eval_reconcile.certainty(session, *eval_reconcile.period_of(month_start, month_end))
    month = await trends(session, start=month_start, end=month_end, bucket="day", group_by="component", currency=code)
    last30 = await trends(session, start=today - timedelta(days=29), end=today, bucket="day", group_by="component", currency=code)
    by_component: Dict[str, float] = {}
    by_provider: Dict[str, float] = {}
    for p in month["points"]:
        for c, v in p["by_group"].items():
            by_component[c] = by_component.get(c, 0.0) + v
    for prov, v in certainty["by_provider"].items():
        if prov != "mock":
            by_provider[prov] = round(v["total_usd"], 6)
    from shared.models.evaluation import EvalJob
    running = []
    for j in (await session.exec(select(EvalJob).where(EvalJob.state.in_(eval_budget.ACTIVE_JOB_STATES)).order_by(EvalJob.created_at))).all():
        if (j.config or {}).get("kind") == "drift_scan":
            continue
        running.append({"job_id": str(j.id), "state": j.state, "kind": (j.config or {}).get("kind"), "dataset": (j.config or {}).get("dataset"), "version": (j.config or {}).get("version"),
                        "models": (j.config or {}).get("models") or [(j.config or {}).get("model")], "estimated_usd": eval_budget.estimate_total(j.estimate), "spent_usd": (j.progress or {}).get("spent_usd"),
                        "executions": (j.progress or {}).get("executions"), "planned": (j.progress or {}).get("planned"), "started_at": j.started_at, "created_at": j.created_at})
    statements = await eval_reconcile.list_statements(session)
    active = [x for x in statements if not x["superseded"]]
    attention = [x for x in active if x["live"] and x["live"]["status"] != "matched"]
    attr = await eval_costs.attribution(session)
    start90, end90 = today - timedelta(days=90), today
    anomaly = await anomalies(session, start=start90, end=end90)
    recs = await recommendations(session, start=start90, end=end90, today=today)
    return {"as_of": datetime.utcnow(), "currency": code, "rate": await eval_rates.current(session, code) if code and code != "USD" else None, "budget": budget,
            "month": {"from": month_start.isoformat(), "to": month_end.isoformat(), "total_usd": month["total_usd"], "converted_total": month.get("converted_total"), "unconverted_usd": month.get("unconverted_usd"),
                      "unknown_lines": month["unknown_lines"], "by_component": {c: round(v, 6) for c, v in sorted(by_component.items())}, "by_provider": by_provider,
                      "certainty": certainty["totals"], "confirmed_by": certainty["confirmed_by"], "projection": ca.month_projection(month["total_usd"], today, limit_usd=(budget["periods"]["month"]["limit_usd"]))},
            "today_usd": next((p["total_usd"] for p in month["points"] if p["start"] == today.isoformat()), 0.0),
            "trend": {"points": last30["points"], "groups": last30["groups"], "total_usd": last30["total_usd"], "converted_total": last30.get("converted_total")},
            "running": running,
            "statements": {"count": len(active), "needs_attention": len(attention), "latest": [{"id": x["id"], "provider": x["provider"], "period_start": x["period_start"], "period_end": x["period_end"],
                                                                                                   "billed_usd": x["billed_usd"], "status": x["live"]["status"] if x["live"] else None,
                                                                                                   "difference_usd": x["live"]["difference_usd"] if x["live"] else None} for x in active[:5]]},
            "attribution": {"checked": attr["checked"], "with_problems": attr["with_problems"]},
            "anomalies": {"count": len(anomaly["anomalies"]), "high": sum(1 for a in anomaly["anomalies"] if a["severity"] == "high"), "counts": anomaly["counts"]},
            "recommendations": {"count": recs["count"], "estimated_saving_usd": round(sum(r.get("estimated_saving_usd") or 0.0 for r in recs["recommendations"]), 4),
                                "top": [{"id": r["id"], "kind": r["kind"], "title": r["title"], "severity": r["severity"]} for r in recs["recommendations"][:3]]}}
