"""Exchange rates on real tables (Phase 7, M6), inside one transaction that is rolled back: what is refused, how the rate in force is chosen, the warning for a rate that
moves a lot, and the spend series in a second currency read from the cost lines. The currency used is XTS (the ISO code reserved for testing) and the days are in 2001.

Run: docker exec insurance-tenant-service python test_eval_rates.py
"""
import asyncio
import sys
import uuid
from datetime import date, datetime

from fastapi import HTTPException
from sqlmodel import select

import database
from services import eval_analytics as an
from services import eval_rates as rates
from shared.models.core import User
from shared.models.evaluation import EvalComputeRate, EvalCostLine

FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


async def refused(coro, code=422) -> bool:
    try:
        await coro
        return False
    except HTTPException as e:
        return e.status_code == code


def line(usd, at, component="agent_llm"):
    return EvalCostLine(run_id="t-rates", case_id="C", component=component, provider="openai", model="gpt-4.1", unit_kind="tokens", input_units=1, output_units=1, cached_units=0, usd=usd,
                        cost_kind="estimated", source="test", usage_ref=uuid.uuid4().hex[:40], incurred_at=at)


async def main() -> int:
    async with database._session_factory() as s:
        try:
            uid = (await s.exec(select(User.id).limit(1))).first()
            add = lambda **k: rates.add_rate(s, actor_id=uid, **{"currency": "XTS", "units_per_usd": 100.0, "effective_from": date(2001, 3, 1), "source": "test: typed", **k})
            check("USD cannot be given a rate", await refused(add(currency="USD")))
            check("a currency is three letters", await refused(add(currency="PKRS")) and await refused(add(currency="P1R")))
            check("a rate must be a positive number", await refused(add(units_per_usd=0)) and await refused(add(units_per_usd=-3)) and await refused(add(units_per_usd=5_000_000)))
            check("a rate cannot take effect on a day that has not happened", await refused(add(effective_from=date(2999, 1, 1))))
            check("a rate needs a source", await refused(add(source="  ")))
            first = await add()
            check("the first rate is recorded with who and where from, no earlier rate and no warning", first["rate"]["currency"] == "XTS" and first["rate"]["source"] == "test: typed" and first["previous"] is None and first["warning"] is None, first)
            second = await add(units_per_usd=104.0, effective_from=date(2001, 3, 10))
            check("a small move is recorded without a warning, and names the rate it follows", second["warning"] is None and second["previous"]["units_per_usd"] == 100.0)
            third = await add(units_per_usd=150.0, effective_from=date(2001, 3, 20))
            check("a rate that moves more than 20% is still recorded, with a warning to check it", third["rate"]["units_per_usd"] == 150.0 and third["warning"] and "+44.2%" in third["warning"], third)
            check("lowercase codes are accepted and stored in capitals", (await add(currency="xts", units_per_usd=151.0, effective_from=date(2001, 3, 21)))["rate"]["currency"] == "XTS")
            ov = await rates.overview(s)
            check("the overview lists the currency with its history, newest first, and the rate in force today", ov["base"] == "USD" and [h["units_per_usd"] for h in ov["currencies"]["XTS"]["history"]][:2] == [151.0, 150.0]
                  and ov["currencies"]["XTS"]["current"]["units_per_usd"] == 151.0)
            f = await rates.rate_function(s, "XTS")
            check("the rate function answers for the day asked", f(datetime(2001, 3, 5)) == 100.0 and f(datetime(2001, 3, 10, 23)) == 104.0 and f(datetime(2001, 3, 25)) == 151.0 and f(datetime(2001, 2, 1)) is None)
            check("a currency with no rate has no current rate", await rates.current(s, "ZZZ") is None)

            s.add_all([line(1.0, datetime(2001, 3, 5, 9)), line(2.0, datetime(2001, 3, 12, 9), "judge"), line(3.0, datetime(2001, 3, 22, 9)), line(4.0, datetime(2001, 2, 20, 9))])
            await s.flush()
            tr = await an.trends(s, start=date(2001, 2, 15), end=date(2001, 3, 31), bucket="day", group_by="component", currency="XTS")
            by_day = {p["start"]: p for p in tr["points"]}
            check("each day is converted at the rate in force that day", by_day["2001-03-05"]["converted"]["total"] == 100.0 and by_day["2001-03-12"]["converted"]["total"] == 208.0 and by_day["2001-03-22"]["converted"]["total"] == 453.0, by_day["2001-03-12"])
            check("a day before any rate is not converted at another day's rate; its dollars are reported as unconverted", by_day["2001-02-20"]["converted"]["total"] == 0.0 and by_day["2001-02-20"]["converted"]["unconverted_usd"] == 4.0 and tr["unconverted_usd"] == 4.0)
            check("the window's converted total is the sum of its days", tr["converted_total"] == 100.0 + 208.0 + 453.0 and tr["currency"] == "XTS" and tr["rate_now"]["units_per_usd"] == 151.0)
            check("the dollars stay the dollars: the same series without a currency has no converted figures", "converted_total" not in await an.trends(s, start=date(2001, 3, 1), end=date(2001, 3, 31)))
            mo = await an.trends(s, start=date(2001, 3, 1), end=date(2001, 3, 31), bucket="month", currency="XTS")
            check("a month bucket converts line by line, not at one rate", mo["points"][0]["converted"]["total"] == 100.0 + 208.0 + 453.0)
            check("asking for USD changes nothing", "converted_total" not in await an.trends(s, start=date(2001, 3, 1), end=date(2001, 3, 31), currency="USD"))

            # ── what a machine costs per hour, for a self-hosted model ──────────────────────────────────────────────────────────
            cadd = lambda **k: rates.add_compute_rate(s, actor_id=uid, **{"name": "TEST-GPU-A10G", "resource": "gpu", "usd_per_hour": 1.2, "effective_from": date(2001, 3, 1), "source": "test: price list", **k})
            check("a machine must be named, sourced, gpu or cpu, with a sensible price, from a day that has happened", await refused(cadd(name=" ")) and await refused(cadd(source=" ")) and await refused(cadd(resource="tpu")) and await refused(cadd(usd_per_hour=-1))
                  and await refused(cadd(usd_per_hour=1e9)) and await refused(cadd(effective_from=date(2999, 1, 1))))
            c1 = await cadd()
            check("a machine's hourly rate is recorded with where it came from, and no warning for the first", c1["rate"]["usd_per_hour"] == 1.2 and c1["rate"]["source"] == "test: price list" and c1["warning"] is None, c1)
            c2 = await cadd(usd_per_hour=3.0, effective_from=date(2001, 3, 15))
            check("a rate that is more than half different from the last is recorded with a warning to check it", c2["warning"] and "+150%" in c2["warning"], c2)
            await cadd(resource="cpu", usd_per_hour=0.1)
            ov2 = await rates.compute_overview(s)
            gpu = next(m for m in ov2["machines"] if m["name"] == "TEST-GPU-A10G" and m["resource"] == "gpu")
            check("each machine and resource lists its rate in force today and its history, newest first", gpu["current"]["usd_per_hour"] == 3.0 and [h["usd_per_hour"] for h in gpu["history"]] == [3.0, 1.2] and any(m["name"] == "TEST-GPU-A10G" and m["resource"] == "cpu" for m in ov2["machines"]))
            allr = await rates.compute_rates(s)
            check("the recorded rates are available to the costing code in its own terms", any(r["name"] == "TEST-GPU-A10G" and r["resource"] == "gpu" and r["usd_per_hour"] == 3.0 for r in allr))
        finally:
            await s.rollback()
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
