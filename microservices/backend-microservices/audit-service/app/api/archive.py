"""Archive & retention API: what is archived, where, how it is verified, how history is retrieved, and who may change retention.

Access (same sign-in check as the rest of the audit trail):
  Admin       read-only on their own tenant: catalog, status, jobs, verification, retrieval requests and results, evidence packages;
  SuperAdmin  every tenant, plus the controls: run/plan archiving, retention policies, legal holds, hot cleanup, job retry.
Every sensitive action (retrieval, verification, evidence download, hold, policy, cleanup) is itself recorded in the audit ledger.
Retrieval never writes to the live chain: results land in a staging table, flagged as archived and verified.
"""
import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from app import db
from app.archive import evidence as evidence_pkg, policy as pol, repository as repo
from app.archive.cleanup import CleanupService
from app.archive.retrieval import RetrievalError, retrieval_to_api
from app.archive.store import StoreError
from app.auth import Identity, current_identity, scope_for
from app.config import settings
from app.services import audit_service
from app.trust import key_registry
from shared.audit.hashing import format_timestamp
from shared.audit.schema import AuditIntent

log = logging.getLogger("audit.api.archive")
router = APIRouter(prefix="/v1/archive", tags=["Archive & retention"])
CLEANUP_CONFIRMATION = "REMOVE-HOT-PARTITIONS"


def _services(request: Request):
    services = getattr(request.app.state, "archive", None)
    if services is None:
        raise HTTPException(503, "Archiving is not enabled on this installation.")
    return services


def _super(identity: Identity) -> None:
    if not identity.is_super_admin:
        raise HTTPException(403, "Only the platform administrator can do this.")


def _tenant(identity: Identity) -> Optional[str]:
    return None if identity.is_super_admin else str(identity.tenant_id)


async def _entry(archive_id: str, identity: Identity, with_bloom: bool = False) -> dict:
    try:
        UUID(archive_id)
    except ValueError:
        raise HTTPException(404, "Archive not found.")
    async with db.engine().connect() as conn:
        row = await repo.get_catalog(conn, archive_id, with_bloom)
    if row is None or (not identity.is_super_admin and str(row["tenant_id"]) != str(identity.tenant_id)):
        raise HTTPException(404, "Archive not found.")      # same answer for "does not exist" and "not yours"
    return dict(row)


async def record_access(identity: Identity, action: str, entity_type: str, entity_id: Optional[str], tenant_id: Optional[str], details: dict) -> None:
    """Archive access is audited like any other action: appended to the tenant's own chain by this service. Failing to audit fails the request."""
    try:
        await audit_service.ingest([AuditIntent(
            source_service="audit-service", source_event_id=f"archive-access-{uuid.uuid4().hex}",
            tenant_id=UUID(tenant_id) if tenant_id else None, actor_id=str(identity.user_id), actor_type="USER", actor_role=identity.role,
            module="audit", action=action, entity_type=entity_type, entity_id=entity_id,
            new_value=details, metadata={"actor_name": identity.name, "actor_email": identity.email})])
    except Exception:
        log.exception("could not audit %s", action)
        raise HTTPException(503, "The action could not be recorded in the audit trail, so it was not performed.")


# ── overview ──────────────────────────────────────────────────────────────────────────────────────────────────
@router.get("/status", summary="Archive & retention overview")
async def status(request: Request, identity: Identity = Depends(current_identity)):
    scope = scope_for(identity)
    tenant = None if scope.unrestricted else str(scope.tenant_id)
    services = getattr(request.app.state, "archive", None)
    out: dict = {
        "enabled": services is not None and settings.archiving_enabled, "server_time": format_timestamp(datetime.now(timezone.utc)),
        "config": {"hot_retention_months": settings.hot_retention_months, "schedule": settings.archive_schedule, "compression": settings.archive_compression,
                   "encryption": "AES-256-GCM (chunked, per-archive data key, wrapped by the master key)", "storage_provider": settings.archive_storage_provider,
                   "bucket": settings.archive_bucket, "auto_hot_cleanup": settings.auto_hot_cleanup, "cleanup_mode": settings.cleanup_mode,
                   "cleanup_safety_days": settings.cleanup_safety_days, "object_lock_mode": settings.lock_mode, "object_lock_days": settings.lock_days,
                   "test_mode": settings.archive_test_mode},
        "storage": None, "master_key": None, "hot": None, "partitions": None,
    }
    async with db.engine().connect() as conn:
        out["summary"] = await repo.summary(conn, tenant, scope.unrestricted)
        out["pending_jobs"] = await repo.list_jobs(conn, tenant, scope.unrestricted, ["ELIGIBLE", "VERIFYING", "EXPORTING", "UPLOADING", "VALIDATING"], 20)
        out["failed_jobs"] = await repo.list_jobs(conn, tenant, scope.unrestricted, ["FAILED"], 20)
        out["recent_jobs"] = await repo.list_jobs(conn, tenant, scope.unrestricted, None, 10)
        out["holds"] = await repo.list_holds(conn, tenant, scope.unrestricted, active_only=True)
        out["policies"] = await _effective_policies(conn, tenant)
        clause, params = ("", {}) if scope.unrestricted else ("WHERE tenant_id = CAST(:t AS uuid)", {"t": tenant})
        hot = (await conn.execute(text(f"SELECT count(*) AS n, min(occurred_at) AS first_at, min(recorded_at) AS first_rec, max(recorded_at) AS last_rec FROM events {clause}"), params)).mappings().one()
        out["hot"] = {"events": hot["n"], "oldest_event_at": format_timestamp(hot["first_at"]) if hot["first_at"] else None,
                      "newest_recorded_at": format_timestamp(hot["last_rec"]) if hot["last_rec"] else None}
        if scope.unrestricted:
            out["partitions"] = [{"partition": r["partition_name"], "month": r["month_start"].strftime("%Y-%m"), "events": r["row_count"], "bytes": r["total_bytes"]}
                                 for r in (await conn.execute(text("SELECT * FROM list_event_partitions() ORDER BY month_start"))).mappings().all()]
            out["runs"] = await repo.recent_runs(conn, 5)
    if services is not None:
        out["master_key"] = {"available": services.keyring.available()}
        try:
            out["storage"] = await asyncio.wait_for(asyncio.to_thread(services.reader.capabilities), 8)
        except Exception as exc:
            out["storage"] = {"reachable": False, "problem": f"{type(exc).__name__}: {exc}"[:200]}
    return out


async def _effective_policies(conn, tenant: Optional[str]) -> list[dict]:
    rows = await repo.policy_rows(conn, tenant)
    resolved = pol.resolve(rows, settings.hot_retention_months)
    return [{"category": c, "hot_retention_months": p.hot_retention_months, "cold_retention_years": p.cold_retention_years, "allow_hot_cleanup": p.allow_hot_cleanup,
             "approved": p.approved, "scope": "tenant" if p.tenant_id else "platform default"} for c, p in resolved.items()]


# ── catalog ───────────────────────────────────────────────────────────────────────────────────────────────────
@router.get("/catalog", summary="Search archives")
async def catalog(chain_id: Optional[str] = Query(None, max_length=128), date_from: Optional[datetime] = Query(None, alias="from"),
                  date_to: Optional[datetime] = Query(None, alias="to"), module: Optional[str] = Query(None, max_length=48),
                  action: Optional[str] = Query(None, max_length=96), page: int = Query(1, ge=1, le=10000), page_size: int = Query(25, ge=1, le=100),
                  identity: Identity = Depends(current_identity)):
    scope = scope_for(identity)
    async with db.engine().connect() as conn:
        rows, total = await repo.search_catalog(conn, tenant_id=None if scope.unrestricted else str(scope.tenant_id), unrestricted=scope.unrestricted, chain_id=chain_id,
                                                since=date_from, until=date_to, module=module, action=action, limit=page_size, offset=(page - 1) * page_size)
    return {"items": [repo.catalog_to_api(r) for r in rows], "total": total, "page": page, "page_size": page_size}


@router.get("/catalog/{archive_id}", summary="One archive with its verification history")
async def catalog_item(archive_id: str, identity: Identity = Depends(current_identity)):
    row = await _entry(archive_id, identity)
    async with db.engine().connect() as conn:
        history = await repo.verifications_for(conn, archive_id)
        job = await repo.get_job(conn, str(row["job_id"]))
    return {**repo.catalog_to_api(row), "verifications": history, "job": repo.job_to_api(job) if job else None}


class VerifyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    archive_id: str
    deep: bool = False


@router.post("/verify", summary="Verify an archive: manifest signature, checksum and (deep) every event hash")
async def verify(body: VerifyBody, request: Request, identity: Identity = Depends(current_identity)):
    services = _services(request)
    row = await _entry(body.archive_id, identity)
    async with db.engine().connect() as conn:
        env = str((await conn.execute(text("SELECT environment_id FROM environment"))).scalar_one())
    result = await services.verifier.verify(row, deep=body.deep, env=env)
    async with db.transaction() as conn:
        vid = await repo.add_verification(conn, body.archive_id, "DEEP" if body.deep else "SAMPLE", result.state, result.code,
                                          {"findings": [f.to_api() for f in result.findings], **result.details}, identity.requester, result.duration_ms)
    await record_access(identity, "archive.verified", "archive", body.archive_id, str(row["tenant_id"]) if row["tenant_id"] else None,
                        {"deep": body.deep, "state": result.state, "findings": [f.code for f in result.findings]})
    return {**result.to_api(), "verification_id": vid}


class ChainBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    chain_id: str = Field(max_length=128)


@router.post("/verify-chain", summary="Verify a chain end to end, including its archived history, against signed manifests and checkpoints")
async def verify_chain(body: ChainBody, identity: Identity = Depends(current_identity)):
    from app.verification import integrity_verifier
    async with db.engine().connect() as conn:
        row = (await conn.execute(text("SELECT tenant_id FROM chains WHERE chain_id = :c"), {"c": body.chain_id})).first()
    if row is None or (not identity.is_super_admin and str(row.tenant_id) != str(identity.tenant_id)):
        raise HTTPException(404, "Audit chain not found.")
    result = await integrity_verifier.verify_anchored(body.chain_id)
    await integrity_verifier.record_run(result, "ON_DEMAND", identity.requester)
    return result.to_api()


@router.get("/catalog/{archive_id}/evidence", summary="Download an evidence package for external verification")
async def evidence(archive_id: str, request: Request, include_data: bool = Query(False), identity: Identity = Depends(current_identity)):
    services = _services(request)
    row = await _entry(archive_id, identity)
    tenant = str(row["tenant_id"]) if row["tenant_id"] else None
    async with db.engine().connect() as conn:
        env = str((await conn.execute(text("SELECT environment_id FROM environment"))).scalar_one())
    verification = await services.verifier.verify(row, deep=False, env=env)
    envelope = services.storage.read_archive(env, tenant, row["archive_number"])
    if not envelope or envelope.get("unreadable"):
        raise HTTPException(409, "The signed manifest is not available in protected storage; an evidence package cannot be built.")
    cov = envelope["manifest"]["covered_checkpoints"]
    checkpoints = [services.storage.read(env, tenant, n) for n in range(cov["first_number"], cov["last_number"] + 1)]
    try:
        registry = {"keys": key_registry.load_registry(env, str(services.storage.root)).public_list()}
    except Exception:
        registry = None
    data_path = None
    if include_data:
        data_path = services.worker.work_dir / f"evidence-{row['archive_id']}.iaar"
        services.worker.work_dir.mkdir(parents=True, exist_ok=True)
        try:
            await asyncio.to_thread(services.reader.get_file, row["data_key"], data_path, row.get("data_version_id"))
        except StoreError as exc:
            raise HTTPException(503, f"The archive object cannot be read from object storage: {exc.message}")
    try:
        payload = await asyncio.to_thread(evidence_pkg.build, row, verification, manifest_envelope=envelope, checkpoints=checkpoints, registry=registry, data_path=data_path)
    finally:
        if data_path:
            data_path.unlink(missing_ok=True)
    await record_access(identity, "archive.evidence_downloaded", "archive", archive_id, tenant, {"include_data": include_data, "verification": verification.state})
    return Response(payload, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="audit-archive-{row["archive_number"]:06d}-evidence.zip"'})


# ── jobs ──────────────────────────────────────────────────────────────────────────────────────────────────────
@router.get("/jobs", summary="Archive jobs")
async def jobs(state: Optional[str] = Query(None, max_length=40), limit: int = Query(50, ge=1, le=200), identity: Identity = Depends(current_identity)):
    scope = scope_for(identity)
    async with db.engine().connect() as conn:
        return {"items": await repo.list_jobs(conn, None if scope.unrestricted else str(scope.tenant_id), scope.unrestricted, [state] if state else None, limit)}


@router.get("/jobs/{job_id}", summary="One archive job with its history")
async def job(job_id: str, identity: Identity = Depends(current_identity)):
    try:
        UUID(job_id)
    except ValueError:
        raise HTTPException(404, "Job not found.")
    async with db.engine().connect() as conn:
        row = await repo.get_job(conn, job_id)
    if row is None or (not identity.is_super_admin and str(row["tenant_id"]) != str(identity.tenant_id)):
        raise HTTPException(404, "Job not found.")
    return repo.job_to_api(row)


@router.post("/jobs/{job_id}/retry", summary="Retry a failed job now")
async def retry_job(job_id: str, request: Request, identity: Identity = Depends(current_identity)):
    _super(identity)
    _services(request)
    async with db.transaction() as conn:
        ok = await repo.request_retry(conn, job_id, datetime.now(timezone.utc))
    if not ok:
        raise HTTPException(409, "Only a failed job can be retried.")
    await record_access(identity, "archive.job_retried", "archive_job", job_id, None, {})
    return {"job_id": job_id, "status": "retry scheduled"}


class PlanBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dry_run: bool = True
    chain_id: Optional[str] = Field(default=None, max_length=128)


@router.post("/run", summary="Plan archiving now (dry run by default); jobs then run in the background")
async def run(body: PlanBody, request: Request, identity: Identity = Depends(current_identity)):
    _super(identity)
    services = _services(request)
    planned = await services.worker.plan(trigger="MANUAL", requested_by=identity.requester, dry_run=body.dry_run, chain_id=body.chain_id)
    await record_access(identity, "archive.run_requested", "archive_run", None, None, {"dry_run": body.dry_run, "planned": len(planned)})
    if not body.dry_run and planned:
        asyncio.create_task(services.worker.process_due())
    return {"dry_run": body.dry_run, "planned": [p.to_api() for p in planned],
            "note": "dry run: nothing was created" if body.dry_run else "jobs created; they run in the background"}


# ── retrieval ─────────────────────────────────────────────────────────────────────────────────────────────────
class RetrievalBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    chain_id: Optional[str] = Field(default=None, max_length=128)
    from_sequence: Optional[int] = Field(default=None, ge=1)
    to_sequence: Optional[int] = Field(default=None, ge=1)
    since: Optional[str] = Field(default=None, max_length=40)
    until: Optional[str] = Field(default=None, max_length=40)
    entity_id: Optional[str] = Field(default=None, max_length=128)
    actor_id: Optional[str] = Field(default=None, max_length=128)
    case_id: Optional[str] = Field(default=None, max_length=128)
    module: Optional[str] = Field(default=None, max_length=48)
    action: Optional[str] = Field(default=None, max_length=96)
    archive_ids: Optional[list[str]] = Field(default=None, max_length=50)


@router.post("/retrievals", status_code=202, summary="Request archived events (restored to a staging area, never into the live chain)")
async def request_retrieval(body: RetrievalBody, request: Request, identity: Identity = Depends(current_identity)):
    services = _services(request)
    scope = scope_for(identity)
    try:
        result = await services.retrieval.request(tenant_id=None if scope.unrestricted else str(scope.tenant_id), unrestricted=scope.unrestricted,
                                                  requested_by=identity.requester, criteria=body.model_dump(exclude_none=True))
    except RetrievalError as exc:
        raise HTTPException(422 if exc.code in ("BAD_CRITERIA", "NO_ARCHIVES", "TOO_BROAD") else 400, exc.message)
    await record_access(identity, "archive.retrieval_requested", "archive_retrieval", result["retrieval_id"], result["tenant_id"],
                        {"criteria": result["criteria"], "archives": len(result["archives"])})
    return result


async def _retrieval(retrieval_id: str, identity: Identity) -> dict:
    try:
        UUID(retrieval_id)
    except ValueError:
        raise HTTPException(404, "Retrieval not found.")
    async with db.engine().connect() as conn:
        row = (await conn.execute(text("SELECT * FROM archive_retrievals WHERE retrieval_id = CAST(:r AS uuid)"), {"r": retrieval_id})).mappings().first()
    if row is None or (not identity.is_super_admin and str(row["tenant_id"]) != str(identity.tenant_id)):
        raise HTTPException(404, "Retrieval not found.")
    return dict(row)


@router.get("/retrievals", summary="Retrieval requests")
async def retrievals(limit: int = Query(20, ge=1, le=100), identity: Identity = Depends(current_identity)):
    scope = scope_for(identity)
    clause, params = ("", {"l": limit}) if scope.unrestricted else ("WHERE tenant_id = CAST(:t AS uuid)", {"t": str(scope.tenant_id), "l": limit})
    async with db.engine().connect() as conn:
        rows = (await conn.execute(text(f"SELECT * FROM archive_retrievals {clause} ORDER BY created_at DESC LIMIT :l"), params)).mappings().all()
    return {"items": [retrieval_to_api(r) for r in rows]}


@router.get("/retrievals/{retrieval_id}", summary="Status of a retrieval")
async def retrieval(retrieval_id: str, identity: Identity = Depends(current_identity)):
    return retrieval_to_api(await _retrieval(retrieval_id, identity))


@router.get("/retrievals/{retrieval_id}/events", summary="Events of a finished retrieval (flagged archived and verified)")
async def retrieval_events(retrieval_id: str, page: int = Query(1, ge=1, le=100000), page_size: int = Query(25, ge=1, le=100),
                           identity: Identity = Depends(current_identity)):
    row = await _retrieval(retrieval_id, identity)
    if row["state"] != "READY":
        raise HTTPException(409, f"This retrieval is {row['state'].lower()}; its events are available when it is ready.")
    async with db.engine().connect() as conn:
        total = (await conn.execute(text("SELECT count(*) FROM archive_staging WHERE retrieval_id = CAST(:r AS uuid)"), {"r": retrieval_id})).scalar_one()
        rows = (await conn.execute(text("""SELECT * FROM archive_staging WHERE retrieval_id = CAST(:r AS uuid)
                                           ORDER BY recorded_at DESC, sequence_number DESC LIMIT :l OFFSET :o"""),
                                   {"r": retrieval_id, "l": page_size, "o": (page - 1) * page_size})).mappings().all()
    items = []
    for r in rows:
        items.append({"event_id": str(r["event_id"]), "chain_id": r["chain_id"], "sequence_number": r["sequence_number"], "tenant_id": str(r["tenant_id"]) if r["tenant_id"] else None,
                      "timestamp": format_timestamp(r["occurred_at"]), "recorded_at": format_timestamp(r["recorded_at"]), "actor_id": r["actor_id"], "actor_type": r["actor_type"],
                      "actor_role": r["actor_role"], "service_name": r["service_name"], "module": r["module"], "action": r["action"], "entity_type": r["entity_type"],
                      "entity_id": r["entity_id"], "case_id": r["case_id"], "correlation_id": r["correlation_id"], "previous_value": r["previous_value"],
                      "new_value": r["new_value"], "outcome": r["outcome"], "metadata": r["metadata"], "previous_hash": r["previous_hash"],
                      "current_hash": r["current_hash"], "hash_version": r["hash_version"], "archived": True, "verified": True, "archive_id": str(r["archive_id"])})
    await record_access(identity, "archive.retrieval_viewed", "archive_retrieval", retrieval_id, str(row["tenant_id"]) if row["tenant_id"] else None,
                        {"page": page, "page_size": page_size})
    return {"items": items, "total": total, "page": page, "page_size": page_size, "retrieval": retrieval_to_api(row)}


# ── retention policies ────────────────────────────────────────────────────────────────────────────────────────
@router.get("/policies", summary="Retention policies (current, and their history)")
async def policies(history: bool = Query(False), identity: Identity = Depends(current_identity)):
    scope = scope_for(identity)
    tenant = None if scope.unrestricted else str(scope.tenant_id)
    async with db.engine().connect() as conn:
        out = {"effective": await _effective_policies(conn, tenant), "categories": list(pol.CATEGORIES),
               "note": "Defaults keep archives indefinitely and are NOT legal retention periods: compliance must approve real periods."}
        if history:
            out["history"] = await repo.policy_history(conn, tenant, scope.unrestricted)
    return out


class PolicyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    category: str
    tenant_id: Optional[str] = Field(default=None, max_length=64, description="Omit for the platform default")
    hot_retention_months: int = Field(ge=0, le=600)
    cold_retention_years: Optional[int] = Field(default=None, ge=1, le=200, description="Omit to keep archives indefinitely")
    allow_hot_cleanup: bool = True
    approved: bool = Field(default=False, description="True only when compliance has approved these periods")
    notes: Optional[str] = Field(default=None, max_length=500)


@router.put("/policies", summary="Set a retention policy (versioned; SuperAdmin)")
async def set_policy(body: PolicyBody, identity: Identity = Depends(current_identity)):
    _super(identity)
    if body.category not in pol.CATEGORIES:
        raise HTTPException(422, f"category must be one of {list(pol.CATEGORIES)}")
    if body.tenant_id:
        try:
            UUID(body.tenant_id)
        except ValueError:
            raise HTTPException(422, "tenant_id must be a tenant id")
    await record_access(identity, "archive.retention_policy_changed", "retention_policy", body.category, body.tenant_id, body.model_dump())
    async with db.transaction() as conn:
        return await repo.set_policy(conn, tenant_id=body.tenant_id, category=body.category, hot_months=body.hot_retention_months, cold_years=body.cold_retention_years,
                                     allow_hot_cleanup=body.allow_hot_cleanup, approved=body.approved, actor=identity.requester, notes=body.notes)


# ── legal holds ───────────────────────────────────────────────────────────────────────────────────────────────
@router.get("/holds", summary="Legal holds")
async def holds(active_only: bool = Query(False), identity: Identity = Depends(current_identity)):
    scope = scope_for(identity)
    async with db.engine().connect() as conn:
        return {"items": await repo.list_holds(conn, None if scope.unrestricted else str(scope.tenant_id), scope.unrestricted, active_only)}


class HoldBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: Optional[str] = Field(default=None, max_length=64, description="Omit (with no chain_id) for the platform chain")
    chain_id: Optional[str] = Field(default=None, max_length=128)
    reason: str = Field(min_length=3, max_length=500)
    case_reference: Optional[str] = Field(default=None, max_length=128)


@router.post("/holds", status_code=201, summary="Place a legal hold: blocks removal from hot storage and any deletion review (SuperAdmin)")
async def place_hold(body: HoldBody, identity: Identity = Depends(current_identity)):
    _super(identity)
    tenant = body.tenant_id
    async with db.engine().connect() as conn:
        if body.chain_id:
            row = (await conn.execute(text("SELECT tenant_id FROM chains WHERE chain_id = :c"), {"c": body.chain_id})).first()
            if row is None:
                raise HTTPException(404, "Audit chain not found.")
            tenant = str(row.tenant_id) if row.tenant_id else None
    if tenant:
        try:
            UUID(tenant)
        except ValueError:
            raise HTTPException(422, "tenant_id must be a tenant id")
    await record_access(identity, "archive.legal_hold_placed", "legal_hold", None, tenant, body.model_dump())
    async with db.transaction() as conn:
        return await repo.place_hold(conn, tenant, body.chain_id, body.reason, body.case_reference, identity.requester)


class ReleaseBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(min_length=3, max_length=500)


@router.post("/holds/{hold_id}/release", summary="Release a legal hold (SuperAdmin)")
async def release_hold(hold_id: str, body: ReleaseBody, identity: Identity = Depends(current_identity)):
    _super(identity)
    try:
        UUID(hold_id)
    except ValueError:
        raise HTTPException(404, "Legal hold not found.")
    async with db.engine().connect() as conn:
        existing = await repo.get_hold(conn, hold_id)
    if existing is None:
        raise HTTPException(404, "Legal hold not found.")
    await record_access(identity, "archive.legal_hold_released", "legal_hold", hold_id, str(existing["tenant_id"]) if existing["tenant_id"] else None, {"reason": body.reason})
    async with db.transaction() as conn:
        released = await repo.release_hold(conn, hold_id, body.reason, identity.requester)
    if released is None:
        raise HTTPException(409, "This hold was already released.")
    return released


# ── hot cleanup ───────────────────────────────────────────────────────────────────────────────────────────────
@router.get("/cleanup/plan", summary="Which monthly partitions could leave hot storage, and what blocks the others (SuperAdmin)")
async def cleanup_plan(request: Request, identity: Identity = Depends(current_identity)):
    _super(identity)
    services = _services(request)
    return {"partitions": await services.cleanup.analyse(), "automatic": settings.auto_hot_cleanup, "mode": settings.cleanup_mode}


class CleanupBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dry_run: bool = True
    mode: Optional[str] = Field(default=None, pattern="^(detach|drop)$")
    confirm: Optional[str] = Field(default=None, description=f"Must equal {CLEANUP_CONFIRMATION} for a real run")
    promote: bool = Field(default=True, description="First re-verify finished archives and approve them for cleanup")
    ignore_safety_period: bool = False


@router.post("/cleanup", summary="Remove fully archived monthly partitions from hot storage (dry run by default; SuperAdmin)")
async def cleanup(body: CleanupBody, request: Request, identity: Identity = Depends(current_identity)):
    _super(identity)
    services = _services(request)
    if not body.dry_run and body.confirm != CLEANUP_CONFIRMATION:
        raise HTTPException(422, f"A real cleanup must be confirmed: send confirm={CLEANUP_CONFIRMATION!r}.")
    if body.mode == "drop" and not body.dry_run and not settings.auto_hot_cleanup and body.confirm != CLEANUP_CONFIRMATION:
        raise HTTPException(422, "drop is irreversible; confirm it explicitly.")
    promotions = await services.cleanup.promote(requested_by=identity.requester, ignore_safety_period=body.ignore_safety_period) if body.promote and not body.dry_run else []
    result = await services.cleanup.remove(dry_run=body.dry_run, mode=body.mode, requested_by=identity.requester)
    await record_access(identity, "archive.cleanup_run", "archive_cleanup", None, None,
                        {"dry_run": body.dry_run, "mode": result["mode"], "removed_months": result["removed_months"], "promotions": len(promotions)})
    return {**result, "promotions": promotions}
