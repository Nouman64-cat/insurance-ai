"""Proves the dataset verifier can fail. Each mutation damages a copy of the real cases in one specific way and the
verifier must report exactly that problem; the untouched dataset must report none.

    python evals/tools/selftest.py

A verifier that always says PASS would be worse than none, so this is run with the dataset checks.
"""
from __future__ import annotations

import copy
import sys
from pathlib import Path
from typing import Callable, List, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

import casekit  # noqa: E402
import test_assertions  # noqa: E402
import test_benchmark  # noqa: E402
import test_chat_eval  # noqa: E402
import test_stats  # noqa: E402
import test_environment  # noqa: E402
import test_operations  # noqa: E402
import test_runner  # noqa: E402
import test_runs  # noqa: E402
import test_usage  # noqa: E402
import verify_dataset  # noqa: E402

Sources = List[Tuple[str, dict]]


def find(sources: Sources, case_id: str) -> dict:
    return next(raw for _, raw in sources if raw["case_id"] == case_id)


def m_wrong_number(s: Sources) -> None:
    find(s, "IND-PAY-001")["metadata"]["truth"][0]["expect"]["total_premium"] = 21061.0


def m_wrong_rbac(s: Sources) -> None:
    find(s, "IND-SEC-001")["metadata"]["truth"][0]["expect"] = True


def m_wrong_decision(s: Sources) -> None:
    find(s, "IND-UW-005")["metadata"]["truth"][0]["expect"] = "Auto Approve"


def m_missing_fixture(s: Sources) -> None:
    find(s, "IND-PLAN-001")["input"]["fixture_refs"].append("no-such-fixture.json")


def m_duplicate_id(s: Sources) -> None:
    s.append(("dup.json", copy.deepcopy(find(s, "IND-LEAD-001"))))


def m_same_input(s: Sources) -> None:
    clone = copy.deepcopy(find(s, "IND-LEAD-001"))
    clone["case_id"] = "IND-LEAD-099"
    s.append(("dup.json", clone))


def m_bad_enum(s: Sources) -> None:
    find(s, "IND-LEAD-001")["scenario_type"] = "wild_guess"


def m_bad_category(s: Sources) -> None:
    find(s, "IND-LEAD-001")["category"] = "not-a-category"


def m_placeholder_unflagged(s: Sources) -> None:
    find(s, "IND-PAY-001")["source"]["verification"] = "code_verified"


def m_unbacked_claim(s: Sources) -> None:
    case = find(s, "IND-LEAD-001")
    case["metadata"].pop("truth")


def m_critical_without_assertion(s: Sources) -> None:
    for a in find(s, "IND-SEC-001")["assertions"]:
        a["severity"] = "major"


def m_broken_code_ref(s: Sources) -> None:
    find(s, "IND-LEAD-001")["source"]["code_refs"].append("shared/pricing/calculator.py::no_such_function_anywhere")


def m_missing_file_ref(s: Sources) -> None:
    find(s, "IND-LEAD-001")["source"]["code_refs"].append("no/such/file.py::x")


def m_missing_interface(s: Sources) -> None:
    find(s, "IND-LEAD-001")["metadata"].pop("interface")


def m_no_multi_turn(s: Sources) -> None:
    for _, raw in s:
        if len(raw.get("messages", [])) > 1:
            raw["messages"] = raw["messages"][:1]


def m_unknown_user(s: Sources) -> None:
    find(s, "IND-LEAD-001")["user"] = "nobody-1"


def m_nan(s: Sources) -> None:
    find(s, "IND-PAY-001")["input"]["payload"]["coverage_amount"] = float("nan")


def m_unknown_oracle(s: Sources) -> None:
    find(s, "IND-LEAD-001")["metadata"]["truth"][0]["oracle"] = "not_an_oracle"


def m_missing_category(s: Sources) -> None:
    for i, (_, raw) in enumerate(s):
        if raw["case_id"] == "IND-LEAD-006":          # lead-onboarding has exactly the minimum of 6
            del s[i]
            return


def _assertion(case_id: str, s: Sources, **fields) -> None:
    find(s, case_id)["assertions"].append(fields)


def m_turn_past_the_end(s: Sources) -> None:
    for a in find(s, "IND-AGT-006")["assertions"]:
        a["target"] = a["target"].replace("turn.2", "turn.3")


def m_turn_zero_based(s: Sources) -> None:
    for a in find(s, "IND-AGT-004")["assertions"]:
        a["target"] = a["target"].replace("turn.1", "turn.0")


def m_result_in_a_chat_case(s: Sources) -> None:
    _assertion("IND-LEAD-001", s, id="A9", type="equals", target="result.status_code", expected=200)


def m_tool_in_an_api_case(s: Sources) -> None:
    _assertion("IND-PAY-001", s, id="A9", type="tool_called", target="record_lead")


def m_unbacked_no_leak(s: Sources) -> None:
    for a in find(s, "IND-SEC-004")["assertions"]:
        if a["type"] == "no_leak":
            a["expected"] = "system prompt"


def m_called_and_not_called(s: Sources) -> None:
    _assertion("IND-LEAD-001", s, id="A9", type="tool_not_called", target="record_lead")


def m_two_values_for_one_target(s: Sources) -> None:
    _assertion("IND-PAY-001", s, id="A8", type="equals", target="result.status_code", expected=200)
    _assertion("IND-PAY-001", s, id="A9", type="equals", target="result.status_code", expected=201)


def m_required_call_not_asserted(s: Sources) -> None:
    case = find(s, "IND-PLAN-005")
    case["assertions"] = [a for a in case["assertions"] if a["type"] != "tool_called"]


def m_placeholder_names_nobody(s: Sources) -> None:
    _assertion("IND-PLAN-001", s, id="A9", type="equals", target="state.lead.customer_id", expected="$customer.nobody.id")


def m_malformed_date_token(s: Sources) -> None:
    for a in find(s, "IND-CLM-006")["assertions"]:
        if isinstance(a.get("expected"), str):
            a["expected"] = a["expected"].replace("{{date:today-4d}}", "{{date:yesterday}}")


MUTATIONS: List[Tuple[str, Callable[[Sources], None], str]] = [
    ("a number that disagrees with the pricing code", m_wrong_number, "oracle premium_plan says"),
    ("a permission the matrix does not grant", m_wrong_rbac, "oracle rbac says"),
    ("a decision the engine would not make", m_wrong_decision, "oracle decide says"),
    ("a fixture that is not in the manifest", m_missing_fixture, "is not in the manifest"),
    ("a repeated case id", m_duplicate_id, "duplicate case_id"),
    ("two cases that send the same input", m_same_input, "sends the same input"),
    ("a scenario type outside the schema", m_bad_enum, "scenario_type"),
    ("a category the workflow does not have", m_bad_category, "category"),
    ("a placeholder-based case marked code_verified", m_placeholder_unflagged, "placeholder rule"),
    ("a code_verified case with nothing backing it", m_unbacked_claim, "has no truth oracle"),
    ("a critical case without a critical assertion", m_critical_without_assertion, "without a critical assertion"),
    ("a code reference to a symbol that is gone", m_broken_code_ref, "no longer mentions"),
    ("a code reference to a file that is gone", m_missing_file_ref, "no such file"),
    ("missing interface metadata", m_missing_interface, "metadata.interface"),
    ("every multi-turn case cut down to one message", m_no_multi_turn, "multi-turn cases"),
    ("a user that is not in the tenant fixture", m_unknown_user, "unknown user ref"),
    ("a NaN inside a case", m_nan, "NaN"),
    ("an oracle that does not exist", m_unknown_oracle, "unknown oracle"),
    ("a category with a case missing", m_missing_category, "has 5 cases"),
    ("a turn number past the last message", m_turn_past_the_end, "is outside 1..2"),
    ("a 0-based turn number (turns start at 1)", m_turn_zero_based, "numbered from 1"),
    ("result.* asserted on a chat case", m_result_in_a_chat_case, "has no result"),
    ("a tool assertion on an API case", m_tool_in_an_api_case, "needs a chat case"),
    ("a no_leak phrase nothing in the source supports", m_unbacked_no_leak, "is not backed by a source_contains"),
    ("a tool both required and forbidden", m_called_and_not_called, "contradictory assertions"),
    ("one target equal to two different values", m_two_values_for_one_target, "with different values"),
    ("a required call that no assertion checks", m_required_call_not_asserted, "no assertion checks that it was called"),
    ("a placeholder that names a customer who does not exist", m_placeholder_names_nobody, "is not in the fixtures"),
    ("a malformed date token", m_malformed_date_token, "is not of the form"),
]


def main() -> int:
    baseline = verify_dataset.verify(casekit.sources())
    failures = 0
    if baseline["errors"]:
        print("FAIL baseline: the untouched dataset reports problems:")
        for e in baseline["errors"][:10]:
            print("   ", e)
        failures += 1
    else:
        print(f"ok   baseline: {len(baseline['cases'])} cases, no problems")
    for label, mutate, expect in MUTATIONS:
        sources = copy.deepcopy(casekit.sources())
        mutate(sources)
        errors = verify_dataset.verify(sources, check_fixture_files=False)["errors"]
        hit = [e for e in errors if expect.lower() in e.lower()]
        if hit:
            print(f"ok   caught {label}")
        else:
            failures += 1
            print(f"FAIL did not catch {label} (looked for {expect!r}; got {errors[:3]})")
    print(f"{'PASS' if not failures else 'FAILED'}: {len(MUTATIONS)} mutations, {failures} not caught")
    # The assertion engine is part of what must keep working: its tests run with the verifier's.
    engine_failures = test_assertions.run()
    print(f"{'PASS' if not engine_failures else 'FAILED'}: {len(test_assertions.TESTS)} engine tests, {engine_failures} failed")
    operation_failures = test_operations.run_all()
    print(f"{'PASS' if not operation_failures else 'FAILED'}: {len(test_operations.TESTS)} operation tests, {operation_failures} failed")
    environment_failures = test_environment.run_all()
    print(f"{'PASS' if not environment_failures else 'FAILED'}: {len(test_environment.TESTS)} environment tests, {environment_failures} failed")
    runner_failures = test_runner.run_all()
    print(f"{'PASS' if not runner_failures else 'FAILED'}: {len(test_runner.TESTS)} runner tests, {runner_failures} failed")
    runs_failures = test_runs.run_all()
    print(f"{'PASS' if not runs_failures else 'FAILED'}: {len(test_runs.TESTS)} run-storage tests, {runs_failures} failed")
    stats_failures = test_stats.run_all()
    print(f"{'PASS' if not stats_failures else 'FAILED'}: {len(test_stats.TESTS)} statistics tests, {stats_failures} failed")
    chat_eval_failures = test_chat_eval.run_all()
    print(f"{'PASS' if not chat_eval_failures else 'FAILED'}: {len(test_chat_eval.TESTS)} chat evaluation tests, {chat_eval_failures} failed")
    benchmark_failures = test_benchmark.run_all()
    print(f"{'PASS' if not benchmark_failures else 'FAILED'}: {len(test_benchmark.TESTS)} benchmark tests, {benchmark_failures} failed")
    usage_failures = test_usage.run_all()
    print(f"{'PASS' if not usage_failures else 'FAILED'}: {len(test_usage.TESTS)} usage tests, {usage_failures} failed")
    return 1 if failures or engine_failures or operation_failures or usage_failures or environment_failures or runner_failures or runs_failures or stats_failures or chat_eval_failures or benchmark_failures else 0


if __name__ == "__main__":
    sys.exit(main())
