"""Integration tests of direct mode and the multi-model benchmark against the live isolated stack, inside eval-runner:

    python evals/environment/envctl.py test-benchmark          # wraps  python -m evals.tools.test_benchmark_integration

Scripted models only (SYNTHETIC: these prove the machinery, not model quality). They check what unit tests cannot: that a direct call goes
through the generation service and is judged like an agent answer, that a model without a key is reported blocked and never called, that
a benchmark runs every model the same way and refuses to call scripted models better, that a run which did not do what was asked
invalidates the benchmark, that the agent benchmark measures tool accuracy, and that a cancel keeps what was done.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
import time
from pathlib import Path
from typing import Callable, List, Optional, Tuple

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import eval_runner  # noqa: E402
from shared.evaluation.run_report import select_cases  # noqa: E402

RUNS = Path(os.environ.get("EVAL_OUTPUT", "/work/runs"))
JUDGE = os.environ["EVAL_JUDGE_URL"]
CASES = ["IND-AGT-001", "IND-AGT-002", "IND-CLM-005", "IND-LEAD-001", "IND-PLAN-003"]      # chat cases with a response check or a judged criterion that the scripted oracle meets


def args(**kw) -> argparse.Namespace:
    base = dict(metrics=[], mode="direct", settings={}, bundle=None, from_source=True, suite="technical", cases=[], categories=[], operations=[], repeat=1, concurrency=4, timeout=120.0,
                reset="per-case", budget_usd=1.0, strict=False, model="mock/mock-oracle", skills="default", prompt_version=None, judge="mock/mock-judge", allow_same_judge=False,
                kind="benchmark_direct", group_id=None, job_id=None, chat_timeout=60.0, retries=0, max_latency_ms=None, max_tokens=None, max_cost_usd=None,
                stop_on_critical=False, gate=False, gate_min_pass_rate=0.9, gate_min_repetitions=1)
    return argparse.Namespace(**{**base, **kw})


async def direct(case_ids: List[str], **kw):
    bundle = eval_runner.bundle_from_source()
    selected, _ = select_cases(bundle.cases, case_ids=case_ids)
    selected, left = eval_runner.direct_selection(selected, [])
    runner = eval_runner.Runner(bundle, args(**kw))
    await runner.run(selected)
    return runner, left


async def benchmark(*cli: str, wait_for: Optional[Tuple[str, int]] = None) -> Tuple[int, dict, str]:
    """Run the benchmark tool the way the command line does. `wait_for=(text, signal)` sends a signal once the text has been printed."""
    bid = f"bench-test-{int(time.time() * 1000) % 10**9}"
    proc = await asyncio.create_subprocess_exec(sys.executable, "-m", "evals.tools.benchmark", "--id", bid, "--from-source", *cli,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    lines, sent = [], False
    assert proc.stdout is not None
    async for raw in proc.stdout:
        line = raw.decode("utf-8", "replace")
        lines.append(line)
        if wait_for and not sent and wait_for[0] in line:
            proc.send_signal(wait_for[1])
            sent = True
    code = await proc.wait()
    path = RUNS / "benchmarks" / f"{bid}.json"
    return code, (json.loads(path.read_text()) if path.is_file() else {}), "".join(lines)


async def t_a_direct_call_goes_through_the_generation_service_and_is_judged_like_an_agent_answer() -> None:
    r, left = await direct(CASES, model="mock/mock-oracle")
    rows = [x.as_dict() for x in r.results]
    assert len(rows) == len(CASES) and all(x["status"] in ("passed", "failed") for x in rows), [(x["case_id"], x["status"], x["reason"]) for x in rows]
    x = rows[0]
    assert x["usage"]["status"] == "attributed" and x["input_tokens"] and x["output_tokens"] and x["ttft_ms"] is not None and x["cost_usd"] == 0.0 and x["cost_known"], x
    assert x["layer_scores"]["L1"]["status"] == "passed" and x["layer_scores"]["L6"]["status"] == "measured"
    assert r.env is None, "a bare model call needs no database and no agent"
    assert (r.out / x["trace_artifact"]).is_file() and json.loads((r.out / x["trace_artifact"]).read_text())["messages"][0]["role"] == "system"


async def t_cases_a_bare_model_cannot_be_judged_on_are_left_out_with_the_reason() -> None:
    r, left = await direct(["IND-CUST-001", "IND-LEAD-002"])
    reasons = {c["case_id"]: c["_left_out"] for c in left}
    assert all(v.startswith("not_applicable_in_direct_mode") for v in reasons.values()) and reasons, reasons


async def t_the_scripted_models_answer_differently_and_the_harness_tells_them_apart() -> None:
    good, _ = await direct(CASES, model="mock/mock-oracle")
    lazy, _ = await direct(CASES, model="mock/mock-lazy")
    ok = lambda r: sum(1 for x in r.results if x.status == "passed")          # noqa: E731
    assert ok(good) > ok(lazy) and ok(lazy) == 0, (ok(good), ok(lazy))


async def t_a_model_without_a_key_is_blocked_and_never_called() -> None:
    r, _ = await direct(CASES[:2], model="anthropic/claude-haiku-4-5")          # a provider with no key in any configuration (OpenAI now has one)
    assert {x.status for x in r.results} == {"blocked"} and {x.reason for x in r.results} == {"blocked_missing_credentials"}
    assert all(x.usage is None for x in r.results)


async def t_the_same_prompt_reaches_every_model() -> None:
    await direct(CASES[:1], model="mock/mock-oracle")
    await direct(CASES[:1], model="mock/mock-lazy")
    log = (await httpx.AsyncClient().get(os.environ["EVAL_MOCK_LLM_URL"].rsplit("/v1", 1)[0] + "/__eval/log")).json()["requests"]
    last = {e["model"]: e for e in log if e["model"] in ("mock-oracle", "mock-lazy")}
    assert last["mock-oracle"]["system_sha"] == last["mock-lazy"]["system_sha"], "both models were given the identical system prompt"


def t_bad_options_are_refused_before_anything_runs() -> None:
    import contextlib
    import io
    for bad in (["--mode", "direct"], ["--mode", "direct", "--model", "mock/mock-oracle", "--skills", "on"], ["--mode", "direct", "--model", "mock/mock-oracle", "--setting", "colour=1"],
                ["--mode", "agent", "--model", "mock/mock-oracle", "--setting", "temperature=0"], ["--mode", "direct", "--model", "mock/mock-oracle", "--setting", "temperature=hot"]):
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                eval_runner.parse(["--from-source", *bad])
        except SystemExit:
            continue
        raise AssertionError(f"{bad} was accepted")
    a = eval_runner.parse(["--from-source", "--mode", "direct", "--model", "mock/mock-oracle", "--setting", "temperature=0", "--setting", "max_tokens=300"])
    assert a.settings == {"temperature": 0, "max_tokens": 300}


async def t_a_direct_benchmark_compares_models_asked_the_same_thing_and_ranks_nobody_when_they_are_scripted() -> None:
    code, b, out = await benchmark("--mode", "direct", "--models", "mock/mock-oracle,mock/mock-lazy", "--judge", "mock/mock-judge", "--repeat", "2", "--case", *CASES)
    assert code == 0 and b["valid"] and b["mode"] == "direct" and b["synthetic"], out[-800:]
    m = b["models"]
    assert m["mock/mock-oracle"]["status"] == "measured" and m["mock/mock-oracle"]["pass_rate"] > m["mock/mock-lazy"]["pass_rate"] == 0
    assert b["leader"] is None and b["comparisons"][0]["verdict"] == "synthetic"
    assert all(c["ok"] for c in b["fairness"] if "verified" not in c["check"]), [c for c in b["fairness"] if not c["ok"]]
    assert m["mock/mock-oracle"]["cost"]["judge_usd"] == 0.0 and "candidate_usd" in m["mock/mock-oracle"]["cost"], "candidate and judge costs are separate figures"
    assert b["fallback"].startswith("none") and b["judge"]["model"] == "mock/mock-judge" and b["judge"]["deepeval_version"]
    runs = [json.loads((Path(v["folder"]) / "summary.json").read_text()) for v in b["runs"].values()]
    assert {r["config"]["group_id"] for r in runs} == {b["benchmark_id"]} and {r["config"]["kind"] for r in runs} == {"benchmark_direct"}


async def t_a_model_that_cannot_be_called_is_reported_blocked_and_the_rest_are_still_measured() -> None:
    code, b, out = await benchmark("--mode", "direct", "--models", "mock/mock-oracle,anthropic/claude-haiku-4-5", "--judge", "mock/mock-judge", "--case", *CASES[:3])
    assert code == 0 and b["models"]["anthropic/claude-haiku-4-5"]["status"] == "blocked_missing_credentials", out[-600:]
    assert b["models"]["mock/mock-oracle"]["status"] == "measured" and b["complete"] is False
    assert any("not measured" in n for n in b["notes"]) and b["leader"] is None


async def t_an_agent_benchmark_changes_only_the_model_and_measures_tool_accuracy() -> None:
    code, b, out = await benchmark("--mode", "agent", "--models", "mock/mock-oracle,mock/mock-lazy", "--judge", "mock/mock-judge", "--repeat", "2",
                                   "--case", "IND-LEAD-001", "IND-AGT-006", "IND-PLAN-002")
    assert code == 0 and b["valid"] and b["mode"] == "agent", out[-800:]
    o, l = b["models"]["mock/mock-oracle"], b["models"]["mock/mock-lazy"]
    assert o["pass_rate"] > l["pass_rate"] and o["tool_accuracy"]["n"] > 0 and o["tool_accuracy"]["mean"] > l["tool_accuracy"]["mean"], (o["tool_accuracy"], l["tool_accuracy"])
    assert o["config"]["skills_enabled"] is None and o["config"]["mode"] == "agent"
    assert all(c["ok"] for c in b["fairness"] if "verified" not in c["check"])


async def t_a_benchmark_whose_run_did_not_do_what_was_asked_is_invalid_and_not_stored() -> None:
    from shared.evaluation import benchmark as lib
    code, b, _ = await benchmark("--mode", "direct", "--models", "mock/mock-oracle,mock/mock-lazy", "--judge", "mock/mock-judge", "--case", *CASES[:2])
    rows = {l: (json.loads((Path(v["folder"]) / "results.jsonl").read_text().splitlines()[0]), json.loads((Path(v["folder"]) / "summary.json").read_text())) for l, v in b["runs"].items()}
    runs = [{"label": l, "rows": [r], "summary": s, "folder": None, "exit_code": 0} for l, (r, s) in rows.items()]
    runs[0]["summary"]["config"]["mode"] = "agent"                                     # what an older runner would have recorded
    assert not lib.build_benchmark(benchmark_id=b["benchmark_id"], mode="direct", runs=runs, judge_model="mock/mock-judge")["valid"]


async def t_a_cancel_keeps_the_models_already_run_and_stops_the_rest() -> None:
    code, b, out = await benchmark("--mode", "direct", "--models", "mock/mock-oracle,mock/mock-lazy,mock/mock-reckless", "--judge", "mock/mock-judge", "--repeat", "3",
                                   wait_for=("=== mock/mock-oracle", signal.SIGTERM))
    assert code in (0, 3) and b and b["complete"] is False and any("CANCELLED" in n for n in b["notes"]), out[-600:]
    assert "mock/mock-reckless" not in b["models"] and "mock/mock-oracle" in b["models"], list(b["models"])


async def t_calibration_is_recorded_with_the_benchmark() -> None:
    code, b, out = await benchmark("--mode", "direct", "--models", "mock/mock-oracle,mock/mock-lazy", "--judge", "mock/mock-judge", "--calibrate", "--case", *CASES[:2])
    cal = b["judge"]["calibration"]
    assert cal and cal["status"] == "not_trusted" and cal["items"] == 13, cal


TESTS: List[Callable] = [t_a_direct_call_goes_through_the_generation_service_and_is_judged_like_an_agent_answer, t_cases_a_bare_model_cannot_be_judged_on_are_left_out_with_the_reason,
                         t_the_scripted_models_answer_differently_and_the_harness_tells_them_apart, t_a_model_without_a_key_is_blocked_and_never_called,
                         t_the_same_prompt_reaches_every_model, t_bad_options_are_refused_before_anything_runs,
                         t_a_direct_benchmark_compares_models_asked_the_same_thing_and_ranks_nobody_when_they_are_scripted,
                         t_a_model_that_cannot_be_called_is_reported_blocked_and_the_rest_are_still_measured, t_an_agent_benchmark_changes_only_the_model_and_measures_tool_accuracy,
                         t_a_benchmark_whose_run_did_not_do_what_was_asked_is_invalid_and_not_stored, t_a_cancel_keeps_the_models_already_run_and_stops_the_rest,
                         t_calibration_is_recorded_with_the_benchmark]


async def main() -> int:
    failed = 0
    for test in TESTS:
        started = time.monotonic()
        try:
            result = test()
            if asyncio.iscoroutine(result):
                await result
            status, detail = "ok", ""
        except AssertionError as exc:
            status, detail, failed = "FAIL", str(exc), failed + 1
        except Exception as exc:                  # noqa: BLE001 — an unexpected error is a failure of the test, reported as one
            status, detail, failed = "FAIL", f"{type(exc).__name__}: {exc}", failed + 1
        print(f"{status:5} {test.__name__[2:]:100} {time.monotonic() - started:5.1f}s" + (f"\n        {detail}" if detail else ""))
    print(f"\nbenchmark integration tests: {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
