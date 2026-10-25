"""Cost analytics: spending over time, unusual spending, which model gives the most for the money, and what to do about it. Pure logic, no database.

Everything here is computed from recorded numbers (cost lines, run results) and says which numbers: no model is asked for an opinion, and a statement the numbers do
not support is not made. Where the evidence is thin (few executions, an interval that overlaps) the output says so instead of choosing a winner.

  spend_series        money per day / week / month, optionally split by component, provider or model, with gaps filled and a running total
  *_anomalies         explainable rules, each naming the observed value, the baseline it was compared with, and the evidence:
                        run_cost        a run cost much more per execution than earlier runs of the same model on the same data
                        daily_spike     a day's spend far above the usual active day
                        token_outlier   an execution used far more tokens than the same case did before on the same model
                        waste           retries, fallbacks and unattributed calls are a large share of a run's cost
                        unpriced        executions whose cost could not be priced (their cost is in no total)
  compare_models      per configuration: quality (with its interval), reliability, latency, cost per passed test; which are on the quality/cost frontier
  recommendations     only what the comparison and the series support, each with its evidence, a saving where one can be computed, and its caveats
"""
from __future__ import annotations

import calendar
import statistics
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from shared.evaluation.cost_lines import provider_of

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2, "info": 3}
MIN_EVIDENCE_EXECUTIONS = 30                          # fewer executions than this, and no model is called better or cheaper than another


# ── time buckets and the spend series ──────────────────────────────────────────────────────────────────────────────────

def bucket_start(at: datetime, bucket: str) -> date:
    d = at.date() if isinstance(at, datetime) else at
    if bucket == "day":
        return d
    if bucket == "week":
        return d - timedelta(days=d.weekday())                       # ISO week: Monday
    if bucket == "month":
        return d.replace(day=1)
    raise ValueError("bucket is day, week or month")


def next_bucket(d: date, bucket: str) -> date:
    if bucket == "day":
        return d + timedelta(days=1)
    if bucket == "week":
        return d + timedelta(days=7)
    return date(d.year + (d.month == 12), 1 if d.month == 12 else d.month + 1, 1)


def line_provider(line: Dict[str, Any]) -> Optional[str]:
    return line.get("provider") or provider_of(line.get("model"))


def spend_series(lines: Iterable[Dict[str, Any]], *, bucket: str = "day", group_by: Optional[str] = None, start: Optional[date] = None, end: Optional[date] = None,
                 real_only: bool = True, rate_for: Optional[Any] = None) -> Dict[str, Any]:
    """Money per bucket. A line whose cost is unknown adds to `unknown_lines`, never to the money. `real_only` leaves out the scripted models (they cost nothing).
    `rate_for(moment) -> units per dollar or None` adds the money in a second currency, each line converted at the rate in force on ITS day; money on a day with no recorded
    rate is not converted at another rate, it is reported as `unconverted_usd`."""
    if group_by not in (None, "component", "provider", "model"):
        raise ValueError("group_by is component, provider or model")
    pts: Dict[date, Dict[str, Any]] = {}
    groups: set = set()
    for l in lines:
        if real_only and line_provider(l) == "mock":
            continue
        at = l["incurred_at"]
        day = at.date() if isinstance(at, datetime) else at
        if (start and day < start) or (end and day > end):
            continue
        p = pts.setdefault(bucket_start(at, bucket), {"total_usd": 0.0, "lines": 0, "unknown_lines": 0, "by_group": {}, "conv_total": 0.0, "conv_by_group": {}, "unconverted_usd": 0.0})
        p["lines"] += l.get("n", 1)                                   # a pre-summed row (the database grouped it) says how many lines it stands for
        p["unknown_lines"] += l.get("unknown_n", 1 if l.get("usd") is None else 0)
        if l.get("usd") is None:
            continue
        p["total_usd"] += l["usd"]
        g = None
        if group_by:
            g = (l.get("component") if group_by == "component" else line_provider(l) if group_by == "provider" else l.get("model")) or "unknown"
            groups.add(g)
            p["by_group"][g] = p["by_group"].get(g, 0.0) + l["usd"]
        if rate_for is not None:
            factor = rate_for(at)
            if factor is None:
                p["unconverted_usd"] += l["usd"]
            else:
                p["conv_total"] += l["usd"] * factor
                if g is not None:
                    p["conv_by_group"][g] = p["conv_by_group"].get(g, 0.0) + l["usd"] * factor
    first = bucket_start(start, bucket) if start else (min(pts) if pts else None)
    last = bucket_start(end, bucket) if end else (max(pts) if pts else None)
    points: List[Dict[str, Any]] = []
    running = running_conv = unconverted = 0.0
    d = first
    while d is not None and last is not None and d <= last:
        p = pts.get(d, {"total_usd": 0.0, "lines": 0, "unknown_lines": 0, "by_group": {}, "conv_total": 0.0, "conv_by_group": {}, "unconverted_usd": 0.0})
        running += p["total_usd"]
        point = {"start": d.isoformat(), "total_usd": round(p["total_usd"], 6), "lines": p["lines"], "unknown_lines": p["unknown_lines"],
                 "by_group": {g: round(v, 6) for g, v in sorted(p["by_group"].items())}, "cumulative_usd": round(running, 6)}
        if rate_for is not None:
            running_conv += p["conv_total"]
            unconverted += p["unconverted_usd"]
            point["converted"] = {"total": round(p["conv_total"], 4), "by_group": {g: round(v, 4) for g, v in sorted(p["conv_by_group"].items())}, "cumulative": round(running_conv, 4),
                                  "unconverted_usd": round(p["unconverted_usd"], 6)}
        points.append(point)
        d = next_bucket(d, bucket)
    active = [p for p in points if p["total_usd"] > 0]
    peak = max(points, key=lambda p: p["total_usd"], default=None)
    out = {"bucket": bucket, "group_by": group_by, "groups": sorted(groups), "points": points, "total_usd": round(running, 6), "unknown_lines": sum(p["unknown_lines"] for p in points),
           "active_buckets": len(active), "average_per_active_bucket_usd": round(running / len(active), 6) if active else None,
           "peak": {"start": peak["start"], "total_usd": peak["total_usd"]} if peak and peak["total_usd"] > 0 else None}
    if rate_for is not None:
        out["converted_total"] = round(running_conv, 4)
        out["unconverted_usd"] = round(unconverted, 6)
    return out


# ── robust statistics ──────────────────────────────────────────────────────────────────────────────────────────────────

def median(xs: Sequence[float]) -> Optional[float]:
    return statistics.median(xs) if xs else None


def mad(xs: Sequence[float]) -> Optional[float]:
    """Median absolute deviation, scaled to be comparable with a standard deviation for roughly bell-shaped data."""
    m = median(xs)
    return None if m is None else 1.4826 * statistics.median([abs(x - m) for x in xs])


def unusual(value: float, baseline: Sequence[float], *, ratio: float, k: float, min_baseline: int) -> Optional[Dict[str, float]]:
    """Whether `value` is unusually high against `baseline`: more than `ratio` times its median AND more than `k` scaled deviations above it (when they are not zero).
    Returns the numbers behind the verdict, or None."""
    if len(baseline) < min_baseline:
        return None
    m, spread = median(baseline), mad(baseline) or 0.0
    if m is None or m <= 0 or value <= m * ratio:
        return None
    if spread > 0 and value <= m + k * spread:
        return None
    return {"median": m, "mad": spread, "ratio": value / m, "baseline_n": len(baseline)}


def _severity(ratio: float) -> str:
    return "high" if ratio >= 5 else "medium" if ratio >= 3 else "low"


# ── anomalies ──────────────────────────────────────────────────────────────────────────────────────────────────────────

def run_anomalies(runs: Sequence[Dict[str, Any]], *, min_baseline: int = 3, ratio: float = 2.0, k: float = 3.0, min_excess_usd: float = 0.05) -> List[Dict[str, Any]]:
    """Runs that cost much more per execution than earlier runs of the same group (the caller groups by model, mode, dataset and version).
    A run is judged only against the runs before it. `runs`: run_id, started_at, group, ran, total_usd, unknown_executions, label."""
    out: List[Dict[str, Any]] = []
    by_group: Dict[Any, List[Dict[str, Any]]] = {}
    for r in sorted(runs, key=lambda r: (r["started_at"], r["run_id"])):
        by_group.setdefault(r["group"], []).append(r)
    for group, rs in by_group.items():
        for i, r in enumerate(rs):
            if not r["ran"] or r.get("unknown_executions"):
                continue
            value = r["total_usd"] / r["ran"]
            earlier = [x["total_usd"] / x["ran"] for x in rs[:i] if x["ran"] and not x.get("unknown_executions")]
            hit = unusual(value, earlier, ratio=ratio, k=k, min_baseline=min_baseline)
            excess = (value - hit["median"]) * r["ran"] if hit else 0.0
            if hit and excess >= min_excess_usd:
                out.append({"kind": "run_cost", "severity": _severity(hit["ratio"]), "subject": {"run_id": r["run_id"], "label": r.get("label")}, "observed": round(value, 6),
                            "baseline": round(hit["median"], 6), "ratio": round(hit["ratio"], 2), "excess_usd": round(excess, 6), "at": r["started_at"],
                            "message": f"Run {r['run_id']} cost ${value:.4f} per execution; the median of the {hit['baseline_n']} earlier runs of {r.get('label') or 'the same configuration'} is ${hit['median']:.4f} "
                                       f"({hit['ratio']:.1f} times): about ${excess:.2f} more than usual for its {r['ran']} executions.",
                            "evidence": {"baseline_runs": hit["baseline_n"], "executions": r["ran"], "total_usd": round(r["total_usd"], 6)}})
    return out


def waste_anomalies(runs: Sequence[Dict[str, Any]], *, share: float = 0.10, min_usd: float = 0.01) -> List[Dict[str, Any]]:
    """Runs where calls that earned no verdict (retries, fallbacks, unattributed) are a large part of the cost. `runs`: run_id, total_usd, by_component, started_at."""
    out = []
    for r in runs:
        bc = r.get("by_component") or {}
        waste = sum((bc.get(c) or {}).get("usd", 0.0) for c in ("retry", "fallback", "unattributed"))
        if r["total_usd"] > 0 and waste >= min_usd and waste / r["total_usd"] >= share:
            parts = ", ".join(f"{c} ${(bc.get(c) or {}).get('usd', 0.0):.4f}" for c in ("retry", "fallback", "unattributed") if (bc.get(c) or {}).get("usd", 0.0) > 0)
            out.append({"kind": "waste", "severity": "high" if waste / r["total_usd"] >= 0.3 else "medium", "subject": {"run_id": r["run_id"]}, "observed": round(waste, 6),
                        "baseline": None, "ratio": round(waste / r["total_usd"], 3), "excess_usd": round(waste, 6), "at": r["started_at"],
                        "message": f"{waste / r['total_usd'] * 100:.0f}% of run {r['run_id']}'s ${r['total_usd']:.4f} (${waste:.4f}) paid for calls that produced no verdict: {parts}.",
                        "evidence": {"by_component": {c: (bc.get(c) or {}).get("usd", 0.0) for c in ("retry", "fallback", "unattributed")}}})
    return out


def unpriced_anomalies(runs: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = []
    for r in runs:
        if r.get("unknown_executions"):
            out.append({"kind": "unpriced", "severity": "medium", "subject": {"run_id": r["run_id"]}, "observed": r["unknown_executions"], "baseline": 0, "ratio": None, "excess_usd": None,
                        "at": r["started_at"], "message": f"{r['unknown_executions']} execution(s) of run {r['run_id']} used a model that could not be priced, so their cost is in no total: "
                                                          "add the model's price to the registry.", "evidence": {"unknown_executions": r["unknown_executions"]}})
    return out


def daily_spike_anomalies(points: Sequence[Dict[str, Any]], *, window_days: int = 30, min_active: int = 4, ratio: float = 3.0, k: float = 3.0, min_excess_usd: float = 0.25) -> List[Dict[str, Any]]:
    """A day's spend far above the usual ACTIVE day of the month before it (days with no evaluation do not pull the usual down to zero). `points`: a day series."""
    out = []
    series = [(date.fromisoformat(p["start"]), p["total_usd"]) for p in points]
    for i, (day, usd) in enumerate(series):
        if usd <= 0:
            continue
        earlier = [u for d, u in series[:i] if u > 0 and (day - d).days <= window_days]
        hit = unusual(usd, earlier, ratio=ratio, k=k, min_baseline=min_active)
        if hit and usd - hit["median"] >= min_excess_usd:
            out.append({"kind": "daily_spike", "severity": _severity(hit["ratio"]), "subject": {"day": day.isoformat()}, "observed": round(usd, 6), "baseline": round(hit["median"], 6),
                        "ratio": round(hit["ratio"], 2), "excess_usd": round(usd - hit["median"], 6), "at": datetime.combine(day, datetime.min.time()),
                        "message": f"{day.isoformat()} cost ${usd:.2f}; the usual active day in the previous {window_days} days is ${hit['median']:.2f} ({hit['ratio']:.1f} times).",
                        "evidence": {"active_days_compared": hit["baseline_n"]}})
    return out


def token_outliers(rows: Sequence[Dict[str, Any]], *, min_baseline: int = 4, ratio: float = 4.0, k: float = 3.0, min_extra_tokens: int = 20_000) -> List[Dict[str, Any]]:
    """An execution that used far more tokens than the same case did before on the same model (a conversation that looped, a prompt that grew).
    `rows`: run_id, case_id, model, tokens (input + output), at."""
    out = []
    by: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for r in sorted(rows, key=lambda r: (r["at"], r["run_id"])):
        if r.get("tokens") is not None:
            by.setdefault((r["model"], r["case_id"]), []).append(r)
    for (model, case), rs in by.items():
        for i, r in enumerate(rs):
            hit = unusual(float(r["tokens"]), [float(x["tokens"]) for x in rs[:i]], ratio=ratio, k=k, min_baseline=min_baseline)
            if hit and r["tokens"] - hit["median"] >= min_extra_tokens:
                out.append({"kind": "token_outlier", "severity": _severity(hit["ratio"]), "subject": {"run_id": r["run_id"], "case_id": case, "model": model}, "observed": int(r["tokens"]),
                            "baseline": int(hit["median"]), "ratio": round(hit["ratio"], 2), "excess_usd": None, "at": r["at"],
                            "message": f"{case} on {model} used {int(r['tokens']):,} tokens in run {r['run_id']}; its median over {hit['baseline_n']} earlier executions is {int(hit['median']):,} ({hit['ratio']:.1f} times).",
                            "evidence": {"earlier_executions": hit["baseline_n"]}})
    return out


def order_anomalies(items: Iterable[Dict[str, Any]], limit: int = 100) -> List[Dict[str, Any]]:
    return sorted(items, key=lambda a: (SEVERITY_ORDER.get(a["severity"], 9), -(a.get("excess_usd") or 0.0), str(a.get("at"))))[:limit]


# ── comparing models ───────────────────────────────────────────────────────────────────────────────────────────────────

def _dominates(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    """a is at least as good as b on quality AND cost, and strictly better on one."""
    if None in (a.get("pass_rate"), b.get("pass_rate"), a.get("per_passed_usd"), b.get("per_passed_usd")):
        return False
    ge_q, le_c = a["pass_rate"] >= b["pass_rate"] - 1e-12, a["per_passed_usd"] <= b["per_passed_usd"] + 1e-12
    strict = a["pass_rate"] > b["pass_rate"] + 1e-12 or a["per_passed_usd"] < b["per_passed_usd"] - 1e-12
    return ge_q and le_c and strict


def compare_models(groups: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Annotate each configuration with whether it is on the quality/cost frontier and what beats it. `groups` come from one dataset version and one mode, so they
    answered the same questions; the caller says so in `warnings` when they did not (different judges, repetition counts)."""
    out = [dict(g) for g in groups]
    for g in out:
        g["dominated_by"] = [o["label"] for o in out if o is not g and _dominates(o, g)]
        g["on_frontier"] = None if (g.get("pass_rate") is None or g.get("per_passed_usd") is None) else not g["dominated_by"]
        g["enough_evidence"] = (g.get("ran") or 0) >= MIN_EVIDENCE_EXECUTIONS
    ranked = sorted([g for g in out if g.get("per_passed_usd") is not None], key=lambda g: g["per_passed_usd"])
    for i, g in enumerate(ranked, start=1):
        g["cost_rank"] = i
    return {"models": sorted(out, key=lambda g: (g.get("per_passed_usd") is None, g.get("per_passed_usd") or 0.0, g["label"])), "frontier": [g["label"] for g in out if g["on_frontier"]]}


# ── recommendations ────────────────────────────────────────────────────────────────────────────────────────────────────

def _pct(x: Optional[float]) -> str:
    return "n/a" if x is None else f"{x * 100:.0f}%"


def _interval(g: Dict[str, Any]) -> str:
    return f"{_pct(g.get('pass_rate'))} (95% interval {_pct(g.get('ci_low'))} to {_pct(g.get('ci_high'))}, {g.get('ran')} executions)"


def _confidence(*gs: Dict[str, Any]) -> str:
    n = min(g.get("ran") or 0 for g in gs)
    return "high" if n >= 100 else "medium" if n >= MIN_EVIDENCE_EXECUTIONS else "low"


def recommend_models(groups: Sequence[Dict[str, Any]], *, dataset: str, mode: str, max_quality_drop: float = 0.10, cost_ratio: float = 0.7) -> List[Dict[str, Any]]:
    """Model choices the numbers support, per dataset version and mode, at most one per configuration:
      dominated_model     it passed clearly less (its whole interval is below another's) and costs at least as much per passed test: drop it from future benchmarks
      cheaper_equivalent  another configuration costs at most 70% as much per passed test and is not meaningfully worse (its interval reaches this one's pass rate, it is within 10 points,
                          and it had no more critical failures): the runs cannot tell them apart, and one costs far less
    Only configurations with at least 30 executions and a known cost per passed test are considered, and never a scripted model."""
    out: List[Dict[str, Any]] = []
    cands = [g for g in groups if g.get("pass_rate") is not None and g.get("per_passed_usd") is not None and (g.get("ran") or 0) >= MIN_EVIDENCE_EXECUTIONS and not g.get("synthetic")]
    for a in cands:
        worse_than = [b for b in cands if b is not a and a["ci_high"] < b["ci_low"] and a["per_passed_usd"] >= b["per_passed_usd"]]
        if worse_than:
            b = min(worse_than, key=lambda g: g["per_passed_usd"])
            out.append({"id": f"dominated:{dataset}:{mode}:{a['label']}", "kind": "dominated_model", "severity": "info", "confidence": _confidence(a, b),
                        "title": f"{a['label']} is worse and no cheaper than {b['label']}",
                        "detail": f"On {dataset} ({mode}), {a['label']} passed {_interval(a)} at ${a['per_passed_usd']:.4f} per passed test; {b['label']} passed {_interval(b)} at ${b['per_passed_usd']:.4f}. "
                                  "The intervals do not overlap.", "estimated_saving_usd": round(a.get("total_usd", 0.0), 4),
                        "saving_basis": f"what {a['label']} cost in these runs: the amount a future benchmark would not spend on it",
                        "evidence": {"runs": {a["label"]: a.get("run_ids"), b["label"]: b.get("run_ids")}}, "caveats": ["only on this dataset version: another task may favour it"]})
            continue
        options = [b for b in cands if b is not a and b["per_passed_usd"] <= a["per_passed_usd"] * cost_ratio and b["ci_high"] >= a["pass_rate"]
                   and b["pass_rate"] >= a["pass_rate"] - max_quality_drop and b.get("critical_failures", 0) <= a.get("critical_failures", 0)]
        if options:
            b = min(options, key=lambda g: g["per_passed_usd"])
            saving = (a["per_passed_usd"] - b["per_passed_usd"]) * (a.get("passes") or 0)
            out.append({"id": f"cheaper:{dataset}:{mode}:{a['label']}->{b['label']}", "kind": "cheaper_equivalent", "severity": "info", "confidence": _confidence(a, b),
                        "title": f"{b['label']} gave comparable results to {a['label']} for {_pct(1 - b['per_passed_usd'] / a['per_passed_usd'])} less per passed test",
                        "detail": f"On {dataset} ({mode}), {b['label']} passed {_interval(b)} at ${b['per_passed_usd']:.4f} per passed test; {a['label']} passed {_interval(a)} at ${a['per_passed_usd']:.4f}. "
                                  f"{a['label']}'s pass rate is within reach of {b['label']}'s interval, so these runs cannot tell them apart, and {b['label']} had no more critical failures.",
                        "estimated_saving_usd": round(saving, 4), "saving_basis": f"the difference per passed test x the {a.get('passes')} tests {a['label']} passed in these runs",
                        "evidence": {"runs": {a["label"]: a.get("run_ids"), b["label"]: b.get("run_ids")}},
                        "caveats": ["a benchmark is a sample of cases: a difference smaller than the intervals above is not evidence either way", "check the cases each model fails before switching"]})
    return out


def recommend_spending(*, by_component: Dict[str, Dict[str, Any]], total_usd: float, retry_reasons: Optional[Dict[str, int]] = None, unknown_lines: int = 0, unpriced_models: Sequence[str] = (),
                       judged_executions: int = 0, window: str = "the window") -> List[Dict[str, Any]]:
    """What the split of the money says: waste, an expensive judge, unpriced models."""
    out: List[Dict[str, Any]] = []
    if total_usd <= 0:
        return out
    usd = lambda c: (by_component.get(c) or {}).get("usd", 0.0)
    waste = usd("retry") + usd("fallback") + usd("unattributed")
    if waste / total_usd >= 0.05 and waste >= 0.01:
        reasons = ", ".join(f"{k} x{v}" for k, v in sorted((retry_reasons or {}).items(), key=lambda kv: -kv[1])[:3])
        out.append({"id": "waste", "kind": "waste", "severity": "medium" if waste / total_usd >= 0.15 else "low", "confidence": "high",
                    "title": f"{waste / total_usd * 100:.0f}% of the spending in {window} bought no verdict",
                    "detail": f"Retries ${usd('retry'):.4f}, fallbacks ${usd('fallback'):.4f}, unattributed calls ${usd('unattributed'):.4f} of ${total_usd:.4f}." + (f" Failures that were retried: {reasons}." if reasons else ""),
                    "estimated_saving_usd": round(waste, 4), "saving_basis": "what those calls cost; the saving is only real if the cause (timeouts, a failing provider, calls without a thread) is fixed",
                    "evidence": {"retry": usd("retry"), "fallback": usd("fallback"), "unattributed": usd("unattributed")}, "caveats": ["some retries are unavoidable provider hiccups"]})
    if usd("judge") / total_usd >= 0.4 and judged_executions >= 20:
        out.append({"id": "judge_share", "kind": "judge_share", "severity": "low", "confidence": "medium",
                    "title": f"The judge is {usd('judge') / total_usd * 100:.0f}% of the spending in {window}",
                    "detail": f"Judging cost ${usd('judge'):.4f} of ${total_usd:.4f} across {judged_executions} judged executions. A cheaper judge would cut this, but a judge is only trustworthy after it passes calibration on answers of known quality "
                              "(the benchmark's calibration step): no cheaper judge has been shown to do so here.",
                    "estimated_saving_usd": None, "saving_basis": None, "evidence": {"judge_usd": usd("judge"), "judged_executions": judged_executions},
                    "caveats": ["do not change the judge without calibrating the new one: scores from different judges are not comparable"]})
    if unknown_lines:
        out.append({"id": "unpriced", "kind": "unpriced", "severity": "medium", "confidence": "high", "title": f"{unknown_lines} cost line(s) could not be priced",
                    "detail": "Their cost is in no total, so every figure above is a lower bound." + (f" Models without a price: {', '.join(sorted(set(unpriced_models)))}." if unpriced_models else ""),
                    "estimated_saving_usd": None, "saving_basis": None, "evidence": {"unknown_lines": unknown_lines, "models": sorted(set(unpriced_models))}, "caveats": []})
    return out


def month_projection(month_to_date_usd: float, today: date, *, limit_usd: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """If spending continues at this month's average daily rate. Honest about being a straight line through sporadic spending."""
    elapsed = today.day
    days = calendar.monthrange(today.year, today.month)[1]
    if month_to_date_usd <= 0:
        return None
    projected = month_to_date_usd / elapsed * days
    out = {"month_to_date_usd": round(month_to_date_usd, 4), "days_elapsed": elapsed, "days_in_month": days, "projected_usd": round(projected, 4), "limit_usd": limit_usd, "over_limit": None}
    if limit_usd is not None:
        out["over_limit"] = projected > limit_usd
    return out


def recommend_budget(projection: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not projection or projection["limit_usd"] is None or not projection["over_limit"]:
        return []
    return [{"id": "budget_pace", "kind": "budget_pace", "severity": "medium", "confidence": "low",
             "title": f"At this month's pace you would spend ${projection['projected_usd']:.2f}, above the ${projection['limit_usd']:.2f} monthly limit",
             "detail": f"${projection['month_to_date_usd']:.2f} was spent in {projection['days_elapsed']} of {projection['days_in_month']} days. This is a straight-line projection through sporadic spending: "
                       "one large benchmark can change it either way.", "estimated_saving_usd": None, "saving_basis": None, "evidence": projection,
             "caveats": ["with enforcement on, a job that would pass the limit is refused when it is scheduled"]}]
