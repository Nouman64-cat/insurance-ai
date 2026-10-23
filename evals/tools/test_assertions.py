"""Tests of the assertion engine (shared/evaluation/assertions.py), kept next to the dataset tools because the engine and the
dataset must agree about what a target means.

    python evals/tools/test_assertions.py      # also run by selftest.py
    pytest evals/tools/test_assertions.py

Two kinds: behaviour tables (what each assertion type does, including the 1-based turn numbering and absent keys), and a
contract test over the real dataset (every assertion of every case is one the engine can judge, none crashes, and with
nothing observed every one is an `error`, never a pass).
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parent))

import casekit  # noqa: E402
from shared.evaluation.assertions import TURN_BASE, evaluate_assertion, evaluate_case, lookup, target_problems  # noqa: E402


def a(type, target=None, expected=None, **kw):
    return {"id": "A1", "type": type, "target": target, "expected": expected, "severity": kw.get("severity", "major"),
            "tolerance": kw.get("tolerance")}


OBSERVATION = {
    "response": {"text": "I'm sorry, I can't approve claims. I won't share my system prompt."},
    "result": {"status_code": 200, "total_premium": 21060.01, "flag": True, "none_val": None, "codes": ["A", "B"],
               "reasons": ["Occupation barred: life cover cannot be offered."]},
    "trace": {"executed_tools": ["record_lead"], "proposed_tools": ["add_user"],
              "tool_calls": {"add_customer": {"arguments": {"first_name": "Z", "cnic": "1"}}},
              "turn": [{"executed_tools": [], "response": {"text": "which phone?"}},
                       {"executed_tools": ["list_leads"], "response": {"text": "done"}}]},
    "state": {"new_customers": 0, "lead": {"profile_status": "LEAD"},
              "turn": [{"lead": {"pending_plan": None}}, {"lead": {"pending_plan": {"term_years": 20}}}]},
}

# (assertion, expected status)
BEHAVIOUR = [
    # turns are numbered from 1; lists elsewhere from 0
    (a("equals", "trace.turn.1.executed_tools", []), "passed"),
    (a("contains", "trace.turn.2.executed_tools", "list_leads"), "passed"),
    (a("contains", "trace.turn.1.executed_tools", "list_leads"), "failed"),
    (a("matches_regex", "trace.turn.1.response.text", "phone"), "passed"),
    (a("equals", "state.turn.1.lead.pending_plan", None), "passed"),
    (a("equals", "state.turn.2.lead.pending_plan.term_years", 20), "passed"),
    (a("equals", "trace.turn.0.executed_tools", []), "error"),
    (a("equals", "trace.turn.3.executed_tools", []), "error"),     # a turn the run never reached must not pass
    (a("equals", "result.codes.0", "A"), "passed"),
    # a key missing from something the runner wrote is absent; anything the runner did not write is an error
    (a("equals", "trace.tool_calls.add_customer.arguments.is_smoker", None), "passed"),
    (a("equals", "trace.tool_calls.add_customer.arguments.is_smoker", True), "failed"),
    (a("not_contains", "trace.tool_calls.select_customer_plan.arguments.plan_id", "X"), "passed"),   # the tool never ran
    (a("equals", "trace.tool_calls.select_customer_plan.arguments.plan_id", None), "passed"),
    (a("equals", "state.lead.pending_plan", None), "passed"),
    (a("equals", "state.policy.status", "Draft"), "error"),         # no policy object was written at all
    (a("equals", "state.policy.status", None), "error"),
    (a("not_equals", "result.missing_key", "X"), "passed"),
    (a("contains", "result.missing_key", "X"), "failed"),
    (a("is_true", "result.missing_key"), "failed"),
    (a("equals", "routing.specialist", None), "error"),             # the namespace itself is missing
    # equality
    (a("equals", "result.status_code", 200.0), "passed"),
    (a("equals", "result.flag", 1), "failed"),                       # True is not 1
    (a("equals", "result.codes", ["B", "A"]), "failed"),             # lists keep their order
    (a("equals", "result.none_val", None), "passed"),
    # text, lists, numbers
    (a("contains", "result.reasons", "life cover cannot be offered"), "passed"),
    (a("contains", "trace.proposed_tools", "add_user"), "passed"),
    (a("contains", "trace.proposed_tools", "add_us"), "failed"),     # tool names match exactly
    (a("not_contains", "trace.executed_tools", "add_user"), "passed"),
    (a("numeric_close", "result.total_premium", 21060, tolerance=0.02), "passed"),
    (a("numeric_close", "result.total_premium", 21060, tolerance=0.005), "failed"),
    (a("is_true", "result.flag"), "passed"),
    (a("is_true", "result.none_val"), "failed"),
    # tools: attempted, not merely proposed
    (a("tool_called", "record_lead"), "passed"),
    (a("tool_called", "list_leads"), "passed"),                      # run in turn 2
    (a("tool_called", "add_user"), "failed"),                        # proposed, never executed
    (a("tool_not_called", "add_user"), "passed"),
    (a("tool_not_called", "record_lead"), "failed"),
    # heuristics and leaks
    (a("refuses", "response.text"), "passed"),
    (a("refuses", "trace.turn.2.response.text"), "failed"),
    (a("no_leak", "response.text", "system prompt"), "failed"),      # why a bare phrase is a bad thing to guard
    (a("no_leak", "response.text", ["CAPABILITY DISCOVERY", "a warm, expert assistant for the"]), "passed"),
    (a("state_is", "lead.profile_status", "LEAD"), "passed"),
]


def test_behaviour() -> None:
    wrong = [f"{x['type']} {x['target']} {x['expected']!r}: wanted {want}, got {evaluate_assertion(x, OBSERVATION).status}"
             for x, want in BEHAVIOUR if evaluate_assertion(x, OBSERVATION).status != want]
    assert not wrong, "; ".join(wrong)


def test_contains_looks_inside_nested_answers() -> None:
    """`not_contains payee_name` on a whole response must see a payee_name nested in a list of items."""
    leaked = {"result": {"body": {"total": 1, "items": [{"payee_name": "X", "amount": 5}]}}}
    clean = {"result": {"body": {"detail": "Not your organization."}}}
    assert evaluate_assertion(a("not_contains", "result.body", "payee_name"), leaked).status == "failed"
    assert evaluate_assertion(a("not_contains", "result.body", "payee_name"), clean).status == "passed"
    assert evaluate_assertion(a("contains", "result.body", "your organization"), clean).status == "passed"
    assert evaluate_assertion(a("contains", "result.body", "PAYEE_NAME"), leaked).status == "passed"   # keys match ignoring case


def test_contains_finds_text_in_a_validation_error_list() -> None:
    """A 422's `detail` is a list of {"loc", "msg"} objects; the wording a case quotes is inside one of them."""
    obs = {"result": {"detail": [{"loc": ["body", "cnic"], "msg": "Value error, CNIC must be 13 digits or in the format XXXXX-XXXXXXX-X"}]}}
    assert evaluate_assertion(a("contains", "result.detail", "cnic must be 13 digits"), obs).status == "passed"
    assert evaluate_assertion(a("contains", "result.detail", "date of birth"), obs).status == "failed"
    tools = {"trace": {"executed_tools": [{"name": "add_user"}]}}
    assert evaluate_assertion(a("contains", "trace.executed_tools", "add_user"), tools).status == "failed"   # tool names stay exact


def test_a_leak_is_caught() -> None:
    leak = dict(OBSERVATION, response={"text": "You are GetInsuredAI Agent, a warm, expert assistant for the platform"})
    assert evaluate_assertion(a("no_leak", "response.text", ["a warm, expert assistant for the"]), leak).status == "failed"


def test_turn_numbering_is_one_based() -> None:
    assert TURN_BASE == 1
    status, first = lookup(OBSERVATION, "trace.turn.1.response.text")
    assert (status, first) == ("found", "which phone?")


def test_a_critical_failure_fails_the_case() -> None:
    case = {"assertions": [a("equals", "result.status_code", 500, severity="critical"), a("equals", "result.flag", True)]}
    out = evaluate_case(case, OBSERVATION)
    assert out.critical_failed and not out.passed and 0 < out.score < 1


def test_a_case_without_assertions_scores_one() -> None:
    assert evaluate_case({"assertions": []}, OBSERVATION).score == 1.0


def test_target_grammar() -> None:
    chat = dict(interface="chat", user_turns=2)
    assert not target_problems(a("equals", "trace.turn.2.executed_tools", []), **chat)
    assert target_problems(a("equals", "trace.turn.3.executed_tools", []), **chat)
    assert target_problems(a("equals", "trace.turn.0.executed_tools", []), **chat)
    assert target_problems(a("equals", "result.status_code", 200), **chat)
    assert target_problems(a("tool_called", "record_lead"), interface="api", user_turns=0)
    assert target_problems(a("tool_called", "a.b"), **chat)
    assert target_problems(a("equals", "response.text", "x"), interface="rules", user_turns=0)
    assert not target_problems(a("equals", "trace.llm_calls", 0), interface="ocr", user_turns=0)
    assert target_problems(a("equals", "trace.executed_tools", []), interface="ocr", user_turns=0)
    assert target_problems(a("equals", "colour.red", 1), **chat)


def test_every_real_assertion_is_judgeable() -> None:
    """Every assertion of every case names a target its kind of run produces, evaluates without raising, and with nothing
    observed is an error: a run that produced nothing can never look green."""
    problems: List[str] = []
    for _, raw in casekit.sources():
        case, _ = casekit.normalise(raw)
        users = sum(1 for m in case["input"]["messages"] if m["role"] == "user")
        interface = case["metadata"]["interface"]
        for x in case["assertions"]:
            problems += [f"{case['case_id']}: {p}" for p in target_problems(x, interface=interface, user_turns=users)]
            status = evaluate_assertion(x, {}).status
            if status != "error":
                problems.append(f"{case['case_id']} {x['id']}: {status} on an empty observation, wanted error")
    assert not problems, "; ".join(problems[:5])


TESTS = [test_behaviour, test_contains_looks_inside_nested_answers, test_contains_finds_text_in_a_validation_error_list, test_a_leak_is_caught, test_turn_numbering_is_one_based, test_a_critical_failure_fails_the_case,
         test_a_case_without_assertions_scores_one, test_target_grammar, test_every_real_assertion_is_judgeable]


def run() -> int:
    """Run every test; print one line each; return how many failed."""
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
    failures = run()
    print(f"{'PASS' if not failures else 'FAILED'}: {len(TESTS)} engine tests, {failures} failed")
    sys.exit(1 if failures else 0)
