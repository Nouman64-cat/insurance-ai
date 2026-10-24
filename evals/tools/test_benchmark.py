"""Unit tests of the multi-model benchmark: the registry's rules, the direct prompt and view, the provider stream reader, the per-model
numbers and the comparison. No database, no network. Run: python evals/tools/test_benchmark.py (selftest.py runs it too)."""
from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1]))
sys.path.insert(0, str(HERE.parents[0] / "environment" / "judge"))

from shared.evaluation import benchmark as bench  # noqa: E402
from shared.evaluation import direct, registry  # noqa: E402
import generate  # noqa: E402


def raises(exc, fn, *a, **kw) -> str:
    try:
        fn(*a, **kw)
    except exc as e:
        return str(e)
    raise AssertionError(f"{fn.__name__} did not raise {exc.__name__}")


# ── registry ────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_model_entry_is_checked_before_it_is_accepted() -> None:
    ok = registry.check_model("openai", "gpt-4o-mini", capabilities={"streaming": True, "context_window": 128000}, configuration={"temperature": 0.2})
    assert ok["synthetic"] is False and ok["roles"] == ["candidate"]
    assert registry.check_model("mock", "mock-oracle")["synthetic"] is True
    for bad in (dict(provider="acme", model_id="x"), dict(provider="openai", model_id="has space"), dict(provider="openai", model_id="x", status="gone"),
                dict(provider="openai", model_id="x", roles=["boss"]), dict(provider="openai", model_id="x", synthetic=True), dict(provider="mock", model_id="m", synthetic=False),
                dict(provider="openai", model_id="x", capabilities={"telepathy": True}), dict(provider="openai", model_id="x", capabilities={"streaming": "yes"}),
                dict(provider="openai", model_id="x", configuration={"colour": 1}), dict(provider="openai", model_id="x", configuration={"temperature": 5})):
        raises(registry.RegistryError, registry.check_model, **bad)


def test_a_price_needs_a_source_and_must_make_sense() -> None:
    assert registry.check_price("openai", 1, 0.5, 4, "pricing page")["output_per_m"] == 4.0
    for args in (("openai", -1, 0, 1, "x"), ("openai", 1, 2, 1, "x"), ("openai", 1, 0, 1, "  "), ("mock", 1, 0, 0, "x")):
        raises(registry.RegistryError, registry.check_price, *args)


def test_the_price_in_force_on_a_day_is_the_newest_one_that_had_started() -> None:
    now = datetime(2026, 10, 23)
    history = [{"effective_from": now - timedelta(days=30), "v": 1}, {"effective_from": now - timedelta(days=2), "v": 2}, {"effective_from": now + timedelta(days=5), "v": 3}]
    assert registry.price_on(history, now)["v"] == 2
    assert registry.price_on(history, now - timedelta(days=10))["v"] == 1
    assert registry.price_on(history, now - timedelta(days=60)) is None
    assert registry.price_on(history, now + timedelta(days=9))["v"] == 3


def test_the_seeded_registry_is_valid_and_scripted_models_cost_nothing() -> None:
    seeds = registry.seed_entries()
    labels = {registry.label(s["provider"], s["model_id"]): s for s in seeds}
    assert "openai/gpt-4o-mini" in labels and "mock/mock-oracle" in labels and "gemini/gemini-2.5-flash" in labels and "anthropic/claude-sonnet-4-5" in labels
    for s in seeds:
        registry.check_price(s["provider"], s["price"]["input_per_m"], s["price"]["cached_per_m"], s["price"]["output_per_m"], s["price"]["source"])
        assert s["synthetic"] == (s["provider"] == "mock")
    assert all(s["price"]["output_per_m"] == 0 for s in seeds if s["provider"] == "mock")


# ── the direct prompt ───────────────────────────────────────────────────────────────────────────────────────────────────

CASE = {"case_id": "C1", "input": {"actor": {"role": "Agent"}, "messages": [{"role": "user", "content": "How long is free-look for $policy.p1.policy_number?"}]},
        "reference_context": [{"text": "Free-look is 14 days."}, {"text": "It starts when documents are received."}],
        "assertions": [{"id": "A1", "target": "response.text", "type": "contains", "expected": "14"}, {"id": "A2", "target": "trace.executed_tools", "type": "equals", "expected": []},
                       {"id": "A3", "target": "state.x", "type": "equals", "expected": 1}],
        "semantic_criteria": [{"id": "S1", "metric": "correctness", "criterion": "says 14 days"}],
        "evaluation": {"layers": [{"layer": n, "enabled": True, "threshold": None} for n in ("L1", "L2", "L3", "L4", "L5", "L6")]}}


def test_every_model_gets_the_same_question_and_the_same_reference_information() -> None:
    m1, h1 = direct.build_messages(CASE)
    m2, h2 = direct.build_messages(CASE)
    assert m1 == m2 and h1 == h2 == {"context": ["Free-look is 14 days.", "It starts when documents are received."]}
    assert m1[0]["role"] == "system" and "Free-look is 14 days." in m1[0]["content"] and "The user is a Agent." in m1[0]["content"]
    assert m1[1] == {"role": "user", "content": CASE["input"]["messages"][0]["content"]} and "tools" not in m1[0]["content"].split("Reference")[1]


def test_a_direct_case_keeps_only_what_a_bare_model_can_be_judged_on() -> None:
    view = direct.direct_view(CASE)
    assert [a["id"] for a in view["assertions"]] == ["A1"] and len(CASE["assertions"]) == 3, "the stored case is not changed"
    enabled = {l["layer"] for l in view["evaluation"]["layers"] if l["enabled"]}
    assert enabled == {"L1", "L2", "L6"}
    assert direct.applicable(CASE) is None
    assert "single user message" in direct.applicable({**CASE, "input": {"messages": [{"role": "user", "content": "a"}, {"role": "user", "content": "b"}]}})
    assert "judged" in direct.applicable({**CASE, "assertions": [], "semantic_criteria": []})
    assert "no user message" in direct.applicable({"input": {"messages": []}})


def test_placeholders_become_readable_stand_ins_without_a_database() -> None:
    out = direct.resolve_standalone(CASE)
    assert "policy-p1" in out["input"]["messages"][0]["content"] and "$policy" not in out["input"]["messages"][0]["content"]
    assert "$policy" in CASE["input"]["messages"][0]["content"]


# ── the provider stream ─────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_stream_is_read_for_text_first_token_and_the_counts_the_provider_reported() -> None:
    st = generate.StreamState(started=100.0)
    lines = ['data: {"model":"gpt-4o-mini-2024-07-18","choices":[{"delta":{"role":"assistant","content":""}}]}', "", ": keep-alive",
             'data: {"choices":[{"delta":{"content":"Hello"}}]}', 'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
             'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8}}}', "data: not json", "data: [DONE]"]
    for i, line in enumerate(lines):
        st.feed(line, 100.0 + 0.5 + i * 0.1)
    r = st.result(ended=101.5)
    assert r["text"] == "Hello world" and r["finish_reason"] == "stop" and r["returned_model"] == "gpt-4o-mini-2024-07-18"
    assert r["latency_ms"] == 1500 and r["ttft_ms"] == 800, r          # the empty first delta is not the first token
    assert (r["input_tokens"], r["output_tokens"], r["cached_tokens"]) == (20, 2, 8) and st.done


def test_counts_the_provider_did_not_report_stay_unknown() -> None:
    st = generate.StreamState(started=0.0)
    st.feed('data: {"choices":[{"delta":{"content":"Hi"}}]}', 0.1)
    r = st.result(ended=0.2)
    assert r["input_tokens"] is None and r["output_tokens"] is None and r["cached_tokens"] is None


def test_only_the_scripted_model_is_told_anything_beyond_the_prompt() -> None:
    msgs = [{"role": "user", "content": "q"}]
    real = generate.build_body("gpt-4o-mini", msgs, {"temperature": 0, "max_tokens": 50, "colour": "x"}, mock_hint=None)
    assert "x_eval_direct" not in real and real["temperature"] == 0 and real["max_tokens"] == 50 and "colour" not in real and real["stream"] is True
    assert generate.build_body("mock-oracle", msgs, {}, mock_hint={"context": ["c"]})["x_eval_direct"] == {"context": ["c"]}


# ── the per-model numbers and the comparison ────────────────────────────────────────────────────────────────────────────

def row(case, rep, status="passed", *, latency=100, cost=0.01, critical=False, reason=None, out=50, inp=100, ttft=10, judge=0.001, metrics=None, layers=None):
    return {"case_id": case, "repetition": rep, "status": status, "reason": reason, "latency_ms": latency, "cost_usd": cost, "cost_known": cost is not None,
            "critical_failed": critical, "output_tokens": out, "input_tokens": inp, "cached_tokens": 0, "ttft_ms": ttft, "judge_cost_usd": judge,
            "metric_scores": metrics or [], "layer_scores": layers or {}}


def summary(model="openai/a", synthetic=False, mode="direct", repeat=3, judge="openai/j"):
    return {"synthetic_model": synthetic, "repeat": repeat, "run_id": "r-" + model,
            "dataset": {"dataset": "d", "version": "1.0.0", "snapshot_sha256": "abc", "verified": True},
            "config": {"mode": mode, "kind": f"benchmark_{mode}", "group_id": "B1", "model_id": model, "provider": model.split("/")[0], "judge_model": judge, "repeat": repeat}}


def rows_for(pass_pattern, cases=12, reps=3, **kw):
    """pass_pattern(case_index, rep) -> bool"""
    return [row(f"C{c}", r, "passed" if pass_pattern(c, r) else "failed", **kw) for c in range(cases) for r in range(1, reps + 1)]


def test_a_model_is_described_by_its_pass_rate_latency_errors_tokens_and_cost() -> None:
    rows = [row("C1", 1, latency=100), row("C1", 2, "failed", latency=300, critical=True), row("C2", 1, latency=200, cost=0.02),
            row("C2", 2, "infrastructure_error", reason="timeout", latency=None, cost=None, out=None, inp=None, ttft=None, judge=None),
            row("C3", 1, "infrastructure_error", reason="provider_error", latency=None, cost=None, out=None, inp=None, ttft=None, judge=None)]
    m = bench.aggregate_model("openai/a", rows, summary())
    assert (m["ran"], m["passes"], m["timeouts"], m["errors"]) == (3, 2, 1, 1) and m["error_kinds"] == {"provider_error": 1}
    assert abs(m["error_rate"] - 2 / 5) < 1e-9, "errors and timeouts count against the calls that were attempted"
    assert m["critical_failures"] == 1 and m["latency_ms"]["p50"] == 200 and m["latency_ms"]["mean"] == 200
    assert m["tokens"] == {"input": 300, "output": 150, "cached": 0, "executions_without_counts": 0}
    assert abs(m["cost"]["candidate_usd"] - 0.04) < 1e-9 and abs(m["cost"]["judge_usd"] - 0.003) < 1e-9, "the judge's cost is its own figure"
    assert abs(m["cost_per_passed_usd"] - 0.02) < 1e-9
    assert abs(m["throughput_tokens_per_s"] - 150 / 0.6) < 1e-6


def test_cached_input_tokens_are_priced_at_the_cached_rate() -> None:
    from shared.evaluation.run_report import cost_from_usage
    usage = {"status": "attributed", "by_model": {"gpt-4o-mini-2024-07-18": {"input_tokens": 1_000_000, "output_tokens": 0, "cached_tokens": 400_000}}}
    cost, known = cost_from_usage(usage, True)
    assert known and abs(cost - (600_000 * 0.15 + 400_000 * 0.075) / 1_000_000) < 1e-9, cost


def test_an_unknown_cost_is_never_turned_into_a_cost_per_pass() -> None:
    m = bench.aggregate_model("openai/a", [row("C1", 1), row("C2", 1, cost=None)], summary())
    assert m["cost"]["executions_with_unknown_cost"] == 1 and m["cost_per_passed_usd"] is None


def test_the_judges_scores_and_the_layers_become_quality_tool_accuracy_and_safety() -> None:
    metrics = [{"metric": "correctness", "status": "scored", "score": 0.9, "passed": True}, {"metric": "safety", "status": "scored", "score": 0.2, "passed": False},
               {"metric": "faithfulness", "status": "judge_error", "score": None}]
    layers = {"L3": {"applicable": True, "score": 0.5}, "L4": {"applicable": True, "score": 1.0}, "L5": {"applicable": True, "status": "passed"}}
    m = bench.aggregate_model("openai/a", [row("C1", 1, metrics=metrics, layers=layers)], summary())
    assert set(m["quality"]) == {"correctness", "safety"} and m["quality"]["correctness"]["mean"] == 0.9, "an unscored metric is left out, not counted as 0"
    assert m["tool_accuracy"]["mean"] == 0.5 and m["workflow_compliance"]["mean"] == 1.0
    assert m["safety_violations"]["executions"] == 1, "a failed safety criterion is a violation"


def test_a_model_that_could_not_be_called_is_reported_as_blocked_not_as_failing() -> None:
    rows = [row("C1", 1, "blocked", reason="blocked_missing_credentials")]
    rows[0]["error"] = "no openai key"
    m = bench.aggregate_model("openai/a", rows, summary())
    assert m["status"] == "blocked_missing_credentials" and "pass_rate" not in m


def pair(a_pass, b_pass, *, cases=12, reps=3, synthetic=False, a_crit=0.0, b_crit=0.0):
    ra, rb = rows_for(a_pass, cases, reps), rows_for(b_pass, cases, reps)
    ma, mb = bench.aggregate_model("openai/a", ra, summary("openai/a", synthetic)), bench.aggregate_model("openai/b", rb, summary("openai/b", synthetic))
    ma["critical_failure_rate"], mb["critical_failure_rate"] = a_crit, b_crit
    return bench.compare_pair(ma, mb, ra, rb, synthetic=synthetic)


def test_a_model_is_called_better_only_when_the_evidence_supports_it() -> None:
    clear = pair(lambda c, r: False, lambda c, r: True)
    assert clear["verdict"] == "b_better", clear
    same = pair(lambda c, r: (c + r) % 2 == 0, lambda c, r: (c + r) % 2 == 0)
    assert same["verdict"] == "no_reliable_difference"
    few_cases = pair(lambda c, r: False, lambda c, r: True, cases=5)
    assert few_cases["verdict"] == "insufficient_evidence" and "5 case(s)" in few_cases["reason"]
    one_rep = pair(lambda c, r: False, lambda c, r: True, reps=1)
    assert one_rep["verdict"] == "insufficient_evidence" and "1 repetition(s)" in one_rep["reason"]


def test_scripted_models_are_never_ranked() -> None:
    assert pair(lambda c, r: False, lambda c, r: True, synthetic=True)["verdict"] == "synthetic"


def test_passing_more_does_not_win_if_the_critical_failures_are_worse() -> None:
    v = pair(lambda c, r: False, lambda c, r: True, b_crit=0.2)
    assert v["verdict"] == "no_reliable_difference" and "critical" in v["reason"]


def run_of(label, rows, **kw):
    return {"label": label, "rows": rows, "summary": summary(label, **kw), "folder": f"/runs/{label}", "exit_code": 0}


def test_a_benchmark_names_a_leader_only_when_it_beats_every_other_model() -> None:
    runs = [run_of("openai/a", rows_for(lambda c, r: False)), run_of("openai/b", rows_for(lambda c, r: True)), run_of("openai/c", rows_for(lambda c, r: c < 2))]
    b = bench.build_benchmark(benchmark_id="B1", mode="direct", runs=runs, judge_model="openai/j")
    assert b["valid"] and b["order"] == ["openai/b", "openai/c", "openai/a"] and b["leader"] == "openai/b"
    assert b["fairness"][0]["ok"]
    close = [run_of("openai/a", rows_for(lambda c, r: c % 2 == 0)), run_of("openai/b", rows_for(lambda c, r: c % 2 == 0 or c == 1))]
    assert bench.build_benchmark(benchmark_id="B1", mode="direct", runs=close, judge_model="openai/j")["leader"] is None, "a small edge is not a leader"


def test_a_benchmark_of_scripted_models_names_no_leader_and_says_so() -> None:
    runs = [run_of("mock/mock-oracle", rows_for(lambda c, r: True), synthetic=True), run_of("mock/mock-lazy", rows_for(lambda c, r: False), synthetic=True)]
    b = bench.build_benchmark(benchmark_id="B1", mode="direct", runs=runs, judge_model="mock/mock-judge")
    assert b["synthetic"] and b["leader"] is None and any("SYNTHETIC" in n for n in b["notes"])
    assert "no model is shown to be better" in bench.render(b)


def test_a_run_that_did_not_do_what_the_benchmark_asked_invalidates_it() -> None:
    wrong = run_of("openai/b", rows_for(lambda c, r: True))
    wrong["summary"]["config"]["mode"] = "agent"
    b = bench.build_benchmark(benchmark_id="B1", mode="direct", runs=[run_of("openai/a", rows_for(lambda c, r: False)), wrong], judge_model="openai/j")
    assert not b["valid"] and "ran in mode 'agent'" in b["problems"][0] and b["notes"][0].startswith("INVALID BENCHMARK")
    assert "INVALID" in bench.render(b)


def test_unequal_conditions_are_called_out() -> None:
    other_judge = run_of("openai/b", rows_for(lambda c, r: True))
    other_judge["summary"]["config"]["judge_model"] = "openai/other"
    b = bench.build_benchmark(benchmark_id="B1", mode="direct", runs=[run_of("openai/a", rows_for(lambda c, r: False)), other_judge], judge_model="openai/j")
    bad = [c["check"] for c in b["fairness"] if not c["ok"]]
    assert "judge model" in bad and any("NOT all asked" in n for n in b["notes"])


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]


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
    print(f"{'PASS' if not failures else 'FAILED'}: {len(TESTS)} benchmark tests, {failures} failed")
    sys.exit(1 if failures else 0)
