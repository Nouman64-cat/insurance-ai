"""The Evaluation Studio's read model (SuperAdmin only): everything the interactive ecosystem map, the global search and the change-impact explorer draw. Read-only.

  GET /eval/studio/graph               nodes (with health and its reason) and links of the evaluation ecosystem, from what the platform records
  GET /eval/studio/observed            the agent, its specialists and its tools as past executions observed them
  GET /eval/studio/search?q=           datasets, cases, benchmarks, runs, models, business rules and templates, review items
  GET /eval/studio/results             executions of every completed run, newest first, filtered by status, model, dataset and case, with the counts per status
  GET /eval/studio/analytics           what the executions in a window say: outcomes and coverage, the six evaluation layers per model, routing and tool accuracy, latency, reliability, review items per week
  GET /eval/studio/impact              the changed or depended-on items worth inspecting
  GET /eval/studio/impact/item?key=    one item: before/after, the cases that depend on it, the suggestions it caused, the versions published since, the regression comparison
Decisions on suggestions, runs, limits and bills keep their own endpoints (and audit): nothing here writes.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import verify_superadmin
from services import eval_studio as svc

router = APIRouter(prefix="/eval/studio", tags=["Evaluation studio"], dependencies=[Depends(verify_superadmin)])


@router.get("/graph")
async def graph(session: AsyncSession = Depends(get_session)):
    return await svc.graph(session)


@router.get("/observed")
async def observed(session: AsyncSession = Depends(get_session)):
    return await svc.observed(session)


@router.get("/search")
async def search(q: str = Query(default="", max_length=80), session: AsyncSession = Depends(get_session)):
    return await svc.search(session, q)


@router.get("/results")
async def results(status: Optional[str] = Query(default=None, pattern="^(passed|failed|blocked|skipped|infrastructure_error)$"), model: Optional[str] = Query(default=None, max_length=120),
                  dataset: Optional[str] = Query(default=None, max_length=80), case: Optional[str] = Query(default=None, max_length=80), run_id: Optional[str] = Query(default=None, max_length=80), include_synthetic: bool = False,
                  failed_layer: Optional[str] = Query(default=None, pattern="^L[1-6]$"), specialist: Optional[str] = Query(default=None, max_length=80), tool: Optional[str] = Query(default=None, max_length=80),
                  days: Optional[int] = Query(default=None, ge=1, le=730), limit: int = Query(default=50, ge=1, le=200), offset: int = Query(default=0, ge=0), session: AsyncSession = Depends(get_session)):
    return await svc.results(session, status=status, model=model, dataset=dataset, case=case, run_id=run_id, include_synthetic=include_synthetic, failed_layer=failed_layer, specialist=specialist, tool=tool, days=days, limit=limit, offset=offset)


@router.get("/analytics")
async def analytics(dataset: Optional[str] = Query(default=None, max_length=80), model: Optional[str] = Query(default=None, max_length=120), days: int = Query(default=90, ge=1, le=730),
                    include_synthetic: bool = False, session: AsyncSession = Depends(get_session)):
    return await svc.analytics(session, dataset=dataset, model=model, days=days, include_synthetic=include_synthetic)


@router.get("/impact")
async def impact_candidates(session: AsyncSession = Depends(get_session)):
    return await svc.impact_candidates(session)


@router.get("/impact/item")
async def impact_item(key: str = Query(max_length=160), session: AsyncSession = Depends(get_session)):
    out = await svc.impact(session, key)
    if out is None:
        raise HTTPException(404, "No such watched item.")
    return out
