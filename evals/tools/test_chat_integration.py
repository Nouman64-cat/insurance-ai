"""Integration tests of chat evaluation against the live isolated stack, inside eval-runner:

    python evals/environment/envctl.py test-chat          # wraps  python -m evals.tools.test_chat_integration

They run the real Runner on real chat cases, through the real chat agent, with the scripted stand-in model (SYNTHETIC: these tests
prove the harness works, they say nothing about model quality) and the DeepEval judge service. They check what unit tests cannot:
that a conversation is driven and observed end to end, that the six layers and the judge decide a verdict, that a lazy agent fails and
a reckless one fails critically, that skills and prompt variants really change what the agent sends to the model, that another user's
conversation is refused, that infrastructure errors are retried and verdicts are not, that a critical failure can stop a run, that
every repetition gets a fresh thread and database, and that a missing key blocks a chat case without calling anything.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Callable, List, Optional

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import eval_runner  # noqa: E402
from shared.evaluation.run_report import CaseResult, select_cases  # noqa: E402

MOCK = os.environ["EVAL_MOCK_LLM_URL"]


def args(**kw) -> argparse.Namespace:
    base = dict(metrics=[], mode="agent", settings={}, bundle=None, from_source=True, suite="technical", cases=[], categories=[], operations=[], repeat=1, concurrency=4, timeout=120.0,
                reset="per-case", budget_usd=1.0, strict=False, model="mock/mock-oracle", skills="default", prompt_version=None, judge=None,
                allow_same_judge=False, kind="suite", group_id=None, job_id=None, chat_timeout=300.0, retries=0, max_latency_ms=None, max_tokens=None,
                max_cost_usd=None, stop_on_critical=False, gate=False, gate_min_pass_rate=0.9, gate_min_repetitions=1)
    return argparse.Namespace(**{**base, **kw})


async def run(case_ids: List[str], **kw) -> "eval_runner.Runner":
    bundle = eval_runner.bundle_from_source()
    selected, _ = select_cases(bundle.cases, case_ids=case_ids)
    runner = eval_runner.Runner(bundle, args(**kw))
    await runner.run(selected)
    return runner


def only(runner: "eval_runner.Runner", case_id: str, repetition: int = 1) -> CaseResult:
    return next(r for r in runner.results if r.case_id == case_id and r.repetition == repetition)


async def mock_log() -> List[dict]:
    async with httpx.AsyncClient() as c:
        return (await c.get(f"{MOCK}/__eval/log")).json()["requests"]


async def t_a_conversation_is_driven_observed_and_judged_in_layers() -> None:
    r = await run(["IND-LEAD-001"], judge="mock/mock-judge")
    x = only(r, "IND-LEAD-001")
    assert x.status == "passed", (x.status, x.reason, x.failed_assertions)
    assert x.layer_scores["L1"]["status"] == "passed" and x.layer_scores["L3"]["status"] == "passed" and x.layer_scores["L4"]["status"] == "passed"
    assert x.layer_scores["L2"]["status"] == "passed" and x.metric_scores and all(m["status"] == "scored" and m["judge_model"] == "mock/mock-judge" for m in x.metric_scores)
    assert x.layer_scores["L6"]["status"] == "measured" and x.latency_ms and x.ttft_ms is not None
    assert x.verdict["passed"] and x.verdict["complete"] and not x.verdict["critical_failed"]
    assert x.model_id == "mock/mock-oracle" and x.synthetic_model and x.turns == 1
    assert x.usage["status"] == "attributed" and x.llm_calls >= 2 and x.cost_known and x.cost_usd == 0.0, x.usage
    assert x.trace_summary["executed_tools"] == ["record_lead"] and x.trace_summary["skills"] == ["lead-customer-acquisition"]
    trace = json.loads((r.out / x.trace_artifact).read_text())
    assert trace["turns"][0]["reply"] and trace["messages"] and trace["synthetic"] is True


async def t_without_a_judge_the_case_is_decided_without_it_and_says_so() -> None:
    x = only(await run(["IND-LEAD-001"]), "IND-LEAD-001")
    assert x.status == "passed" and x.layer_scores["L2"]["status"] == "not_scored" and x.verdict["complete"] is False and x.verdict["unscored_layers"] == ["L2"], x.verdict
    assert all(m["status"] == "judge_not_configured" for m in x.metric_scores) or x.metric_scores == []


async def t_a_lazy_agent_fails_and_the_judge_sees_the_empty_answer() -> None:
    x = only(await run(["IND-AGT-001"], model="mock/mock-lazy", judge="mock/mock-judge"), "IND-AGT-001")
    assert x.status == "failed" and "L2" in x.verdict["failing_layers"], x.verdict          # the empty answer is caught by the judged layer
    assert x.layer_scores["L2"]["status"] == "failed" and any(m["score"] is not None and m["score"] < 0.7 for m in x.metric_scores), x.metric_scores


async def t_a_reckless_agent_is_stopped_by_the_permission_gate_and_otherwise_fails_critically() -> None:
    # Where the role may not use the tool, the real agent never executes it: a reckless model gets no further than the gate.
    gated = only(await run(["IND-SEC-001"], model="mock/mock-reckless"), "IND-SEC-001")
    assert gated.status == "passed" and "delete_customer" not in gated.trace_summary["executed_tools"], (gated.status, gated.trace_summary)
    # Where the role may use the tool, only the case's own assertion can catch it: a critical failure, which can stop the run.
    r = await run(["IND-AGT-004", "IND-AGT-006", "IND-LEAD-002", "IND-LEAD-003"], model="mock/mock-reckless", stop_on_critical=True)
    crit = [x for x in r.results if x.critical_failed]
    assert crit and all(x.status == "failed" and x.verdict["reason"] == "critical_assertion_failed" for x in crit), [(x.case_id, x.status, x.verdict) for x in r.results]
    assert r.cancel.is_set() and r.stop_reason and "critical failure" in r.stop_reason and len(r.results) < 4, (r.stop_reason, len(r.results))
    events = [json.loads(l) for l in (r.out / "events.jsonl").read_text().splitlines()]
    assert any(e["kind"] == "log" and "stopping" in e["message"] for e in events)


async def t_skills_and_prompt_variants_change_what_the_agent_sends_to_the_model() -> None:
    async def system_of(**kw) -> dict:
        async with httpx.AsyncClient() as c:
            await c.post(f"{MOCK}/__eval/reset")
        r = await run(["IND-LEAD-001"], **kw)
        assert only(r, "IND-LEAD-001").status == "passed", kw
        rows = [q for q in await mock_log() if q["case"] == "IND-LEAD-001" and not q["model"].startswith("mock-judge")]
        return {"sha": {q["system_sha"] for q in rows}, "chars": max(q["system_chars"] for q in rows), "tools": max(q["tools_bound"] for q in rows)}
    base = await system_of()
    off = await system_of(skills="off")
    on = await system_of(skills="on")
    concise = await system_of(prompt_version="concise-v1")
    cautious = await system_of(prompt_version="cautious-v1")
    assert on["sha"] == base["sha"], "skills on is the default"
    assert off["sha"] != base["sha"] and off["chars"] < base["chars"] and off["tools"] < base["tools"], (off, base)
    assert concise["sha"] != base["sha"] and concise["chars"] > base["chars"] and cautious["sha"] not in (base["sha"], concise["sha"])


async def t_another_users_conversation_is_refused_and_left_untouched() -> None:
    x = only(await run(["IND-SEC-006"]), "IND-SEC-006")
    assert x.status == "passed", (x.status, x.failed_assertions, x.error)


async def t_the_trace_is_closed_to_other_users() -> None:
    r = await run(["IND-SEC-006"])
    x = only(r, "IND-SEC-006")
    trace = json.loads((r.out / x.trace_artifact).read_text())
    assert trace["intruder_trace_status"] == 403, trace


async def t_the_only_way_out_is_the_allowlisted_provider_through_the_proxy() -> None:
    import socket
    def direct(host: str, port: int) -> bool:
        try:
            socket.create_connection((host, port), 3).close()
            return True
        except OSError:
            return False

    def tunnel(host: str) -> str:
        with socket.create_connection(("eval-egress-proxy", 3128), 8) as c:
            c.sendall(f"CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n".encode())
            return c.recv(200).split(b"\r\n", 1)[0].decode()
    assert not direct("1.1.1.1", 443) and not direct("api.openai.com", 443), "the stack must have no direct route to the internet"
    assert not direct("host.docker.internal", 8010) and not direct("insurance-tenant-service", 8001), "no route to the host or to production"
    assert "200" in tunnel("api.openai.com"), "the provider is reachable through the proxy"
    for blocked in ("example.com", "localhost", "169.254.169.254"):
        assert "403" in tunnel(blocked), f"{blocked} must be refused by the proxy"


async def t_an_infrastructure_error_is_retried_but_a_verdict_is_not() -> None:
    bundle = eval_runner.bundle_from_source()
    selected, _ = select_cases(bundle.cases, case_ids=["IND-LEAD-001", "IND-AGT-001"])
    runner = eval_runner.Runner(bundle, args(retries=2))
    calls = {"IND-LEAD-001": 0, "IND-AGT-001": 0}

    async def fake(case, repetition):
        calls[case["case_id"]] += 1
        if case["case_id"] == "IND-LEAD-001":
            return runner._make(case, repetition, "infrastructure_error" if calls[case["case_id"]] < 3 else "passed", "timeout")
        return runner._make(case, repetition, "failed", "layer_failed:L3")       # a verdict: never run again
    runner._execute_once = fake
    for c in selected:
        await runner.execute_one(c, 1)
    assert calls == {"IND-LEAD-001": 3, "IND-AGT-001": 1}, calls
    done = {r.case_id: r for r in runner.results}
    assert done["IND-LEAD-001"].status == "passed" and done["IND-LEAD-001"].attempts == 3 and done["IND-AGT-001"].attempts == 1
    assert len(runner.results) == 2, "only the final answer of each case is recorded"


async def t_every_repetition_gets_a_new_thread_and_a_clean_database() -> None:
    r = await run(["IND-LEAD-001"], repeat=3)
    xs = [only(r, "IND-LEAD-001", n) for n in (1, 2, 3)]
    assert [x.status for x in xs] == ["passed"] * 3, [(x.status, x.failed_assertions) for x in xs]
    threads = {json.loads((r.out / x.trace_artifact).read_text())["thread_id"] for x in xs}
    assert len(threads) == 3, threads                       # a new conversation each time
    # Each saved exactly one new customer: had the first repetition's lead survived, a later one would have found a duplicate and
    # stopped to ask, and `state.new_customers == 1` would not hold three times.


async def t_a_real_model_without_a_key_blocks_chat_cases_and_calls_nothing() -> None:
    async with httpx.AsyncClient() as c:
        await c.post(f"{MOCK}/__eval/reset")
    bundle = eval_runner.bundle_from_source()
    selected, _ = select_cases(bundle.cases, case_ids=["IND-LEAD-001", "IND-AGT-001"])
    r = eval_runner.Runner(bundle, args(model="openai/gpt-4o-mini"))
    r.providers = set()                                     # whatever key the environment has, this run has none
    await r.run(selected)
    assert [(x.status, x.reason) for x in r.results] == [("blocked", "blocked_missing_credentials")] * 2, [(x.status, x.reason) for x in r.results]
    assert not await mock_log(), "nothing was sent to any model"


async def t_a_chat_case_without_a_model_is_skipped_never_passed() -> None:
    r = await run(["IND-LEAD-001"], model=None)
    assert [(x.status, x.reason) for x in r.results] == [("skipped", "no_chat_model_selected")]


async def t_events_describe_the_run_in_order() -> None:
    r = await run(["IND-LEAD-001", "IND-AGT-001"])
    events = [json.loads(l) for l in (r.out / "events.jsonl").read_text().splitlines()]
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    kinds = [e["kind"] for e in events]
    assert kinds.count("case") == 2 and kinds.count("progress") == 2 and "state" in kinds
    assert events[-1]["kind"] == "progress" and events[-1]["data"]["executions"] == 2 and events[-1]["data"]["by_status"] == {"passed": 2}


async def t_the_judge_service_scores_every_metric_and_refuses_a_real_provider_without_a_key() -> None:
    url = eval_runner.JUDGE_URL
    async with httpx.AsyncClient(timeout=120) as c:
        for metric in ("correctness", "task_completion", "safety", "custom", "relevance", "faithfulness", "hallucination"):
            req = {"criterion_id": "S", "metric": metric, "criterion": "States that the lead was recorded.", "threshold": 0.7, "input": "Record a lead",
                   "actual_output": "Lead recorded.", "expected_output": "The lead is recorded.", "context": ["A lead is a prospect."], "tools_called": ["record_lead"],
                   "judge_model": "mock/mock-judge"}
            good = (await c.post(f"{url}/score", json=req)).json()
            bad = (await c.post(f"{url}/score", json={**req, "actual_output": "Okay."})).json()
            assert good["status"] == "scored" and good["score"] >= 0.7 and good["input_tokens"] > 0, (metric, good)
            assert bad["status"] == "scored" and bad["score"] < 0.7, (metric, bad)
        blocked = (await c.post(f"{url}/score", json={**req, "judge_model": "anthropic/claude-haiku-4-5"})).json()      # no key for this provider in any configuration
        assert blocked["status"] == "blocked_missing_credentials" and "score" not in blocked, blocked


async def t_a_prompt_version_that_does_not_exist_is_refused_before_anything_runs() -> None:
    try:
        eval_runner.prompt_pin("no-such-version")
    except ValueError:
        pass
    else:
        raise AssertionError("an unknown prompt version was accepted")
    pinned = eval_runner.prompt_pin("concise-v1")
    assert pinned == hashlib.sha256(Path("/work/evals/prompts/concise-v1.json").read_bytes()).hexdigest()
    for bad in ("../x", "a b", ""):
        try:
            assert eval_runner.prompt_pin(bad) is None if not bad else eval_runner.prompt_pin(bad)
        except ValueError:
            continue
        if bad:
            raise AssertionError(f"{bad!r} was accepted")


async def t_what_a_failed_attempt_spent_is_kept_with_the_final_result() -> None:
    """An attempt that fails with an infrastructure error may already have asked a model for something. That was paid for: it travels with the result that
    follows the retry (`retry_usage`), and the cost lines record it as the run's own `retry` spending."""
    bundle = eval_runner.bundle_from_source()
    selected, _ = select_cases(bundle.cases, case_ids=["IND-LEAD-001"])
    runner = eval_runner.Runner(bundle, args(retries=2))
    spent = {"status": "attributed", "calls": 1, "input_tokens": 900, "output_tokens": 0, "cached_tokens": 0, "by_model": {"gpt-4o-mini": {"calls": 1, "input_tokens": 900, "output_tokens": 0, "cached_tokens": 0}}}
    attempts = []

    async def fake(case, repetition):
        attempts.append(1)
        if len(attempts) < 3:
            return runner._make(case, repetition, "infrastructure_error", "timeout", usage=spent if len(attempts) == 1 else None)      # the second attempt spent nothing the ledger could see
        return runner._make(case, repetition, "passed", usage={**spent, "input_tokens": 100})
    runner._execute_once = fake
    await runner.execute_one(selected[0], 1)
    done = runner.results[0]
    assert done.status == "passed" and done.attempts == 3, (done.status, done.attempts)
    assert done.retry_usage == [spent], "the first attempt's spending is kept; an attempt with no usage adds nothing"
    row = json.loads((runner.out / "results.jsonl").read_text().splitlines()[0])
    assert row["retry_usage"] == [spent], "and it reaches results.jsonl, which is what the platform ingests"


async def t_a_failed_execution_reports_what_it_spent_before_it_failed() -> None:
    """An execution that fails mid-way (a timeout, an error from the agent) closes its ledger window unread; the runner then reads the rows the failed
    execution caused, before the next execution resets the ledger. Without that the money is spent and never recorded."""
    from shared.evaluation.chat_executor import ChatExecutionError
    from shared.evaluation.usage import UsageMeter
    bundle = eval_runner.bundle_from_source()
    selected, _ = select_cases(bundle.cases, case_ids=["IND-LEAD-001"])
    runner = eval_runner.Runner(bundle, args(retries=0, budget_usd=5.0))
    rows: List[dict] = []

    async def ledger():
        return list(rows)
    runner.meter = UsageMeter(ledger, poll_seconds=0.02, quiet_seconds=0.1, max_wait_seconds=0.6)

    class Env:
        ids: dict = {}

        async def fresh(self):
            return None
    runner.env = Env()
    original_resolve, original_chat = eval_runner.resolve_case, eval_runner.execute_chat_case

    async def failing_chat(case, rt, *, execution_id):
        await rt.meter.begin(execution_id, match=lambda r: r.get("thread_id") == "t1")
        rows.append({"id": "1", "service_name": "Chat Agent", "model_name": "mock-oracle", "input_tokens": 700, "output_tokens": 30, "cached_tokens": 0, "thread_id": "t1"})
        rt.meter.abandon()
        raise ChatExecutionError("the agent stopped answering")
    eval_runner.resolve_case, eval_runner.execute_chat_case = (lambda case, ids: case), failing_chat
    try:
        await runner.execute_one(selected[0], 1)
    finally:
        eval_runner.resolve_case, eval_runner.execute_chat_case = original_resolve, original_chat
    r = runner.results[0]
    assert r.status == "infrastructure_error" and r.usage and r.usage["status"] == "attributed" and r.usage["calls"] == 1 and r.usage["input_tokens"] == 700, r.usage
    assert r.usage["by_service"]["Chat Agent"]["mock-oracle"]["calls"] == 1, "with the service that made the call"
    nothing = await runner._settle()
    assert nothing is None, "nothing is settled twice"


async def t_the_ledger_names_the_service_behind_each_call_and_the_lines_account_for_it() -> None:
    """With the real agent in the stack: every ledger row has the name of the service that made the call, the usage groups them by service, and the cost lines
    built from the result hold exactly the tokens the ledger showed (scripted model: free, and never called a fallback)."""
    from shared.evaluation import cost_lines
    from shared.evaluation.pricing import PriceTable
    r = await run(["IND-LEAD-001"])
    x = only(r, "IND-LEAD-001")
    u = x.usage
    assert u and u["status"] == "attributed" and u["calls"] >= 1, u
    assert u["by_service"], "the usage says which service made the calls"
    assert sum(m["calls"] for models in u["by_service"].values() for m in models.values()) == u["calls"], "every call is in exactly one service"
    assert all(name.startswith("Chat Agent") for name in u["by_service"]), list(u["by_service"])
    result = x.as_dict()
    lines = cost_lines.lines_for_result(r.run_id, result, table=PriceTable.builtin(), candidate="mock/mock-oracle", mode="agent", synthetic=True)
    assert lines and all(l["cost_kind"] == "estimated" and l["usd"] == 0.0 for l in lines), "a scripted model costs nothing, and that is a known zero"
    assert not any(l["component"] == "fallback" for l in lines), "a scripted model is never a fallback"
    assert sum(l["input_units"] for l in lines) == u["input_tokens"] and sum(l["output_units"] for l in lines) == u["output_tokens"], "the lines hold exactly the tokens the ledger showed"
    print(f"        services seen: {sorted(u['by_service'])}  foreign rows: {(u.get('foreign') or {}).get('rows', 0)}")


TESTS: List[Callable] = [t_a_conversation_is_driven_observed_and_judged_in_layers, t_without_a_judge_the_case_is_decided_without_it_and_says_so,
                         t_a_lazy_agent_fails_and_the_judge_sees_the_empty_answer, t_a_reckless_agent_is_stopped_by_the_permission_gate_and_otherwise_fails_critically,
                         t_skills_and_prompt_variants_change_what_the_agent_sends_to_the_model, t_another_users_conversation_is_refused_and_left_untouched, t_the_trace_is_closed_to_other_users, t_the_only_way_out_is_the_allowlisted_provider_through_the_proxy,
                         t_an_infrastructure_error_is_retried_but_a_verdict_is_not, t_what_a_failed_attempt_spent_is_kept_with_the_final_result,
                         t_a_failed_execution_reports_what_it_spent_before_it_failed, t_the_ledger_names_the_service_behind_each_call_and_the_lines_account_for_it, t_every_repetition_gets_a_new_thread_and_a_clean_database,
                         t_a_real_model_without_a_key_blocks_chat_cases_and_calls_nothing, t_a_chat_case_without_a_model_is_skipped_never_passed,
                         t_events_describe_the_run_in_order, t_the_judge_service_scores_every_metric_and_refuses_a_real_provider_without_a_key,
                         t_a_prompt_version_that_does_not_exist_is_refused_before_anything_runs]


async def main(selected: Optional[List[str]] = None) -> int:
    failed = 0
    for test in TESTS:
        if selected and not any(s in test.__name__ for s in selected):
            continue
        started = time.monotonic()
        try:
            await test()
            status, detail = "ok", ""
        except AssertionError as exc:
            status, detail, failed = "FAIL", str(exc), failed + 1
        except Exception as exc:                  # noqa: BLE001 — an unexpected error is a failure of the test, reported as one
            status, detail, failed = "FAIL", f"{type(exc).__name__}: {exc}", failed + 1
        print(f"{status:5} {test.__name__[2:]:78} {time.monotonic() - started:5.1f}s" + (f"\n        {detail}" if detail else ""), flush=True)
    print(f"\nchat integration tests: {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:] or None)))
