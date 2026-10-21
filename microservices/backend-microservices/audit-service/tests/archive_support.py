"""Harness for the Stage 3 tests: the real worker, real encryption/compression, real signer (Ed25519) and real database roles, against
either an in-memory object store (fast, with failure injection and tampering helpers) or the real MinIO (integration tests)."""
import hashlib
import os
import shutil
import tempfile
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from uuid import UUID, uuid4

from sqlalchemy import text

from app import db
from app.archive import crypto
from app.archive.cleanup import CleanupService
from app.archive.retrieval import RetrievalService
from app.archive.store import ObjectInfo, StoreError
from app.archive.worker import ArchiveWorker
from app.checkpoints.storage import TrustedStorage
from app.config import settings
from app.services import audit_service
from tests.signing_support import OffsetClock, StageTwoCase, override_settings
from tests.support import intent


class MemoryStore:
    """An S3-like object store in memory: versioning, a lock record, failure injection and direct tampering for tests."""

    def __init__(self, *, object_lock: bool = True, versioning: bool = True, private: bool = True):
        self.objects: dict[str, list[dict]] = {}
        self.down = False
        self.fail_puts_after: Optional[int] = None        # let N puts succeed, then fail
        self.puts = 0
        self.caps = {"reachable": True, "bucket": "memory", "versioning": versioning, "object_lock": object_lock, "private": private, "problem": None}

    def _check(self, what: str) -> None:
        if self.down:
            raise StoreError("STORE_UNAVAILABLE", f"{what}: object storage cannot be reached (test outage)")

    def _put(self, key: str, data: bytes, sha256: str, lock_mode, retain_until) -> ObjectInfo:
        self._check(f"upload of {key}")
        if self.fail_puts_after is not None and self.puts >= self.fail_puts_after:
            raise StoreError("STORE_UNAVAILABLE", f"upload of {key}: connection reset (test outage)")
        self.puts += 1
        version = uuid4().hex
        self.objects.setdefault(key, []).append({"data": data, "sha256": sha256, "version": version, "lock_mode": lock_mode, "retain_until": retain_until})
        return ObjectInfo(key, len(data), version, sha256, lock_mode, retain_until)

    def put_file(self, key, path, *, sha256, content_type="", lock_mode=None, retain_until=None):
        return self._put(key, Path(path).read_bytes(), sha256, lock_mode, retain_until)

    def put_bytes(self, key, data, *, sha256, content_type="", lock_mode=None, retain_until=None):
        return self._put(key, data, sha256, lock_mode, retain_until)

    def _latest(self, key: str, version_id=None) -> Optional[dict]:
        versions = self.objects.get(key)
        if not versions:
            return None
        if version_id:
            return next((v for v in versions if v["version"] == version_id), None)
        return versions[-1]

    def head(self, key, version_id=None):
        self._check(f"head of {key}")
        v = self._latest(key, version_id)
        return None if v is None else ObjectInfo(key, len(v["data"]), v["version"], v["sha256"], v["lock_mode"], v["retain_until"])

    def get_file(self, key, dest, version_id=None):
        self._check(f"download of {key}")
        v = self._latest(key, version_id)
        if v is None:
            raise StoreError("STORE_NOT_FOUND", f"download of {key}: object not found", retryable=False)
        Path(dest).write_bytes(v["data"])
        return ObjectInfo(key, len(v["data"]), v["version"], v["sha256"], v["lock_mode"], v["retain_until"])

    def get_bytes(self, key, version_id=None):
        self._check(f"download of {key}")
        v = self._latest(key, version_id)
        if v is None:
            raise StoreError("STORE_NOT_FOUND", f"download of {key}: object not found", retryable=False)
        return v["data"]

    def list_keys(self, prefix):
        self._check("list")
        return sorted(k for k in self.objects if k.startswith(prefix))

    def capabilities(self):
        return dict(self.caps) if not self.down else {**self.caps, "reachable": False, "problem": "test outage"}

    # tampering helpers (what someone with access to the bucket could do; the real writer identity cannot delete)
    def replace(self, key: str, data: bytes) -> None:
        self.objects[key][-1] = {**self.objects[key][-1], "data": data}

    def delete(self, key: str) -> None:
        self.objects.pop(key, None)


class ArchiveCase(StageTwoCase):
    """Fresh database, signer, keys, protected store, temp work dir and in-memory object store per test."""
    use_real_store = False

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.trusted = await self.signer.init()
        self.env = str(await self.environment_id())
        self.keys_dir = self.tmp / "archive-keys"
        crypto.init_keys(str(self.keys_dir))
        self.keyring = crypto.KeyRing(str(self.keys_dir))
        self.work = self.tmp / "archive-work"
        self.store = MemoryStore()
        self._archive_override = override_settings(
            archive_min_events=1, archive_retry_base_seconds=0.0, archive_retry_max_seconds=0.0, archive_chunk_bytes=4096, hot_retention_months=6,
            lock_days=30, lock_mode="GOVERNANCE", require_object_lock=True, cleanup_safety_days=0.0, archive_lease_seconds=600,
            archive_test_mode=False, archive_schedule="monthly", archive_max_events=2_000_000, archive_fetch_batch=300)
        self._archive_override.__enter__()

    async def asyncTearDown(self):
        self._archive_override.__exit__(None, None, None)
        await super().asyncTearDown()

    # ── services ──
    def worker(self, instance: str = "worker-1", store: Optional[MemoryStore] = None, clock=None) -> ArchiveWorker:
        store = store or self.store
        return ArchiveWorker(self.signer.client, store, store, self.keyring, instance, clock=clock or self.clock, config=settings,
                             storage=TrustedStorage(str(self.signer.checkpoints_dir)), work_dir=self.work)

    def cleanup_service(self, worker: Optional[ArchiveWorker] = None, clock=None) -> CleanupService:
        return CleanupService((worker or self.worker()).verifier, clock=clock or self.clock, config=settings)

    def retrieval_service(self, worker: Optional[ArchiveWorker] = None, instance: str = "retriever") -> RetrievalService:
        w = worker or self.worker()
        return RetrievalService(w.reader, self.keyring, w.verifier, instance, clock=self.clock, config=settings)

    # ── data ──
    async def aged_events(self, n: int, months_ago: float = 8.0, tenant: Optional[UUID] = None, start: int = 0, modules=("policies",)) -> str:
        """Append n events recorded `months_ago` months in the past (real production path, only the clock is old), return the chain id."""
        tenant = tenant or self.tenant
        moment = datetime.now(timezone.utc) - timedelta(days=30 * months_ago)
        ticks = {"n": 0}

        def clock() -> datetime:
            ticks["n"] += 1
            return moment + timedelta(seconds=ticks["n"])

        for offset in range(0, n, 200):
            batch = [intent(tenant, start + i, module=modules[(start + i) % len(modules)], entity_id=f"ENT-{(start + i) % 25}", case_id=f"CASE-{(start + i) % 10}",
                            actor_id=f"user-{(start + i) % 5}") for i in range(offset, min(n, offset + 200))]
            await audit_service.ingest(batch, clock=clock)
        return await self.chain_id(tenant)

    async def archive_chain(self, chain_id: str, worker: Optional[ArchiveWorker] = None):
        """Plan and fully run archiving for a chain; returns the job outcomes."""
        worker = worker or self.worker()
        planned = await worker.plan(chain_id=chain_id)
        self.assertTrue(planned, "nothing was planned")
        outcomes = []
        for p in planned:
            outcomes.append(await worker.run_job(p.job_id))
        return planned, outcomes

    async def catalog(self, chain_id: str):
        return await self.fetch("SELECT * FROM archive_catalog WHERE chain_id = :c ORDER BY archive_number", c=chain_id)

    async def job_rows(self, chain_id: str):
        return await self.fetch("SELECT * FROM archive_jobs WHERE chain_id = :c ORDER BY archive_number", c=chain_id)

    async def hot_count(self, chain_id: str) -> int:
        return (await self.fetch("SELECT count(*) AS n FROM events WHERE chain_id = :c", c=chain_id))[0]["n"]

    async def archived_chain(self, n: int = 40, months_ago: float = 8.0, tenant: Optional[UUID] = None):
        """A chain with n aged events, checkpointed, archived. Returns (chain_id, catalog_row)."""
        chain = await self.aged_events(n, months_ago, tenant)
        await self.checkpoint(chain)
        _, outcomes = await self.archive_chain(chain)
        for o in outcomes:
            self.assertEqual(o.status, "DONE", f"{o.error_code}: {o.error}")
        rows = await self.catalog(chain)
        self.assertEqual(len(rows), 1)
        return chain, rows[0]
