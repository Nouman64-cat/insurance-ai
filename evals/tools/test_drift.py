"""Unit tests of shared/evaluation/drift.py: what it finds, and the rules that stop a finding from ever changing an approved golden answer.
Pure: no database, no network, no model. Run with the rest by evals/tools/selftest.py."""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))

from shared.evaluation import drift  # noqa: E402


def case(cid, stage="lead-onboarding", scenario="positive", severity="high", verification="code_verified", truth=None, approved_at=None, kind="code"):
    return {"case_id": cid, "category": stage, "scenario_type": scenario, "severity": severity, "source": {"kind": kind, "verification": verification},
            "metadata": {"truth": truth if truth is not None else [{"oracle": "x", "inputs": {}, "expect": True}]}, "approval": {"approved_at": approved_at},
            "input": {"messages": [{"role": "user", "content": "Record a lead: Name, 0300-1234567"}]}}


def row(cid, status, severity="high", tools=(), latency=1000, cost=0.01):
    return {"case_id": cid, "status": status, "severity": severity, "latency_ms": latency, "cost_usd": cost, "cost_known": True, "trace_summary": {"executed_tools": list(tools)}, "repetition": 1}


def test_a_pin_that_no_longer_matches_the_code_is_a_finding_and_changes_nothing() -> None:
    cases = [case("A"), case("B")]
    truth = {"A": [{"oracle": "source_contains", "inputs": {"path": "p"}, "expect": True, "got": False}], "B": [{"oracle": "source_contains", "inputs": {}, "expect": True, "got": True}]}
    found = drift.rule_findings(cases, truth)
    assert [f["kind"] for f in found] == ["rule_changed"] and found[0]["affected_cases"] == ["A"], found
    assert found[0]["detail"]["expected_by_case"] is True and found[0]["detail"]["found_in_code"] is False and found[0]["needs_human"]
    assert cases[0]["metadata"]["truth"][0]["expect"] is True, "the case itself is untouched"


def test_a_check_that_cannot_run_is_reported_separately() -> None:
    f = drift.rule_findings([case("A")], {"A": [{"oracle": "transition_legal", "inputs": {}, "expect": True, "error": "TypeError: boom"}]})
    assert f[0]["kind"] == "oracle_error" and "boom" in f[0]["summary"]


def test_the_same_problem_found_twice_is_one_item() -> None:
    truth = {"A": [{"oracle": "o", "inputs": {}, "expect": True, "got": False}]}
    assert drift.rule_findings([case("A")], truth)[0]["key"] == drift.rule_findings([case("A")], truth)[0]["key"]
    other = {"A": [{"oracle": "o", "inputs": {}, "expect": True, "got": "different"}]}
    assert drift.rule_findings([case("A")], other)[0]["key"] != drift.rule_findings([case("A")], truth)[0]["key"], "a different finding is a different item"


def test_unconfirmed_unpinned_and_old_approvals_are_found() -> None:
    now = datetime(2026, 10, 23, tzinfo=timezone.utc)
    cases = [case("U", verification="pending_domain_approval"), case("P", truth=[]), case("OLD", approved_at="2026-01-01T00:00:00Z"), case("FRESH", approved_at="2026-10-01T00:00:00Z")]
    kinds = {(f["kind"], f["affected_cases"][0]) for f in drift.stale_findings(cases, now=now)}
    assert kinds == {("unconfirmed", "U"), ("unpinned", "P"), ("review_due", "OLD")}, kinds


def test_coverage_gaps_name_the_stage_and_the_missing_scenario() -> None:
    cases = [case(f"A{i}", stage="underwriting", scenario="positive") for i in range(6)] + [case("B1", stage="claims", scenario="negative", severity="low")]
    found = drift.coverage_findings(cases, stages=["kyc"])
    texts = " | ".join(f["summary"] for f in found)
    assert "claims: 1 case(s)" in texts and "kyc: 0 case(s)" in texts, texts
    assert any(f["detail"].get("scenario_type") == "negative" and f["detail"]["stage"] == "underwriting" for f in found), "underwriting has no negative case"
    assert any(f["detail"].get("kind") == "no_critical_case" and f["detail"]["stage"] == "claims" for f in found), "a stage with no critical case cannot fail a gate"
    assert not any(f["detail"].get("stage") == "underwriting" and f["detail"].get("have") == 6 and "fewer" in f["summary"] for f in found)


def test_proposals_have_no_expected_value_and_are_not_cases() -> None:
    cases = [case(f"A{i}", stage="underwriting") for i in range(6)]
    gaps = drift.coverage_findings(cases)
    props = drift.candidate_proposals(cases, gaps)
    assert props and all(p["expected"] is None and p["proposed_input"] is None and p["state"] == "proposed" for p in props)
    assert all("assertions" not in p and "case_id" not in p for p in props), "a proposal is not a golden case"
    assert all(p["seed_case"] in {c["case_id"] for c in cases} for p in props)


def test_a_regression_a_fix_and_a_tool_change_are_reported_with_what_differed() -> None:
    base = [row("R", "passed", severity="critical"), row("F", "failed"), row("T", "passed", tools=("add_customer",))]
    cur = [row("R", "failed", severity="critical"), row("F", "passed"), row("T", "passed", tools=("add_customer", "resolve_customer_type"))]
    found = drift.behaviour_findings(base, cur, context={"model": "b"})
    by = {f["affected_cases"][0]: f for f in found}
    assert by["R"]["severity"] == "critical" and by["R"]["detail"]["context"] == {"model": "b"}
    assert "now passes" in by["F"]["summary"] and "different tools" in by["T"]["summary"] and by["T"]["severity"] == "low"


def test_run_level_movement_ignores_unknown_figures() -> None:
    base = [row(f"C{i}", "passed", latency=1000, cost=0.01) for i in range(10)]
    worse = [row(f"C{i}", "passed" if i < 6 else "failed", latency=2000, cost=0.02) for i in range(10)]
    kinds = " ".join(f["summary"] for f in drift.performance_findings(base, worse))
    assert "pass rate fell from 100% to 60%" in kinds and "p95 latency grew" in kinds and "cost per executed case grew" in kinds, kinds
    unknown = [{**r, "cost_known": False, "cost_usd": None} for r in worse]
    assert "cost per executed case" not in " ".join(f["summary"] for f in drift.performance_findings(base, unknown)), "unknown cost is not compared"
    assert drift.performance_findings(base, base) == []


def test_a_shift_in_what_people_send_is_noticed_and_small_samples_are_not_judged() -> None:
    ref = [{"category": "kyc", "message": "upload id"} for _ in range(30)]
    steady = [{"category": "kyc", "message": "upload id"} for _ in range(30)]
    moved = [{"category": "claims", "message": "My claim number 12345 was rejected and I want to appeal it, please explain the reason in detail" + "x" * 150, "locale": "ur"} for _ in range(30)]
    assert drift.input_shift_findings(ref, steady) == []
    features = {f["detail"]["feature"] for f in drift.input_shift_findings(ref, moved)}
    assert {"stage", "length", "locale", "has_number"} <= features, features
    assert drift.input_shift_findings(ref, moved[:5]) == [], "too few current items to say anything"
    assert drift.psi(["a"] * 10, ["a"] * 10) == 0 and drift.psi([], ["a"]) is None


def test_identifiers_are_removed_and_a_trace_that_still_leaks_is_refused() -> None:
    text, kinds = drift.scrub("I am Mr Ahmed Khan, CNIC 35202-1234567-1, phone 0300-1234567, mail a.khan@example.com, born 1990-05-04")
    assert "35202" not in text and "1234567" not in text and "example.com" not in text and "Ahmed" not in text and "1990" not in text, text
    assert {"cnic", "phone", "email", "date_of_birth", "name"} <= set(kinds), kinds
    safe = drift.deidentify_trace({"messages": ["My CNIC is 3520212345671 and I want to add a policy"], "locale": "en"})
    assert "3520212345671" not in safe["messages"][0] and safe["provenance"]["scrubbed"] and set(safe) == {"messages", "locale", "stage", "provenance"}
    assert drift.residual_pii("call me on 03001234567") == ["phone"] or "phone" in drift.residual_pii("call me on 03001234567")
    try:
        drift.deidentify_trace({"messages": []})
    except drift.DriftError:
        return
    raise AssertionError("an empty trace was accepted")


def test_accepting_needs_a_person_a_reason_and_an_expected_value_they_wrote() -> None:
    item = {"state": "open", "kind": "proposal", "expected": None}
    item = drift.advance(item, "in_review", actor="reviewer@x")
    for bad in (dict(actor=None, note="n", expected={"a": 1}), dict(actor="r", note="", expected={"a": 1}), dict(actor="r", note="n", expected=None)):
        try:
            drift.advance(item, "accepted", **bad)
        except drift.DriftError:
            continue
        raise AssertionError(f"accepted without {bad}")
    done = drift.advance(item, "accepted", actor="r", note="confirmed with underwriting", expected={"status": 422})
    assert done["state"] == "accepted" and done["expected"] == {"status": 422} and done["expected_source"] == "reviewer" and len(done["history"]) == 2
    model_made = {"state": "in_review", "kind": "proposal", "expected": {"status": 200}, "expected_source": "model"}
    try:
        drift.advance(model_made, "accepted", actor="r", note="ok", expected={"status": 200})
    except drift.DriftError:
        pass
    else:
        raise AssertionError("a model's suggestion was accepted unchanged")


def test_the_states_only_move_along_the_allowed_paths_and_acknowledgements_need_no_expected_value() -> None:
    for frm, to in (("open", "accepted"), ("accepted", "open"), ("dismissed", "accepted"), ("open", "bogus")):
        try:
            drift.advance({"state": frm, "kind": "review_due"}, to, actor="r", note="n")
        except drift.DriftError:
            continue
        raise AssertionError(f"{frm} -> {to} was allowed")
    ack = drift.advance(drift.advance({"state": "open", "kind": "review_due"}, "in_review", actor="r"), "accepted", actor="r", note="still right")
    assert ack["state"] == "accepted" and "expected" not in ack, "reviewing an old case writes nothing"
    assert drift.advance({"state": "open", "kind": "performance_changed"}, "dismissed", actor="r", note="noise")["state"] == "dismissed"


def test_nothing_derived_from_a_finding_can_overwrite_an_approved_case_or_write_to_gold() -> None:
    for change in ({"replaces_case": "IND-SEC-009"}, {"overwrites": "IND-SEC-009"}, {"write_to": "gold"}, {"write_to": "published"}):
        try:
            drift.guard_no_overwrite(change, ["IND-SEC-009"])
        except drift.DriftError:
            continue
        raise AssertionError(f"{change} was allowed")
    drift.guard_no_overwrite({"write_to": "silver", "creates_draft": "CAND-1"}, ["IND-SEC-009"])


def test_a_scan_clears_and_reopens_but_never_touches_a_decision() -> None:
    item = {"state": "open", "kind": "rule_changed"}
    cleared = drift.system_advance(item, "cleared", scan_id="scan-1")
    assert cleared["state"] == "cleared" and cleared["history"][-1]["by"] == "system"
    assert drift.system_advance(cleared, "open", scan_id="scan-2")["state"] == "open"
    for decided in ("accepted", "rejected", "dismissed"):
        for to in ("cleared", "open"):
            try:
                drift.system_advance({"state": decided, "kind": "review_due"}, to, scan_id="scan-3")
            except drift.DriftError:
                continue
            raise AssertionError(f"a scan moved a {decided} item to {to}")
    try:
        drift.advance(cleared, "in_review", actor="r")
    except drift.DriftError:
        return
    raise AssertionError("a person moved a cleared item")


def test_a_template_change_suggests_cases_with_no_input_and_no_expected_value() -> None:
    from shared import doc_templates as t
    old = t.seed_lead_acquisition()
    new = __import__("copy").deepcopy(old)
    new["sections"][0]["fields"].append({"id": "blood_group", "label": "Blood group", "type": "text", "binding": {"store": "details"}})
    new["sections"][0]["fields"][0]["label"] = "Given name"
    new["sections"][0]["fields"][1]["placeholder"] = "x"
    props = drift.template_proposals("lead_acquisition", "Lead acquisition", 2, t.diff(old, new), new)
    targets = {p["provenance"]["target"]: p for p in props}
    assert set(targets) == {"field:blood_group", "field:first_name"}, set(targets)
    assert "was added to" in targets["field:blood_group"]["rationale"] and "was reworded" in targets["field:first_name"]["rationale"]
    assert all(p["expected"] is None and p["proposed_input"] is None and p["state"] == "proposed" for p in props)
    assert props[0]["key"] == drift.template_proposals("lead_acquisition", "Lead acquisition", 2, t.diff(old, new), new)[0]["key"], "stable keys"
    assert drift.template_proposals("lead_acquisition", "Lead acquisition", 2, [], new) == []


def test_the_summary_counts_what_blocks() -> None:
    f = drift.rule_findings([case("A", severity="critical")], {"A": [{"oracle": "o", "inputs": {}, "expect": True, "got": False}]}) + drift.stale_findings([case("B", verification="pending_domain_approval")])
    s = drift.summarise(f)
    assert s["total"] == 2 and s["blocking"] >= 1 and s["by_kind"]["rule_changed"] == 1
    assert drift.sort_findings(f)[0]["severity"] == "critical"


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
    print(f"{'PASS' if not failed else 'FAILED'}: {len(TESTS)} drift tests, {failed} failed")
    sys.exit(1 if failed else 0)
