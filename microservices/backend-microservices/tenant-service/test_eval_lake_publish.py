"""Evaluation data lake against a disposable PostgreSQL database (the object store is the in-memory twin):
Bronze ingest -> Silver promotion -> review -> Gold publication, immutability, integrity checks, recovery.

Run: docker compose exec -T tenant-service python test_eval_lake_publish.py
"""
import os
os.environ["DISABLE_PGVECTOR"] = "true"
import asyncio
import json
import sys
import unittest
from datetime import datetime, timedelta
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

from eval_test_cases import jsonl_bytes, make_case, many
from shared.evaluation.canonical import content_hash, sha256_hex
from shared.evaluation.config import LakeSettings
from shared.evaluation.ddl import EVAL_IMMUTABILITY_DDL
from shared.evaluation.formats import parse_cases
from shared.evaluation.lake import DataLake, LakeValidationError, PublishConflict
from shared.evaluation.object_store import InMemoryObjectStore, IntegrityFailure, LakeError, ObjectLocked
from shared.models.core import Role, User
from shared.models.evaluation import (EvalCase, EvalDataset, EvalDatasetVersion, EvalFixture, EvalIngestion, EvalStorageObject,
                                      EvalVersionCase)

DB = "tenant_evallake_test_" + uuid4().hex[:10]
ADMIN = f"postgresql+asyncpg://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}@host.docker.internal:5432"
factory = None
APPROVAL = {"approved_by": "ayla@example.com", "note": "reviewed"}


class LakeFlow(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.settings = LakeSettings(backend="memory", retention_mode="GOVERNANCE", retention_days=30, publish_stale_minutes=15)
        self.store = InMemoryObjectStore(self.settings)
        self.lake = DataLake(self.store, self.settings, lambda: factory())
        async with factory() as s:
            role = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first() or Role(name="SuperAdmin", description="")
            s.add(role)
            await s.flush()
            self.user = User(tenant_id=None, role_id=role.id, email=f"{uuid4()}@x.test", username=uuid4().hex,
                             hashed_password="x", full_name="Ayla Reviewer")
            s.add(self.user)
            await s.commit()
            self.user_id = self.user.id
            self.dataset = await self.lake.create_dataset(s, slug="ind-" + uuid4().hex[:10], name="Individual single turn",
                                                          workflow="individual-insurance", turn_mode="single_turn", created_by=self.user_id)
            self.dataset_id, self.slug = self.dataset.id, self.dataset.slug

    # ── helpers ──
    async def load_cases(self, cases, *, approve=True, promote=True):
        async with factory() as s:
            ds = await s.get(EvalDataset, self.dataset_id)
            res = await self.lake.ingest_bronze(s, ds, data=jsonl_bytes(*cases), filename="cases.jsonl", created_by=self.user_id)
            if promote:
                await self.lake.promote_to_silver(s, ds, ingestion_id=res.ingestion_id)
            if approve and promote:
                for row in (await s.exec(select(EvalCase).where(EvalCase.dataset_id == ds.id, EvalCase.tier == "silver",
                                                                EvalCase.status == "draft"))).all():
                    await self.lake.transition_case(s, row, "in_review", actor=self.user_id)
                    await self.lake.transition_case(s, row, "approved", actor=self.user_id, note="ok")
            return res

    async def publish(self, version="1.0.0", **kw):
        return await self.lake.publish(self.dataset_id, version, approval=APPROVAL, published_by=self.user_id, **kw)

    async def version_row(self, version):
        async with factory() as s:
            return (await s.exec(select(EvalDatasetVersion).where(EvalDatasetVersion.dataset_id == self.dataset_id,
                                                                  EvalDatasetVersion.version == version).order_by(EvalDatasetVersion.started_at.desc()))).first()

    # ── Bronze ──
    async def test_ingest_keeps_the_raw_file_and_files_each_record(self):
        good = [make_case("IND-TST-001"), make_case("IND-TST-002")]
        data = jsonl_bytes(*good) + b"this is not json\n" + jsonl_bytes(make_case("IND-TST-002"), {"title": "no id at all"}, {"case_id": "x"})
        async with factory() as s:
            ds = await s.get(EvalDataset, self.dataset_id)
            res = await self.lake.ingest_bronze(s, ds, data=data, filename="batch 1.jsonl", source_ref="unit test")
            self.assertEqual((res.created, res.updated), (3, 0))                 # two good + the one without an id (given CAND-...)
            self.assertEqual(res.rejected, 3)                                    # bad JSON line, repeated id, invalid id "x"
            self.assertEqual(self.store.get(res.raw_key), data)                  # stored exactly as received
            self.assertEqual(self.store.head(res.raw_key).sha256, sha256_hex(data))
            ing = await s.get(EvalIngestion, res.ingestion_id)
            self.assertEqual((ing.sha256, ing.record_count, ing.stored_count, ing.rejected_count), (sha256_hex(data), 6, 3, 3))
            rows = (await s.exec(select(EvalCase).where(EvalCase.dataset_id == ds.id))).all()
            self.assertEqual({r.tier for r in rows}, {"bronze"})
            self.assertTrue(any(r.case_key.startswith("CAND-") for r in rows))
            registry = (await s.exec(select(EvalStorageObject).where(EvalStorageObject.ingestion_id == res.ingestion_id))).all()
            self.assertEqual({o.kind for o in registry}, {"raw", "report"})
            report = json.loads(self.store.get(next(o.object_key for o in registry if o.kind == "report")))
            self.assertEqual(len(report["rejected"]), 3)

    async def test_ingest_refuses_empty_oversized_and_unknown_files(self):
        async with factory() as s:
            ds = await s.get(EvalDataset, self.dataset_id)
            for kwargs in (dict(data=b"", filename="a.jsonl"), dict(data=b"{}", filename="a.xml"), dict(data=b"{}", filename="a.jsonl", source_type="weird")):
                with self.assertRaises(LakeValidationError):
                    await self.lake.ingest_bronze(s, ds, **kwargs)

    async def test_nul_characters_are_rejected_not_allowed_to_break_the_batch(self):
        nul = make_case("IND-TST-003", input={"messages": [{"role": "user", "content": "a\u0000b"}]})
        res = await self.load_cases([make_case("IND-TST-004"), nul], promote=False)
        self.assertEqual((res.created, res.rejected), (1, 1))
        self.assertIn("NUL", res.rejects[0]["error"])

    async def test_reingesting_a_case_id_is_a_new_revision_back_in_draft(self):
        await self.load_cases([make_case("IND-TST-010")])
        await self.load_cases([make_case("IND-TST-010", title="Premium question, reworded")], promote=False)
        async with factory() as s:
            row = (await s.exec(select(EvalCase).where(EvalCase.case_key == "IND-TST-010", EvalCase.dataset_id == self.dataset_id))).one()
            self.assertEqual((row.revision, row.tier, row.status, row.approved_by), (2, "bronze", "draft", None))
            self.assertEqual(row.content["title"], "Premium question, reworded")

    # ── Silver ──
    async def test_promotion_validates_cleans_and_deduplicates(self):
        broken = make_case("IND-TST-020", category="made-up")
        first = make_case("IND-TST-021", message="the same question")
        repeat = make_case("IND-TST-022", message="The  same question", tags=["Z", "a"])
        res = await self.load_cases([broken, first, repeat], approve=False, promote=False)
        async with factory() as s:
            ds = await s.get(EvalDataset, self.dataset_id)
            report = await self.lake.promote_to_silver(s, ds, ingestion_id=res.ingestion_id)
            self.assertEqual((report.accepted, report.rejected, report.duplicates), (1, 2, 1))
            self.assertEqual((await s.get(EvalIngestion, res.ingestion_id)).status, "promoted")
        async with factory() as s:                                    # read back in a new session: what the database really holds
            rows = {r.case_key: r for r in (await s.exec(select(EvalCase).where(EvalCase.dataset_id == self.dataset_id))).all()}
            self.assertEqual(rows["IND-TST-020"].tier, "bronze")
            self.assertIn("category", rows["IND-TST-020"].validation_errors[0]["msg"])
            self.assertEqual(rows["IND-TST-021"].tier, "silver")                       # the first one with that input wins
            self.assertEqual(rows["IND-TST-022"].tier, "bronze")
            self.assertEqual(rows["IND-TST-022"].validation_errors[0]["type"], "duplicate")
            silver = rows["IND-TST-021"]
            self.assertEqual(silver.content_sha256, content_hash(silver.content))      # the JSONB round trip keeps the checksum
            self.assertIsNotNone(silver.dedupe_key)
            self.assertEqual(silver.category, "premium-payment")
        artifacts = [o.key for o in self.store.list("silver/")]
        self.assertEqual(sorted(k.rsplit("/", 1)[1] for k in artifacts), ["cases.jsonl", "rejects.json", "report.json"])
        self.assertEqual(len(parse_cases(self.store.get(next(k for k in artifacts if k.endswith("cases.jsonl"))), "jsonl").records), 1)

    async def test_review_rules(self):
        res = await self.load_cases([make_case("IND-TST-030")], approve=False, promote=False)
        async with factory() as s:
            row = (await s.exec(select(EvalCase).where(EvalCase.case_key == "IND-TST-030"))).one()
            with self.assertRaises(LakeValidationError):
                await self.lake.transition_case(s, row, "in_review", actor=self.user_id)       # still Bronze
            await self.lake.promote_to_silver(s, await s.get(EvalDataset, self.dataset_id), ingestion_id=res.ingestion_id)
            row = (await s.exec(select(EvalCase).where(EvalCase.case_key == "IND-TST-030"))).one()
            with self.assertRaises(LakeValidationError):
                await self.lake.transition_case(s, row, "approved", actor=self.user_id)        # must be reviewed first
            await self.lake.transition_case(s, row, "in_review", actor=self.user_id)
            with self.assertRaises(LakeValidationError):
                await self.lake.transition_case(s, row, "approved", actor=None)                # an approval names its approver
            await self.lake.transition_case(s, row, "approved", actor=self.user_id, note="fine")
            self.assertEqual((row.status, row.approved_by, row.approval_note), ("approved", self.user_id, "fine"))
            await self.lake.edit_case(s, row, {**row.content, "title": "Edited after approval"}, actor=self.user_id)
            self.assertEqual((row.tier, row.status, row.approved_by, row.revision), ("bronze", "draft", None, 2))

    # ── Gold ──
    async def test_publish_creates_a_verified_immutable_snapshot(self):
        await self.load_cases(many(3))
        v = await self.publish("1.0.0", change_summary="first release")
        self.assertEqual((v.state, v.case_count, v.parent_version), ("published", 3, None))
        self.assertTrue(v.snapshot_key.endswith(f"/{self.slug}/1.0.0/cases.jsonl"))
        for key, sha in ((v.snapshot_key, v.snapshot_sha256), (v.manifest_key, v.manifest_sha256)):
            info = self.store.head(key)
            self.assertEqual(info.sha256, sha)
            self.assertTrue(info.locked)                                                        # object lock applied
            with self.assertRaises(ObjectLocked):
                self.store.delete(key)
        loaded = await self.lake.load_version(v)
        self.assertEqual([c["case_id"] for c in loaded.cases], ["IND-TST-001", "IND-TST-002", "IND-TST-003"])
        self.assertEqual(loaded.cases[0]["approval"]["status"], "approved")
        self.assertEqual(loaded.cases[0]["approval"]["approved_by"], str(self.user_id))
        m = loaded.manifest
        self.assertEqual((m["version"], m["dataset"]["slug"], m["stats"]["case_count"], m["approval"]["approved_by"]),
                         ("1.0.0", self.slug, 3, "ayla@example.com"))
        self.assertEqual(m["files"][0]["sha256"], v.snapshot_sha256)
        async with factory() as s:
            self.assertEqual((await s.get(EvalDataset, self.dataset_id)).latest_version, "1.0.0")
            index = (await s.exec(select(EvalVersionCase).where(EvalVersionCase.version_id == v.id).order_by(EvalVersionCase.line_no))).all()
            self.assertEqual([(i.case_key, i.line_no) for i in index], [("IND-TST-001", 1), ("IND-TST-002", 2), ("IND-TST-003", 3)])
            objs = (await s.exec(select(EvalStorageObject).where(EvalStorageObject.version_id == v.id))).all()
            self.assertEqual({o.state for o in objs}, {"verified"})
            case = (await s.exec(select(EvalCase).where(EvalCase.case_key == "IND-TST-001", EvalCase.dataset_id == self.dataset_id))).one()
            self.assertEqual((case.last_published_version, case.last_published_revision), ("1.0.0", 1))
        report = await self.lake.verify_version(v)
        self.assertTrue(report.ok, report.problems)

    async def test_the_database_itself_refuses_to_change_a_published_version(self):
        await self.load_cases(many(1))
        v = await self.publish()
        statements = [
            ("UPDATE eval_dataset_versions SET case_count = 99 WHERE id = :id", "immutable"),
            ("UPDATE eval_dataset_versions SET state = 'failed' WHERE id = :id", "immutable"),
            ("DELETE FROM eval_dataset_versions WHERE id = :id", "immutable"),
            ("UPDATE eval_version_cases SET revision = 9 WHERE version_id = :id", "immutable"),
            ("DELETE FROM eval_version_cases WHERE version_id = :id", "immutable"),
            ("INSERT INTO eval_version_cases (id, version_id, case_key, revision, content_sha256, line_no) "
             "VALUES (gen_random_uuid(), :id, 'IND-TST-999', 1, 'x', 9)", "immutable"),
        ]
        for sql, expected in statements:
            async with factory() as s:
                with self.assertRaises(Exception) as ctx:
                    await s.execute(text(sql), {"id": v.id})
                    await s.commit()
                self.assertIn(expected, str(ctx.exception), sql)
        self.assertEqual((await self.version_row("1.0.0")).case_count, 1)

    async def test_versions_only_go_up_and_history_is_kept(self):
        await self.load_cases(many(2))
        first = await self.publish("1.0.0")
        with self.assertRaises(PublishConflict):
            await self.publish("1.0.0")                                                         # a published version is final
        with self.assertRaises(LakeValidationError):
            await self.publish("0.9.0")
        await self.load_cases([make_case("IND-TST-100")])
        second = await self.publish("1.1.0")
        self.assertEqual((second.parent_version, second.case_count), ("1.0.0", 3))
        old = await self.lake.load_version(await self.version_row("1.0.0"))
        self.assertEqual(len(old.cases), 2)
        self.assertEqual(self.store.head(first.snapshot_key).sha256, first.snapshot_sha256)     # untouched by the second release
        with self.assertRaises(LakeValidationError):
            await self.lake.publish(self.dataset_id, "1.2", approval=APPROVAL)

    async def test_only_approved_cases_are_published(self):
        await self.load_cases([make_case("IND-TST-110")], approve=True)
        await self.load_cases([make_case("IND-TST-111")], approve=False)                         # validated but not approved
        v = await self.publish()
        self.assertEqual([c["case_id"] for c in (await self.lake.load_version(v)).cases], ["IND-TST-110"])
        with self.assertRaises(LakeValidationError) as ctx:
            await self.publish("1.1.0", case_keys=["IND-TST-111"])
        self.assertIn("IND-TST-111", str(ctx.exception))

    async def test_nothing_to_publish_and_missing_approver_are_refused(self):
        with self.assertRaises(LakeValidationError):
            await self.publish()
        await self.load_cases(many(1))
        with self.assertRaises(LakeValidationError):
            await self.lake.publish(self.dataset_id, "1.0.0", approval={})
        self.assertIsNone(await self.version_row("1.0.0"))

    async def test_a_case_changed_behind_the_lakes_back_blocks_publication(self):
        await self.load_cases(many(1))
        async with factory() as s:
            await s.execute(text("UPDATE eval_cases SET content = jsonb_set(content, '{title}', CAST('\"Sneaky edit\"' AS jsonb)) "
                                 "WHERE case_key = 'IND-TST-001' AND dataset_id = :d"), {"d": self.dataset_id})
            await s.commit()
        with self.assertRaises(LakeValidationError) as ctx:
            await self.publish()
        self.assertIn("checksum", str(ctx.exception))

    async def test_fixtures_are_required_pinned_and_locked(self):
        case = make_case("IND-TST-120", input={"messages": [{"role": "user", "content": "check my file"}], "fixture_refs": ["applicant-clean"]})
        await self.load_cases([case])
        with self.assertRaises(LakeValidationError) as ctx:
            await self.publish()
        self.assertIn("applicant-clean", str(ctx.exception))
        original = json.dumps({"name": "Test Applicant", "cnic": "35202-0000000-0"}).encode()
        async with factory() as s:
            ds = await s.get(EvalDataset, self.dataset_id)
            await self.lake.put_fixture(s, ds, fixture_key="applicant-clean", data=original, filename="applicant.json", kind="applicant")
        v = await self.publish()
        entry = (await self.lake.load_version(v)).manifest["fixtures"][0]
        self.assertEqual((entry["fixture_key"], entry["sha256"]), ("applicant-clean", sha256_hex(original)))
        self.assertTrue(self.store.head(entry["object_key"]).locked)
        async with factory() as s:                                                              # the fixture is later changed...
            ds = await s.get(EvalDataset, self.dataset_id)
            await self.lake.put_fixture(s, ds, fixture_key="applicant-clean", data=b'{"name": "Changed"}', filename="applicant.json")
            current = (await s.exec(select(EvalFixture).where(EvalFixture.fixture_key == "applicant-clean"))).one()
            self.assertNotEqual(current.sha256, entry["sha256"])
        self.assertEqual(await self.lake.read_fixture(entry), original)                         # ...the published version still has the old one
        self.assertTrue((await self.lake.verify_version(v, deep=True)).ok)

    async def test_tampering_with_stored_objects_is_detected(self):
        await self.load_cases(many(2))
        v = await self.publish()
        self.store._tamper(v.snapshot_key, self.store.get(v.snapshot_key).replace(b"premium", b"PREMIUM"))
        with self.assertRaises(IntegrityFailure):
            await self.lake.load_version(v)
        report = await self.lake.verify_version(v)
        self.assertFalse(report.ok)
        self.assertIn("snapshot", report.problems[0])
        async with factory() as s:
            states = {o.state for o in (await s.exec(select(EvalStorageObject).where(EvalStorageObject.version_id == v.id))).all()}
            self.assertEqual(states, {"corrupt"})

    async def test_export_round_trips_in_every_format(self):
        await self.load_cases(many(2))
        v = await self.publish()
        loaded = await self.lake.load_version(v)
        for fmt in ("jsonl", "json", "csv"):
            parsed = parse_cases(await self.lake.export_version(v, fmt), fmt)
            self.assertEqual(parsed.rejects, [])
            self.assertEqual(parsed.records, loaded.cases, fmt)

    # ── failure and recovery ──
    async def test_a_failed_upload_is_cleaned_up_and_the_same_version_can_be_retried(self):
        await self.load_cases(many(2))
        self.store.fail_put = lambda key: key.endswith("manifest.json")
        with self.assertRaises(LakeError):
            await self.publish()
        failed = await self.version_row("1.0.0")
        self.assertEqual(failed.state, "failed")
        self.assertIn("simulated upload failure", failed.failure_reason)
        self.assertEqual(self.store.list("gold/"), [])                                          # nothing half-published is left
        async with factory() as s:
            self.assertIsNone((await s.get(EvalDataset, self.dataset_id)).latest_version)
            self.assertEqual((await s.exec(select(EvalVersionCase).where(EvalVersionCase.version_id == failed.id))).all(), [])
        self.store.fail_put = None
        again = await self.publish()
        self.assertEqual((again.state, again.version), ("published", "1.0.0"))
        self.assertNotEqual(again.id, failed.id)
        self.assertTrue((await self.lake.verify_version(again)).ok)

    async def test_a_crash_after_the_upload_is_completed_by_reconcile(self):
        await self.load_cases(many(2))

        async def database_down(plan):
            raise RuntimeError("database went away")
        real_commit, self.lake._commit = self.lake._commit, database_down
        with self.assertRaises(RuntimeError):
            await self.publish()
        self.lake._commit = real_commit
        stuck = await self.version_row("1.0.0")
        self.assertEqual(stuck.state, "publishing")                                             # the good snapshot was kept, not discarded
        self.assertTrue(self.store.head(stuck.manifest_key).locked)
        self.assertEqual((await self.lake.reconcile()).finalized, [])                           # too recent to be called interrupted
        await self.age(stuck.id)
        report = await self.lake.reconcile()
        self.assertEqual(report.finalized, [f"{self.dataset_id}:1.0.0"])
        done = await self.version_row("1.0.0")
        self.assertEqual(done.state, "published")
        self.assertEqual(len((await self.lake.load_version(done)).cases), 2)
        async with factory() as s:
            self.assertEqual((await s.get(EvalDataset, self.dataset_id)).latest_version, "1.0.0")
            self.assertEqual(len((await s.exec(select(EvalVersionCase).where(EvalVersionCase.version_id == done.id))).all()), 2)

    async def test_an_interrupted_publication_with_no_objects_is_failed_by_reconcile(self):
        await self.load_cases(many(1))
        plan = await self.lake._prepare(self.dataset_id, "1.0.0", {"approved_by": "x"}, self.user_id, None, None)
        with self.assertRaises(PublishConflict):
            await self.publish("1.1.0")                                                         # one publication at a time
        await self.age(plan.version_id)
        report = await self.lake.reconcile()
        self.assertEqual(report.failed, [f"{self.dataset_id}:1.0.0"])
        self.assertEqual((await self.version_row("1.0.0")).state, "failed")
        self.assertEqual((await self.publish()).state, "published")                             # and the version number is free again

    async def age(self, version_id):
        async with factory() as s:
            await s.execute(text("UPDATE eval_dataset_versions SET started_at = :t WHERE id = :id"),
                            {"t": datetime.utcnow() - timedelta(hours=2), "id": version_id})
            await s.commit()


if __name__ == "__main__":
    async def create():
        engine = create_async_engine(f"{ADMIN}/postgres", isolation_level="AUTOCOMMIT")
        async with engine.connect() as c:
            await c.execute(text(f'CREATE DATABASE "{DB}"'))
        await engine.dispose()
        target = create_async_engine(f"{ADMIN}/{DB}", poolclass=NullPool)
        async with target.begin() as c:
            await c.run_sync(SQLModel.metadata.create_all)
            for _label, sql in EVAL_IMMUTABILITY_DDL:          # the triggers migrate.py installs
                await c.execute(text(sql))
        return target

    async def drop(target):
        await target.dispose()
        engine = create_async_engine(f"{ADMIN}/postgres", isolation_level="AUTOCOMMIT")
        async with engine.connect() as c:
            await c.execute(text(f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'))
        await engine.dispose()

    target = asyncio.run(create())
    factory = async_sessionmaker(target, class_=AsyncSession, expire_on_commit=False)
    try:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(LakeFlow))
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
