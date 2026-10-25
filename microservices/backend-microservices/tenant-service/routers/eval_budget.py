"""Evaluation budgets (Phase 7): a daily and a monthly limit on real-model evaluation spend. SuperAdmin only.

  GET /eval/budget            both limits, what has been spent and reserved in each period, and the status
  PUT /eval/budget/{period}   set a limit (day | month): amount or none, warning level, whether passing it stops scheduling, and WHY
  GET /eval/budget/history    every change of a limit: who, when, why
A job that would pass an enforced limit is refused at scheduling (routers/eval_jobs.py) and the refusal is recorded in the audit trail.
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, oauth2_scheme, verify_superadmin
from services import eval_budget as svc
from services.audit_capture import record_standalone
from shared.models.core import User

router = APIRouter(prefix="/eval/budget", tags=["Evaluation budget"], dependencies=[Depends(verify_superadmin)])


async def _actor(token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)) -> User:
    return await _get_current_user(token, session)


class LimitIn(BaseModel):
    limit_usd: Optional[float] = Field(default=None, ge=0, le=1_000_000, description="null removes the limit")
    warn_at_pct: int = Field(default=80, ge=1, le=100)
    enforce: bool = True
    reason: str = Field(min_length=1, max_length=1000)


def _row(r) -> Dict[str, Any]:
    return {"id": str(r.id), "period": r.period, "limit_usd": r.limit_usd, "warn_at_pct": r.warn_at_pct, "enforce": r.enforce, "set_by": str(r.set_by), "reason": r.reason, "at": r.effective_from}


@router.get("")
async def get_budget(session: AsyncSession = Depends(get_session)):
    return await svc.status(session)


@router.put("/{period}")
async def put_limit(period: str, body: LimitIn, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    row = await svc.set_limit(session, period, limit_usd=body.limit_usd, warn_at_pct=body.warn_at_pct, enforce_limit=body.enforce, reason=body.reason, actor_id=actor.id)
    await session.commit()
    await record_standalone(module="administration", action="eval.budget.set", entity_type="eval_budget", entity_id=period, tenant_id=actor.tenant_id, actor_id=str(actor.id),
                            actor_type="USER", actor_role="SuperAdmin", metadata={"limit_usd": body.limit_usd, "warn_at_pct": body.warn_at_pct, "enforce": body.enforce, "reason": body.reason[:300]})
    return {"limit": _row(row), "status": await svc.status(session)}


@router.get("/history")
async def get_history(session: AsyncSession = Depends(get_session)):
    return {"changes": [_row(r) for r in await svc.history(session)]}
