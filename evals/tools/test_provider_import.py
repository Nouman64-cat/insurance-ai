"""Unit tests of the provider usage export reader and the day-by-day comparison (shared/evaluation/provider_import.py). No database.

Run: python evals/tools/test_provider_import.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.evaluation import provider_import as pi  # noqa: E402

FAILS = 0


def check(name, ok, detail=""):
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {str(detail)[:400]}" if detail and not ok else ""))


csv1 = "date,model,input_tokens,output_tokens,cached_tokens,cost\n2026-10-22,gpt-4o-mini-2024-07-18,1000000,200000,0,0.27\n2026-10-22,gpt-4.1-2025-04-14,500000,50000,100000,1.30\n2026-10-23,gpt-4.1-2025-04-14,250000,20000,0,0.66\n2026-10-25,gpt-4o-mini,100,10,0,0.0001\n"
r = pi.parse_csv(csv1)
check("a usage export is read: period, billed total, token totals, per day and per model", r["ok"] and r["period_start"] == "2026-10-22" and r["period_end"] == "2026-10-25" and abs(r["billed_usd"] - 2.2301) < 1e-9
      and r["tokens"] == {"input": 1750100, "output": 270010, "cached": 100000} and set(r["by_day"]) == {"2026-10-22", "2026-10-23", "2026-10-25"}, r)
check("models are grouped by family: the provider's dated name and the plain name are one model", set(r["by_model"]) == {"gpt-4o-mini", "gpt-4.1"} and r["by_model"]["gpt-4o-mini"]["input"] == 1000100, r["by_model"])
check("it says which columns it used, and nothing was skipped", r["columns"]["usd"] == "cost" and r["columns"]["input"] == "input_tokens" and r["skipped_count"] == 0 and r["warnings"] == [])
csv2 = 'start_time,n_context_tokens_total,n_generated_tokens_total,n_cached_tokens_total,amount_value,snapshot_id\n1761091200,1000,100,0,"$1,234.50",gpt-4.1\n2026-10-23T10:00:00Z,10,1,0,0.5,gpt-4.1\n'
r2 = pi.parse_csv(csv2)
check("other column names, an epoch time, an ISO time, a $ and thousands separator are all understood", r2["ok"] and r2["period_start"] == "2025-10-22" and r2["period_end"] == "2026-10-23" and abs(r2["billed_usd"] - 1235.0) < 1e-9, r2)
check("a semicolon-separated export is read too", pi.parse_csv("date;model;cost\n2026-10-01;gpt-4.1;2,5\n".replace("2,5", "2.5"))["billed_usd"] == 2.5)
noc = pi.parse_csv("date,model,input_tokens,output_tokens\n2026-10-01,gpt-4.1,10,5\n")
check("an export with no cost column gives NO billed amount (never a made-up zero) and says to type it", noc["ok"] and noc["billed_usd"] is None and any("no cost column" in w for w in noc["warnings"]), noc)
nom = pi.parse_csv("date,cost\n2026-10-01,1.5\n")
check("an export with no token or model columns still gives the money, and says what it cannot compare", nom["billed_usd"] == 1.5 and nom["tokens"] is None and any("model" in w for w in nom["warnings"]) and "all models" in nom["by_model"])
bad = pi.parse_csv("date,model,cost\nnot a date,gpt-4.1,1\n2026-10-02,gpt-4.1,2\n2026-10-03,gpt-4.1,\n")
check("a row that cannot be read is skipped and counted with its reason, never guessed", bad["rows_used"] == 1 and bad["skipped_count"] == 2 and "could not be read" in bad["skipped"][0]["reason"] and "no cost and no tokens" in bad["skipped"][1]["reason"] and any("2 row(s)" in w for w in bad["warnings"]), bad)
check("no date column is refused, naming the columns it found", "No date column" in pi.parse_csv("a,b,c\n1,2,3\n")["error"] and "a, b, c" in pi.parse_csv("a,b,c\n1,2,3\n")["error"])
check("no cost or token column is refused", "No cost or token" in pi.parse_csv("date,model\n2026-10-01,x\n")["error"])
check("an empty file and a file of only headers are refused", not pi.parse_csv("")["ok"] and not pi.parse_csv("date,cost\n")["ok"])
check("a file that is too big is refused", not pi.parse_csv("date,cost\n" + "2026-10-01,1\n" * 600_000)["ok"])
check("model families drop only a date suffix", pi.model_family("gpt-4.1-2025-04-14") == "gpt-4.1" and pi.model_family("gpt-4o-mini-20240718") == "gpt-4o-mini" and pi.model_family("GPT-4.1") == "gpt-4.1" and pi.model_family(None) == "unknown" and pi.model_family("claude-sonnet-4-5") == "claude-sonnet-4-5")

# ── the day-by-day comparison ──────────────────────────────────────────────────────────────────────────────────────────
c = pi.compare_days(r["by_day"], r["by_model"], {"2026-10-22": 1.57, "2026-10-23": 0.66}, {"gpt-4o-mini-2024-07-18": 0.27, "gpt-4.1-2025-04-14": 1.96})
byd = {d["key"]: d for d in c["days"]}
check("days that agree match, including a day too small to matter (a hundredth of a cent billed, nothing recorded)", all(d["verdict"] == "matches" for d in c["days"]) and c["days_billed_not_recorded"] == [] and c["explanation"] == ["Every day and every model agrees with what was recorded."], c["days"])
c2 = pi.compare_days({"2026-10-20": {"usd": 3.0}, "2026-10-21": {"usd": 1.0}, "2026-10-22": {"usd": 0.5}}, {"gpt-4.1": {"usd": 4.5}}, {"2026-10-21": 0.4, "2026-10-22": 0.9}, {"gpt-4.1-2025-04-14": 1.3})
v = {d["key"]: d["verdict"] for d in c2["days"]}
check("billed with nothing recorded, billed more than recorded, and recorded more than billed are three different verdicts", v == {"2026-10-20": "billed_not_recorded", "2026-10-21": "billed_more", "2026-10-22": "recorded_more"}, v)
check("the largest gaps come first", [d["key"] for d in c2["largest_days"]] == ["2026-10-20", "2026-10-21", "2026-10-22"])
check("the explanation says in words what each kind of day means", len(c2["explanation"]) >= 3 and any("nothing recorded" in e for e in c2["explanation"]) and any("not attributed" in e for e in c2["explanation"]) and any("prices" in e for e in c2["explanation"]), c2["explanation"])
check("models are compared by family, and a billed model that was never recorded is named", pi.compare_days({"d": {"usd": 2.0}}, {"gpt-4.1": {"usd": 2.0}, "gpt-5": {"usd": 1.0}}, {"d": 2.0}, {"gpt-4.1-2025-04-14": 2.0})["days_billed_not_recorded"] == [] and
      [m["key"] for m in pi.compare_days({"d": {"usd": 3.0}}, {"gpt-4.1": {"usd": 2.0}, "gpt-5": {"usd": 1.0}}, {"d": 2.0}, {"gpt-4.1-2025-04-14": 2.0})["models"] if m["verdict"] == "billed_not_recorded"] == ["gpt-5"])
check("when everything agrees it says so", pi.compare_days({"d": {"usd": 1.0}}, {"m": {"usd": 1.0}}, {"d": 1.0}, {"m": 1.0})["explanation"] == ["Every day and every model agrees with what was recorded."])
print("FAILED" if FAILS else "PASS: all provider import tests, 0 failed")
sys.exit(1 if FAILS else 0)
