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
from shared.models.evaluation import EvalExchangeRate


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
