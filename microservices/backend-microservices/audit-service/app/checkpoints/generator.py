"""Creating one signed checkpoint for one chain.

    lease the chain (so exactly one Audit Service instance works on it)
      -> ask the isolated signer to checkpoint it (the signer re-reads and re-verifies the chain itself)
      -> check what came back (signature against the trusted registry, and that the protected copy really is on disk)
      -> record it in PostgreSQL and release the lease, in one transaction.

A checkpoint is recorded as protected only after both signing AND protected storage succeeded. Any failure is kept in
durable state (retry with exponential backoff) and raises an alert; it is never skipped silently, and the next attempt
resumes from where the signer's trusted state says things stand.
"""
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Optional

from sqlalchemy import text

from app import db
from app.checkpoints import repository as repo
from app.checkpoints.storage import TrustedStorage
from app.config import Settings, settings as default_settings
from app.signing.interface import CheckpointSigner, SigningError
from app.trust import key_registry
from shared.audit import checkpoint as cp
from shared.audit.hashing import chain_id_for

log = logging.getLogger("audit.checkpoints")

CREATED, LEASE_HELD, NOTHING_PENDING, FAILED = "CREATED", "LEASE_HELD", "NOTHING_PENDING", "FAILED"

# error code -> (alert kind, severity)
ALERT_KINDS = {
    "SIGNER_UNAVAILABLE": ("SIGNER_UNAVAILABLE", "CRITICAL"), "KEY_UNAVAILABLE": ("SIGNER_KEY_UNAVAILABLE", "CRITICAL"),
    "KEY_INVALID": ("SIGNER_KEY_UNAVAILABLE", "CRITICAL"), "STORAGE_FAILED": ("STORAGE_FAILED", "CRITICAL"),
    "REPLICA_FAILED": ("STORAGE_FAILED", "CRITICAL"), "STORAGE_NOT_VISIBLE": ("STORAGE_FAILED", "CRITICAL"),
    "ANCHOR_MISMATCH": ("INTEGRITY_VIOLATION", "CRITICAL"), "CHAIN_TRUNCATED": ("INTEGRITY_VIOLATION", "CRITICAL"),
    "HASH_CHAIN_BROKEN": ("INTEGRITY_VIOLATION", "CRITICAL"), "SEQUENCE_GAP": ("INTEGRITY_VIOLATION", "CRITICAL"),
    "TENANT_MISMATCH": ("INTEGRITY_VIOLATION", "CRITICAL"), "PROPOSAL_MISMATCH": ("INTEGRITY_VIOLATION", "CRITICAL"),
    "STATE_STORE_MISMATCH": ("INTEGRITY_VIOLATION", "CRITICAL"), "ENVIRONMENT_MISMATCH": ("SIGNER_KEY_UNAVAILABLE", "CRITICAL"),
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Outcome:
    status: str
    chain_id: str
    checkpoint: Optional[dict] = None
    error_code: Optional[str] = None
    error: Optional[str] = None


class CheckpointGenerator:
    def __init__(self, signer: CheckpointSigner, instance_id: str, *, clock: Callable[[], datetime] = utcnow,
                 config: Settings = default_settings, storage: Optional[TrustedStorage] = None):
        self.signer, self.instance_id, self.clock, self.config = signer, instance_id, clock, config
        self.storage = storage or TrustedStorage(config.checkpoint_directory)

    async def checkpoint_chain(self, chain_id: str) -> Outcome:
        now = self.clock()
        async with db.transaction() as conn:
            if not await repo.acquire_lease(conn, chain_id, self.instance_id, now, self.config.checkpoint_lease_seconds):
                return Outcome(LEASE_HELD, chain_id)
        tenant_id: Optional[str] = None
        try:
            async with db.engine().connect() as conn:
                rows = await repo.chain_progress(conn, chain_id)
                last = await repo.last_checkpoint(conn, chain_id)
            if not rows or rows[0]["pending"] <= 0:   # nothing new since the last checkpoint: not an error, and no redundant checkpoint
                async with db.transaction() as conn:
                    await repo.release_success(conn, chain_id, self.instance_id, self.clock())
                return Outcome(NOTHING_PENDING, chain_id)
            progress = rows[0]
            tenant_id = str(progress["tenant_id"]) if progress["tenant_id"] else None
            signed_end = progress["signed_end"]
            end = min(progress["head_sequence"], signed_end + self.config.checkpoint_max_events)
            proposal = {"checkpoint_number": (last.checkpoint_number if last else 0) + 1, "start_sequence": signed_end + 1,
                        "previous_checkpoint_hash": last.checkpoint_hash if last else cp.checkpoint_genesis_hash(chain_id)}
            signed = await self.signer.sign_checkpoint(chain_id, end_sequence=end, proposal=proposal)
            envelope = signed.envelope
            self._verify_returned(envelope, chain_id)
            self._verify_protected(envelope, tenant_id)
            async with db.transaction() as conn:
                await repo.insert_checkpoint(conn, envelope, signed.path)
                recovered = await repo.release_success(conn, chain_id, self.instance_id, self.clock())
                if recovered:
                    await repo.add_alert(conn, chain_id, tenant_id, "CHECKPOINT_RECOVERED", "INFO",
                                         f"Checkpointing of {chain_id} recovered with checkpoint {envelope['payload']['checkpoint_number']}", {})
            async with db.engine().connect() as conn:
                row = await repo.last_checkpoint(conn, chain_id)
            log.info("checkpoint %s #%d covers events %d..%d", chain_id, envelope["payload"]["checkpoint_number"],
                     envelope["payload"]["start_sequence"], envelope["payload"]["end_sequence"])
            return Outcome(CREATED, chain_id, repo.row_to_api(row))
        except SigningError as exc:
            return await self._failed(chain_id, tenant_id, exc.code, exc.message)
        except Exception as exc:  # database trouble, a rejected insert, anything unexpected: still recorded and alerted
            log.exception("checkpoint for %s failed", chain_id)
            return await self._failed(chain_id, tenant_id, getattr(exc, "code", "CHECKPOINT_FAILED"), f"{type(exc).__name__}: {exc}")

    def _verify_returned(self, envelope: dict, chain_id: str) -> None:
        """Trust but verify: the signature must check out against the trusted registry before anything is recorded."""
        problem = cp.check_envelope(envelope)
        if problem:
            raise SigningError("SIGNER_RESPONSE_INVALID", problem, retryable=True)
        p = envelope["payload"]
        try:
            registry = key_registry.load_registry(p["environment_id"])
        except Exception as exc:
            raise SigningError("TRUST_REGISTRY_UNAVAILABLE", str(exc)) from exc
        key = registry.get(p["signing_key_id"])
        if p["chain_id"] != chain_id or key is None or not key.valid_at(p["created_at"]) or not cp.verify_payload(key.public_key, p, envelope["signature"]):
            raise SigningError("SIGNER_RESPONSE_INVALID", "the signer returned a checkpoint whose signature is not valid for a trusted key")

    def _verify_protected(self, envelope: dict, tenant_id: Optional[str]) -> None:
        p = envelope["payload"]
        stored = self.storage.read(p["environment_id"], tenant_id, p["checkpoint_number"])
        if stored != envelope:
            raise SigningError("STORAGE_NOT_VISIBLE", "the protected copy of the checkpoint is missing or differs from what was signed")

    async def _failed(self, chain_id: str, tenant_id: Optional[str], code: str, message: str) -> Outcome:
        now = self.clock()
        kind, severity = ALERT_KINDS.get(code, ("SIGNING_FAILED", "CRITICAL"))
        try:
            async with db.transaction() as conn:
                state = await conn.execute(text("SELECT consecutive_failures FROM checkpoint_state WHERE chain_id = :c"), {"c": chain_id})
                failures = (state.scalar() or 0) + 1
                backoff = min(self.config.checkpoint_retry_base_seconds * 2 ** (failures - 1), self.config.checkpoint_retry_max_seconds)
                _, already = await repo.release_failure(conn, chain_id, self.instance_id, now, code, message, backoff)
                if not already:
                    await repo.add_alert(conn, chain_id, tenant_id, kind, severity, f"Checkpoint creation failed: {message}", {"code": code})
        except Exception:
            log.exception("could not record the checkpoint failure for %s", chain_id)
        log.error("CHECKPOINT FAILED chain=%s code=%s: %s (alert %s)", chain_id, code, message, kind)
        return Outcome(FAILED, chain_id, error_code=code, error=message)
