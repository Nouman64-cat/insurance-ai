"""Drift Monitor API (Phase 6): the review queue of things that may have made the golden dataset out of date. SuperAdmin only.

  GET  /eval/drift/overview               counts by state, kind and severity; the last scan
  GET  /eval/drift/items[?state=&kind=&severity=&q=]   the review items (open and in-review first)
  GET  /eval/drift/items/{id}             one item with its history
  POST /eval/drift/items/{id}/{action}    start | accept | reject | dismiss | reopen   (a decision needs a written reason; accepting a
                                          case-producing item needs the expected value the reviewer wrote)
  GET  /eval/drift/items/{id}/draft       the prepared draft of a case for an accepted item (to open in the Dataset Manager)
  GET  /eval/drift/scans                  past scans
  POST /eval/drift/scans                  scan now: record the registry's changes at once, and queue a dataset scan for the worker
  GET  /eval/drift/registry               every watched item with its latest version
  GET  /eval/drift/registry/versions?key= the recorded versions of one item, with what changed
The worker's side (shared secret, never proxied): POST /internal/eval/drift/ingest, POST /internal/eval/drift/schedule.
Nothing here edits a golden case or a dataset version.
"""
import os
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, oauth2_scheme, verify_superadmin
from routers.eval_jobs import _secret
from services import eval_drift as svc
from services.audit_capture import record_standalone
from shared.evaluation import change_registry as cr
from shared.models.core import User
from shared.models.evaluation import EvalDataset, EvalDatasetVersion, EvalDriftEvent, EvalDriftItem, EvalDriftScan, EvalJob, EvalJobEvent, EvalRegistryItem, EvalRegistryVersion

router = APIRouter(prefix="/eval/drift", tags=["Drift Monitor"], dependencies=[Depends(verify_superadmin)])
internal = APIRouter(prefix="/internal/eval/drift", tags=["Drift Monitor (worker)"])
SCAN_EVERY = timedelta(hours=int(os.environ.get("EVAL_DRIFT_SCAN_EVERY_HOURS", "24")))


async def _actor(token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)) -> User:
    return await _get_current_user(token, session)


def _item(i: EvalDriftItem) -> Dict[str, Any]:
    return {"id": str(i.id), "key": i.finding_key, "kind": i.kind, "severity": i.severity, "state": i.state, "summary": i.summary, "dataset": i.dataset_slug,
            "affected_cases": i.affected_cases, "detail": i.detail, "registry_item": i.registry_item_key, "from_version": i.from_version, "to_version": i.to_version,
            "times_seen": i.times_seen, "opened_at": i.opened_at, "last_seen_at": i.last_seen_at, "cleared_at": i.cleared_at,
            "assigned_to": str(i.assigned_to) if i.assigned_to else None, "decided_by": str(i.decided_by) if i.decided_by else None, "decided_at": i.decided_at,
            "decision_note": i.decision_note, "expected": i.expected, "expected_source": i.expected_source,
            "needs_expected": i.kind in ("proposal", "rule_changed", "unconfirmed", "coverage_gap")}


async def _get(session: AsyncSession, item_id: UUID) -> EvalDriftItem:
    i = await session.get(EvalDriftItem, item_id)
    if i is None:
        raise HTTPException(404, "No such review item.")
    return i


@router.get("/overview")
async def get_overview(session: AsyncSession = Depends(get_session)):
    return await svc.overview(session)


@router.get("/items")
async def list_items(state: Optional[str] = None, kind: Optional[str] = None, severity: Optional[str] = None, q: Optional[str] = Query(default=None, max_length=80),
                     limit: int = Query(default=100, ge=1, le=500), offset: int = Query(default=0, ge=0), session: AsyncSession = Depends(get_session)):
    stmt = select(EvalDriftItem)
    if state == "active":
        stmt = stmt.where(EvalDriftItem.state.in_(["open", "in_review"]))
    elif state:
        stmt = stmt.where(EvalDriftItem.state == state)
    if kind:
        stmt = stmt.where(EvalDriftItem.kind == kind)
    if severity:
        stmt = stmt.where(EvalDriftItem.severity == severity)
    if q:
        stmt = stmt.where(EvalDriftItem.summary.ilike(f"%{q}%"))
    total = (await session.exec(select(func.count()).select_from(stmt.subquery()))).one()
    sev = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    rows = (await session.exec(stmt.order_by(EvalDriftItem.opened_at.desc()).limit(1000))).all()
    rows.sort(key=lambda i: (0 if i.state in ("open", "in_review") else 1, sev.get(i.severity, 9)))
    return {"total": total, "items": [_item(i) for i in rows[offset:offset + limit]]}


@router.get("/items/{item_id}")
async def get_item(item_id: UUID, session: AsyncSession = Depends(get_session)):
    i = await _get(session, item_id)
    ev = (await session.exec(select(EvalDriftEvent).where(EvalDriftEvent.drift_item_id == i.id).order_by(EvalDriftEvent.at))).all()
    return {**_item(i), "history": [{"at": e.at, "from": e.from_state, "to": e.to_state, "by": e.actor_kind, "actor_id": str(e.actor_id) if e.actor_id else None, "note": e.note} for e in ev]}


class Decision(BaseModel):
    note: Optional[str] = Field(default=None, max_length=2000)
    expected: Optional[Dict[str, Any]] = None


@router.post("/items/{item_id}/{action}")
async def act(item_id: UUID, action: str, body: Decision, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    i = (await session.exec(select(EvalDriftItem).where(EvalDriftItem.id == item_id).with_for_update())).first()
    if i is None:
        raise HTTPException(404, "No such review item.")
    await svc.transition(session, i, action, actor_id=actor.id, note=body.note, expected=body.expected)
    await session.commit()
    await record_standalone(module="administration", action=f"eval.drift.{action}", entity_type="eval_drift_item", entity_id=str(i.id), tenant_id=actor.tenant_id,
                            actor_id=str(actor.id), actor_type="USER", actor_role="SuperAdmin", metadata={"kind": i.kind, "state": i.state})
    return _item(i)


@router.get("/items/{item_id}/draft")
async def draft(item_id: UUID, session: AsyncSession = Depends(get_session)):
    """The prepared draft of a case for an ACCEPTED item. The expected value is the reviewer's own; the input is left for the author when the system could not know it."""
    i = await _get(session, item_id)
    if i.state != "accepted" or not i.expected:
        raise HTTPException(409, "A draft is prepared only for an accepted item that has the reviewer's expected value.")
    d = i.detail or {}
    return {"draft": {"case_id": None, "title": i.summary[:120], "stage": d.get("stage"), "scenario_type": d.get("scenario_type") or "positive", "severity": i.severity,
                      "input": d.get("proposed_input"), "expected": i.expected, "expected_source": "reviewer",
                      "provenance": {"drift_item": str(i.id), "finding_key": i.finding_key, "kind": i.kind, **(d.get("provenance") or {})}, "derived_from": i.affected_cases},
            "next": "Open this in the Dataset Manager as a new case, complete the input, and publish a new dataset version. Nothing was changed in the dataset."}


@router.get("/scans")
async def list_scans(limit: int = Query(default=30, ge=1, le=200), session: AsyncSession = Depends(get_session)):
    rows = (await session.exec(select(EvalDriftScan).order_by(EvalDriftScan.created_at.desc()).limit(limit))).all()
    jobs = (await session.exec(select(EvalJob).where(func.coalesce(EvalJob.config["kind"].astext, "") == "drift_scan").order_by(EvalJob.created_at.desc()).limit(10))).all()
    return {"scans": [{"scan_id": s.scan_id, "dataset": s.dataset_slug, "version": s.dataset_version, "source": s.source, "counts": s.counts, "created_at": s.created_at} for s in rows],
            "jobs": [{"id": str(j.id), "state": j.state, "dataset": j.config.get("dataset"), "version": j.config.get("version"), "error": j.error, "created_at": j.created_at, "finished_at": j.finished_at} for j in jobs]}


class ScanIn(BaseModel):
    dataset: Optional[str] = Field(default=None, pattern=r"^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$")
    version: Optional[str] = Field(default=None, pattern=r"^\d+\.\d+\.\d+$")


async def queue_scan(session: AsyncSession, dataset: Optional[str], version: Optional[str], created_by: Optional[UUID], reason: str) -> Optional[EvalJob]:
    """Queue a dataset scan for the worker (the latest published version unless one is named). None when there is nothing published to scan."""
    stmt = select(EvalDataset.slug, EvalDatasetVersion.version, EvalDatasetVersion.published_at).join(EvalDatasetVersion, EvalDatasetVersion.dataset_id == EvalDataset.id).where(EvalDatasetVersion.state == "published")
    if dataset:
        stmt = stmt.where(EvalDataset.slug == dataset)
    if version:
        stmt = stmt.where(EvalDatasetVersion.version == version)
    rows = (await session.exec(stmt.order_by(EvalDatasetVersion.published_at.desc()).limit(1))).all()
    if not rows:
        return None
    slug, ver, _ = rows[0]
    job = EvalJob(config={"kind": "drift_scan", "dataset": slug, "version": ver, "reason": reason}, estimate={}, created_by=created_by)
    session.add(job)
    session.add(EvalJobEvent(job_id=job.id, seq=1, kind="state", message=f"queued (drift scan: {reason})", data={"state": "queued"}))
    await session.commit()
    return job


@router.post("/scans", status_code=201)
async def scan_now(body: ScanIn, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    registry = await svc.scan_registry(session, captured_from="manual")
    await session.commit()
    job = await queue_scan(session, body.dataset, body.version, actor.id, "requested by a person")
    await record_standalone(module="administration", action="eval.drift.scan", entity_type="eval_drift_scan", entity_id=str(job.id) if job else "registry", tenant_id=actor.tenant_id,
                            actor_id=str(actor.id), actor_type="USER", actor_role="SuperAdmin", metadata={"changed": registry["changed"]})
    return {"registry": registry, "job": {"id": str(job.id), "state": job.state, "dataset": job.config["dataset"], "version": job.config["version"]} if job else None,
            "note": None if job else "No published dataset version to scan; only the registry was read."}


@router.get("/registry")
async def registry(session: AsyncSession = Depends(get_session)):
    items = (await session.exec(select(EvalRegistryItem).order_by(EvalRegistryItem.item_type, EvalRegistryItem.item_key))).all()
    out = []
    for it in items:
        vs = (await session.exec(select(EvalRegistryVersion.version, EvalRegistryVersion.captured_at).where(EvalRegistryVersion.item_id == it.id).order_by(EvalRegistryVersion.version.desc()))).all()
        out.append({"key": it.item_key, "type": it.item_type, "title": it.title, "source": it.source, "status": it.status, "version": vs[0][0] if vs else None,
                    "versions": len(vs), "last_change": vs[0][1] if vs else None, "dependent_cases": len(await svc.dependents_of(session, it.item_key))})
    return {"items": out}


@router.get("/registry/versions")
async def registry_versions(key: str = Query(max_length=160), session: AsyncSession = Depends(get_session)):
    it = (await session.exec(select(EvalRegistryItem).where(EvalRegistryItem.item_key == key))).first()
    if it is None:
        raise HTTPException(404, "No such watched item.")
    vs = (await session.exec(select(EvalRegistryVersion).where(EvalRegistryVersion.item_id == it.id).order_by(EvalRegistryVersion.version.desc()))).all()
    by = {v.version: v for v in vs}
    return {"key": key, "title": it.title, "dependents": await svc.dependents_of(session, key),
            "versions": [{"version": v.version, "captured_at": v.captured_at, "captured_from": v.captured_from, "fingerprint": v.fingerprint[:12],
                          "diff": cr.diff_summaries(by[v.version - 1].summary, v.summary) if v.version - 1 in by else []} for v in vs]}


@router.get("/knowledge-base")
async def knowledge_base(session: AsyncSession = Depends(get_session)):
    """Which published templates the agent assistant's knowledge base is up to date with."""
    from services import template_knowledge
    return {"templates": await template_knowledge.freshness(session)}


@router.post("/knowledge-base/sync")
async def knowledge_base_sync(session: AsyncSession = Depends(get_session)):
    """Bring the knowledge base up to date with every published template that is behind."""
    from services import template_knowledge
    behind = [t["template"] for t in await template_knowledge.freshness(session) if not t["current"]]
    return {"synced": {k: await template_knowledge.sync_template(session, k) for k in behind}}


# ── the worker's side ─────────────────────────────────────────────────────────────────────────────────────────────────

class Ingest(BaseModel):
    worker_id: str = Field(min_length=1, max_length=80)
    report: Dict[str, Any]
    job_id: Optional[UUID] = None


@internal.post("/ingest", dependencies=[Depends(_secret)])
async def ingest(body: Ingest, session: AsyncSession = Depends(get_session)):
    out = await svc.ingest_scan(session, body.report, job_id=body.job_id)
    await session.commit()
    return out


@internal.post("/schedule", dependencies=[Depends(_secret)])
async def schedule(session: AsyncSession = Depends(get_session)):
    """The worker asks once in a while: scan if no scan was queued within SCAN_EVERY (the nightly scan). Reads the registry first."""
    recent = (await session.exec(select(EvalJob.id).where(func.coalesce(EvalJob.config["kind"].astext, "") == "drift_scan", EvalJob.created_at > datetime.utcnow() - SCAN_EVERY).limit(1))).first()
    if recent:
        return {"queued": False}
    reg = await svc.scan_registry(session, captured_from="scheduled")
    await session.commit()
    job = await queue_scan(session, None, None, None, "scheduled")
    return {"queued": bool(job), "registry_changed": reg["changed"]}
