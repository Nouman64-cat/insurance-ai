"""Independent installations (two developers' laptops) and tenants sharing one installation must never share or conflict."""
import json
import shutil
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from app import db
from app.services import audit_service
from app.verification import integrity_verifier as iv
from app.verification import signature_verifier as sv
from app.checkpoints.storage import TrustedStorage
from shared.audit import checkpoint as cp
from shared.audit.signer.errors import SignerError
from tests.signing_support import SignerHarness, StageTwoCase, override_settings
from tests.support import TestDatabase, intent


class IsolationTests(StageTwoCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.tenant = uuid4()
        # "Developer B": a completely separate installation: its own database, keys, secrets, state and checkpoint store.
        self.other_db = TestDatabase()
        await self.other_db.create()
        self.other_tmp = Path(tempfile.mkdtemp(prefix="audit-dev-b-"))
        self.other = SignerHarness(self.other_db, self.other_tmp, signer_id="test-signer", clock=self.clock)

    async def asyncTearDown(self):
        await self.other.close()
        shutil.rmtree(self.other_tmp, ignore_errors=True)
        await self.other_db.drop()
        await super().asyncTearDown()

    @asynccontextmanager
    async def installation(self, which: str):
        """Run code 'inside' installation A or B: its database, its protected store."""
        database, harness = (self.database, self.signer) if which == "A" else (self.other_db, self.other)
        await db.dispose()
        db.configure(database.app_url)
        with override_settings(checkpoint_directory=str(harness.checkpoints_dir)):
            try:
                yield harness
            finally:
                await db.dispose()
                db.configure(self.database.app_url)

    async def signed(self, which: str, tenant, count: int = 5):
        async with self.installation(which) as harness:
            chain = f"{(await harness.service.source.environment_id())}:{tenant}"
            await audit_service.ingest([intent(tenant, i) for i in range(count)])
            outcome = await harness.generator("w").checkpoint_chain(chain)
            self.assertEqual(outcome.status, "CREATED", outcome.error)
            return chain

    async def test_two_installations_have_different_identities_keys_and_paths(self):
        a = await self.signer.init()
        b = await self.other.init()
        env_a, env_b = await self.signer.service.source.environment_id(), await self.other.service.source.environment_id()
        self.assertNotEqual(env_a, env_b)
        self.assertNotEqual(a.fingerprint, b.fingerprint)
        self.assertNotEqual(a.public_key, b.public_key)
        chain_a, chain_b = await self.signed("A", self.tenant), await self.signed("B", self.tenant)       # even the SAME tenant id
        self.assertNotEqual(chain_a, chain_b)
        files_a = sorted(str(p.relative_to(self.signer.checkpoints_dir)) for p in self.signer.checkpoints_dir.rglob("checkpoint-*.json"))
        files_b = sorted(str(p.relative_to(self.other.checkpoints_dir)) for p in self.other.checkpoints_dir.rglob("checkpoint-*.json"))
        self.assertEqual(files_a, [f"{env_a}/{self.tenant}/checkpoint-000001.json"])
        self.assertEqual(files_b, [f"{env_b}/{self.tenant}/checkpoint-000001.json"])
        envelope_a = json.loads((self.signer.checkpoints_dir / files_a[0]).read_text())
        envelope_b = json.loads((self.other.checkpoints_dir / files_b[0]).read_text())
        self.assertNotEqual(envelope_a["checkpoint_hash"], envelope_b["checkpoint_hash"])
        self.assertFalse(cp.verify_payload(a.public_key, envelope_b["payload"], envelope_b["signature"]))   # B's signature means nothing to A

    async def test_both_installations_sign_at_the_same_time_without_conflict(self):
        """Two independent signers (each with its own keys, state, store and database) signing the same tenant id concurrently."""
        import asyncio
        await self.signer.init()
        await self.other.init()
        chains = {}
        for which, count in (("A", 4), ("B", 7)):
            async with self.installation(which) as harness:
                chains[which] = f"{await harness.service.source.environment_id()}:{self.tenant}"
                await audit_service.ingest([intent(self.tenant, i) for i in range(count)])
        a, b = await asyncio.gather(self.signer.service.sign_checkpoint(chains["A"]), self.other.service.sign_checkpoint(chains["B"]))
        self.assertEqual((a["envelope"]["payload"]["event_count"], b["envelope"]["payload"]["event_count"]), (4, 7))
        self.assertNotEqual(a["envelope"]["payload"]["signing_key_id"] + a["envelope"]["signature"], b["envelope"]["payload"]["signing_key_id"] + b["envelope"]["signature"])
        self.assertNotEqual(a["envelope"]["payload"]["environment_id"], b["envelope"]["payload"]["environment_id"])

    async def test_a_checkpoint_imported_from_another_installation_is_not_trusted(self):
        await self.signer.init()
        await self.other.init()
        chain_a = await self.signed("A", self.tenant)
        await self.signed("B", self.tenant)
        env_a = str(await self.environment_id())
        foreign = json.loads((self.other.checkpoints_dir / next(iter(sorted(p.relative_to(self.other.checkpoints_dir) for p in self.other.checkpoints_dir.rglob("checkpoint-*.json"))))).read_text())
        target = self.signer.checkpoints_dir / env_a / str(self.tenant) / "checkpoint-000001.json"
        target.chmod(0o644)
        target.write_text(json.dumps(foreign))
        async with self.installation("A"):
            result = await iv.verify_anchored(chain_a, storage=TrustedStorage(str(self.signer.checkpoints_dir)))
        self.assertNotEqual(result.state, sv.VERIFIED)
        self.assertIn(result.state, (sv.CHECKPOINT_MISMATCH, sv.UNTRUSTED_SIGNER, sv.INVALID_SIGNATURE))

    async def test_keys_of_one_installation_cannot_sign_for_another_database(self):
        await self.signer.init()
        await self.other.init()
        async with self.installation("A"):
            await audit_service.ingest([intent(self.tenant, i) for i in range(3)])
        # Developer B copies A's key material and registry onto a signer that points at B's database.
        shutil.copytree(self.signer.settings.key_dir, self.other_tmp / "stolen-keys")
        stolen = SignerHarness(self.other_db, self.other_tmp / "stolen", clock=self.clock)
        shutil.copytree(self.signer.settings.checkpoint_dir / "trust", stolen.settings.checkpoint_dir / "trust")
        shutil.copytree(self.other_tmp / "stolen-keys", stolen.settings.key_dir)
        (stolen.settings.passphrase_file.parent).mkdir(parents=True, exist_ok=True)
        shutil.copy(self.signer.settings.passphrase_file, stolen.settings.passphrase_file)
        async with self.installation("B"):
            await audit_service.ingest([intent(self.tenant, i) for i in range(3)])
            chain_b = f"{await stolen.service.source.environment_id()}:{self.tenant}"
            with self.assertRaises(SignerError) as ctx:
                await stolen.service.sign_checkpoint(chain_b)
        self.assertEqual(ctx.exception.code, "ENVIRONMENT_MISMATCH")
        await stolen.close()

    async def test_a_recreated_database_does_not_silently_reuse_old_keys(self):
        await self.signer.init()
        await self.signed("A", self.tenant)
        replacement = TestDatabase()          # the same keys, but the database was wiped and re-initialised: a NEW environment id
        await replacement.create()
        try:
            harness = SignerHarness(replacement, self.tmp, clock=self.clock)
            status = await harness.service.status()
            self.assertFalse(status["key_available"])
            self.assertIn("ENVIRONMENT_MISMATCH", status["problem"])
            await harness.close()
        finally:
            await replacement.drop()

    async def test_tenants_in_one_installation_have_separate_checkpoint_chains_and_files(self):
        await self.signer.init()
        t1, t2 = uuid4(), uuid4()
        c1, c2 = await self.signed("A", t1, 4), await self.signed("A", t2, 9)
        env = str(await self.environment_id())
        self.assertTrue((self.signer.checkpoints_dir / env / str(t1) / "checkpoint-000001.json").exists())
        self.assertTrue((self.signer.checkpoints_dir / env / str(t2) / "checkpoint-000001.json").exists())
        p1 = json.loads((self.signer.checkpoints_dir / env / str(t1) / "checkpoint-000001.json").read_text())["payload"]
        p2 = json.loads((self.signer.checkpoints_dir / env / str(t2) / "checkpoint-000001.json").read_text())["payload"]
        self.assertEqual((p1["tenant_id"], p1["event_count"], p2["tenant_id"], p2["event_count"]), (str(t1), 4, str(t2), 9))
        self.assertNotEqual(p1["previous_checkpoint_hash"], p2["previous_checkpoint_hash"])        # each chain has its own checkpoint genesis
        async with self.installation("A"):
            for chain in (c1, c2):
                r = await iv.verify_anchored(chain, storage=TrustedStorage(str(self.signer.checkpoints_dir)))
                self.assertEqual(r.state, sv.VERIFIED, [f.to_api() for f in r.findings])
            platform = await self.signed_platform()
        self.assertTrue((self.signer.checkpoints_dir / env / "platform" / "checkpoint-000001.json").exists())
        self.assertEqual(platform, "OK")

    async def signed_platform(self):
        await audit_service.ingest([intent(None, 1, module="administration", action="tenant.created")])
        chain = f"{await self.environment_id()}:platform"
        outcome = await self.signer.generator("w").checkpoint_chain(chain)
        return "OK" if outcome.status == "CREATED" else outcome.error
