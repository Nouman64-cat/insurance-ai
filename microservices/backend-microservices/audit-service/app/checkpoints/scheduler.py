"""The hybrid checkpoint schedule: every chain independently, 500 new events OR 15 minutes, whichever comes first.

Each tick looks only at chains that have unsigned events (a chain with nothing new never gets a redundant checkpoint) and
asks the generator for a checkpoint when one is due:
  * pending >= AUDIT_CHECKPOINT_EVENT_THRESHOLD                                   -> due now;
  * the OLDEST unsigned event is at least AUDIT_CHECKPOINT_INTERVAL_SECONDS old   -> due now.
Several Audit Service instances can run this loop: the per-chain lease in checkpoint_state keeps them from duplicating work,
and the numbering rules (database trigger + signer state) keep checkpoints strictly ordered. Work is driven entirely by
durable state, so a restart simply resumes. Nothing here runs in a business request.
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import Callable, Optional

from sqlalchemy import text

from app import db
from app.checkpoints import repository as repo
from app.checkpoints.generator import CREATED, CheckpointGenerator, Outcome
from app.config import Settings, settings as default_settings
from app.trust import key_registry

log = logging.getLogger("audit.checkpoints")
MAX_PER_CHAIN_PER_TICK = 20     # catch-up after an outage: bounded so one backlogged chain can't starve the others
CONCURRENCY = 4


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class CheckpointScheduler:
    def __init__(self, generator: CheckpointGenerator, *, clock: Callable[[], datetime] = utcnow, config: Settings = default_settings):
        self.generator, self.clock, self.config = generator, clock, config
        self._last_sync = 0.0

    async def due_chains(self) -> list[str]:
        now = self.clock()
        async with db.engine().connect() as conn:
            rows = await repo.chain_progress(conn)
        return [r["chain_id"] for r in rows
                if repo.is_due(r["pending"], r["oldest_unsigned_at"], now, self.config.checkpoint_event_threshold, self.config.checkpoint_interval_seconds)]

    async def _drain(self, chain_id: str) -> list[Outcome]:
        outcomes: list[Outcome] = []
        for _ in range(MAX_PER_CHAIN_PER_TICK):
            outcome = await self.generator.checkpoint_chain(chain_id)
            outcomes.append(outcome)
            if outcome.status != CREATED:
                break
            async with db.engine().connect() as conn:  # still a full threshold of events waiting? keep going
                rows = await repo.chain_progress(conn, chain_id)
            if not rows or not repo.is_due(rows[0]["pending"], rows[0]["oldest_unsigned_at"], self.clock(),
                                            self.config.checkpoint_event_threshold, self.config.checkpoint_interval_seconds):
                break
        return outcomes

    async def tick(self) -> list[Outcome]:
        gate = asyncio.Semaphore(CONCURRENCY)

        async def one(chain_id: str) -> list[Outcome]:
            async with gate:
                return await self._drain(chain_id)

        results = await asyncio.gather(*(one(c) for c in await self.due_chains()), return_exceptions=True)
        outcomes: list[Outcome] = []
        for result in results:
            if isinstance(result, BaseException):
                log.error("checkpoint tick error: %s", result)
            else:
                outcomes.extend(result)
        return outcomes

    async def sync_registry(self) -> None:
        """Keep the signing_keys mirror in line with the trusted registry file (best effort; display only)."""
        try:
            async with db.engine().connect() as conn:
                env = (await conn.execute(text("SELECT environment_id FROM environment"))).scalar_one()
            registry = key_registry.load_registry(str(env))
            async with db.transaction() as conn:
                await key_registry.sync_to_db(conn, registry)
        except key_registry.RegistryUnavailable:
            pass
        except Exception as exc:
            log.warning("could not mirror the trusted key registry: %s", exc)

    async def run(self, stop: asyncio.Event) -> None:
        log.info("checkpoint scheduler: every %ss, threshold %d events or %ds", self.config.checkpoint_poll_seconds,
                 self.config.checkpoint_event_threshold, self.config.checkpoint_interval_seconds)
        while not stop.is_set():
            try:
                await self.sync_registry()
                await self.tick()
            except Exception:
                log.exception("checkpoint scheduler tick failed")
            try:
                await asyncio.wait_for(stop.wait(), timeout=self.config.checkpoint_poll_seconds)
            except asyncio.TimeoutError:
                pass
