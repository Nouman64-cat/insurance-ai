"""Tests of the runner's pure logic (shared/evaluation/run_report.py): bundle verification, case selection and classification, the
result classes, pass-rate and cost arithmetic, and the exit status. No stack needed.

    python evals/tools/test_runner.py      # also run by selftest.py
    pytest evals/tools/test_runner.py

The behaviours that need the live stack (reset between cases, repetition, cancellation, timeout, budget) are in
test_runner_integration.py.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import casekit  # noqa: E402
from shared.evaluation.canonical import content_hash, sha256_hex, to_jsonl  # noqa: E402
from shared.evaluation.run_report import (CHAT_REASON, BundleError, CaseResult, classify, cost_from_usage, exit_code, load_bundle, needs_model,  # noqa: E402
                                          operation_of, render_report, select_cases, summarise)

CASES = [casekit.normalise(raw)[0] for _, raw in casekit.sources()]


def make_bundle(root: Path, cases=None, fixtures=None) -> Path:
    """An exported Gold version, built the way the lake builds it: a snapshot, a manifest that pins every part, fixtures."""
    cases = [c for c in (cases or CASES)][:12]
    fixtures = fixtures if fixtures is not None else {"plans.json": b'{"plans": []}', "empty-file.png": b"", "card.png": b"\x89PNGdata"}
    (root / "fixtures").mkdir(parents=True)
    raw = to_jsonl(cases)
    (root / "cases.jsonl").write_bytes(raw)
    entries = [{"case_id": c["case_id"], "sha256": content_hash(c), "category": c.get("category")} for c in cases]
    fx = []
    for name, data in fixtures.items():
        (root / "fixtures" / name).write_bytes(data)
        fx.append({"fixture_key": name, "sha256": sha256_hex(data), "size_bytes": len(data)})
    lines = [f"case:{e['case_id']}:{e['sha256']}" for e in entries] + [f"fixture:{f['fixture_key']}:{f['sha256']}" for f in fx]
    manifest = {"version": "9.9.9", "dataset": {"slug": "unit-test"}, "files": [{"name": "cases.jsonl", "sha256": sha256_hex(raw), "size_bytes": len(raw)}],
                "cases": entries, "fixtures": fx, "dataset_sha256": sha256_hex("\n".join(sorted(lines)).encode("utf-8"))}
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def expect_refused(path: Path, fragment: str) -> None:
    try:
        load_bundle(path)
    except BundleError as exc:
        assert fragment in str(exc), (fragment, str(exc))
    else:
        raise AssertionError(f"a bundle that should be refused ({fragment}) was accepted")


def test_a_published_bundle_loads_and_is_identified() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        bundle = load_bundle(make_bundle(Path(tmp) / "b"))
        assert bundle.verified and len(bundle.cases) == 12 and set(bundle.fixtures) == {"plans.json", "empty-file.png", "card.png"}
        assert bundle.identity["version"] == "9.9.9" and bundle.identity["dataset"] == "unit-test" and bundle.identity["snapshot_sha256"]


def test_a_changed_snapshot_is_refused() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = make_bundle(Path(tmp) / "b")
        (root / "cases.jsonl").write_bytes((root / "cases.jsonl").read_bytes() + b"\n")
        expect_refused(root, "cases.jsonl does not match")


def test_a_changed_case_is_refused_even_if_the_snapshot_checksum_is_repaired() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = make_bundle(Path(tmp) / "b")
        lines = (root / "cases.jsonl").read_text().splitlines()
        case = json.loads(lines[0])
        case["expected"]["outcome"] = "something_else"
        lines[0] = json.dumps(case)
        raw = ("\n".join(lines) + "\n").encode()
        (root / "cases.jsonl").write_bytes(raw)
        manifest = json.loads((root / "manifest.json").read_text())
        manifest["files"][0]["sha256"] = sha256_hex(raw)                       # an attacker fixes the file checksum too
        (root / "manifest.json").write_text(json.dumps(manifest))
        expect_refused(root, "does not match its pinned checksum")


def test_a_changed_or_missing_fixture_is_refused() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = make_bundle(Path(tmp) / "b")
        (root / "fixtures" / "card.png").write_bytes(b"tampered")
        expect_refused(root, "does not match the checksum its version pinned")
    with tempfile.TemporaryDirectory() as tmp:
        root = make_bundle(Path(tmp) / "b")
        (root / "fixtures" / "plans.json").unlink()
        expect_refused(root, "is missing from the bundle")


def test_an_incomplete_bundle_is_refused() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = make_bundle(Path(tmp) / "b")
        (root / "manifest.json").unlink()
        expect_refused(root, "manifest.json is missing")


def test_a_swapped_case_list_is_refused_by_the_fingerprint() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = make_bundle(Path(tmp) / "b")
        manifest = json.loads((root / "manifest.json").read_text())
        manifest["dataset_sha256"] = "0" * 64
        (root / "manifest.json").write_text(json.dumps(manifest))
        expect_refused(root, "fingerprint")


def test_selection_by_suite_case_category_and_operation() -> None:
    every, left = select_cases(CASES)
    assert len(every) == len(CASES) and not left
    only, left = select_cases(CASES, case_ids=["IND-SEC-007", "IND-CUST-001"])
    assert [c["case_id"] for c in only] == ["IND-CUST-001", "IND-SEC-007"] and all(x["_left_out"] == "not_selected" for x in left)
    sec, _ = select_cases(CASES, categories=["security-rbac"])
    assert sec and all(c["category"] == "security-rbac" for c in sec)
    ops, _ = select_cases(CASES, operations=["rules.early_check"])
    assert ops and all(operation_of(c) == "rules.early_check" for c in ops)
    business, left = select_cases(CASES, suite="business")
    assert business == [] and {x["_left_out"] for x in left} == {"not_business_approved"}, "no case is business-approved yet"
    approved = [{**CASES[0], "source": {**CASES[0]["source"], "verification": "business_approved"}}, CASES[1]]
    got, _ = select_cases(approved, suite="business")
    assert [c["case_id"] for c in got] == [CASES[0]["case_id"]]


def test_an_unknown_case_or_suite_is_an_error_not_an_empty_run() -> None:
    for kwargs in ({"case_ids": ["IND-NOPE-1"]}, {"suite": "everything"}):
        try:
            select_cases(CASES, **kwargs)
        except ValueError:
            continue
        raise AssertionError(f"{kwargs} was accepted")


REGISTERED = {"rules.early_check": "http", "quotes.calculate": "function", "ocr.extract_customer": "http"}
FILES = {"card.png": b"\x89PNG", "note.txt": b"x", "empty-file.png": b""}


def case_with(op, **payload):
    return {"case_id": "T-1", "input": {"payload": {"operation": op, **payload}}, "metadata": {"interface": "api"}}


def test_chat_cases_are_skipped_never_run_never_passed() -> None:
    chat = [c for c in CASES if (c.get("metadata") or {}).get("interface") == "chat"]
    assert chat, "the dataset has chat cases"
    for c in chat:
        assert classify(c, registered=REGISTERED, files=FILES, providers_ready=True) == {"status": "skipped", "reason": CHAT_REASON}
    stream = case_with("chat.stream", message="hi")
    assert classify(stream, registered={**REGISTERED, "chat.stream": "http"}, files=FILES, providers_ready=True)["status"] == "skipped"


def test_an_unregistered_operation_is_blocked() -> None:
    assert classify(case_with("customers.merge"), registered=REGISTERED, files=FILES, providers_ready=True) == {"status": "blocked", "reason": "operation_not_registered:customers.merge"}


def test_model_backed_cases_need_credentials_but_refusals_do_not() -> None:
    reading = case_with("ocr.extract_customer", file="card.png")
    assert needs_model(reading, FILES)
    assert classify(reading, registered=REGISTERED, files=FILES, providers_ready=False) == {"status": "blocked", "reason": "blocked_missing_credentials"}
    assert classify(reading, registered=REGISTERED, files=FILES, providers_ready=True) is None
    for refused in (case_with("ocr.extract_customer", file="note.txt"), case_with("ocr.extract_customer", file="empty-file.png")):
        assert not needs_model(refused, FILES)
        assert classify(refused, registered=REGISTERED, files=FILES, providers_ready=False) is None, "a refused upload never reaches a model"


def test_cost_is_zero_only_when_no_model_was_used() -> None:
    assert cost_from_usage(None, uses_model=False) == (0.0, True)
    assert cost_from_usage(None, uses_model=True) == (None, False)                               # a model was used, nothing measured
    assert cost_from_usage({"status": "missing"}, uses_model=True) == (None, False)
    assert cost_from_usage({"status": "unavailable"}, uses_model=True) == (None, False)
    assert cost_from_usage({"status": "attributed", "by_model": {}}, uses_model=False) == (0.0, True)
    cost, known = cost_from_usage({"status": "attributed", "by_model": {"gpt-4o-mini-2024-07-18": {"input_tokens": 10_000, "output_tokens": 200}}}, True)
    assert known and abs(cost - (10_000 * 0.15 + 200 * 0.6) / 1e6) < 1e-9
    assert cost_from_usage({"status": "attributed", "by_model": {"unlisted-model": {"input_tokens": 5, "output_tokens": 5}}}, True) == (None, False)


def result(case_id, status, **kw):
    return CaseResult(case_id=case_id, category=kw.pop("category", "c"), operation=kw.pop("operation", "op"), verification="code_verified", status=status, **kw)


def test_only_ran_cases_count_towards_the_pass_rate() -> None:
    rows = [result("A", "passed", latency_ms=10), result("B", "passed", latency_ms=20), result("C", "failed", latency_ms=30),
            result("D", "blocked", reason="blocked_missing_credentials"), result("E", "skipped", reason=CHAT_REASON), result("F", "infrastructure_error", reason="timeout")]
    s = summarise(rows, selected=6)
    assert s["by_status"] == {"passed": 2, "failed": 1, "blocked": 1, "skipped": 1, "infrastructure_error": 1}
    assert s["ran"] == 3 and abs(s["pass_rate"] - 2 / 3) < 1e-9
    assert summarise([result("E", "skipped", reason=CHAT_REASON)], selected=1)["pass_rate"] is None, "all skipped is not 100%"


def test_unknown_costs_are_counted_not_dropped() -> None:
    rows = [result("A", "passed", cost_usd=0.002, cost_known=True), result("B", "passed", cost_usd=None, cost_known=False), result("C", "passed", cost_usd=0.0, cost_known=True)]
    s = summarise(rows, selected=3)
    assert s["cost"] == {"known_usd": 0.002, "executions_with_unknown_cost": 1}


def test_flaky_cases_are_found_across_repetitions() -> None:
    rows = [result("A", "passed", repetition=1), result("A", "failed", repetition=2), result("B", "passed", repetition=1), result("B", "passed", repetition=2)]
    assert summarise(rows, selected=2)["flaky_cases"] == ["A"]


def test_exit_status() -> None:
    def s(**by):
        return {"by_status": {"passed": 0, "failed": 0, "blocked": 0, "skipped": 0, "infrastructure_error": 0, **by}, "ran": by.get("passed", 0) + by.get("failed", 0)}
    assert exit_code(s(passed=3)) == 0
    assert exit_code(s(passed=3, failed=1, infrastructure_error=1)) == 1
    assert exit_code(s(passed=3, infrastructure_error=1)) == 2
    assert exit_code(s(passed=3, blocked=1)) == 0 and exit_code(s(passed=3, blocked=1), strict=True) == 3
    assert exit_code(s(skipped=5), strict=True) == 3, "nothing ran"


def test_the_report_names_what_did_not_run_and_never_calls_it_passed() -> None:
    rows = [result("A", "passed", latency_ms=12), result("B", "failed", latency_ms=40, operation="customers.create",
                                                          failed_assertions=[{"status": "failed", "target": "result.body.is_smoker", "expected": None, "actual": False}]),
            result("K1", "blocked", reason="blocked_missing_credentials"), result("X", "skipped", reason=CHAT_REASON), result("T", "infrastructure_error", reason="timeout")]
    s = summarise(rows, selected=5)
    text = render_report(s, rows, identity={"dataset": "d", "version": "1.0.5", "cases": 5, "fixtures": 2, "verified": True}, suite="technical", run_id="r1", budget_usd=1.0)
    for needle in ("VERIFIED against the published manifest", "pass rate  50.0% (1 of 2 that ran)", "blocked_missing_credentials: K1", f"{CHAT_REASON}: 1 case(s)",
                   "timeout: T", "result.body.is_smoker", "SKIPPED (never counted as passed)", "no unknown costs"):
        assert needle in text, needle
    unverified = render_report(s, rows, identity={"dataset": "src", "version": "working", "cases": 5, "fixtures": 2, "verified": False}, suite="technical", run_id="r2")
    assert "NOT verified" in unverified


TESTS = [test_a_published_bundle_loads_and_is_identified, test_a_changed_snapshot_is_refused,
         test_a_changed_case_is_refused_even_if_the_snapshot_checksum_is_repaired, test_a_changed_or_missing_fixture_is_refused,
         test_an_incomplete_bundle_is_refused, test_a_swapped_case_list_is_refused_by_the_fingerprint, test_selection_by_suite_case_category_and_operation,
         test_an_unknown_case_or_suite_is_an_error_not_an_empty_run, test_chat_cases_are_skipped_never_run_never_passed, test_an_unregistered_operation_is_blocked,
         test_model_backed_cases_need_credentials_but_refusals_do_not, test_cost_is_zero_only_when_no_model_was_used, test_only_ran_cases_count_towards_the_pass_rate,
         test_unknown_costs_are_counted_not_dropped, test_flaky_cases_are_found_across_repetitions, test_exit_status,
         test_the_report_names_what_did_not_run_and_never_calls_it_passed]


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
    print(f"{'PASS' if not failures else 'FAILED'}: {len(TESTS)} runner tests, {failures} failed")
    sys.exit(1 if failures else 0)
