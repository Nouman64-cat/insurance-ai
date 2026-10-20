"""Key management, the checkpoint format and the trust registry, with real Ed25519 keys and real files."""
import base64
import json
import os
import stat
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from shared.audit import checkpoint as cp
from shared.audit.signer.cli import make_backup, restore_backup
from shared.audit.signer.errors import SignerError
from shared.audit.signer.files import AlreadyExists, CheckpointStore, write_new
from shared.audit.signer.key_manager import KeyManager
from shared.audit.trust import RegistryError, TrustRegistry, make_statement, new_registry_data, sign_entry
from tests.signing_support import StageTwoCase


def sample_payload(**overrides) -> dict:
    fields = dict(checkpoint_id=uuid4(), tenant_id=uuid4(), environment_id=uuid4(), chain_id="c", checkpoint_number=1, start_sequence=1, end_sequence=500,
                  event_count=500, last_event_hash="a" * 64, previous_checkpoint_hash="b" * 64, created_at="2026-10-20T10:00:00.000000Z",
                  signer_id="s", signing_key_id="s-v1", key_version=1, signature_algorithm="Ed25519", payload_version=1)
    fields.update(overrides)
    return cp.build_payload(**fields)


class CheckpointFormatTests(unittest.TestCase):
    def test_payload_binds_every_required_field(self):
        self.assertEqual(set(sample_payload()), {
            "checkpoint_id", "tenant_id", "environment_id", "chain_id", "checkpoint_number", "start_sequence", "end_sequence", "event_count",
            "last_event_hash", "previous_checkpoint_hash", "created_at", "signer_id", "signing_key_id", "key_version", "signature_algorithm", "payload_version"})

    def test_signature_verifies_and_every_field_is_covered(self):
        key = Ed25519PrivateKey.generate()
        public = cp.public_key_b64(key.public_key())
        payload = sample_payload()
        signature = cp.sign_payload(key, payload)
        self.assertTrue(cp.verify_payload(public, payload, signature))
        for field, value in (("end_sequence", 501), ("last_event_hash", "c" * 64), ("previous_checkpoint_hash", "d" * 64), ("chain_id", "other"),
                             ("tenant_id", str(uuid4())), ("environment_id", str(uuid4())), ("created_at", "2026-10-20T10:00:01.000000Z"),
                             ("signing_key_id", "s-v2"), ("checkpoint_number", 2), ("signer_id", "evil")):
            with self.subTest(field=field):
                changed = dict(payload, **{field: value})
                if field == "end_sequence":
                    changed["event_count"] = 501
                self.assertFalse(cp.verify_payload(public, changed, signature))

    def test_wrong_key_and_garbage_signatures_fail(self):
        payload = sample_payload()
        signature = cp.sign_payload(Ed25519PrivateKey.generate(), payload)
        other = cp.public_key_b64(Ed25519PrivateKey.generate().public_key())
        self.assertFalse(cp.verify_payload(other, payload, signature))
        for bad in ("", "not base64!", base64.b64encode(b"short").decode()):
            self.assertFalse(cp.verify_payload(other, payload, bad))

    def test_encoding_is_deterministic_and_checkpoint_hash_links(self):
        a, b = sample_payload(checkpoint_id=uuid4()), sample_payload()
        c = dict(a)
        self.assertEqual(cp.canonical_payload(a), cp.canonical_payload(dict(reversed(list(c.items())))))
        self.assertNotEqual(cp.checkpoint_hash(a), cp.checkpoint_hash(b))
        self.assertRegex(cp.checkpoint_hash(a), r"^[0-9a-f]{64}$")

    def test_malformed_payloads_are_refused(self):
        with self.assertRaises(cp.CheckpointFormatError):
            sample_payload(event_count=3)                      # does not match the range
        with self.assertRaises(cp.CheckpointFormatError):
            sample_payload(signature_algorithm="RSA")
        with self.assertRaises(cp.CheckpointFormatError):
            cp.build_payload(chain_id="c")                      # missing fields

    def test_envelope_consistency_check(self):
        key = Ed25519PrivateKey.generate()
        payload = sample_payload()
        envelope = cp.make_envelope(payload, cp.sign_payload(key, payload))
        self.assertIsNone(cp.check_envelope(envelope))
        tampered = json.loads(json.dumps(envelope))
        tampered["payload"]["end_sequence"] = 9
        self.assertIsNotNone(cp.check_envelope(tampered))


class FileStoreTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.root = Path(tempfile.mkdtemp(prefix="store-"))
        self.store = CheckpointStore(self.root)
        self.env, self.tenant = str(uuid4()), str(uuid4())

    def test_paths_are_confined_to_the_store(self):
        for bad in ("../../etc", "a/b", "", "x" * 40, "../" + self.tenant):
            with self.subTest(bad=bad), self.assertRaises(SignerError):
                self.store.directory(self.env, bad)
        with self.assertRaises(SignerError):
            self.store.directory("not-a-uuid", self.tenant)
        with self.assertRaises(SignerError):
            self.store.path(self.env, self.tenant, 0)
        self.assertTrue(str(self.store.path(self.env, None, 7)).endswith(f"{self.env}/platform/checkpoint-000007.json"))

    def test_files_are_never_overwritten_and_are_read_only(self):
        self.store.write(self.env, self.tenant, 1, {"a": 1})
        with self.assertRaises(AlreadyExists):
            self.store.write(self.env, self.tenant, 1, {"a": 2})
        self.assertEqual(self.store.read(self.env, self.tenant, 1), {"a": 1})
        mode = stat.S_IMODE(os.stat(self.store.path(self.env, self.tenant, 1)).st_mode)
        self.assertEqual(mode & 0o222, 0, "stored checkpoints are not writable")
        self.assertEqual(self.store.numbers(self.env, self.tenant), [1])
        self.assertEqual([p.name for p in self.store.directory(self.env, self.tenant).iterdir() if p.name.endswith(".tmp")], [])

    def test_an_interrupted_write_leaves_nothing_behind(self):
        target = self.store.path(self.env, self.tenant, 1)
        original = os.link
        try:
            os.link = lambda *a, **k: (_ for _ in ()).throw(KeyboardInterrupt())
            with self.assertRaises(KeyboardInterrupt):
                write_new(target, b"data")
        finally:
            os.link = original
        self.assertFalse(target.exists())
        self.assertEqual([p.name for p in target.parent.iterdir()], [])


class KeyManagerTests(StageTwoCase):
    async def test_initialisation_creates_an_encrypted_key_and_a_trust_root(self):
        trusted = await self.signer.init()
        pem = (self.tmp / "keys" / "ed25519-private-v1.pem").read_bytes()
        self.assertIn(b"BEGIN ENCRYPTED PRIVATE KEY", pem)          # PKCS#8, encrypted
        with self.assertRaises(Exception):
            serialization.load_pem_private_key(pem, password=None)  # unusable without the passphrase
        passphrase = (self.tmp / "secrets" / "key-passphrase").read_bytes().strip()
        key = serialization.load_pem_private_key(pem, password=passphrase)
        self.assertEqual(cp.public_key_b64(key.public_key()), trusted.public_key)
        self.assertEqual(stat.S_IMODE(os.stat(self.tmp / "keys" / "ed25519-private-v1.pem").st_mode), 0o400)
        self.assertEqual(stat.S_IMODE(os.stat(self.tmp / "secrets" / "key-passphrase").st_mode), 0o400)
        self.assertEqual(trusted.status, "ACTIVE")
        self.assertEqual(len(trusted.fingerprint), 64)
        self.assertNotIn(passphrase.decode(), json.dumps(self.signer.service.store.read_registry()))
        self.assertNotIn(b"PRIVATE", self.signer.service.store.registry_path.read_bytes())

    async def test_restart_reuses_the_same_key_and_never_generates_a_new_one(self):
        first = await self.signer.init()
        before = (self.tmp / "keys" / "ed25519-private-v1.pem").read_bytes()
        await self.signer.restart()
        env = await self.signer.service.source.environment_id()
        active, _ = self.signer.service.keys.active(env)
        self.assertEqual(active.fingerprint, first.fingerprint)
        self.assertEqual((self.tmp / "keys" / "ed25519-private-v1.pem").read_bytes(), before)
        self.assertEqual(sorted(p.name for p in (self.tmp / "keys").iterdir()), ["ed25519-private-v1.pem"])

    async def test_initialisation_refuses_to_run_twice(self):
        await self.signer.init()
        with self.assertRaises(SignerError) as ctx:
            await self.signer.init()
        self.assertEqual(ctx.exception.code, "ALREADY_INITIALISED")

    async def test_a_missing_key_is_reported_not_silently_replaced(self):
        await self.signer.init()
        (self.tmp / "keys" / "ed25519-private-v1.pem").chmod(0o600)
        (self.tmp / "keys" / "ed25519-private-v1.pem").unlink()
        await self.signer.restart()
        chain = await self.events(2)
        with self.assertRaises(SignerError) as ctx:
            await self.signer.service.sign_checkpoint(chain)
        self.assertEqual(ctx.exception.code, "KEY_UNAVAILABLE")
        self.assertEqual(list((self.tmp / "keys").iterdir()), [])          # nothing was regenerated
        status = await self.signer.service.status()
        self.assertFalse(status["key_available"])
        self.assertIn("KEY_UNAVAILABLE", status["problem"])

    async def test_a_wrong_or_missing_passphrase_is_reported(self):
        await self.signer.init()
        chain = await self.events(2)
        passphrase = self.tmp / "secrets" / "key-passphrase"
        passphrase.chmod(0o600)
        passphrase.write_text("a different passphrase")
        with self.assertRaises(SignerError) as ctx:
            await self.signer.service.sign_checkpoint(chain)
        self.assertEqual(ctx.exception.code, "KEY_INVALID")
        passphrase.unlink()
        with self.assertRaises(SignerError) as ctx:
            await self.signer.service.sign_checkpoint(chain)
        self.assertEqual(ctx.exception.code, "KEY_UNAVAILABLE")

    async def test_an_uninitialised_signer_refuses_and_creates_nothing(self):
        chain = await self.events(2)
        with self.assertRaises(SignerError) as ctx:
            await self.signer.service.sign_checkpoint(chain)
        self.assertEqual(ctx.exception.code, "KEY_UNAVAILABLE")
        self.assertFalse((self.tmp / "keys").exists() and any((self.tmp / "keys").iterdir()))

    async def test_the_private_key_is_never_exposed_through_the_api(self):
        await self.signer.init()
        from tests.signing_support import SERVICE_KEY
        from shared.security import service_auth
        import httpx
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.signer.app), base_url="http://s") as client:
            for path in ("/v1/health", "/v1/status", "/v1/keys"):
                headers = service_auth.sign(SERVICE_KEY, "GET", path, b"", caller="audit-service")
                body = (await client.get(path, headers=headers)).text
                self.assertNotIn("PRIVATE", body)
                self.assertNotIn((self.tmp / "secrets" / "key-passphrase").read_text().strip(), body)
            paths = {getattr(r, "path", "") for r in self.signer.app.routes}
            self.assertFalse({p for p in paths if "private" in p or "sign-hash" in p or "export" in p})

    async def test_encrypted_backup_and_restore_round_trip(self):
        await self.signer.init()
        chain = await self.events(3)
        await self.checkpoint(chain)
        passphrase = b"backup passphrase 123"
        blob = make_backup(self.signer.settings, passphrase)
        self.assertNotIn(b"checkpoint", blob)                              # encrypted
        self.assertNotIn((self.tmp / "secrets" / "key-passphrase").read_bytes().strip(), blob)   # the key passphrase is never in a backup
        with self.assertRaises(SignerError):
            restore_backup(self.signer.settings, blob, b"wrong")
        import shutil
        shutil.rmtree(self.tmp / "checkpoints")
        shutil.rmtree(self.tmp / "state")
        restored = restore_backup(self.signer.settings, blob, passphrase)
        self.assertTrue(any(r.endswith("checkpoint-000001.json") for r in restored))
        again = restore_backup(self.signer.settings, blob, passphrase)
        self.assertEqual(again, [])                                        # identical files are left alone, nothing overwritten
        (self.tmp / "checkpoints" / "trust" / "signing-keys.json").chmod(0o644)
        (self.tmp / "checkpoints" / "trust" / "signing-keys.json").write_text("{}")
        with self.assertRaises(SignerError) as ctx:
            restore_backup(self.signer.settings, blob, passphrase)
        self.assertEqual(ctx.exception.code, "RESTORE_CONFLICT")


class RegistryTests(StageTwoCase):
    def make_chain(self, versions: int = 2):
        env = str(uuid4())
        keys, entries, previous = [], [], None
        for v in range(1, versions + 1):
            key = Ed25519PrivateKey.generate()
            st = make_statement(action="bootstrap" if v == 1 else "rotate", signer_id="s", key_id=f"s-v{v}", key_version=v, environment_id=env,
                                public_key=cp.public_key_b64(key.public_key()), created_at=f"2026-10-0{v}T00:00:00.000000Z", previous_key_id=previous)
            entries.append(sign_entry(st, key, *( [keys[-1], f"s-v{v-1}"] if v > 1 else [])))
            keys.append(key)
            previous = f"s-v{v}"
        return env, keys, entries

    def test_a_valid_chain_of_trust_parses_and_derives_key_status(self):
        env, keys, entries = self.make_chain(3)
        registry = TrustRegistry.parse(new_registry_data(env, entries), environment_id=env)
        self.assertEqual([k.status for k in registry.keys], ["RETIRED", "RETIRED", "ACTIVE"])
        self.assertEqual(registry.active.key_id, "s-v3")
        old = registry.get("s-v1")
        self.assertTrue(old.valid_at("2026-10-01T12:00:00.000000Z"))
        self.assertFalse(old.valid_at("2026-10-02T00:00:00.000000Z"))      # retired the moment v2 was activated

    def test_a_key_cannot_be_added_without_the_previous_keys_authorisation(self):
        env, keys, entries = self.make_chain(1)
        attacker = Ed25519PrivateKey.generate()
        st = make_statement(action="rotate", signer_id="s", key_id="s-v2", key_version=2, environment_id=env,
                            public_key=cp.public_key_b64(attacker.public_key()), created_at="2026-10-05T00:00:00.000000Z", previous_key_id="s-v1")
        forged = sign_entry(st, attacker, attacker, "s-v1")                 # "authorised" by the wrong private key
        with self.assertRaises(RegistryError):
            TrustRegistry.parse(new_registry_data(env, entries + [forged]), environment_id=env)
        unauthorised = sign_entry(st, attacker)                              # no authorisation at all
        with self.assertRaises(RegistryError):
            TrustRegistry.parse(new_registry_data(env, entries + [unauthorised]), environment_id=env)

    def test_a_replaced_trust_root_is_rejected_when_the_anchor_is_pinned(self):
        env, keys, entries = self.make_chain(1)
        other_env, other_keys, other_entries = self.make_chain(1)
        other_entries[0]["statement"]["environment_id"] = env
        with self.assertRaises(RegistryError):
            TrustRegistry.parse(new_registry_data(env, other_entries), environment_id=env)   # statement no longer matches its signature
        genuine = TrustRegistry.parse(new_registry_data(env, entries), environment_id=env, anchor_fingerprint=entries[0]["statement"]["fingerprint"])
        self.assertEqual(genuine.active.key_id, "s-v1")
        with self.assertRaises(RegistryError):
            TrustRegistry.parse(new_registry_data(env, entries), environment_id=env, anchor_fingerprint="0" * 64)

    def test_another_environments_registry_is_not_trusted(self):
        env, keys, entries = self.make_chain(1)
        with self.assertRaises(RegistryError):
            TrustRegistry.parse(new_registry_data(env, entries), environment_id=str(uuid4()))

    def test_tampered_entries_are_rejected(self):
        env, keys, entries = self.make_chain(2)
        for mutate in (lambda e: e[0]["statement"].update(public_key=cp.public_key_b64(Ed25519PrivateKey.generate().public_key())),
                       lambda e: e[1]["statement"].update(previous_key_id="s-v9"),
                       lambda e: e.reverse(), lambda e: e.pop(0)):
            copy = json.loads(json.dumps(entries))
            mutate(copy)
            with self.subTest(), self.assertRaises(RegistryError):
                TrustRegistry.parse(new_registry_data(env, copy), environment_id=env)

    async def test_rotation_through_the_signer_keeps_old_keys_trusted(self):
        first = await self.signer.init()
        second = await self.signer.service.rotate()
        env = await self.signer.service.source.environment_id()
        registry = self.signer.service.keys.registry(env)
        self.assertEqual([k.key_id for k in registry.keys], ["test-signer-v1", "test-signer-v2"])
        self.assertEqual(registry.keys[0].status, "RETIRED")
        self.assertEqual(registry.active.fingerprint, second["fingerprint"])
        self.assertNotEqual(first.fingerprint, second["fingerprint"])
        self.assertEqual(sorted(p.name for p in (self.tmp / "keys").iterdir()), ["ed25519-private-v1.pem", "ed25519-private-v2.pem"])


if __name__ == "__main__":
    unittest.main()
