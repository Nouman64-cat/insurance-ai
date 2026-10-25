"""Exchange rates for showing evaluation money in a second currency (PKR). A rate is recorded by a person, with where it came from and the day it takes effect, and is
never edited or deleted: a correction is a newer rate. The conversion logic is shared/evaluation/currency.py.
"""
from datetime import date, datetime, time
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import HTTPException
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.evaluation import currency as cur
from shared.models.evaluation import EvalComputeRate, EvalExchangeRate


def _out(r: EvalExchangeRate) -> Dict[str, Any]:
    return {"id": str(r.id), "currency": r.currency, "units_per_usd": r.units_per_usd, "effective_from": r.effective_from.date().isoformat(), "source": r.source,
            "recorded_by": str(r.recorded_by), "created_at": r.created_at}


async def rows(session: AsyncSession, currency: Optional[str] = None) -> List[EvalExchangeRate]:
    stmt = select(EvalExchangeRate).order_by(EvalExchangeRate.effective_from.desc(), EvalExchangeRate.created_at.desc())
    if currency:
        stmt = stmt.where(EvalExchangeRate.currency == currency)
    return list((await session.exec(stmt)).all())


def _plain(rs: List[EvalExchangeRate]) -> List[Dict[str, Any]]:
    return [{"units_per_usd": r.units_per_usd, "effective_from": r.effective_from, "created_at": r.created_at, "row": r} for r in rs]


async def overview(session: AsyncSession) -> Dict[str, Any]:
    """Every currency with a recorded rate: the one in force today and the history."""
    out: Dict[str, Dict[str, Any]] = {}
    by: Dict[str, List[EvalExchangeRate]] = {}
    for r in await rows(session):
        by.setdefault(r.currency, []).append(r)
    today = datetime.utcnow()
    for code, rs in sorted(by.items()):
        now = cur.rate_on(_plain(rs), today)
        out[code] = {"current": _out(now["row"]) if now else None, "history": [_out(r) for r in rs]}
    return {"base": "USD", "currencies": out}


async def rate_function(session: AsyncSession, currency: str):
    """A function from a moment to the units per dollar in force then, for the spend series."""
    return cur.rate_for(_plain(await rows(session, currency)))


async def current(session: AsyncSession, currency: str) -> Optional[Dict[str, Any]]:
    now = cur.rate_on(_plain(await rows(session, currency)), datetime.utcnow())
    return _out(now["row"]) if now else None


async def add_rate(session: AsyncSession, *, actor_id: UUID, currency: str, units_per_usd: float, effective_from: date, source: str) -> Dict[str, Any]:
    code = currency.strip().upper()
    if len(code) != 3 or not code.isalpha() or code == "USD":
        raise HTTPException(422, "The currency is a three-letter code other than USD (for example PKR).")
    if not (units_per_usd > 0) or units_per_usd > 1_000_000:
        raise HTTPException(422, "The rate is how many units of the currency one US dollar buys: a positive number.")
    if effective_from > datetime.utcnow().date():
        raise HTTPException(422, "A rate cannot take effect on a day that has not happened yet.")
    if not source.strip():
        raise HTTPException(422, "Say where the rate came from (for example: State Bank of Pakistan, interbank closing rate).")
    previous = cur.rate_on(_plain(await rows(session, code)), datetime.combine(effective_from, time.max))
    row = EvalExchangeRate(currency=code, units_per_usd=units_per_usd, effective_from=datetime.combine(effective_from, time.min), source=source.strip(), recorded_by=actor_id)
    session.add(row)
    await session.flush()
    return {"rate": _out(row), "previous": _out(previous["row"]) if previous else None, "warning": cur.change_warning(previous, units_per_usd) if previous else None}


# ── what a machine costs per hour (for self-hosted models) ─────────────────────────────────────────────────────────────

def _compute_out(r: EvalComputeRate) -> Dict[str, Any]:
    return {"id": str(r.id), "name": r.name, "resource": r.resource, "usd_per_hour": r.usd_per_hour, "effective_from": r.effective_from.date().isoformat(), "source": r.source,
            "recorded_by": str(r.recorded_by), "created_at": r.created_at}


async def compute_rates(session: AsyncSession) -> List[Dict[str, Any]]:
    """Every recorded hourly machine rate, as the pure costing code reads them."""
    return [{"name": r.name, "resource": r.resource, "usd_per_hour": r.usd_per_hour, "effective_from": r.effective_from, "source": r.source, "created_at": r.created_at}
            for r in (await session.exec(select(EvalComputeRate))).all()]


async def compute_overview(session: AsyncSession) -> Dict[str, Any]:
    """Each machine and resource with its rate in force today and its history, newest first."""
    from shared.evaluation import self_hosted
    rows = (await session.exec(select(EvalComputeRate).order_by(EvalComputeRate.effective_from.desc(), EvalComputeRate.created_at.desc()))).all()
    plain = await compute_rates(session)
    seen, out = set(), []
    for r in rows:
        key = (r.name, r.resource)
        if key in seen:
            continue
        seen.add(key)
        now = self_hosted.rate_in_force(plain, r.name, r.resource, datetime.utcnow())
        out.append({"name": r.name, "resource": r.resource, "current": None if now is None else {"usd_per_hour": now["usd_per_hour"], "effective_from": now["effective_from"].date().isoformat(), "source": now["source"]},
                    "history": [_compute_out(x) for x in rows if (x.name, x.resource) == key]})
    return {"machines": out}


async def add_compute_rate(session: AsyncSession, *, actor_id: UUID, name: str, resource: str, usd_per_hour: float, effective_from: date, source: str) -> Dict[str, Any]:
    if resource not in ("gpu", "cpu"):
        raise HTTPException(422, "The resource is gpu or cpu.")
    if not name.strip():
        raise HTTPException(422, "Name the machine (for example: A10G on-demand), so an execution can say which one it used.")
    if usd_per_hour < 0 or usd_per_hour > 100_000:
        raise HTTPException(422, "The hourly rate is a number of US dollars per hour.")
    if effective_from > datetime.utcnow().date():
        raise HTTPException(422, "A rate cannot take effect on a day that has not happened yet.")
    if not source.strip():
        raise HTTPException(422, "Say where the price came from (a price list, an invoice, an internal cost sheet).")
    previous = [r for r in await compute_rates(session) if r["name"] == name.strip() and r["resource"] == resource]
    row = EvalComputeRate(name=name.strip(), resource=resource, usd_per_hour=usd_per_hour, effective_from=datetime.combine(effective_from, time.min), source=source.strip(), recorded_by=actor_id)
    session.add(row)
    await session.flush()
    warn = None
    if previous:
        last = max(previous, key=lambda r: (r["effective_from"], r["created_at"]))
        if last["usd_per_hour"] > 0 and abs(usd_per_hour - last["usd_per_hour"]) / last["usd_per_hour"] > 0.5:
            warn = f"This differs by {(usd_per_hour - last['usd_per_hour']) / last['usd_per_hour'] * 100:+.0f}% from the rate it follows (${last['usd_per_hour']:g}/h). Check it for a typing mistake; it was recorded as typed."
    return {"rate": _compute_out(row), "warning": warn}
