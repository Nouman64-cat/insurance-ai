"""Stage 3 operations: failures and recovery, duplicate execution, hot cleanup safety, legal holds, retrieval."""
import asyncio
import json
import subprocess
import sys
import zipfile
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import text

from app import db
from app.archive import crypto, evidence as evidence_pkg, repository as repo
from app.archive.retrieval import RetrievalError, clean_criteria
from app.archive.worker import FAILED as JOB_FAILED, LEASE_HELD
from app.checkpoints.storage import TrustedStorage
from app.config import settings
from app.services import chain_verifier
from app.signing.interface import SigningError
from app.verification import integrity_verifier as iv, signature_verifier as sv
from tests.archive_support import ArchiveCase, MemoryStore
from tests.support import intent


class FailureRecoveryTests(ArchiveCase):
    async def prepared(self, n=40, tenant=None):
        chain = await self.aged_events(n, tenant=tenant)
        await self.checkpoint(chain)
        w = self.worker()
        planned = await w.plan(chain_id=chain)
        return chain, w, planned[0].job_id

    async def test_an_object_store_outage_parks_the_job_without_losing_or_changing_anything_then_resumes(self):
        chain, w, job_id = await self.prepared()
        self.store.down = True
        out = await w.run_job(job_id)
        self.assertEqual((out.status, out.error_code), (JOB_FAILED, "STORE_UNAVAILABLE"))
        job = (await self.job_rows(chain))[0]
        self.assertEqual((job["state"], job["resume_state"]), ("FAILED", "UPLOADING"))
        self.assertEqual(await self.hot_count(chain), 40, "a failed archive must never discard source records")
        self.assertEqual(await self.catalog(chain), [])
        alerts = await self.fetch("SELECT kind, severity FROM checkpoint_alerts WHERE kind LIKE 'ARCHIVE_%'")
        self.assertTrue(alerts)
        self.store.down = False
        outcomes = await w.process_due()
        self.assertEqual([o.status for o in outcomes], ["DONE"])
        self.assertEqual((await self.job_rows(chain))[0]["state"], "ARCHIVED")
        self.assertEqual(len(await self.catalog(chain)), 1)

    async def test_an_outage_half_way_through_the_uploads_resumes_without_a_second_signature(self):
        chain, w, job_id = await self.prepared()
        self.store.fail_puts_after = 1                       # the data object goes up, the manifest objects do not
        out = await w.run_job(job_id)
        self.assertEqual(out.status, JOB_FAILED)
        self.store.fail_puts_after = None
        before = (self.signer.checkpoints_dir / "archives" / self.env / str(self.tenant) / "archive-000001.json").read_bytes()
        self.assertEqual([o.status for o in await w.process_due()], ["DONE"])
        after = (self.signer.checkpoints_dir / "archives" / self.env / str(self.tenant) / "archive-000001.json").read_bytes()
        self.assertEqual(before, after, "the manifest is signed once and never re-signed on retry")
        self.assertEqual(len(await self.catalog(chain)), 1)

    async def test_a_signer_outage_is_retried_and_the_archive_completes_when_it_returns(self):
        chain, w, job_id = await self.prepared()

        class Down:
            async def sign_archive(self, manifest):
                raise SigningError("SIGNER_UNAVAILABLE", "the signer cannot be reached")
        real = w.signer
        w.signer = Down()
        out = await w.run_job(job_id)
        self.assertEqual((out.status, out.error_code), (JOB_FAILED, "SIGNER_UNAVAILABLE"))
        w.signer = real
        self.assertEqual([o.status for o in await w.process_due()], ["DONE"])

    async def test_a_crash_mid_job_leaves_a_lease_that_a_later_worker_takes_over(self):
        chain, w, job_id = await self.prepared()
        async with db.transaction() as conn:                 # a worker that took the job and then died
            taken = await repo.acquire_job(conn, job_id, "dead-worker", self.clock(), 600)
        self.assertIsNotNone(taken)
        out = await self.worker("worker-2").run_job(job_id)
        self.assertEqual(out.status, LEASE_HELD, "a live lease must be respected")
        self.clock.advance(minutes=11)
        out = await self.worker("worker-2").run_job(job_id)
        self.assertEqual(out.status, "DONE")
        self.assertEqual(len(await self.catalog(chain)), 1)

    async def test_an_exception_in_a_step_is_recorded_and_the_job_resumes_in_that_step(self):
        chain, w, job_id = await self.prepared()
        original = w._validating

        async def boom(job):
            raise RuntimeError("process died")
        w._validating = boom
        out = await w.run_job(job_id)
        self.assertEqual(out.status, JOB_FAILED)
        job = (await self.job_rows(chain))[0]
        self.assertEqual(job["resume_state"], "VALIDATING")
        w._validating = original
        self.assertEqual([o.status for o in await w.process_due()], ["DONE"])
        self.assertEqual(len(await self.catalog(chain)), 1)

    async def test_the_same_job_run_twice_at_once_archives_exactly_once(self):
        chain, w, job_id = await self.prepared()
        results = await asyncio.gather(self.worker("a").run_job(job_id), self.worker("b").run_job(job_id))
        self.assertEqual(sorted(r.status for r in results), sorted(["DONE", LEASE_HELD]))
        self.assertEqual(len(await self.catalog(chain)), 1)
        self.assertEqual(len([k for k in self.store.objects if k.endswith("data.iaar")]), 1)

    async def test_planning_twice_concurrently_creates_one_job(self):
        chain = await self.aged_events(30)
        await self.checkpoint(chain)
        await asyncio.gather(self.worker("a").plan(chain_id=chain), self.worker("b").plan(chain_id=chain))
        self.assertEqual(len(await self.job_rows(chain)), 1)

    async def test_a_broken_chain_is_never_archived(self):
        chain, w, job_id = await self.prepared()
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE events SET new_value = '{\"n\": 999}' WHERE chain_id = :c AND sequence_number = 7"), {"c": chain})
        out = await w.run_job(job_id)
        self.assertEqual((out.status, out.error_code), (JOB_FAILED, "HASH_CHAIN_INVALID"))
        self.assertEqual(self.store.objects, {}, "nothing is uploaded for a range that fails verification")
        job = (await self.job_rows(chain))[0]
        self.assertIsNone(job["next_attempt_at"], "an integrity failure needs a person, not a retry loop")
        alerts = await self.fetch("SELECT severity FROM checkpoint_alerts WHERE kind = 'ARCHIVE_INTEGRITY'")
        self.assertEqual(alerts[0]["severity"], "CRITICAL")

    async def test_a_bucket_without_object_lock_or_that_is_public_is_refused(self):
        for caps, needle in (({"object_lock": False}, "Object Lock"), ({"private": False}, "anonymous")):
            with self.subTest(caps=caps):
                self.store = MemoryStore()
                chain, w, job_id = await self.prepared(tenant=uuid4())
                w = self.worker(store=self.store)
                self.store.caps.update(caps)
                out = await w.run_job(job_id)
                self.assertEqual((out.status, out.error_code), (JOB_FAILED, "STORE_CAPABILITY"))
                self.assertIn(needle, out.error)
                self.assertEqual(self.store.objects, {})

    async def test_a_missing_master_key_fails_the_job_and_nothing_is_lost(self):
        chain, w, job_id = await self.prepared()
        w.keyring = crypto.KeyRing(str(self.tmp / "no-keys"))
        out = await w.run_job(job_id)
        self.assertEqual((out.status, out.error_code), (JOB_FAILED, "KEK_UNAVAILABLE"))
        self.assertEqual(await self.hot_count(chain), 40)

    async def test_a_lost_local_export_is_rebuilt(self):
        chain, w, job_id = await self.prepared()
        original = w._uploading
        state = {"first": True}

        async def lose_file(job):
            if state["first"]:
                state["first"] = False
                w._local(job).unlink()
            return await original(job)
        w._uploading = lose_file
        out = await w.run_job(job_id)
        self.assertEqual(out.status, JOB_FAILED)
        self.assertEqual([o.status for o in await w.process_due()], ["DONE"])
        self.assertEqual(len(await self.catalog(chain)), 1)


class HotCleanupTests(ArchiveCase):
    async def archived_and_ready(self, n=60):
        chain, row = await self.archived_chain(n)
        w = self.worker()
        cleanup = self.cleanup_service(w)
        return chain, row, w, cleanup

    async def test_nothing_leaves_hot_storage_when_cleanup_is_not_requested_and_the_default_is_off(self):
        self.assertFalse(settings.auto_hot_cleanup)
        chain, row, w, cleanup = await self.archived_and_ready()
        from app.archive.scheduler import ArchiveScheduler
        from app.archive.service import ArchiveServices
        services = ArchiveServices(w, cleanup, self.retrieval_service(w), w.verifier, self.store, self.store, self.keyring, w.storage)
        await ArchiveScheduler(services).tick()
        self.assertEqual(await self.hot_count(chain), 60)

    async def test_the_safety_period_must_pass_before_an_archive_is_approved(self):
        chain, row, w, cleanup = await self.archived_and_ready()
        async with db.transaction() as conn:
            await conn.execute(text("UPDATE archive_jobs SET cleanup_after = now() + interval '3 days'"))
        result = await cleanup.promote()
        self.assertEqual(result[0]["status"], "WAITING")
        self.assertIsNone((await self.catalog(chain))[0]["cleanup_approved_at"])
        self.clock.advance(days=4)
        self.assertEqual((await cleanup.promote())[0]["status"], "ELIGIBLE")
        self.assertIsNotNone((await self.catalog(chain))[0]["cleanup_approved_at"])
        kinds = await self.fetch("SELECT kind, state FROM archive_verifications WHERE kind = 'CLEANUP_GATE'")
        self.assertEqual([k["state"] for k in kinds], ["VERIFIED"])

    async def test_a_damaged_archive_blocks_cleanup(self):
        chain, row, w, cleanup = await self.archived_and_ready()
        blob = bytearray(self.store.objects[row["data_key"]][-1]["data"])
        blob[-30] ^= 1
        self.store.replace(row["data_key"], bytes(blob))
        result = await cleanup.promote()
        self.assertEqual(result[0]["status"], "BLOCKED")
        self.assertIsNone((await self.catalog(chain))[0]["cleanup_approved_at"])
        report = await cleanup.remove(dry_run=False)
        self.assertEqual(report["removed_months"], [])
        self.assertEqual(await self.hot_count(chain), 60)

    async def test_a_dry_run_changes_nothing(self):
        chain, row, w, cleanup = await self.archived_and_ready()
        await cleanup.promote()
        report = await cleanup.remove(dry_run=True)
        removable = [p for p in report["partitions"] if p["status"] == "REMOVABLE"]
        self.assertEqual(len(removable), 1)
        self.assertEqual(await self.hot_count(chain), 60)

    async def test_a_fully_archived_old_month_is_removed_whole_and_the_chain_still_verifies(self):
        chain, row, w, cleanup = await self.archived_and_ready()
        before = await self.fetch("SELECT current_hash FROM events WHERE chain_id = :c ORDER BY sequence_number", c=chain)
        await cleanup.promote()
        report = await cleanup.remove(dry_run=False)
        self.assertEqual(len(report["removed_months"]), 1)
        self.assertEqual(report["jobs_completed"], 1)
        self.assertEqual(await self.hot_count(chain), 0)
        self.assertEqual((await self.job_rows(chain))[0]["state"], "HOT_CLEANUP_COMPLETED")
        # detached, not destroyed: still a table, re-attachable
        detached = await self.fetch("SELECT count(*) AS n FROM pg_tables WHERE tablename LIKE 'detached_events_p%'")
        self.assertEqual(detached[0]["n"], 1)
        result = await chain_verifier.verify_chain(chain)
        self.assertEqual(result.status, chain_verifier.VALID, result.details)
        self.assertEqual(result.details["archived_prefix"]["through_sequence"], 60)
        anchored = await iv.verify_anchored(chain, storage=TrustedStorage(str(self.signer.checkpoints_dir)))
        self.assertIn(anchored.state, (sv.VERIFIED, sv.UNSIGNED_EVENTS_PENDING), [f.to_api() for f in anchored.findings])
        # the archive still has every event
        path = self.tmp / "after.iaar"
        path.write_bytes(self.store.objects[row["data_key"]][-1]["data"])
        from app.archive import format as fmt
        self.assertEqual([e["current_hash"] for e in fmt.iter_events(path, self.keyring)], [r["current_hash"] for r in before])

    async def test_an_archive_that_extends_past_the_removed_partition_leaves_a_verifiable_hot_chain(self):
        """The normal steady-state shape: one archive spans two months, only the older month can leave hot storage (another tenant's unarchived
        events pin the newer one), so the hot chain starts in the MIDDLE of the archive."""
        first = await self.aged_events(30, months_ago=9.0)
        await self.aged_events(30, months_ago=7.5, start=30)
        await self.checkpoint(first)
        other = uuid4()
        await self.aged_events(5, months_ago=7.5, tenant=other)          # unarchived, same month as the second half
        w = self.worker()
        _, outcomes = await self.archive_chain(first, w)
        self.assertEqual(outcomes[0].status, "DONE")
        cleanup = self.cleanup_service(w)
        await cleanup.promote()
        report = await cleanup.remove(dry_run=False)
        self.assertEqual(len(report["removed_months"]), 1, report["partitions"])
        hot = await self.fetch("SELECT min(sequence_number) AS lo, count(*) AS n FROM events WHERE chain_id = :c", c=first)
        self.assertTrue(0 < hot[0]["n"] < 60, hot)
        result = await chain_verifier.verify_chain(first)
        self.assertEqual(result.status, chain_verifier.VALID, result.details)
        self.assertEqual(result.from_sequence, hot[0]["lo"])
        anchored = await iv.verify_anchored(first, storage=TrustedStorage(str(self.signer.checkpoints_dir)))
        self.assertIn(anchored.state, (sv.VERIFIED, sv.UNSIGNED_EVENTS_PENDING), [f.to_api() for f in anchored.findings])
        # tampering with the first surviving event is still caught: its hash feeds every later signed checkpoint
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE events SET new_value = '{\"x\": 1}' WHERE chain_id = :c AND sequence_number = :s"), {"c": first, "s": hot[0]["lo"]})
        self.assertNotEqual((await chain_verifier.verify_chain(first)).status, chain_verifier.VALID)

    async def test_new_events_and_checkpoints_continue_after_cleanup(self):
        chain, row, w, cleanup = await self.archived_and_ready()
        await cleanup.promote()
        await cleanup.remove(dry_run=False)
        from app.services import audit_service
        await audit_service.ingest([intent(self.tenant, 1000 + i) for i in range(5)])
        cp = await self.checkpoint(chain)     # the signer's anchor event is gone from hot storage: it must accept the signed archive boundary
        self.assertEqual((cp["start_sequence"], cp["end_sequence"]), (61, 65))
        self.assertEqual((await chain_verifier.verify_chain(chain)).status, chain_verifier.VALID)
        anchored = await iv.verify_anchored(chain, storage=TrustedStorage(str(self.signer.checkpoints_dir)))
        self.assertEqual(anchored.state, sv.VERIFIED, [f.to_api() for f in anchored.findings])
        dup = await audit_service.ingest([intent(self.tenant, 0, source_event_id="seed-dup")])
        again = await audit_service.ingest([intent(self.tenant, 0, source_event_id="seed-dup")])
        self.assertEqual(again[0].status, "DUPLICATE", "global idempotency survives partition removal (event_sources)")

    async def test_the_signer_still_refuses_a_truncated_chain_whose_boundary_was_never_archived(self):
        chain = await self.aged_events(30, months_ago=0.2)           # recent: not archivable
        await self.checkpoint(chain)
        await self.aged_events(5, months_ago=0.2, start=30)
        async with self.privileged() as conn:
            await conn.execute(text("DELETE FROM events WHERE chain_id = :c AND sequence_number = 30"), {"c": chain})
        out = await self.signer.generator("w").checkpoint_chain(chain)
        self.assertEqual(out.status, "FAILED")
        self.assertIn(out.error_code, ("CHAIN_TRUNCATED", "SEQUENCE_GAP", "ANCHOR_MISMATCH", "HASH_CHAIN_BROKEN"))

    async def test_events_that_are_not_archived_keep_their_partition(self):
        chain, row, w, cleanup = await self.archived_and_ready()
        other = uuid4()
        await self.aged_events(10, months_ago=8, tenant=other)        # same month, never archived
        await cleanup.promote()
        report = await cleanup.remove(dry_run=False)
        self.assertEqual(report["removed_months"], [])
        self.assertEqual(await self.hot_count(chain), 60)
        item = next(p for p in report["partitions"] if p["events"] > 0 and p["status"] == "BLOCKED")
        self.assertTrue(any("not archived" in r for r in item["reasons"]))

    async def test_the_database_itself_refuses_unsafe_removal_even_if_the_application_is_wrong(self):
        chain, row, w, cleanup = await self.archived_and_ready()
        month = (await self.fetch("SELECT date_trunc('month', min(recorded_at))::date AS m FROM events WHERE chain_id = :c", c=chain))[0]["m"]
        with self.assertRaises(Exception) as ctx:                   # archived, but cleanup was never approved
            async with db.transaction() as conn:
                await conn.execute(text("SELECT remove_event_partition(:m)"), {"m": month})
        self.assertIn("not archived and approved", str(ctx.exception))
        current = datetime.now(timezone.utc).date().replace(day=1)
        with self.assertRaises(Exception):
            async with db.transaction() as conn:
                await conn.execute(text("SELECT remove_event_partition(:m)"), {"m": current})
        with self.assertRaises(Exception):
            async with db.transaction() as conn:
                await conn.execute(text("DROP TABLE events_legacy_v1"))
        self.assertEqual(await self.hot_count(chain), 60)

    async def test_a_database_failure_during_removal_leaves_everything_in_place(self):
        chain, row, w, cleanup = await self.archived_and_ready()
        await cleanup.promote()
        real = db.transaction
        calls = {"n": 0}

        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def flaky():
            async with real() as conn:
                calls["n"] += 1
                orig = conn.execute

                async def execute(statement, *a, **k):
                    if "remove_event_partition" in str(statement):
                        await orig(statement, *a, **k)
                        raise ConnectionError("connection lost after the DDL, before commit")
                    return await orig(statement, *a, **k)
                conn.execute = execute
                yield conn
        db.transaction = flaky
        try:
            report = await cleanup.remove(dry_run=False)
        finally:
            db.transaction = real
        self.assertEqual(report["removed_months"], [])
        self.assertEqual(await self.hot_count(chain), 60, "the partition removal is transactional: a failure before commit removes nothing")
        self.assertEqual((await self.job_rows(chain))[0]["state"], "HOT_CLEANUP_ELIGIBLE")

    async def test_a_legal_hold_blocks_promotion_and_removal_and_release_unblocks(self):
        chain, row, w, cleanup = await self.archived_and_ready()
        async with db.transaction() as conn:
            hold = await repo.place_hold(conn, str(self.tenant), None, "litigation", "CASE-1", "legal@example.test")
        blocked = await cleanup.promote()
        self.assertEqual(blocked[0]["status"], "BLOCKED")
        self.assertIn("legal hold", blocked[0]["reason"])
        # even if an approval existed already, the database checks the hold itself
        async with db.transaction() as conn:
            await repo.approve_cleanup(conn, str(row["archive_id"]))
        report = await cleanup.remove(dry_run=False)
        self.assertEqual(report["removed_months"], [])
        self.assertEqual(await self.hot_count(chain), 60)
        async with db.transaction() as conn:
            self.assertIsNotNone(await repo.release_hold(conn, hold["hold_id"], "resolved", "legal@example.test"))
            self.assertIsNone(await repo.release_hold(conn, hold["hold_id"], "again", "x"), "a hold is released once")
        with self.assertRaises(Exception):
            async with db.transaction() as conn:
                await conn.execute(text("UPDATE legal_holds SET reason = 'edited'"))
        with self.assertRaises(Exception):
            async with db.transaction() as conn:
                await conn.execute(text("DELETE FROM legal_holds"))

    async def test_a_policy_can_forbid_hot_cleanup(self):
        chain, row, w, cleanup = await self.archived_and_ready()
        async with db.transaction() as conn:
            await repo.set_policy(conn, tenant_id=str(self.tenant), category="underwriting_policy", hot_months=6, cold_years=None, allow_hot_cleanup=False,
                                  approved=False, actor="t", notes=None)
        self.assertEqual((await cleanup.promote())[0]["status"], "BLOCKED")


class RetrievalTests(ArchiveCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.chain, self.row = await self.archived_chain(80)
        self.w = self.worker()
        self.svc = self.retrieval_service(self.w)

    async def retrieve(self, **criteria):
        r = await self.svc.request(tenant_id=str(self.tenant), unrestricted=False, requested_by="tester", criteria=criteria)
        self.assertEqual(r["state"], "PENDING")
        await self.svc.process_pending()
        return (await self.fetch("SELECT * FROM archive_retrievals WHERE retrieval_id = CAST(:r AS uuid)", r=r["retrieval_id"]))[0]

    async def test_retrieval_restores_matching_events_to_staging_without_touching_the_live_chain(self):
        before = await self.fetch("SELECT event_id, current_hash FROM events WHERE chain_id = :c ORDER BY sequence_number", c=self.chain)
        row = await self.retrieve(entity_id="ENT-3")
        self.assertEqual((row["state"], row["verified"]), ("READY", True))
        staged = await self.fetch("SELECT * FROM archive_staging WHERE retrieval_id = :r ORDER BY sequence_number", r=row["retrieval_id"])
        expected = [e for e in before if True]
        ledger = await self.fetch("SELECT * FROM events WHERE chain_id = :c AND entity_id = 'ENT-3' ORDER BY sequence_number", c=self.chain)
        self.assertEqual([s["current_hash"] for s in staged], [l["current_hash"] for l in ledger])
        self.assertEqual(staged[0]["new_value"], ledger[0]["new_value"])
        after = await self.fetch("SELECT event_id, current_hash FROM events WHERE chain_id = :c ORDER BY sequence_number", c=self.chain)
        self.assertEqual(before, after)
        self.assertEqual((await chain_verifier.verify_chain(self.chain)).status, chain_verifier.VALID)

    async def test_retrieval_by_sequence_range_and_time(self):
        row = await self.retrieve(chain_id=self.chain, from_sequence=10, to_sequence=19)
        self.assertEqual(row["event_count"], 10)
        row = await self.retrieve(module="policies", action="policy.issued", chain_id=self.chain)
        self.assertEqual(row["event_count"], 80)

    async def test_retrieval_still_works_after_events_left_hot_storage(self):
        ledger = await self.fetch("SELECT current_hash FROM events WHERE chain_id = :c ORDER BY sequence_number", c=self.chain)
        cleanup = self.cleanup_service(self.w)
        await cleanup.promote()
        await cleanup.remove(dry_run=False)
        self.assertEqual(await self.hot_count(self.chain), 0)
        row = await self.retrieve(chain_id=self.chain)
        staged = await self.fetch("SELECT current_hash FROM archive_staging WHERE retrieval_id = :r ORDER BY sequence_number", r=row["retrieval_id"])
        self.assertEqual([s["current_hash"] for s in staged], [l["current_hash"] for l in ledger])

    async def test_a_damaged_archive_fails_the_retrieval_and_stages_nothing(self):
        blob = bytearray(self.store.objects[self.row["data_key"]][-1]["data"])
        blob[len(blob) // 3] ^= 1
        self.store.replace(self.row["data_key"], bytes(blob))
        row = await self.retrieve(chain_id=self.chain)
        self.assertEqual((row["state"], row["verified"]), ("FAILED", False))
        self.assertEqual((await self.fetch("SELECT count(*) AS n FROM archive_staging"))[0]["n"], 0)

    async def test_requests_that_cannot_match_are_refused_up_front(self):
        for criteria in ({"entity_id": "NOT-THERE-" + uuid4().hex}, {"chain_id": "no:such"}):
            with self.assertRaises(RetrievalError) as ctx:
                await self.svc.request(tenant_id=str(self.tenant), unrestricted=False, requested_by="t", criteria=criteria)
            self.assertEqual(ctx.exception.code, "NO_ARCHIVES")
        with self.assertRaises(RetrievalError):
            clean_criteria({})
        with self.assertRaises(RetrievalError):
            clean_criteria({"sql": "x"})

    async def test_another_tenant_cannot_find_these_archives(self):
        with self.assertRaises(RetrievalError) as ctx:
            await self.svc.request(tenant_id=str(uuid4()), unrestricted=False, requested_by="other", criteria={"chain_id": self.chain})
        self.assertEqual(ctx.exception.code, "NO_ARCHIVES")

    async def test_staged_copies_expire_and_the_archive_is_untouched(self):
        row = await self.retrieve(chain_id=self.chain)
        self.clock.advance(hours=settings.retrieval_ttl_hours + 1)
        self.assertEqual(await self.svc.expire(), 1)
        self.assertEqual((await self.fetch("SELECT count(*) AS n FROM archive_staging"))[0]["n"], 0)
        self.assertEqual((await self.fetch("SELECT state FROM archive_retrievals"))[0]["state"], "EXPIRED")
        self.assertEqual(len(await self.catalog(self.chain)), 1)


class EvidencePackageTests(ArchiveCase):
    async def test_the_package_can_be_verified_by_the_standalone_script_and_tampering_fails_it(self):
        chain, row = await self.archived_chain(40)
        w = self.worker()
        verification = await w.verifier.verify(dict(row), deep=False, env=self.env)
        envelope = w.storage.read_archive(self.env, str(self.tenant), 1)
        cov = envelope["manifest"]["covered_checkpoints"]
        checkpoints = [w.storage.read(self.env, str(self.tenant), n) for n in range(cov["first_number"], cov["last_number"] + 1)]
        from app.trust import key_registry
        registry = {"keys": key_registry.load_registry(self.env, str(self.signer.checkpoints_dir)).public_list()}
        blob = evidence_pkg.build(dict(row), verification, manifest_envelope=envelope, checkpoints=checkpoints, registry=registry)
        out = self.tmp / "evidence"
        out.mkdir()
        with zipfile.ZipFile(__import__("io").BytesIO(blob)) as z:
            z.extractall(out)
            self.assertIn("verify_evidence.py", z.namelist())
            self.assertNotIn("data.iaar", z.namelist())
        ok = subprocess.run([sys.executable, "-I", "verify_evidence.py"], cwd=out, capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
        self.assertIn("OK", ok.stdout)
        signature = json.loads((out / "signature.json").read_text())
        signature["manifest"]["event_count"] = 41
        (out / "signature.json").write_text(json.dumps(signature))
        bad = subprocess.run([sys.executable, "-I", "verify_evidence.py"], cwd=out, capture_output=True, text=True)
        self.assertNotEqual(bad.returncode, 0)
