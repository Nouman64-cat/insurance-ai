"""Evaluation budgets in the platform: read the limits, add up what has been spent and committed, decide whether a request may be scheduled.
The arithmetic is shared/evaluation/budget.py; this module supplies its inputs from the database.

  spent     eval_runs.known_cost_usd of real-model runs that started in the period (a scripted model's run is free and is left out)
  reserved  the pre-run estimates of jobs that are queued or running (committed, not yet recorded)
A limit change is a new row of eval_budget_limits with who and why (the table is append-only), so the history of limits is the table itself.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from sqlalchemy import Float, cast, func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.evaluation import budget as bl
from shared.models.evaluation import EvalBudgetLimit, EvalJob, EvalJobEvent, EvalRun

ACTIVE_JOB_STATES = ("queued", "running", "cancel_requested")


async def current_limits(session: AsyncSession) -> Dict[str, Optional[EvalBudgetLimit]]:
    out: Dict[str, Optional[EvalBudgetLimit]] = {}
    for period in bl.PERIODS:
        out[period] = (await session.exec(select(EvalBudgetLimit).where(EvalBudgetLimit.period == period).order_by(EvalBudgetLimit.effective_from.desc(), EvalBudgetLimit.created_at.desc()).limit(1))).first()
    return out


async def spent_since(session: AsyncSession, start: datetime) -> float:
    when = func.coalesce(EvalRun.started_at, EvalRun.finished_at)
    total = (await session.exec(select(func.coalesce(func.sum(EvalRun.known_cost_usd), 0.0)).where(EvalRun.synthetic_model == False, when >= start))).one()      # noqa: E712
    return float(total or 0.0)


async def reserved_now(session: AsyncSession) -> float:
    jobs = (await session.exec(select(EvalJob).where(EvalJob.state.in_(ACTIVE_JOB_STATES)))).all()
    total = 0.0
    for j in jobs:
        if (j.config or {}).get("kind") == "drift_scan":
            continue
        try:
            total += float((((j.estimate or {}).get("cost") or {}).get("usd") or {}).get("total") or 0.0)
        except (TypeError, ValueError):
            continue
    return total


async def status(session: AsyncSession, estimate_usd: Optional[float] = None, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """The state of the day's and the month's budget, with `estimate_usd` (None = unknown, 0 = free) added when a request is being checked."""
    now = now or datetime.utcnow()
    limits = await current_limits(session)
    reserved = await reserved_now(session)
    periods: Dict[str, Dict[str, Any]] = {}
    for period, row in limits.items():
        spent = await spent_since(session, bl.window_start(now, period))
        ev = bl.evaluate(row.limit_usd if row else None, spent, reserved, estimate_usd, warn_at_pct=row.warn_at_pct if row else bl.DEFAULT_WARN_PCT, enforce=row.enforce if row else True)
        ev.update({"period": period, "since": bl.window_start(now, period), "set_by": str(row.set_by) if row else None, "set_at": row.effective_from if row else None, "reason": row.reason if row else None})
        periods[period] = ev
    return {"periods": periods, **bl.overall(periods)}


def estimate_total(estimate: Optional[Dict[str, Any]]) -> Optional[float]:
    """The USD figure of a pre-run estimate, or None when it is missing or incomplete (an unpriced model): unknown is never taken as free."""
    usd = (((estimate or {}).get("cost") or {}).get("usd") or {})
    if not usd or usd.get("complete") is False or usd.get("total") is None:
        return None
    return float(usd["total"])


async def enforce(session: AsyncSession, estimate: Dict[str, Any]) -> Dict[str, Any]:
    """Refuse (HTTP 409) a request that would pass an enforced limit. Returns the budget status to store with the job, so a warning travels with it."""
    st = jsonable_encoder(await status(session, estimate_total(estimate)))            # plain JSON (dates as text): it is stored inside the job's estimate
    if not st["allowed"]:
        raise HTTPException(409, detail={"message": "This run would pass the evaluation budget, so it was not scheduled.", "problems": st["messages"], "budget": st})
    return st


async def set_limit(session: AsyncSession, period: str, *, limit_usd: Optional[float], warn_at_pct: int, enforce_limit: bool, reason: str, actor_id: UUID) -> EvalBudgetLimit:
    if period not in bl.PERIODS:
        raise HTTPException(422, f"period is one of {', '.join(bl.PERIODS)}")
    if not reason.strip():
        raise HTTPException(422, "A reason is required to change a budget.")
    row = EvalBudgetLimit(period=period, limit_usd=limit_usd, warn_at_pct=warn_at_pct, enforce=enforce_limit, reason=reason.strip(), set_by=actor_id)
    session.add(row)
    await session.flush()
    return row


async def history(session: AsyncSession, limit: int = 50) -> List[EvalBudgetLimit]:
    return list((await session.exec(select(EvalBudgetLimit).order_by(EvalBudgetLimit.created_at.desc()).limit(limit))).all())


async def running_spend(session: AsyncSession, job_id: UUID) -> float:
    """What a job has really spent so far, added up from its own case events: the model's calls, the judge and retried attempts (`total_cost_usd`; older events carry `cost_usd` only)."""
    amount = func.coalesce(cast(EvalJobEvent.data["total_cost_usd"].astext, Float), cast(EvalJobEvent.data["cost_usd"].astext, Float), 0.0)
    return float((await session.exec(select(func.coalesce(func.sum(amount), 0.0)).where(EvalJobEvent.job_id == job_id, EvalJobEvent.kind == "case"))).one() or 0.0)


async def check_running(session: AsyncSession, job: EvalJob, *, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Is a job that is already running still within the daily and monthly limits? Its own real spend so far replaces its estimate; the estimates of OTHER queued or running jobs stay reserved.
    A limit that is enforced and has been passed stops the job (the caller cancels it). A free job (a scripted model) never spends, so it is never stopped."""
    if (job.config or {}).get("kind") == "drift_scan":
        return {"allowed": True, "messages": [], "periods": {}}
    now = now or datetime.utcnow()
    own = await running_spend(session, job.id)
    if own <= 0:
        return {"allowed": True, "messages": [], "periods": {}, "job_spent_usd": 0.0}
    own_estimate = float((((job.estimate or {}).get("cost") or {}).get("usd") or {}).get("total") or 0.0) if job.state in ACTIVE_JOB_STATES else 0.0
    others = max(0.0, await reserved_now(session) - own_estimate)                    # this job's estimate is replaced by what it has really spent
    periods: Dict[str, Dict[str, Any]] = {}
    for period, row in (await current_limits(session)).items():
        spent = await spent_since(session, bl.window_start(now, period))
        # what is already committed = finished runs + other jobs' reservations; this job's real spend so far is the "request" being added to it
        periods[period] = bl.evaluate(row.limit_usd if row else None, spent, others, own, warn_at_pct=row.warn_at_pct if row else bl.DEFAULT_WARN_PCT, enforce=row.enforce if row else True)
    verdict = bl.overall(periods)
    return {**verdict, "periods": periods, "job_spent_usd": round(own, 6)}
