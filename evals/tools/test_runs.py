"""Unit tests of run folders and run pricing (shared/evaluation/runs.py): sealing, tamper detection, and how a cost is established.
No database, no network.

    python evals/tools/test_runs.py      # also run by selftest.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from shared.evaluation.pricing import PriceTable  # noqa: E402
from shared.evaluation.runs import (COST_BASIS_CALCULATED, COST_BASIS_NONE, COST_BASIS_UNKNOWN, RunFolderError, reprice, row_id_for,  # noqa: E402
                                    seal_folder, verify_folder)


def make_folder(root: Path, run_id: str = "20260101T000000-abc123") -> Path:
    (root / "artifacts").mkdir(parents=True)
    (root / "results.jsonl").write_text(json.dumps({"case_id": "C-1", "status": "passed"}) + "\n")
    (root / "summary.json").write_text(json.dumps({"run_id": run_id}))
    (root / "report.txt").write_text("report\n")
    (root / "artifacts" / "C-1-r1.json").write_text("{}")
    seal_folder(root, extra={"run_id": run_id})
    return root


def refused(root: Path, fragment: str) -> None:
    try:
        verify_folder(root)
    except RunFolderError as exc:
        assert fragment in str(exc), (fragment, str(exc))
    else:
        raise AssertionError(f"accepted a folder that should be refused ({fragment})")


def test_a_sealed_folder_verifies() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        manifest = verify_folder(make_folder(Path(tmp) / "r"))
        assert {f["name"] for f in manifest["files"]} == {"results.jsonl", "summary.json", "report.txt", "artifacts/C-1-r1.json"}


def test_any_change_after_sealing_is_refused() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = make_folder(Path(tmp) / "a")
        (root / "results.jsonl").write_text("{}\n")
        refused(root, "results.jsonl does not match")
    with tempfile.TemporaryDirectory() as tmp:
        root = make_folder(Path(tmp) / "b")
        (root / "artifacts" / "C-1-r1.json").unlink()
        refused(root, "missing from the folder")
    with tempfile.TemporaryDirectory() as tmp:
        root = make_folder(Path(tmp) / "c")
        (root / "artifacts" / "extra.json").write_text("{}")
        refused(root, "does not list")
    with tempfile.TemporaryDirectory() as tmp:
        root = make_folder(Path(tmp) / "d")
        (root / "manifest.json").unlink()
        refused(root, "not sealed")


def test_the_row_id_of_a_run_is_stable() -> None:
    assert row_id_for("20260101T000000-abc123") == row_id_for("20260101T000000-abc123") != row_id_for("20260101T000000-abc124")


TABLE = PriceTable.from_rates("v-test", {"gpt-4o-mini": {"input": 0.15, "cached": 0.075, "output": 0.6}})


def test_cost_is_zero_only_when_no_model_was_used() -> None:
    assert reprice(None, TABLE) == (0.0, COST_BASIS_NONE)
    assert reprice({"status": "attributed", "by_model": {}}, TABLE) == (0.0, COST_BASIS_NONE)


def test_cost_is_unknown_when_usage_could_not_be_established() -> None:
    for status in ("missing", "unavailable", "ambiguous"):
        assert reprice({"status": status}, TABLE) == (None, COST_BASIS_UNKNOWN), status
    assert reprice({"status": "attributed", "by_model": {"unlisted-model": {"input_tokens": 1, "output_tokens": 1}}}, TABLE) == (None, COST_BASIS_UNKNOWN)


def test_cost_is_tokens_times_the_versioned_rate_and_follows_the_version() -> None:
    usage = {"status": "attributed", "by_model": {"gpt-4o-mini-2024-07-18": {"input_tokens": 10_000, "output_tokens": 200, "cached_tokens": 4_000}}}
    cost, basis = reprice(usage, TABLE)
    assert basis == COST_BASIS_CALCULATED and abs(cost - (6_000 * 0.15 + 4_000 * 0.075 + 200 * 0.6) / 1e6) < 1e-12
    dearer = PriceTable.from_rates("v-dearer", {"gpt-4o-mini": {"input": 1.5, "cached": 0.75, "output": 6.0}})
    assert abs(reprice(usage, dearer)[0] - 10 * cost) < 1e-12, "the same tokens, priced under another version, give that version's cost"


def test_two_models_in_one_execution_are_each_priced_without_double_counting() -> None:
    usage = {"status": "attributed", "by_model": {"gpt-4o-mini": {"input_tokens": 1_000_000, "output_tokens": 0}, "gpt-4o": {"input_tokens": 1_000_000, "output_tokens": 0}}}
    both = PriceTable.from_rates("v", {"gpt-4o-mini": {"input": 0.15, "output": 0.6}, "gpt-4o": {"input": 2.5, "output": 10}})
    assert abs(reprice(usage, both)[0] - 2.65) < 1e-9, "gpt-4o is not also charged as gpt-4o-mini (longest listed name wins)"


TESTS = [test_a_sealed_folder_verifies, test_any_change_after_sealing_is_refused, test_the_row_id_of_a_run_is_stable,
         test_cost_is_zero_only_when_no_model_was_used, test_cost_is_unknown_when_usage_could_not_be_established,
         test_cost_is_tokens_times_the_versioned_rate_and_follows_the_version, test_two_models_in_one_execution_are_each_priced_without_double_counting]


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
    print(f"{'PASS' if not failures else 'FAILED'}: {len(TESTS)} run-storage tests, {failures} failed")
    sys.exit(1 if failures else 0)
