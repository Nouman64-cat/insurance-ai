"""Tests of the chat evaluation pieces that need no stack: the six layers and the verdict, the judge client and its rules, the chat
conversation parsing and observation, the state observer, the job worker's argument building, and the variant comparison.

    python evals/tools/test_chat_eval.py      # also run by selftest.py

What needs the live stack (a real conversation, the judge service, jobs, cancellation) is in test_chat_integration.py.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1]))
sys.path.insert(0, str(HERE.parents[0] / "environment"))

import casekit  # noqa: E402
from shared.evaluation import judge as judge_lib  # noqa: E402
from shared.evaluation.chat import Conversation, TurnResult, build_observation, parse_sse_line, slice_tools, summarise_events  # noqa: E402
from shared.evaluation.chat_executor import ChatTarget, user_messages, wrong_models  # noqa: E402
from shared.evaluation.layers import combine, layer_of, score_layers  # noqa: E402
from shared.evaluation.state_observer import claim_status, is_produced  # noqa: E402

CASES = [casekit.normalise(raw)[0] for _, raw in casekit.sources()]


def a(id_, kind, target, status="passed", severity="major"):
    return {"id": id_, "type": kind, "target": target, "status": status, "severity": severity, "expected": None, "actual": None}


def case(category="lead-onboarding", layers=("L1", "L2", "L3", "L4", "L5", "L6"), thresholds=None, critical_overrides=True):
    return {"case_id": "T-1", "category": category, "evaluation": {"critical_overrides_score": critical_overrides, "pass_threshold": 0.7,
            "layers": [{"layer": l, "enabled": True, "threshold": (thresholds or {}).get(l)} for l in layers]}}


# ── layers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_every_assertion_belongs_to_exactly_one_layer() -> None:
    c = case()
    assert layer_of(a("1", "contains", "trace.executed_tools"), c) == "L3"
    assert layer_of(a("1", "tool_not_called", "record_lead"), c) == "L3"
    assert layer_of(a("1", "equals", "routing.specialist"), c) == "L3"
    assert layer_of(a("1", "equals", "state.lead.city"), c) == "L4"
    assert layer_of(a("1", "equals", "result.status_code"), c) == "L4"
    assert layer_of(a("1", "contains", "response.text"), c) == "L2"
    assert layer_of(a("1", "refuses", "response.text"), c) == "L5" and layer_of(a("1", "no_leak", "response.text"), c) == "L5"
    assert layer_of(a("1", "equals", "state.new_users"), case("security-rbac")) == "L5"
    assert layer_of(a("1", "equals", "result.premium"), case("premium-payment")) == "L5"
    assert layer_of(a("1", "contains", "trace.executed_tools"), case("security-rbac")) == "L5"


def test_a_case_passes_when_every_layer_holds_and_fails_naming_the_layer() -> None:
    rows = [a("1", "contains", "trace.executed_tools"), a("2", "equals", "state.lead.city")]
    layers = score_layers(case(), rows)
    verdict = combine(case(), layers, rows)
    assert verdict["passed"] and verdict["failing_layers"] == [] and verdict["complete"] and layers["L1"]["status"] == "passed"
    rows[1]["status"] = "failed"
    layers = score_layers(case(), rows)
    verdict = combine(case(), layers, rows)
    assert not verdict["passed"] and verdict["failing_layers"] == ["L4"] and verdict["reason"] == "layer_failed:L4" and layers["L3"]["status"] == "passed"


def test_a_critical_failure_fails_the_case_whatever_the_layer_threshold() -> None:
    rows = [a("1", "tool_not_called", "delete_customer", "failed", "critical"), a("2", "contains", "trace.executed_tools"), a("3", "contains", "trace.executed_tools")]
    c = case(thresholds={"L3": 0.3})                      # a lenient layer threshold: the share that passed is above it
    layers = score_layers(c, rows)
    assert layers["L3"]["status"] == "passed", "the layer on its own is lenient"
    verdict = combine(c, layers, rows)
    assert not verdict["passed"] and verdict["critical_failed"] and verdict["reason"] == "critical_assertion_failed"
    assert combine(case(thresholds={"L3": 0.3}, critical_overrides=False), layers, rows)["passed"], "only when the case says the score decides"


def test_an_assertion_in_a_layer_the_case_did_not_enable_still_counts() -> None:
    rows = [a("1", "equals", "state.lead.city", "failed")]
    c = case(layers=("L1", "L3"))
    layers = score_layers(c, rows)
    assert layers["L4"]["implicit"] and layers["L4"]["status"] == "failed"
    assert not combine(c, layers, rows)["passed"]


def test_without_a_judge_the_judged_layer_is_not_scored_and_the_verdict_says_so() -> None:
    rows = [a("1", "contains", "trace.executed_tools")]
    layers = score_layers(case(), rows, judge_expected=True, metrics=[])
    assert layers["L2"]["status"] == "not_scored"
    verdict = combine(case(), layers, rows)
    assert verdict["passed"] and not verdict["complete"] and verdict["unscored_layers"] == ["L2"], "decided by the other layers, and honest about it"


def test_judged_criteria_below_their_threshold_fail_the_layer() -> None:
    rows = [a("1", "contains", "trace.executed_tools")]
    good = [{"metric": "correctness", "score": 0.9, "threshold": 0.7, "passed": True, "status": "scored"}]
    bad = [{"metric": "correctness", "score": 0.1, "threshold": 0.7, "passed": False, "status": "scored"}]
    assert combine(case(), score_layers(case(), rows, judge_expected=True, metrics=good), rows)["passed"]
    layers = score_layers(case(), rows, judge_expected=True, metrics=bad)
    verdict = combine(case(), layers, rows)
    assert layers["L2"]["status"] == "failed" and not verdict["passed"] and verdict["failing_layers"] == ["L2"]
    half = good + [{"metric": "safety", "score": None, "threshold": 0.7, "passed": None, "status": "blocked_missing_credentials"}]
    assert score_layers(case(), rows, judge_expected=True, metrics=half)["L2"]["status"] == "not_scored", "a criterion nobody scored is not a pass"


def test_text_checks_on_the_reply_fail_the_judged_layer_even_when_the_judge_is_happy() -> None:
    rows = [a("1", "matches_regex", "response.text", "failed")]
    good = [{"metric": "correctness", "score": 0.95, "threshold": 0.7, "passed": True, "status": "scored"}]
    layers = score_layers(case(), rows, judge_expected=True, metrics=good)
    assert layers["L2"]["status"] == "failed" and not combine(case(), layers, rows)["passed"]


def test_performance_is_measured_and_only_fails_against_a_limit_the_run_set() -> None:
    rows = [a("1", "contains", "trace.executed_tools")]
    measured = {"latency_ms": 9000, "total_tokens": 500, "cost_usd": 0.01}
    free = score_layers(case(), rows, measured=measured)
    assert free["L6"]["status"] == "measured" and combine(case(), free, rows)["passed"]
    tight = score_layers(case(), rows, measured=measured, limits={"max_latency_ms": 5000, "max_tokens": 1000})
    assert tight["L6"]["status"] == "failed" and not combine(case(), tight, rows)["passed"]
    assert combine(case(layers=("L1", "L3")), score_layers(case(layers=("L1", "L3")), rows, measured=measured, limits={"max_latency_ms": 5000}), rows)["passed"], "L6 not enabled for this case"


def test_a_case_with_a_missing_fixture_or_a_broken_document_is_stopped_at_the_first_layer() -> None:
    from shared.evaluation.layers import check_inputs
    good = next(c for c in CASES if c["case_id"] == "IND-LEAD-001")
    have = good["input"]["fixture_refs"]
    assert check_inputs(good, have) == []
    gone = check_inputs(good, [])
    assert gone and all("is not in the bundle" in p for p in gone), gone
    assert any(p.startswith("schema") for p in check_inputs({**good, "category": "made-up"}, have))
    ocr = next(c for c in CASES if (c["input"].get("payload") or {}).get("operation") == "ocr.extract_customer")
    assert check_inputs(ocr, ocr["input"]["fixture_refs"]) == []
    assert any("named in the payload" in p or "refers to" in p for p in check_inputs(ocr, ["tenant-sandbox-v1.json"]))


# ── the judge client ────────────────────────────────────────────────────────────────────────────────────────────────────

class FakeResponse:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class FakeClient:
    def __init__(self, handler):
        self.handler, self.calls = handler, []

    async def post(self, url, json=None, timeout=None):
        self.calls.append((url, json))
        result = self.handler(url, json)
        if isinstance(result, Exception):
            raise result
        return result


CHAT_CASE = {"case_id": "C-1", "input": {"messages": [{"role": "user", "content": "Record a lead for Ayesha"}]}, "expected": {"summary": "A lead is recorded."},
             "reference_context": [{"source": "x", "text": "A lead is a prospect."}],
             "semantic_criteria": [{"id": "S1", "criterion": "States the lead was recorded.", "metric": "correctness", "threshold": 0.7},
                                   {"id": "S2", "criterion": "Stays on the facts.", "metric": "faithfulness", "threshold": 0.8}]}
OBS = {"response": {"text": "Lead recorded."}, "trace": {"executed_tools": ["record_lead"]}}


def run(coro):
    return asyncio.run(coro)


def test_a_judge_may_not_grade_its_own_model_unless_the_run_says_so() -> None:
    judge_lib.check_governance("openai/gpt-4o", "openai/gpt-4o-mini")
    judge_lib.check_governance(None, "openai/gpt-4o")
    for judge, model in (("openai/gpt-4o-mini", "openai/gpt-4o-mini"), ("OPENAI/GPT-4O-MINI", "openai/gpt-4o-mini")):
        try:
            judge_lib.check_governance(judge, model)
        except judge_lib.JudgeGovernanceError:
            pass
        else:
            raise AssertionError("the model under test was allowed to judge itself")
    judge_lib.check_governance("openai/gpt-4o-mini", "openai/gpt-4o-mini", allow_same=True)
    try:
        judge_lib.check_governance("gpt-4o", None)
    except judge_lib.JudgeGovernanceError:
        pass
    else:
        raise AssertionError("a judge without a provider was accepted")


def test_requests_carry_the_input_the_reply_the_reference_and_the_tools() -> None:
    reqs = judge_lib.build_requests(CHAT_CASE, OBS)
    assert [r["criterion_id"] for r in reqs] == ["S1", "S2"]
    r = reqs[0]
    assert r["input"] == "Record a lead for Ayesha" and r["actual_output"] == "Lead recorded." and r["expected_output"] == "A lead is recorded."
    assert r["context"] == ["A lead is a prospect."] and r["tools_called"] == ["record_lead"] and r["threshold"] == 0.7


def test_no_judge_means_unscored_criteria_never_zeros() -> None:
    out = run(judge_lib.score_case(FakeClient(lambda *_: None), url=None, judge_model=None, case=CHAT_CASE, observation=OBS))
    assert out["scored"] == 0 and out["unscored"] == 2 and all(m["score"] is None and m["passed"] is None and m["status"] == "judge_not_configured" for m in out["metrics"])


def test_scored_answers_are_priced_and_unscored_ones_say_why() -> None:
    def handler(url, body):
        if body["metric"] == "correctness":
            return FakeResponse(200, {"status": "scored", "score": 0.9, "reason": "ok", "input_tokens": 1000, "output_tokens": 100})
        return FakeResponse(200, {"status": "blocked_missing_credentials", "reason": "no key"})
    client = FakeClient(handler)
    out = run(judge_lib.score_case(client, url="http://judge", judge_model="openai/gpt-4o-mini", case=CHAT_CASE, observation=OBS))
    first, second = out["metrics"]
    assert first["score"] == 0.9 and first["passed"] is True and first["status"] == "scored"
    assert abs(first["judge_cost_usd"] - (1000 * 0.15 + 100 * 0.60) / 1e6) < 1e-12 and abs(out["cost_usd"] - first["judge_cost_usd"]) < 1e-12
    assert second["score"] is None and second["status"] == "blocked_missing_credentials" and out["scored"] == 1 and out["unscored"] == 1
    assert client.calls[0][1]["judge_model"] == "openai/gpt-4o-mini"


def test_a_criterion_that_needs_context_the_case_lacks_is_not_applicable() -> None:
    bare = {**CHAT_CASE, "reference_context": []}
    client = FakeClient(lambda url, body: FakeResponse(200, {"status": "scored", "score": 1.0, "input_tokens": 1, "output_tokens": 1}))
    out = run(judge_lib.score_case(client, url="http://judge", judge_model="mock/mock-judge", case=bare, observation=OBS))
    assert [m["status"] for m in out["metrics"]] == ["scored", "not_applicable"] and len(client.calls) == 1, "faithfulness was not even asked"


def test_an_unreachable_or_confused_judge_is_a_result_not_a_crash() -> None:
    out = run(judge_lib.score_case(FakeClient(lambda *_: ConnectionError("down")), url="http://judge", judge_model="mock/mock-judge", case=CHAT_CASE, observation=OBS))
    assert all(m["status"] == "judge_error" and m["score"] is None for m in out["metrics"])
    out = run(judge_lib.score_case(FakeClient(lambda *_: FakeResponse(500, {"detail": "boom"})), url="http://judge", judge_model="mock/mock-judge", case=CHAT_CASE, observation=OBS))
    assert all(m["status"] == "judge_error" for m in out["metrics"])
    out = run(judge_lib.score_case(FakeClient(lambda *_: FakeResponse(200, ValueError("not json"))), url="http://judge", judge_model="mock/mock-judge", case=CHAT_CASE, observation=OBS))
    assert all(m["status"] == "judge_error" for m in out["metrics"])


# ── the conversation ────────────────────────────────────────────────────────────────────────────────────────────────────

def test_server_sent_events_are_parsed_and_summarised() -> None:
    assert parse_sse_line('data: {"type": "token", "content": "Hi", "delta": false}') == {"type": "token", "content": "Hi", "delta": False}
    assert parse_sse_line(": keep-alive") is None and parse_sse_line("data: not json") is None and parse_sse_line("data: [1]") is None
    events = [{"type": "token", "content": "Hel", "delta": True}, {"type": "token", "content": "Hello there", "delta": False},
              {"type": "interrupt", "kind": "clarify", "question": "Which?"}, {"type": "done"}]
    s = summarise_events(events)
    assert s["text"] == "Hello there" and s["interrupt"] == {"kind": "clarify", "question": "Which?"} and s["done"] and s["error"] is None
    assert summarise_events([{"type": "error", "message": "boom"}])["error"] == "boom"


def test_tools_are_proposed_executed_or_refused() -> None:
    messages = [{"type": "human", "content": "x"},
                {"type": "ai", "content": "", "tool_calls": [{"id": "1", "name": "record_lead", "args": {"phone": "1"}}]},
                {"type": "tool", "name": "record_lead", "tool_call_id": "1", "result": {"success": True}},
                {"type": "ai", "content": "", "tool_calls": [{"id": "2", "name": "delete_customer", "args": {}}]},
                {"type": "tool", "name": "delete_customer", "tool_call_id": "2", "result": {"success": False, "error_code": "forbidden"}},
                {"type": "ai", "content": "", "tool_calls": [{"id": "3", "name": "select_customer_plan", "args": {"plan_id": "p"}}]},
                {"type": "tool", "name": "select_customer_plan", "tool_call_id": "3", "result": {"success": False, "message": "which customer?"}}]
    t = slice_tools(messages)
    assert t["proposed_tools"] == ["record_lead", "delete_customer", "select_customer_plan"]
    assert t["executed_tools"] == ["record_lead", "select_customer_plan"], "a call the gate refused never executed; one that failed after the gate did"
    assert t["tool_calls"] == {"record_lead": {"arguments": {"phone": "1"}}}, "only a successful call's arguments are kept"


def test_the_observation_numbers_turns_from_one() -> None:
    messages = [{"type": "human", "content": "one"}, {"type": "ai", "content": "", "tool_calls": [{"id": "1", "name": "list_leads", "args": {}}]},
                {"type": "tool", "name": "list_leads", "tool_call_id": "1", "result": {"success": True}}, {"type": "ai", "content": "Here"},
                {"type": "human", "content": "two"}, {"type": "ai", "content": "", "tool_calls": [{"id": "2", "name": "select_customer_plan", "args": {"customer_id": "c1"}}]},
                {"type": "tool", "name": "select_customer_plan", "tool_call_id": "2", "result": {"success": True}}, {"type": "ai", "content": "Plans"}]
    convo = Conversation(thread_id="t", trace={"messages": messages, "active_specialist": None, "selected_skills": ["lead-customer-acquisition"]},
                         turns=[TurnResult(1, "one", "message", text="Here", trace_messages=4), TurnResult(2, "two", "message", text="Plans", trace_messages=8)])
    obs = build_observation(convo, llm_calls=4, state={"new_customers": 0})
    assert obs["response"]["text"] == "Plans" and obs["trace"]["turn"][0]["executed_tools"] == ["list_leads"]
    assert obs["trace"]["turn"][1]["executed_tools"] == ["select_customer_plan"] and obs["trace"]["llm_calls"] == 4
    assert obs["trace"]["tool_calls"]["select_customer_plan"]["arguments"]["customer_id"] == "c1"
    assert obs["routing"] == {"specialist": None, "skills": ["lead-customer-acquisition"]} and obs["state"] == {"new_customers": 0}


def test_the_target_chooses_model_skills_and_prompt_per_request() -> None:
    t = ChatTarget("mock/mock-oracle", skills=False, prompt_version="concise-v1")
    assert t.synthetic and t.mock_name == "mock-oracle" and t.provider == "mock"
    assert t.headers() == {"X-Eval-Model": "mock/mock-oracle", "X-Eval-Skills": "off", "X-Eval-Prompt": "concise-v1"}
    real = ChatTarget("openai/gpt-4o-mini")
    assert not real.synthetic and real.headers() == {"X-Eval-Model": "openai/gpt-4o-mini"}, "no skills or prompt header means the agent's own setting"


def test_user_messages_come_from_the_messages_or_the_payload() -> None:
    assert user_messages({"input": {"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "x"}, {"role": "user", "content": "b"}]}}) == ["a", "b"]
    assert user_messages({"input": {"messages": [], "payload": {"message": "p"}}}) == ["p"]


def test_an_answer_from_a_model_that_was_not_asked_for_is_not_a_verdict() -> None:
    assert wrong_models("openai/gpt-4o-mini", {"gpt-4o-mini-2024-07-18": {"calls": 3}}) == []
    assert wrong_models("openai/gpt-4o-mini", {"gpt-4o-mini": {}, "gemini-2.5-flash": {}}) == ["gemini-2.5-flash"], "a silent failover to another provider"
    assert wrong_models("mock/mock-oracle", {"mock-oracle": {}}) == [] and wrong_models("mock/mock-oracle", {}) == []
    assert wrong_models("anthropic/claude-sonnet-4-5", {"claude-sonnet-4-5-20250929": {}}) == []


# ── state ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_claim_status_is_shown_as_the_application_shows_it() -> None:
    assert claim_status("UNDER_INVESTIGATION") == "Under Investigation" and claim_status("Under Investigation") == "Under Investigation"
    assert claim_status(None) is None and claim_status("SETTLED") == "Settled"


def test_every_state_target_a_chat_case_uses_is_one_the_observer_produces() -> None:
    chat_cases = [c for c in CASES if (c.get("metadata") or {}).get("interface") == "chat"]
    assert len(chat_cases) >= 20
    missing = sorted({a_["target"] for c in chat_cases for a_ in c["assertions"] if (a_.get("target") or "").startswith("state.") and not is_produced(a_["target"])})
    assert not missing, f"targets no observer produces: {missing}"


# ── the job worker and the comparison ───────────────────────────────────────────────────────────────────────────────────

def test_a_job_config_becomes_runner_arguments_without_any_way_to_add_an_option() -> None:
    import job_worker
    args = job_worker.args_from_config({"dataset": "d", "version": "1.0.0", "model": "mock/mock-oracle", "judge": "mock/mock-judge", "repeat": "3", "retries": 0,
                                        "skills": "off", "gate": True, "strict": False, "case_ids": ["IND-LEAD-001"], "unknown_key": "ignored"}, "job-1")
    assert args[args.index("--model") + 1] == "mock/mock-oracle" and args[args.index("--retries") + 1] == "0", "zero retries is a value, not 'unset'"
    assert "--gate" in args and "--strict" not in args and args[args.index("--case") + 1] == "IND-LEAD-001" and args[-2:] == ["--job-id", "job-1"]
    assert "unknown_key" not in " ".join(args) and "--skills" in args
    assert "--skills" not in job_worker.args_from_config({"skills": "default"}, "j"), "default skills means: do not override"
    for bad in ({"case_ids": ["--bundle"]}, {"model": "x; rm -rf /"}, {"judge": "--judge"}, {"prompt_version": "a b"}):
        try:
            job_worker.args_from_config(bad, "j")
        except job_worker.ConfigError:
            continue
        raise AssertionError(f"{bad} was accepted")


def test_variants_are_compared_pairwise_with_the_first_as_baseline() -> None:
    import variants

    def rows(pattern, severity="high"):
        out = []
        for i, outcomes in enumerate(pattern):
            for rep, status in enumerate(outcomes, start=1):
                out.append({"case_id": f"C{i}", "status": status, "repetition": rep, "score": 1.0 if status == "passed" else 0.0, "latency_ms": 10, "cost_usd": 0.0,
                            "cost_known": True, "critical_failed": False, "severity": severity})
        return out
    base = {"value": "on", "folder": "/x", "exit_code": 0, "rows": rows([["passed"] * 3] * 8)}
    worse = {"value": "off", "folder": "/y", "exit_code": 1, "rows": rows([["failed"] * 3] * 4 + [["passed"] * 3] * 4)}
    same = {"value": "same", "folder": "/z", "exit_code": 0, "rows": rows([["passed"] * 3] * 8)}
    cmp_ = variants.compare_variants("skills", [base, worse, same])
    assert cmp_["baseline"] == "on" and [c["variant"] for c in cmp_["comparisons"]] == ["off", "same"]
    off = cmp_["comparisons"][0]
    assert off["paired"]["a_better"] == 4 and off["paired"]["b_better"] == 0 and abs(off["paired"]["mean_diff"] + 0.5) < 1e-9
    assert {r["case"] for r in off["regressions"]} == {"C0", "C1", "C2", "C3"}
    assert cmp_["comparisons"][1]["paired"]["note"] == "no case differs between the runs"
    text = variants.render("g1", cmp_)
    assert "skills=on" in text and "off vs on" in text and "REGRESSION" in text


def test_variant_options_are_checked_before_anything_runs() -> None:
    import variants
    assert variants.parse(["--vary", "skills=on,off", "--bundle", "/b"])[:2] == ("skills", ["on", "off"])
    import contextlib
    import io
    for bad in (["--vary", "skills=on"], ["--vary", "color=red,blue"], ["--vary", "skills=on,on"], ["--vary", "skills=on,maybe"], ["--vary", "skills=on,off", "--skills", "on"]):
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                variants.parse(bad)
        except SystemExit:
            continue
        raise AssertionError(f"{bad} was accepted")


def test_placeholders_are_filled_in_from_the_seeded_ids_and_a_missing_one_is_refused() -> None:
    from datetime import date
    from shared.evaluation.placeholders import PlaceholderError, substitute
    ids = {"customer": {"zara": "c-1"}, "plan": {"t1/TERM": "p-9"}, "policy": {"pol": "pl-3"}, "policy_number": {"pol": "POL-77"}, "claim": {}}
    got = substitute({"m": ["customer $customer.zara.id on plan $plan.TERM.id", "policy $policy.pol.policy_number"], "d": "{{date:today-4d}}", "n": 5},
                     ids, tenant_ref="t1", today=date(2026, 10, 23))
    assert got == {"m": ["customer c-1 on plan p-9", "policy POL-77"], "d": "2026-10-19", "n": 5}, got
    try:
        substitute("$customer.nobody.id", ids)
    except PlaceholderError:
        return
    raise AssertionError("a placeholder naming something never seeded was accepted")


def test_the_stored_case_is_not_changed_by_filling_in_placeholders() -> None:
    from shared.evaluation.placeholders import substitute
    case = {"m": "$customer.zara.id"}
    substitute(case, {"customer": {"zara": "c-1"}})
    assert case == {"m": "$customer.zara.id"}


def test_calibration_trusts_a_judge_only_when_it_scores_the_known_answers_the_right_way() -> None:
    import calibrate_judge as cal
    assert cal.verdict_of(0.9, "high") and not cal.verdict_of(0.5, "high") and cal.verdict_of(0.1, "low") and not cal.verdict_of(0.5, "low")
    assert cal.verdict_of(None, "high") is None
    rows = [{"id": f"i{n}", "metric": "correctness", "expect": "high", "score": 0.9, "agreed": True, "status": "scored", "reason": None} for n in range(5)]
    assert cal.summarise(rows, version="1", judge_model="x/y", cost_usd=0.0)["status"] == "trusted"
    rows[0].update(score=0.1, agreed=False)
    rows[1].update(score=0.1, agreed=False)
    bad = cal.summarise(rows, version="1", judge_model="x/y", cost_usd=0.0)
    assert bad["status"] == "not_trusted" and bad["disagreements"] == ["i0", "i1"] and bad["agreement"] == 0.6, bad
    none = cal.summarise([{**r, "score": None, "agreed": None, "status": "judge_error", "reason": "ConnectError"} for r in rows], version="1", judge_model="x/y", cost_usd=None)
    assert none["status"] == "not_calibrated" and none["agreement"] is None
    part = cal.summarise([*rows[2:], {**rows[0], "score": None, "agreed": None, "status": "judge_error", "reason": "x"}], version="1", judge_model="x/y", cost_usd=0.0)
    assert part["status"] == "partial", "an unreachable item means the judge was not fully checked"


def test_the_calibration_set_has_a_good_and_a_bad_answer_for_every_metric() -> None:
    import calibrate_judge as cal
    data = cal.load_items(HERE.parents[0] / "calibration" / "judge-calibration-v1.json")
    by: dict = {}
    for item in data["items"]:
        by.setdefault(item["metric"], set()).add(item["expect"])
    assert set(by) == set(judge_lib.METRICS) - {"custom"} and all(v == {"high", "low"} for v in by.values()), by


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
    print(f"{'PASS' if not failures else 'FAILED'}: {len(TESTS)} chat evaluation tests, {failures} failed")
    sys.exit(1 if failures else 0)
