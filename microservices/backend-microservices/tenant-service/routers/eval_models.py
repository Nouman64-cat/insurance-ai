"""The model registry and the benchmarks, for the Super Admin. A model is registered once, with what it can do, how a benchmark should
configure it and its price history; every benchmark that used it is listed on its page.

  GET   /eval/models[?provider=&status=&role=]    the registry, each model with its current price and its latest benchmark result
  POST  /eval/models                              register a model (optionally with its first price)
  GET   /eval/models/{id}                         one model: configuration, price history, the benchmarks it took part in
  PATCH /eval/models/{id}                         change its name, status, roles, capabilities, configuration or notes
  POST  /eval/models/{id}/prices                  record a new price (append-only; a source is required)
  GET   /eval/benchmarks, /eval/benchmarks/{id}   the comparisons: configuration, per-model results, the evidence behind any "better"

The provider and the model id of an entry never change after it is created; a renamed model is a new entry. A price is never edited or
deleted: a new row takes over from its effective date.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, oauth2_scheme, verify_superadmin
from services.audit_capture import record_standalone
from shared.evaluation import registry
from shared.models.core import User
from shared.models.evaluation import EvalBenchmark, EvalModel, EvalModelPrice, EvalRun

router = APIRouter(prefix="/eval/models", tags=["Evaluation model registry"], dependencies=[Depends(verify_superadmin)])
benchmarks = APIRouter(prefix="/eval/benchmarks", tags=["Evaluation benchmarks"], dependencies=[Depends(verify_superadmin)])


class PriceIn(BaseModel):
    input_per_m: float
    cached_per_m: float
    output_per_m: float
    source: str = Field(max_length=300)
    effective_from: Optional[datetime] = None


class ModelIn(BaseModel):
    provider: str
    model_id: str
    display_name: Optional[str] = Field(default=None, max_length=160)
    status: str = "active"
    roles: List[str] = Field(default_factory=lambda: ["candidate"])
    capabilities: Dict[str, Any] = Field(default_factory=dict)
    configuration: Dict[str, Any] = Field(default_factory=dict)
    notes: Optional[str] = Field(default=None, max_length=2000)
    price: Optional[PriceIn] = None


class ModelPatch(BaseModel):
    display_name: Optional[str] = Field(default=None, max_length=160)
    status: Optional[str] = None
    roles: Optional[List[str]] = None
    capabilities: Optional[Dict[str, Any]] = None
    configuration: Optional[Dict[str, Any]] = None
    notes: Optional[str] = Field(default=None, max_length=2000)


async def _actor(token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)) -> User:
    return await _get_current_user(token, session)


def _price_out(p: EvalModelPrice) -> Dict[str, Any]:
    return {"id": str(p.id), "input_per_m": p.input_per_m, "cached_per_m": p.cached_per_m, "output_per_m": p.output_per_m,
            "effective_from": p.effective_from, "source": p.source, "created_at": p.created_at}


def _out(m: EvalModel, prices: List[EvalModelPrice], bench: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    current = registry.price_on([{"effective_from": p.effective_from, **_price_out(p)} for p in prices], datetime.utcnow())
    return {"id": str(m.id), "label": registry.label(m.provider, m.model_id), "provider": m.provider, "model_id": m.model_id, "display_name": m.display_name,
            "status": m.status, "synthetic": m.synthetic, "roles": m.roles, "capabilities": m.capabilities, "configuration": m.configuration, "notes": m.notes,
            "current_price": current, "latest_benchmark": bench, "created_at": m.created_at, "updated_at": m.updated_at}


def _benchmark_out(b: EvalBenchmark, *, full: bool = False) -> Dict[str, Any]:
    out = {"benchmark_id": b.benchmark_id, "mode": b.mode, "dataset": b.dataset_slug, "dataset_version": b.dataset_version, "models": b.models,
           "repetitions": b.repetitions, "judge_model": b.judge_model, "judge_version": b.judge_version, "synthetic": b.synthetic, "complete": b.complete,
           "created_at": b.created_at}
    if full:
        out.update({"config": b.config, "summary": b.summary})
    return out


def _result_of(b: EvalBenchmark, label: str) -> Optional[Dict[str, Any]]:
    row = ((b.summary or {}).get("models") or {}).get(label)
    if not row:
        return None
    return {"benchmark_id": b.benchmark_id, "mode": b.mode, "synthetic": b.synthetic, "at": b.created_at, "status": row.get("status"),
            "pass_rate": row.get("pass_rate"), "ci_low": row.get("ci_low"), "ci_high": row.get("ci_high"), "cost_per_pass_usd": row.get("cost_per_passed_usd")}


async def _prices(session: AsyncSession, model_id: UUID) -> List[EvalModelPrice]:
    return list((await session.exec(select(EvalModelPrice).where(EvalModelPrice.model_row_id == model_id).order_by(EvalModelPrice.effective_from.desc()))).all())


async def _model(session: AsyncSession, model_id: UUID) -> EvalModel:
    m = await session.get(EvalModel, model_id)
    if m is None:
        raise HTTPException(404, "No such model.")
    return m


def _refuse(exc: registry.RegistryError) -> HTTPException:
    return HTTPException(422, detail={"message": str(exc)})


async def _audit(actor: User, action: str, entity_id: str, **meta: Any) -> None:
    await record_standalone(module="administration", action=action, entity_type="eval_model", entity_id=entity_id, tenant_id=actor.tenant_id,
                            actor_id=str(actor.id), actor_type="USER", actor_role="SuperAdmin", metadata=meta)


@router.get("")
async def list_models(provider: Optional[str] = Query(default=None), status: Optional[str] = Query(default=None), role: Optional[str] = Query(default=None),
                      session: AsyncSession = Depends(get_session)):
    stmt = select(EvalModel).order_by(EvalModel.provider, EvalModel.model_id)
    if provider:
        stmt = stmt.where(EvalModel.provider == provider)
    if status:
        stmt = stmt.where(EvalModel.status == status)
    models = [m for m in (await session.exec(stmt)).all() if not role or role in (m.roles or [])]
    recent = list((await session.exec(select(EvalBenchmark).order_by(EvalBenchmark.created_at.desc()).limit(100))).all())
    out = []
    for m in models:
        label = registry.label(m.provider, m.model_id)
        latest = next((r for b in recent if (r := _result_of(b, label))), None)
        out.append(_out(m, await _prices(session, m.id), latest))
    return out


@router.post("", status_code=201)
async def create_model(body: ModelIn, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    try:
        clean = registry.check_model(body.provider, body.model_id, status=body.status, roles=body.roles, capabilities=body.capabilities, configuration=body.configuration)
        price = registry.check_price(body.provider, body.price.input_per_m, body.price.cached_per_m, body.price.output_per_m, body.price.source) if body.price else None
    except registry.RegistryError as exc:
        raise _refuse(exc)
    m = EvalModel(**clean, display_name=body.display_name or body.model_id, notes=body.notes, created_by=actor.id)
    session.add(m)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, f"{body.provider}/{body.model_id} is already registered.")
    if price:
        session.add(EvalModelPrice(model_row_id=m.id, created_by=actor.id, effective_from=body.price.effective_from or datetime.utcnow(), **price))
    await session.commit()
    await _audit(actor, "eval.model.create", str(m.id), model=registry.label(m.provider, m.model_id))
    return _out(m, await _prices(session, m.id))


@router.get("/{model_id}")
async def get_model(model_id: UUID, session: AsyncSession = Depends(get_session)):
    m = await _model(session, model_id)
    prices = await _prices(session, m.id)
    label = registry.label(m.provider, m.model_id)
    results = [r for b in (await session.exec(select(EvalBenchmark).order_by(EvalBenchmark.created_at.desc()).limit(200))).all() if (r := _result_of(b, label))]
    return {**_out(m, prices, results[0] if results else None), "price_history": [_price_out(p) for p in prices], "benchmarks": results}


@router.patch("/{model_id}")
async def update_model(model_id: UUID, body: ModelPatch, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    m = await _model(session, model_id)
    try:
        clean = registry.check_model(m.provider, m.model_id, status=body.status or m.status, roles=body.roles or m.roles,
                                     capabilities=m.capabilities if body.capabilities is None else body.capabilities,
                                     configuration=m.configuration if body.configuration is None else body.configuration)
    except registry.RegistryError as exc:
        raise _refuse(exc)
    for field in ("status", "roles", "capabilities", "configuration"):
        setattr(m, field, clean[field])
    if body.display_name is not None:
        m.display_name = body.display_name
    if body.notes is not None:
        m.notes = body.notes
    m.updated_at = datetime.utcnow()
    session.add(m)
    await session.commit()
    await _audit(actor, "eval.model.update", str(m.id), changed=sorted(body.model_dump(exclude_none=True)))
    return _out(m, await _prices(session, m.id))


@router.post("/{model_id}/prices", status_code=201)
async def add_price(model_id: UUID, body: PriceIn, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    m = await _model(session, model_id)
    try:
        price = registry.check_price(m.provider, body.input_per_m, body.cached_per_m, body.output_per_m, body.source)
    except registry.RegistryError as exc:
        raise _refuse(exc)
    p = EvalModelPrice(model_row_id=m.id, created_by=actor.id, effective_from=body.effective_from or datetime.utcnow(), **price)
    session.add(p)
    await session.commit()
    await _audit(actor, "eval.model.price", str(m.id), **price)
    return _price_out(p)


@benchmarks.get("")
async def list_benchmarks(limit: int = Query(default=50, ge=1, le=200), session: AsyncSession = Depends(get_session)):
    return [_benchmark_out(b) for b in (await session.exec(select(EvalBenchmark).order_by(EvalBenchmark.created_at.desc()).limit(limit))).all()]


@benchmarks.get("/{benchmark_id}")
async def get_benchmark(benchmark_id: str, session: AsyncSession = Depends(get_session)):
    b = (await session.exec(select(EvalBenchmark).where(EvalBenchmark.benchmark_id == benchmark_id))).first()
    if b is None:
        raise HTTPException(404, "No such benchmark.")
    runs = (await session.exec(select(EvalRun).where(EvalRun.group_id == b.benchmark_id).order_by(EvalRun.started_at))).all()
    return {**_benchmark_out(b, full=True), "runs": [{"run_id": r.run_id, "model": r.model_label, "state": r.state, "pass_rate": r.pass_rate, "known_cost_usd": r.known_cost_usd} for r in runs]}
