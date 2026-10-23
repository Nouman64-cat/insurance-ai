"""Reliability statistics for repeated evaluations. Pure functions: no database, no network, no model.

Why repeat. A deterministic operation (a premium, a rule, an HTTP permission) gives the same answer every time, so repeating it only
costs time. A model-backed case does not: the same conversation can pass twice and fail once. Each repetition here is independent (a
freshly reset database, a new conversation thread), and these functions turn the repetitions into numbers you can act on.

What is reported, per case (over the executions that RAN; blocked, skipped and infrastructure errors are not evidence either way):
  n, passes, pass_rate and its Wilson 95% interval (honest for small n and for rates near 0 or 1, unlike the normal approximation)
  class     stable_pass   every one of n >= 2 repetitions passed
            stable_fail   every one failed: a CONSISTENT WRONG ANSWER. It is a failure, never a success because it is repeatable
            flaky         both outcomes occurred
            insufficient  fewer than 2 repetitions ran, so consistency cannot be judged
  decision_consistency   the share of repetitions that reached the most common verdict (pass/fail)
  tool_consistency       the share that made the most common sequence of executed tools (chat cases)
Per run: pass rate with interval, the share of cases that passed in ALL repetitions, flaky cases, the critical failure rate, and the
latency and cost distributions. A quality gate turns those into pass/fail, with CRITICAL cases held to a stricter standard.
"""
from __future__ import annotations

import math
import random
from collections import Counter
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

Z95 = 1.959963984540054
RAN = ("passed", "failed")
DEFAULT_REPETITIONS = {"deterministic": 1, "model": 3, "benchmark": 5}


# ── intervals ───────────────────────────────────────────────────────────────────────────────────────────────────────────

def wilson(successes: int, n: int, z: float = Z95) -> Optional[Tuple[float, float]]:
    """The Wilson score interval for a proportion. None when there is no sample."""
    if n <= 0:
        return None
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def percentile(values: Sequence[float], p: float) -> Optional[float]:
    """Linear-interpolated percentile (p in 0..100). None for an empty sample."""
    if not values:
        return None
    v = sorted(values)
    k = (len(v) - 1) * p / 100
    lo, hi = math.floor(k), math.ceil(k)
    return v[lo] if lo == hi else v[lo] + (v[hi] - v[lo]) * (k - lo)


def describe(values: Sequence[float]) -> Dict[str, Optional[float]]:
    vals = [float(x) for x in values if x is not None]
    if not vals:
        return {"n": 0, "mean": None, "p50": None, "p95": None, "min": None, "max": None, "stdev": None}
    mean = sum(vals) / len(vals)
    stdev = math.sqrt(sum((x - mean) ** 2 for x in vals) / (len(vals) - 1)) if len(vals) > 1 else 0.0
    return {"n": len(vals), "mean": mean, "p50": percentile(vals, 50), "p95": percentile(vals, 95), "min": min(vals), "max": max(vals), "stdev": stdev}


# ── repetition policy ───────────────────────────────────────────────────────────────────────────────────────────────────

def case_class_of(case: Dict[str, Any], *, model_backed: bool) -> str:
    return "model" if model_backed else "deterministic"


def repetitions_for(case_class: str, *, kind: str = "suite", override: Optional[int] = None) -> int:
    """How many times a case runs by default: deterministic operations once, model-backed and chat cases three times, a benchmark five;
    an explicit number always wins."""
    if override is not None:
        if override < 1:
            raise ValueError("repetitions must be at least 1")
        return override
    if kind.startswith("benchmark"):
        return DEFAULT_REPETITIONS["benchmark"] if case_class == "model" else 1
    return DEFAULT_REPETITIONS[case_class]


# ── per case ────────────────────────────────────────────────────────────────────────────────────────────────────────────

def _sig(result: Dict[str, Any]) -> str:
    t = result.get("trace_summary") or {}
    return "|".join(t.get("executed_tools") or []) if t else ""


def aggregate_case(executions: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Reliability of one case over its repetitions. `executions` are result rows (dicts with status, score, latency_ms, cost_usd,
    critical_failed, trace_summary)."""
    ran = [e for e in executions if e["status"] in RAN]
    passes = sum(1 for e in ran if e["status"] == "passed")
    n = len(ran)
    other = Counter(e["status"] for e in executions if e["status"] not in RAN)
    if n >= 2:
        klass = "stable_pass" if passes == n else "stable_fail" if passes == 0 else "flaky"
    else:
        klass = "insufficient"
    verdicts = Counter(e["status"] for e in ran)
    sigs = Counter(_sig(e) for e in ran)
    ci = wilson(passes, n)
    scores = [e["score"] for e in ran if e.get("score") is not None]
    return {
        "n": n, "passes": passes, "fails": n - passes, "other": dict(other), "pass_rate": (passes / n) if n else None,
        "ci_low": ci[0] if ci else None, "ci_high": ci[1] if ci else None, "class": klass,
        "decision_consistency": (verdicts.most_common(1)[0][1] / n) if n else None,
        "tool_consistency": (sigs.most_common(1)[0][1] / n) if n else None,
        "critical_failures": sum(1 for e in ran if e.get("critical_failed")),
        "score": describe(scores), "latency_ms": describe([e["latency_ms"] for e in ran if e.get("latency_ms") is not None]),
        "cost_usd": describe([e["cost_usd"] for e in ran if e.get("cost_known", True) and e.get("cost_usd") is not None]),
        "unknown_cost": sum(1 for e in executions if not e.get("cost_known", True)),
    }


def group_by_case(results: Iterable[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    out: Dict[str, List[Dict[str, Any]]] = {}
    for r in results:
        out.setdefault(r.get("case_key") or r.get("case_id"), []).append(r)
    return out


# ── per run ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

def run_reliability(results: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """The reliability of a whole run: per-case aggregates and the totals."""
    per_case = {case: aggregate_case(rows) for case, rows in group_by_case(results).items()}
    ran = [r for r in results if r["status"] in RAN]
    passes = sum(1 for r in ran if r["status"] == "passed")
    ci = wilson(passes, len(ran))
    judged = [c for c in per_case.values() if c["n"] >= 1]
    repeated = [c for c in judged if c["n"] >= 2]
    classes = Counter(c["class"] for c in per_case.values())
    return {
        "cases": len(per_case), "executions": len(results), "ran": len(ran),
        "pass_rate": (passes / len(ran)) if ran else None, "ci_low": ci[0] if ci else None, "ci_high": ci[1] if ci else None,
        "all_runs_success_rate": (sum(1 for c in repeated if c["class"] == "stable_pass") / len(repeated)) if repeated else None,
        "repeated_cases": len(repeated), "classes": dict(classes), "flaky_cases": sorted(k for k, c in per_case.items() if c["class"] == "flaky"),
        "consistently_wrong_cases": sorted(k for k, c in per_case.items() if c["class"] == "stable_fail"),
        "decision_consistency": _mean([c["decision_consistency"] for c in repeated]), "tool_consistency": _mean([c["tool_consistency"] for c in repeated]),
        "critical_failure_rate": (sum(1 for r in ran if r.get("critical_failed")) / len(ran)) if ran else None,
        "latency_ms": describe([r["latency_ms"] for r in ran if r.get("latency_ms") is not None]),
        "cost_usd": describe([r["cost_usd"] for r in ran if r.get("cost_known", True) and r.get("cost_usd") is not None]),
        "unknown_cost_executions": sum(1 for r in results if not r.get("cost_known", True)),
        "per_case": per_case,
    }


def _mean(values: Sequence[Optional[float]]) -> Optional[float]:
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else None


# ── quality gate ────────────────────────────────────────────────────────────────────────────────────────────────────────

DEFAULT_GATE = {"min_pass_rate": 0.9, "critical_pass_rate": 1.0, "max_flaky_cases": 0, "min_repetitions": 1, "max_critical_failure_rate": 0.0}


def evaluate_gate(results: Sequence[Dict[str, Any]], config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Apply thresholds to a run. A case whose severity is critical must pass in `critical_pass_rate` of its repetitions (1.0 = every
    one: a critical case that passed 4 of 5 times fails the gate). Fewer repetitions than `min_repetitions` for a model-backed case is
    a failed check, not a pass. Returns {"passed", "checks": [...]}; every check says what was measured and what was required."""
    cfg = {**DEFAULT_GATE, **(config or {})}
    rel = run_reliability(results)
    checks: List[Dict[str, Any]] = []

    def check(name: str, value: Any, threshold: Any, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "value": value, "threshold": threshold, "ok": bool(ok), "detail": detail})
    rate = rel["pass_rate"]
    check("pass_rate", rate, cfg["min_pass_rate"], rate is not None and rate >= cfg["min_pass_rate"], "of the executions that ran" if rate is not None else "nothing ran")
    critical_cases = {r.get("case_key") or r.get("case_id") for r in results if r.get("severity") == "critical"}
    short: List[str] = []
    for case in sorted(critical_cases):
        c = rel["per_case"][case]
        if c["n"] and c["pass_rate"] < cfg["critical_pass_rate"]:
            short.append(f"{case} {c['passes']}/{c['n']}")
    check("critical_cases", len(short), 0, not short, ", ".join(short) if short else f"{len(critical_cases)} critical case(s), all at or above {cfg['critical_pass_rate']:.0%}")
    flaky = rel["flaky_cases"]
    check("flaky_cases", len(flaky), cfg["max_flaky_cases"], len(flaky) <= cfg["max_flaky_cases"], ", ".join(flaky[:8]))
    cfr = rel["critical_failure_rate"]
    check("critical_failure_rate", cfr, cfg["max_critical_failure_rate"], cfr is None or cfr <= cfg["max_critical_failure_rate"])
    if cfg["min_repetitions"] > 1:
        thin = sorted(k for k, c in rel["per_case"].items() if 0 < c["n"] < cfg["min_repetitions"])
        check("repetitions", len(thin), 0, not thin, (f"fewer than {cfg['min_repetitions']} repetitions: " + ", ".join(thin[:8])) if thin else "")
    return {"passed": all(c["ok"] for c in checks), "checks": checks, "config": cfg}


# ── comparing two runs of the same cases ────────────────────────────────────────────────────────────────────────────────

def _binom_two_sided(k: int, n: int) -> float:
    """Exact two-sided sign test p-value for k of n successes under p = 0.5."""
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, i) for i in range(0, min(k, n - k) + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def paired_compare(a: Sequence[Dict[str, Any]], b: Sequence[Dict[str, Any]], *, seed: int = 7, resamples: int = 2000) -> Dict[str, Any]:
    """Paired comparison of two runs over the cases they share (skills on vs off, prompt v1 vs v2, model A vs model B). Each case is
    compared by its pass rate over its repetitions. Reports the mean difference in pass rate with a bootstrap 95% interval (seeded, so
    it is reproducible), and an exact sign test on the cases that moved: A better on x cases, B better on y. With few cases or no case
    that differs, it says so rather than inventing significance."""
    ga, gb = group_by_case(a), group_by_case(b)
    shared = sorted(set(ga) & set(gb))
    rows, wins_a, wins_b = [], 0, 0
    diffs: List[float] = []
    for case in shared:
        ca, cb = aggregate_case(ga[case]), aggregate_case(gb[case])
        if ca["pass_rate"] is None or cb["pass_rate"] is None:
            continue
        d = cb["pass_rate"] - ca["pass_rate"]
        diffs.append(d)
        wins_a += d < 0
        wins_b += d > 0
        rows.append({"case": case, "a": ca["pass_rate"], "b": cb["pass_rate"], "diff": d})
    out: Dict[str, Any] = {"cases_compared": len(rows), "only_in_a": sorted(set(ga) - set(gb)), "only_in_b": sorted(set(gb) - set(ga)), "a_better": wins_a,
                           "b_better": wins_b, "mean_diff": (sum(diffs) / len(diffs)) if diffs else None, "rows": rows}
    out["sign_test_p"] = _binom_two_sided(min(wins_a, wins_b), wins_a + wins_b) if wins_a + wins_b else None
    if diffs:
        rng = random.Random(seed)
        means = sorted(sum(rng.choice(diffs) for _ in diffs) / len(diffs) for _ in range(resamples))
        out["diff_ci_low"], out["diff_ci_high"] = means[int(0.025 * resamples)], means[int(0.975 * resamples) - 1]
    else:
        out["diff_ci_low"] = out["diff_ci_high"] = None
    out["note"] = ("no case differs between the runs" if rows and not (wins_a + wins_b) else
                   "too few cases that differ to say the difference is real" if (wins_a + wins_b) < 6 else "")
    return out


def _fisher_less(a_pass: int, a_n: int, b_pass: int, b_n: int) -> float:
    """One-sided Fisher exact p that B's pass rate is LOWER than A's by chance (hypergeometric)."""
    total_pass, total_n = a_pass + b_pass, a_n + b_n
    denom = math.comb(total_n, a_n)
    p = 0.0
    for x in range(max(0, a_n - (total_n - total_pass)), min(a_n, total_pass) + 1):
        if x >= a_pass:                              # A at least as good as observed
            p += math.comb(total_pass, x) * math.comb(total_n - total_pass, a_n - x) / denom
    return min(1.0, p)


def detect_regressions(baseline: Sequence[Dict[str, Any]], current: Sequence[Dict[str, Any]], *, min_drop: float = 0.2, alpha: float = 0.2) -> List[Dict[str, Any]]:
    """Cases that got worse from `baseline` to `current`. A case regresses when its pass rate fell by at least `min_drop` AND the fall is
    unlikely to be chance (Fisher exact, one-sided, `alpha`), or when it passed every time before and a CRITICAL case now fails at all.
    With a single repetition each there is no statistics to apply: any pass->fail is reported as `unconfirmed`."""
    gb, gc = group_by_case(baseline), group_by_case(current)
    found: List[Dict[str, Any]] = []
    for case in sorted(set(gb) & set(gc)):
        a, b = aggregate_case(gb[case]), aggregate_case(gc[case])
        if not a["n"] or not b["n"]:
            continue
        drop = a["pass_rate"] - b["pass_rate"]
        critical = any(r.get("severity") == "critical" for r in gc[case])
        if a["n"] == 1 and b["n"] == 1:
            if drop > 0:
                found.append({"case": case, "from": a["pass_rate"], "to": b["pass_rate"], "p": None, "critical": critical, "evidence": "unconfirmed (one repetition each)"})
            continue
        p = _fisher_less(a["passes"], a["n"], b["passes"], b["n"])
        if (drop >= min_drop and p <= alpha) or (critical and a["pass_rate"] == 1.0 and b["pass_rate"] < 1.0):
            found.append({"case": case, "from": a["pass_rate"], "to": b["pass_rate"], "p": p, "critical": critical, "evidence": "statistical" if p <= alpha else "critical case no longer perfect"})
    return found


# ── stopping ────────────────────────────────────────────────────────────────────────────────────────────────────────────

def should_stop_on_critical(results: Sequence[Dict[str, Any]], *, enabled: bool) -> Optional[str]:
    """A reason to stop the run early, or None. Stopping on the first critical failure saves money when the run is already a no."""
    if not enabled:
        return None
    for r in results:
        if r["status"] == "failed" and r.get("critical_failed"):
            return f"critical failure in {r.get('case_key') or r.get('case_id')} (repetition {r.get('repetition', 1)})"
    return None


def can_afford(spent_usd: float, next_estimate_usd: float, budget_usd: Optional[float]) -> bool:
    """No repetition starts that the budget cannot pay for."""
    return budget_usd is None or spent_usd + next_estimate_usd <= budget_usd
