"""Signed checkpoints: history, progress toward the next one, verification, and the trusted signing keys.

Read access follows Stage 1 (a tenant Admin sees their own tenant's chain, the SuperAdmin sees every chain). Creating a
checkpoint by hand and rotating the signing key are SuperAdmin-only. No route accepts a hash, payload or signature to sign:
only the isolated signer signs, and only after re-verifying the chain itself.
"""
import logging
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from app import db
from app.api.verification import _resolve_chain
from app.auth import Identity, current_identity, scope_for
from app.checkpoints import repository as repo
from app.checkpoints.storage import TrustedStorage
from app.config import settings
from app.schemas import VerificationRequest
from app.signing.interface import SigningError
from app.trust import key_registry, rotation
from app.verification import integrity_verifier, signature_verifier as sv
from shared.audit import checkpoint as cp
from shared.audit.hashing import format_timestamp
from shared.audit.trust import RegistryError

log = logging.getLogger("audit.api.checkpoints")
router = APIRouter(prefix="/v1", tags=["Checkpoints"])


class ChainBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    chain_id: Optional[str] = Field(default=None, max_length=128)
    tenant_id: Optional[str] = Field(default=None, max_length=64)


def _signer(request: Request):
    return getattr(request.app.state, "signer", None)


def _require_super(identity: Identity) -> None:
    if not identity.is_super_admin:
        raise HTTPException(403, "Only the platform administrator can do this.")


async def _environment_id() -> str:
    async with db.engine().connect() as conn:
        return str((await conn.execute(text("SELECT environment_id FROM environment"))).scalar_one())


def _progress(row, now: datetime) -> dict:
    pending, oldest = row["pending"], row["oldest_unsigned_at"]
    seconds_left = None
    if pending > 0 and oldest is not None:
        seconds_left = max(0.0, settings.checkpoint_interval_seconds - (now - oldest).total_seconds())
    return {
        "chain_id": row["chain_id"], "tenant_id": str(row["tenant_id"]) if row["tenant_id"] else None, "head_sequence": row["head_sequence"],
        "last_checkpoint_number": row["checkpoint_number"], "last_checkpoint_end_sequence": row["signed_end"] or None,
        "last_checkpoint_at": format_timestamp(row["last_checkpoint_at"]) if row["last_checkpoint_at"] else None,
        "pending_events": pending, "event_threshold": settings.checkpoint_event_threshold,
        "events_until_threshold": max(0, settings.checkpoint_event_threshold - pending) if pending > 0 else settings.checkpoint_event_threshold,
        "interval_seconds": settings.checkpoint_interval_seconds, "oldest_unsigned_at": format_timestamp(oldest) if oldest else None,
        "seconds_until_interval": seconds_left,
        "due": repo.is_due(pending, oldest, now, settings.checkpoint_event_threshold, settings.checkpoint_interval_seconds),
    }


@router.get("/checkpoints/status", summary="Signing status and progress toward the next checkpoint")
async def checkpoint_status(request: Request, identity: Identity = Depends(current_identity)):
    now = datetime.now(timezone.utc)
    scope = scope_for(identity)
    signer = _signer(request)
    env = await _environment_id()
    out: dict = {"signing_enabled": settings.signing_enabled, "provider": settings.signing_provider, "environment_id": env,
                 "environment_label": settings.environment_label, "server_time": format_timestamp(now),
                 "storage_available": TrustedStorage(settings.checkpoint_directory).available(), "signer": None, "registry": None}
    if signer is not None:
        status = await signer.status()
        out["signer"] = status if identity.is_super_admin else {k: status.get(k) for k in ("key_available", "reachable", "active_key")} | {"problem": bool(status.get("problem"))}
    try:
        out["registry"] = {"ok": True, "keys": key_registry.load_registry(env).public_list()}
    except (key_registry.RegistryUnavailable, RegistryError) as exc:
        out["registry"] = {"ok": False, "problem": str(exc), "keys": []}
    async with db.engine().connect() as conn:
        rows = await repo.progress_for_scope(conn, scope.unrestricted, str(scope.tenant_id) if scope.tenant_id else None)
        state = {r["chain_id"]: r for r in await repo.state_rows(conn)}
        out["chains"] = [{**_progress(r, now), "failures": (state.get(r["chain_id"]) or {}).get("consecutive_failures", 0),
                          "last_error": (state.get(r["chain_id"]) or {}).get("last_error"),
                          "alert_open": bool((state.get(r["chain_id"]) or {}).get("alert_open")),
                          "next_attempt_at": format_timestamp(state[r["chain_id"]]["next_attempt_at"]) if state.get(r["chain_id"]) and state[r["chain_id"]]["next_attempt_at"] else None}
                         for r in rows]
        out["alerts"] = await repo.list_alerts(conn, str(scope.tenant_id) if scope.tenant_id else None, scope.unrestricted)
    return out


@router.get("/checkpoints", summary="Signed checkpoint history of a chain (newest first)")
async def list_checkpoints(chain_id: Optional[str] = Query(None, max_length=128), tenant: Optional[str] = Query(None, max_length=64),
                           page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100), identity: Identity = Depends(current_identity)):
    chain = await _resolve_chain(VerificationRequest(chain_id=chain_id, tenant_id=tenant), identity)
    async with db.engine().connect() as conn:
        rows, total = await repo.list_checkpoints(conn, chain, page_size, (page - 1) * page_size)
    return {"chain_id": chain, "items": [repo.row_to_api(r) for r in rows], "total": total, "page": page, "page_size": page_size}


async def _visible_checkpoint(checkpoint_id: UUID, identity: Identity):
    async with db.engine().connect() as conn:
        row = await repo.get_checkpoint(conn, checkpoint_id)
    scope = scope_for(identity)
    if row is None or (not scope.unrestricted and row.tenant_id != scope.tenant_id):
        raise HTTPException(404, "Checkpoint not found")
    return row


@router.get("/checkpoints/verifications", summary="History of anchored verification runs")
async def verification_history(chain_id: Optional[str] = Query(None, max_length=128), limit: int = Query(20, ge=1, le=100),
                               identity: Identity = Depends(current_identity)):
    scope = scope_for(identity)
    async with db.engine().connect() as conn:
        return {"items": await repo.anchored_runs(conn, chain_id, str(scope.tenant_id) if scope.tenant_id else None, scope.unrestricted, limit)}


@router.get("/checkpoints/{checkpoint_id}", summary="One checkpoint with its canonical signed payload")
async def get_checkpoint(checkpoint_id: UUID, identity: Identity = Depends(current_identity)):
    row = await _visible_checkpoint(checkpoint_id, identity)
    return {**repo.row_to_api(row), "canonical_payload": row.canonical_payload}


@router.post("/checkpoints/{checkpoint_id}/verify", summary="Verify one checkpoint's signature against the trusted keys and its protected copy")
async def verify_checkpoint(checkpoint_id: UUID, identity: Identity = Depends(current_identity)):
    row = await _visible_checkpoint(checkpoint_id, identity)
    env = str(row.environment_id)
    tenant = str(row.tenant_id) if row.tenant_id else None
    envelope = repo.envelope_from_row(row)
    out = {"checkpoint_id": str(checkpoint_id), "checkpoint_number": row.checkpoint_number, "signing_key_id": row.signing_key_id,
           "key_version": row.key_version, "signature_valid": None, "signer_trusted": None, "stored_copy_matches": None, "findings": []}
    try:
        registry = key_registry.load_registry(env)
    except (key_registry.RegistryUnavailable, RegistryError) as exc:
        return {**out, "state": sv.VERIFICATION_FAILED, "findings": [{"code": "TRUSTED_REGISTRY_UNAVAILABLE", "message": str(exc)}]}
    findings = sv.verify_envelope(envelope, registry, chain_id=row.chain_id, environment_id=env, tenant_id=tenant, source="database")
    storage = TrustedStorage(settings.checkpoint_directory)
    stored = storage.read(env, tenant, row.checkpoint_number) if storage.available() else None
    out["stored_copy_matches"] = stored == envelope if stored is not None else None
    if not storage.available():
        findings.append(sv.Finding(sv.VERIFICATION_FAILED, "TRUSTED_STORAGE_UNAVAILABLE", "the independent checkpoint store cannot be read", row.checkpoint_number))
    elif stored is None:
        findings.append(sv.Finding(sv.MISSING_CHECKPOINT, "CHECKPOINT_MISSING_FROM_TRUSTED_STORAGE", "the protected copy of this checkpoint is missing", row.checkpoint_number))
    elif stored != envelope:
        findings.append(sv.Finding(sv.CHECKPOINT_MISMATCH, "DATABASE_COPY_DIFFERS", "the database copy differs from the protected copy", row.checkpoint_number))
    states = {f.state for f in findings}
    out["signature_valid"] = sv.INVALID_SIGNATURE not in states
    out["signer_trusted"] = sv.UNTRUSTED_SIGNER not in states
    out["findings"] = [f.to_api() for f in findings]
    out["state"] = next((s for s in sv.PRIORITY if s in states), sv.VERIFIED)
    return out


@router.post("/checkpoints/verify", summary="Full anchored verification: hash chain + checkpoints + signatures + trusted anchors")
async def verify_chain_anchored(body: ChainBody, identity: Identity = Depends(current_identity)):
    chain = await _resolve_chain(VerificationRequest(chain_id=body.chain_id, tenant_id=body.tenant_id), identity)
    result = await integrity_verifier.verify_anchored(chain)
    run_id = await integrity_verifier.record_run(result, "ON_DEMAND", identity.requester)
    return {**result.to_api(), "run_id": str(run_id) if run_id else None}


@router.post("/checkpoints/create", summary="SuperAdmin: create a checkpoint for a chain now")
async def create_checkpoint(body: ChainBody, request: Request, identity: Identity = Depends(current_identity)):
    _require_super(identity)
    generator = getattr(request.app.state, "generator", None)
    if generator is None:
        raise HTTPException(503, "Checkpoint signing is not enabled.")
    chain = await _resolve_chain(VerificationRequest(chain_id=body.chain_id, tenant_id=body.tenant_id), identity)
    outcome = await generator.checkpoint_chain(chain)
    return {"status": outcome.status, "chain_id": chain, "checkpoint": outcome.checkpoint, "error_code": outcome.error_code, "error": outcome.error}


@router.get("/signing/keys", summary="The trusted public signing keys (current and historical)")
async def signing_keys(identity: Identity = Depends(current_identity)):
    env = await _environment_id()
    try:
        return {"environment_id": env, "keys": key_registry.load_registry(env).public_list()}
    except key_registry.RegistryUnavailable as exc:
        return {"environment_id": env, "keys": [], "problem": str(exc)}
    except RegistryError as exc:
        raise HTTPException(409, f"The trusted key registry is not valid: {exc}")


@router.post("/signing/rotate", summary="SuperAdmin: rotate the signing key (old public keys stay trusted for old checkpoints)")
async def rotate_key(request: Request, identity: Identity = Depends(current_identity)):
    _require_super(identity)
    signer = _signer(request)
    if signer is None:
        raise HTTPException(503, "Checkpoint signing is not enabled.")
    try:
        return await rotation.rotate_signing_key(signer, identity.requester)
    except SigningError as exc:
        raise HTTPException(409 if not exc.retryable else 503, f"{exc.code}: {exc.message}")
