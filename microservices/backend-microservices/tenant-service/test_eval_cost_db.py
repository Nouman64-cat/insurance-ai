"""The database enforces the rules of the cost records (Phase 7, M1), whatever the application does: lines, budgets, exchange rates and provider
statements are append-only; an unknown cost has no amount and a known one has; a ledger row is attributed once per component; a budget change
needs a reason; a rate must be positive and sourced. Everything runs in one transaction that is rolled back.

Run: docker exec insurance-tenant-service python test_eval_cost_db.py
"""
import asyncio
import sys
import uuid

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from database import engine

FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


async def refused(conn, sql: str, params: dict) -> str | None:
    try:
        async with conn.begin_nested():
            await conn.execute(text(sql), params)
        return None
    except (IntegrityError, DBAPIError) as exc:
        return str(exc.orig)[:300]


LINE = ("insert into eval_cost_lines (id, component, unit_kind, input_units, output_units, cached_units, usd, cost_kind, source, usage_ref, incurred_at, created_at) "
        "values (:id, :comp, 'tokens', 10, 5, 0, :usd, :kind, 'test', :ref, now(), now())")


async def main() -> int:
    async with engine.connect() as conn:
        outer = await conn.begin()
        try:
            user = (await conn.execute(text("select id from users limit 1"))).scalar()
            ref = f"ledger-{uuid.uuid4().hex[:8]}"
            ok = lambda **k: {"id": uuid.uuid4(), "comp": "candidate_llm", "usd": 0.01, "kind": "estimated", "ref": ref, **k}
            check("an estimated line with an amount is accepted", await refused(conn, LINE, ok()) is None)
            check("an unknown line has no amount", await refused(conn, LINE, ok(usd=None, kind="unknown", ref=None)) is None)
            check("an unknown cost cannot carry an amount (never 0 for 'not measured')", "ck_eval_cost_unknown_has_no_amount" in (await refused(conn, LINE, ok(usd=0.0, kind="unknown", ref=None)) or ""))
            check("a known cost must have an amount", "ck_eval_cost_unknown_has_no_amount" in (await refused(conn, LINE, ok(usd=None, kind="estimated", ref=None)) or ""))
            check("a negative amount is refused", "ck_eval_cost_usd" in (await refused(conn, LINE, ok(usd=-1, ref=None)) or ""))
            check("an unknown component is refused", "ck_eval_cost_component" in (await refused(conn, LINE, ok(comp="magic", ref=None)) or ""))
            check("an unknown cost kind is refused", "ck_eval_cost_kind" in (await refused(conn, LINE, ok(kind="guess", ref=None)) or ""))
            check("the same ledger row cannot be attributed twice to the same component", "uq_eval_cost_line_usage" in (await refused(conn, LINE, ok()) or ""))
            check("the same ledger row may be attributed to a different component", await refused(conn, LINE, ok(comp="judge")) is None)
            check("a line cannot be edited", "append-only" in (await refused(conn, "update eval_cost_lines set usd = 0 where usage_ref = :r", {"r": ref}) or ""))
            check("a line cannot be deleted", "append-only" in (await refused(conn, "delete from eval_cost_lines where usage_ref = :r", {"r": ref}) or ""))

            budget = "insert into eval_budget_limits (id, period, limit_usd, warn_at_pct, enforce, effective_from, set_by, reason, created_at) values (:id, :p, :l, :w, true, now(), :u, :r, now())"
            b = lambda **k: {"id": uuid.uuid4(), "p": "day", "l": 5.0, "w": 80, "u": user, "r": "test", **k}
            check("a budget limit with a reason is accepted", await refused(conn, budget, b()) is None)
            check("a limit of NULL (no limit) is accepted", await refused(conn, budget, b(l=None)) is None)
            check("a budget change needs a reason", "ck_eval_budget_reason" in (await refused(conn, budget, b(r="  ")) or ""))
            check("a budget period is a day or a month", "ck_eval_budget_period" in (await refused(conn, budget, b(p="week")) or ""))
            check("a negative limit is refused", "ck_eval_budget_limit" in (await refused(conn, budget, b(l=-1)) or ""))
            check("the warning level is 1 to 100 per cent", "ck_eval_budget_warn" in (await refused(conn, budget, b(w=0)) or ""))
            check("a budget row cannot be edited or deleted", "append-only" in (await refused(conn, "update eval_budget_limits set limit_usd = 99", {}) or "") and "append-only" in (await refused(conn, "delete from eval_budget_limits", {}) or ""))

            rate = "insert into eval_exchange_rates (id, currency, units_per_usd, effective_from, source, recorded_by, created_at) values (:id, :c, :r, now(), :s, :u, now())"
            x = lambda **k: {"id": uuid.uuid4(), "c": "PKR", "r": 280.5, "s": "State Bank of Pakistan, test", "u": user, **k}
            check("an exchange rate with a source is accepted", await refused(conn, rate, x()) is None)
            check("a rate must be positive", "ck_eval_exchange_rate_positive" in (await refused(conn, rate, x(r=0)) or ""))
            check("a rate needs a source", "ck_eval_exchange_rate_source" in (await refused(conn, rate, x(s=" ")) or ""))
            check("a currency is three capital letters", "ck_eval_exchange_rate_currency" in (await refused(conn, rate, x(c="Pkr")) or ""))
            check("a rate cannot be edited or deleted", "append-only" in (await refused(conn, "update eval_exchange_rates set units_per_usd = 1", {}) or "") and "append-only" in (await refused(conn, "delete from eval_exchange_rates", {}) or ""))

            stmt = ("insert into eval_provider_statements (id, provider, period_start, period_end, billed_usd, source, entered_by, created_at) "
                    "values (:id, 'openai', :s, :e, :b, :src, :u, now())")
            st = lambda **k: {"id": uuid.uuid4(), "s": "2026-10-01", "e": "2026-10-31", "b": 12.5, "src": "typed from the usage page", "u": user, **k}
            from datetime import datetime
            st2 = lambda **k: {k2: (datetime.fromisoformat(v) if k2 in ("s", "e") else v) for k2, v in st(**k).items()}
            check("a provider statement is accepted", await refused(conn, stmt, st2()) is None)
            check("a statement cannot end before it starts", "ck_eval_statement_period" in (await refused(conn, stmt, st2(e="2026-09-01")) or ""))
            check("a statement needs a source", "ck_eval_statement_source" in (await refused(conn, stmt, st2(src=" ")) or ""))
            check("a negative billed amount is refused", "ck_eval_statement_amount" in (await refused(conn, stmt, st2(b=-1)) or ""))
            check("a statement cannot be edited or deleted", "append-only" in (await refused(conn, "update eval_provider_statements set billed_usd = 1", {}) or "") and "append-only" in (await refused(conn, "delete from eval_provider_statements", {}) or ""))
        finally:
            await outer.rollback()
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
