"""Evaluation costs (Phase 7): the cost lines, provider billing reconciliation, and how sure the money is. SuperAdmin only.

  GET  /eval/costs/lines                       the detailed usage records: every cost line, filterable by run, component, provider, kind and period
  GET  /eval/costs/attribution[?run_id=]       is every run's spending attributed exactly once (lines = recorded cost, every token in a line, nothing doubled)
  GET  /eval/costs/certainty?from=&to=         the money of a window as confirmed / estimated / unknown
  GET  /eval/costs/overview[?currency=]       everything the page opens with: month and day against the budgets, what is running, how sure the money is, the 30-day trend, statements, checks, advice
  GET/POST /eval/costs/compute-rates          what a named machine costs per hour (GPU or CPU), for costing a self-hosted model as machine time x rate
  GET  /eval/costs/rates                       exchange rates recorded for showing money in a second currency (PKR), with the one in force today
  POST /eval/costs/rates                       record a rate (units per dollar, the day it takes effect, where it came from); never edited, a correction is a newer rate
  GET  /eval/costs/trends?from=&to=&bucket=&group_by=[&currency=]   money over time (day | week | month), split by component, provider or model; in a second currency at each day's rate
  GET  /eval/costs/models                      per dataset version and mode: quality, reliability, latency and what a PASSED test cost, with the quality/cost frontier and the advice
  GET  /eval/costs/benchmarks                  what each benchmark cost in total and per model
  GET  /eval/costs/anomalies?from=&to=         unusual runs, days and executions, each with the numbers it was compared with
  GET  /eval/costs/recommendations?from=&to=   what the comparison and the spending support, with evidence and caveats (nothing is changed by it)
  GET  /eval/costs/statements                  what providers billed (typed in), each with its live comparison against the recorded lines
  POST /eval/costs/statements/preview          read a provider usage export (CSV): what it says, and where it differs from what was recorded, day by day and model by model; saves nothing
  POST /eval/costs/statements                  enter what a provider billed for a period (inclusive dates); two statements of one provider may not overlap
  GET  /eval/costs/statements/{id}             one statement with its live comparison and every reconciliation made of it
  POST /eval/costs/statements/{id}/reconcile   compare again now and keep who looked and what they wrote about the difference
A statement and a reconciliation can never be edited or deleted: a correction is a new statement that names the one it replaces.
"""
from datetime import date, datetime, time, timedelta
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, oauth2_scheme, verify_superadmin
from services import eval_analytics, eval_costs, eval_rates, eval_reconcile as svc
from services.audit_capture import record_standalone
from shared.evaluation import cost_lines
from shared.models.core import User
from shared.models.evaluation import COST_COMPONENTS, COST_KINDS, EvalCostLine, EvalProviderStatement, EvalReconciliation

router = APIRouter(prefix="/eval/costs", tags=["Evaluation costs"], dependencies=[Depends(verify_superadmin)])


async def _actor(token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)) -> User:
    return await _get_current_user(token, session)


class StatementIn(BaseModel):
    provider: str = Field(pattern="^(openai|anthropic|gemini)$")
    period_start: date
    period_end: date
    billed_usd: float = Field(ge=0, le=10_000_000)
    reference: Optional[str] = Field(default=None, max_length=120, description="an invoice number or the name of the dashboard export")
    source: str = Field(min_length=1, max_length=1000, description="where the figure came from, for example: typed from the OpenAI usage page, project 'evaluation'")
    billed_input_tokens: Optional[int] = Field(default=None, ge=0)
    billed_output_tokens: Optional[int] = Field(default=None, ge=0)
    billed_cached_tokens: Optional[int] = Field(default=None, ge=0)
    tolerance_pct: float = Field(default=5.0, ge=0, le=50)
    tolerance_usd: float = Field(default=0.05, ge=0, le=100)
    supersedes_id: Optional[UUID] = None
    note: Optional[str] = Field(default=None, max_length=2000)
    usage_detail: Optional[Dict[str, Any]] = Field(default=None, description="the per-day and per-model totals of an imported usage export (from /statements/preview)")


class PreviewIn(BaseModel):
    provider: str = Field(pattern="^(openai|anthropic|gemini)$")
    filename: str = Field(default="usage.csv", max_length=200)
    content: str = Field(min_length=1, max_length=6_000_000, description="the text of the provider's usage export (CSV)")


class ReconcileIn(BaseModel):
    note: Optional[str] = Field(default=None, max_length=2000)


def _line(l: EvalCostLine) -> Dict[str, Any]:
    return {"id": str(l.id), "run_id": l.run_id, "case_id": l.case_id, "repetition": l.repetition, "component": l.component, "provider": l.provider or cost_lines.provider_of(l.model), "model": l.model, "unit_kind": l.unit_kind,
            "input_units": l.input_units, "output_units": l.output_units, "cached_units": l.cached_units, "usd": l.usd, "cost_kind": l.cost_kind, "source": l.source, "incurred_at": l.incurred_at}


@router.get("/lines")
async def lines(run_id: Optional[str] = None, component: Optional[str] = None, provider: Optional[str] = None, kind: Optional[str] = None, case_id: Optional[str] = None,
                date_from: Optional[date] = Query(default=None, alias="from"), date_to: Optional[date] = Query(default=None, alias="to"),
                limit: int = Query(default=100, ge=1, le=1000), offset: int = Query(default=0, ge=0), session: AsyncSession = Depends(get_session)):
    if component and component not in COST_COMPONENTS:
        raise HTTPException(422, f"component is one of {', '.join(COST_COMPONENTS)}")
    if kind and kind not in COST_KINDS:
        raise HTTPException(422, f"kind is one of {', '.join(COST_KINDS)}")
    where = []
    for col, val in ((EvalCostLine.run_id, run_id), (EvalCostLine.component, component), (svc.provider_expr(), provider), (EvalCostLine.cost_kind, kind), (EvalCostLine.case_id, case_id)):
        if val:
            where.append(col == val)
    if date_from:
        where.append(EvalCostLine.incurred_at >= datetime.combine(date_from, time.min))
    if date_to:
        where.append(EvalCostLine.incurred_at <= datetime.combine(date_to, time.max))
    total, usd, unknown = (await session.exec(select(func.count(), func.coalesce(func.sum(EvalCostLine.usd), 0.0), func.count().filter(EvalCostLine.usd == None)).where(*where))).one()   # noqa: E711
    rows = (await session.exec(select(EvalCostLine).where(*where).order_by(EvalCostLine.incurred_at.desc(), EvalCostLine.run_id, EvalCostLine.case_id, EvalCostLine.component).offset(offset).limit(limit))).all()
    return {"total": int(total), "usd": float(usd), "unknown_lines": int(unknown), "lines": [_line(l) for l in rows]}


@router.get("/attribution")
async def attribution(run_id: Optional[str] = None, session: AsyncSession = Depends(get_session)):
    return await eval_costs.attribution(session, run_id)


@router.get("/certainty")
async def certainty(date_from: Optional[date] = Query(default=None, alias="from"), date_to: Optional[date] = Query(default=None, alias="to"), session: AsyncSession = Depends(get_session)):
    today = datetime.utcnow().date()
    start, end = svc.period_of(date_from or (today - timedelta(days=30)), date_to or today)
    if end < start:
        raise HTTPException(422, "The window cannot end before it starts.")
    return await svc.certainty(session, start, end)


@router.get("/statements")
async def statements(provider: Optional[str] = None, session: AsyncSession = Depends(get_session)):
    return {"statements": await svc.list_statements(session, provider), "scope_note": svc.SCOPE_NOTE}


@router.post("/statements/preview")
async def preview_statement(body: PreviewIn, session: AsyncSession = Depends(get_session)):
    """Read a provider's usage export and show what it says and where it differs from what was recorded, day by day and model by model. Saves nothing."""
    return await svc.preview_import(session, body.provider, body.filename, body.content)


@router.post("/statements", status_code=201)
async def add_statement(body: StatementIn, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    out = await svc.create_statement(session, actor_id=actor.id, provider=body.provider, period_start=body.period_start, period_end=body.period_end, billed_usd=body.billed_usd, reference=body.reference,
                                     source=body.source, billed_tokens={"input": body.billed_input_tokens, "output": body.billed_output_tokens, "cached": body.billed_cached_tokens},
                                     tolerance_pct=body.tolerance_pct, tolerance_usd=body.tolerance_usd, supersedes_id=body.supersedes_id, note=body.note,
                                     usage_detail=_checked_detail(body.usage_detail))
    await session.commit()
    await record_standalone(module="administration", action="eval.cost.statement", entity_type="eval_provider_statement", entity_id=out["statement"]["id"], tenant_id=actor.tenant_id, actor_id=str(actor.id),
                            actor_type="USER", actor_role="SuperAdmin", metadata={"provider": body.provider, "period": f"{body.period_start}..{body.period_end}", "billed_usd": body.billed_usd,
                                                                                  "status": out["reconciliation"]["status"], "replaces": str(body.supersedes_id) if body.supersedes_id else None})
    return out


def _checked_detail(d: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Only the shape the reader produces is kept (per-day and per-model totals): numbers, bounded in size."""
    if not d:
        return None
    keep: Dict[str, Any] = {}
    for key in ("by_day", "by_model"):
        part = d.get(key) or {}
        if not isinstance(part, dict) or len(part) > 2000:
            raise HTTPException(422, "The usage detail is not what a usage export produces.")
        keep[key] = {str(k)[:80]: {f: float(v.get(f) or 0) for f in ("usd", "input", "output", "cached")} for k, v in part.items() if isinstance(v, dict)}
    if isinstance(d.get("filename"), str):
        keep["filename"] = d["filename"][:200]
    return keep


async def _statement(session: AsyncSession, statement_id: UUID) -> EvalProviderStatement:
    st = await session.get(EvalProviderStatement, statement_id)
    if st is None:
        raise HTTPException(404, "No such statement.")
    return st


@router.get("/statements/{statement_id}")
async def get_statement(statement_id: UUID, session: AsyncSession = Depends(get_session)):
    st = await _statement(session, statement_id)
    history = (await session.exec(select(EvalReconciliation).where(EvalReconciliation.statement_id == st.id).order_by(EvalReconciliation.created_at.desc()))).all()
    superseded = st.id in await svc.superseded_ids(session)
    return {**svc._out(st), "superseded": superseded, "live": None if superseded else await svc.compare(session, st), "scope_note": svc.SCOPE_NOTE,
            "reconciliations": [{"id": str(r.id), "status": r.status, "billed_usd": r.billed_usd, "recorded_usd": r.recorded_usd, "difference_usd": r.difference_usd, "difference_pct": r.difference_pct,
                                 "unknown_lines": r.unknown_lines, "note": r.note, "detail": r.detail, "by": str(r.performed_by), "at": r.created_at} for r in history]}


@router.post("/statements/{statement_id}/reconcile")
async def reconcile_statement(statement_id: UUID, body: ReconcileIn, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    st = await _statement(session, statement_id)
    out = await svc.reconcile(session, st, actor_id=actor.id, note=body.note)
    await session.commit()
    await record_standalone(module="administration", action="eval.cost.reconcile", entity_type="eval_provider_statement", entity_id=str(st.id), tenant_id=actor.tenant_id, actor_id=str(actor.id),
                            actor_type="USER", actor_role="SuperAdmin", metadata={"status": out["status"], "difference_usd": out["difference_usd"], "note": (body.note or "")[:300]})
    return out


def _window(date_from: Optional[date], date_to: Optional[date], default_days: int) -> tuple:
    today = datetime.utcnow().date()
    start, end = date_from or (today - timedelta(days=default_days)), date_to or today
    if end < start:
        raise HTTPException(422, "The window cannot end before it starts.")
    if (end - start).days > 800:
        raise HTTPException(422, "The window is limited to about two years.")
    return start, end


@router.get("/trends")
async def trends(date_from: Optional[date] = Query(default=None, alias="from"), date_to: Optional[date] = Query(default=None, alias="to"),
                 bucket: str = Query(default="day", pattern="^(day|week|month)$"), group_by: Optional[str] = Query(default=None, pattern="^(component|provider|model)$"),
                 include_synthetic: bool = False, currency: Optional[str] = Query(default=None, pattern="^[A-Za-z]{3}$"), session: AsyncSession = Depends(get_session)):
    start, end = _window(date_from, date_to, 30)
    return await eval_analytics.trends(session, start=start, end=end, bucket=bucket, group_by=group_by, include_synthetic=include_synthetic, currency=currency)


@router.get("/overview")
async def overview(currency: Optional[str] = Query(default=None, pattern="^[A-Za-z]{3}$"), session: AsyncSession = Depends(get_session)):
    return await eval_analytics.overview(session, currency=currency)


class RateIn(BaseModel):
    currency: str = Field(min_length=3, max_length=3, pattern="^[A-Za-z]{3}$")
    units_per_usd: float = Field(gt=0, le=1_000_000, description="how many units of the currency one US dollar buys")
    effective_from: date
    source: str = Field(min_length=1, max_length=1000, description="where the rate came from, for example: State Bank of Pakistan interbank closing rate")


@router.get("/rates")
async def rates(session: AsyncSession = Depends(get_session)):
    return await eval_rates.overview(session)


@router.post("/rates", status_code=201)
async def add_rate(body: RateIn, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    out = await eval_rates.add_rate(session, actor_id=actor.id, currency=body.currency, units_per_usd=body.units_per_usd, effective_from=body.effective_from, source=body.source)
    await session.commit()
    await record_standalone(module="administration", action="eval.cost.rate", entity_type="eval_exchange_rate", entity_id=out["rate"]["id"], tenant_id=actor.tenant_id, actor_id=str(actor.id),
                            actor_type="USER", actor_role="SuperAdmin", metadata={"currency": out["rate"]["currency"], "units_per_usd": body.units_per_usd, "effective_from": str(body.effective_from), "warning": out["warning"]})
    return out


@router.get("/models")
async def models(dataset: Optional[str] = None, version: Optional[str] = None, mode: Optional[str] = Query(default=None, pattern="^(agent|direct)$"), include_synthetic: bool = False,
                 session: AsyncSession = Depends(get_session)):
    return await eval_analytics.models(session, dataset=dataset, version=version, mode=mode, include_synthetic=include_synthetic)


@router.get("/benchmarks")
async def benchmarks(include_synthetic: bool = False, benchmark_id: Optional[str] = Query(default=None, max_length=60), session: AsyncSession = Depends(get_session)):
    return await eval_analytics.benchmark_spending(session, include_synthetic=include_synthetic, benchmark_id=benchmark_id)


@router.get("/anomalies")
async def anomalies(date_from: Optional[date] = Query(default=None, alias="from"), date_to: Optional[date] = Query(default=None, alias="to"), session: AsyncSession = Depends(get_session)):
    start, end = _window(date_from, date_to, 90)
    return await eval_analytics.anomalies(session, start=start, end=end)


@router.get("/recommendations")
async def recommendations(date_from: Optional[date] = Query(default=None, alias="from"), date_to: Optional[date] = Query(default=None, alias="to"), session: AsyncSession = Depends(get_session)):
    start, end = _window(date_from, date_to, 90)
    return await eval_analytics.recommendations(session, start=start, end=end)


class ComputeRateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120, description="the machine, as an execution will name it: for example A10G on-demand")
    resource: str = Field(pattern="^(gpu|cpu)$")
    usd_per_hour: float = Field(ge=0, le=100_000)
    effective_from: date
    source: str = Field(min_length=1, max_length=1000)


@router.get("/compute-rates")
async def compute_rates(session: AsyncSession = Depends(get_session)):
    """What each named machine costs per hour (GPU or CPU), for costing a self-hosted model as machine time x rate."""
    return await eval_rates.compute_overview(session)


@router.post("/compute-rates", status_code=201)
async def add_compute_rate(body: ComputeRateIn, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    out = await eval_rates.add_compute_rate(session, actor_id=actor.id, name=body.name, resource=body.resource, usd_per_hour=body.usd_per_hour, effective_from=body.effective_from, source=body.source)
    await session.commit()
    await record_standalone(module="administration", action="eval.cost.compute_rate", entity_type="eval_compute_rate", entity_id=out["rate"]["id"], tenant_id=actor.tenant_id, actor_id=str(actor.id),
                            actor_type="USER", actor_role="SuperAdmin", metadata={"name": body.name, "resource": body.resource, "usd_per_hour": body.usd_per_hour, "effective_from": str(body.effective_from)})
    return out
