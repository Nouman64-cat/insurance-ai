"""Unit tests of the investigation analytics (shared/evaluation/analytics.py), on small sets of executions worked out by hand. No database.

Run: python evals/tools/test_analytics.py
"""
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.evaluation import analytics as an  # noqa: E402

FAILS = 0


def check(name, ok, detail=""):
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {str(detail)[:400]}" if detail and not ok else ""))


def lay(**kw):
    base = {l: {"applicable": False, "status": "not_applicable", "score": None} for l in an.LAYERS}
    for l, (st, sc) in kw.items():
        base[l] = {"applicable": True, "status": st, "score": sc}
    return base


def row(case, status, model="m1", rep=1, lat=1000, layers=None, specialist=None, tools=(), crit=False, dataset="ds"):
    return {"model": model, "dataset": dataset, "case_id": case, "repetition": rep, "status": status, "critical_failed": crit, "latency_ms": lat, "layer_scores": layers if layers is not None else lay(), "specialist": specialist, "tools": list(tools),
            "at": datetime(2026, 10, 20)}


rows = [row("A", "passed", layers=lay(L1=("passed", 1), L3=("passed", 1), L6=("measured", None)), specialist="claims", tools=["list_claims"], lat=900),
        row("B", "failed", layers=lay(L1=("passed", 1), L3=("failed", 0.5), L5=("failed", 0)), specialist="claims", tools=["list_claims", "intimate_claim"], lat=2100, crit=True),
        row("C", "blocked"), row("D", "skipped"), row("E", "infrastructure_error"),
        row("A", "passed", model="m2", layers=lay(L1=("passed", 1), L3=("passed", 1)), specialist="finance", tools=["list_payments"], lat=500)]
o = an.outcomes(rows)
check("outcomes count every status, overall and per model, with the pass rate over executions that ran and the critical failures", o["total"] == 6 and o["by_status"] == {"passed": 2, "failed": 1, "blocked": 1, "skipped": 1, "infrastructure_error": 1}
      and abs(o["pass_rate"] - 2 / 3) < 1e-9 and o["critical_failures"] == 1 and o["by_model"]["m1"]["blocked"] == 1 and o["by_model"]["m2"]["passed"] == 1, o)
check("no execution that ran means no pass rate (not zero)", an.outcomes([row("C", "blocked")])["pass_rate"] is None and an.outcomes([])["pass_rate"] is None)
c = an.coverage(rows, {"ds": 4, "other": 10})
check("coverage is the cases run to a verdict (passed or failed) over the cases in the published version, and a dataset never run has none", c["ds"] == {"cases_run": 2, "cases_total": 4, "share": 0.5} and c["other"] == {"cases_run": 0, "cases_total": 10, "share": 0.0}, c)
check("a dataset with no known size has no share", an.coverage(rows, {})["ds"]["share"] is None)

ls = an.layer_scores(rows)["by_model"]
check("layers L1 to L6 are scored per model, counting only the executions a layer applied to and only those that ran", ls["m1"]["L1"]["applicable"] == 2 and ls["m1"]["L1"]["pass_rate"] == 1.0 and ls["m1"]["L3"]["passed"] == 1 and ls["m1"]["L3"]["failed"] == 1 and ls["m1"]["L3"]["pass_rate"] == 0.5
      and abs(ls["m1"]["L3"]["mean_score"] - 0.75) < 1e-9 and ls["m1"]["L2"]["applicable"] == 0 and ls["m1"]["L2"]["pass_rate"] is None, ls["m1"])
check("a measured-only layer (L6 without a limit) is applicable but neither passed nor failed, so it has no pass rate", ls["m1"]["L6"]["applicable"] == 1 and ls["m1"]["L6"]["other"] == 1 and ls["m1"]["L6"]["pass_rate"] is None)
check("a blocked or skipped execution adds nothing to any layer", an.layer_scores([row("C", "blocked", layers=lay(L1=("failed", 0)))])["by_model"] == {})

rt = an.routing(rows)
check("routing accuracy per specialist is its executions that passed the trajectory layer over those it applied to", rt["specialists"]["claims"] == {"executions": 2, "l3_applied": 2, "l3_passed": 1, "l3_failed": 1, "accuracy": 0.5} and rt["specialists"]["finance"]["accuracy"] == 1.0, rt["specialists"])
check("tool-calling accuracy per tool the same way, most used first", list(rt["tools"])[0] == "list_claims" and rt["tools"]["list_claims"]["accuracy"] == 0.5 and rt["tools"]["intimate_claim"]["l3_failed"] == 1 and rt["tools"]["list_payments"]["accuracy"] == 1.0)
check("the overall trajectory accuracy counts only executions where it applied", rt["overall"] == {"l3_applied": 3, "l3_passed": 2, "accuracy": 2 / 3}, rt["overall"])
check("an execution where the trajectory layer did not apply is counted as using the specialist, with no verdict on it", an.routing([row("Z", "passed", specialist="claims", tools=["t"])])["specialists"]["claims"] == {"executions": 1, "l3_applied": 0, "l3_passed": 0, "l3_failed": 0, "accuracy": None})

la = an.latency(rows)
check("latency is the mean, P50 and P95 per model over executions that ran and reported one", la["m1"]["n"] == 2 and la["m1"]["mean"] == 1500 and la["m1"]["p50"] == 1500 and la["m1"]["p95"] > 2000 - 1 and la["m2"]["p50"] == 500)
check("an execution without a latency is left out, not counted as zero", an.latency([row("A", "passed", lat=None)]) == {})

rep = [row("A", "passed", rep=i) for i in (1, 2, 3)] + [row("B", "passed", rep=1), row("B", "failed", rep=2), row("B", "passed", rep=3)] + [row("C", "failed", rep=i) for i in (1, 2, 3)]
rl = an.reliability(rep)["m1"]
check("repeated cases give a consistency figure, the flaky case is named, a case that always fails is counted", rl["repeated_cases"] == 3 and rl["flaky_cases"] == ["B"] and rl["consistently_wrong"] == 1 and rl["decision_consistency"] is not None and abs(rl["all_runs_success_rate"] - 1 / 3) < 1e-9, rl)
check("with too few repeated cases there is no consistency figure (never a made-up one)", an.reliability([row("A", "passed", rep=1), row("A", "passed", rep=2)])["m1"]["decision_consistency"] is None)

now = datetime(2026, 10, 22, 12)
items = [{"opened_at": datetime(2026, 10, 20), "kind": "rule_changed"}, {"opened_at": datetime(2026, 10, 21), "kind": "unconfirmed"}, {"opened_at": datetime(2026, 10, 14), "kind": "coverage_gap"}, {"opened_at": datetime(2025, 1, 1), "kind": "proposal"}]
dt = an.drift_timeline(items, now=now, weeks=4)
check("drift is new review items per week and kind; every week is present, an old item is left out", [w["start"] for w in dt["weeks"]] == ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"], dt["weeks"])
check("the weeks add up: two items this week, one the week before, none before that", [w["total"] for w in dt["weeks"]] == [0, 0, 1, 2] and dt["total"] == 3 and dt["kinds"] == ["coverage_gap", "rule_changed", "unconfirmed"], dt)
s = an.summarise(rows, version_cases={"ds": 4}, drift_items=items, now=now)
check("the summary carries every part", set(s) == {"executions", "outcomes", "coverage", "layers", "routing", "latency", "reliability", "drift"} and s["executions"] == 6)
print("FAILED" if FAILS else "PASS: all analytics tests, 0 failed")
sys.exit(1 if FAILS else 0)
