"""Stage 2 verification: signed checkpoints and trusted anchors against every kind of tampering.

The point of this file is the difference between the two layers:
  * Stage 1 (SHA-256 chain) trusts the database it is checking; a privileged attacker who rewrites the WHOLE chain
    consistently passes it (see test_a_perfectly_recomputed_chain_...).
  * Stage 2 compares against signed checkpoints held OUTSIDE the database, verified with keys the database cannot add to.
"""
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy import text

from app import db
from app.checkpoints.storage import TrustedStorage
from app.services import chain_verifier
from app.verification import integrity_verifier as iv
from app.verification import signature_verifier as sv
from app.config import settings
from shared.audit import checkpoint as cp
from shared.audit.hashing import format_timestamp
from shared.audit.trust import TrustRegistry, make_statement, new_registry_data, sign_entry
from tests.signing_support import StageTwoCase, SignerHarness, override_settings


class AnchoredCase(StageTwoCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.trusted = await self.signer.init()
        self.env = str(await self.environment_id())
        self.attacker = Ed25519PrivateKey.generate()

    async def signed_chain(self, first: int = 6, second: int = 4) -> str:
        chain = await self.events(first)
        await self.checkpoint(chain)
        if second:
            await self.events(second, start=first)
            await self.checkpoint(chain)
        return chain

    async def verify(self, chain: str):
        return await iv.verify_anchored(chain, storage=TrustedStorage(str(self.signer.checkpoints_dir)))

    def file(self, number: int, tenant=None) -> Path:
        return self.signer.checkpoints_dir / self.env / str(tenant or self.tenant) / f"checkpoint-{number:06d}.json"

    def read_file(self, number: int) -> dict:
        return json.loads(self.file(number).read_text())

    def write_file(self, number: int, envelope: dict) -> None:
        path = self.file(number)
        path.chmod(0o644)
        path.write_text(json.dumps(envelope, sort_keys=True))

    def forge(self, envelope: dict, key=None, **changes) -> dict:
        """What an attacker can build: a well-formed checkpoint signed with a key of their own."""
        payload = dict(envelope["payload"], **changes)
        payload["event_count"] = payload["end_sequence"] - payload["start_sequence"] + 1
        return cp.make_envelope(payload, cp.sign_payload(key or self.attacker, payload))

    async def replace_db_checkpoint(self, chain: str, number: int, envelope: dict) -> None:
        p = envelope["payload"]
        async with self.privileged() as conn:
            await conn.execute(text("""UPDATE checkpoints SET canonical_payload = :c, signature = :s, signing_key_id = :k, checkpoint_hash = :h,
                last_event_hash = :l, end_sequence = :e, event_count = :n WHERE chain_id = :ch AND checkpoint_number = :num"""),
                {"c": envelope["canonical_payload"], "s": envelope["signature"], "k": p["signing_key_id"], "h": envelope["checkpoint_hash"],
                 "l": p["last_event_hash"], "e": p["end_sequence"], "n": p["event_count"], "ch": chain, "num": number})

    def codes(self, result) -> set:
        return {f.code for f in result.findings}


class HappyPathTests(AnchoredCase):
    async def test_a_fully_signed_and_anchored_chain_is_verified(self):
        chain = await self.signed_chain()
        r = await self.verify(chain)
        self.assertEqual(r.state, sv.VERIFIED, [f.to_api() for f in r.findings])
        self.assertEqual((r.hash_chain_valid, r.signatures_valid, r.signer_trusted, r.anchored), (True, True, True, True))
        self.assertEqual((r.checkpoints_checked, r.last_checkpoint_number, r.pending_events), (2, 2, 0))

    async def test_events_after_the_last_checkpoint_are_reported_as_pending_not_hidden(self):
        chain = await self.signed_chain()
        await self.events(3, start=10)
        r = await self.verify(chain)
        self.assertEqual((r.state, r.pending_events, r.anchored, r.hash_chain_valid), (sv.UNSIGNED_EVENTS_PENDING, 3, True, True))

    async def test_a_chain_without_any_checkpoint_yet_is_pending(self):
        chain = await self.events(4)
        r = await self.verify(chain)
        self.assertEqual((r.state, r.pending_events, r.checkpoints_checked, r.anchored), (sv.UNSIGNED_EVENTS_PENDING, 4, 0, None))

    async def test_an_unknown_chain(self):
        r = await self.verify(await self.chain_id(uuid4()))
        self.assertEqual(r.state, sv.VERIFICATION_FAILED)

    async def test_stage_one_features_keep_working_next_to_checkpoints(self):
        chain = await self.signed_chain()
        stage1 = await chain_verifier.verify_chain(chain)
        self.assertEqual((stage1.status, stage1.total_events_checked), ("VALID", 10))
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE events SET action = 'x' WHERE chain_id = :c AND sequence_number = 3"), {"c": chain})
        self.assertEqual((await chain_verifier.verify_chain(chain)).reason, "EVENT_HASH_MISMATCH")


class EventTamperingTests(AnchoredCase):
    async def test_a_modified_event_is_caught_by_the_hash_chain(self):
        chain = await self.signed_chain()
        async with self.privileged() as conn:
            await conn.execute(text("""UPDATE events SET new_value = '{"status": "Hacked"}'::jsonb WHERE chain_id = :c AND sequence_number = 3"""), {"c": chain})
        r = await self.verify(chain)
        self.assertEqual((r.state, r.hash_chain_valid), (sv.INVALID_HASH_CHAIN, False))
        self.assertEqual(r.hash_chain["reason"], "EVENT_HASH_MISMATCH")

    async def test_deleted_and_reordered_events_are_caught(self):
        chain = await self.signed_chain()
        async with self.privileged() as conn:
            await conn.execute(text("DELETE FROM events WHERE chain_id = :c AND sequence_number = 4"), {"c": chain})
        r = await self.verify(chain)
        self.assertEqual(r.state, sv.INVALID_HASH_CHAIN)
        self.assertEqual(r.hash_chain["reason"], "SEQUENCE_GAP")

    async def test_a_perfectly_recomputed_chain_passes_stage_one_but_not_the_signed_checkpoints(self):
        """THE demonstration. An attacker with database owner rights rewrites an anchored event and recomputes every hash and the
        chain head. Stage 1 sees a flawless chain. Stage 2 notices because event 6 no longer matches what checkpoint 1 signed."""
        chain = await self.signed_chain()
        self.assertEqual((await self.verify(chain)).state, sv.VERIFIED)
        await self.rewrite_chain(chain, lambda row: row.update(new_value={"status": "Rewritten", "amount": 1}) if row["sequence_number"] == 2 else None)
        stage1 = await chain_verifier.verify_chain(chain)
        self.assertEqual((stage1.status, stage1.total_events_checked), ("VALID", 10), "Stage 1 is fooled: that is the gap Stage 2 closes")
        r = await self.verify(chain)
        self.assertEqual((r.state, r.hash_chain_valid, r.anchored), (sv.CHECKPOINT_MISMATCH, True, False))
        self.assertIn("ANCHOR_EVENT_MISMATCH", self.codes(r))
        mismatch = next(f for f in r.findings if f.code == "ANCHOR_EVENT_MISMATCH")
        self.assertEqual(mismatch.checkpoint_number, 1)
        self.assertTrue(r.signatures_valid and r.signer_trusted)          # the signatures are fine: it is the HISTORY that changed

    async def test_rewriting_history_that_no_checkpoint_covers_yet_cannot_be_detected(self):
        """The documented limit: only events up to the last checkpoint are anchored. Events after it are pending."""
        chain = await self.signed_chain()
        await self.events(3, start=10)
        await self.rewrite_chain(chain, lambda row: row.update(new_value={"status": "Rewritten"}) if row["sequence_number"] > 10 else None)
        r = await self.verify(chain)
        self.assertEqual((r.state, r.pending_events), (sv.UNSIGNED_EVENTS_PENDING, 3))

    async def test_truncating_the_chain_and_rolling_the_head_back_is_caught(self):
        chain = await self.signed_chain()
        async with self.privileged() as conn:
            await conn.execute(text("DELETE FROM events WHERE chain_id = :c AND sequence_number > 7"), {"c": chain})
            head = (await conn.execute(text("SELECT current_hash FROM events WHERE chain_id = :c AND sequence_number = 7"), {"c": chain})).scalar_one()
            await conn.execute(text("UPDATE chains SET head_sequence = 7, head_hash = :h WHERE chain_id = :c"), {"h": head, "c": chain})
        self.assertEqual((await chain_verifier.verify_chain(chain)).status, "VALID", "Stage 1 cannot see a clean truncation")
        r = await self.verify(chain)
        self.assertEqual((r.state, r.hash_chain_valid), (sv.CHECKPOINT_MISMATCH, True))
        self.assertIn("CHAIN_TRUNCATED", self.codes(r))


class SignatureAndTrustTests(AnchoredCase):
    async def test_a_forged_signature_is_detected(self):
        chain = await self.signed_chain()
        envelope = self.read_file(2)
        raw = bytearray(__import__("base64").b64decode(envelope["signature"]))
        raw[0] ^= 0xFF
        envelope["signature"] = __import__("base64").b64encode(bytes(raw)).decode()
        self.write_file(2, envelope)
        r = await self.verify(chain)
        self.assertEqual((r.state, r.signatures_valid), (sv.INVALID_SIGNATURE, False))
        self.assertIn("SIGNATURE_DOES_NOT_VERIFY", self.codes(r))

    async def test_a_changed_payload_under_the_original_signature_is_detected(self):
        chain = await self.signed_chain()
        envelope = self.read_file(1)
        payload = envelope["payload"]
        payload["last_event_hash"] = "a" * 64
        replaced = cp.make_envelope(payload, envelope["signature"])         # internally consistent, but not what was signed
        self.write_file(1, replaced)
        r = await self.verify(chain)
        self.assertEqual(r.state, sv.INVALID_SIGNATURE)

    async def test_a_checkpoint_signed_by_an_attackers_own_key_is_untrusted(self):
        chain = await self.signed_chain()
        genuine = self.read_file(2)
        evil = self.forge(genuine, signing_key_id="evil-v1", signer_id="evil", key_version=1)
        self.write_file(2, evil)
        await self.replace_db_checkpoint(chain, 2, evil)                    # the attacker even makes the database agree
        r = await self.verify(chain)
        self.assertEqual((r.state, r.signer_trusted), (sv.UNTRUSTED_SIGNER, False))
        self.assertIn("UNKNOWN_SIGNING_KEY", self.codes(r))

    async def test_an_attacker_cannot_reuse_a_trusted_key_id_with_their_own_key(self):
        chain = await self.signed_chain()
        evil = self.forge(self.read_file(2))                                # claims test-signer-v1 but signed with the attacker's key
        self.write_file(2, evil)
        await self.replace_db_checkpoint(chain, 2, evil)
        r = await self.verify(chain)
        self.assertEqual(r.state, sv.INVALID_SIGNATURE)

    async def test_database_only_forgery_of_a_checkpoint_does_not_survive_the_trusted_copy(self):
        chain = await self.signed_chain()
        forged = self.forge(self.read_file(2), last_event_hash="c" * 64)
        await self.replace_db_checkpoint(chain, 2, forged)                  # only the database is changed
        r = await self.verify(chain)
        self.assertNotEqual(r.state, sv.VERIFIED)
        self.assertIn("DATABASE_COPY_DIFFERS", self.codes(r))
        self.assertEqual(r.state, sv.INVALID_SIGNATURE)                    # and the forged copy fails on its own signature too

    async def test_a_checkpoint_deleted_from_the_database_is_missing(self):
        chain = await self.signed_chain()
        async with self.privileged() as conn:
            await conn.execute(text("DELETE FROM checkpoints WHERE chain_id = :c AND checkpoint_number = 2"), {"c": chain})
        r = await self.verify(chain)
        self.assertEqual(r.state, sv.MISSING_CHECKPOINT)
        self.assertIn("CHECKPOINT_MISSING_FROM_DATABASE", self.codes(r))

    async def test_a_checkpoint_deleted_from_trusted_storage_is_missing(self):
        chain = await self.signed_chain()
        self.file(2).chmod(0o644)
        self.file(2).unlink()
        r = await self.verify(chain)
        self.assertEqual(r.state, sv.MISSING_CHECKPOINT)
        self.assertIn("CHECKPOINT_MISSING_FROM_TRUSTED_STORAGE", self.codes(r))

    async def test_a_gap_in_the_checkpoint_numbers_is_missing(self):
        chain = await self.signed_chain()
        await self.events(2, start=10)
        await self.checkpoint(chain)
        self.file(2).chmod(0o644)
        self.file(2).unlink()
        r = await self.verify(chain)
        self.assertEqual(r.state, sv.MISSING_CHECKPOINT)
        self.assertIn("CHECKPOINT_NUMBER_GAP", self.codes(r))

    async def test_a_checkpoint_from_another_tenants_chain_cannot_be_substituted(self):
        chain = await self.signed_chain()
        other_tenant = uuid4()
        other = await self.events(6, tenant=other_tenant)
        await self.checkpoint(other)
        foreign = json.loads(self.file(1, other_tenant).read_text())
        self.write_file(1, foreign)
        r = await self.verify(chain)
        self.assertEqual(r.state, sv.CHECKPOINT_MISMATCH)
        self.assertIn("CHECKPOINT_NOT_FOR_THIS_CHAIN", self.codes(r))

    async def test_trusted_storage_that_cannot_be_read_is_never_reported_as_verified(self):
        chain = await self.signed_chain()
        hidden = self.tmp / "hidden"
        shutil.move(str(self.signer.checkpoints_dir), str(hidden))
        r = await self.verify(chain)
        self.assertEqual(r.state, sv.VERIFICATION_FAILED)
        self.assertNotEqual(r.anchored, True)
        self.assertIn("TRUSTED_STORAGE_UNAVAILABLE", self.codes(r))

    async def test_a_missing_registry_is_never_reported_as_verified(self):
        chain = await self.signed_chain()
        self.signer.service.store.registry_path.chmod(0o644)
        self.signer.service.store.registry_path.unlink()
        r = await self.verify(chain)
        self.assertEqual(r.state, sv.VERIFICATION_FAILED)
        self.assertIn("TRUSTED_REGISTRY_UNAVAILABLE", self.codes(r))

    async def test_a_registry_replaced_by_the_attacker(self):
        chain = await self.signed_chain()
        statement = make_statement(action="bootstrap", signer_id="test-signer", key_id="test-signer-v1", key_version=1, environment_id=self.env,
                                   public_key=cp.public_key_b64(self.attacker.public_key()), created_at=self.trusted.activated_at, previous_key_id=None)
        registry_path = self.signer.service.store.registry_path
        registry_path.chmod(0o644)
        registry_path.write_text(json.dumps(new_registry_data(self.env, [sign_entry(statement, self.attacker)])))
        self.assertEqual((await self.verify(chain)).state, sv.INVALID_SIGNATURE)        # the genuine signatures no longer verify
        with override_settings(trust_anchor_fingerprint=self.trusted.fingerprint):      # with the operator's pinned fingerprint: refused outright
            r = await self.verify(chain)
        self.assertEqual(r.state, sv.UNTRUSTED_SIGNER)
        self.assertIn("TRUSTED_REGISTRY_INVALID", self.codes(r))

    async def test_a_registry_from_another_environment_is_not_trusted(self):
        chain = await self.signed_chain()
        key = Ed25519PrivateKey.generate()
        other_env = str(uuid4())
        statement = make_statement(action="bootstrap", signer_id="test-signer", key_id="test-signer-v1", key_version=1, environment_id=other_env,
                                   public_key=cp.public_key_b64(key.public_key()), created_at="2026-01-01T00:00:00.000000Z", previous_key_id=None)
        path = self.signer.service.store.registry_path
        path.chmod(0o644)
        path.write_text(json.dumps(new_registry_data(other_env, [sign_entry(statement, key)])))
        r = await self.verify(chain)
        self.assertEqual(r.state, sv.UNTRUSTED_SIGNER)

    def test_a_key_scoped_to_another_tenant_is_not_authorised(self):
        key = Ed25519PrivateKey.generate()
        env, tenant, other = str(uuid4()), str(uuid4()), str(uuid4())
        statement = make_statement(action="bootstrap", signer_id="s", key_id="s-v1", key_version=1, environment_id=env, public_key=cp.public_key_b64(key.public_key()),
                                   created_at="2026-01-01T00:00:00.000000Z", previous_key_id=None, tenant_scope=other)
        registry = TrustRegistry.parse(new_registry_data(env, [sign_entry(statement, key)]), environment_id=env)
        payload = cp.build_payload(checkpoint_id=uuid4(), tenant_id=tenant, environment_id=env, chain_id="c", checkpoint_number=1, start_sequence=1, end_sequence=2,
                                   event_count=2, last_event_hash="a" * 64, previous_checkpoint_hash=cp.checkpoint_genesis_hash("c"),
                                   created_at="2026-02-01T00:00:00.000000Z", signer_id="s", signing_key_id="s-v1", key_version=1,
                                   signature_algorithm="Ed25519", payload_version=1)
        envelope = cp.make_envelope(payload, cp.sign_payload(key, payload))
        found = sv.verify_envelope(envelope, registry, chain_id="c", environment_id=env, tenant_id=tenant, source="test")
        self.assertEqual([f.code for f in found], ["KEY_NOT_AUTHORISED"])


class RotationTests(AnchoredCase):
    async def test_checkpoints_signed_before_and_after_a_rotation_all_verify(self):
        chain = await self.signed_chain()
        rotated = await self.signer.service.rotate()
        await self.events(3, start=10)
        await self.checkpoint(chain)
        r = await self.verify(chain)
        self.assertEqual(r.state, sv.VERIFIED, [f.to_api() for f in r.findings])
        self.assertEqual(r.checkpoints_checked, 3)
        keys = [self.read_file(n)["payload"]["signing_key_id"] for n in (1, 2, 3)]
        self.assertEqual(keys, ["test-signer-v1", "test-signer-v1", "test-signer-v2"])
        self.assertEqual(self.read_file(3)["payload"]["key_version"], 2)
        self.assertEqual(rotated["status"], "ACTIVE")

    async def test_the_old_checkpoints_still_verify_with_the_retired_public_key(self):
        chain = await self.signed_chain()
        await self.signer.service.rotate()
        env = self.env
        registry = self.signer.service.keys.registry(env)
        retired = registry.get("test-signer-v1")
        self.assertEqual(retired.status, "RETIRED")
        for n in (1, 2):
            envelope = self.read_file(n)
            self.assertTrue(cp.verify_payload(retired.public_key, envelope["payload"], envelope["signature"]))
        self.assertEqual((await self.verify(chain)).state, sv.VERIFIED)

    async def test_a_retired_key_cannot_be_used_to_sign_new_checkpoints(self):
        chain = await self.signed_chain()
        old_private = self.signer.service.keys.load_private(1)
        await self.signer.service.rotate()
        await self.events(2, start=10)
        p = dict(self.read_file(2)["payload"], checkpoint_id=str(uuid4()), checkpoint_number=3, start_sequence=11, end_sequence=12, event_count=2,
                 created_at=format_timestamp(datetime.now(timezone.utc) + timedelta(seconds=1)),
                 previous_checkpoint_hash=self.read_file(2)["checkpoint_hash"])
        last = (await self.fetch("SELECT current_hash FROM events WHERE chain_id = :c AND sequence_number = 12", c=chain))[0]["current_hash"]
        p["last_event_hash"] = last
        backdated_after_retirement = cp.make_envelope(p, cp.sign_payload(old_private, p))
        self.file(1).parent.joinpath("checkpoint-000003.json").write_text(json.dumps(backdated_after_retirement))
        r = await self.verify(chain)
        self.assertIn("KEY_NOT_ACTIVE_AT_SIGNING", self.codes(r))
        self.assertEqual(r.state, sv.UNTRUSTED_SIGNER)


class BackdatingTests(AnchoredCase):
    async def test_a_backdated_checkpoint_is_flagged_and_the_signer_never_lets_time_run_backwards(self):
        chain = await self.signed_chain()
        first = self.read_file(1)["payload"]["created_at"]
        # The signer's clock steps backwards: its next checkpoint still isn't earlier than the previous one.
        self.clock.offset = timedelta(days=-1)
        await self.events(2, start=10)
        await self.checkpoint(chain)
        third = self.read_file(3)["payload"]["created_at"]
        self.assertGreaterEqual(third, self.read_file(2)["payload"]["created_at"])
        self.assertEqual((await self.verify(chain)).state, sv.VERIFIED)
        # Someone holding the real key forges a validly signed checkpoint dated before its predecessor.
        key = self.signer.service.keys.load_private(1)
        payload = dict(self.read_file(3)["payload"], created_at=first)
        forged = cp.make_envelope(payload, cp.sign_payload(key, payload))
        self.write_file(3, forged)
        r = await self.verify(chain)
        self.assertIn("CHECKPOINT_TIME_REGRESSION", self.codes(r))
        self.assertNotEqual(r.state, sv.VERIFIED)


class HistoryTests(AnchoredCase):
    async def test_verification_results_are_recorded_and_cannot_be_changed(self):
        chain = await self.signed_chain()
        run = await iv.record_run(await self.verify(chain), "ON_DEMAND", "tester")
        [row] = await self.fetch("SELECT * FROM anchor_verification_runs WHERE run_id = :r", r=run)
        self.assertEqual((row["state"], row["checkpoints_checked"], row["requested_by"], row["anchored"]), ("VERIFIED", 2, "tester", True))
        for sql in ("UPDATE anchor_verification_runs SET state = 'VERIFIED'", "DELETE FROM anchor_verification_runs"):
            with self.assertRaises(Exception):
                async with db.transaction() as conn:
                    await conn.execute(text(sql))

    async def test_a_failed_verification_raises_an_alert(self):
        chain = await self.signed_chain()
        self.file(2).chmod(0o644)
        self.file(2).unlink()
        await iv.record_run(await self.verify(chain), "SCHEDULED", None)
        kinds = [a["kind"] for a in await self.fetch("SELECT kind FROM checkpoint_alerts WHERE chain_id = :c", c=chain)]
        self.assertEqual(kinds, ["VERIFICATION_MISSING_CHECKPOINT"])

    async def test_verify_all_covers_every_chain(self):
        good = await self.signed_chain()
        bad_tenant = uuid4()
        bad = await self.events(5, tenant=bad_tenant)
        await self.checkpoint(bad)
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE events SET action = 'x' WHERE chain_id = :c AND sequence_number = 2"), {"c": bad})
        with override_settings(checkpoint_directory=str(self.signer.checkpoints_dir)):
            results = {r.chain_id: r for r in await iv.verify_all_anchored("SCHEDULED")}
        self.assertEqual((results[good].state, results[bad].state), (sv.VERIFIED, sv.INVALID_HASH_CHAIN))
