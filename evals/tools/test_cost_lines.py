"""Unit tests of the cost lines (shared/evaluation/cost_lines.py): which component each call belongs to, how a result becomes lines, that an unknown
cost is never zero, that a line has one identity, and that the run-level checks catch a missing, doubled or mismatched attribution. No database.

Run: python evals/tools/test_cost_lines.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.evaluation import cost_lines as cl  # noqa: E402
from shared.evaluation.pricing import PriceTable  # noqa: E402

TABLE = PriceTable.builtin()                       # gpt-4.1: $2.00 in, $0.50 cached, $8.00 out per million tokens
FAILS = 0


def check(name, ok, detail=""):
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {str(detail)[:500]}" if detail and not ok else ""))


def tok(calls, i, o, c=0):
    return {"calls": calls, "input_tokens": i, "output_tokens": o, "cached_tokens": c}


def usage(by_service, **kw):
    by_model = {}
    for models in by_service.values():
        for m, v in models.items():
            b = by_model.setdefault(m, tok(0, 0, 0))
            for k in b:
                b[k] += v[k]
    calls = sum(b["calls"] for b in by_model.values())
    return {"status": "attributed", "calls": calls, "input_tokens": sum(b["input_tokens"] for b in by_model.values()), "output_tokens": sum(b["output_tokens"] for b in by_model.values()),
            "cached_tokens": sum(b["cached_tokens"] for b in by_model.values()), "by_model": by_model, "by_service": by_service, **kw}


def result(case="IND-AGT-001", rep=1, **kw):
    return {"case_id": case, "repetition": rep, "status": "passed", "operation": "chat", "usage": None, "llm_calls": None, "judge_cost_usd": None, "metric_scores": [], "retry_usage": [], **kw}


def lines(r, **kw):
    args = {"table": TABLE, "candidate": "openai/gpt-4.1", "mode": "agent", "synthetic": False, "pricing_version_id": "pv1", **kw}
    return cl.lines_for_result("RUN1", r, **args)


check("the provider is read from a provider/model label as well as from a bare model name", cl.provider_of("openai/gpt-4o") == "openai" and cl.provider_of("gemini-2.5-flash") == "gemini"
      and cl.provider_of("anthropic/claude-sonnet-4-5") == "anthropic" and cl.provider_of("google/gemini-2.5-pro") == "gemini" and cl.provider_of("models/gemini-embedding-001") == "gemini"
      and cl.provider_of("mock/mock-judge") == "mock" and cl.provider_of("gpt-4.1-2025-04-14") == "openai" and cl.provider_of(None) is None and cl.provider_of("acme/thing") is None)

# ── components ────────────────────────────────────────────────────────────────────────────────────────────────────────
f = lambda service, model="gpt-4.1-2025-04-14", **kw: cl.component_for(service, model, **{"operation": "chat", "candidate": "openai/gpt-4.1", "synthetic": False, "mode": "agent", **kw})
check("the chat agent itself is the agent", f("Chat Agent") == "agent_llm")
check("a specialist or helper of the agent is a subagent", all(f(s) == "subagent_llm" for s in ("Chat Agent — Claims Specialist", "Chat Agent — Plan Advisor", "Chat Agent — Title Generator")))
check("the OCR engine is OCR, whatever model it used", f("OCR Engine", "gpt-4o-mini") == "ocr")
check("an OCR case with no service name recorded is OCR by its operation", f(None, "gpt-4o-mini", operation="ocr.extract_customer") == "ocr")
check("an embedding model is an embedding, whoever called it", f("Chat Agent", "gemini-embedding-001") == "embedding" and f(None, "text-embedding-3-small") == "embedding")
check("a call answered by a model other than the one under test is a fallback", f("Chat Agent", "gemini-2.5-flash") == "fallback")
check("the provider's dated name of the model under test is the model under test", f("Chat Agent", "gpt-4.1-2025-04-14") == "agent_llm")
check("a scripted model is never called a fallback", f("Chat Agent", "mock-oracle", candidate="mock/mock-oracle", synthetic=True) == "agent_llm" and f("Chat Agent", "other", synthetic=True) == "agent_llm")
check("with no model under test named, nothing is a fallback", f("Chat Agent", "gemini-2.5-flash", candidate=None) == "agent_llm")
check("in a direct benchmark the model asked is the candidate", f(None, "gpt-4.1-2025-04-14", mode="direct", operation="chat") == "candidate_llm" and f(None, "gemini-2.5-flash", mode="direct") == "fallback")

# ── one execution becomes lines ───────────────────────────────────────────────────────────────────────────────────────
r = result(usage=usage({"Chat Agent": {"gpt-4.1-2025-04-14": tok(2, 40562, 85, 19968)}, "Chat Agent — Claims Specialist": {"gpt-4.1-2025-04-14": tok(1, 1000, 100)}}), llm_calls=3)
ls = lines(r)
check("each service and model is its own line, with its own tokens", len(ls) == 2 and {l["component"] for l in ls} == {"agent_llm", "subagent_llm"} and sum(l["input_units"] for l in ls) == 41562, ls)
agent = next(l for l in ls if l["component"] == "agent_llm")
want = ((40562 - 19968) * 2.0 + 19968 * 0.5 + 85 * 8.0) / 1e6
check("a line is priced from its tokens, with cached input at the cached rate", abs(agent["usd"] - want) < 1e-12 and agent["cost_kind"] == "estimated", (agent["usd"], want))
check("a line says where its number came from and which price version", "token ledger" in agent["source"] and TABLE.label in agent["source"] and agent["pricing_version_id"] == "pv1")
check("the lines add up to what the old per-model pricing gave", abs(cl.known_total(ls) - (want + (1000 * 2.0 + 100 * 8.0) / 1e6)) < 1e-12)
check("a line's identity is stable, and different for different components", [l["usage_ref"] for l in lines(r)] == [l["usage_ref"] for l in ls] and len({l["usage_ref"] for l in ls}) == 2 and all(len(l["usage_ref"]) == 40 for l in ls))

old = result(usage={"status": "attributed", "calls": 1, "input_tokens": 4061, "output_tokens": 233, "cached_tokens": 0, "by_model": {"gpt-4.1-2025-04-14": tok(1, 4061, 233)}}, llm_calls=1)
lo = lines(old)
check("a run that did not record service names still gets lines, and says the component is inferred", len(lo) == 1 and lo[0]["component"] == "agent_llm" and "inferred" in lo[0]["source"], lo)
check("a direct-mode run's calls are the candidate's", lines(old, mode="direct")[0]["component"] == "candidate_llm")
check("an OCR execution's calls are OCR", lines(result(operation="ocr.extract_customer", usage=usage({"OCR Engine": {"gpt-4o-mini": tok(1, 900, 40)}}), llm_calls=1))[0]["component"] == "ocr")
check("a call that no price table knows is an unknown line that still holds its tokens", (lambda x: x["usd"] is None and x["cost_kind"] == "unknown" and x["input_units"] == 500 and "no price" in x["source"])(
    lines(result(usage=usage({"Chat Agent": {"gpt-9-future": tok(1, 500, 5)}}), llm_calls=1), candidate=None)[0]))
partly = lines(result(usage=usage({"Chat Agent": {"gpt-4.1-2025-04-14": tok(1, 1000, 100)}, "Chat Agent — Plan Advisor": {"gpt-9-future": tok(1, 500, 5)}}), llm_calls=2), candidate=None)
check("a result with one priced and one unpriced model keeps the known money and flags the unknown", cl.known_total(partly) > 0 and sum(1 for l in partly if l["usd"] is None) == 1 and cl.unknown_executions(partly) == 1, partly)
check("scripted models are priced as free, not unknown", (lambda x: x["usd"] == 0.0 and x["cost_kind"] == "estimated")(lines(result(usage=usage({"Chat Agent": {"mock-oracle": tok(1, 100, 10)}}), llm_calls=1), candidate="mock/mock-oracle", synthetic=True)[0]))

# ── nothing known is never zero ───────────────────────────────────────────────────────────────────────────────────────
for status in ("missing", "unavailable", "ambiguous", "unknown"):
    one = lines(result(usage={"status": status, "calls": None, "note": "the ledger could not be read"}, llm_calls=None))
    check(f"usage '{status}' is ONE unknown line with no amount", len(one) == 1 and one[0]["usd"] is None and one[0]["cost_kind"] == "unknown" and "not known" in one[0]["source"], one)
check("a model call reported by the trace but with no usage at all is an unknown line", (lambda x: len(x) == 1 and x[0]["usd"] is None)(lines(result(usage=None, llm_calls=2))))
check("an execution that used no model has no lines (nothing was spent, and that is known)", lines(result(usage=None, llm_calls=None)) == [])
check("a skipped or blocked execution has no lines", lines(result(status="blocked", usage=None, llm_calls=3)) == [] and lines(result(status="skipped")) == [])

# ── retries, unattributed, judge ──────────────────────────────────────────────────────────────────────────────────────
final = usage({"Chat Agent": {"gpt-4.1-2025-04-14": tok(1, 2000, 100)}})
failed = usage({"Chat Agent": {"gpt-4.1-2025-04-14": tok(1, 900, 0)}})
withretry = lines(result(usage=final, llm_calls=1, retry_usage=[failed, failed]))
check("the spend of failed attempts is its own component, one line per attempt", sorted(l["component"] for l in withretry) == ["agent_llm", "retry", "retry"] and len({l["usage_ref"] for l in withretry}) == 3, withretry)
check("a retry line says which attempt it was and what it would have been", all("attempt" in l["source"] and "agent_llm" in l["source"] for l in withretry if l["component"] == "retry"))
check("a retry's money counts in the total", abs(cl.known_total(withretry) - ((2000 * 2.0 + 100 * 8.0) / 1e6 + 2 * (900 * 2.0) / 1e6)) < 1e-12)
check("an attempt that failed with an unknown usage is an unknown retry line", (lambda x: sum(1 for l in x if l["component"] == "retry" and l["usd"] is None) == 1)(lines(result(usage=final, llm_calls=1, retry_usage=[{"status": "missing", "calls": None}]))))
fr = usage({"Chat Agent": {"gpt-4.1-2025-04-14": tok(1, 800, 40)}}); fr["foreign"] = {"rows": 1, "input_tokens": 120, "output_tokens": 12, "cached_tokens": 0, "by_model": {"gpt-4o-mini": tok(1, 120, 12)},
                                                                                     "by_service": {"Chat Agent — Title Generator": {"gpt-4o-mini": tok(1, 120, 12)}}}
uf = lines(result(usage=fr, llm_calls=1))
check("rows with another thread id are unattributed spend, priced, and not hidden", sorted(l["component"] for l in uf) == ["agent_llm", "unattributed"] and next(l for l in uf if l["component"] == "unattributed")["usd"] > 0, uf)

jr = result(usage=None, metric_scores=[{"judge_model": "openai/gpt-4o-mini", "input_tokens": 3000, "output_tokens": 400, "judge_cost_usd": 0.0007}, {"judge_model": "openai/gpt-4o-mini", "input_tokens": 2000, "output_tokens": 300, "judge_cost_usd": 0.0005}],
            judge_cost_usd=0.0012)
jl = lines(jr)
check("the judge is one line per judge model, with the cost the judge service reported", len(jl) == 1 and jl[0]["component"] == "judge" and abs(jl[0]["usd"] - 0.0012) < 1e-12 and jl[0]["input_units"] == 5000 and jl[0]["output_units"] == 700, jl)
check("a judge cost reported only for the whole case is kept on the one judge model", (lambda x: len(x) == 1 and abs(x[0]["usd"] - 0.002) < 1e-12)(lines(result(usage=None, metric_scores=[{"judge_model": "openai/gpt-4o-mini", "input_tokens": 10, "output_tokens": 5}], judge_cost_usd=0.002))))
check("a judge that reported no cost is an unknown line, not free", (lambda x: len(x) == 1 and x[0]["usd"] is None)(lines(result(usage=None, metric_scores=[{"judge_model": "openai/gpt-4o-mini", "input_tokens": 10, "output_tokens": 5}], judge_cost_usd=None))))
check("no judge, no judge line", lines(result(usage=None)) == [])
check("the judge's unknowns are not counted as unknown executions (as before)", cl.unknown_executions(lines(result(usage=None, metric_scores=[{"judge_model": "x", "input_tokens": 1, "output_tokens": 1}]))) == 0)

# ── the run-level checks ──────────────────────────────────────────────────────────────────────────────────────────────
res = [result("A", 1, usage=final, llm_calls=1, retry_usage=[failed]), result("B", 1, usage=usage({"OCR Engine": {"gpt-4o-mini": tok(1, 900, 40)}}), llm_calls=1, operation="ocr.extract_customer"), result("C", 1, usage=None)]
ls = [l for r in res for l in lines(r)]
run = {"known_cost_usd": round(cl.known_total(ls), 6), "unknown_cost_executions": 0}
check("a run whose lines account for it exactly has no problems", cl.check_run(run, res, ls) == [], cl.check_run(run, res, ls))
check("a total that differs from the lines is reported", any("add up" in p for p in cl.check_run({**run, "known_cost_usd": run["known_cost_usd"] + 0.01}, res, ls)))
check("an unknown count that differs is reported", any("unknown cost" in p for p in cl.check_run({**run, "unknown_cost_executions": 1}, res, ls)))
check("a line missing for an execution that used a model is reported", any("A r1" in p for p in cl.check_run(run, res, [l for l in ls if l["case_id"] != "A"])))
check("tokens that are not in the lines are reported (a call attributed to nobody)", any("tokens" in p for p in cl.check_run(run, res, [l for l in ls if l["component"] != "retry"])))
check("a line recorded twice is reported", any("more than once" in p for p in cl.check_run(run, res, ls + [ls[0]])))
check("a line for an execution the run does not have is reported", any("do(es) not have" in p or "does not have" in p for p in cl.check_run(run, res, ls + [{**ls[0], "case_id": "ZZZ", "usage_ref": "x" * 40}])))
check("an execution with usage but a run that lost its lines altogether is reported", len(cl.check_run(run, res, [])) >= 2)
print("FAILED" if FAILS else "PASS: all cost line tests, 0 failed")
sys.exit(1 if FAILS else 0)
