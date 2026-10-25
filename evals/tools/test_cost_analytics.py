"""Unit tests of the cost analytics (shared/evaluation/cost_analytics.py): the spend series, each anomaly rule, the model comparison and every recommendation, on small
numbers worked out by hand. No database.

Run: python evals/tools/test_cost_analytics.py
"""
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.evaluation import cost_analytics as ca  # noqa: E402

FAILS = 0


def check(name, ok, detail=""):
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {str(detail)[:500]}" if detail and not ok else ""))


def L(day, usd, component="agent_llm", provider="openai", model="gpt-4.1", hour=12, run="r"):
    return {"incurred_at": datetime(2026, 10, day, hour), "usd": usd, "component": component, "provider": provider, "model": model, "run_id": run}


# ── buckets ────────────────────────────────────────────────────────────────────────────────────────────────────────────
check("a day is its own bucket, a week starts on Monday, a month on the 1st", ca.bucket_start(datetime(2026, 10, 22, 9), "day") == date(2026, 10, 22) and ca.bucket_start(datetime(2026, 10, 22, 9), "week") == date(2026, 10, 19)
      and ca.bucket_start(datetime(2026, 10, 22, 9), "month") == date(2026, 10, 1))
check("the next bucket rolls over weeks, months and years", ca.next_bucket(date(2026, 10, 19), "week") == date(2026, 10, 26) and ca.next_bucket(date(2026, 12, 1), "month") == date(2027, 1, 1) and ca.next_bucket(date(2026, 2, 28), "day") == date(2026, 3, 1))
try:
    ca.bucket_start(datetime(2026, 1, 1), "year")
    check("an unknown bucket is refused", False)
except ValueError:
    check("an unknown bucket is refused", True)

# ── the spend series ───────────────────────────────────────────────────────────────────────────────────────────────────
lines = [L(1, 1.0), L(1, 0.5, component="judge", model="gpt-4o"), L(4, 2.0, model="gpt-4o-mini"), L(4, None, component="ocr"), L(4, 0.0, provider="mock", model="mock-oracle")]
s = ca.spend_series(lines, bucket="day")
check("days with no spend between the first and the last are filled with zero, and the running total grows", [p["start"] for p in s["points"]] == ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]
      and [p["total_usd"] for p in s["points"]] == [1.5, 0.0, 0.0, 2.0] and [p["cumulative_usd"] for p in s["points"]] == [1.5, 1.5, 1.5, 3.5], s["points"])
check("a line that could not be priced is counted as unknown and adds no money; scripted models are left out", s["points"][3]["unknown_lines"] == 1 and s["points"][3]["lines"] == 2 and s["total_usd"] == 3.5 and s["unknown_lines"] == 1)
check("the series says how many days had spending, the average of those days and the peak", s["active_buckets"] == 2 and s["average_per_active_bucket_usd"] == 1.75 and s["peak"] == {"start": "2026-10-04", "total_usd": 2.0})
check("scripted models can be included", ca.spend_series(lines, bucket="day", real_only=False)["points"][3]["lines"] == 3)
g = ca.spend_series(lines, bucket="day", group_by="component")
check("money can be split by component", g["groups"] == ["agent_llm", "judge"] and g["points"][0]["by_group"] == {"agent_llm": 1.0, "judge": 0.5} and g["points"][3]["by_group"] == {"agent_llm": 2.0})
check("or by provider and by model", ca.spend_series(lines, group_by="provider")["groups"] == ["openai"] and ca.spend_series(lines, group_by="model")["points"][3]["by_group"] == {"gpt-4o-mini": 2.0})
w = ca.spend_series([L(5, 1.0), L(7, 1.0), L(14, 3.0)], bucket="week")
check("weeks are Monday to Sunday", [p["start"] for p in w["points"]] == ["2026-10-05", "2026-10-12"] and [p["total_usd"] for p in w["points"]] == [2.0, 3.0])
m = ca.spend_series([L(30, 1.0), {**L(1, 2.0), "incurred_at": datetime(2026, 12, 2)}], bucket="month")
check("months across a year end are all present", [p["start"] for p in m["points"]] == ["2026-10-01", "2026-11-01", "2026-12-01"] and m["points"][1]["total_usd"] == 0.0)
check("a window cuts the series at both ends and still fills it", [p["start"] for p in ca.spend_series(lines, bucket="day", start=date(2026, 10, 2), end=date(2026, 10, 4))["points"]] == ["2026-10-02", "2026-10-03", "2026-10-04"])
pre = ca.spend_series([{"incurred_at": datetime(2026, 10, 1), "usd": 3.0, "component": "agent_llm", "provider": "openai", "model": "gpt-4.1", "n": 5, "unknown_n": 2}])
check("a row the database already summed counts as the lines it stands for", pre["points"][0]["lines"] == 5 and pre["points"][0]["unknown_lines"] == 2 and pre["total_usd"] == 3.0, pre)
check("no lines is an empty series, not an error", ca.spend_series([], bucket="day")["points"] == [] and ca.spend_series([], bucket="day")["peak"] is None)
check("a provider is read from the model name when the line has none", ca.spend_series([{**L(1, 1.0), "provider": None, "model": "gemini-2.5-flash"}], group_by="provider")["groups"] == ["gemini"])

# ── robust statistics ──────────────────────────────────────────────────────────────────────────────────────────────────
check("the median and the scaled deviation", ca.median([1, 2, 3, 100]) == 2.5 and abs(ca.mad([1, 2, 3, 4, 100]) - 1.4826) < 1e-9 and ca.median([]) is None)
base = [10, 11, 9, 10, 12]
check("a value must be more than the ratio times the median AND beyond the usual spread", ca.unusual(30, base, ratio=2, k=3, min_baseline=3) is not None and ca.unusual(15, base, ratio=2, k=3, min_baseline=3) is None)
check("with too little history nothing is flagged", ca.unusual(300, [10, 11], ratio=2, k=3, min_baseline=3) is None)
check("a baseline of identical values has no spread, so the ratio alone decides", ca.unusual(25, [10, 10, 10], ratio=2, k=3, min_baseline=3) is not None and ca.unusual(19, [10, 10, 10], ratio=2, k=3, min_baseline=3) is None)
check("a baseline of zeros flags nothing (there is nothing to compare with)", ca.unusual(5, [0, 0, 0, 0], ratio=2, k=3, min_baseline=3) is None)

# ── run anomalies ──────────────────────────────────────────────────────────────────────────────────────────────────────
def run(i, usd, ran=44, group="g1", unknown=0, bc=None):
    return {"run_id": f"R{i}", "started_at": datetime(2026, 10, 1) + timedelta(days=i), "group": group, "ran": ran, "total_usd": usd, "unknown_executions": unknown, "label": "gpt-4.1 on single-turn",
            "by_component": bc or {}}
steady = [run(i, 0.10) for i in range(4)]
a = ca.run_anomalies(steady + [run(5, 0.60)])
check("a run costing several times what earlier runs of its group cost is flagged, with the numbers", len(a) == 1 and a[0]["subject"]["run_id"] == "R5" and a[0]["ratio"] == 6.0 and a[0]["severity"] == "high" and "$0.0136" in a[0]["message"] and "6.0 times" in a[0]["message"], a)
check("the excess is what it cost above the usual, over its own executions", abs(a[0]["excess_usd"] - (0.60 / 44 - 0.10 / 44) * 44) < 1e-9)
check("an ordinary run is not flagged", ca.run_anomalies(steady + [run(5, 0.12)]) == [])
check("a run is judged only against earlier runs (an expensive first run flags nothing)", ca.run_anomalies([run(0, 5.0)] + [run(i, 0.1) for i in range(1, 5)]) == [])
check("fewer than three earlier runs is not enough to call anything unusual", ca.run_anomalies([run(0, 0.1), run(1, 0.1), run(2, 5.0)]) == [])
check("a small absolute excess is ignored even at a high ratio", ca.run_anomalies([run(i, 0.001, ran=10) for i in range(4)] + [run(5, 0.01, ran=10)]) == [])
check("different groups are never compared with each other", ca.run_anomalies(steady + [run(5, 0.6, group="other")]) == [])
check("a run with unknown costs is neither a baseline nor judged", ca.run_anomalies(steady + [run(5, 0.6, unknown=2)]) == [] and len(ca.run_anomalies([run(i, 0.1, unknown=1) for i in range(4)] + [run(5, 0.6)])) == 0)
check("the severity grows with the ratio", ca.run_anomalies(steady + [run(5, 0.25)])[0]["severity"] == "low" and ca.run_anomalies(steady + [run(5, 0.35)])[0]["severity"] == "medium")

# ── waste and unpriced ─────────────────────────────────────────────────────────────────────────────────────────────────
w = ca.waste_anomalies([run(1, 1.0, bc={"agent_llm": {"usd": 0.8}, "retry": {"usd": 0.15}, "fallback": {"usd": 0.05}}), run(2, 1.0, bc={"agent_llm": {"usd": 0.98}, "retry": {"usd": 0.02}}),
                        run(3, 1.0, bc={"agent_llm": {"usd": 0.5}, "unattributed": {"usd": 0.5}})])
check("a run where retries, fallbacks and unattributed calls are 10% or more is flagged; 2% is not", [x["subject"]["run_id"] for x in w] == ["R1", "R3"], [x["subject"] for x in w])
check("half of it wasted is high severity and the message names the parts", w[1]["severity"] == "high" and "unattributed $0.5000" in w[1]["message"] and "retry" in w[0]["message"])
check("a trivial amount is ignored", ca.waste_anomalies([run(1, 0.02, bc={"retry": {"usd": 0.005}})]) == [])
check("executions that could not be priced are reported once per run, and a run without them is not", len(ca.unpriced_anomalies([run(1, 1.0, unknown=3), run(2, 1.0)])) == 1 and ca.unpriced_anomalies([run(1, 1.0, unknown=3)])[0]["observed"] == 3)

# ── daily spikes ───────────────────────────────────────────────────────────────────────────────────────────────────────
def day_points(spec):
    return [{"start": (date(2026, 10, 1) + timedelta(days=i)).isoformat(), "total_usd": v} for i, v in enumerate(spec)]
spec = [0, 0.5, 0, 0.4, 0.6, 0, 0.5, 0, 0, 0.45, 3.0]
sp = ca.daily_spike_anomalies(day_points(spec))
check("a day far above the usual ACTIVE day is flagged; days with no spending do not drag the usual down to zero", len(sp) == 1 and sp[0]["subject"]["day"] == "2026-10-11" and sp[0]["ratio"] == 6.0, sp)
check("an ordinary day is not", ca.daily_spike_anomalies(day_points([0, 0.5, 0.4, 0.6, 0.5, 0.45, 0.9])) == [])
check("with fewer than four earlier active days nothing is flagged", ca.daily_spike_anomalies(day_points([0.5, 0.5, 0.5, 9.0])) == [])
check("history older than the window is not used", ca.daily_spike_anomalies(day_points([0.5, 0.5, 0.5, 0.5] + [0] * 40 + [3.0])) == [])

# ── token outliers ─────────────────────────────────────────────────────────────────────────────────────────────────────
def tr(i, tokens, case="C1", model="gpt-4.1"):
    return {"run_id": f"R{i}", "case_id": case, "model": model, "tokens": tokens, "at": datetime(2026, 10, 1) + timedelta(days=i)}
rows = [tr(i, 8000) for i in range(5)] + [tr(5, 90_000)]
t = ca.token_outliers(rows)
check("an execution using many times the tokens the same case used before on the same model is flagged", len(t) == 1 and t[0]["subject"]["case_id"] == "C1" and t[0]["observed"] == 90000 and t[0]["baseline"] == 8000, t)
check("another model or another case is a different baseline", ca.token_outliers([tr(i, 8000) for i in range(5)] + [tr(5, 90_000, model="other")]) == [] and ca.token_outliers([tr(i, 8000) for i in range(5)] + [tr(5, 90_000, case="C2")]) == [])
check("a small absolute increase is ignored", ca.token_outliers([tr(i, 1000) for i in range(5)] + [tr(5, 6000)]) == [])
check("an execution without token counts is ignored", ca.token_outliers([tr(i, 8000) for i in range(5)] + [{**tr(5, 0), "tokens": None}]) == [])
check("anomalies are ordered by severity, then by money", [x["severity"] for x in ca.order_anomalies(t + w + sp)][0] == "high")

# ── comparing models ───────────────────────────────────────────────────────────────────────────────────────────────────
def grp(label, pr, lo, hi, per, ran=44, crit=0, passes=None, runs=("a",), synthetic=False, total=None):
    p = passes if passes is not None else round(pr * ran)
    return {"label": label, "pass_rate": pr, "ci_low": lo, "ci_high": hi, "per_passed_usd": per, "ran": ran, "passes": p, "critical_failures": crit, "run_ids": list(runs), "synthetic": synthetic, "total_usd": total if total is not None else (per or 0) * p}
big, small, bad = grp("gpt-4.1", 0.91, 0.79, 0.96, 0.0091), grp("gpt-4o-mini", 0.91, 0.79, 0.96, 0.0027, ran=88), grp("old-model", 0.40, 0.27, 0.55, 0.0100)
c = ca.compare_models([big, small, bad])
check("a model that is no better and no cheaper than another is off the quality/cost frontier, and is told what beats it", c["frontier"] == ["gpt-4o-mini"] and next(m for m in c["models"] if m["label"] == "gpt-4.1")["dominated_by"] == ["gpt-4o-mini"], c["frontier"])
check("models are listed cheapest per passed test first, with their rank", [m["label"] for m in c["models"]] == ["gpt-4o-mini", "gpt-4.1", "old-model"] and c["models"][0]["cost_rank"] == 1)
cc = ca.compare_models([grp("fast-cheap", 0.80, 0.7, 0.88, 0.001), grp("slow-good", 0.95, 0.9, 0.98, 0.01)])
check("when one is better and the other cheaper, both are on the frontier", sorted(cc["frontier"]) == ["fast-cheap", "slow-good"])
check("a model with no known cost per passed test is neither on the frontier nor off it", ca.compare_models([grp("x", 0.5, 0.4, 0.6, None)])["models"][0]["on_frontier"] is None)
check("evidence is flagged when a model ran fewer than 30 executions", ca.compare_models([grp("tiny", 1.0, 0.5, 1.0, 0.1, ran=5)])["models"][0]["enough_evidence"] is False)

# ── model recommendations ──────────────────────────────────────────────────────────────────────────────────────────────
r = ca.recommend_models([big, small, bad], dataset="single-turn 1.0.6", mode="agent")
kinds = sorted(x["kind"] for x in r)
check("a cheaper model that is not distinguishable from the dearer one is recommended, with both intervals and a saving", "cheaper_equivalent" in kinds and "gpt-4o-mini" in r[0]["title"] and "95% interval" in r[0]["detail"] and r[0]["estimated_saving_usd"] > 0, r)
check("the saving is the difference per passed test over the tests the dearer model passed", abs(next(x for x in r if x["kind"] == "cheaper_equivalent")["estimated_saving_usd"] - round((0.0091 - 0.0027) * big["passes"], 4)) < 1e-9)
check("a model that is clearly worse and no cheaper is reported as dominated, once, against the cheapest model that beats it", [x["kind"] for x in r].count("dominated_model") == 1
      and "old-model is worse and no cheaper than gpt-4o-mini" == next(x for x in r if x["kind"] == "dominated_model")["title"])
check("at most one recommendation per configuration: a dominated model is not also told to switch", len(r) == 2 and sorted(x["kind"] for x in r) == ["cheaper_equivalent", "dominated_model"], [x["id"] for x in r])
better = ca.recommend_models([grp("old", 0.50, 0.36, 0.64, 0.0100), grp("new", 0.90, 0.78, 0.96, 0.0020)], dataset="d", mode="agent")
check("a model that is clearly worse than a cheaper one is dominated; the better, cheaper one is not itself the subject of advice", [x["kind"] for x in better] == ["dominated_model"] and "old is worse" in better[0]["title"], better)
check("a cheaper model that is clearly worse is NOT recommended", ca.recommend_models([big, grp("cheap-bad", 0.50, 0.36, 0.64, 0.001)], dataset="d", mode="agent") == [])
check("a cheaper model only slightly cheaper is not worth a recommendation", ca.recommend_models([big, grp("meh", 0.91, 0.79, 0.96, 0.0080)], dataset="d", mode="agent") == [])
check("a cheaper model with more critical failures is not recommended", ca.recommend_models([big, {**small, "critical_failures": 2}], dataset="d", mode="agent") == [])
check("too few executions: nothing is recommended", ca.recommend_models([big, grp("few", 0.91, 0.79, 0.96, 0.001, ran=10)], dataset="d", mode="agent") == [])
check("scripted models are never recommended", ca.recommend_models([big, grp("mock", 1.0, 0.9, 1.0, 0.0, synthetic=True)], dataset="d", mode="agent") == [])
check("confidence follows the smaller sample", r[0]["confidence"] == "medium" and ca.recommend_models([grp("a", 0.9, 0.8, 0.95, 0.01, ran=150), grp("b", 0.9, 0.8, 0.95, 0.002, ran=150)], dataset="d", mode="agent")[0]["confidence"] == "high")

# ── spending recommendations ───────────────────────────────────────────────────────────────────────────────────────────
bc = {"agent_llm": {"usd": 0.60}, "judge": {"usd": 0.25}, "retry": {"usd": 0.10}, "fallback": {"usd": 0.0}, "unattributed": {"usd": 0.05}}
sr = ca.recommend_spending(by_component=bc, total_usd=1.0, retry_reasons={"timeout": 4, "provider_error": 1}, unknown_lines=0, judged_executions=100)
check("waste of 5% or more is reported with its causes, and its saving is conditional on fixing them", [x["id"] for x in sr] == ["waste"] and "timeout x4" in sr[0]["detail"] and "only real if the cause" in sr[0]["saving_basis"] and sr[0]["estimated_saving_usd"] == 0.15)
sr = ca.recommend_spending(by_component={"agent_llm": {"usd": 0.4}, "judge": {"usd": 0.6}}, total_usd=1.0, judged_executions=80)
check("a judge that is 40% or more of the spending is noted, but a cheaper judge is NOT recommended without calibration", [x["id"] for x in sr] == ["judge_share"] and "calibration" in sr[0]["detail"] and sr[0]["estimated_saving_usd"] is None)
check("a judge with few judged executions is not noted", ca.recommend_spending(by_component={"judge": {"usd": 0.6}, "agent_llm": {"usd": 0.4}}, total_usd=1.0, judged_executions=5) == [])
check("unpriced models are reported with their names", [x["id"] for x in ca.recommend_spending(by_component={"agent_llm": {"usd": 1.0}}, total_usd=1.0, unknown_lines=3, unpriced_models=["gpt-9"])] == ["unpriced"])
check("no spending, no spending advice", ca.recommend_spending(by_component={}, total_usd=0.0, unknown_lines=3) == [])

# ── the month's pace ───────────────────────────────────────────────────────────────────────────────────────────────────
p = ca.month_projection(3.0, date(2026, 10, 10), limit_usd=5.0)
check("a straight-line projection over the days of the month", p["projected_usd"] == 9.3 and p["days_in_month"] == 31 and p["over_limit"] is True, p)
check("no spending, no projection", ca.month_projection(0.0, date(2026, 10, 10)) is None)
check("over the limit at this pace is a recommendation that says it is a straight line; under it is not", len(ca.recommend_budget(p)) == 1 and "straight-line" in ca.recommend_budget(p)[0]["detail"]
      and ca.recommend_budget(ca.month_projection(1.0, date(2026, 10, 10), limit_usd=50.0)) == [] and ca.recommend_budget(ca.month_projection(1.0, date(2026, 10, 10))) == [])
print("FAILED" if FAILS else "PASS: all cost analytics tests, 0 failed")
sys.exit(1 if FAILS else 0)
