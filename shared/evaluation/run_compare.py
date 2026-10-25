"""Two runs side by side: which cases got worse, which got better, what else changed, and what it cost. Pure logic over plain rows, no database.

A case is compared by its OUTCOME across the repetitions that produced a verdict (passed or failed):
  passed       every verdict-producing execution passed
  failed       at least one failed (`pass_fraction` says how many passed)
  no_verdict   the case ran but produced no verdict (blocked, skipped, infrastructure error)
Two runs of different dataset versions or models are still compared, but the note says they are not like for like. Nothing is guessed: a cost that is unknown in either run stays unknown.

A row: {case, repetition, status, latency_ms, cost_usd, cost_known}
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Dict, List, Optional, Sequence

from shared.evaluation import stats

RAN = ("passed", "failed")


def case_outcomes(rows: Sequence[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    by: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by[r["case"]].append(r)
    out: Dict[str, Dict[str, Any]] = {}
    for case, xs in by.items():
        ran = [x for x in xs if x["status"] in RAN]
        passed = sum(1 for x in ran if x["status"] == "passed")
        if not ran:
            outcome = "no_verdict"
        else:
            outcome = "passed" if passed == len(ran) else "failed"
        statuses = sorted({x["status"] for x in xs})
        out[case] = {"outcome": outcome, "executions": len(xs), "ran": len(ran), "passed": passed, "pass_fraction": (passed / len(ran)) if ran else None, "statuses": statuses}
    return out


def _totals(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    ran = [r for r in rows if r["status"] in RAN]
    passed = sum(1 for r in ran if r["status"] == "passed")
    unknown = [r for r in rows if r["status"] in RAN and not r.get("cost_known")]
    known = [float(r["cost_usd"]) for r in rows if r.get("cost_known") and r.get("cost_usd") is not None]
    lat = [float(r["latency_ms"]) for r in ran if r.get("latency_ms") is not None]
    return {"executions": len(rows), "ran": len(ran), "passed": passed, "failed": len(ran) - passed, "pass_rate": (passed / len(ran)) if ran else None,
            "cost_usd": round(sum(known), 6) if known else None, "unknown_cost_executions": len(unknown),
            "cost_per_execution_usd": (sum(known) / len(known)) if known and not unknown else None,
            "latency_p50_ms": stats.percentile(lat, 50), "latency_p95_ms": stats.percentile(lat, 95)}


def _delta(a: Optional[float], b: Optional[float]) -> Optional[float]:
    return None if a is None or b is None else b - a


def compare_runs(rows_a: Sequence[Dict[str, Any]], rows_b: Sequence[Dict[str, Any]], *, meta_a: Optional[Dict[str, Any]] = None, meta_b: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """A is the earlier or baseline run, B the later or candidate one: `newly_failing` passed in A and fails in B."""
    meta_a, meta_b = meta_a or {}, meta_b or {}
    oa, ob = case_outcomes(rows_a), case_outcomes(rows_b)
    common = sorted(set(oa) & set(ob))
    newly_failing, newly_passing, changed, same = [], [], [], 0
    for c in common:
        a, b = oa[c], ob[c]
        item = {"case": c, "a": a["outcome"], "b": b["outcome"], "a_pass_fraction": a["pass_fraction"], "b_pass_fraction": b["pass_fraction"], "a_statuses": a["statuses"], "b_statuses": b["statuses"]}
        if a["outcome"] == b["outcome"]:
            same += 1
        elif a["outcome"] == "passed" and b["outcome"] == "failed":
            newly_failing.append(item)
        elif a["outcome"] == "failed" and b["outcome"] == "passed":
            newly_passing.append(item)
        else:
            changed.append(item)                                   # a verdict gained or lost: passed or failed to or from no verdict
    ta, tb = _totals(rows_a), _totals(rows_b)
    notes: List[str] = []
    for key, label in (("dataset", "dataset"), ("version", "dataset version"), ("model", "model"), ("judge_model", "judge")):
        if meta_a.get(key) != meta_b.get(key):
            notes.append(f"the runs differ in {label} ({meta_a.get(key)} against {meta_b.get(key)}), so they are not like for like")
    if ta["unknown_cost_executions"] or tb["unknown_cost_executions"]:
        notes.append("some executions have an unknown cost; the cost difference is not given unless both totals are complete")
    only_a, only_b = sorted(set(oa) - set(ob)), sorted(set(ob) - set(oa))
    if only_a or only_b:
        notes.append(f"{len(only_a)} case(s) ran only in A and {len(only_b)} only in B; they are listed, not compared")
    complete = not ta["unknown_cost_executions"] and not tb["unknown_cost_executions"]
    return {"a": ta, "b": tb, "cases_compared": len(common), "unchanged": same, "newly_failing": newly_failing, "newly_passing": newly_passing, "changed": changed, "only_in_a": only_a, "only_in_b": only_b,
            "delta": {"pass_rate": _delta(ta["pass_rate"], tb["pass_rate"]), "cost_usd": _delta(ta["cost_usd"], tb["cost_usd"]) if complete else None,
                      "latency_p50_ms": _delta(ta["latency_p50_ms"], tb["latency_p50_ms"]), "latency_p95_ms": _delta(ta["latency_p95_ms"], tb["latency_p95_ms"])}, "notes": notes}
