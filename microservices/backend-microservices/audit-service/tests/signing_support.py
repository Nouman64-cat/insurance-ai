"""Harness for the Stage 2 tests: a REAL signer (real Ed25519 keys, real encrypted PEM files, real protected-store files,
the real read-only database role, the real HMAC-authenticated HTTP API) running in-process against a disposable database,
with its key, state and checkpoint directories in a temp folder.  Nothing about signing or verification is mocked."""
import os
import shutil
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from uuid import UUID, uuid4

import httpx
from sqlalchemy import text

from app import db
from app.checkpoints.generator import CheckpointGenerator
from app.checkpoints.scheduler import CheckpointScheduler
from app.checkpoints.storage import TrustedStorage
from app.config import settings
from app.services import audit_service
from app.signing.local_signer import LocalSignerClient
from shared.audit import hashing
from shared.audit.signer.app import create_app
from shared.audit.signer.config import SignerSettings
from shared.audit.signer.service import SignerService
from shared.audit.signer.source import DbEventSource
from tests.support import LedgerCase, TestDatabase, intent

SERVICE_KEY = "test-service-key-0123456789abcdef0123456789"


class OffsetClock:
    """A clock that can be moved forward, to test the 15-minute rule without waiting 15 minutes."""

    def __init__(self):
        self.offset = timedelta(0)

    def __call__(self) -> datetime:
        return datetime.now(timezone.utc) + self.offset

    def advance(self, **kwargs) -> None:
        self.offset += timedelta(**kwargs)


class SignerHarness:
    def __init__(self, database: TestDatabase, root: Path, *, replica: bool = False, max_events: int = 5000, signer_id: str = "test-signer",
                 clock=None, replica_required: bool = False):
        self.database, self.root, self.clock = database, Path(root), clock
        self.settings = SignerSettings(
            database_url=database.signer_url, schema="audit", signer_id=signer_id, key_dir=self.root / "keys",
            passphrase_file=self.root / "secrets" / "key-passphrase", checkpoint_dir=self.root / "checkpoints",
            replica_dir=(self.root / "replica") if replica else None, replica_required=replica_required, state_dir=self.root / "state",
            service_key=SERVICE_KEY, max_events=max_events, trust_anchor_fingerprint=None)
        self.build()

    def build(self) -> None:
        """(Re)create the signer 'process': what a container restart does. Keys, state and files stay on disk."""
        kwargs = {"clock": self.clock} if self.clock else {}
        self.service = SignerService(self.settings, DbEventSource(self.settings.database_url, "audit"), **kwargs)
        self.app = create_app(self.service, self.settings)
        self.client = LocalSignerClient("http://signer.test", SERVICE_KEY, transport=httpx.ASGITransport(app=self.app))

    async def init(self):
        env = await self.service.source.environment_id()
        return self.service.keys.initialize(env)

    async def restart(self) -> None:
        await self.service.source.dispose()
        self.build()

    async def close(self) -> None:
        await self.service.source.dispose()

    @property
    def checkpoints_dir(self) -> Path:
        return self.settings.checkpoint_dir

    def generator(self, instance: str = "worker-1", clock=None, signer=None) -> CheckpointGenerator:
        return CheckpointGenerator(signer or self.client, instance, clock=clock or (lambda: datetime.now(timezone.utc)),
                                   storage=TrustedStorage(str(self.settings.checkpoint_dir)))

    def scheduler(self, instance: str = "worker-1", clock=None, signer=None) -> CheckpointScheduler:
        clock = clock or (lambda: datetime.now(timezone.utc))
        return CheckpointScheduler(self.generator(instance, clock, signer), clock=clock)


@contextmanager
def override_settings(**changes):
    saved = {k: getattr(settings, k) for k in changes}
    for k, v in changes.items():
        object.__setattr__(settings, k, v)
    try:
        yield
    finally:
        for k, v in saved.items():
            object.__setattr__(settings, k, v)


class StageTwoCase(LedgerCase):
    """Per class: a fresh database. Per test: fresh keys, state and checkpoint directories, and a fresh tenant."""
    replica = False
    max_events = 5000
    per_test_database = True      # the scheduler looks at every chain, so each test needs a database of its own

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.tmp = Path(tempfile.mkdtemp(prefix="audit-stage2-"))
        self.clock = OffsetClock()
        self.signer = SignerHarness(self.database, self.tmp, replica=self.replica, max_events=self.max_events, clock=self.clock)
        self._override = override_settings(checkpoint_directory=str(self.signer.checkpoints_dir), checkpoint_event_threshold=500,
                                           checkpoint_interval_seconds=900, signer_service_key=SERVICE_KEY, trust_anchor_fingerprint="",
                                           checkpoint_retry_base_seconds=0.0, checkpoint_retry_max_seconds=0.0)
        self._override.__enter__()
        self.tenant = uuid4()

    async def asyncTearDown(self):
        self._override.__exit__(None, None, None)
        await self.signer.close()
        shutil.rmtree(self.tmp, ignore_errors=True)
        await super().asyncTearDown()

    async def events(self, n: int, tenant: Optional[UUID] = None, start: int = 0) -> str:
        """Append n events for a tenant (default: this test's) and return its chain id."""
        tenant = tenant or self.tenant
        for offset in range(0, n, 250):
            await audit_service.ingest([intent(tenant, start + i) for i in range(offset, min(n, offset + 250))])
        return await self.chain_id(tenant)

    async def checkpoint(self, chain_id: str, harness: Optional[SignerHarness] = None, instance: str = "w"):
        """Create a checkpoint through the full production path (lease -> signer -> verify -> protected copy -> record)."""
        outcome = await (harness or self.signer).generator(instance).checkpoint_chain(chain_id)
        self.assertEqual(outcome.status, "CREATED", f"{outcome.error_code}: {outcome.error}")
        return outcome.checkpoint

    async def rewrite_chain(self, chain_id: str, mutate) -> None:
        """A database-privileged attacker who rewrites an entire chain consistently: every event hash recomputed from the
        first changed event on, and the chain head updated. Stage 1 verification sees nothing wrong afterwards."""
        async with self.privileged() as conn:
            rows = (await conn.execute(text("SELECT * FROM events WHERE chain_id = :c ORDER BY sequence_number"), {"c": chain_id})).mappings().all()
            previous = hashing.genesis_hash(chain_id)
            for row in rows:
                data = dict(row)
                mutate(data)
                data["previous_hash"] = previous
                data["current_hash"] = hashing.compute_event_hash(chain_id, data["sequence_number"], previous, data)
                await conn.execute(text("UPDATE events SET new_value = CAST(:nv AS jsonb), previous_hash = :p, current_hash = :h WHERE event_id = :e"),
                                   {"nv": __import__("json").dumps(data["new_value"]), "p": previous, "h": data["current_hash"], "e": data["event_id"]})
                previous = data["current_hash"]
            await conn.execute(text("UPDATE chains SET head_hash = :h WHERE chain_id = :c"), {"h": previous, "c": chain_id})
