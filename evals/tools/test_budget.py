"""Unit tests of the budget arithmetic (shared/evaluation/budget.py). No database.

Run: python evals/tools/test_budget.py
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.evaluation import budget as b  # noqa: E402

FAILS = 0


def check(name, ok, detail=""):
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


now = datetime(2026, 10, 24, 15, 30, 12, 999)
check("a day starts at midnight UTC", b.window_start(now, "day") == datetime(2026, 10, 24))
check("a month starts on the 1st at midnight UTC", b.window_start(now, "month") == datetime(2026, 10, 1))
check("an aware time is converted to UTC first", b.window_start(datetime(2026, 10, 24, 1, 0, tzinfo=timezone.utc), "day") == datetime(2026, 10, 24))
try:
    b.window_start(now, "week")
    check("an unknown period is refused", False)
except ValueError:
    check("an unknown period is refused", True)

r = b.evaluate(None, 5, 1, 2)
check("no limit: allowed, whatever the spend", r["status"] == "no_limit" and r["allowed"] and r["remaining_usd"] is None)
r = b.evaluate(10, 2, 1, 3)
check("well inside the limit: ok, allowed, remaining counts spent and reserved", r["status"] == "ok" and r["allowed"] and r["remaining_usd"] == 7 and r["projected_usd"] == 6 and r["used_pct"] == 60.0, r)
r = b.evaluate(10, 2, 1, 5)
check("at 80% or more: warning, still allowed", r["status"] == "warning" and r["allowed"] and r["used_pct"] == 80.0, r)
r = b.evaluate(10, 2, 1, 8)
check("passing the limit with enforcement on: exceeded and refused", r["status"] == "exceeded" and not r["allowed"] and "above" in r["message"], r)
r = b.evaluate(10, 2, 1, 8, enforce=False)
check("passing the limit with enforcement off: exceeded but allowed (a warning only)", r["status"] == "exceeded" and r["allowed"], r)
check("exactly reaching the limit is allowed (the limit is the most you may spend)", b.evaluate(10, 2, 1, 7.0)["projected_usd"] == 10 and b.evaluate(10, 2, 1, 7.0)["allowed"])
check("one cent over is refused", not b.evaluate(10, 2, 1, 7.01)["allowed"])
r = b.evaluate(10, 2, 1, None)
check("unknown cost, money left: allowed with a note that only committed money was checked", r["allowed"] and r["status"] == "ok" and "could not be estimated" in r["message"], r)
r = b.evaluate(10, 9, 1.5, None)
check("unknown cost against a limit that is used up: refused, never treated as free", r["status"] == "exceeded" and not r["allowed"], r)
r = b.evaluate(10, 9, 1.5, 0.0)
check("a request known to be free is allowed even when the period is over (it spends nothing), and the status still says exceeded", r["status"] == "exceeded" and r["allowed"], r)
check("a zero limit refuses any spend but allows a free request", not b.evaluate(0, 0, 0, 0.01)["allowed"] and b.evaluate(0, 0, 0, 0.0)["allowed"])
check("reserved money counts as committed", b.evaluate(10, 0, 9, 2)["status"] == "exceeded" and not b.evaluate(10, 0, 9, 2)["allowed"])
o = b.overall({"day": b.evaluate(5, 4, 0, 2), "month": b.evaluate(100, 4, 0, 2)})
check("overall: refused when any enforced period refuses, and says which", not o["allowed"] and o["refused_by"] == ["day"] and o["status"] == "exceeded" and any(m.startswith("day:") for m in o["messages"]), o)
o = b.overall({"day": b.evaluate(None, 4, 0, 2), "month": b.evaluate(100, 4, 0, 2)})
check("overall: allowed when every period allows", o["allowed"] and o["status"] == "ok" and o["refused_by"] == [])
check("overall: nothing configured is allowed", b.overall({})["allowed"])
print("FAILED" if FAILS else f"PASS: all budget tests, 0 failed")
sys.exit(1 if FAILS else 0)
