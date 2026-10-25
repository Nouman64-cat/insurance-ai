"""Unit tests of shared/evaluation/change_registry.py: fingerprints ignore how code is written, differences are readable, the first sighting
of an item is not a change, and a change plus its dependent cases gives one finding. Pure: no database."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from shared.evaluation import change_registry as cr  # noqa: E402

CODE = '''
"""Module docs."""
RATE = 3.5

def premium(coverage, rate):
    """Compute it."""
    # a comment
    return coverage * rate / 100

def other():
    return 1
'''


def test_formatting_comments_and_docstrings_are_not_a_change() -> None:
    reformatted = CODE.replace("# a comment", "# a different comment").replace('"""Compute it."""', '"""Compute the premium."""').replace("coverage * rate / 100", "(coverage * rate) / 100")
    assert cr.fingerprint(cr.module_summary(CODE)) == cr.fingerprint(cr.module_summary(reformatted)), "brackets, comments and docstrings changed the fingerprint"


def test_a_real_code_change_names_the_function_that_changed() -> None:
    changed = CODE.replace("/ 100", "/ 1000")
    d = cr.diff_summaries(cr.module_summary(CODE), cr.module_summary(changed))
    assert [x["path"] for x in d] == ["functions.premium"], d


def test_adding_removing_and_changing_values_are_all_shown() -> None:
    old = {"rate": 3.5, "bands": [18, 65], "flags": {"smoker": 1.5}}
    new = {"rate": 3.8, "bands": [18, 70], "flags": {"smoker": 1.5, "female": 0.9}}
    d = {(x["path"], x["change"]): (x["before"], x["after"]) for x in cr.diff_summaries(old, new)}
    assert d[("rate", "changed")] == (3.5, 3.8) and d[("bands", "removed")] == (65, None) and d[("bands", "added")] == (None, 70) and d[("flags.female", "added")] == (None, 0.9), d
    assert cr.diff_summaries(old, old) == []


def test_key_order_does_not_change_a_fingerprint() -> None:
    assert cr.fingerprint({"a": 1, "b": [1, 2]}) == cr.fingerprint({"b": [1, 2], "a": 1}) and cr.fingerprint({"a": 1}) != cr.fingerprint({"a": 2})


def test_a_missing_function_is_a_change_not_a_silent_pass() -> None:
    assert cr.function_summary(CODE, ["premium", "gone"])["items"]["gone"] == "MISSING"


def obs(summary):
    return {"key": "calc:premium", "type": "calc", "title": "Premium calculation", "source": "shared/pricing/calculator.py", "summary": summary}


def test_the_first_sighting_records_version_one_and_is_not_a_change() -> None:
    r = cr.classify_reading(obs({"x": 1}), None)
    assert r["status"] == "new" and r["version"] == 1 and cr.change_finding(obs({"x": 1}), r, []) is None


def test_an_unchanged_reading_records_nothing_and_a_changed_one_makes_the_next_version() -> None:
    last = {"version": 3, "fingerprint": cr.fingerprint({"x": 1}), "summary": {"x": 1}}
    assert cr.classify_reading(obs({"x": 1}), last)["status"] == "unchanged"
    r = cr.classify_reading(obs({"x": 2}), last)
    assert r["status"] == "changed" and r["version"] == 4 and r["diff"][0]["before"] == 1 and r["diff"][0]["after"] == 2


def test_a_change_gives_one_finding_with_the_affected_cases_and_the_worst_severity() -> None:
    last = {"version": 1, "fingerprint": cr.fingerprint({"x": 1}), "summary": {"x": 1}}
    r = cr.classify_reading(obs({"x": 2}), last)
    cases = [{"case_id": "B", "severity": "high"}, {"case_id": "A", "severity": "critical"}, {"case_id": "A", "severity": "critical"}]
    f = cr.change_finding(obs({"x": 2}), r, cases)
    assert f["kind"] == "config_changed" and f["severity"] == "critical" and f["affected_cases"] == ["A", "B"] and f["needs_human"]
    assert f["registry_item_key"] == "calc:premium" and f["detail"]["from_version"] == 1 and f["detail"]["to_version"] == 2
    assert f["key"] == cr.change_finding(obs({"x": 2}), r, cases)["key"], "the same change is the same item"
    r3 = cr.classify_reading(obs({"x": 3}), {**last, "version": 2, "fingerprint": r["fingerprint"], "summary": {"x": 2}})
    assert cr.change_finding(obs({"x": 3}), r3, cases)["key"] != f["key"], "a later change is a new item"


def test_a_change_nobody_depends_on_is_reported_as_a_gap_in_coverage() -> None:
    last = {"version": 1, "fingerprint": cr.fingerprint({"x": 1}), "summary": {"x": 1}}
    f = cr.change_finding(obs({"x": 2}), cr.classify_reading(obs({"x": 2}), last), [])
    assert f["severity"] == "low" and "no case depends on it" in f["summary"] and f["affected_cases"] == []


def test_dependencies_match_exactly_or_by_family() -> None:
    deps = [("C1", "plan:TERM"), ("C2", "plan:*"), ("C3", "calc:premium")]
    got = {d["case_id"] for d in cr.dependents("plan:TERM", deps, {})}
    assert got == {"C1", "C2"} and {d["case_id"] for d in cr.dependents("calc:premium", deps, {})} == {"C3"}


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]

if __name__ == "__main__":
    failed = 0
    for t in TESTS:
        try:
            t()
            print(f"ok   {t.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {t.__name__}: {exc}")
    print(f"{'PASS' if not failed else 'FAILED'}: {len(TESTS)} change registry tests, {failed} failed")
    sys.exit(1 if failed else 0)
