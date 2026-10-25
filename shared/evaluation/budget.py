"""Evaluation budgets: what a period's limit allows, given what has been spent and what is already committed. Pure arithmetic, no database.

Money in three parts, for a day or a month (UTC):
  spent      real-model cost already recorded by finished runs in the period (a scripted model costs nothing and adds nothing)
  reserved   the estimates of jobs that are queued or running: committed, but not yet recorded
  estimate   what a request now being made is expected to cost (an upper bound: see services/eval_estimate.py)

A limit of None means no limit. `enforce` decides whether passing a limit refuses the request (stop scheduling) or only warns. A request whose cost cannot
be estimated is never treated as free: against a limit that is already used up it is refused, otherwise it is allowed with a warning that it could not be checked.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

PERIODS = ("day", "month")
DEFAULT_WARN_PCT = 80


def window_start(now: datetime, period: str) -> datetime:
    """The start of the UTC day or month containing `now` (naive UTC, as the database stores times)."""
    if period not in PERIODS:
        raise ValueError(f"period is one of {', '.join(PERIODS)}")
    if now.tzinfo is not None:
        now = now.astimezone(timezone.utc).replace(tzinfo=None)
    return now.replace(hour=0, minute=0, second=0, microsecond=0, day=1 if period == "month" else now.day)


def evaluate(limit_usd: Optional[float], spent: float, reserved: float, estimate: Optional[float], *, warn_at_pct: int = DEFAULT_WARN_PCT, enforce: bool = True) -> Dict[str, Any]:
    """The state of one period's budget, and whether a request with this estimate may go ahead.

    status: no_limit | ok | warning | exceeded      (of the money committed so far, plus this request when its cost is known)
    allowed: False only when `enforce` is on and the limit would be passed (or is already used up and the cost is unknown). A request known to be free is always allowed."""
    committed = spent + reserved
    projected = committed + (estimate or 0.0)
    out: Dict[str, Any] = {"limit_usd": limit_usd, "spent_usd": round(spent, 6), "reserved_usd": round(reserved, 6), "estimate_usd": estimate, "projected_usd": round(projected, 6),
                           "warn_at_pct": warn_at_pct, "enforce": enforce, "remaining_usd": None, "used_pct": None, "status": "no_limit", "allowed": True, "message": None}
    if limit_usd is None:
        return out
    out["remaining_usd"] = round(limit_usd - committed, 6)
    out["used_pct"] = round(100 * projected / limit_usd, 1) if limit_usd > 0 else (0.0 if projected == 0 else 100.0)
    if projected > limit_usd or (limit_usd == 0 and projected > 0):
        out["status"] = "exceeded"
        out["allowed"] = not enforce
        out["message"] = (f"this would take the spend to ${projected:.2f}, above the ${limit_usd:.2f} limit" if estimate is not None
                          else f"the ${limit_usd:.2f} limit is already used up (${committed:.2f} spent or reserved) and this request's cost cannot be estimated")
    elif estimate is None and committed >= limit_usd:
        out["status"] = "exceeded"
        out["allowed"] = not enforce
        out["message"] = f"the ${limit_usd:.2f} limit is already used up (${committed:.2f} spent or reserved) and this request's cost cannot be estimated"
    elif out["used_pct"] >= warn_at_pct:
        out["status"] = "warning"
        out["message"] = f"this would use {out['used_pct']:.0f}% of the ${limit_usd:.2f} limit"
    else:
        out["status"] = "ok"
    if estimate == 0.0:                                   # a request known to cost nothing (a scripted model) never spends the budget, so it is never refused for it
        out["allowed"] = True
    if estimate is None and out["status"] in ("ok", "warning"):
        out["message"] = ((out["message"] + "; ") if out["message"] else "") + "its cost could not be estimated, so only the money already committed was checked"
    return out


def overall(periods: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """The verdict across the day and the month: refused if any enforced period refuses; otherwise the worst status."""
    rank = {"no_limit": 0, "ok": 1, "warning": 2, "exceeded": 3}
    worst = max(periods.values(), key=lambda p: rank[p["status"]]) if periods else {"status": "no_limit"}
    refused = [name for name, p in periods.items() if not p["allowed"]]
    return {"allowed": not refused, "status": worst["status"], "refused_by": refused,
            "messages": [f"{name}: {p['message']}" for name, p in periods.items() if p.get("message")]}
