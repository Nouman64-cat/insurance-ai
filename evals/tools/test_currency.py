"""Unit tests of the currency conversion (shared/evaluation/currency.py) and of the spend series in a second currency. No database.

Run: python evals/tools/test_currency.py
"""
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.evaluation import cost_analytics as ca  # noqa: E402
from shared.evaluation import currency as cur  # noqa: E402

FAILS = 0


def check(name, ok, detail=""):
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {str(detail)[:400]}" if detail and not ok else ""))


def R(day, units, created=None):
    return {"units_per_usd": units, "effective_from": datetime(2026, 10, day), "created_at": created or datetime(2026, 10, day, 8)}


rates = [R(1, 280.0), R(15, 290.0)]
check("the rate in force is the latest one effective on or before the day", cur.rate_on(rates, datetime(2026, 10, 10))["units_per_usd"] == 280.0 and cur.rate_on(rates, datetime(2026, 10, 15))["units_per_usd"] == 290.0
      and cur.rate_on(rates, date(2026, 10, 31))["units_per_usd"] == 290.0)
check("before the first recorded rate there is none (never another day's rate)", cur.rate_on(rates, datetime(2026, 9, 30)) is None and cur.rate_on([], datetime(2026, 10, 1)) is None)
check("two rates for the same day: the one recorded last wins", cur.rate_on([R(5, 281.0, datetime(2026, 10, 5, 8)), R(5, 283.0, datetime(2026, 10, 5, 17))], datetime(2026, 10, 9))["units_per_usd"] == 283.0)
check("a rate order does not matter", cur.rate_on(list(reversed(rates)), datetime(2026, 10, 20))["units_per_usd"] == 290.0)
check("conversion multiplies; an unknown amount or rate stays unknown", cur.convert(2.0, rates[0]) == 560.0 and cur.convert(None, rates[0]) is None and cur.convert(2.0, None) is None and cur.convert(0.0, rates[0]) == 0.0)
f = cur.rate_for(rates)
check("a rate function answers for any moment", f(datetime(2026, 10, 3, 23, 59)) == 280.0 and f(datetime(2026, 10, 15, 0, 1)) == 290.0 and f(datetime(2026, 1, 1)) is None)
check("a rate that moves a lot gets a warning, a small move does not, the first rate does not", cur.change_warning(rates[0], 350.0) is not None and "+25.0%" in cur.change_warning(rates[0], 350.0)
      and cur.change_warning(rates[0], 285.0) is None and cur.change_warning(None, 280.0) is None and cur.change_warning(rates[0], 200.0) is not None)
check("amounts read naturally in each currency", cur.money(0.0034, "USD") == "$0.0034" and cur.money(12.5, "USD") == "$12.50" and cur.money(1234.5, "USD") == "$1,234.50" and cur.money(0, "USD") == "$0"
      and cur.money(1234.5, "PKR") == "1,234 PKR" and cur.money(12.5, "PKR") == "12.50 PKR" and cur.money(None, "PKR") == "unknown")


def L(day, usd, component="agent_llm"):
    return {"incurred_at": datetime(2026, 10, day, 12), "usd": usd, "component": component, "provider": "openai", "model": "gpt-4.1"}


lines = [L(10, 1.0), L(10, 0.5, "judge"), L(20, 2.0), L(20, None), L(30, 1.0)]
s = ca.spend_series(lines, bucket="day", group_by="component", rate_for=f)
p10 = next(p for p in s["points"] if p["start"] == "2026-10-10")
p20 = next(p for p in s["points"] if p["start"] == "2026-10-20")
check("each day is converted at the rate in force that day (280 on the 10th, 290 on the 20th)", p10["converted"]["total"] == 420.0 and p20["converted"]["total"] == 580.0, (p10["converted"], p20["converted"]))
check("the split by component is converted too, and adds up to the day", p10["converted"]["by_group"] == {"agent_llm": 280.0, "judge": 140.0})
check("the window's converted total is the sum of its days, not the dollar total at one rate", s["converted_total"] == 420.0 + 580.0 + 290.0 and s["converted_total"] != round(s["total_usd"] * 290.0, 4))
check("the running converted total grows", s["points"][-1]["converted"]["cumulative"] == s["converted_total"])
early = ca.spend_series([L(10, 1.0)], bucket="day", rate_for=cur.rate_for([R(12, 300.0)]))
check("money on a day with no rate yet is not converted at another rate: it is reported in dollars as unconverted", early["converted_total"] == 0.0 and early["unconverted_usd"] == 1.0 and early["points"][0]["converted"]["unconverted_usd"] == 1.0, early)
w = ca.spend_series(lines, bucket="week", rate_for=f)
check("a bucket wider than a day still converts line by line (a rate change inside it is respected)", abs(w["converted_total"] - s["converted_total"]) < 1e-9)
check("without a rate function nothing about conversion is added", "converted_total" not in ca.spend_series(lines) and "converted" not in ca.spend_series(lines)["points"][0])
print("FAILED" if FAILS else "PASS: all currency tests, 0 failed")
sys.exit(1 if FAILS else 0)
