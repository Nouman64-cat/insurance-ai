"""The signer: what it signs, what it refuses, and how it recovers. Real keys, real files, real read-only database role."""
import json
from pathlib import Path
from unittest import mock
from uuid import uuid4

import httpx
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.signing.interface import SigningError
from shared.audit import checkpoint as cp
from shared.audit import hashing
from shared.audit.signer.errors import SignerError
from shared.audit.signer.files import CheckpointStore
from shared.security import service_auth
from tests.signing_support import SERVICE_KEY, StageTwoCase, SignerHarness, intent


class SigningTests(StageTwoCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.trusted = await self.signer.init()
        self.env = await self.environment_id()

    async def sign(self, chain, **kw):
        return await self.signer.service.sign_checkpoint(chain, **kw)

    async def test_the_first_checkpoint_commits_to_the_whole_range_from_the_genesis(self):
        chain = await self.events(7)
        result = await self.sign(chain)
        p = result["envelope"]["payload"]
        last = (await self.fetch("SELECT current_hash FROM events WHERE chain_id = :c AND sequence_number = 7", c=chain))[0]["current_hash"]
        self.assertEqual((p["checkpoint_number"], p["start_sequence"], p["end_sequence"], p["event_count"]), (1, 1, 7, 7))
        self.assertEqual((p["last_event_hash"], p["previous_checkpoint_hash"]), (last, cp.checkpoint_genesis_hash(chain)))
        self.assertEqual((p["tenant_id"], p["environment_id"], p["chain_id"]), (str(self.tenant), str(self.env), chain))
        self.assertEqual((p["signer_id"], p["signing_key_id"], p["key_version"], p["signature_algorithm"], p["payload_version"]),
                         ("test-signer", "test-signer-v1", 1, "Ed25519", 1))
        self.assertTrue(cp.verify_payload(self.trusted.public_key, p, result["envelope"]["signature"]))
        self.assertEqual(result["path"], f"{self.env}/{self.tenant}/checkpoint-000001.json")
        self.assertEqual(CheckpointStore(self.signer.checkpoints_dir).read(str(self.env), str(self.tenant), 1), result["envelope"])

    async def test_checkpoints_link_to_each_other_and_continue_the_sequence(self):
        chain = await self.events(5)
        first = (await self.sign(chain))["envelope"]
        await self.events(4, start=5)
        second = (await self.sign(chain))["envelope"]
        p = second["payload"]
        self.assertEqual((p["checkpoint_number"], p["start_sequence"], p["end_sequence"], p["event_count"]), (2, 6, 9, 4))
        self.assertEqual(p["previous_checkpoint_hash"], first["checkpoint_hash"])
        self.assertEqual((await self.fetch("SELECT head_sequence FROM chains WHERE chain_id = :c", c=chain))[0]["head_sequence"], 9)   # the chain was not reset

    async def test_nothing_new_means_nothing_to_sign(self):
        chain = await self.events(3)
        await self.sign(chain)
        with self.assertRaises(SignerError) as ctx:
            await self.sign(chain)
        self.assertEqual(ctx.exception.code, "NOTHING_TO_SIGN")
        with self.assertRaises(SignerError) as ctx:
            await self.sign(await self.chain_id(uuid4()))
        self.assertEqual(ctx.exception.code, "CHAIN_NOT_FOUND")

    async def test_it_signs_what_it_computed_not_what_it_was_told(self):
        chain = await self.events(6)
        for name, wrong in (("last_event_hash", "f" * 64), ("end_sequence", 5), ("event_count", 99), ("previous_checkpoint_hash", "e" * 64),
                            ("checkpoint_number", 4), ("start_sequence", 2)):
            with self.subTest(name=name), self.assertRaises(SignerError) as ctx:
                await self.sign(chain, proposal={name: wrong})
            self.assertEqual(ctx.exception.code, "PROPOSAL_MISMATCH")
        self.assertEqual(CheckpointStore(self.signer.checkpoints_dir).numbers(str(self.env), str(self.tenant)), [])
        ok = await self.sign(chain, proposal={"checkpoint_number": 1, "start_sequence": 1, "end_sequence": 6, "event_count": 6})
        self.assertEqual(ok["envelope"]["payload"]["end_sequence"], 6)

    async def test_the_api_has_no_way_to_submit_a_hash_to_sign(self):
        chain = await self.events(2)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.signer.app), base_url="http://s") as client:
            body = json.dumps({"chain_id": chain, "last_event_hash": "a" * 64, "payload": {"x": 1}, "signature": "x"}).encode()
            headers = service_auth.sign(SERVICE_KEY, "POST", "/v1/checkpoints/sign", body, caller="audit-service")
            response = await client.post("/v1/checkpoints/sign", content=body, headers={**headers, "content-type": "application/json"})
        self.assertEqual(response.status_code, 422)          # unknown fields are refused outright

    async def test_requests_must_be_signed_by_the_audit_service(self):
        chain = await self.events(2)
        body = json.dumps({"chain_id": chain}).encode()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.signer.app), base_url="http://s") as client:
            async def post(headers):
                return (await client.post("/v1/checkpoints/sign", content=body, headers={**headers, "content-type": "application/json"})).status_code
            self.assertEqual(await post({}), 401)
            self.assertEqual(await post(service_auth.sign("wrong-key" * 6, "POST", "/v1/checkpoints/sign", body, caller="audit-service")), 401)
            self.assertEqual(await post(service_auth.sign(SERVICE_KEY, "POST", "/v1/checkpoints/sign", body, caller="tenant-service")), 401)
            good = service_auth.sign(SERVICE_KEY, "POST", "/v1/checkpoints/sign", body, caller="audit-service")
            self.assertEqual(await post(good), 200)
            tampered = json.dumps({"chain_id": chain, "end_sequence": 1}).encode()          # a captured signature can't be reused for another body
            replay = (await client.post("/v1/checkpoints/sign", content=tampered, headers={**good, "content-type": "application/json"})).status_code
            self.assertEqual(replay, 401)
            for path in ("/v1/status", "/v1/keys"):
                self.assertEqual((await client.get(path)).status_code, 401)
            self.assertEqual((await client.post("/v1/keys/rotate")).status_code, 401)

    async def test_rewritten_history_is_not_signed_over(self):
        chain = await self.events(5)
        await self.sign(chain)
        await self.events(3, start=5)
        await self.rewrite_chain(chain, lambda row: row.update(new_value={"status": "Rewritten"}))   # perfectly consistent, Stage 1 sees nothing
        with self.assertRaises(SignerError) as ctx:
            await self.sign(chain)
        self.assertEqual(ctx.exception.code, "ANCHOR_MISMATCH")
        self.assertEqual(CheckpointStore(self.signer.checkpoints_dir).numbers(str(self.env), str(self.tenant)), [1])

    async def test_a_truncated_chain_is_not_signed_over(self):
        chain = await self.events(5)
        await self.sign(chain)
        async with self.privileged() as conn:
            await conn.execute(text("DELETE FROM events WHERE chain_id = :c AND sequence_number >= 4"), {"c": chain})
        with self.assertRaises(SignerError) as ctx:
            await self.sign(chain)
        self.assertEqual(ctx.exception.code, "CHAIN_TRUNCATED")

    async def test_new_events_that_do_not_link_to_the_trusted_history_are_refused(self):
        chain = await self.events(4)
        await self.sign(chain)
        await self.events(3, start=4)
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE events SET previous_hash = repeat('9', 64) WHERE chain_id = :c AND sequence_number = 5"), {"c": chain})
        with self.assertRaises(SignerError) as ctx:
            await self.sign(chain)
        self.assertEqual(ctx.exception.code, "HASH_CHAIN_BROKEN")

    async def test_a_modified_unsigned_event_is_not_signed(self):
        chain = await self.events(4)
        async with self.privileged() as conn:
            await conn.execute(text("""UPDATE events SET new_value = '{"status": "Hacked"}'::jsonb WHERE chain_id = :c AND sequence_number = 3"""), {"c": chain})
        with self.assertRaises(SignerError) as ctx:
            await self.sign(chain)
        self.assertEqual(ctx.exception.code, "HASH_CHAIN_BROKEN")

    async def test_the_signer_only_has_read_access_to_the_ledger(self):
        engine = self.signer.service.source.engine()
        for sql in ("DELETE FROM events", "UPDATE chains SET head_sequence = 0", "INSERT INTO checkpoints (checkpoint_id) VALUES (gen_random_uuid())",
                    "SELECT * FROM verification_runs", "SELECT * FROM checkpoints", "TRUNCATE events"):
            with self.subTest(sql=sql), self.assertRaises(DBAPIError):
                async with engine.begin() as conn:
                    await conn.execute(text(sql))
        async with engine.connect() as conn:
            self.assertGreaterEqual((await conn.execute(text("SELECT count(*) FROM events"))).scalar(), 0)

    async def test_a_checkpoint_is_capped_and_the_rest_follows(self):
        harness = SignerHarness(self.database, self.tmp / "capped", max_events=4, clock=self.clock)
        await harness.init()
        chain = await self.events(10)
        ends = []
        for _ in range(3):
            ends.append((await harness.service.sign_checkpoint(chain))["envelope"]["payload"]["end_sequence"])
        self.assertEqual(ends, [4, 8, 10])
        await harness.close()

    async def test_environment_mismatch_is_refused(self):
        chain = await self.events(2)
        registry = self.signer.service.store.read_registry()
        self.signer.service.store.registry_path.chmod(0o644)
        registry["environment_id"] = str(uuid4())
        self.signer.service.store.registry_path.write_text(json.dumps(registry))
        with self.assertRaises(SignerError) as ctx:
            await self.sign(chain)
        self.assertEqual(ctx.exception.code, "ENVIRONMENT_MISMATCH")
        status = await self.signer.service.status()
        self.assertFalse(status["key_available"])


class RecoveryTests(StageTwoCase):
    replica = True

    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.signer.init()
        self.env = await self.environment_id()

    async def test_restart_continues_the_checkpoint_chain(self):
        chain = await self.events(5)
        first = (await self.signer.service.sign_checkpoint(chain))["envelope"]
        await self.signer.restart()
        await self.events(2, start=5)
        second = (await self.signer.service.sign_checkpoint(chain))["envelope"]
        self.assertEqual(second["payload"]["previous_checkpoint_hash"], first["checkpoint_hash"])
        self.assertEqual(second["payload"]["checkpoint_number"], 2)

    async def test_a_crash_after_the_file_was_stored_adopts_it_instead_of_signing_again(self):
        chain = await self.events(5)
        service = self.signer.service
        first = (await service.sign_checkpoint(chain))["envelope"]
        await self.events(3, start=5)
        with mock.patch.object(service.state, "save", side_effect=RuntimeError("crash after the file was stored, before state was saved")):
            with self.assertRaises(RuntimeError):
                await service.sign_checkpoint(chain)
        store = CheckpointStore(self.signer.checkpoints_dir)
        stored = store.read(str(self.env), str(self.tenant), 2)
        self.assertIsNotNone(stored)
        self.assertEqual(stored["payload"]["previous_checkpoint_hash"], first["checkpoint_hash"])
        await self.events(4, start=8)                       # the world moved on while the signer was down
        again = await service.sign_checkpoint(chain)
        self.assertTrue(again["idempotent"])
        self.assertEqual(again["envelope"], stored)         # the original signature, never a second one for the same number
        self.assertEqual(store.numbers(str(self.env), str(self.tenant)), [1, 2])
        nxt = (await service.sign_checkpoint(chain))["envelope"]["payload"]
        self.assertEqual((nxt["checkpoint_number"], nxt["start_sequence"], nxt["end_sequence"]), (3, 9, 12))

    async def test_a_crash_on_the_very_first_checkpoint_is_recovered_from_the_stored_file(self):
        chain = await self.events(5)
        service = self.signer.service
        with mock.patch.object(service.state, "save", side_effect=RuntimeError("crash")):
            with self.assertRaises(RuntimeError):
                await service.sign_checkpoint(chain)
        stored = CheckpointStore(self.signer.checkpoints_dir).read(str(self.env), str(self.tenant), 1)
        await self.events(2, start=5)
        second = (await service.sign_checkpoint(chain))["envelope"]["payload"]
        self.assertEqual((second["checkpoint_number"], second["previous_checkpoint_hash"]), (2, stored["checkpoint_hash"]))

    async def test_lost_signer_state_is_rebuilt_from_the_signed_files(self):
        import shutil
        chain = await self.events(4)
        first = (await self.signer.service.sign_checkpoint(chain))["envelope"]
        shutil.rmtree(self.tmp / "state")
        await self.signer.restart()
        await self.events(2, start=4)
        second = (await self.signer.service.sign_checkpoint(chain))["envelope"]
        self.assertEqual(second["payload"]["previous_checkpoint_hash"], first["checkpoint_hash"])

    async def test_a_deleted_checkpoint_file_stops_signing_instead_of_forking_the_chain(self):
        chain = await self.events(4)
        await self.signer.service.sign_checkpoint(chain)
        path = self.signer.checkpoints_dir / str(self.env) / str(self.tenant) / "checkpoint-000001.json"
        path.chmod(0o644)
        path.unlink()
        await self.events(2, start=4)
        with self.assertRaises(SignerError) as ctx:
            await self.signer.service.sign_checkpoint(chain)
        self.assertEqual(ctx.exception.code, "STATE_STORE_MISMATCH")

    async def test_an_existing_checkpoint_is_never_overwritten(self):
        chain = await self.events(3)
        store = CheckpointStore(self.signer.checkpoints_dir)
        store.write(str(self.env), str(self.tenant), 1, {"planted": "by an attacker"})
        with self.assertRaises(SignerError):               # the planted file is not a valid, trusted checkpoint
            await self.signer.service.sign_checkpoint(chain)
        self.assertEqual(store.read(str(self.env), str(self.tenant), 1), {"planted": "by an attacker"})

    async def test_the_replica_receives_every_checkpoint(self):
        chain = await self.events(3)
        result = await self.signer.service.sign_checkpoint(chain)
        self.assertEqual(result["replica"], "ok")
        replica = CheckpointStore(self.tmp / "replica")
        self.assertEqual(replica.read(str(self.env), str(self.tenant), 1), result["envelope"])

    async def test_a_failing_required_replica_fails_the_checkpoint_loudly(self):
        harness = SignerHarness(self.database, self.tmp / "strict", replica=True, replica_required=True, clock=self.clock)
        await harness.init()
        chain = await self.events(3)
        # make the replica location unwritable (a file where its directory should be)
        replica_root = self.tmp / "strict" / "replica"
        replica_root.parent.mkdir(parents=True, exist_ok=True)
        replica_root.write_text("a file where the replica directory should be")
        with self.assertRaises(SignerError) as ctx:
            await harness.service.sign_checkpoint(chain)
        self.assertEqual(ctx.exception.code, "REPLICA_FAILED")
        await harness.close()

    async def test_storage_failure_means_not_signed(self):
        chain = await self.events(3)
        service = self.signer.service
        with mock.patch.object(CheckpointStore, "write", side_effect=OSError("disk full")):
            with self.assertRaises(SignerError) as ctx:
                await service.sign_checkpoint(chain)
        self.assertEqual(ctx.exception.code, "STORAGE_FAILED")
        self.assertIsNone(service.state.load(chain))                        # state did not advance
        ok = await service.sign_checkpoint(chain)                           # and a retry then succeeds
        self.assertEqual(ok["envelope"]["payload"]["checkpoint_number"], 1)
