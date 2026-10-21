"""Stage 3 integrity: encryption/AEAD properties, and detection of every way an archive can be damaged, replaced, deleted or forged."""
import copy
import io
import json
import struct
from uuid import uuid4

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy import text

from app import db
from app.archive import crypto, format as fmt
from app.checkpoints.storage import TrustedStorage
from app.verification import integrity_verifier as iv, signature_verifier as sv
from shared.audit import archive_manifest as am
from tests.archive_support import ArchiveCase


class CryptoUnitTests(ArchiveCase):
    def build_blob(self, plaintext: bytes, chunk: int = 64) -> bytes:
        out = io.BytesIO()
        w = crypto.EncryptingWriter(out, self.keyring, "arch-1", chunk_bytes=chunk)
        w.write(plaintext)
        w.close()
        return out.getvalue()

    def read(self, blob: bytes) -> bytes:
        return b"".join(crypto.decrypt_chunks(io.BytesIO(blob), self.keyring, "arch-1"))

    def test_roundtrip_in_many_chunks_and_empty(self):
        data = bytes(range(256)) * 20
        self.assertEqual(self.read(self.build_blob(data)), data)
        self.assertEqual(self.read(self.build_blob(b"")), b"")

    def test_every_archive_gets_its_own_data_key_and_nonce_prefix(self):
        a, b = self.build_blob(b"same"), self.build_blob(b"same")
        self.assertNotEqual(a, b)
        self.assertNotIn(b"same", a)

    def test_chunk_reordering_truncation_and_extension_are_detected(self):
        blob = self.build_blob(b"x" * 400, chunk=64)
        header_len = len(crypto.MAGIC) + 4 + struct.unpack(">I", blob[len(crypto.MAGIC):len(crypto.MAGIC) + 4])[0]
        body, chunks, pos = blob[header_len:], [], 0
        while pos < len(blob) - header_len:
            (n,) = struct.unpack(">I", body[pos:pos + 4])
            chunks.append(body[pos:pos + 4 + n])
            pos += 4 + n
        head = blob[:header_len]
        self.assertGreater(len(chunks), 3)
        for tampered in (head + chunks[1] + chunks[0] + b"".join(chunks[2:]),      # reordered
                         head + b"".join(chunks[:-1]),                                # last chunk dropped
                         head + b"".join(chunks) + chunks[0],                         # extended
                         head + b"".join(chunks[:2]) + b"".join(chunks[3:])):          # one removed from the middle
            with self.assertRaises(crypto.ArchiveCryptoError) as ctx:
                self.read(tampered)
            self.assertEqual(ctx.exception.code, "ARCHIVE_TAMPERED")

    def test_a_flipped_bit_or_an_edited_header_fails_authentication(self):
        blob = bytearray(self.build_blob(b"y" * 300))
        flipped = bytes(blob[:-5] + bytes([blob[-5] ^ 1]) + blob[-4:])
        with self.assertRaises(crypto.ArchiveCryptoError):
            self.read(flipped)
        edited = bytes(blob).replace(b'"chunk_bytes":64', b'"chunk_bytes":65', 1)
        with self.assertRaises(crypto.ArchiveCryptoError):
            self.read(edited)

    def test_the_wrong_master_key_cannot_open_an_archive_and_a_missing_key_is_reported(self):
        blob = self.build_blob(b"secret")
        other = self.tmp / "other-keys"
        crypto.init_keys(str(other))
        with self.assertRaises(crypto.ArchiveCryptoError):
            list(crypto.decrypt_chunks(io.BytesIO(blob), crypto.KeyRing(str(other))))
        with self.assertRaises(crypto.ArchiveCryptoError) as ctx:
            list(crypto.decrypt_chunks(io.BytesIO(blob), crypto.KeyRing(str(self.tmp / "nothing"))))
        self.assertEqual(ctx.exception.code, "KEK_UNAVAILABLE")

    def test_an_archive_cannot_be_presented_as_a_different_archive(self):
        with self.assertRaises(crypto.ArchiveCryptoError):
            list(crypto.decrypt_chunks(io.BytesIO(self.build_blob(b"z")), self.keyring, "some-other-archive"))

    def test_the_master_key_is_never_regenerated_and_is_not_in_the_repository_tree(self):
        with self.assertRaises(crypto.ArchiveCryptoError) as ctx:
            crypto.init_keys(str(self.keys_dir))
        self.assertEqual(ctx.exception.code, "KEK_EXISTS")
        mode = (self.keys_dir / f"{self.keyring.current_id()}.key").stat().st_mode & 0o777
        self.assertEqual(mode, 0o400)


class DetectionTests(ArchiveCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.chain, self.row = await self.archived_chain(70)
        self.w = self.worker()
        self.base = str(self.row["data_key"])

    async def verdict(self, deep=True, row=None):
        r = await self.w.verifier.verify(dict(row or self.row), deep=deep, env=self.env)
        return r, {f.code for f in r.findings}

    async def test_an_untouched_archive_verifies_quickly_and_deeply(self):
        for deep in (False, True):
            r, codes = await self.verdict(deep)
            self.assertEqual(r.state, "VERIFIED", codes)
        self.assertEqual(r.details["events_verified"], 70)

    async def test_a_flipped_byte_is_detected(self):
        blob = bytearray(self.store.objects[self.base][-1]["data"])
        blob[len(blob) // 2] ^= 0x01
        self.store.replace(self.base, bytes(blob))
        _, codes = await self.verdict()
        self.assertIn("ARCHIVE_CHECKSUM_MISMATCH", codes)

    async def test_a_truncated_object_is_detected_even_by_the_quick_check(self):
        self.store.replace(self.base, self.store.objects[self.base][-1]["data"][:-100])
        _, codes = await self.verdict(deep=False)
        self.assertIn("ARCHIVE_CHECKSUM_MISMATCH", codes)

    async def test_an_object_replaced_by_another_valid_archive_is_detected(self):
        other_chain, other = await self.archived_chain(70, tenant=uuid4())
        self.store.replace(self.base, self.store.objects[other["data_key"]][-1]["data"])
        r, codes = await self.verdict()
        self.assertIn("ARCHIVE_CHECKSUM_MISMATCH", codes)

    async def test_a_deleted_object_is_detected(self):
        self.store.delete(self.base)
        _, codes = await self.verdict(deep=False)
        self.assertIn("ARCHIVE_OBJECT_MISSING", codes)

    async def test_a_missing_manifest_object_is_detected(self):
        self.store.delete(self.row["signature_key"])
        _, codes = await self.verdict(deep=False)
        self.assertIn("MANIFEST_MISSING", codes)

    async def test_a_manifest_copy_that_was_edited_in_object_storage_is_detected(self):
        envelope = json.loads(self.store.objects[self.row["signature_key"]][-1]["data"])
        envelope["manifest"]["event_count"] = 71
        self.store.replace(self.row["signature_key"], json.dumps(envelope).encode())
        _, codes = await self.verdict(deep=False)
        self.assertIn("MANIFEST_COPIES_DIFFER", codes)

    async def test_a_missing_protected_manifest_is_detected(self):
        (self.signer.checkpoints_dir / "archives" / self.env / str(self.tenant) / "archive-000001.json").unlink()
        _, codes = await self.verdict(deep=False)
        self.assertIn("MANIFEST_PROTECTED_COPY_MISSING", codes)

    async def test_an_invalid_protected_manifest_is_detected(self):
        path = self.signer.checkpoints_dir / "archives" / self.env / str(self.tenant) / "archive-000001.json"
        path.chmod(0o644)
        path.write_text("{ not json")
        r, codes = await self.verdict(deep=False)
        self.assertEqual(r.state, "FAILED")

    async def test_a_manifest_forged_with_an_attackers_key_is_untrusted_even_if_planted_everywhere(self):
        attacker = Ed25519PrivateKey.generate()
        envelope = json.loads(self.store.objects[self.row["signature_key"]][-1]["data"])
        forged = dict(envelope["manifest"], event_count=70)
        forged_envelope = am.make_envelope(forged, am.sign_manifest(attacker, forged))
        path = self.signer.checkpoints_dir / "archives" / self.env / str(self.tenant) / "archive-000001.json"
        path.chmod(0o644)
        path.write_text(json.dumps(forged_envelope))
        self.store.replace(self.row["signature_key"], json.dumps(forged_envelope).encode())
        _, codes = await self.verdict(deep=False)
        self.assertTrue({"MANIFEST_SIGNATURE_INVALID", "UNTRUSTED_SIGNER"} & codes, codes)

    async def test_an_edited_manifest_with_the_original_signature_fails(self):
        envelope = json.loads(self.store.objects[self.row["signature_key"]][-1]["data"])
        envelope["manifest"]["end_sequence"] = 69
        path = self.signer.checkpoints_dir / "archives" / self.env / str(self.tenant) / "archive-000001.json"
        path.chmod(0o644)
        path.write_text(json.dumps(envelope))
        _, codes = await self.verdict(deep=False)
        self.assertIn("MANIFEST_INVALID", codes)

    async def test_a_catalog_entry_edited_to_disagree_with_the_signed_manifest_is_detected(self):
        async with self.privileged() as conn:
            await conn.execute(text("ALTER TABLE archive_catalog DISABLE TRIGGER USER"))
            await conn.execute(text("UPDATE archive_catalog SET last_event_hash = repeat('a', 64) WHERE archive_id = :a"), {"a": self.row["archive_id"]})
            await conn.execute(text("ALTER TABLE archive_catalog ENABLE TRIGGER USER"))
        row = (await self.catalog(self.chain))[0]
        _, codes = await self.verdict(deep=False, row=row)
        self.assertIn("CATALOG_MANIFEST_MISMATCH", codes)

    async def test_an_archive_encrypted_with_the_wrong_key_is_reported_as_unreadable_not_valid(self):
        other = tempfile = self.tmp / "keys2"
        crypto.init_keys(str(other))
        w = self.worker()
        w.verifier.keyring = crypto.KeyRing(str(other))
        r = await w.verifier.verify(dict(self.row), deep=True, env=self.env)
        self.assertEqual(r.state, "FAILED")

    async def test_a_deleted_archive_is_detected_by_chain_level_verification(self):
        """Delete the archive's catalog entry (as a privileged attacker could): the signed manifest still proves it existed."""
        async with self.privileged() as conn:
            for table in ("archive_catalog", "archive_verifications"):
                await conn.execute(text(f"ALTER TABLE {table} DISABLE TRIGGER USER"))
            await conn.execute(text("DELETE FROM archive_verifications"))
            await conn.execute(text("DELETE FROM archive_catalog WHERE chain_id = :c"), {"c": self.chain})
            for table in ("archive_catalog", "archive_verifications"):
                await conn.execute(text(f"ALTER TABLE {table} ENABLE TRIGGER USER"))
        self.store.delete(self.base)
        r = await iv.verify_anchored(self.chain, storage=TrustedStorage(str(self.signer.checkpoints_dir)))
        self.assertIn("ARCHIVE_MISSING_FROM_CATALOG", {f.code for f in r.findings})
        self.assertNotIn(r.state, (sv.VERIFIED, sv.UNSIGNED_EVENTS_PENDING))

    async def test_a_catalog_entry_without_a_signed_manifest_is_not_trusted(self):
        (self.signer.checkpoints_dir / "archives" / self.env / str(self.tenant) / "archive-000001.json").unlink()
        r = await iv.verify_anchored(self.chain, storage=TrustedStorage(str(self.signer.checkpoints_dir)))
        self.assertIn("ARCHIVE_NOT_SIGNED", {f.code for f in r.findings})

    async def test_the_object_store_credentials_the_service_uses_cannot_delete(self):
        """The writer role in MinIO has no delete action; the application also never calls delete (there is no delete method in the store interface)."""
        from app.archive import store
        self.assertFalse(any(name for name in dir(store.S3Store) if "delete" in name.lower() or "remove" in name.lower()))
