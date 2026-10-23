"""Tests of the reliability statistics (shared/evaluation/stats.py) against hand-computed values.

    python evals/tools/test_stats.py      # also run by selftest.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from shared.evaluation.stats import (aggregate_case, can_afford, describe, detect_regressions, evaluate_gate, paired_compare, percentile,  # noqa: E402
                                     repetitions_for, run_reliability, should_stop_on_critical, wilson)


def near(a, b, tol=5e-4):
    return abs(a - b) <= tol


def ex(case, status, rep=1, **kw):
    return {"case_key": case, "status": status, "repetition": rep, "score": 1.0 if status == "passed" else 0.0, "latency_ms": 100 + rep, "cost_usd": 0.01,
            "cost_known": True, "critical_failed": kw.pop("critical_failed", False), "severity": kw.pop("severity", "high"), **kw}


def test_wilson_matches_hand_computed_intervals() -> None:
    lo, hi = wilson(8, 10)
    assert near(lo, 0.4902) and near(hi, 0.9433), (lo, hi)
    lo, hi = wilson(0, 5)
    assert lo == 0.0 and near(hi, 0.4345), (lo, hi)
    lo, hi = wilson(5, 5)
    assert near(lo, 0.5655) and hi == 1.0, (lo, hi)
    assert wilson(0, 0) is None
    lo, hi = wilson(50, 100)
    assert near(lo, 0.4038) and near(hi, 0.5962), (lo, hi)


def test_percentiles_and_description() -> None:
    assert percentile([1, 2, 3, 4], 50) == 2.5 and percentile([10], 95) == 10 and percentile([], 50) is None
    d = describe([2, 4, 4, 4, 5, 5, 7, 9])
    assert d["mean"] == 5 and near(d["stdev"], 2.13809, 1e-4) and d["p50"] == 4.5 and d["n"] == 8
    assert describe([])["mean"] is None


def test_repetition_policy_and_override() -> None:
    assert repetitions_for("deterministic") == 1 and repetitions_for("model") == 3
    assert repetitions_for("model", kind="benchmark_agent") == 5 and repetitions_for("deterministic", kind="benchmark_agent") == 1
    assert repetitions_for("model", override=10) == 10 and repetitions_for("deterministic", override=30) == 30
    try:
        repetitions_for("model", override=0)
    except ValueError:
        return
    raise AssertionError("0 repetitions accepted")


def test_case_classes() -> None:
    assert aggregate_case([ex("A", "passed", i) for i in range(1, 6)])["class"] == "stable_pass"
    wrong = aggregate_case([ex("A", "failed", i) for i in range(1, 6)])
    assert wrong["class"] == "stable_fail" and wrong["pass_rate"] == 0 and wrong["decision_consistency"] == 1.0, "a consistent wrong answer is consistent and still a failure"
    flaky = aggregate_case([ex("A", "passed", 1), ex("A", "passed", 2), ex("A", "failed", 3), ex("A", "passed", 4), ex("A", "failed", 5)])
    assert flaky["class"] == "flaky" and flaky["passes"] == 3 and near(flaky["decision_consistency"], 0.6)
    assert aggregate_case([ex("A", "passed")])["class"] == "insufficient"


def test_blocked_skipped_and_errors_are_not_evidence() -> None:
    c = aggregate_case([ex("A", "blocked"), ex("A", "skipped", 2), ex("A", "infrastructure_error", 3)])
    assert c["n"] == 0 and c["pass_rate"] is None and c["class"] == "insufficient" and c["other"] == {"blocked": 1, "skipped": 1, "infrastructure_error": 1}
    mixed = aggregate_case([ex("A", "passed"), ex("A", "passed", 2), ex("A", "infrastructure_error", 3)])
    assert mixed["n"] == 2 and mixed["class"] == "stable_pass", "an infrastructure error neither passes nor fails the case"


def test_tool_consistency_follows_the_executed_tool_sequence() -> None:
    rows = [ex("A", "passed", i, trace_summary={"executed_tools": ["record_lead"]}) for i in range(1, 4)] + [ex("A", "failed", 4, trace_summary={"executed_tools": []})]
    assert near(aggregate_case(rows)["tool_consistency"], 0.75)


def test_run_reliability() -> None:
    rows = ([ex("A", "passed", i) for i in range(1, 6)] + [ex("B", "failed", i) for i in range(1, 6)] + [ex("C", "passed", 1), ex("C", "failed", 2)] +
            [ex("D", "passed", 1, critical_failed=False)])
    r = run_reliability(rows)
    assert r["cases"] == 4 and r["ran"] == 13 and r["classes"] == {"stable_pass": 1, "stable_fail": 1, "flaky": 1, "insufficient": 1}
    assert near(r["pass_rate"], 7 / 13) and r["flaky_cases"] == ["C"] and r["consistently_wrong_cases"] == ["B"]
    assert near(r["all_runs_success_rate"], 1 / 3), "of the 3 repeated cases only A passed every time"


def test_the_critical_failure_rate() -> None:
    rows = [ex("A", "failed", 1, critical_failed=True), ex("A", "passed", 2), ex("B", "passed", 1), ex("B", "passed", 2)]
    assert near(run_reliability(rows)["critical_failure_rate"], 0.25)


def test_gate_passes_a_clean_run_and_fails_a_critical_flake() -> None:
    clean = [ex("A", "passed", i, severity="critical") for i in range(1, 6)] + [ex("B", "passed", i) for i in range(1, 6)]
    assert evaluate_gate(clean)["passed"]
    flake = [ex("A", "passed", i, severity="critical") for i in range(1, 5)] + [ex("A", "failed", 5, severity="critical", critical_failed=True)] + [ex("B", "passed", i) for i in range(1, 6)]
    g = evaluate_gate(flake)
    failed = {c["name"] for c in g["checks"] if not c["ok"]}
    assert not g["passed"] and {"critical_cases", "flaky_cases", "critical_failure_rate"} <= failed and "pass_rate" not in failed, "90% overall passes the rate, the critical flake still fails the gate"
    relaxed = evaluate_gate(flake, {"critical_pass_rate": 0.8, "max_flaky_cases": 1, "max_critical_failure_rate": 0.2})
    assert relaxed["passed"]


def test_gate_does_not_pass_when_nothing_ran_or_repetitions_are_too_few() -> None:
    assert not evaluate_gate([ex("A", "blocked")])["passed"]
    thin = [ex("A", "passed", 1), ex("A", "passed", 2)]
    assert evaluate_gate(thin, {"min_repetitions": 3})["checks"][-1]["ok"] is False
    assert evaluate_gate(thin, {"min_repetitions": 2})["passed"]


def test_paired_comparison() -> None:
    a = [ex(f"C{i}", "passed", r) for i in range(10) for r in (1, 2)]
    b = [ex(f"C{i}", "passed" if i >= 8 else "failed", r) for i in range(10) for r in (1, 2)]
    c = paired_compare(a, b)
    assert c["cases_compared"] == 10 and c["a_better"] == 8 and c["b_better"] == 0
    assert near(c["mean_diff"], -0.8) and c["diff_ci_high"] <= -0.5
    assert near(c["sign_test_p"], 2 * 1 / 256), c["sign_test_p"]                     # 8 vs 0: p = 2 * (1/2^8)
    assert c["diff_ci_low"] <= c["mean_diff"] <= c["diff_ci_high"]
    same = paired_compare(a, a)
    assert same["mean_diff"] == 0 and same["sign_test_p"] is None and "no case differs" in same["note"]
    assert paired_compare(a, b[:6])["only_in_a"], "cases only one run has are reported, not silently dropped"


def test_paired_comparison_is_reproducible_and_flags_thin_evidence() -> None:
    a = [ex("X", "passed"), ex("Y", "passed"), ex("Z", "passed")]
    b = [ex("X", "failed"), ex("Y", "passed"), ex("Z", "passed")]
    one, two = paired_compare(a, b), paired_compare(a, b)
    assert one == two and "too few" in one["note"]


def test_regression_detection() -> None:
    base = [ex("A", "passed", i) for i in range(1, 6)] + [ex("B", "passed", i) for i in range(1, 6)] + [ex("C", "passed", i, severity="critical") for i in range(1, 6)]
    cur = ([ex("A", "failed", i) for i in range(1, 6)] + [ex("B", "passed", i) for i in range(1, 5)] + [ex("B", "failed", 5)] +
           [ex("C", "passed", i, severity="critical") for i in range(1, 5)] + [ex("C", "failed", 5, severity="critical")])
    found = {f["case"]: f for f in detect_regressions(base, cur)}
    assert set(found) == {"A", "C"}, found
    assert near(found["A"]["p"], 1 / 252, 1e-6) and found["A"]["evidence"] == "statistical"
    assert found["C"]["critical"] and found["C"]["evidence"] == "critical case no longer perfect"
    single = detect_regressions([ex("A", "passed")], [ex("A", "failed")])
    assert single[0]["evidence"].startswith("unconfirmed")
    assert detect_regressions(base, base) == []


def test_stopping_rules() -> None:
    rows = [ex("A", "passed"), ex("B", "failed", critical_failed=True, repetition=2)]
    assert should_stop_on_critical(rows, enabled=False) is None
    assert "B" in should_stop_on_critical(rows, enabled=True) and should_stop_on_critical([ex("A", "failed")], enabled=True) is None
    assert can_afford(0.5, 0.4, 1.0) and not can_afford(0.7, 0.4, 1.0) and can_afford(99, 99, None)


TESTS = [test_wilson_matches_hand_computed_intervals, test_percentiles_and_description, test_repetition_policy_and_override, test_case_classes,
         test_blocked_skipped_and_errors_are_not_evidence, test_tool_consistency_follows_the_executed_tool_sequence, test_run_reliability,
         test_the_critical_failure_rate, test_gate_passes_a_clean_run_and_fails_a_critical_flake, test_gate_does_not_pass_when_nothing_ran_or_repetitions_are_too_few,
         test_paired_comparison, test_paired_comparison_is_reproducible_and_flags_thin_evidence, test_regression_detection, test_stopping_rules]


def run_all() -> int:
    failed = 0
    for test in TESTS:
        try:
            test()
            print(f"ok   {test.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {test.__name__}: {exc}")
    return failed


if __name__ == "__main__":
    failures = run_all()
    print(f"{'PASS' if not failures else 'FAILED'}: {len(TESTS)} statistics tests, {failures} failed")
    sys.exit(1 if failures else 0)
