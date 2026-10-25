"""Unit tests of self-hosted costing (shared/evaluation/self_hosted.py) and of how it becomes cost lines. No database.

Run: python evals/tools/test_self_hosted.py
"""
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.evaluation import cost_lines as cl  # noqa: E402
from shared.evaluation import self_hosted as sh  # noqa: E402
from shared.evaluation.pricing import PriceTable  # noqa: E402

FAILS = 0


def check(name, ok, detail=""):
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {str(detail)[:400]}" if detail and not ok else ""))


def R(name, resource, per_hour, day, source="vendor price list", created=None):
    return {"name": name, "resource": resource, "usd_per_hour": per_hour, "effective_from": datetime(2026, 10, day), "source": source, "created_at": created or datetime(2026, 10, day, 8)}


rates = [R("A10G on-demand", "gpu", 1.20, 1), R("A10G on-demand", "gpu", 1.50, 15), R("A10G on-demand", "cpu", 0.10, 1), R("c6i.4xlarge", "cpu", 0.68, 1)]
check("the rate in force is the latest one on or before the day, per machine name AND resource", sh.rate_in_force(rates, "A10G on-demand", "gpu", datetime(2026, 10, 10))["usd_per_hour"] == 1.20
      and sh.rate_in_force(rates, "A10G on-demand", "gpu", datetime(2026, 10, 15))["usd_per_hour"] == 1.50 and sh.rate_in_force(rates, "A10G on-demand", "cpu", datetime(2026, 10, 20))["usd_per_hour"] == 0.10)
check("before the first recorded rate, for another name, or for a resource the machine has no rate for, there is none", sh.rate_in_force(rates, "A10G on-demand", "gpu", datetime(2026, 9, 30)) is None
      and sh.rate_in_force(rates, "H100", "gpu", datetime(2026, 10, 20)) is None and sh.rate_in_force(rates, "c6i.4xlarge", "gpu", datetime(2026, 10, 20)) is None)
check("the rate recorded last wins when two share a day", sh.rate_in_force([R("m", "gpu", 1.0, 5, created=datetime(2026, 10, 5, 8)), R("m", "gpu", 2.0, 5, created=datetime(2026, 10, 5, 17))], "m", "gpu", datetime(2026, 10, 9))["usd_per_hour"] == 2.0)
check("cost is seconds / 3600 x the hourly rate; no rate or a bad duration is unknown, never zero", abs(sh.compute_cost(1800, rates[0]) - 0.60) < 1e-12 and sh.compute_cost(0, rates[0]) == 0.0 and sh.compute_cost(10, None) is None and sh.compute_cost(-1, rates[0]) is None)

u = {"status": "attributed", "calls": 1, "input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "by_model": {}, "compute": [{"resource": "gpu", "seconds": 1800, "rate": "A10G on-demand"}, {"resource": "cpu", "seconds": 7200, "rate": "c6i.4xlarge"}]}
ls = sh.lines_from_compute(u, at=datetime(2026, 10, 20), rates=rates)
check("each piece of machine time becomes one line with its cost and where the rate came from", len(ls) == 2 and abs(ls[0]["usd"] - 0.75) < 1e-12 and abs(ls[1]["usd"] - 1.36) < 1e-12 and ls[0]["unit_kind"] == "gpu_seconds" and ls[1]["unit_kind"] == "cpu_seconds" and "vendor price list" in ls[0]["source"], ls)
bad = sh.lines_from_compute({"compute": [{"resource": "gpu", "seconds": 60, "rate": "H100"}, {"resource": "tpu", "seconds": 5, "rate": "x"}, {"resource": "gpu", "seconds": "lots", "rate": "A10G on-demand"}]}, at=datetime(2026, 10, 20), rates=rates)
check("a machine with no rate, an unknown resource and an unreadable duration are each an UNKNOWN line that says why (never dropped, never zero)", len(bad) == 3 and all(b["usd"] is None and not b["known"] for b in bad) and "no hourly rate named 'H100'" in bad[0]["source"] and "cannot be read" in bad[1]["source"] and "cannot be read" in bad[2]["source"], bad)
check("an execution that reports no machine time has no compute lines", sh.lines_from_compute({"status": "attributed"}, at=datetime(2026, 10, 20), rates=rates) == [] and sh.lines_from_compute(None, at=datetime(2026, 10, 20), rates=rates) == [])

# ── as cost lines ──────────────────────────────────────────────────────────────────────────────────────────────────────
result = {"case_id": "C1", "repetition": 1, "status": "passed", "operation": "chat", "usage": u, "llm_calls": None, "metric_scores": [], "retry_usage": [], "started_at": datetime(2026, 10, 20)}
lines = cl.lines_for_result("RUN", result, table=PriceTable.builtin(), candidate="self/llama", mode="agent", synthetic=False, compute_rates=rates, at=datetime(2026, 10, 20))
sl = [l for l in lines if l["component"] == "self_hosted"]
check("machine time is a self_hosted cost line in seconds, priced from the recorded rate, an estimate (nothing was invoiced yet)", len(sl) == 2 and {l["unit_kind"] for l in sl} == {"gpu_seconds", "cpu_seconds"} and abs(sum(l["usd"] for l in sl) - 2.11) < 1e-9
      and all(l["cost_kind"] == "estimated" and l["provider"] is None for l in sl) and sl[0]["input_units"] == 1800.0 and "recorded from" in sl[0]["source"], sl)
check("a machine with no rate is an unknown self_hosted line, so the run's cost is a lower bound and says so", (lambda x: len(x) == 1 and x[0]["usd"] is None and x[0]["cost_kind"] == "unknown")(
    [l for l in cl.lines_for_result("RUN", {**result, "usage": {**u, "compute": [{"resource": "gpu", "seconds": 60, "rate": "H100"}]}}, table=PriceTable.builtin(), candidate="self/llama", mode="agent", synthetic=False, compute_rates=rates, at=datetime(2026, 10, 20)) if l["component"] == "self_hosted"]))
check("without any rates passed, machine time is unknown rather than free", all(l["usd"] is None for l in cl.lines_for_result("RUN", result, table=PriceTable.builtin(), candidate="self/llama", mode="agent", synthetic=False) if l["component"] == "self_hosted"))
check("identical lines get one identity each, and two different machines get different ones", len({l["usage_ref"] for l in sl}) == 2 and [l["usage_ref"] for l in sl] == [l["usage_ref"] for l in cl.lines_for_result("RUN", result, table=PriceTable.builtin(), candidate="self/llama", mode="agent", synthetic=False, compute_rates=rates, at=datetime(2026, 10, 20)) if l["component"] == "self_hosted"])
check("the run-level check counts self-hosted lines, and the token check ignores their seconds", cl.check_run({"known_cost_usd": 2.11, "unknown_cost_executions": 0}, [result], lines) == [], cl.check_run({"known_cost_usd": 2.11, "unknown_cost_executions": 0}, [result], lines))
print("FAILED" if FAILS else "PASS: all self-hosted costing tests, 0 failed")
sys.exit(1 if FAILS else 0)
