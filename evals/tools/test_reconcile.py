"""Unit tests of the reconciliation arithmetic (shared/evaluation/reconcile.py). No database.

Run: python evals/tools/test_reconcile.py
"""
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.evaluation import reconcile as rc  # noqa: E402

FAILS = 0


def check(name, ok, detail=""):
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {str(detail)[:400]}" if detail and not ok else ""))


def cmp(billed, recorded, unknown=0, lines=10, **kw):
    return rc.compare(billed_usd=billed, recorded_usd=recorded, unknown_lines=unknown, line_count=lines, **kw)


check("the allowed difference is a percentage of the bill, never less than the fixed floor", rc.allowed_difference(100.0) == 5.0 and rc.allowed_difference(0.40) == 0.05 and rc.allowed_difference(0.0) == 0.05)
r = cmp(10.00, 9.80)
check("within the tolerance: matched, and it confirms the recorded amounts", r["status"] == "matched" and r["confirms"] and r["difference_usd"] == 0.2, r)
check("exactly at the tolerance still matches; one cent beyond does not", cmp(100, 95.0)["status"] == "matched" and cmp(100, 94.99)["status"] == "under_recorded")
r = cmp(10.00, 6.00)
check("billed clearly more, every line priced: under-recorded (usage was not attributed), and it does not confirm", r["status"] == "under_recorded" and not r["confirms"] and r["difference_usd"] == 4.0 and "not attributed" in r["explanation"][0], r)
r = cmp(10.00, 6.00, unknown=3)
check("billed more with lines that could not be priced: incomplete, not under-recorded", r["status"] == "incomplete" and "3 line(s)" in r["explanation"][0], r)
r = cmp(10.00, 14.00)
check("recorded clearly more than billed: over-recorded", r["status"] == "over_recorded" and r["difference_usd"] == -4.0 and "out of date" in r["explanation"][0], r)
r = cmp(10.00, 9.9, unknown=2)
check("a match with unknown lines still matches but says the recorded figure is a lower bound", r["status"] == "matched" and any("lower bound" in e for e in r["explanation"]), r)
r = cmp(5.00, 0.0, lines=0)
check("a bill with nothing recorded at all says so", r["status"] == "under_recorded" and "no usage at all" in r["explanation"][0], r)
r = cmp(0.0, 0.0, lines=0)
check("nothing billed and nothing recorded is a match", r["status"] == "matched" and r["difference_pct"] == 0.0)
check("nothing billed but something recorded is over-recorded", cmp(0.0, 3.0)["status"] == "over_recorded")

t = rc.compare_tokens({"input": 1_000_000, "output": 200_000}, {"input": 995_000, "output": 200_000, "cached": 0})
check("token totals within 2% agree, and only the fields the provider showed are compared", t["all_match"] and set(t) == {"input", "output", "all_match"} and t["input"]["difference"] == 5000, t)
check("no token totals given: nothing is compared", rc.compare_tokens(None, {"input": 5}) is None and rc.compare_tokens({"input": None}, {"input": 5}) is None)
r = cmp(10.0, 6.0, billed_tokens={"input": 1_000_000, "output": 100_000}, recorded_tokens={"input": 1_000_000, "output": 100_000})
check("dollars differ but tokens agree: the difference is in the prices", r["status"] == "under_recorded" and any("prices used" in e for e in r["explanation"]), r["explanation"])
r = cmp(10.0, 6.0, billed_tokens={"input": 1_000_000, "output": 100_000}, recorded_tokens={"input": 600_000, "output": 100_000})
check("the provider counted more input tokens than were attributed: missing attribution", any("more input tokens" in e and "not recorded" in e for e in r["explanation"]) and not r["tokens"]["all_match"], r["explanation"])
r = cmp(6.0, 10.0, billed_tokens={"input": 600_000}, recorded_tokens={"input": 1_000_000})
check("more tokens attributed than the provider counted is said the other way round", any("more input tokens were attributed" in e for e in r["explanation"]), r["explanation"])
check("a matching statement does not add token commentary", not any("token" in e for e in cmp(10, 10, billed_tokens={"input": 5}, recorded_tokens={"input": 9})["explanation"]))

start, end = datetime(2026, 10, 1), datetime(2026, 10, 31, 23, 59, 59)
matched = [{"provider": "openai", "start": start, "end": end}]
check("a priced line inside a matched period of its provider is confirmed", rc.classify_line("openai", datetime(2026, 10, 12), 0.5, matched) == "confirmed")
check("the same line is only estimated when its period is not matched", rc.classify_line("openai", datetime(2026, 10, 12), 0.5, []) == "estimated")
check("a line of another provider or outside the period is estimated", rc.classify_line("gemini", datetime(2026, 10, 12), 0.5, matched) == "estimated" and rc.classify_line("openai", datetime(2026, 11, 2), 0.5, matched) == "estimated")
check("a line that could not be priced is unknown, even inside a matched period", rc.classify_line("openai", datetime(2026, 10, 12), None, matched) == "unknown")
check("a line with no provider cannot be confirmed", rc.classify_line(None, datetime(2026, 10, 12), 0.5, matched) == "estimated")
check("periods overlap when they share any moment", rc.overlaps(start, end, datetime(2026, 10, 31), datetime(2026, 11, 5)) and not rc.overlaps(start, end, datetime(2026, 11, 1), datetime(2026, 11, 5)))
print("FAILED" if FAILS else "PASS: all reconciliation tests, 0 failed")
sys.exit(1 if FAILS else 0)
