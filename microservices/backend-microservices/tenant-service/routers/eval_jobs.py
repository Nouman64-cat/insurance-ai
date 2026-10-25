"""Evaluation jobs: request a run, watch it live, cancel it. SuperAdmin only.

A job is a requested evaluation run that lives in the platform database, so it survives a restart and can be seen by anyone with access:
  POST /eval/jobs                 request a run of a published dataset version (what to run, with which model, skills, prompt, judge,
                                  repetitions, limits). The request is checked here, before anything is queued.
  GET  /eval/jobs[?state=]        the jobs, newest first
  GET  /eval/jobs/{id}            one job: state, config, progress, error, and the run it produced
  GET  /eval/jobs/{id}/events     its events as JSON, after a sequence number
  GET  /eval/jobs/{id}/stream     the same events live, as Server-Sent Events (id: is the sequence, so a dropped connection resumes
                                  with Last-Event-ID); ends with `event: end` once the job is finished
  POST /eval/jobs/{id}/cancel     ask it to stop: a queued job is cancelled at once, a running one finishes the case in flight

The evaluation itself runs in the isolated evaluation stack, which never talks to the platform. A WORKER on the host (envctl.py worker)
claims queued jobs through the internal endpoints below (shared secret, never proxied by the gateway), drives the stack, sends its
events back, and finishes the job with the run it produced. A worker that stops sending heartbeats loses its job (state `lost`).
"""
import asyncio
import hmac
import json
import os
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, oauth2_scheme, verify_superadmin
from services.audit_capture import record_standalone
from services.eval_estimate import estimate_cost
from services.eval_lake import get_lake
from shared.evaluation import judge as judge_lib
from shared.evaluation.object_store import IntegrityFailure, LakeError
from shared.models.core import User
from shared.models.evaluation import EvalDataset, EvalDatasetVersion, EvalJob, EvalJobEvent, EvalModel, EvalRun, EvalVersionCase

router = APIRouter(prefix="/eval/jobs", tags=["Evaluation jobs"], dependencies=[Depends(verify_superadmin)])
internal = APIRouter(prefix="/internal/eval/jobs", tags=["Evaluation jobs (worker)"])

TERMINAL = ("succeeded", "failed", "cancelled", "lost")
HEARTBEAT_LOST_AFTER = timedelta(seconds=int(os.environ.get("EVAL_JOB_HEARTBEAT_LOST_SECONDS", "120")))
_SLUG = r"^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$"
_ID = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$"
_MODEL = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,40}/[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$"
INTERNAL_API_SECRET = os.environ.get("INTERNAL_API_SECRET", "").strip()


class JobRequest(BaseModel):
    """What to run. Every field is checked against a strict pattern: the worker turns these into command-line arguments."""
    dataset: str = Field(pattern=_SLUG)
    version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    suite: Literal["technical", "business"] = "technical"
    case_ids: List[str] = Field(default_factory=list, max_length=500)
    categories: List[str] = Field(default_factory=list, max_length=20)
    operations: List[str] = Field(default_factory=list, max_length=40)
    model: Optional[str] = Field(default=None, pattern=_MODEL)
    skills: Literal["on", "off", "default"] = "default"
    prompt_version: Optional[str] = Field(default=None, pattern=_ID)
    judge: Optional[str] = Field(default=None, pattern=_MODEL)
    metrics: List[str] = Field(default_factory=list, max_length=7, description="judge only these metrics (default: whatever each case asks for)")
    allow_same_judge: bool = False
    repeat: str = Field(default="1", pattern=r"^(auto|[1-9][0-9]{0,2})$")
    kind: Literal["suite", "benchmark_agent", "benchmark_direct"] = "suite"
    models: List[str] = Field(default_factory=list, max_length=8, description="a benchmark: the models to compare (provider/model each), at least two")
    settings: List[str] = Field(default_factory=list, max_length=6, description="a direct benchmark: model settings, temperature=0")
    vary: Optional[str] = Field(default=None, pattern=r"^(skills|prompt|model)=[^,\s]+(,[^,\s]+)+$", description="a paired comparison: skills=on,off")
    retries: int = Field(default=1, ge=0, le=5)
    concurrency: int = Field(default=4, ge=1, le=16)
    timeout: int = Field(default=120, ge=1, le=900)
    chat_timeout: int = Field(default=300, ge=1, le=3600)
    budget_usd: Optional[float] = Field(default=None, ge=0, le=1000)
    max_latency_ms: Optional[int] = Field(default=None, ge=1)
    max_tokens: Optional[int] = Field(default=None, ge=1)
    max_cost_usd: Optional[float] = Field(default=None, ge=0)
    stop_on_critical: bool = False
    gate: bool = False
    gate_min_pass_rate: float = Field(default=0.9, ge=0, le=1)
    gate_min_repetitions: int = Field(default=1, ge=1, le=100)
    strict: bool = False

    @field_validator("models")
    @classmethod
    def _models(cls, values: List[str]) -> List[str]:
        for v in values:
            if not re.fullmatch(_MODEL, v):
                raise ValueError(f"{v!r} is not provider/model")
        return values

    @field_validator("metrics")
    @classmethod
    def _metrics(cls, values: List[str]) -> List[str]:
        bad = [v for v in values if v not in judge_lib.METRICS]
        if bad or len(set(values)) != len(values):
            raise ValueError(f"metrics are chosen once each from {', '.join(judge_lib.METRICS)}")
        return values

    @field_validator("settings")
    @classmethod
    def _settings(cls, values: List[str]) -> List[str]:
        for v in values:
            if not re.fullmatch(r"(temperature|top_p|max_tokens|seed)=-?[0-9]+(\.[0-9]+)?", v):
                raise ValueError(f"{v!r} is not a model setting (temperature, top_p, max_tokens or seed = a number)")
        return values

    @field_validator("case_ids", "categories", "operations")
    @classmethod
    def _tokens(cls, values: List[str]) -> List[str]:
        for v in values:
            if not re.fullmatch(_ID, v):
                raise ValueError(f"{v!r} is not a valid identifier")
        return values


def _secret(x_internal_secret: str = Header(default="")) -> None:
    if not INTERNAL_API_SECRET:
        raise HTTPException(status_code=503, detail="Internal API secret is not configured")
    if not hmac.compare_digest(x_internal_secret.encode(), INTERNAL_API_SECRET.encode()):
        raise HTTPException(status_code=401, detail="Invalid internal secret")


async def _actor(token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)) -> User:
    return await _get_current_user(token, session)


def _out(job: EvalJob) -> Dict[str, Any]:
    return {"id": str(job.id), "state": job.state, "config": job.config, "estimate": job.estimate, "progress": job.progress, "cancel_requested": job.cancel_requested,
            "run_id": job.run_id, "error": job.error, "worker_id": job.worker_id, "heartbeat_at": job.heartbeat_at, "created_by": str(job.created_by) if job.created_by else None,
            "created_at": job.created_at, "started_at": job.started_at, "finished_at": job.finished_at}


def _event_out(e: EvalJobEvent) -> Dict[str, Any]:
    return {"seq": e.seq, "at": e.at, "kind": e.kind, "message": e.message, "data": e.data}


async def _check_request(session: AsyncSession, req: JobRequest) -> Dict[str, Any]:
    """Refuse a request that cannot run, say what it would run. Nothing is queued on a refusal."""
    dataset = (await session.exec(select(EvalDataset).where(EvalDataset.slug == req.dataset))).first()
    if dataset is None:
        raise HTTPException(404, f"No dataset '{req.dataset}'.")
    version = (await session.exec(select(EvalDatasetVersion).where(
        EvalDatasetVersion.dataset_id == dataset.id, EvalDatasetVersion.version == req.version, EvalDatasetVersion.state == "published"))).first()
    if version is None:
        raise HTTPException(422, detail={"message": f"{req.dataset} has no published version {req.version}. Only a published (immutable) version can be evaluated.", "problems": []})
    problems: List[str] = []
    try:
        judge_lib.check_governance(req.judge, req.model, allow_same=req.allow_same_judge)
    except judge_lib.JudgeGovernanceError as exc:
        problems.append(str(exc))
    if req.vary:
        dim, _, values = req.vary.partition("=")
        if dim == "skills" and not set(values.split(",")) <= {"on", "off", "default"}:
            problems.append("skills values are on, off or default")
        if dim == "model" and not all(re.fullmatch(_MODEL, v) for v in values.split(",")):
            problems.append("model values must be provider/model")
        if dim == "prompt" and not all(v == "none" or re.fullmatch(_ID, v) for v in values.split(",")):
            problems.append("prompt values must be prompt version names (or none)")
        if {"skills": req.skills != "default", "prompt": bool(req.prompt_version), "model": bool(req.model)}.get(dim) and dim != "model":
            problems.append(f"{dim} is varied, so it cannot also be set for the whole run")
        if dim == "model" and req.model:
            problems.append("model is varied, so it cannot also be set for the whole run")
    if req.kind.startswith("benchmark_"):
        mode = req.kind.split("_", 1)[1]
        if len(req.models) < 2 or len(set(req.models)) != len(req.models):
            problems.append("a benchmark compares at least two different models (models)")
        if req.model or req.vary:
            problems.append("a benchmark chooses its models in `models`; model and vary are for single runs")
        if mode == "direct" and (req.skills != "default" or req.prompt_version):
            problems.append("skills and prompt version belong to the agent: a direct benchmark calls the bare model")
        if mode == "agent" and req.settings:
            problems.append("model settings apply to a direct benchmark; the agent uses the platform's own configuration")
        for label in req.models:
            provider, _, model_id = label.partition("/")
            entry = (await session.exec(select(EvalModel).where(EvalModel.provider == provider, EvalModel.model_id == model_id))).first()
            if entry is None:
                problems.append(f"{label} is not in the model registry; register it first")
            elif entry.status != "active" or "candidate" not in (entry.roles or []):
                problems.append(f"{label} is {entry.status} / roles {','.join(entry.roles or [])}: it cannot be benchmarked")
        if req.judge:
            provider, _, model_id = req.judge.partition("/")
            judge = (await session.exec(select(EvalModel).where(EvalModel.provider == provider, EvalModel.model_id == model_id))).first()
            if judge is None or judge.status != "active" or "judge" not in (judge.roles or []):
                problems.append(f"{req.judge} is not an active judge in the model registry")
            if req.judge in req.models and not req.allow_same_judge:
                problems.append("the judge is also one of the models being compared; choose another judge or allow it on purpose")
    elif req.models or req.settings:
        problems.append("models and settings are for a benchmark (kind benchmark_agent or benchmark_direct)")
    if req.metrics and not req.judge:
        problems.append("metrics choose what the judge scores: a judge is needed")
    if req.model is None and not req.vary:
        pass                                                           # a run without a model still runs every non-chat case; chat cases are skipped
    if problems:
        raise HTTPException(422, detail={"message": "This run cannot be requested.", "problems": problems})
    rows = (await session.exec(select(EvalVersionCase.category, func.count()).where(EvalVersionCase.version_id == version.id).group_by(EvalVersionCase.category))).all()
    in_scope = sum(n for cat, n in rows if not req.categories or cat in req.categories)
    cases = len(req.case_ids) if req.case_ids else in_scope
    reps = None if req.repeat == "auto" else int(req.repeat)
    variants = len(req.vary.split("=", 1)[1].split(",")) if req.vary else (len(req.models) if req.models else 1)
    estimate = {"cases_in_version": version.case_count, "cases_selected": cases, "repetitions": req.repeat, "variants": variants,
                "executions": (cases * reps * variants) if reps else None, "real_model": any(not m.startswith("mock/") for m in ([req.model] if req.model else req.models)),
                "synthetic": any(m.startswith("mock/") for m in ([req.model] if req.model else req.models)), "note": "executions are an upper bound: a case skipped or blocked does not run"}
    try:
        loaded = await get_lake().load_version(version)                # the preview reads the verified snapshot, so it counts the cases that would really run
        estimate["cost"] = await estimate_cost(session, req, loaded.cases)
    except (IntegrityFailure, LakeError) as exc:
        estimate["cost"] = {"error": f"the cost could not be estimated: the data lake did not give the verified version ({exc})"}
    return estimate


async def _budget_gate(session: AsyncSession, estimate: Dict[str, Any], actor: User, req: JobRequest) -> Dict[str, Any]:
    """Stop scheduling when the request would pass an enforced daily or monthly budget; the refusal is audited. Returns the budget status to keep with the job."""
    from services import eval_budget
    try:
        return await eval_budget.enforce(session, estimate)
    except HTTPException as exc:
        await record_standalone(module="administration", action="eval.budget.refused", entity_type="eval_job", entity_id="-", tenant_id=actor.tenant_id, actor_id=str(actor.id),
                                actor_type="USER", actor_role="SuperAdmin", metadata={"dataset": req.dataset, "version": req.version, "problems": (exc.detail or {}).get("problems", [])[:4]})
        raise


@router.post("/estimate")
async def preview_job(req: JobRequest, session: AsyncSession = Depends(get_session)):
    """What this request would run and cost, checked exactly as a real request is. Nothing is queued."""
    estimate = await _check_request(session, req)
    from services import eval_budget
    return {"valid": True, "estimate": estimate, "budget": await eval_budget.status(session, eval_budget.estimate_total(estimate))}


@router.post("/{job_id}/rerun", status_code=201)
async def rerun_job(job_id: UUID, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    """Queue a new job with the same request as an earlier one (checked again: the dataset version or the registry may have changed since)."""
    old = await _job(session, job_id)
    try:
        req = JobRequest.model_validate(old.config)
    except Exception as exc:                                                                      # noqa: BLE001
        raise HTTPException(422, detail={"message": "The earlier request is no longer valid.", "problems": [str(exc)[:300]]})
    estimate = await _check_request(session, req)
    estimate["budget"] = await _budget_gate(session, estimate, actor, req)
    job = EvalJob(config=req.model_dump(exclude_none=True), estimate=estimate, created_by=actor.id)
    session.add(job)
    session.add(EvalJobEvent(job_id=job.id, seq=1, kind="state", message=f"queued (rerun of {old.id})", data={"state": "queued", "rerun_of": str(old.id)}))
    await session.commit()
    await record_standalone(module="administration", action="eval.job.rerun", entity_type="eval_job", entity_id=str(job.id), tenant_id=actor.tenant_id,
                            actor_id=str(actor.id), actor_type="USER", actor_role="SuperAdmin", metadata={"rerun_of": str(old.id)})
    return _out(job)


@router.post("", status_code=201)
async def create_job(req: JobRequest, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    estimate = await _check_request(session, req)
    estimate["budget"] = await _budget_gate(session, estimate, actor, req)
    config = req.model_dump(exclude_none=True)
    job = EvalJob(config=config, estimate=estimate, created_by=actor.id)
    session.add(job)
    session.add(EvalJobEvent(job_id=job.id, seq=1, kind="state", message="queued", data={"state": "queued"}))
    await session.commit()
    await record_standalone(module="administration", action="eval.job.create", entity_type="eval_job", entity_id=str(job.id), tenant_id=actor.tenant_id,
                            actor_id=str(actor.id), actor_type="USER", actor_role="SuperAdmin", metadata={"dataset": req.dataset, "version": req.version})
    return _out(job)


@router.get("")
async def list_jobs(state: Optional[str] = Query(default=None), limit: int = Query(default=50, ge=1, le=200), session: AsyncSession = Depends(get_session)):
    stmt = select(EvalJob).where(func.coalesce(EvalJob.config["kind"].astext, "") != "drift_scan").order_by(EvalJob.created_at.desc()).limit(limit)     # scans have their own page
    if state:
        stmt = stmt.where(EvalJob.state == state)
    return [_out(j) for j in (await session.exec(stmt)).all()]


async def _job(session: AsyncSession, job_id: UUID) -> EvalJob:
    job = await session.get(EvalJob, job_id)
    if job is None:
        raise HTTPException(404, "No such job.")
    return job


@router.get("/{job_id}")
async def get_job(job_id: UUID, session: AsyncSession = Depends(get_session)):
    job = await _job(session, job_id)
    out = _out(job)
    if job.run_id:
        run = (await session.exec(select(EvalRun).where(EvalRun.run_id == job.run_id))).first()
        out["run"] = {"run_id": run.run_id, "state": run.state, "passed": run.passed, "failed": run.failed, "blocked": run.blocked, "skipped": run.skipped,
                      "infrastructure_errors": run.infrastructure_errors, "pass_rate": run.pass_rate, "known_cost_usd": run.known_cost_usd} if run else None
    return out


@router.get("/{job_id}/events")
async def job_events(job_id: UUID, after: int = Query(default=0, ge=0), limit: int = Query(default=500, ge=1, le=2000), session: AsyncSession = Depends(get_session)):
    await _job(session, job_id)
    rows = (await session.exec(select(EvalJobEvent).where(EvalJobEvent.job_id == job_id, EvalJobEvent.seq > after).order_by(EvalJobEvent.seq).limit(limit))).all()
    return [_event_out(e) for e in rows]


def _sse(e: EvalJobEvent) -> str:
    return f"id: {e.seq}\nevent: {e.kind}\ndata: {json.dumps(_event_out(e), default=str)}\n\n"


@router.get("/{job_id}/stream")
async def job_stream(job_id: UUID, request: Request, after: int = Query(default=0, ge=0), last_event_id: Optional[str] = Header(default=None),
                     session: AsyncSession = Depends(get_session)):
    """Live events. The cursor is `after`, or the browser's Last-Event-ID after a dropped connection."""
    await _job(session, job_id)
    cursor = after
    if last_event_id and last_event_id.isdigit():
        cursor = max(cursor, int(last_event_id))

    async def gen():
        from database import _session_factory
        nonlocal cursor
        quiet = 0
        while True:
            if await request.is_disconnected():
                return
            async with _session_factory() as s:
                events = (await s.exec(select(EvalJobEvent).where(EvalJobEvent.job_id == job_id, EvalJobEvent.seq > cursor).order_by(EvalJobEvent.seq).limit(200))).all()
                job = await s.get(EvalJob, job_id)
            for e in events:
                cursor = e.seq
                yield _sse(e)
            if job is not None and job.state in TERMINAL and not events:
                yield f"event: end\ndata: {json.dumps({'state': job.state, 'run_id': job.run_id, 'error': job.error})}\n\n"
                return
            quiet = 0 if events else quiet + 1
            if quiet and quiet % 15 == 0:
                yield ": keep-alive\n\n"
            await asyncio.sleep(1.0)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


async def _append(session: AsyncSession, job: EvalJob, kind: str, message: Optional[str], data: Dict[str, Any], at: Optional[datetime] = None) -> EvalJobEvent:
    last = (await session.exec(select(func.max(EvalJobEvent.seq)).where(EvalJobEvent.job_id == job.id))).one()
    event = EvalJobEvent(job_id=job.id, seq=(last or 0) + 1, kind=kind, message=message, data=data, **({"at": at} if at else {}))
    session.add(event)
    return event


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: UUID, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    job = (await session.exec(select(EvalJob).where(EvalJob.id == job_id).with_for_update())).first()
    if job is None:
        raise HTTPException(404, "No such job.")
    if job.state in TERMINAL:
        raise HTTPException(409, f"The job is already {job.state}.")
    if job.state == "queued":
        job.state, job.finished_at, job.cancel_requested = "cancelled", datetime.utcnow(), True
        await _append(session, job, "state", "cancelled before it started", {"state": "cancelled"})
    else:
        job.cancel_requested = True
        await _append(session, job, "log", "cancel requested: the case in flight will finish, then the run stops", {"cancel_requested": True})
    session.add(job)
    await session.commit()
    await record_standalone(module="administration", action="eval.job.cancel", entity_type="eval_job", entity_id=str(job.id), tenant_id=actor.tenant_id,
                            actor_id=str(actor.id), actor_type="USER", actor_role="SuperAdmin", metadata={})
    return _out(job)


# ── the worker's side ─────────────────────────────────────────────────────────────────────────────────────────────────

class Claim(BaseModel):
    worker_id: str = Field(min_length=1, max_length=80)


class Events(BaseModel):
    worker_id: str
    events: List[Dict[str, Any]] = Field(default_factory=list, max_length=500)


class Finish(BaseModel):
    worker_id: str
    state: Literal["succeeded", "failed", "cancelled"]
    run_id: Optional[str] = None
    error: Optional[str] = None


async def _reap(session: AsyncSession) -> None:
    """A running job whose worker went quiet is lost: say so, so nobody waits for it."""
    cutoff = datetime.utcnow() - HEARTBEAT_LOST_AFTER
    for job in (await session.exec(select(EvalJob).where(EvalJob.state == "running", EvalJob.heartbeat_at < cutoff).with_for_update(skip_locked=True))).all():
        job.state, job.finished_at, job.error = "lost", datetime.utcnow(), "the worker stopped sending heartbeats"
        await _append(session, job, "state", "lost: the worker stopped sending heartbeats", {"state": "lost"})
        session.add(job)


@internal.post("/claim", dependencies=[Depends(_secret)])
async def claim(body: Claim, session: AsyncSession = Depends(get_session)):
    await _reap(session)
    job = (await session.exec(select(EvalJob).where(EvalJob.state == "queued").order_by(EvalJob.created_at).limit(1).with_for_update(skip_locked=True))).first()
    if job is None:
        await session.commit()
        return {"job": None}
    job.state, job.worker_id, job.started_at, job.heartbeat_at = "running", body.worker_id, datetime.utcnow(), datetime.utcnow()
    await _append(session, job, "state", f"claimed by {body.worker_id}", {"state": "running", "worker_id": body.worker_id})
    session.add(job)
    await session.commit()
    return {"job": {"id": str(job.id), "config": job.config}}


async def _owned(session: AsyncSession, job_id: UUID, worker_id: str) -> EvalJob:
    job = (await session.exec(select(EvalJob).where(EvalJob.id == job_id).with_for_update())).first()
    if job is None:
        raise HTTPException(404, "No such job.")
    if job.worker_id != worker_id:
        raise HTTPException(409, "This job belongs to another worker.")
    return job


@internal.post("/{job_id}/events", dependencies=[Depends(_secret)])
async def post_events(job_id: UUID, body: Events, session: AsyncSession = Depends(get_session)):
    job = await _owned(session, job_id, body.worker_id)
    for e in body.events:
        kind = e.get("kind") if e.get("kind") in ("log", "case", "progress", "cost", "state") else "log"
        data = e.get("data") if isinstance(e.get("data"), dict) else {}
        await _append(session, job, kind, (str(e.get("message"))[:2000] if e.get("message") is not None else None), data)
        if kind == "progress":
            job.progress = data
    job.heartbeat_at = datetime.utcnow()
    if not job.cancel_requested and any(e.get("kind") == "case" for e in body.events):
        await session.flush()
        from services import eval_budget
        verdict = await eval_budget.check_running(session, job)
        if not verdict["allowed"]:                                                    # a limit that is enforced has been passed: stop the run, keep what it has
            job.cancel_requested = True
            reason = "; ".join(verdict["messages"])[:600]
            await _append(session, job, "log", f"stopped by the spending limit: {reason}. The case in flight will finish, then the run stops and keeps what it has.",
                          {"cancel_requested": True, "stopped_by": "budget", "job_spent_usd": verdict.get("job_spent_usd")})
            await record_standalone(module="administration", action="eval.budget.stopped_running_job", entity_type="eval_job", entity_id=str(job.id), tenant_id=None, actor_id=None,
                                    actor_type="SYSTEM", actor_role="SYSTEM", metadata={"job_spent_usd": verdict.get("job_spent_usd"), "messages": verdict["messages"][:3]})
    session.add(job)
    await session.commit()
    return {"cancel_requested": job.cancel_requested, "state": job.state}


@internal.post("/{job_id}/heartbeat", dependencies=[Depends(_secret)])
async def heartbeat(job_id: UUID, body: Claim, session: AsyncSession = Depends(get_session)):
    job = await _owned(session, job_id, body.worker_id)
    job.heartbeat_at = datetime.utcnow()
    session.add(job)
    await session.commit()
    return {"cancel_requested": job.cancel_requested, "state": job.state}


@internal.post("/{job_id}/finish", dependencies=[Depends(_secret)])
async def finish(job_id: UUID, body: Finish, session: AsyncSession = Depends(get_session)):
    job = await _owned(session, job_id, body.worker_id)
    job.state = body.state if not (job.cancel_requested and body.state == "succeeded") else "cancelled"
    job.run_id, job.error, job.finished_at = body.run_id, (body.error or None), datetime.utcnow()
    await _append(session, job, "state", f"{job.state}" + (f": {body.error}" if body.error else ""), {"state": job.state, "run_id": body.run_id})
    session.add(job)
    await session.commit()
    return _out(job)
