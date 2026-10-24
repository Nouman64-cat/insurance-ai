"""Integration tests of the runner (evals/tools/eval_runner.py) against the live isolated stack, inside eval-runner:

    python evals/environment/envctl.py test-runner          # wraps  python -m evals.tools.test_runner_integration

They run the real Runner on real cases (from the repository sources, which need no lake) and check what the unit tests cannot:
that every execution starts from a clean database, that repetitions are independent, that results survive resets, that a
cancel keeps what was done, that a timeout is an infrastructure error and not a failure, that a missing key or an exhausted
budget blocks a model-backed case WITHOUT calling the model, and that a chat case can never be reported as passed.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Callable, List

sys.path.insert(0, str(Path(__file__).resolve().parent))
import eval_runner  # noqa: E402
from shared.evaluation.run_report import select_cases  # noqa: E402


def args(**kw) -> argparse.Namespace:
    base = dict(metrics=[], mode="agent", settings={}, bundle=None, from_source=True, suite="technical", cases=[], categories=[], operations=[], repeat=1, concurrency=4, timeout=120.0,
                reset="per-case", budget_usd=1.0, strict=False, model=None, skills="default", prompt_version=None, judge=None, allow_same_judge=False,
                kind="suite", group_id=None, job_id=None, chat_timeout=300.0, retries=0, max_latency_ms=None, max_tokens=None, max_cost_usd=None,
                stop_on_critical=False, gate=False, gate_min_pass_rate=0.9, gate_min_repetitions=1)
    return argparse.Namespace(**{**base, **kw})


async def run(case_ids: List[str], **kw) -> "eval_runner.Runner":
    bundle = eval_runner.bundle_from_source()
    selected, _ = select_cases(bundle.cases, case_ids=case_ids)
    runner = eval_runner.Runner(bundle, args(**kw))
    await runner.run(selected)
    return runner


def lines(runner) -> List[dict]:
    return [json.loads(x) for x in (runner.out / "results.jsonl").read_text().splitlines()]


async def t_repetitions_start_from_a_clean_database() -> None:
    # IND-CUST-001 creates a customer. If the first repetition's customer were still there, the second would be refused as a duplicate.
    r = await run(["IND-CUST-001", "IND-CUST-004"], repeat=3)
    got = [(x["case_id"], x["repetition"], x["status"], x["reason"]) for x in lines(r)]
    assert len(got) == 6 and all(s == "passed" for _, _, s, _ in got), got
    assert {x["repetition"] for x in lines(r)} == {1, 2, 3}


async def t_each_case_starts_clean_even_in_the_same_repetition() -> None:
    r = await run(["IND-CUST-001", "IND-CUST-001x"][:1] + ["IND-CUST-004"], reset="per-case")
    assert [x["status"] for x in lines(r)] == ["passed", "passed"], lines(r)


async def t_results_are_on_disk_outside_the_database() -> None:
    r = await run(["IND-RISK-001", "IND-PAY-004"])
    assert (r.out / "results.jsonl").is_file() and len(lines(r)) == 2
    for x in lines(r):
        art = json.loads((r.out / x["artifact"]).read_text())
        assert art["observation"]["result"]["status_code"] and art["assertions"]["results"], "the observed output and every assertion are kept"
    assert eval_runner.OUTPUT in r.out.parents, "results are written under the runs folder, not into the database that is reset"


async def t_a_cancel_keeps_what_was_done_and_stops() -> None:
    bundle = eval_runner.bundle_from_source()
    selected, _ = select_cases(bundle.cases, case_ids=["IND-RISK-001", "IND-RISK-002", "IND-RISK-003"])
    runner = eval_runner.Runner(bundle, args())
    original = runner.execute_one

    async def cancel_after_first(case, repetition):
        out = await original(case, repetition)
        runner.cancel.set()                                  # what SIGINT does
        return out
    runner.execute_one = cancel_after_first
    await runner.run(selected)
    assert len(lines(runner)) == 1 and runner.cancel.is_set(), "the case in flight finished, nothing after it started"


async def t_a_timeout_is_an_infrastructure_error_not_a_failure() -> None:
    r = await run(["IND-RISK-001"], timeout=0.001)
    x = lines(r)[0]
    assert x["status"] == "infrastructure_error" and x["reason"] == "timeout", x


async def t_without_a_key_model_cases_are_blocked_and_the_model_is_not_called() -> None:
    bundle = eval_runner.bundle_from_source()
    selected, _ = select_cases(bundle.cases, case_ids=["IND-KYC-001", "IND-KYC-003"])
    runner = eval_runner.Runner(bundle, args())
    runner.providers = set()
    before = len(await _ledger(runner, selected))
    await runner.run(selected)
    by = {x["case_id"]: x for x in lines(runner)}
    assert by["IND-KYC-001"]["status"] == "blocked" and by["IND-KYC-001"]["reason"] == "blocked_missing_credentials", by["IND-KYC-001"]
    assert by["IND-KYC-003"]["status"] == "passed", "a refused upload needs no key and proves no model was called"
    assert len(await _ledger(runner, selected)) == before, "nothing was recorded in the token ledger"


async def _ledger(runner, selected):
    env = eval_runner.Environment(eval_runner.casekit.FIXTURES)
    try:
        return await env.ledger()
    finally:
        await env.close()


async def t_an_exhausted_budget_blocks_before_calling_the_model() -> None:
    bundle = eval_runner.bundle_from_source()
    selected, _ = select_cases(bundle.cases, case_ids=["IND-KYC-001"])
    runner = eval_runner.Runner(bundle, args(budget_usd=0.0))
    runner.providers = {"openai"}                           # pretend a key exists: the budget must stop it first
    await runner.run(selected)
    x = lines(runner)[0]
    assert x["status"] == "blocked" and x["reason"] == "budget_exceeded", x
    assert x["usage"] is None, "no call was attempted, so there is no usage"


async def t_chat_cases_are_skipped_and_never_pass() -> None:
    bundle = eval_runner.bundle_from_source()
    chat = [c["case_id"] for c in bundle.cases if (c.get("metadata") or {}).get("interface") == "chat"]
    selected, _ = select_cases(bundle.cases, case_ids=chat)
    runner = eval_runner.Runner(bundle, args())
    await runner.run(selected)
    statuses = {x["status"] for x in lines(runner)}
    assert statuses == {"skipped"} and len(lines(runner)) == len(chat) > 0, statuses


async def t_function_cases_run_concurrently_and_still_pass() -> None:
    bundle = eval_runner.bundle_from_source()
    selected, _ = select_cases(bundle.cases, operations=["quotes.calculate", "underwriting.decide", "underwriting.determine_requirements", "compliance.screen_aml"])
    runner = eval_runner.Runner(bundle, args(concurrency=4))
    await runner.run(selected)
    rows = lines(runner)
    assert rows and all(x["status"] == "passed" for x in rows), [(x["case_id"], x["status"], x["reason"]) for x in rows if x["status"] != "passed"]
    assert all(x["cost_usd"] == 0.0 and x["cost_known"] for x in rows), "no model was used: the cost is known to be zero"


async def t_the_refusal_cases_prove_zero_model_calls_from_the_ledger() -> None:
    r = await run(["IND-KYC-003", "IND-KYC-004"])
    for x in lines(r):
        assert x["status"] == "passed" and x["usage"]["status"] == "attributed" and x["usage"]["calls"] == 0, x
        assert x["cost_usd"] == 0.0 and x["cost_known"]


async def t_the_regression_cases_for_the_three_defects_pass_now() -> None:
    r = await run(["IND-CUST-001", "IND-SEC-007", "IND-SEC-008", "IND-SEC-009", "IND-SEC-010", "IND-SEC-011"])
    bad = [(x["case_id"], x["failed_assertions"]) for x in lines(r) if x["status"] != "passed"]
    assert not bad, bad


async def t_the_environment_is_left_clean() -> None:
    await run(["IND-CUST-001"])
    env = eval_runner.Environment(eval_runner.casekit.FIXTURES)
    try:
        await env.fresh()
        async with env.engine.connect() as conn:
            from sqlalchemy import text
            assert (await conn.execute(text("select count(*) from customers where name = 'Zara Iqbal'"))).scalar() == 0
    finally:
        await env.close()


TESTS: List[Callable] = [t_repetitions_start_from_a_clean_database, t_each_case_starts_clean_even_in_the_same_repetition, t_results_are_on_disk_outside_the_database,
                         t_a_cancel_keeps_what_was_done_and_stops, t_a_timeout_is_an_infrastructure_error_not_a_failure,
                         t_without_a_key_model_cases_are_blocked_and_the_model_is_not_called, t_an_exhausted_budget_blocks_before_calling_the_model,
                         t_chat_cases_are_skipped_and_never_pass, t_function_cases_run_concurrently_and_still_pass,
                         t_the_refusal_cases_prove_zero_model_calls_from_the_ledger, t_the_regression_cases_for_the_three_defects_pass_now,
                         t_the_environment_is_left_clean]


async def main() -> int:
    failed = 0
    for test in TESTS:
        started = time.monotonic()
        try:
            await test()
            status, detail = "ok", ""
        except AssertionError as exc:
            status, detail, failed = "FAIL", str(exc), failed + 1
        except Exception as exc:                  # noqa: BLE001 — an unexpected error is a failure of the test, reported as one
            status, detail, failed = "FAIL", f"{type(exc).__name__}: {exc}", failed + 1
        print(f"{status:5} {test.__name__[2:]:72} {time.monotonic() - started:5.1f}s" + (f"\n        {detail}" if detail else ""))
    print(f"\n{len(TESTS)} runner integration tests: {len(TESTS) - failed} ok, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
