"""The archive worker: plans archives and drives each job through its durable state machine.

    ELIGIBLE -> VERIFYING -> EXPORTING -> UPLOADING -> VALIDATING -> ARCHIVED  (-> HOT_CLEANUP_ELIGIBLE -> HOT_CLEANUP_COMPLETED: cleanup.py)

  ELIGIBLE    planned: a contiguous range of one chain that ends on a signed checkpoint boundary and is older than the hot window;
  VERIFYING   the range's SHA-256 chain is re-verified from the trusted hash before it, and its checkpoint coverage is confirmed;
  EXPORTING   events are streamed, re-checked, compressed (zstd) and encrypted (AES-256-GCM, chunked) into a local file; its checksum is kept;
  UPLOADING   the encrypted object is stored (versioned, Object-Locked); the isolated signer signs the manifest; manifest, signature and
              covering checkpoints are stored beside it;
  VALIDATING  everything is read BACK from object storage and re-verified end to end (checksum, signature, every event hash) before the
              catalog records the archive; only then does the job become ARCHIVED, atomically with the catalog entry.

Safety properties:
  * archiving NEVER deletes or alters anything in PostgreSQL; removing hot data is a separate, gated step (cleanup.py);
  * every step is idempotent and its state is durable: a crash or an outage resumes where it stopped (an expired lease is taken over);
  * one worker per job (lease), one job per chain at a time (the planner), and the database refuses illegal transitions or gaps;
  * failures never discard anything: the job parks as FAILED with the state to resume from, an alert is raised, retries back off.
"""
import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional
from uuid import uuid4

from sqlalchemy import text

from app import db
from app.archive import crypto, format as fmt, policy as pol, repository as repo
from app.archive.store import ObjectStore, StoreError
from app.archive.verify import ArchiveVerifier, ContentError, Finding, verify_content
from app.checkpoints import repository as cp_repo
from app.checkpoints.storage import TrustedStorage
from app.config import Settings, settings as default_settings
from app.services import chain_verifier
from app.signing.interface import CheckpointSigner, SigningError
from shared.audit import archive_manifest as am
from shared.audit import checkpoint as cp
from shared.audit import hashing
from shared.audit.hashing import format_timestamp

log = logging.getLogger("audit.archive")

LEASE_HELD, DONE, FAILED, NOTHING = "LEASE_HELD", "DONE", "FAILED", "NOTHING"
PERMANENT = {"HASH_CHAIN_INVALID", "EXPORT_CHAIN_BROKEN", "EXPORT_SEQUENCE", "PROPOSAL_MISMATCH", "ANCHOR_MISMATCH", "ARCHIVE_EXISTS", "MANIFEST_INVALID",
             "STORE_ACCESS_DENIED", "STORE_CAPABILITY", "VALIDATION_FAILED", "UNSUPPORTED_COMPRESSION", "CHAIN_TRUNCATED", "TENANT_MISMATCH", "COVERAGE_MISMATCH",
             "HASH_CHAIN_BROKEN", "SEQUENCE_GAP", "KEK_INVALID", "STATE_INCONSISTENT"}
INTEGRITY = {"HASH_CHAIN_INVALID", "EXPORT_CHAIN_BROKEN", "EXPORT_SEQUENCE", "PROPOSAL_MISMATCH", "ANCHOR_MISMATCH", "CHAIN_TRUNCATED", "VALIDATION_FAILED",
             "COVERAGE_MISMATCH", "HASH_CHAIN_BROKEN", "SEQUENCE_GAP"}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _norm(job) -> dict:
    """A job row as a plain dict with UUIDs as text (they go into JSON requests and object keys)."""
    job = dict(job)
    for name in ("job_id", "tenant_id"):
        if job.get(name) is not None:
            job[name] = str(job[name])
    return job


class JobFailure(Exception):
    def __init__(self, code: str, message: str, *, retryable: Optional[bool] = None, resume: Optional[str] = None):
        super().__init__(message)
        self.code, self.message, self.resume = code, message, resume
        self.retryable = (code not in PERMANENT) if retryable is None else retryable


@dataclass
class Planned:
    chain_id: str
    tenant_id: Optional[str]
    archive_number: int
    start_sequence: int
    end_sequence: int
    event_count: int
    cutoff: str
    hot_retention_months: int
    job_id: Optional[str] = None

    def to_api(self) -> dict:
        return self.__dict__.copy()


@dataclass
class JobOutcome:
    status: str
    job_id: str
    state: Optional[str] = None
    error_code: Optional[str] = None
    error: Optional[str] = None


class ArchiveWorker:
    def __init__(self, signer: Optional[CheckpointSigner], writer: ObjectStore, reader: ObjectStore, keyring: crypto.KeyRing, instance_id: str, *,
                 clock: Callable[[], datetime] = utcnow, config: Settings = default_settings, storage: Optional[TrustedStorage] = None,
                 work_dir: Optional[Path] = None):
        self.signer, self.writer, self.reader, self.keyring, self.instance_id = signer, writer, reader, keyring, instance_id
        self.clock, self.config = clock, config
        self.storage = storage or TrustedStorage(config.checkpoint_directory)
        self.work_dir = Path(work_dir or config.work_directory)
        self.verifier = ArchiveVerifier(reader, keyring, self.storage, self.work_dir)
        self._caps: tuple[float, dict] = (0.0, {})

    # ── planning ───────────────────────────────────────────────────────────────────────────────────────
    async def plan(self, *, trigger: str = "SCHEDULED", requested_by: Optional[str] = None, dry_run: bool = False,
                   chain_id: Optional[str] = None) -> list[Planned]:
        """Find every chain with archivable history and (unless dry_run) create one ELIGIBLE job for each. Creating a job copies nothing and
        removes nothing: it only records an intent that the state machine then verifies before acting."""
        now = self.clock()
        async with db.engine().connect() as conn:
            chains = await repo.chains_for_planning(conn, chain_id)
        planned: list[Planned] = []
        for chain in chains:
            if chain["has_open_job"]:
                continue
            async with db.engine().connect() as conn:
                found = await self._plan_chain(conn, chain, now)
            if found:
                planned.append(found)
        if not dry_run:
            for item in planned:
                async with db.transaction() as conn:
                    job = await repo.create_job(conn, chain_id=item.chain_id, tenant_id=item.tenant_id, number=item.archive_number, start=item.start_sequence,
                                                end=item.end_sequence, trigger=trigger, requested_by=requested_by, plan=item.to_api())
                item.job_id = str(job["job_id"]) if job else None
        async with db.transaction() as conn:
            run_id = await repo.start_run(conn, trigger, dry_run, requested_by)
            await repo.finish_run(conn, run_id, 0 if dry_run else len([p for p in planned if p.job_id]),
                                  {"chains_considered": len(chains), "planned": [p.to_api() for p in planned][:100]})
        return planned

    async def _plan_chain(self, conn, chain: dict, now: datetime) -> Optional[Planned]:
        tenant = str(chain["tenant_id"]) if chain["tenant_id"] else None
        policies = pol.resolve(await repo.policy_rows(conn, tenant), self.config.hot_retention_months)
        months = pol.effective_hot_months(policies)
        cutoff = pol.hot_cutoff(now, months, test_seconds=self.config.archive_test_hot_seconds if self.config.archive_test_mode else None,
                                aligned=self.config.archive_schedule != "continuous")
        after = chain["planned_end"]
        newest_old = await repo.last_old_sequence(conn, chain["chain_id"], cutoff)
        if newest_old <= after:
            return None
        boundary = await repo.checkpoint_boundary(conn, chain["chain_id"], after, min(newest_old, after + self.config.archive_max_events))
        if boundary is None or boundary["end_sequence"] - after < self.config.archive_min_events:
            return None
        return Planned(chain["chain_id"], tenant, chain["last_number"] + 1, after + 1, boundary["end_sequence"], boundary["end_sequence"] - after,
                       format_timestamp(cutoff), months)

    # ── driving jobs ───────────────────────────────────────────────────────────────────────────────────
    async def process_due(self, limit: int = 20) -> list[JobOutcome]:
        async with db.engine().connect() as conn:
            due = await repo.due_jobs(conn, self.clock(), limit)
        outcomes = []
        for job in due:
            outcomes.append(await self.run_job(job["job_id"]))
        return outcomes

    async def run_job(self, job_id) -> JobOutcome:
        async with db.transaction() as conn:
            job = await repo.acquire_job(conn, job_id, self.instance_id, self.clock(), self.config.archive_lease_seconds)
        if job is None:
            return JobOutcome(LEASE_HELD, str(job_id))
        job = _norm(job)
        handlers = {"ELIGIBLE": self._eligible, "VERIFYING": self._verifying, "EXPORTING": self._exporting,
                    "UPLOADING": self._uploading, "VALIDATING": self._validating}
        try:
            while job["state"] in handlers:
                await handlers[job["state"]](job)
                async with db.engine().connect() as conn:
                    job = _norm(await repo.get_job(conn, job["job_id"]))
            log.info("archive job %s (%s #%d, events %d..%d) is %s", job["job_id"], job["chain_id"], job["archive_number"], job["start_sequence"],
                     job["end_sequence"], job["state"])
            return JobOutcome(DONE, str(job["job_id"]), job["state"])
        except Exception as exc:
            return await self._failed(job, exc)

    async def _step(self, job: dict, new_state: str, note: str, patch: Optional[dict] = None, **columns) -> None:
        async with db.transaction() as conn:
            if not await repo.advance(conn, job["job_id"], self.instance_id, new_state, note, self.clock(), patch, **columns):
                raise JobFailure("LEASE_LOST", "another worker took over this job", retryable=True)

    async def _heartbeat(self, job: dict) -> None:
        async with db.transaction() as conn:
            if not await repo.renew_lease(conn, job["job_id"], self.instance_id, self.clock(), self.config.archive_lease_seconds):
                raise JobFailure("LEASE_LOST", "another worker took over this job", retryable=True)

    # ── ELIGIBLE ───────────────────────────────────────────────────────────────────────────────────────
    async def _eligible(self, job: dict) -> None:
        await self._step(job, "VERIFYING", "range confirmed")

    # ── VERIFYING ──────────────────────────────────────────────────────────────────────────────────────
    async def _first_previous_hash(self, conn, job: dict) -> str:
        if job["archive_number"] == 1:
            return hashing.genesis_hash(job["chain_id"])
        prev = (await conn.execute(text("SELECT last_event_hash, end_sequence FROM archive_catalog WHERE chain_id = :c AND archive_number = :n"),
                                   {"c": job["chain_id"], "n": job["archive_number"] - 1})).first()
        if prev is None or prev.end_sequence != job["start_sequence"] - 1:
            raise JobFailure("STATE_INCONSISTENT", f"archive {job['archive_number'] - 1} of {job['chain_id']} is not in the catalog; archives are cut in order", retryable=False)
        return prev.last_event_hash

    async def _verifying(self, job: dict) -> None:
        async with db.engine().connect() as conn:
            first_previous = await self._first_previous_hash(conn, job)
            coverage = await repo.checkpoint_numbers_for(conn, job["chain_id"], job["start_sequence"], job["end_sequence"])
            boundary = (await conn.execute(text("SELECT last_event_hash FROM checkpoints WHERE chain_id = :c AND end_sequence = :e"),
                                           {"c": job["chain_id"], "e": job["end_sequence"]})).first()
        if coverage is None or boundary is None:
            raise JobFailure("COVERAGE_MISSING", f"events {job['start_sequence']}..{job['end_sequence']} are not covered by contiguous signed checkpoints ending on the boundary", retryable=True)
        result = await chain_verifier.verify_chain(job["chain_id"], from_sequence=job["start_sequence"], to_sequence=job["end_sequence"],
                                                   trusted_previous_hash=first_previous if job["start_sequence"] > 1 else None)
        if result.status != chain_verifier.VALID or result.total_events_checked != job["event_count"]:
            raise JobFailure("HASH_CHAIN_INVALID", f"the range failed verification before archiving ({result.reason} at {result.first_invalid_sequence}); nothing was archived",
                             retryable=False)
        if result.calculated_hash != boundary.last_event_hash:
            raise JobFailure("ANCHOR_MISMATCH", "the last event of the range does not match the checkpoint that ends it", retryable=False)
        await self._step(job, "EXPORTING", f"{result.total_events_checked} events verified", {
            "first_previous_hash": first_previous, "coverage_first": coverage["first_number"], "coverage_last": coverage["last_number"],
            "verified_events": result.total_events_checked, "verified_in_ms": result.duration_ms})

    # ── EXPORTING ──────────────────────────────────────────────────────────────────────────────────────
    def _local(self, job: dict) -> Path:
        return self.work_dir / f"{job['job_id']}.iaar"

    async def _exporting(self, job: dict) -> None:
        self.work_dir.mkdir(parents=True, exist_ok=True)
        archive_id = job["result"].get("archive_id") or str(uuid4())
        path = self._local(job)
        path.unlink(missing_ok=True)                  # a partial file from an interrupted attempt is rebuilt from the (immutable) ledger
        builder = fmt.ArchiveBuilder(path, self.keyring, archive_id=archive_id, chain_id=job["chain_id"], start_sequence=job["start_sequence"],
                                     end_sequence=job["end_sequence"], first_previous_hash=job["result"]["first_previous_hash"],
                                     chunk_bytes=self.config.archive_chunk_bytes, compression=self.config.archive_compression,
                                     level=self.config.archive_compression_level)
        started = asyncio.get_running_loop().time()
        try:
            cursor, batch = job["start_sequence"] - 1, self.config.archive_fetch_batch
            async with db.engine().connect() as conn:
                while cursor < job["end_sequence"]:
                    rows = (await conn.execute(text(
                        "SELECT * FROM events WHERE chain_id = :c AND sequence_number > :a AND sequence_number <= :b ORDER BY sequence_number LIMIT :n"),
                        {"c": job["chain_id"], "a": cursor, "b": job["end_sequence"], "n": batch})).mappings().all()
                    if not rows:
                        break
                    await asyncio.to_thread(builder.add_batch, rows)
                    cursor = rows[-1]["sequence_number"]
                    await self._heartbeat(job)
            built = await asyncio.to_thread(builder.finish)
        except fmt.ArchiveBuildError as exc:
            builder.abort(); path.unlink(missing_ok=True)
            raise JobFailure(exc.code, exc.message, retryable=False) from exc
        except BaseException:
            builder.abort()
            raise
        seconds = max(asyncio.get_running_loop().time() - started, 1e-6)
        await self._step(job, "UPLOADING", f"{built.event_count} events -> {built.stored_bytes} bytes", {
            "archive_id": archive_id, "stored_sha256": built.stored_sha256, "stored_bytes": built.stored_bytes, "plaintext_sha256": built.plaintext_sha256,
            "plaintext_bytes": built.plaintext_bytes, "events_digest": built.events_digest, "last_event_hash": built.last_event_hash, "kek_id": built.kek_id,
            "first_occurred_at": built.first_occurred_at, "last_occurred_at": built.last_occurred_at, "first_recorded_at": built.first_recorded_at,
            "last_recorded_at": built.last_recorded_at, "created_at": format_timestamp(self.clock()),
            "export_seconds": round(seconds, 3), "export_events_per_second": round(built.event_count / seconds)})

    # ── UPLOADING ──────────────────────────────────────────────────────────────────────────────────────
    async def capabilities(self) -> dict:
        loop = asyncio.get_running_loop()
        if loop.time() - self._caps[0] > 60:
            caps = await asyncio.to_thread(self.writer.capabilities)
            if not caps.get("reachable"):
                return caps                    # an outage is never cached: the next attempt must look again
            self._caps = (loop.time(), caps)
        return self._caps[1]

    def _keys(self, job: dict, env: str) -> dict:
        tenant = job["tenant_id"] if job["tenant_id"] else "platform"
        prefix = f"v1/{env}/{tenant}/archive-{job['archive_number']:06d}/"
        return {"prefix": prefix, "data": prefix + "data.iaar", "manifest": prefix + "manifest.json", "signature": prefix + "signature.json",
                "checkpoints": prefix + "checkpoints.json"}

    async def _environment(self) -> str:
        async with db.engine().connect() as conn:
            return str((await conn.execute(text("SELECT environment_id FROM environment"))).scalar_one())

    def _lock(self) -> tuple[Optional[str], Optional[datetime]]:
        if self.config.lock_days > 0 and self.config.lock_mode in ("GOVERNANCE", "COMPLIANCE"):
            return self.config.lock_mode, self.clock() + timedelta(days=self.config.lock_days)
        return None, None

    async def _uploading(self, job: dict) -> None:
        r, env = job["result"], await self._environment()
        keys = self._keys(job, env)
        caps = await self.capabilities()
        if not caps.get("reachable"):
            raise JobFailure("STORE_UNAVAILABLE", caps.get("problem") or "object storage cannot be reached", retryable=True)
        lock_mode, retain_until = self._lock()
        if caps.get("versioning") is not True:
            raise JobFailure("STORE_CAPABILITY", "the archive bucket does not have versioning enabled", retryable=False)
        if lock_mode and self.config.require_object_lock and caps.get("object_lock") is not True:
            raise JobFailure("STORE_CAPABILITY", "the archive bucket does not have Object Lock enabled (it can only be enabled when a bucket is created)", retryable=False)
        if caps.get("private") is False:
            raise JobFailure("STORE_CAPABILITY", "the archive bucket allows anonymous access; refusing to store audit archives in it", retryable=False)

        # 1. the encrypted object
        existing = await asyncio.to_thread(self.writer.head, keys["data"])
        data_info = existing if existing and existing.sha256 == r["stored_sha256"] and existing.size == r["stored_bytes"] else None
        if data_info is None:
            local = self._local(job)
            if not local.exists():
                if r.get("manifest_hash"):
                    raise JobFailure("STATE_INCONSISTENT", "the manifest was signed but the archive object is neither local nor in object storage", retryable=False)
                raise JobFailure("EXPORT_LOST", "the exported file is gone; exporting again", retryable=True, resume="EXPORTING")
            data_info = await asyncio.to_thread(self.writer.put_file, keys["data"], local, sha256=r["stored_sha256"], lock_mode=lock_mode, retain_until=retain_until)
            if data_info.size != r["stored_bytes"]:
                raise JobFailure("STORE_ERROR", f"object storage reports {data_info.size} bytes, expected {r['stored_bytes']}", retryable=True)
        await self._heartbeat(job)

        # 2. the signed manifest (the signer re-reads the ledger and the checkpoints itself)
        if self.signer is None:
            raise JobFailure("SIGNER_UNAVAILABLE", "signing is disabled; archives need a signed manifest", retryable=True)
        coverage = await asyncio.to_thread(self._coverage, env, job["tenant_id"], r["coverage_first"], r["coverage_last"], job)
        proposal = {
            "archive_id": r["archive_id"], "tenant_id": job["tenant_id"], "environment_id": env, "chain_id": job["chain_id"], "archive_number": job["archive_number"],
            "manifest_version": am.MANIFEST_VERSION, "start_sequence": job["start_sequence"], "end_sequence": job["end_sequence"], "event_count": job["event_count"],
            "first_previous_hash": r["first_previous_hash"], "last_event_hash": r["last_event_hash"], "previous_archive_hash": await self._previous_archive_hash(job),
            "events_digest": r["events_digest"], "plaintext_sha256": r["plaintext_sha256"], "plaintext_bytes": r["plaintext_bytes"],
            "stored_sha256": r["stored_sha256"], "stored_bytes": r["stored_bytes"],
            "compression": {"algorithm": self.config.archive_compression, "level": self.config.archive_compression_level},
            "encryption": {"algorithm": crypto.ALGORITHM, "kek_id": r["kek_id"], "chunk_bytes": self.config.archive_chunk_bytes},
            "covered_checkpoints": coverage, "first_occurred_at": r["first_occurred_at"], "last_occurred_at": r["last_occurred_at"],
            "first_recorded_at": r["first_recorded_at"], "last_recorded_at": r["last_recorded_at"], "created_at": r["created_at"]}
        signed = await self.signer.sign_archive(proposal)
        envelope = signed.envelope
        findings: list[Finding] = []
        manifest = self.verifier.check_manifest_envelope(envelope, None, env, job["tenant_id"], findings, job["archive_number"])
        if manifest is None:
            raise JobFailure("MANIFEST_INVALID", f"the signer returned a manifest that does not verify: {findings[0].message if findings else 'unknown'}", retryable=False)
        protected = self.storage.read_archive(env, job["tenant_id"], job["archive_number"])
        if protected != envelope:
            raise JobFailure("STORAGE_NOT_VISIBLE", "the signed manifest is not visible in protected storage", retryable=True)
        await self._heartbeat(job)

        # 3. manifest, signature and covering checkpoints beside the data
        def put(key: str, payload: bytes) -> object:
            import hashlib
            return self.writer.put_bytes(key, payload, sha256=hashlib.sha256(payload).hexdigest(), lock_mode=lock_mode, retain_until=retain_until)
        await asyncio.to_thread(put, keys["manifest"], json.dumps(manifest, sort_keys=True, indent=2).encode())
        await asyncio.to_thread(put, keys["signature"], json.dumps(envelope, sort_keys=True, indent=2).encode())
        cp_path = self.work_dir / f"{job['job_id']}.checkpoints.json"
        try:
            await asyncio.to_thread(self._write_checkpoints, cp_path, env, job["tenant_id"], r["coverage_first"], r["coverage_last"])
            import hashlib
            digest = hashlib.sha256(cp_path.read_bytes()).hexdigest() if cp_path.stat().st_size < 64 * 1024 * 1024 else self._sha_file(cp_path)
            await asyncio.to_thread(self.writer.put_file, keys["checkpoints"], cp_path, sha256=digest, content_type="application/json", lock_mode=lock_mode, retain_until=retain_until)
        finally:
            cp_path.unlink(missing_ok=True)
        await self._step(job, "VALIDATING", "uploaded and signed", {
            "manifest_hash": envelope["manifest_hash"], "data_version_id": data_info.version_id, "keys": keys, "signed_at": manifest["signed_at"],
            "signer_replica": signed.replica, "lock_mode": lock_mode, "lock_retain_until": format_timestamp(retain_until) if retain_until else None})

    @staticmethod
    def _sha_file(path: Path) -> str:
        import hashlib
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(1024 * 1024), b""):
                h.update(block)
        return h.hexdigest()

    async def _previous_archive_hash(self, job: dict) -> str:
        if job["archive_number"] == 1:
            return am.archive_genesis_hash(job["chain_id"])
        async with db.engine().connect() as conn:
            row = (await conn.execute(text("SELECT manifest_hash FROM archive_catalog WHERE chain_id = :c AND archive_number = :n"),
                                      {"c": job["chain_id"], "n": job["archive_number"] - 1})).first()
        if row is None:
            raise JobFailure("STATE_INCONSISTENT", "the previous archive is not in the catalog", retryable=False)
        return row.manifest_hash

    def _coverage(self, env: str, tenant: Optional[str], first: int, last: int, job: dict) -> dict:
        digest = am.CheckpointsDigest()
        for n in range(first, last + 1):
            envelope = self.storage.read(env, tenant, n)
            if not envelope or envelope.get("unreadable") or cp.check_envelope(envelope):
                raise JobFailure("COVERAGE_MISMATCH", f"checkpoint {n} is missing from protected storage", retryable=True)
            digest.update(envelope["checkpoint_hash"])
        return {"first_number": first, "last_number": last, "count": last - first + 1, "digest": digest.hexdigest()}

    def _write_checkpoints(self, path: Path, env: str, tenant: Optional[str], first: int, last: int) -> None:
        with open(path, "w") as f:
            f.write('{"checkpoints":[')
            for n in range(first, last + 1):
                if n > first:
                    f.write(",")
                f.write(json.dumps(self.storage.read(env, tenant, n), sort_keys=True))
            f.write("]}")

    # ── VALIDATING ─────────────────────────────────────────────────────────────────────────────────────
    async def _validating(self, job: dict) -> None:
        r, env = job["result"], await self._environment()
        keys = r["keys"]
        local = self.work_dir / f"{job['job_id']}.validate.iaar"
        local.unlink(missing_ok=True)
        try:
            try:
                info = await asyncio.to_thread(self.reader.get_file, keys["data"], local, r.get("data_version_id"))
                if await asyncio.to_thread(self._sha_file, local) != r["stored_sha256"]:
                    raise JobFailure("VALIDATION_FAILED", "the archive read back from object storage does not match its checksum", retryable=False)
                signature = json.loads(await asyncio.to_thread(self.reader.get_bytes, keys["signature"]))
                checkpoints_info = await asyncio.to_thread(self.reader.head, keys["checkpoints"])
                manifest_info = await asyncio.to_thread(self.reader.head, keys["manifest"])
            except StoreError as exc:
                raise JobFailure(exc.code, exc.message, retryable=exc.retryable) from exc
            if checkpoints_info is None or manifest_info is None:
                raise JobFailure("VALIDATION_FAILED", "the manifest or checkpoint objects are missing after upload", retryable=True, resume="UPLOADING")
            findings: list[Finding] = []
            manifest = self.verifier.check_manifest_envelope(signature, None, env, job["tenant_id"], findings, job["archive_number"])
            if manifest is None or signature["manifest_hash"] != r["manifest_hash"]:
                raise JobFailure("VALIDATION_FAILED", "the stored manifest does not verify", retryable=False)
            for f in self.verifier._check_coverage(manifest, env, job["tenant_id"], job["archive_number"]):
                raise JobFailure("COVERAGE_MISMATCH", f.message, retryable=False)
            lock_mode, _ = self._lock()
            if lock_mode and self.config.require_object_lock and info.lock_mode != lock_mode:
                raise JobFailure("STORE_CAPABILITY", "the stored archive object carries no Object Lock retention", retryable=False)
            try:
                derived = await asyncio.to_thread(verify_content, local, manifest, self.keyring, collect_metadata=True)
            except crypto.ArchiveCryptoError as exc:
                raise JobFailure("KEK_UNAVAILABLE" if exc.code.startswith("KEK_") else "VALIDATION_FAILED", exc.message, retryable=exc.code == "KEK_UNAVAILABLE") from exc
            except ContentError as exc:
                raise JobFailure("VALIDATION_FAILED", f"{exc.code}: {exc.message}", retryable=False) from exc
        finally:
            local.unlink(missing_ok=True)

        async with db.engine().connect() as conn:
            tenant_policies = pol.resolve(await repo.policy_rows(conn, job["tenant_id"]), self.config.hot_retention_months)
        categories = sorted({pol.category_of(m) for m in derived["modules"]})
        last_recorded = datetime.strptime(derived["last_recorded_at"], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
        until = pol.retention_until(tenant_policies, categories, last_recorded)
        policy_id = next((tenant_policies[c].policy_id for c in categories if tenant_policies[c].policy_id), None)
        now = self.clock()
        row = {
            "archive_id": r["archive_id"], "job_id": str(job["job_id"]), "chain_id": job["chain_id"], "tenant_id": job["tenant_id"], "environment_id": env,
            "archive_number": job["archive_number"], "archive_version": 1, "start_sequence": job["start_sequence"], "end_sequence": job["end_sequence"],
            "event_count": job["event_count"], "first_previous_hash": r["first_previous_hash"], "last_event_hash": r["last_event_hash"],
            "previous_archive_hash": manifest["previous_archive_hash"], "manifest_hash": r["manifest_hash"], "archive_checksum": r["stored_sha256"],
            "size_bytes": r["stored_bytes"], "uncompressed_bytes": r["plaintext_bytes"], "compression_algorithm": manifest["compression"]["algorithm"],
            "encryption_algorithm": manifest["encryption"]["algorithm"], "kek_id": r["kek_id"], "object_prefix": keys["prefix"], "data_key": keys["data"],
            "manifest_key": keys["manifest"], "signature_key": keys["signature"], "checkpoints_key": keys["checkpoints"], "data_version_id": r.get("data_version_id"),
            "lock_mode": info.lock_mode, "lock_retain_until": info.retain_until, "covered_checkpoints": manifest["covered_checkpoints"],
            "first_occurred_at": _dt(derived["first_occurred_at"]), "last_occurred_at": _dt(derived["last_occurred_at"]),
            "first_recorded_at": _dt(derived["first_recorded_at"]), "last_recorded_at": last_recorded, "modules": derived["modules"], "actions": derived["actions"],
            "entity_types": derived["entity_types"], "bloom": derived["bloom"], "bloom_bits": derived["bloom_bits"], "bloom_hashes": fmt.BLOOM_HASHES,
            "retention_policy_id": policy_id, "retention_until": until}
        cleanup_after = now + timedelta(days=self.config.cleanup_safety_days)
        async with db.transaction() as conn:
            await repo.insert_catalog(conn, row)
            await repo.add_verification(conn, r["archive_id"], "INTAKE", "VERIFIED", None,
                                        {"events": derived["events"], "stored_sha256": r["stored_sha256"], "from": "object storage, read back and fully re-verified"},
                                        "archive-worker", 0)
            if not await repo.advance(conn, job["job_id"], self.instance_id, "ARCHIVED", "validated and cataloged", now,
                                      {"cataloged_at": format_timestamp(now), "compression_ratio": round(r["plaintext_bytes"] / r["stored_bytes"], 2)},
                                      cleanup_after=cleanup_after):
                raise JobFailure("LEASE_LOST", "another worker took over this job", retryable=True)

    # ── failure handling ───────────────────────────────────────────────────────────────────────────────
    async def _failed(self, job: dict, exc: Exception) -> JobOutcome:
        resume = None
        if isinstance(exc, JobFailure):
            code, message, retryable, resume = exc.code, exc.message, exc.retryable, exc.resume
        elif isinstance(exc, StoreError):
            code, message, retryable = exc.code, exc.message, exc.retryable
        elif isinstance(exc, SigningError):
            code, message, retryable = exc.code, exc.message, exc.retryable and exc.code not in PERMANENT
        elif isinstance(exc, crypto.ArchiveCryptoError):
            code, message, retryable = exc.code, exc.message, exc.code == "KEK_UNAVAILABLE"
        else:
            log.exception("archive job %s failed unexpectedly", job["job_id"])
            code, message, retryable = "ARCHIVE_FAILED", f"{type(exc).__name__}: {exc}", True
        if code == "LEASE_LOST":
            return JobOutcome(LEASE_HELD, str(job["job_id"]))
        now = self.clock()
        attempts = job["attempts"]
        backoff = min(self.config.archive_retry_base_seconds * 2 ** max(attempts - 1, 0), self.config.archive_retry_max_seconds) if retryable else None
        fresh = job["last_error_code"] != code
        try:
            async with db.transaction() as conn:
                if resume:
                    job = {**job, "state": resume}
                await repo.fail_job(conn, job, self.instance_id, now, code, message, backoff)
                if fresh or attempts in (1, 5) or attempts % 20 == 0:
                    severity = "CRITICAL" if code in INTEGRITY else "WARNING"
                    kind = "ARCHIVE_INTEGRITY" if code in INTEGRITY else "ARCHIVE_STORAGE_UNAVAILABLE" if code.startswith("STORE_") else "ARCHIVE_FAILED"
                    await cp_repo.add_alert(conn, job["chain_id"], job["tenant_id"], kind, severity,
                                            f"Archiving {job['chain_id']} events {job['start_sequence']}..{job['end_sequence']} failed in {job['state']}: {message}",
                                            {"code": code, "job_id": str(job["job_id"]), "attempt": attempts, "retry_in_seconds": backoff})
        except Exception:
            log.exception("could not record the failure of archive job %s", job["job_id"])
        log.error("ARCHIVE JOB FAILED job=%s chain=%s state=%s code=%s: %s", job["job_id"], job["chain_id"], job["state"], code, message)
        return JobOutcome(FAILED, str(job["job_id"]), job["state"], code, message)


def _dt(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
