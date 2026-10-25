"""Showing evaluation money in a second currency (PKR) from rates that a person recorded. Pure logic, no database.

Money is recorded once, in US dollars, as the provider charges it. A second currency is only a way of reading it: each amount is converted at the rate that was in force
on the day the cost was incurred, never at today's rate, so a report for last month does not change when the rupee moves. A day with no recorded rate on or before it is
NOT converted at some other rate: it is reported as unconverted, with its dollar amount, so nothing is guessed.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Callable, Dict, Iterable, Optional, Sequence

MAX_CHANGE_WITHOUT_WARNING_PCT = 20.0


def _day(at: Any) -> date:
    return at.date() if isinstance(at, datetime) else at


def rate_on(rates: Sequence[Dict[str, Any]], at: Any) -> Optional[Dict[str, Any]]:
    """The rate in force on a day: of the rates effective on or before it, the latest effective one, and among rates with the same effective day the one recorded last.
    `rates`: {"units_per_usd", "effective_from" (date or datetime), "created_at" (datetime)}. None when no rate was in force yet."""
    day = _day(at)
    best: Optional[Dict[str, Any]] = None
    for r in rates:
        eff = _day(r["effective_from"])
        if eff <= day and (best is None or (eff, r.get("created_at") or datetime.min) > (_day(best["effective_from"]), best.get("created_at") or datetime.min)):
            best = r
    return best


def convert(usd: Optional[float], rate: Optional[Dict[str, Any]]) -> Optional[float]:
    """Dollars to the other currency; None when the amount or the rate is not known."""
    if usd is None or rate is None:
        return None
    return float(usd) * float(rate["units_per_usd"])


def rate_for(rates: Sequence[Dict[str, Any]]) -> Callable[[Any], Optional[float]]:
    """A function from a moment to the units per dollar in force then (or None), for the spend series to convert line by line."""
    ordered = list(rates)

    def at(moment: Any) -> Optional[float]:
        r = rate_on(ordered, moment)
        return float(r["units_per_usd"]) if r else None
    return at


def change_warning(previous: Optional[Dict[str, Any]], new_units_per_usd: float) -> Optional[str]:
    """A recorded rate that differs a lot from the one it replaces is probably a typing mistake: say so (the rate is still recorded; a person decides)."""
    if previous is None or not previous.get("units_per_usd"):
        return None
    change = (new_units_per_usd - previous["units_per_usd"]) / previous["units_per_usd"] * 100.0
    if abs(change) > MAX_CHANGE_WITHOUT_WARNING_PCT:
        return f"This differs by {change:+.1f}% from the rate it follows ({previous['units_per_usd']}). Check it for a typing mistake; it was recorded as typed."
    return None


def money(amount: Optional[float], currency: str) -> str:
    """How an amount reads: dollars to the cent (or four places for tiny sums), rupees without decimals above 100."""
    if amount is None:
        return "unknown"
    if currency == "USD":
        return "$0" if amount == 0 else f"${amount:.4f}" if abs(amount) < 0.01 else f"${amount:,.2f}"
    if amount == 0:
        return f"0 {currency}"
    return f"{amount:,.0f} {currency}" if abs(amount) >= 100 else f"{amount:,.2f} {currency}"
