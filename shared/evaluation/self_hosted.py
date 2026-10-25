"""Costing a model that runs on our own hardware. Pure logic, no database.

A hosted model is billed per token. A model on our own GPU or CPU machine is billed by the time the machine is held, so its cost is time x a recorded hourly rate:

    usd = seconds / 3600 x usd_per_hour        (of the rate in force when the work was done)

An execution of a self-hosted model reports what it used as `usage["compute"]`, a list of {"resource": "gpu" | "cpu", "seconds": ..., "rate": "A10G on-demand"}. The rate is looked up BY NAME
in the compute rates a person recorded (each with its source); a name with no rate in force on that day makes the cost UNKNOWN (never zero), exactly like a model with no price.
Nothing here guesses a machine's price, and no model is treated as self-hosted unless its usage says so.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, List, Optional, Sequence

RESOURCES = ("gpu", "cpu")
UNIT_KIND = {"gpu": "gpu_seconds", "cpu": "cpu_seconds"}


def _day(at: Any) -> date:
    return at.date() if isinstance(at, datetime) else at


def rate_in_force(rates: Sequence[Dict[str, Any]], name: str, resource: str, at: Any) -> Optional[Dict[str, Any]]:
    """The recorded hourly rate of a named machine for a resource on a day: the latest one effective on or before it (the one recorded last wins when two share a day). None when none is."""
    day = _day(at)
    best: Optional[Dict[str, Any]] = None
    for r in rates:
        if r["name"] != name or r["resource"] != resource or _day(r["effective_from"]) > day:
            continue
        if best is None or (_day(r["effective_from"]), r.get("created_at") or datetime.min) > (_day(best["effective_from"]), best.get("created_at") or datetime.min):
            best = r
    return best


def compute_cost(seconds: float, rate: Optional[Dict[str, Any]]) -> Optional[float]:
    """Dollars for a stretch of machine time at a recorded hourly rate; None when there is no rate, or no valid duration."""
    if rate is None or seconds is None or seconds < 0:
        return None
    return float(seconds) / 3600.0 * float(rate["usd_per_hour"])


def lines_from_compute(usage: Optional[Dict[str, Any]], *, at: Any, rates: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One description of a cost line per piece of machine time an execution reported: {"resource", "unit_kind", "seconds", "usd" (None when unpriced), "rate_name", "source", "known"}.
    The caller turns these into cost lines (shared/evaluation/cost_lines.py). A malformed entry is kept as an unknown line with the reason, not dropped."""
    out: List[Dict[str, Any]] = []
    for i, c in enumerate((usage or {}).get("compute") or []):
        resource, name, seconds = c.get("resource"), c.get("rate") or "", c.get("seconds")
        if resource not in RESOURCES or not isinstance(seconds, (int, float)) or seconds < 0:
            out.append({"resource": resource if resource in RESOURCES else "gpu", "unit_kind": UNIT_KIND.get(resource, "gpu_seconds"), "seconds": 0.0, "usd": None, "rate_name": name, "known": False, "index": i,
                        "source": f"the execution reported machine time that cannot be read ({c!r}): its cost is unknown"})
            continue
        rate = rate_in_force(rates, name, resource, at)
        usd = compute_cost(seconds, rate)
        out.append({"resource": resource, "unit_kind": UNIT_KIND[resource], "seconds": float(seconds), "usd": usd, "rate_name": name, "known": usd is not None, "index": i,
                    "source": (f"{seconds:g} s of {resource.upper()} time x ${rate['usd_per_hour']:g} per hour ('{name}', recorded from: {rate['source']})" if rate
                               else f"{seconds:g} s of {resource.upper()} time, but no hourly rate named '{name}' is recorded for {_day(at)}: the cost is unknown")})
    return out
