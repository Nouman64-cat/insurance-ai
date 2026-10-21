"""Stage 3 core: eligibility, retention windows, compression + encryption, signed manifests, the catalog, and hash-chain preservation."""
import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import text

from app import db
from app.archive import crypto, format as fmt, policy as pol, repository as repo
from app.services import chain_verifier
from app.verification import integrity_verifier as iv, signature_verifier as sv
from app.checkpoints.storage import TrustedStorage
from shared.audit import archive_manifest as am
from tests.archive_support import ArchiveCase


class EligibilityTests(ArchiveCase):
    async def test_events_older_than_the_hot_window_are_planned_for_archive(self):
        chain = await self.aged_events(30, months_ago=8)
        await self.checkpoint(chain)
        planned = await self.worker().plan(chain_id=chain, dry_run=True)
        self.assertEqual(len(planned), 1)
        self.assertEqual((planned[0].start_sequence, planned[0].end_sequence), (1, 30))
        self.assertEqual(await self.fetch("SELECT count(*) AS n FROM archive_jobs"), [{"n": 0}], "a dry run must not create anything")

    async def test_events_inside_the_default_six_month_window_are_not_archived(self):
        chain = await self.aged_events(30, months_ago=5)
        await self.checkpoint(chain)
        self.assertEqual(await self.worker().plan(chain_id=chain), [])

    async def test_only_a_signed_checkpoint_boundary_can_end_an_archive(self):
        chain = await self.aged_events(30, months_ago=8)
        await self.checkpoint(chain)
        await self.aged_events(10, months_ago=8, start=30)          # old but not yet checkpointed
        planned = await self.worker().plan(chain_id=chain, dry_run=True)
        self.assertEqual(planned[0].end_sequence, 30, "unsigned events must wait for their checkpoint")

    async def test_nothing_is_planned_without_checkpoints(self):
        chain = await self.aged_events(30, months_ago=8)
        self.assertEqual(await self.worker().plan(chain_id=chain), [])

    async def test_a_second_plan_does_not_duplicate_an_open_job(self):
        chain = await self.aged_events(30, months_ago=8)
        await self.checkpoint(chain)
        w = self.worker()
        self.assertEqual(len(await w.plan(chain_id=chain)), 1)
        self.assertEqual(await w.plan(chain_id=chain), [])
        self.assertEqual(len(await self.job_rows(chain)), 1)

    async def test_a_tenant_policy_can_extend_the_hot_window(self):
        chain = await self.aged_events(30, months_ago=8)
        await self.checkpoint(chain)
        async with db.transaction() as conn:
            for category in pol.CATEGORIES:
                await repo.set_policy(conn, tenant_id=str(self.tenant), category=category, hot_months=12, cold_years=None, allow_hot_cleanup=True,
                                      approved=False, actor="t", notes=None)
        self.assertEqual(await self.worker().plan(chain_id=chain), [], "8-month-old events are still hot under a 12-month policy")

    async def test_the_longest_category_window_governs_a_mixed_chain(self):
        chain = await self.aged_events(30, months_ago=8, modules=("policies", "claims"))
        await self.checkpoint(chain)
        async with db.transaction() as conn:
            await repo.set_policy(conn, tenant_id=str(self.tenant), category="claims", hot_months=24, cold_years=None, allow_hot_cleanup=True, approved=False, actor="t", notes=None)
        self.assertEqual(await self.worker().plan(chain_id=chain), [], "claims events must not leave hot storage before their own window ends")

    async def test_policies_are_versioned_never_edited(self):
        async with db.transaction() as conn:
            first = await repo.set_policy(conn, tenant_id=None, category="claims", hot_months=9, cold_years=7, allow_hot_cleanup=True, approved=True, actor="admin", notes="n")
            second = await repo.set_policy(conn, tenant_id=None, category="claims", hot_months=10, cold_years=7, allow_hot_cleanup=True, approved=True, actor="admin", notes="n")
        rows = await self.fetch("SELECT policy_id, superseded_at, hot_retention_months FROM retention_policies WHERE category = 'claims' AND tenant_id IS NULL ORDER BY created_at")
        self.assertEqual([r["hot_retention_months"] for r in rows][-2:], [9, 10])
        self.assertIsNotNone(rows[-2]["superseded_at"])
        self.assertIsNone(rows[-1]["superseded_at"])
        with self.assertRaises(Exception):
            async with db.transaction() as conn:
                await conn.execute(text("UPDATE retention_policies SET hot_retention_months = 1 WHERE policy_id = CAST(:p AS uuid)"), {"p": second["policy_id"]})

    def test_no_legal_period_is_hardcoded_and_defaults_keep_archives_indefinitely(self):
        resolved = pol.resolve([], 6)
        self.assertTrue(all(p.cold_retention_years is None and not p.approved for p in resolved.values()))
        self.assertIsNone(pol.retention_until(resolved, ["claims"], datetime.now(timezone.utc)))

    def test_modules_map_to_categories(self):
        self.assertEqual(pol.category_of("claims"), "claims")
        self.assertEqual(pol.category_of("policies"), "underwriting_policy")
        self.assertEqual(pol.category_of("administration"), "administration")
        self.assertEqual(pol.category_of("something_new"), "operational")


class ArchiveLifecycleTests(ArchiveCase):
    async def test_archiving_produces_a_cataloged_encrypted_signed_archive_and_leaves_hot_data_alone(self):
        chain, row = await self.archived_chain(60)
        self.assertEqual((row["start_sequence"], row["end_sequence"], row["event_count"], row["archive_number"]), (1, 60, 60, 1))
        self.assertEqual(await self.hot_count(chain), 60, "archiving must never remove anything from PostgreSQL")
        job = (await self.job_rows(chain))[0]
        self.assertEqual(job["state"], "ARCHIVED")
        self.assertEqual([h["state"] for h in job["history"]], ["ELIGIBLE", "VERIFYING", "EXPORTING", "UPLOADING", "VALIDATING", "ARCHIVED"])
        for key in ("data_key", "manifest_key", "signature_key", "checkpoints_key"):
            self.assertIn(row[key], self.store.objects)
        self.assertEqual(row["compression_algorithm"], "zstd")
        self.assertEqual(row["encryption_algorithm"], crypto.ALGORITHM)
        self.assertIsNotNone(row["lock_mode"], "Object Lock retention must be recorded on the stored archive")

    async def test_the_stored_object_is_compressed_and_does_not_contain_plaintext(self):
        chain, row = await self.archived_chain(80)
        blob = self.store.objects[row["data_key"]][-1]["data"]
        self.assertTrue(blob.startswith(crypto.MAGIC))
        for needle in (b"ENT-", b"policy.issued", b"tenant-service", b"Test Admin", self.tenant.hex.encode(), str(self.tenant).encode()):
            self.assertNotIn(needle, blob)
        self.assertLess(row["size_bytes"], row["uncompressed_bytes"], "zstd should shrink repetitive audit JSON")
        self.assertEqual(len(blob), row["size_bytes"])

    async def test_decrypting_the_archive_returns_exactly_the_ledger_events(self):
        chain, row = await self.archived_chain(45)
        path = self.tmp / "roundtrip.iaar"
        path.write_bytes(self.store.objects[row["data_key"]][-1]["data"])
        events = list(fmt.iter_events(path, self.keyring, str(row["archive_id"])))
        ledger = await self.fetch("SELECT * FROM events WHERE chain_id = :c ORDER BY sequence_number", c=chain)
        self.assertEqual([e["current_hash"] for e in events], [r["current_hash"] for r in ledger])
        self.assertEqual([e["event_id"] for e in events], [str(r["event_id"]) for r in ledger])
        self.assertEqual(events[0]["new_value"], ledger[0]["new_value"])

    async def test_the_manifest_is_signed_by_the_checkpoint_signer_and_stored_outside_postgres(self):
        chain, row = await self.archived_chain(30)
        envelope = json.loads((self.signer.checkpoints_dir / "archives" / self.env / str(self.tenant) / "archive-000001.json").read_text())
        self.assertIsNone(am.check_envelope(envelope))
        key = self.trusted
        self.assertEqual(envelope["manifest"]["signing_key_id"], key.key_id, "archives use the existing Stage 2 key, not a new one")
        self.assertTrue(am.verify_manifest(key.public_key, envelope["manifest"], envelope["signature"]))
        self.assertEqual(envelope["manifest_hash"], row["manifest_hash"])
        self.assertEqual(json.loads(self.store.objects[row["signature_key"]][-1]["data"]), envelope, "object storage holds the same signed manifest")

    async def test_a_manifest_signature_is_not_a_valid_checkpoint_signature(self):
        chain, row = await self.archived_chain(30)
        envelope = json.loads(self.store.objects[row["signature_key"]][-1]["data"])
        from shared.audit import checkpoint as cp
        self.assertFalse(cp.verify_message(self.trusted.public_key, cp.CHECKPOINT_DOMAIN + am.canonical_manifest(envelope["manifest"]), envelope["signature"]),
                         "domain separation: a manifest signature must never verify as a checkpoint signature")

    async def test_archives_end_on_checkpoint_boundaries_and_name_their_checkpoints(self):
        chain = await self.aged_events(40, months_ago=8)
        await self.checkpoint(chain)
        await self.aged_events(25, months_ago=8, start=40)
        await self.checkpoint(chain)
        _, outcomes = await self.archive_chain(chain)
        self.assertEqual(outcomes[0].status, "DONE")
        row = (await self.catalog(chain))[0]
        self.assertEqual(row["end_sequence"], 65)
        cov = row["covered_checkpoints"]
        self.assertEqual((cov["first_number"], cov["last_number"], cov["count"]), (1, 2, 2))
        last = (await self.fetch("SELECT last_event_hash, end_sequence FROM checkpoints WHERE chain_id = :c AND checkpoint_number = 2", c=chain))[0]
        self.assertEqual((last["end_sequence"], last["last_event_hash"]), (row["end_sequence"], row["last_event_hash"]))

    async def test_consecutive_archives_form_a_hash_linked_chain_without_gaps(self):
        chain = await self.aged_events(30, months_ago=9)
        await self.checkpoint(chain)
        w = self.worker()
        _, first = await self.archive_chain(chain, w)
        await self.aged_events(20, months_ago=8, start=30)
        await self.checkpoint(chain)
        _, second = await self.archive_chain(chain, w)
        self.assertEqual([o.status for o in first + second], ["DONE", "DONE"])
        a, b = await self.catalog(chain)
        self.assertEqual((b["archive_number"], b["start_sequence"], b["first_previous_hash"], b["previous_archive_hash"]),
                         (2, a["end_sequence"] + 1, a["last_event_hash"], a["manifest_hash"]))
        # the database itself refuses a catalog entry that skips or forks
        with self.assertRaises(Exception):
            async with self.privileged() as conn:
                await conn.execute(text("INSERT INTO archive_catalog (archive_id, job_id, chain_id, environment_id, archive_number, archive_version, start_sequence, end_sequence, event_count,"
                                        " first_previous_hash, last_event_hash, previous_archive_hash, manifest_hash, archive_checksum, size_bytes, uncompressed_bytes, compression_algorithm,"
                                        " encryption_algorithm, kek_id, object_prefix, data_key, manifest_key, signature_key, checkpoints_key, covered_checkpoints, first_occurred_at, last_occurred_at,"
                                        " first_recorded_at, last_recorded_at, modules, actions, entity_types, bloom, bloom_bits, bloom_hashes) SELECT gen_random_uuid(), job_id, chain_id,"
                                        " environment_id, 5, 1, 99, 100, 2, first_previous_hash, last_event_hash, previous_archive_hash, manifest_hash, archive_checksum, 1, 1, 'zstd', 'x', 'k',"
                                        " 'p', 'd', 'm', 's', 'c', '{}', now(), now(), now(), now(), '{}', '{}', '{}', ''::bytea, 8, 1 FROM archive_catalog WHERE archive_id = :a"), {"a": a["archive_id"]})

    async def test_the_hash_chain_and_anchored_verification_survive_archiving(self):
        chain, row = await self.archived_chain(50)
        self.assertEqual((await chain_verifier.verify_chain(chain)).status, chain_verifier.VALID)
        r = await iv.verify_anchored(chain, storage=TrustedStorage(str(self.signer.checkpoints_dir)))
        self.assertIn(r.state, (sv.VERIFIED, sv.UNSIGNED_EVENTS_PENDING), [f.to_api() for f in r.findings])
        self.assertEqual(r.archives_checked, 1)

    async def test_catalog_metadata_supports_search(self):
        chain, row = await self.archived_chain(50)
        self.assertEqual(row["modules"], ["policies"])
        self.assertEqual(row["actions"], ["policy.issued"])
        bloom = fmt.Bloom(chain, row["bloom_bits"], row["bloom_hashes"], bytes(row["bloom"]))
        self.assertTrue(bloom.might_contain("entity", "ENT-3") and bloom.might_contain("case", "CASE-4") and bloom.might_contain("actor", "user-2"))
        self.assertFalse(bloom.might_contain("entity", "NOT-A-REAL-ENTITY-" + uuid4().hex))
        async with db.engine().connect() as conn:
            rows, total = await repo.search_catalog(conn, tenant_id=str(self.tenant), unrestricted=False, module="policies")
            none, zero = await repo.search_catalog(conn, tenant_id=str(self.tenant), unrestricted=False, module="claims")
        self.assertEqual((total, zero), (1, 0))

    async def test_the_catalog_and_jobs_are_append_only(self):
        chain, row = await self.archived_chain(20)
        for sql in ("DELETE FROM archive_catalog", "UPDATE archive_catalog SET event_count = 1", "DELETE FROM archive_jobs", "UPDATE archive_jobs SET end_sequence = 1",
                    "TRUNCATE archive_catalog"):
            with self.assertRaises(Exception, msg=sql):
                async with db.transaction() as conn:
                    await conn.execute(text(sql))
        async with db.transaction() as conn:       # the one allowed change, once
            self.assertTrue(await repo.approve_cleanup(conn, str(row["archive_id"])))
            self.assertFalse(await repo.approve_cleanup(conn, str(row["archive_id"])))

    async def test_job_state_cannot_skip_or_go_backwards(self):
        chain, row = await self.archived_chain(20)
        job = (await self.job_rows(chain))[0]
        for target in ("EXPORTING", "ELIGIBLE", "HOT_CLEANUP_COMPLETED"):
            with self.assertRaises(Exception, msg=target):
                async with db.transaction() as conn:
                    await conn.execute(text("UPDATE archive_jobs SET state = :s WHERE job_id = :j"), {"s": target, "j": job["job_id"]})

    async def test_a_chain_verified_after_partial_archive_boundary_reports_the_archived_prefix_only_when_events_are_gone(self):
        chain, row = await self.archived_chain(20)
        result = await chain_verifier.verify_chain(chain)
        self.assertNotIn("archived_prefix", result.details, "all events are still hot, so the whole chain is checked from genesis")
        self.assertEqual(result.from_sequence, 1)
