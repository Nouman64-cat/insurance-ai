"""Archive & retention HTTP API: access control, tenant isolation, auditing of sensitive actions, and the end-to-end flows."""
from uuid import uuid4

import httpx
from sqlalchemy import text

from app import auth
from app.archive.service import ArchiveServices
from app.main import app
from tests.archive_support import ArchiveCase
from tests.signing_support import override_settings


class ArchiveApiCase(ArchiveCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self._roles = override_settings(read_roles=frozenset({"Admin", "SuperAdmin"}))   # tenant Admin access is opt-in
        self._roles.__enter__()
        auth.clear_cache()
        self.tenant_a, self.tenant_b = uuid4(), uuid4()
        self.users = {}
        self.admin_a, self.admin_b = self.add_user("Admin", self.tenant_a), self.add_user("Admin", self.tenant_b)
        self.super = self.add_user("SuperAdmin", None)
        self.underwriter = self.add_user("Underwriter", self.tenant_a)

        async def fetch_me(token):
            return (200, self.users[token]) if token in self.users else (401, {"detail": "no"})

        self._fetch = auth.fetch_me
        auth.fetch_me = fetch_me
        w = self.worker()
        self.services = ArchiveServices(w, self.cleanup_service(w), self.retrieval_service(w), w.verifier, self.store, self.store, self.keyring, w.storage)
        app.state.signer, app.state.generator, app.state.archive = self.signer.client, self.signer.generator("api"), self.services
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://audit.test")
        self.chain_a, self.row_a = await self.archived_chain(40, tenant=self.tenant_a)
        self.chain_b, self.row_b = await self.archived_chain(30, tenant=self.tenant_b)

    async def asyncTearDown(self):
        await self.client.aclose()
        auth.fetch_me = self._fetch
        auth.clear_cache()
        app.state.signer = app.state.generator = app.state.archive = None
        self._roles.__exit__(None, None, None)
        await super().asyncTearDown()

    def add_user(self, role, tenant):
        token = f"token-{uuid4().hex}"
        self.users[token] = {"id": str(uuid4()), "tenant_id": str(tenant) if tenant else None, "role_name": role, "full_name": f"{role} User",
                             "email": f"{role.lower()}@example.test", "is_active": True, "status": "ACTIVE"}
        return token

    def headers(self, token):
        return {"Authorization": f"Bearer {token}"} if token else {}

    async def get(self, path, token=None, **params):
        return await self.client.get(path, headers=self.headers(token), params=params)

    async def post(self, path, token=None, body=None):
        return await self.client.post(path, headers=self.headers(token), json=body or {})

    async def put(self, path, token=None, body=None):
        return await self.client.put(path, headers=self.headers(token), json=body or {})


class AccessTests(ArchiveApiCase):
    async def test_unauthenticated_and_unauthorised_roles_are_refused_everywhere(self):
        paths = ["/v1/archive/status", "/v1/archive/catalog", "/v1/archive/jobs", "/v1/archive/policies", "/v1/archive/holds", "/v1/archive/retrievals"]
        for path in paths:
            self.assertEqual((await self.get(path)).status_code, 401, path)
            self.assertEqual((await self.get(path, self.underwriter)).status_code, 403, path)

    async def test_controls_are_platform_administrator_only(self):
        for method, path, body in (("post", "/v1/archive/run", {"dry_run": True}), ("put", "/v1/archive/policies", {"category": "claims", "hot_retention_months": 6}),
                                   ("post", "/v1/archive/holds", {"reason": "because", "tenant_id": str(self.tenant_a)}),
                                   ("get", "/v1/archive/cleanup/plan", None), ("post", "/v1/archive/cleanup", {"dry_run": True})):
            call = getattr(self, method)
            self.assertEqual((await call(path, self.admin_a, body) if body is not None else await call(path, self.admin_a)).status_code, 403, path)

    async def test_there_is_no_delete_or_update_route_for_archives(self):
        for route in app.routes:
            path = getattr(route, "path", "")
            if path.startswith("/v1/archive"):
                self.assertFalse({m for m in (getattr(route, "methods", None) or set()) if m in ("PATCH", "DELETE")}, path)
        self.assertEqual((await self.client.delete(f"/v1/archive/catalog/{self.row_a['archive_id']}", headers=self.headers(self.super))).status_code, 405)


class TenantIsolationTests(ArchiveApiCase):
    async def test_an_admin_sees_only_their_own_tenants_archives(self):
        own = (await self.get("/v1/archive/catalog", self.admin_a)).json()
        self.assertEqual((own["total"], own["items"][0]["chain_id"]), (1, self.chain_a))
        self.assertEqual((await self.get("/v1/archive/catalog", self.super)).json()["total"], 2)
        self.assertEqual((await self.get(f"/v1/archive/catalog/{self.row_b['archive_id']}", self.admin_a)).status_code, 404)
        self.assertEqual((await self.get("/v1/archive/catalog", self.admin_a, chain_id=self.chain_b)).json()["total"], 0)

    async def test_foreign_archives_cannot_be_verified_downloaded_or_retrieved(self):
        foreign = str(self.row_b["archive_id"])
        self.assertEqual((await self.post("/v1/archive/verify", self.admin_a, {"archive_id": foreign})).status_code, 404)
        self.assertEqual((await self.get(f"/v1/archive/catalog/{foreign}/evidence", self.admin_a)).status_code, 404)
        self.assertEqual((await self.post("/v1/archive/retrievals", self.admin_a, {"chain_id": self.chain_b})).status_code, 422)
        self.assertEqual((await self.post("/v1/archive/retrievals", self.admin_a, {"archive_ids": [foreign]})).status_code, 422)
        self.assertEqual((await self.post("/v1/archive/verify-chain", self.admin_a, {"chain_id": self.chain_b})).status_code, 404)

    async def test_jobs_retrievals_holds_and_status_are_scoped(self):
        jobs = (await self.get("/v1/archive/jobs", self.admin_a)).json()["items"]
        self.assertEqual({j["chain_id"] for j in jobs}, {self.chain_a})
        foreign_job = (await self.fetch("SELECT job_id FROM archive_jobs WHERE chain_id = :c", c=self.chain_b))[0]["job_id"]
        self.assertEqual((await self.get(f"/v1/archive/jobs/{foreign_job}", self.admin_a)).status_code, 404)
        status = (await self.get("/v1/archive/status", self.admin_a)).json()
        self.assertEqual(status["summary"]["archives"], 1)
        self.assertIsNone(status["partitions"], "partition internals are platform-wide and only for the platform administrator")
        r = (await self.post("/v1/archive/retrievals", self.admin_b, {"chain_id": self.chain_b})).json()
        self.assertEqual((await self.get(f"/v1/archive/retrievals/{r['retrieval_id']}", self.admin_a)).status_code, 404)
        self.assertEqual((await self.get(f"/v1/archive/retrievals/{r['retrieval_id']}/events", self.admin_a)).status_code, 404)
        self.assertEqual((await self.get("/v1/archive/retrievals", self.admin_a)).json()["items"], [])


class FlowTests(ArchiveApiCase):
    async def test_status_reports_storage_capabilities_and_counts(self):
        status = (await self.get("/v1/archive/status", self.super)).json()
        self.assertEqual(status["summary"]["archives"], 2)
        self.assertEqual(status["summary"]["archived_events"], 70)
        self.assertTrue(status["storage"]["object_lock"] and status["storage"]["versioning"] and status["storage"]["private"])
        self.assertTrue(status["master_key"]["available"])
        self.assertFalse(status["config"]["auto_hot_cleanup"])
        self.assertEqual(len(status["policies"]), 6)
        self.assertIsNotNone(status["partitions"])

    async def test_verify_retrieve_and_download_evidence(self):
        aid = str(self.row_a["archive_id"])
        quick = (await self.post("/v1/archive/verify", self.admin_a, {"archive_id": aid})).json()
        deep = (await self.post("/v1/archive/verify", self.admin_a, {"archive_id": aid, "deep": True})).json()
        self.assertEqual((quick["state"], deep["state"]), ("VERIFIED", "VERIFIED"))
        self.assertEqual(deep["details"]["events_verified"], 40)
        detail = (await self.get(f"/v1/archive/catalog/{aid}", self.admin_a)).json()
        self.assertEqual(len(detail["verifications"]), 3)           # intake + the two just run
        r = await self.post("/v1/archive/retrievals", self.admin_a, {"entity_id": "ENT-4"})
        self.assertEqual(r.status_code, 202)
        rid = r.json()["retrieval_id"]
        self.assertEqual((await self.get(f"/v1/archive/retrievals/{rid}/events", self.admin_a)).status_code, 409, "not ready yet")
        await self.services.retrieval.process_pending()
        page = (await self.get(f"/v1/archive/retrievals/{rid}/events", self.admin_a)).json()
        self.assertEqual(page["total"], 2)
        self.assertTrue(all(e["archived"] and e["verified"] and e["entity_id"] == "ENT-4" for e in page["items"]))
        zipped = await self.get(f"/v1/archive/catalog/{aid}/evidence", self.admin_a)
        self.assertEqual((zipped.status_code, zipped.headers["content-type"]), (200, "application/zip"))
        self.assertTrue(zipped.content.startswith(b"PK"))

    async def test_sensitive_actions_are_recorded_in_the_audit_ledger(self):
        aid = str(self.row_a["archive_id"])
        await self.post("/v1/archive/verify", self.admin_a, {"archive_id": aid})
        await self.get(f"/v1/archive/catalog/{aid}/evidence", self.admin_a)
        await self.post("/v1/archive/retrievals", self.admin_a, {"chain_id": self.chain_a})
        rows = await self.fetch("SELECT action, actor_role, tenant_id FROM events WHERE service_name = 'audit-service' AND module = 'audit' ORDER BY recorded_at")
        self.assertEqual({r["action"] for r in rows}, {"archive.verified", "archive.evidence_downloaded", "archive.retrieval_requested"})
        self.assertTrue(all(r["actor_role"] == "Admin" and r["tenant_id"] == self.tenant_a for r in rows))

    async def test_policy_and_hold_changes_are_versioned_audited_and_restricted(self):
        body = {"category": "claims", "hot_retention_months": 12, "cold_retention_years": 7, "allow_hot_cleanup": True, "approved": True, "notes": "approved by compliance"}
        saved = (await self.put("/v1/archive/policies", self.super, body)).json()
        self.assertTrue(saved["approved"] and saved["approved_by"])
        shown = (await self.get("/v1/archive/policies", self.admin_a, history="true")).json()
        claims = next(p for p in shown["effective"] if p["category"] == "claims")
        self.assertEqual((claims["hot_retention_months"], claims["cold_retention_years"], claims["approved"]), (12, 7, True))
        self.assertEqual((await self.put("/v1/archive/policies", self.super, {"category": "nonsense", "hot_retention_months": 1})).status_code, 422)
        hold = await self.post("/v1/archive/holds", self.super, {"tenant_id": str(self.tenant_a), "reason": "litigation hold", "case_reference": "CASE-9"})
        self.assertEqual(hold.status_code, 201)
        self.assertEqual(len((await self.get("/v1/archive/holds", self.admin_a, active_only="true")).json()["items"]), 1)
        self.assertEqual((await self.get("/v1/archive/holds", self.admin_b)).json()["items"], [])
        released = await self.post(f"/v1/archive/holds/{hold.json()['hold_id']}/release", self.super, {"reason": "settled"})
        self.assertFalse(released.json()["active"])
        self.assertEqual((await self.post(f"/v1/archive/holds/{hold.json()['hold_id']}/release", self.super, {"reason": "again"})).status_code, 409)
        actions = {r["action"] for r in await self.fetch("SELECT action FROM events WHERE service_name = 'audit-service'")}
        self.assertTrue({"archive.retention_policy_changed", "archive.legal_hold_placed", "archive.legal_hold_released"} <= actions)

    async def test_cleanup_needs_an_explicit_confirmation_and_defaults_to_a_dry_run(self):
        dry = (await self.post("/v1/archive/cleanup", self.super, {})).json()
        self.assertTrue(dry["dry_run"])
        self.assertEqual((await self.post("/v1/archive/cleanup", self.super, {"dry_run": False})).status_code, 422)
        plan = (await self.get("/v1/archive/cleanup/plan", self.super)).json()
        self.assertFalse(plan["automatic"])
        real = (await self.post("/v1/archive/cleanup", self.super, {"dry_run": False, "confirm": "REMOVE-HOT-PARTITIONS", "ignore_safety_period": True})).json()
        self.assertEqual(len(real["removed_months"]), 1)
        self.assertEqual((await self.fetch("SELECT count(*) AS n FROM events WHERE service_name <> 'audit-service'"))[0]["n"], 0)
        chain = (await self.post("/v1/archive/verify-chain", self.admin_a, {"chain_id": self.chain_a})).json()
        self.assertIn(chain["state"], ("VERIFIED", "UNSIGNED_EVENTS_PENDING"), chain["findings"])

    async def test_run_is_a_dry_run_by_default_and_a_failed_job_can_be_retried(self):
        out = (await self.post("/v1/archive/run", self.super, {})).json()
        self.assertTrue(out["dry_run"])
        self.assertEqual((await self.post(f"/v1/archive/jobs/{(await self.fetch('SELECT job_id FROM archive_jobs'))[0]['job_id']}/retry", self.super)).status_code, 409)

    async def test_bad_input_is_rejected_cleanly(self):
        for body in ({}, {"sql": "drop"}, {"since": "not a date", "chain_id": self.chain_a}):
            self.assertIn((await self.post("/v1/archive/retrievals", self.admin_a, body)).status_code, (422,))
        self.assertEqual((await self.get("/v1/archive/catalog/not-a-uuid", self.super)).status_code, 404)
        self.assertEqual((await self.get("/v1/archive/jobs/not-a-uuid", self.super)).status_code, 404)
