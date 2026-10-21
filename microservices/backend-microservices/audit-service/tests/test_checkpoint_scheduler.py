"""The hybrid schedule (500 events OR 15 minutes), concurrency between workers, retries, alerts and restarts, end to end."""
import asyncio
from datetime import datetime, timedelta, timezone
from unittest import mock
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app import db
from app.checkpoints import repository as repo
from app.checkpoints.generator import CheckpointGenerator
from app.checkpoints.storage import TrustedStorage
from app.services import audit_service, chain_verifier
from app.signing.interface import SigningError
from app.signing.signer_factory import UnsupportedProvider, get_signer
from app.config import settings
from shared.audit.signer.files import CheckpointStore
from tests.signing_support import SERVICE_KEY, SignerHarness, StageTwoCase, override_settings


class ScheduleTests(StageTwoCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.signer.init()
        self.scheduler = self.signer.scheduler(clock=self.clock)

    async def checkpoints(self, chain):
        return await self.fetch("SELECT checkpoint_number, start_sequence, end_sequence, event_count FROM checkpoints WHERE chain_id = :c ORDER BY 1", c=chain)

    async def test_a_checkpoint_is_created_once_500_new_events_exist(self):
        chain = await self.events(499)
        self.assertEqual(await self.scheduler.tick(), [])
        self.assertEqual(await self.checkpoints(chain), [])
        await self.events(1, start=499)
        outcomes = await self.scheduler.tick()
        self.assertEqual([o.status for o in outcomes], ["CREATED"])
        [row] = await self.checkpoints(chain)
        self.assertEqual((row["checkpoint_number"], row["start_sequence"], row["end_sequence"], row["event_count"]), (1, 1, 500, 500))

    async def test_a_checkpoint_is_created_after_15_minutes_with_fewer_than_500_events(self):
        chain = await self.events(3)
        self.assertEqual(await self.scheduler.tick(), [])                  # brand new events: not due
        self.clock.advance(minutes=14, seconds=30)
        self.assertEqual(await self.scheduler.tick(), [])                  # 14.5 minutes: still not due
        self.clock.advance(seconds=31)
        self.assertEqual([o.status for o in await self.scheduler.tick()], ["CREATED"])
        [row] = await self.checkpoints(chain)
        self.assertEqual((row["start_sequence"], row["end_sequence"]), (1, 3))

    async def test_the_interval_is_measured_from_the_oldest_unsigned_event(self):
        chain = await self.events(2)
        self.clock.advance(minutes=16)
        await self.scheduler.tick()
        self.clock.offset = timedelta(0)
        await self.events(1, start=2)                                       # one brand-new event after a checkpoint
        self.assertEqual(await self.scheduler.tick(), [])                  # a new event does not make a new checkpoint due at once
        self.assertEqual(len(await self.checkpoints(chain)), 1)

    async def test_empty_chains_and_chains_with_nothing_new_get_no_checkpoint(self):
        async with db.transaction() as conn:
            await conn.execute(text("SELECT ensure_chain(CAST(:t AS uuid))"), {"t": self.tenant})
        chain = await self.chain_id(self.tenant)
        self.clock.advance(hours=3)
        self.assertEqual(await self.scheduler.tick(), [])
        self.assertEqual(await self.checkpoints(chain), [])
        await self.events(2)
        self.assertEqual([o.status for o in await self.scheduler.tick()], ["CREATED"])
        self.clock.advance(hours=3)
        self.assertEqual(await self.scheduler.tick(), [])                  # nothing new since: no redundant checkpoint
        self.assertEqual(len(await self.checkpoints(chain)), 1)

    async def test_every_chain_is_scheduled_independently(self):
        busy = await self.events(500)
        quiet_tenant = uuid4()
        quiet = await self.events(5, tenant=quiet_tenant)
        await self.scheduler.tick()
        self.assertEqual(len(await self.checkpoints(busy)), 1)
        self.assertEqual(await self.checkpoints(quiet), [])
        self.clock.advance(minutes=20)
        await self.scheduler.tick()
        self.assertEqual(len(await self.checkpoints(quiet)), 1)
        self.assertEqual(len(await self.checkpoints(busy)), 1)             # nothing new on the busy chain: no redundant second checkpoint

    async def test_a_backlog_is_caught_up_in_order_without_resetting_the_chain(self):
        object.__setattr__(self.signer.settings, "max_events", 500)         # the signer caps one checkpoint at 500 events
        with override_settings(checkpoint_max_events=500):
            chain = await self.events(1300)
            await self.scheduler.tick()
            rows = await self.checkpoints(chain)
            self.assertEqual([(r["checkpoint_number"], r["start_sequence"], r["end_sequence"]) for r in rows], [(1, 1, 500), (2, 501, 1000)])
            self.clock.advance(minutes=20)
            await self.scheduler.tick()
            self.assertEqual([r["end_sequence"] for r in await self.checkpoints(chain)], [500, 1000, 1300])
            verdict = await chain_verifier.verify_chain(chain)
            self.assertEqual((verdict.status, verdict.total_events_checked), ("VALID", 1300))   # the SHA-256 chain is untouched

    async def test_concurrent_workers_never_create_duplicate_or_misordered_checkpoints(self):
        chain = await self.events(500)
        workers = [self.signer.generator(f"worker-{i}") for i in range(8)]
        outcomes = await asyncio.gather(*(w.checkpoint_chain(chain) for w in workers))
        self.assertEqual(sorted(o.status for o in outcomes).count("CREATED"), 1)
        self.assertEqual(len(await self.checkpoints(chain)), 1)
        await self.events(500, start=500)
        schedulers = [self.signer.scheduler(f"s{i}", clock=self.clock) for i in range(5)]
        await asyncio.gather(*(s.tick() for s in schedulers), *(s.tick() for s in schedulers))
        rows = await self.checkpoints(chain)
        self.assertEqual([(r["checkpoint_number"], r["start_sequence"], r["end_sequence"]) for r in rows], [(1, 1, 500), (2, 501, 1000)])
        files = CheckpointStore(self.signer.checkpoints_dir).numbers(str(await self.environment_id()), str(self.tenant))
        self.assertEqual(files, [1, 2])

    async def test_a_lease_held_by_a_live_worker_blocks_others_and_an_expired_one_is_taken_over(self):
        chain = await self.events(500)
        now = datetime.now(timezone.utc)
        async with db.transaction() as conn:
            self.assertTrue(await repo.acquire_lease(conn, chain, "crashed-worker", now, 120))
        outcome = await self.signer.generator("healthy").checkpoint_chain(chain)
        self.assertEqual(outcome.status, "LEASE_HELD")
        later = lambda: now + timedelta(minutes=5)                          # the crashed worker's lease has expired
        outcome = await self.signer.generator("healthy", clock=later).checkpoint_chain(chain)
        self.assertEqual(outcome.status, "CREATED")

    async def test_signing_failure_is_retried_alerted_once_and_recovers(self):
        chain = await self.events(500)

        class Flaky:
            def __init__(self, real):
                self.real, self.fail = real, 2

            async def sign_checkpoint(self, *a, **k):
                if self.fail:
                    self.fail -= 1
                    raise SigningError("SIGNER_UNAVAILABLE", "the signer cannot be reached")
                return await self.real.sign_checkpoint(*a, **k)

        flaky = Flaky(self.signer.client)
        generator = self.signer.generator("w", signer=flaky)
        first = await generator.checkpoint_chain(chain)
        second = await generator.checkpoint_chain(chain)
        self.assertEqual((first.status, first.error_code, second.status), ("FAILED", "SIGNER_UNAVAILABLE", "FAILED"))
        state = (await self.fetch("SELECT * FROM checkpoint_state WHERE chain_id = :c", c=chain))[0]
        self.assertEqual((state["consecutive_failures"], state["alert_open"], state["last_error_code"], state["lease_owner"]), (2, True, "SIGNER_UNAVAILABLE", None))
        alerts = await self.fetch("SELECT kind, severity FROM checkpoint_alerts WHERE chain_id = :c", c=chain)
        self.assertEqual([(a["kind"], a["severity"]) for a in alerts], [("SIGNER_UNAVAILABLE", "CRITICAL")])      # one alert, not one per retry
        self.assertEqual(await self.checkpoints(chain), [])                                                       # nothing was silently skipped or faked
        third = await generator.checkpoint_chain(chain)
        self.assertEqual(third.status, "CREATED")
        state = (await self.fetch("SELECT * FROM checkpoint_state WHERE chain_id = :c", c=chain))[0]
        self.assertEqual((state["consecutive_failures"], state["alert_open"], state["last_error"]), (0, False, None))
        kinds = [a["kind"] for a in await self.fetch("SELECT kind FROM checkpoint_alerts WHERE chain_id = :c ORDER BY id", c=chain)]
        self.assertEqual(kinds, ["SIGNER_UNAVAILABLE", "CHECKPOINT_RECOVERED"])

    async def test_retries_back_off_instead_of_hammering_the_signer(self):
        chain = await self.events(500)

        class Down:
            calls = 0

            async def sign_checkpoint(self, *a, **k):
                Down.calls += 1
                raise SigningError("SIGNER_UNAVAILABLE", "down")

        with override_settings(checkpoint_retry_base_seconds=60.0, checkpoint_retry_max_seconds=600.0):
            generator = self.signer.generator("w", signer=Down())
            self.assertEqual((await generator.checkpoint_chain(chain)).status, "FAILED")
            self.assertEqual((await generator.checkpoint_chain(chain)).status, "LEASE_HELD")      # still backing off
            self.assertEqual(Down.calls, 1)

    async def test_an_uninitialised_signer_raises_a_key_alert_and_creates_nothing(self):
        other = SignerHarness(self.database, self.tmp / "uninitialised", clock=self.clock)
        chain = await self.events(500)
        outcome = await other.generator("w").checkpoint_chain(chain)
        self.assertEqual((outcome.status, outcome.error_code), ("FAILED", "KEY_UNAVAILABLE"))
        self.assertEqual([a["kind"] for a in await self.fetch("SELECT kind FROM checkpoint_alerts WHERE chain_id = :c", c=chain)], ["SIGNER_KEY_UNAVAILABLE"])
        self.assertEqual(await self.checkpoints(chain), [])
        await other.close()

    async def test_a_storage_failure_is_a_failure_not_a_checkpoint(self):
        chain = await self.events(500)
        with mock.patch.object(CheckpointStore, "write", side_effect=OSError("disk full")):
            outcome = await self.signer.generator("w").checkpoint_chain(chain)
        self.assertEqual((outcome.status, outcome.error_code), ("FAILED", "STORAGE_FAILED"))
        self.assertEqual(await self.checkpoints(chain), [])
        self.assertEqual([a["kind"] for a in await self.fetch("SELECT kind FROM checkpoint_alerts WHERE chain_id = :c", c=chain)], ["STORAGE_FAILED"])
        self.assertEqual((await self.signer.generator("w").checkpoint_chain(chain)).status, "CREATED")

    async def test_a_checkpoint_whose_protected_copy_is_not_visible_is_not_recorded(self):
        chain = await self.events(500)
        generator = CheckpointGenerator(self.signer.client, "w", storage=TrustedStorage(str(self.tmp / "somewhere-else")))
        outcome = await generator.checkpoint_chain(chain)
        self.assertEqual((outcome.status, outcome.error_code), ("FAILED", "STORAGE_NOT_VISIBLE"))
        self.assertEqual(await self.checkpoints(chain), [])           # not 'fully protected', so not recorded as a checkpoint

    async def test_a_restart_resumes_from_durable_state(self):
        chain = await self.events(500)
        await self.signer.scheduler(clock=self.clock).tick()
        await self.signer.restart()                                    # the signer 'container' restarts
        await self.events(500, start=500)
        fresh_scheduler = self.signer.scheduler("after-restart", clock=self.clock)   # and so does the audit service
        await fresh_scheduler.tick()
        self.assertEqual([r["end_sequence"] for r in await self.checkpoints(chain)], [500, 1000])

    async def test_the_database_itself_refuses_misordered_or_unanchored_checkpoints(self):
        chain = await self.events(500)
        await self.checkpoint(chain)
        row = (await self.fetch("SELECT * FROM checkpoints WHERE chain_id = :c", c=chain))[0]
        columns = [k for k in row.keys()]
        async def insert(**changes):
            values = dict(row, checkpoint_id=uuid4(), **changes)
            async with db.transaction() as conn:
                await conn.execute(text(f"INSERT INTO checkpoints ({', '.join(columns)}) VALUES ({', '.join(':' + c for c in columns)})"), values)
        for changes in (dict(checkpoint_number=3), dict(checkpoint_number=2, start_sequence=7), dict(checkpoint_number=2, start_sequence=501, end_sequence=501, event_count=1),
                        dict(checkpoint_number=2, start_sequence=501, end_sequence=501, event_count=1, previous_checkpoint_hash="1" * 64)):
            with self.subTest(changes=changes), self.assertRaises(DBAPIError):
                await insert(**changes)
        for sql in ("UPDATE checkpoints SET signature = 'x'", "DELETE FROM checkpoints", "TRUNCATE checkpoints"):
            with self.subTest(sql=sql), self.assertRaises(DBAPIError):
                async with db.transaction() as conn:
                    await conn.execute(text(sql))

    async def test_ingestion_is_not_blocked_while_checkpoints_are_signed(self):
        chain = await self.events(500)
        async def keep_ingesting():
            for n in range(500, 540):
                await audit_service.ingest([audit_service_intent(self.tenant, n)])
        from tests.support import intent as audit_service_intent
        outcomes, _ = await asyncio.gather(self.signer.generator("w").checkpoint_chain(chain), keep_ingesting())
        self.assertEqual(outcomes.status, "CREATED")
        verdict = await chain_verifier.verify_chain(chain)
        self.assertEqual((verdict.status, verdict.total_events_checked), ("VALID", 540))


class ProviderTests(StageTwoCase):
    def test_provider_selection(self):
        with override_settings(signing_enabled=False):
            self.assertIsNone(get_signer(settings))
        with override_settings(signing_enabled=True, signing_provider="local", signer_service_key=SERVICE_KEY):
            self.assertEqual(type(get_signer(settings)).__name__, "LocalSignerClient")
        for name in ("vault", "kms", "unknown"):
            with override_settings(signing_enabled=True, signing_provider=name), self.assertRaises(UnsupportedProvider):
                get_signer(settings)
