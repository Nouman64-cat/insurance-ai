"""What a set of executions says, summed up for the Investigate analytics view. Pure logic over plain rows, no database.

Every figure is computed from the executions it is shown for, and says how many that is. A layer that did not apply to an execution is not counted as passed or failed for it; a model
with too few repeated cases has no consistency figure rather than a made-up one. Nothing here guesses.

A row: {model, dataset, case_id, repetition, status, critical_failed, latency_ms, layer_scores, specialist, tools, at}
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence

from shared.evaluation import stats

LAYERS = ("L1", "L2", "L3", "L4", "L5", "L6")
LAYER_NAMES = {"L1": "Inputs and fixtures", "L2": "Output quality (judged)", "L3": "Agent trajectory: routing, skills, tools", "L4": "Workflow and state", "L5": "Security and business rules", "L6": "Performance and cost limits"}
STATUSES = ("passed", "failed", "blocked", "skipped", "infrastructure_error")
RAN = ("passed", "failed")


def _layer(row: Dict[str, Any], layer: str) -> Optional[Dict[str, Any]]:
    v = (row.get("layer_scores") or {}).get(layer)
    return v if isinstance(v, dict) and v.get("applicable") else None


def outcomes(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """How many executions ended each way, overall and per model."""
    by_model: Dict[str, Counter] = defaultdict(Counter)
    for r in rows:
        by_model[r["model"] or "no model"][r["status"]] += 1
    total = Counter(r["status"] for r in rows)
    ran = sum(total[s] for s in RAN)
    return {"total": len(rows), "by_status": {s: total.get(s, 0) for s in STATUSES}, "pass_rate": (total["passed"] / ran) if ran else None, "critical_failures": sum(1 for r in rows if r.get("critical_failed")),
            "by_model": {m: {s: c.get(s, 0) for s in STATUSES} for m, c in sorted(by_model.items())}}


def coverage(rows: Sequence[Dict[str, Any]], version_cases: Dict[str, int]) -> Dict[str, Any]:
    """Per dataset: how many of the latest published version's cases have been run to a verdict at least once in these executions."""
    run_cases: Dict[str, set] = defaultdict(set)
    for r in rows:
        if r["status"] in RAN and r.get("dataset"):
            run_cases[r["dataset"]].add(r["case_id"])
    out = {}
    for ds in sorted(set(version_cases) | set(run_cases)):
        total = version_cases.get(ds)
        n = len(run_cases.get(ds, ()))
        out[ds] = {"cases_run": n, "cases_total": total, "share": (min(n, total) / total) if total else None}
    return out


def layer_scores(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Per model and layer (L1 to L6): how many executions the layer applied to, how many passed and failed it, and its mean score. An execution a layer did not apply to is left out of that layer."""
    models: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for r in rows:
        if r["status"] not in RAN:
            continue
        m = models.setdefault(r["model"] or "no model", {l: {"applicable": 0, "passed": 0, "failed": 0, "other": 0, "scores": []} for l in LAYERS})
        for l in LAYERS:
            v = _layer(r, l)
            if v is None:
                continue
            b = m[l]
            b["applicable"] += 1
            st = v.get("status")
            b["passed" if st == "passed" else "failed" if st == "failed" else "other"] += 1
            if isinstance(v.get("score"), (int, float)):
                b["scores"].append(float(v["score"]))
    out = {}
    for model, ls in sorted(models.items()):
        out[model] = {l: {"applicable": b["applicable"], "passed": b["passed"], "failed": b["failed"], "other": b["other"],
                          "pass_rate": (b["passed"] / (b["passed"] + b["failed"])) if (b["passed"] + b["failed"]) else None, "mean_score": (sum(b["scores"]) / len(b["scores"])) if b["scores"] else None} for l, b in ls.items()}
    return {"layers": list(LAYERS), "names": LAYER_NAMES, "by_model": out}


def routing(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Agent routing and tool-calling accuracy, from the agent-trajectory layer (L3): per specialist and per tool, how many executions used it and how many of those passed L3.
    Only executions where L3 applied are judged; the others are counted as 'used' without a verdict on the trajectory."""
    def blank() -> Dict[str, int]:
        return {"executions": 0, "l3_applied": 0, "l3_passed": 0, "l3_failed": 0}
    sp: Dict[str, Dict[str, int]] = defaultdict(blank)
    tl: Dict[str, Dict[str, int]] = defaultdict(blank)
    for r in rows:
        if r["status"] not in RAN:
            continue
        v = _layer(r, "L3")
        names = [("sp", r["specialist"])] if r.get("specialist") else []
        names += [("tl", t) for t in sorted(set(r.get("tools") or []))]
        for kind, name in names:
            b = (sp if kind == "sp" else tl)[name]
            b["executions"] += 1
            if v is not None and v.get("status") in ("passed", "failed"):
                b["l3_applied"] += 1
                b["l3_passed" if v["status"] == "passed" else "l3_failed"] += 1
    fin = lambda d: {k: {**v, "accuracy": (v["l3_passed"] / v["l3_applied"]) if v["l3_applied"] else None} for k, v in sorted(d.items(), key=lambda kv: (-kv[1]["executions"], kv[0]))}
    overall = [_layer(r, "L3") for r in rows if r["status"] in RAN]
    applied = [v for v in overall if v is not None and v.get("status") in ("passed", "failed")]
    return {"specialists": fin(sp), "tools": fin(tl), "overall": {"l3_applied": len(applied), "l3_passed": sum(1 for v in applied if v["status"] == "passed"),
                                                                 "accuracy": (sum(1 for v in applied if v["status"] == "passed") / len(applied)) if applied else None}}


def latency(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Average, P50 and P95 latency per model, over the executions that produced a verdict and reported a latency."""
    by: Dict[str, List[float]] = defaultdict(list)
    for r in rows:
        if r["status"] in RAN and r.get("latency_ms") is not None:
            by[r["model"] or "no model"].append(float(r["latency_ms"]))
    return {m: {k: v for k, v in stats.describe(xs).items() if k in ("n", "mean", "p50", "p95", "max")} for m, xs in sorted(by.items())}


def reliability(rows: Sequence[Dict[str, Any]], *, min_repeated: int = 3) -> Dict[str, Any]:
    """Per model: how many cases were run more than once, how consistently they gave the same verdict, and which flipped. With fewer than `min_repeated` repeated cases there is no consistency figure."""
    by: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by[r["model"] or "no model"].append({"case_id": r["case_id"], "status": r["status"], "score": None, "latency_ms": r.get("latency_ms"), "cost_usd": None, "critical_failed": r.get("critical_failed"),
                                            "trace_summary": {"executed_tools": r.get("tools") or []}})
    out = {}
    for m, rs in sorted(by.items()):
        rel = stats.run_reliability(rs)
        repeated = rel["repeated_cases"]
        out[m] = {"cases": rel["cases"], "repeated_cases": repeated, "decision_consistency": rel["decision_consistency"] if repeated >= min_repeated else None, "flaky_cases": rel["flaky_cases"],
                  "consistently_wrong": len(rel["consistently_wrong_cases"]), "all_runs_success_rate": rel["all_runs_success_rate"] if repeated >= min_repeated else None}
    return out


def drift_timeline(items: Iterable[Dict[str, Any]], *, now: Optional[datetime] = None, weeks: int = 12) -> Dict[str, Any]:
    """New review items per ISO week and kind, for the last `weeks` weeks (weeks with none are present, with zero). `items`: {"opened_at", "kind", "state"}."""
    now = now or datetime.utcnow()
    monday = (now - timedelta(days=now.weekday())).date()
    starts = [monday - timedelta(weeks=i) for i in range(weeks - 1, -1, -1)]
    first = starts[0]
    pts = {s.isoformat(): Counter() for s in starts}
    kinds: set = set()
    for it in items:
        d = it["opened_at"].date() if isinstance(it["opened_at"], datetime) else it["opened_at"]
        if d < first:
            continue
        s = (d - timedelta(days=d.weekday())).isoformat()
        if s in pts:
            pts[s][it["kind"]] += 1
            kinds.add(it["kind"])
    return {"weeks": [{"start": k, "total": sum(c.values()), "by_kind": dict(c)} for k, c in pts.items()], "kinds": sorted(kinds), "total": sum(sum(c.values()) for c in pts.values())}


def summarise(rows: Sequence[Dict[str, Any]], *, version_cases: Dict[str, int], drift_items: Iterable[Dict[str, Any]] = (), now: Optional[datetime] = None) -> Dict[str, Any]:
    return {"executions": len(rows), "outcomes": outcomes(rows), "coverage": coverage(rows, version_cases), "layers": layer_scores(rows), "routing": routing(rows), "latency": latency(rows),
            "reliability": reliability(rows), "drift": drift_timeline(drift_items, now=now)}
