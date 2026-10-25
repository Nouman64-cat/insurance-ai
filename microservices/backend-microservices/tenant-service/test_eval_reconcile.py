"""Provider billing reconciliation on real tables (Phase 7, M4), inside one transaction that is rolled back. The periods used are in 2001, where the platform has no
real lines, so nothing here depends on or touches the real spending.

Run: docker exec insurance-tenant-service python test_eval_reconcile.py
"""
import asyncio
import sys
import uuid
from datetime import date, datetime

from fastapi import HTTPException
from sqlmodel import select

import database
from services import eval_reconcile as svc
from shared.evaluation import cost_lines
from shared.models.core import User
from shared.models.evaluation import EvalCostLine, EvalProviderStatement, EvalReconciliation

FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


def line(run, provider, usd, *, model="gpt-4.1-2025-04-14", component="agent_llm", at=datetime(2001, 3, 10, 12), inp=1000, out=100, kind=None):
    return EvalCostLine(run_id=run, case_id="C", component=component, provider=provider, model=model, unit_kind="tokens", input_units=inp, output_units=out, cached_units=0, usd=usd,
                        cost_kind=kind or ("unknown" if usd is None else "estimated"), source="test", usage_ref=uuid.uuid4().hex[:40], incurred_at=at)


async def refused(coro, code: int) -> bool:
    try:
        await coro
        return False
    except HTTPException as e:
        return e.status_code == code


async def main() -> int:
    async with database._session_factory() as s:
        try:
            uid = (await s.exec(select(User.id).limit(1))).first()
            run = f"t-recon-{uuid.uuid4().hex[:6]}"
            s.add_all([line(run, "openai", 6.00), line(run, None, 0.50, model="openai/gpt-4o", component="judge"),          # a judge line written before the provider was read from its label
                       line(run, "openai", None, model=None), line(run, "gemini", 1.00, model="gemini-2.5-flash"), line(run, "openai", 9.0, at=datetime(2001, 4, 2))])   # outside the period
            await s.flush()
            rec = await svc.recorded(s, "openai", *svc.period_of(date(2001, 3, 1), date(2001, 3, 31)))
            check("the recorded figure is the provider's priced lines in the period, with the unknown ones counted and not summed as 0", abs(rec["usd"] - 6.5) < 1e-9 and rec["lines"] == 3 and rec["unknown_lines"] == 1, rec)
            check("a judge line stored without a provider is read from its provider/model label", rec["by_component"]["judge"]["usd"] == 0.5)
            check("another provider's lines and lines outside the period are not counted", abs((await svc.recorded(s, "gemini", *svc.period_of(date(2001, 3, 1), date(2001, 3, 31))))["usd"] - 1.0) < 1e-9)
            check("tokens are summed over the same lines", rec["tokens"] == {"input": 3000, "output": 300, "cached": 0}, rec["tokens"])

            first = await svc.create_statement(s, actor_id=uid, provider="openai", period_start=date(2001, 3, 1), period_end=date(2001, 3, 31), billed_usd=10.00, reference="INV-1",
                                               source="typed from the OpenAI usage page, project 'evaluation'", billed_tokens={"input": 3000, "output": 300}, note="first look")
            r1 = first["reconciliation"]
            check("billed more than recorded while a line is unpriced: incomplete (the gap may be those lines)", r1["status"] == "incomplete" and abs(r1["difference_usd"] - 3.5) < 1e-9, r1)
            check("creating a statement keeps its first reconciliation with who and why", r1["note"] == "first look" and (await s.exec(select(EvalReconciliation).where(EvalReconciliation.statement_id == uuid.UUID(first["statement"]["id"])))).all() != [])
            check("the page's scope note tells the person which key to take the figure from", "key or project" in first["scope_note"])
            st1 = uuid.UUID(first["statement"]["id"])

            s.add(line(run, "openai", 3.55))
            await s.flush()
            stmt1 = await s.get(EvalProviderStatement, st1)
            second = await svc.reconcile(s, stmt1, actor_id=uid, note="a late run was ingested")
            check("once the recorded lines reach the bill (within the tolerance) it matches, and says the figure is a lower bound", second["status"] == "matched" and any("lower bound" in e for e in second["explanation"]), second)
            check("each reconciliation is a new row: the history keeps both", len((await s.exec(select(EvalReconciliation).where(EvalReconciliation.statement_id == st1))).all()) == 2)

            check("a second statement for the same provider that overlaps is refused (one bill must not be counted twice)",
                  await refused(svc.create_statement(s, actor_id=uid, provider="openai", period_start=date(2001, 3, 20), period_end=date(2001, 4, 10), billed_usd=1, reference=None, source="x"), 409))
            ok = await svc.create_statement(s, actor_id=uid, provider="openai", period_start=date(2001, 4, 1), period_end=date(2001, 4, 30), billed_usd=9.0, reference=None, source="typed from the usage page")
            check("the next period, with nothing else overlapping, is accepted and matches its own lines", ok["reconciliation"]["status"] == "matched", ok["reconciliation"])
            check("the same period for another provider is accepted", (await svc.create_statement(s, actor_id=uid, provider="gemini", period_start=date(2001, 3, 1), period_end=date(2001, 3, 31), billed_usd=1.0,
                                                                                                  reference=None, source="typed"))["reconciliation"]["status"] == "matched")
            check("a period that ends before it starts is refused", await refused(svc.create_statement(s, actor_id=uid, provider="openai", period_start=date(2001, 5, 5), period_end=date(2001, 5, 1), billed_usd=1, reference=None, source="x"), 422))
            check("days that have not happened yet are refused", await refused(svc.create_statement(s, actor_id=uid, provider="openai", period_start=date(2999, 1, 1), period_end=date(2999, 1, 2), billed_usd=1, reference=None, source="x"), 422))
            check("a figure with no source is refused", await refused(svc.create_statement(s, actor_id=uid, provider="openai", period_start=date(2001, 6, 1), period_end=date(2001, 6, 2), billed_usd=1, reference=None, source="  "), 422))
            check("an unknown provider is refused", await refused(svc.create_statement(s, actor_id=uid, provider="acme", period_start=date(2001, 6, 1), period_end=date(2001, 6, 2), billed_usd=1, reference=None, source="x"), 422))

            repl = await svc.create_statement(s, actor_id=uid, provider="openai", period_start=date(2001, 3, 1), period_end=date(2001, 3, 31), billed_usd=12.0, reference="INV-1 corrected", source="typed again from the invoice",
                                              supersedes_id=st1)
            check("a correction replaces a statement for the same period, and is judged on its own figure (billed 12.00 vs 10.05 recorded)", repl["reconciliation"]["status"] in ("incomplete", "under_recorded"), repl["reconciliation"])
            listed = {x["id"]: x for x in await svc.list_statements(s, "openai")}
            check("the replaced statement is marked superseded and has no live comparison; the new one has", listed[str(st1)]["superseded"] and listed[str(st1)]["live"] is None and listed[repl["statement"]["id"]]["live"] is not None)
            check("a replaced statement cannot be replaced again", await refused(svc.create_statement(s, actor_id=uid, provider="openai", period_start=date(2001, 3, 1), period_end=date(2001, 3, 31), billed_usd=11, reference=None, source="x", supersedes_id=st1), 409))
            check("a replaced statement cannot be reconciled", await refused(svc.reconcile(s, stmt1, actor_id=uid), 409))
            check("a statement cannot be replaced by one of another provider", await refused(svc.create_statement(s, actor_id=uid, provider="gemini", period_start=date(2001, 3, 1), period_end=date(2001, 3, 31), billed_usd=1, reference=None, source="x", supersedes_id=st1), 422))

            # restore the matching correction to see certainty
            fix = await svc.create_statement(s, actor_id=uid, provider="openai", period_start=date(2001, 3, 1), period_end=date(2001, 3, 31), billed_usd=10.05, reference="INV-1 final", source="typed from the invoice",
                                             supersedes_id=uuid.UUID(repl["statement"]["id"]))
            check("a final correction that agrees with the lines matches", fix["reconciliation"]["status"] == "matched", fix["reconciliation"])
            cert = await svc.certainty(s, *svc.period_of(date(2001, 3, 1), date(2001, 3, 31)))
            oa, ge = cert["by_provider"]["openai"], cert["by_provider"]["gemini"]
            check("in a matched period the provider's recorded money is CONFIRMED, not estimated", abs(oa["confirmed_usd"] - 10.05) < 1e-9 and oa["estimated_usd"] == 0.0, oa)
            check("the unpriced line is counted as unknown and sits in no total", oa["unknown_lines"] == 1 and abs(oa["total_usd"] - 10.05) < 1e-9)
            check("a provider whose statement also matches is confirmed; the totals add up", abs(ge["confirmed_usd"] - 1.0) < 1e-9 and abs(cert["totals"]["confirmed_usd"] + cert["totals"]["estimated_usd"] - cert["totals"]["total_usd"]) < 1e-9, cert["totals"])
            wide = await svc.certainty(s, *svc.period_of(date(2001, 3, 1), date(2001, 4, 30)))
            check("a wider window splits confirmed from estimated by period", abs(wide["by_provider"]["openai"]["confirmed_usd"] - (10.05 + 9.0)) < 1e-9, wide["by_provider"]["openai"])
            none = await svc.certainty(s, *svc.period_of(date(2001, 7, 1), date(2001, 7, 31)))
            check("a window with nothing recorded is all zeros", none["totals"]["total_usd"] == 0.0 and none["confirmed_by"] == [])
            check("only statements that match right now confirm anything", all(p["statement_id"] != str(st1) for p in await svc.matched_periods(s)))
        finally:
            await s.rollback()
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
