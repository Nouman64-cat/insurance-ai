"""Integration against the REAL MinIO of the compose stack (writer and reader identities, versioning, Object Lock, private bucket).
Skipped when MinIO or its credentials are not reachable. Objects are written under this test database's own environment id, with a
1-day GOVERNANCE lock; the writer identity cannot delete them (that is the point), so clean up with the MinIO root account."""
import os
import unittest

from app.archive.store import S3Store, StoreError
from app.config import settings
from tests.archive_support import ArchiveCase, override_settings
from app.checkpoints.storage import TrustedStorage
from app.archive.worker import ArchiveWorker


def minio_ready() -> bool:
    try:
        return bool(settings.writer_key) and S3Store(settings, "writer").capabilities().get("reachable") is True
    except Exception:
        return False


@unittest.skipUnless(minio_ready(), "MinIO is not reachable with the writer credentials")
class RealMinioTests(ArchiveCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.writer, self.reader = S3Store(settings, "writer"), S3Store(settings, "reader")
        self._o = override_settings(lock_days=1)
        self._o.__enter__()

    async def asyncTearDown(self):
        self._o.__exit__(None, None, None)
        await super().asyncTearDown()

    def real_worker(self):
        return ArchiveWorker(self.signer.client, self.writer, self.reader, self.keyring, "w", clock=self.clock, config=settings,
                             storage=TrustedStorage(str(self.signer.checkpoints_dir)), work_dir=self.work)

    async def test_bucket_is_private_versioned_and_object_locked(self):
        caps = self.writer.capabilities()
        self.assertEqual((caps["versioning"], caps["object_lock"], caps["private"]), (True, True, True))

    async def test_full_archive_cycle_on_real_storage_with_lock_and_verification(self):
        chain = await self.aged_events(120)
        await self.checkpoint(chain)
        w = self.real_worker()
        _, outcomes = await self.archive_chain(chain, w)
        self.assertEqual([o.status for o in outcomes], ["DONE"], outcomes)
        row = (await self.catalog(chain))[0]
        info = self.reader.head(row["data_key"], row["data_version_id"])
        self.assertEqual(info.size, row["size_bytes"])
        self.assertEqual(info.lock_mode, "GOVERNANCE")
        self.assertIsNotNone(info.retain_until)
        self.assertEqual(row["lock_mode"], "GOVERNANCE")
        deep = await w.verifier.verify(dict(row), deep=True, env=self.env)
        self.assertEqual(deep.state, "VERIFIED", [f.to_api() for f in deep.findings])
        # a second upload to the same key creates a new VERSION; the catalogued version stays readable and verifiable
        self.writer.put_bytes(row["data_key"], b"overwritten", sha256="0" * 64)
        self.assertEqual(self.reader.head(row["data_key"], row["data_version_id"]).size, row["size_bytes"])
        replaced = await w.verifier.verify(dict(row, data_version_id=None), deep=False, env=self.env)
        self.assertIn("ARCHIVE_CHECKSUM_MISMATCH", {f.code for f in replaced.findings}, "the latest version was replaced and that is detected")

    async def test_the_reader_identity_cannot_write_and_the_writer_cannot_delete(self):
        with self.assertRaises(StoreError) as ctx:
            self.reader.put_bytes("v1/readers-cannot-write.txt", b"x", sha256="0" * 64)
        self.assertEqual(ctx.exception.code, "STORE_ACCESS_DENIED")
        self.writer.put_bytes(f"v1/{self.env}/probe.txt", b"x", sha256="0" * 64)
        with self.assertRaises(Exception):
            self.writer._client.delete_object(Bucket=settings.archive_bucket, Key=f"v1/{self.env}/probe.txt", VersionId=self.writer.head(f"v1/{self.env}/probe.txt").version_id)

    async def test_wrong_credentials_are_denied_not_retried_forever(self):
        bad = S3Store(settings.__class__(), "writer", client=None) if False else None
        from dataclasses import replace
        bad_cfg = replace(settings, writer_secret="wrong-secret-0123456789")
        with self.assertRaises(StoreError) as ctx:
            S3Store(bad_cfg, "writer").put_bytes("v1/x.txt", b"x", sha256="0" * 64)
        self.assertFalse(ctx.exception.retryable)
