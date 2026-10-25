"""The cost API against a running tenant-service with real tokens (a Super Admin and an ordinary user): who may use it, what it refuses, the statement and
reconciliation flow, the detailed usage records and the confirmed / estimated / unknown split. Statements and lines can never be deleted, so run this against
the ISOLATED evaluation stack; it uses a random past period of its own.

Run: docker exec eval-tenant-service python test_eval_costs_api.py
"""
import asyncio
import random
import sys
import uuid
from datetime import date, datetime, timedelta

import httpx
from sqlmodel import select

import database
from routers.auth import create_access_token
from shared.models.core import Role, User
from shared.models.evaluation import EvalCostLine, EvalProviderStatement

BASE = "http://localhost:8001"
FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


async def setup():
    async with database._session_factory() as s:
        sa = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
        admin = (await s.exec(select(User).where(User.role_id == sa.id, User.is_deleted == False))).first()  # noqa: E712
        other = (await s.exec(select(User).where(User.role_id != sa.id, User.is_deleted == False))).first()    # noqa: E712
        tokens = create_access_token({"sub": str(admin.id)}), create_access_token({"sub": str(other.id)}), str(admin.id)
        used = {d.year for d in (await s.exec(select(EvalProviderStatement.period_start))).all()} | {d.year for d in (await s.exec(select(EvalCostLine.incurred_at))).all()}
        year = random.choice([y for y in range(1960, 2000) if y not in used])          # statements and lines are permanent: a year this test used before is not used again
        month_start = datetime(year, 5, 1)
        run = f"t-costapi-{uuid.uuid4().hex[:8]}"
        for usd, kind, model in ((6.0, "estimated", "gpt-4.1-2025-04-14"), (3.5, "estimated", "gpt-4.1-2025-04-14"), (None, "unknown", None)):
            s.add(EvalCostLine(run_id=run, case_id="C1", component="agent_llm", provider="openai", model=model, unit_kind="tokens", input_units=1000, output_units=100, cached_units=0, usd=usd,
                               cost_kind=kind, source="api test", usage_ref=uuid.uuid4().hex[:40], incurred_at=month_start + timedelta(days=9)))
        await s.commit()
        return tokens, year, run


async def main() -> int:
    (admin, other, admin_id), year, run = await setup()
    A, O = {"Authorization": f"Bearer {admin}"}, {"Authorization": f"Bearer {other}"}
    body = {"provider": "openai", "period_start": f"{year}-05-01", "period_end": f"{year}-05-31", "billed_usd": 12.0, "reference": "INV-API", "source": "api test: typed from the usage page",
            "billed_input_tokens": 3000, "billed_output_tokens": 300}
    async with httpx.AsyncClient(base_url=BASE, timeout=60) as c:
        for path in ("/eval/costs/statements", "/eval/costs/lines", "/eval/costs/certainty", "/eval/costs/attribution", "/eval/costs/rates", "/eval/costs/overview"):
            check(f"anonymous callers are refused ({path})", (await c.get(path)).status_code == 401)
            check(f"an ordinary user is refused ({path})", (await c.get(path, headers=O)).status_code == 403)
        check("an ordinary user cannot enter a statement", (await c.post("/eval/costs/statements", headers=O, json=body)).status_code == 403)
        check("an ordinary user cannot record a rate", (await c.post("/eval/costs/rates", headers=O, json={"currency": "XTS", "units_per_usd": 50, "effective_from": f"{year}-05-01", "source": "x"})).status_code == 403)
        for what, bad in (("an unknown provider", {**body, "provider": "acme"}), ("a negative bill", {**body, "billed_usd": -1}), ("no source", {**body, "source": ""}), ("a blank source", {**body, "source": "  "}),
                          ("a period that ends first", {**body, "period_start": f"{year}-05-20", "period_end": f"{year}-05-10"}), ("a future period", {**body, "period_start": "2999-01-01", "period_end": "2999-01-31"}),
                          ("a tolerance over 50%", {**body, "tolerance_pct": 80}), ("negative tokens", {**body, "billed_input_tokens": -5})):
            check(f"refused: {what}", (await c.post("/eval/costs/statements", headers=A, json=bad)).status_code == 422)

        r = await c.post("/eval/costs/statements", headers=A, json=body)
        d = r.json()
        check("a statement is entered and reconciled at once: the lines (6.0 + 3.5, one unpriced) fall short of 12.0, so it is incomplete", r.status_code == 201 and d["reconciliation"]["status"] == "incomplete"
              and abs(d["reconciliation"]["recorded_usd"] - 9.5) < 1e-9 and d["reconciliation"]["unknown_lines"] == 1, r.text[:400])
        check("the reply explains the gap and which key the figure must come from", d["reconciliation"]["explanation"] and "key or project" in d["scope_note"])
        sid = d["statement"]["id"]
        check("an overlapping statement for the same provider is refused with the one it conflicts with", (lambda x: x.status_code == 409 and x.json()["detail"]["conflicts_with"] == sid)(
            await c.post("/eval/costs/statements", headers=A, json={**body, "period_start": f"{year}-05-15", "period_end": f"{year}-06-15"})))
        listed = (await c.get("/eval/costs/statements", headers=A, params={"provider": "openai"})).json()["statements"]
        mine = next(x for x in listed if x["id"] == sid)
        check("the list shows the statement with its live comparison and its last reconciliation", mine["live"]["status"] == "incomplete" and mine["last_reconciliation"]["status"] == "incomplete" and not mine["superseded"])
        r = await c.post(f"/eval/costs/statements/{sid}/reconcile", headers=A, json={"note": "checking again after the late run"})
        check("a person can reconcile again with a note", r.status_code == 200 and r.json()["note"] == "checking again after the late run", r.text[:300])
        one = (await c.get(f"/eval/costs/statements/{sid}", headers=A)).json()
        check("the statement shows every reconciliation, newest first, with who and when", len(one["reconciliations"]) == 2 and one["reconciliations"][0]["note"] == "checking again after the late run" and one["reconciliations"][0]["by"] == admin_id)
        check("an unknown statement is a 404", (await c.get(f"/eval/costs/statements/{uuid.uuid4()}", headers=A)).status_code == 404 and (await c.post(f"/eval/costs/statements/{uuid.uuid4()}/reconcile", headers=A, json={})).status_code == 404)

        r = await c.post("/eval/costs/statements", headers=A, json={**body, "billed_usd": 9.5, "reference": "INV-API corrected", "supersedes_id": sid})
        check("a correction that agrees with the lines replaces it and matches", r.status_code == 201 and r.json()["reconciliation"]["status"] == "matched", r.text[:300])
        new_id = r.json()["statement"]["id"]
        check("the replaced statement is marked superseded and can no longer be reconciled", (await c.get(f"/eval/costs/statements/{sid}", headers=A)).json()["superseded"] is True
              and (await c.post(f"/eval/costs/statements/{sid}/reconcile", headers=A, json={})).status_code == 409)
        check("it cannot be replaced a second time", (await c.post("/eval/costs/statements", headers=A, json={**body, "supersedes_id": sid})).status_code == 409)

        cert = (await c.get("/eval/costs/certainty", headers=A, params={"from": f"{year}-05-01", "to": f"{year}-05-31"})).json()
        oa = cert["by_provider"]["openai"]
        check("the window's money is confirmed (the statement matches), with the unpriced line counted as unknown", abs(oa["confirmed_usd"] - 9.5) < 1e-9 and oa["estimated_usd"] == 0.0 and oa["unknown_lines"] == 1
              and any(x["statement_id"] == new_id for x in cert["confirmed_by"]), cert)
        cert2 = (await c.get("/eval/costs/certainty", headers=A, params={"from": f"{year}-07-01", "to": f"{year}-07-31"})).json()
        check("a window with no statement and no lines is empty", cert2["totals"]["total_usd"] == 0.0 and cert2["confirmed_by"] == [])
        check("a window that ends before it starts is refused", (await c.get("/eval/costs/certainty", headers=A, params={"from": "2001-05-10", "to": "2001-05-01"})).status_code == 422)

        r = (await c.get("/eval/costs/lines", headers=A, params={"run_id": run})).json()
        check("the detailed usage records list each line with its component, kind and source", r["total"] == 3 and abs(r["usd"] - 9.5) < 1e-9 and r["unknown_lines"] == 1 and all(x["source"] and x["component"] for x in r["lines"]), str(r)[:300])
        check("lines filter by kind", (await c.get("/eval/costs/lines", headers=A, params={"run_id": run, "kind": "unknown"})).json()["total"] == 1)
        check("lines filter by provider and period", (await c.get("/eval/costs/lines", headers=A, params={"provider": "openai", "from": f"{year}-05-01", "to": f"{year}-05-31"})).json()["total"] == 3)
        check("lines page", len((await c.get("/eval/costs/lines", headers=A, params={"run_id": run, "limit": 2})).json()["lines"]) == 2 and len((await c.get("/eval/costs/lines", headers=A, params={"run_id": run, "limit": 2, "offset": 2})).json()["lines"]) == 1)
        check("an unknown component or kind is refused", (await c.get("/eval/costs/lines", headers=A, params={"component": "magic"})).status_code == 422 and (await c.get("/eval/costs/lines", headers=A, params={"kind": "guess"})).status_code == 422)
        for what, bad in (("a currency of the wrong length", {"currency": "PKRS", "units_per_usd": 50, "effective_from": f"{year}-05-01", "source": "x"}), ("a zero rate", {"currency": "XTS", "units_per_usd": 0, "effective_from": f"{year}-05-01", "source": "x"}),
                          ("no source", {"currency": "XTS", "units_per_usd": 50, "effective_from": f"{year}-05-01", "source": ""}), ("USD", {"currency": "USD", "units_per_usd": 1, "effective_from": f"{year}-05-01", "source": "x"}),
                          ("a future day", {"currency": "XTS", "units_per_usd": 50, "effective_from": "2999-01-01", "source": "x"})):
            check(f"a rate is refused for {what}", (await c.post("/eval/costs/rates", headers=A, json=bad)).status_code == 422)
        r = await c.post("/eval/costs/rates", headers=A, json={"currency": "XTS", "units_per_usd": 50.0, "effective_from": f"{year}-05-01", "source": "api test: typed"})
        check("a rate is recorded with who and where from", r.status_code == 201 and r.json()["rate"]["units_per_usd"] == 50.0 and r.json()["rate"]["recorded_by"] == admin_id and r.json()["rate"]["source"] == "api test: typed", r.text[:300])
        listed = (await c.get("/eval/costs/rates", headers=A)).json()
        check("the rates list shows the currency with its history and the one in force", listed["base"] == "USD" and listed["currencies"]["XTS"]["current"] is not None and any(h["id"] == r.json()["rate"]["id"] for h in listed["currencies"]["XTS"]["history"]))
        tr = (await c.get("/eval/costs/trends", headers=A, params={"from": f"{year}-05-01", "to": f"{year}-05-31", "currency": "XTS"})).json()
        check("trends in a second currency convert each day at the rate in force then (9.5 dollars x 50), the dollars unchanged", abs(tr["total_usd"] - 9.5) < 1e-9 and abs(tr["converted_total"] - 475.0) < 1e-6 and tr["currency"] == "XTS" and tr["unconverted_usd"] == 0.0, str(tr)[:300])
        early = (await c.get("/eval/costs/trends", headers=A, params={"from": f"{year}-04-01", "to": f"{year}-04-30", "currency": "XTS"})).json()
        check("a window before any rate reports no conversion rather than another rate", early["converted_total"] == 0.0 and early["total_usd"] == 0.0)
        check("a currency code of the wrong length is refused on trends", (await c.get("/eval/costs/trends", headers=A, params={"currency": "PKRS"})).status_code == 422)
        ov = (await c.get("/eval/costs/overview", headers=A)).json()
        check("the overview carries every block the page opens with", all(k in ov for k in ("budget", "month", "today_usd", "trend", "running", "statements", "attribution", "anomalies", "recommendations", "rate")), list(ov))
        check("its budget has both periods, its trend is the last 30 days, and its month starts on the 1st", set(ov["budget"]["periods"]) == {"day", "month"} and len(ov["trend"]["points"]) == 30 and ov["month"]["from"].endswith("-01"))
        check("its certainty split adds up to the month's money", abs(ov["month"]["certainty"]["confirmed_usd"] + ov["month"]["certainty"]["estimated_usd"] - ov["month"]["certainty"]["total_usd"]) < 1e-6)
        check("the overview in a second currency says which rate it used", (await c.get("/eval/costs/overview", headers=A, params={"currency": "XTS"})).json()["rate"]["currency"] == "XTS")
        one = (await c.get("/eval/costs/benchmarks", headers=A, params={"benchmark_id": "no-such-benchmark"})).json()
        check("benchmark spending can be asked for one benchmark", one["count"] == 0 and one["benchmarks"] == [])
        a = (await c.get("/eval/costs/attribution", headers=A)).json()
        check("the attribution check answers for every run", "runs" in a and "with_problems" in a and a["checked"] == len(a["runs"]))
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
