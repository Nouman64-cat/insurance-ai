"""Turning the runs of one benchmark (one run per model, same cases) into a comparison a person can trust, and no more than that.

Per model: pass rate with its interval, consistency, critical-failure rate, the judge's quality scores, tool accuracy and workflow
compliance (agent benchmark), safety violations, latency mean/p50/p95, time to the first token where reported, throughput, errors and
timeouts, tokens in/out/cached, cost, and cost per successful execution. The judge's cost is kept apart from the candidate's.

Between models: a paired comparison over the cases they share. "A is better than B" is only written when the evidence supports it:
enough cases, enough repetitions, a difference whose 95% interval excludes zero, and no worse critical-failure rate. Otherwise the report
says "no reliable difference" or "not enough evidence" and why. A benchmark of scripted models never ranks anything: it proves the
harness, not the models.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from shared.evaluation import stats

RAN = ("passed", "failed")
MIN_CASES = 10                 # paired cases both models ran, below which no model is called better
MIN_REPETITIONS = 3            # repetitions per case, below which a pass rate is one sample of a noisy process
SIGN_TEST_ALPHA = 0.05
FALLBACK = "none: a failed call is recorded as an error or a timeout against the model that was asked, and no other model is ever substituted"
QUALITY_METRICS = ("correctness", "task_completion", "faithfulness", "relevance", "hallucination", "safety", "custom")


def _mean(values: Sequence[Optional[float]]) -> Optional[float]:
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else None


def _layer_mean(rows: Sequence[Dict[str, Any]], layer: str) -> Dict[str, Any]:
    scores = [(r.get("layer_scores") or {}).get(layer) for r in rows]
    scores = [s["score"] for s in scores if s and s.get("applicable") and s.get("score") is not None]
    return {"n": len(scores), "mean": _mean(scores)}


def aggregate_model(label: str, rows: Sequence[Dict[str, Any]], summary: Dict[str, Any]) -> Dict[str, Any]:
    """Everything a benchmark reports about one model, from that model's results.jsonl rows and summary.json. Unknown stays unknown."""
    ran = [r for r in rows if r["status"] in RAN]
    infra = [r for r in rows if r["status"] == "infrastructure_error"]
    blocked = [r for r in rows if r["status"] == "blocked"]
    cfg = summary.get("config") or {}
    out: Dict[str, Any] = {"label": label, "synthetic": bool(summary.get("synthetic_model")), "executions": len(rows), "ran": len(ran), "blocked": len(blocked),
                           "skipped": sum(1 for r in rows if r["status"] == "skipped"), "infrastructure_errors": len(infra),
                           "config": {k: cfg.get(k) for k in ("mode", "provider", "model_id", "skills_enabled", "prompt_version", "prompt_sha256", "model_settings",
                                                              "direct_prompt_version", "judge_model", "repeat", "retries", "limits")}}
    if blocked and len(blocked) == len(rows):
        reason = blocked[0].get("reason")
        return {**out, "status": reason or "blocked", "note": "not run: " + (blocked[0].get("error") or reason or "blocked")[:200]}
    if not ran:
        return {**out, "status": "no_results", "note": "no execution produced a verdict (all were errors, skipped or blocked)"}
    rel = stats.run_reliability(list(rows))
    passes = sum(1 for r in ran if r["status"] == "passed")
    timeouts = [r for r in infra if r.get("reason") == "timeout"]
    errors = [r for r in infra if r.get("reason") != "timeout"]
    attempted = len(ran) + len(infra)

    quality: Dict[str, Any] = {}
    for metric in QUALITY_METRICS:
        scored = [m for r in ran for m in (r.get("metric_scores") or []) if m.get("metric") == metric and m.get("status") == "scored" and m.get("score") is not None]
        if scored:
            quality[metric] = {"n": len(scored), "mean": _mean([m["score"] for m in scored]), "met": sum(1 for m in scored if m.get("passed")) / len(scored)}
    safety_hits = [r for r in ran if r.get("critical_failed") or ((r.get("layer_scores") or {}).get("L5") or {}).get("status") == "failed"
                   or any(m.get("metric") == "safety" and m.get("status") == "scored" and m.get("passed") is False for m in (r.get("metric_scores") or []))]
    gen = [r for r in ran if r.get("output_tokens") is not None and r.get("latency_ms")]
    known_tokens = [r for r in ran if r.get("input_tokens") is not None]
    known_cost = [r for r in ran if r.get("cost_known", True) and r.get("cost_usd") is not None]
    unknown_cost = len(ran) - len(known_cost)
    llm_cost = sum(r["cost_usd"] for r in known_cost)
    judge_costs = [r.get("judge_cost_usd") for r in ran if r.get("judge_cost_usd") is not None]
    out.update({
        "status": "measured", "passes": passes, "fails": len(ran) - passes, "pass_rate": rel["pass_rate"], "ci_low": rel["ci_low"], "ci_high": rel["ci_high"],
        "consistency": rel["decision_consistency"], "tool_consistency": rel["tool_consistency"], "flaky_cases": rel["flaky_cases"],
        "consistently_wrong_cases": rel["consistently_wrong_cases"], "cases": rel["cases"],
        "critical_failures": sum(1 for r in ran if r.get("critical_failed")), "critical_failure_rate": rel["critical_failure_rate"],
        "quality": quality, "tool_accuracy": _layer_mean(ran, "L3"), "workflow_compliance": _layer_mean(ran, "L4"),
        "safety_violations": {"executions": len(safety_hits), "rate": len(safety_hits) / len(ran), "cases": sorted({r["case_id"] for r in safety_hits})},
        "latency_ms": stats.describe([r["latency_ms"] for r in ran if r.get("latency_ms") is not None]),
        "ttft_ms": stats.describe([r["ttft_ms"] for r in ran if r.get("ttft_ms") is not None]),
        "throughput_tokens_per_s": (sum(r["output_tokens"] for r in gen) / (sum(r["latency_ms"] for r in gen) / 1000.0)) if gen else None,
        "errors": len(errors), "timeouts": len(timeouts), "error_rate": (len(errors) + len(timeouts)) / attempted if attempted else None,
        "error_kinds": dict(sorted({k: sum(1 for r in errors if r.get("reason") == k) for k in {r.get("reason") for r in errors}}.items())),
        "tokens": {"input": sum(r["input_tokens"] for r in known_tokens), "output": sum(r.get("output_tokens") or 0 for r in known_tokens),
                   "cached": sum(r.get("cached_tokens") or 0 for r in known_tokens), "executions_without_counts": len(ran) - len(known_tokens)},
        "cost": {"candidate_usd": llm_cost, "judge_usd": sum(judge_costs) if judge_costs else 0.0, "total_usd": llm_cost + (sum(judge_costs) if judge_costs else 0.0),
                 "executions_with_unknown_cost": unknown_cost,
                 "per_passed_usd": (llm_cost / passes) if passes and not unknown_cost else None},
    })
    out["cost_per_passed_usd"] = out["cost"]["per_passed_usd"]
    return out


def fairness(runs: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Were the models asked the same thing the same way? Each check says what it compared."""
    def same(name: str, get, *, detail: str = "") -> Dict[str, Any]:
        values = [get(r) for r in runs]
        ok = all(v == values[0] for v in values)
        return {"check": name, "ok": ok, "detail": detail if ok else "differs: " + "; ".join(f"{r['label']}={v!r}" for r, v in zip(runs, values))}
    cfg = lambda r: r["summary"].get("config") or {}                                  # noqa: E731
    ds = lambda r: ((r["summary"].get("dataset") or {}).get("dataset"), (r["summary"].get("dataset") or {}).get("version"),         # noqa: E731
                    (r["summary"].get("dataset") or {}).get("snapshot_sha256"))
    out = [same("dataset version and checksum", ds), same("the same cases", lambda r: sorted({x["case_id"] for x in r["rows"]})),
           same("repetitions", lambda r: r["summary"].get("repeat")), same("judge model", lambda r: cfg(r).get("judge_model")),
           same("mode", lambda r: cfg(r).get("mode")), same("direct prompt version", lambda r: cfg(r).get("direct_prompt_version")),
           same("skills setting", lambda r: cfg(r).get("skills_enabled")), same("prompt version", lambda r: (cfg(r).get("prompt_version"), cfg(r).get("prompt_sha256"))),
           same("model settings", lambda r: cfg(r).get("model_settings")), same("limits", lambda r: cfg(r).get("limits"))]
    out.append({"check": "the dataset was verified against its published checksums", "ok": all(bool((r["summary"].get("dataset") or {}).get("verified")) for r in runs),
                "detail": "" if all((r["summary"].get("dataset") or {}).get("verified") for r in runs) else "run from the repository sources, not a published version"})
    return out


def compare_pair(a: Dict[str, Any], b: Dict[str, Any], rows_a: Sequence[Dict[str, Any]], rows_b: Sequence[Dict[str, Any]], *, synthetic: bool) -> Dict[str, Any]:
    """Is B better than A? The answer is one of: b_better, a_better, no_reliable_difference, insufficient_evidence, not_compared, synthetic."""
    base = {"a": a["label"], "b": b["label"]}
    if a["status"] != "measured" or b["status"] != "measured":
        return {**base, "verdict": "not_compared", "reason": "a model that did not produce results cannot be compared", "paired": None}
    paired = stats.paired_compare(list(rows_a), list(rows_b))
    paired = {k: v for k, v in paired.items() if k != "rows"}
    if synthetic:
        return {**base, "verdict": "synthetic", "paired": paired, "reason": "scripted models: this checks the benchmark, it says nothing about which real model is better"}
    reps = min(_reps(rows_a), _reps(rows_b))
    reasons: List[str] = []
    if paired["cases_compared"] < MIN_CASES:
        reasons.append(f"only {paired['cases_compared']} case(s) were compared (at least {MIN_CASES} are needed)")
    if reps < MIN_REPETITIONS:
        reasons.append(f"{reps} repetition(s) per case (at least {MIN_REPETITIONS} are needed)")
    if reasons:
        return {**base, "verdict": "insufficient_evidence", "paired": paired, "reason": "; ".join(reasons)}
    lo, hi, p = paired.get("diff_ci_low"), paired.get("diff_ci_high"), paired.get("sign_test_p")
    if lo is not None and lo > 0 and (p is None or p < SIGN_TEST_ALPHA):
        winner, loser = b, a
        verdict = "b_better"
    elif hi is not None and hi < 0 and (p is None or p < SIGN_TEST_ALPHA):
        winner, loser = a, b
        verdict = "a_better"
    else:
        return {**base, "verdict": "no_reliable_difference", "paired": paired, "reason": "the difference in pass rate is within what chance could produce"}
    if (winner.get("critical_failure_rate") or 0) > (loser.get("critical_failure_rate") or 0):
        return {**base, "verdict": "no_reliable_difference", "paired": paired,
                "reason": f"{winner['label']} passes more often but has the higher critical-failure rate, so it is not called better"}
    return {**base, "verdict": verdict, "paired": paired, "reason": f"{winner['label']} passes more cases ({paired['mean_diff'] * 100:+.1f} points for B over A, 95% interval {lo * 100:+.1f} to {hi * 100:+.1f})"}


def _reps(rows: Sequence[Dict[str, Any]]) -> int:
    return max((r.get("repetition", 1) for r in rows), default=1)


def validity(mode: str, benchmark_id: str, runs: Sequence[Dict[str, Any]]) -> List[str]:
    """Did every run actually do what the benchmark asked? A run that recorded another mode, kind or group (an older runner, a changed
    command line) is not evidence for this benchmark. Only runs that produced a summary can be checked; a missing one is reported by the
    model's own status."""
    problems: List[str] = []
    for r in runs:
        cfg = (r["summary"] or {}).get("config")
        if cfg is None:
            continue
        if cfg.get("mode") != mode:
            problems.append(f"{r['label']} ran in mode {cfg.get('mode')!r}, not {mode!r}")
        if cfg.get("kind") != f"benchmark_{mode}":
            problems.append(f"{r['label']} was recorded as kind {cfg.get('kind')!r}")
        if cfg.get("group_id") != benchmark_id:
            problems.append(f"{r['label']} belongs to group {cfg.get('group_id')!r}")
        if cfg.get("model_id") != r["label"] and f"{cfg.get('provider')}/{cfg.get('model_id')}" != r["label"] and cfg.get("model_id") != r["label"].split("/", 1)[-1]:
            problems.append(f"{r['label']}: the run recorded model {cfg.get('model_id')!r}")
    return problems


def build_benchmark(*, benchmark_id: str, mode: str, runs: Sequence[Dict[str, Any]], judge_model: Optional[str], judge_info: Optional[Dict[str, Any]] = None,
                    calibration: Optional[Dict[str, Any]] = None, created: str = "") -> Dict[str, Any]:
    """`runs`: one dict per model: label, rows (results.jsonl), summary (summary.json), folder, exit_code."""
    models = {r["label"]: aggregate_model(r["label"], r["rows"], r["summary"]) for r in runs}
    synthetic = any(m.get("synthetic") for m in models.values())
    measured = [r for r in runs if models[r["label"]]["status"] == "measured"]
    order = sorted((r["label"] for r in measured), key=lambda l: (-(models[l]["pass_rate"] or 0), models[l]["critical_failure_rate"] or 0, l))
    by_label = {r["label"]: r for r in runs}
    comparisons = [compare_pair(models[x], models[y], by_label[x]["rows"], by_label[y]["rows"], synthetic=synthetic) for i, x in enumerate(order) for y in order[i + 1:]]
    # x is ahead of y in the observed order; the pair is stored as (a=x, b=y), so "a_better" means the observed leader is really better.
    leader = None
    if order and not synthetic and len(order) > 1 and all(c["verdict"] == "a_better" for c in comparisons if c["a"] == order[0]):
        leader = order[0]
    notes: List[str] = []
    if synthetic:
        notes.append("SYNTHETIC: at least one model is a scripted stand-in. This benchmark checks the machinery; it does not rank models.")
    blocked = [l for l, m in models.items() if m["status"] != "measured"]
    if blocked:
        notes.append("not measured: " + ", ".join(f"{l} ({models[l]['status']})" for l in blocked))
    checks = fairness([{"label": r["label"], "rows": r["rows"], "summary": r["summary"]} for r in runs])
    if not all(c["ok"] for c in checks if c["check"] != "the dataset was verified against its published checksums"):
        notes.append("the models were NOT all asked the same thing in the same way (see the fairness checks): treat the comparison with care")
    if not leader and not synthetic and len(order) > 1:
        notes.append("no model is shown to be better than all the others on this evidence")
    problems = validity(mode, benchmark_id, runs)
    if problems:
        notes.insert(0, "INVALID BENCHMARK: " + "; ".join(problems) + ". Its runs are kept as they are, but nothing here may be read as a comparison.")
    first = runs[0]["summary"] if runs else {}
    return {"valid": not problems, "problems": problems, **{"benchmark_id": benchmark_id, "mode": mode, "created": created, "synthetic": synthetic, "complete": not blocked and all(r.get("exit_code") in (0, 1) for r in runs),
            "dataset": first.get("dataset"), "repetitions": first.get("repeat"), "judge": {"model": judge_model, **(judge_info or {}), "calibration": calibration},
            "fallback": FALLBACK, "evidence_rules": {"min_cases": MIN_CASES, "min_repetitions": MIN_REPETITIONS, "interval": "95% bootstrap on the mean paired difference", "sign_test_alpha": SIGN_TEST_ALPHA},
            "models": models, "order": order, "comparisons": comparisons, "leader": leader, "fairness": checks, "notes": notes,
            "runs": {r["label"]: {"folder": r["folder"], "run_id": r["summary"].get("run_id"), "exit_code": r.get("exit_code")} for r in runs}}}


def _pct(x: Optional[float]) -> str:
    return "-" if x is None else f"{x * 100:.1f}%"


def _ms(d: Dict[str, Any]) -> str:
    return "-" if not d or d.get("mean") is None else f"{d['mean']:.0f}/{d['p50']:.0f}/{d['p95']:.0f}"


def _usd(x: Optional[float]) -> str:
    return "unknown" if x is None else f"${x:.4f}"


def render(b: Dict[str, Any]) -> str:
    out = ["=" * 100, ("*** INVALID *** " if not b.get("valid", True) else "") + f"Benchmark {b['benchmark_id']}   mode: {b['mode']}   repetitions: {b['repetitions']}   judge: {b['judge'].get('model') or 'none'}", "-" * 100]
    ds = b.get("dataset") or {}
    out.append(f"dataset {ds.get('dataset')} {ds.get('version')}" + ("" if ds.get("verified") else "   (NOT a verified published version)"))
    for n in b["notes"]:
        out.append(f"  ! {n}")
    out.append("")
    out.append(f"  {'model':34} {'pass rate (95%)':24} {'crit':>5} {'consist':>8} {'lat ms mean/p50/p95':>22} {'ttft p50':>9} {'err/to':>7} {'cost/pass':>10}")
    for label in [*b["order"], *[l for l in b["models"] if l not in b["order"]]]:
        m = b["models"][label]
        if m["status"] != "measured":
            out.append(f"  {label:34} NOT MEASURED: {m.get('note') or m['status']}")
            continue
        ttft = m["ttft_ms"]["p50"]
        out.append(f"  {label:34} {_pct(m['pass_rate']):>7} ({m['ci_low'] * 100:3.0f}-{m['ci_high'] * 100:3.0f}%) {'':6} {m['critical_failures']:>5} {_pct(m['consistency']):>8} "
                   f"{_ms(m['latency_ms']):>22} {('-' if ttft is None else f'{ttft:.0f}'):>9} {m['errors']:>3}/{m['timeouts']:<3} {('no passes' if not m['passes'] else _usd(m['cost_per_passed_usd'])):>10}")
    out.append("")
    for label in b["order"]:
        m = b["models"][label]
        q = ", ".join(f"{k} {v['mean']:.2f}" for k, v in m["quality"].items()) or "no judged scores"
        out.append(f"  {label}: quality [{q}]")
        out.append(f"      tool accuracy {_pct(m['tool_accuracy']['mean'])} (n={m['tool_accuracy']['n']})   workflow compliance {_pct(m['workflow_compliance']['mean'])} (n={m['workflow_compliance']['n']})"
                   f"   safety violations {m['safety_violations']['executions']} ({_pct(m['safety_violations']['rate'])})")
        t = m["tokens"]
        out.append(f"      tokens in {t['input']} / out {t['output']} / cached {t['cached']}" + (f" ({t['executions_without_counts']} execution(s) without counts)" if t["executions_without_counts"] else "")
                   + f"   throughput {'-' if m['throughput_tokens_per_s'] is None else format(m['throughput_tokens_per_s'], '.1f')} tok/s"
                   f"   cost: candidate {_usd(m['cost']['candidate_usd'])}, judge {_usd(m['cost']['judge_usd'])} (kept apart)"
                   + (f", {m['cost']['executions_with_unknown_cost']} execution(s) of unknown cost" if m['cost']['executions_with_unknown_cost'] else ""))
        if m["flaky_cases"]:
            out.append(f"      flaky: {', '.join(m['flaky_cases'])}")
    out.append("")
    out.append("  comparisons (paired by case; B is the model lower in the observed order)")
    for c in b["comparisons"]:
        p = c["paired"] or {}
        out.append(f"    {c['a']} vs {c['b']}: {c['verdict'].upper().replace('_', ' ')}" + (f" ({p.get('cases_compared')} cases)" if p else "") + f" - {c['reason']}")
    out.append(f"  verdict: " + (f"{b['leader']} is shown to be better than every other model." if b["leader"] else "no model is shown to be better than the others."))
    out.append("")
    out.append("  fairness: " + ", ".join(f"{'ok' if c['ok'] else 'DIFFERS'} {c['check']}" for c in b["fairness"]))
    out.append(f"  fallback behaviour: {b['fallback']}")
    out.append("=" * 100)
    return "\n".join(out)
