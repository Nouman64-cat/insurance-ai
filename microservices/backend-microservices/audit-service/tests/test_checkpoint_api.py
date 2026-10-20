"""Checkpoint HTTP API: access control, tenant isolation, progress, verification, rotation. Real signer behind it."""
import json
from uuid import uuid4

import httpx
from sqlalchemy import text

from app import auth
from app.main import app
from app.verification import signature_verifier as sv
from tests.signing_support import StageTwoCase


class CheckpointApiCase(StageTwoCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        await self.signer.init()
        auth.clear_cache()
        self.tenant_a, self.tenant_b = uuid4(), uuid4()
        self.users = {}
        self.admin_a = self.add_user("Admin", self.tenant_a)
        self.admin_b = self.add_user("Admin", self.tenant_b)
        self.super = self.add_user("SuperAdmin", None)
        self.underwriter = self.add_user("Underwriter", self.tenant_a)

        async def fetch_me(token):
            return (200, self.users[token]) if token in self.users else (401, {"detail": "no"})

        self._fetch = auth.fetch_me
        auth.fetch_me = fetch_me
        app.state.signer = self.signer.client
        app.state.generator = self.signer.generator("api")
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://audit.test")
        self.chain_a = await self.events(6, tenant=self.tenant_a)
        self.chain_b = await self.events(3, tenant=self.tenant_b)

    async def asyncTearDown(self):
        await self.client.aclose()
        auth.fetch_me = self._fetch
        auth.clear_cache()
        app.state.signer = app.state.generator = None
        await super().asyncTearDown()

    def add_user(self, role, tenant):
        token = f"token-{uuid4().hex}"
        self.users[token] = {"id": str(uuid4()), "tenant_id": str(tenant) if tenant else None, "role_name": role, "full_name": f"{role} User",
                             "email": f"{role.lower()}@example.test", "is_active": True, "status": "ACTIVE"}
        return token

    async def get(self, path, token=None, **params):
        return await self.client.get(path, headers={"Authorization": f"Bearer {token}"} if token else {}, params=params)

    async def post(self, path, token=None, body=None):
        return await self.client.post(path, headers={"Authorization": f"Bearer {token}"} if token else {}, json=body or {})


class AccessTests(CheckpointApiCase):
    async def test_unauthenticated_and_unauthorised_roles_are_refused(self):
        for path in ("/v1/checkpoints/status", "/v1/checkpoints", "/v1/signing/keys", "/v1/checkpoints/verifications"):
            self.assertEqual((await self.get(path)).status_code, 401, path)
            self.assertEqual((await self.get(path, self.underwriter)).status_code, 403, path)
        self.assertEqual((await self.post("/v1/checkpoints/verify")).status_code, 401)
        self.assertEqual((await self.post("/v1/checkpoints/verify", self.underwriter)).status_code, 403)

    async def test_creating_checkpoints_and_rotating_keys_is_platform_administrator_only(self):
        self.assertEqual((await self.post("/v1/checkpoints/create", self.admin_a, {"chain_id": self.chain_a})).status_code, 403)
        self.assertEqual((await self.post("/v1/signing/rotate", self.admin_a)).status_code, 403)
        self.assertEqual((await self.post("/v1/signing/rotate")).status_code, 401)

    async def test_no_route_accepts_a_hash_or_signature_to_sign(self):
        for route in app.routes:
            path = getattr(route, "path", "")
            if "checkpoint" in path or "signing" in path:
                self.assertFalse({m for m in (getattr(route, "methods", None) or set()) if m in ("PUT", "PATCH", "DELETE")}, path)
        for method in ("put", "patch", "delete"):
            self.assertEqual((await getattr(self.client, method)("/v1/checkpoints", headers={"Authorization": f"Bearer {self.super}"})).status_code, 405)


class TenantIsolationTests(CheckpointApiCase):
    async def test_an_admin_only_sees_their_own_tenants_checkpoints(self):
        await self.checkpoint(self.chain_a)
        await self.checkpoint(self.chain_b)
        own = (await self.get("/v1/checkpoints", self.admin_a)).json()
        self.assertEqual((own["chain_id"], own["total"]), (self.chain_a, 1))
        self.assertEqual((await self.get("/v1/checkpoints", self.admin_a, chain_id=self.chain_b)).status_code, 404)
        foreign = (await self.get("/v1/checkpoints", self.admin_b)).json()["items"][0]["checkpoint_id"]
        self.assertEqual((await self.get(f"/v1/checkpoints/{foreign}", self.admin_a)).status_code, 404)
        self.assertEqual((await self.post(f"/v1/checkpoints/{foreign}/verify", self.admin_a)).status_code, 404)
        self.assertEqual((await self.post("/v1/checkpoints/verify", self.admin_a, {"chain_id": self.chain_b})).status_code, 404)
        status = (await self.get("/v1/checkpoints/status", self.admin_a)).json()
        self.assertEqual([c["chain_id"] for c in status["chains"]], [self.chain_a])
        self.assertEqual(sorted(c["chain_id"] for c in (await self.get("/v1/checkpoints/status", self.super)).json()["chains"]), sorted([self.chain_a, self.chain_b]))

    async def test_admin_alerts_are_limited_to_their_tenant(self):
        await self.checkpoint(self.chain_a)
        async with __import__("app.db", fromlist=["db"]).transaction() as conn:
            from app.checkpoints import repository as repo
            await repo.add_alert(conn, self.chain_b, str(self.tenant_b), "SIGNING_FAILED", "CRITICAL", "other tenant")
            await repo.add_alert(conn, self.chain_a, str(self.tenant_a), "SIGNING_FAILED", "CRITICAL", "my tenant")
        mine = (await self.get("/v1/checkpoints/status", self.admin_a)).json()["alerts"]
        self.assertEqual([a["message"] for a in mine], ["my tenant"])
        self.assertEqual(len((await self.get("/v1/checkpoints/status", self.super)).json()["alerts"]), 2)


class ProgressAndHistoryTests(CheckpointApiCase):
    async def test_status_reports_progress_toward_the_next_checkpoint(self):
        status = (await self.get("/v1/checkpoints/status", self.admin_a)).json()
        chain = status["chains"][0]
        self.assertEqual((chain["pending_events"], chain["event_threshold"], chain["events_until_threshold"], chain["interval_seconds"]), (6, 500, 494, 900))
        self.assertTrue(0 < chain["seconds_until_interval"] <= 900)
        self.assertFalse(chain["due"])
        self.assertIsNone(chain["last_checkpoint_number"])
        self.assertTrue(status["signing_enabled"] and status["storage_available"])
        self.assertEqual((status["signer"]["key_available"], status["registry"]["ok"], status["environment_label"]), (True, True, "local-dev"))
        self.assertEqual(status["registry"]["keys"][0]["status"], "ACTIVE")
        await self.checkpoint(self.chain_a)
        chain = (await self.get("/v1/checkpoints/status", self.admin_a)).json()["chains"][0]
        self.assertEqual((chain["pending_events"], chain["last_checkpoint_number"], chain["last_checkpoint_end_sequence"], chain["seconds_until_interval"]), (0, 1, 6, None))
        await self.events(2, tenant=self.tenant_a, start=6)
        chain = (await self.get("/v1/checkpoints/status", self.admin_a)).json()["chains"][0]
        self.assertEqual(chain["pending_events"], 2)

    async def test_history_pagination_and_detail(self):
        await self.checkpoint(self.chain_a)
        await self.events(3, tenant=self.tenant_a, start=6)
        await self.checkpoint(self.chain_a)
        page = (await self.get("/v1/checkpoints", self.admin_a, page_size=1)).json()
        self.assertEqual((page["total"], [c["checkpoint_number"] for c in page["items"]]), (2, [2]))
        item = page["items"][0]
        self.assertEqual((item["signature_algorithm"], item["signing_key_id"], item["key_version"], item["start_sequence"], item["end_sequence"]), ("Ed25519", "test-signer-v1", 1, 7, 9))
        detail = (await self.get(f"/v1/checkpoints/{item['checkpoint_id']}", self.admin_a)).json()
        self.assertEqual(json.loads(detail["canonical_payload"])["checkpoint_number"], 2)
        self.assertNotIn("private", json.dumps(detail).lower())

    async def test_manual_signature_verification_of_one_checkpoint(self):
        await self.checkpoint(self.chain_a)
        cid = (await self.get("/v1/checkpoints", self.admin_a)).json()["items"][0]["checkpoint_id"]
        ok = (await self.post(f"/v1/checkpoints/{cid}/verify", self.admin_a)).json()
        self.assertEqual((ok["state"], ok["signature_valid"], ok["signer_trusted"], ok["stored_copy_matches"]), (sv.VERIFIED, True, True, True))
        path = self.signer.checkpoints_dir / str(await self.environment_id()) / str(self.tenant_a) / "checkpoint-000001.json"
        path.chmod(0o644)
        path.unlink()
        gone = (await self.post(f"/v1/checkpoints/{cid}/verify", self.admin_a)).json()
        self.assertEqual(gone["state"], sv.MISSING_CHECKPOINT)

    async def test_full_anchored_verification_and_its_history(self):
        await self.checkpoint(self.chain_a)
        await self.events(2, tenant=self.tenant_a, start=6)
        first = (await self.post("/v1/checkpoints/verify", self.admin_a)).json()
        self.assertEqual((first["state"], first["hash_chain_valid"], first["signatures_valid"], first["signer_trusted"], first["anchored"], first["pending_events"]),
                         (sv.UNSIGNED_EVENTS_PENDING, True, True, True, True, 2))
        await self.rewrite_chain(self.chain_a, lambda row: row.update(new_value={"status": "Rewritten"}) if row["sequence_number"] == 1 else None)
        second = (await self.post("/v1/checkpoints/verify", self.admin_a)).json()
        self.assertEqual((second["state"], second["hash_chain_valid"], second["anchored"]), (sv.CHECKPOINT_MISMATCH, True, False))
        history = (await self.get("/v1/checkpoints/verifications", self.admin_a)).json()["items"]
        self.assertEqual([h["state"] for h in history], [sv.CHECKPOINT_MISMATCH, sv.UNSIGNED_EVENTS_PENDING])
        self.assertEqual((await self.get("/v1/checkpoints/verifications", self.admin_b)).json()["items"], [])

    async def test_stage_one_endpoints_still_work(self):
        self.assertEqual((await self.post("/v1/verification/run", self.admin_a)).json()["status"], "VALID")
        self.assertEqual((await self.get("/v1/chains", self.admin_a)).status_code, 200)


class PlatformAdministrationTests(CheckpointApiCase):
    async def test_creating_a_checkpoint_by_hand(self):
        result = (await self.post("/v1/checkpoints/create", self.super, {"chain_id": self.chain_b})).json()
        self.assertEqual((result["status"], result["checkpoint"]["checkpoint_number"], result["checkpoint"]["event_count"]), ("CREATED", 1, 3))
        again = (await self.post("/v1/checkpoints/create", self.super, {"chain_id": self.chain_b})).json()
        self.assertEqual(again["status"], "NOTHING_PENDING")

    async def test_rotation_through_the_api_keeps_history_verifiable(self):
        await self.checkpoint(self.chain_a)
        rotated = (await self.post("/v1/signing/rotate", self.super)).json()
        self.assertEqual((rotated["key_version"], rotated["status"]), (2, "ACTIVE"))
        keys = (await self.get("/v1/signing/keys", self.admin_a)).json()["keys"]
        self.assertEqual([(k["key_version"], k["status"]) for k in keys], [(1, "RETIRED"), (2, "ACTIVE")])
        mirrored = await self.fetch("SELECT key_version, status FROM signing_keys ORDER BY key_version")
        self.assertEqual([(r["key_version"], r["status"]) for r in mirrored], [(1, "RETIRED"), (2, "ACTIVE")])
        await self.events(2, tenant=self.tenant_a, start=6)
        await self.checkpoint(self.chain_a)
        verdict = (await self.post("/v1/checkpoints/verify", self.admin_a)).json()
        self.assertEqual((verdict["state"], verdict["checkpoints_checked"]), (sv.VERIFIED, 2))
        self.assertEqual([c["key_version"] for c in (await self.get("/v1/checkpoints", self.admin_a)).json()["items"]], [2, 1])

    async def test_the_database_mirror_of_keys_cannot_be_altered_by_the_application(self):
        await self.signer.service.rotate()
        from app.trust import key_registry
        from app import db
        async with db.transaction() as conn:
            await key_registry.sync_to_db(conn, key_registry.load_registry(str(await self.environment_id())))
        for sql in ("DELETE FROM signing_keys", "UPDATE signing_keys SET public_key = 'x'", "UPDATE signing_keys SET status = 'ACTIVE'"):
            with self.assertRaises(Exception):
                async with db.transaction() as conn:
                    await conn.execute(text(sql))
