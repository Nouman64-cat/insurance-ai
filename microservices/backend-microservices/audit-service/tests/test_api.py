"""HTTP API: access control, tenant isolation, filtering, read-only guarantees, verification endpoint."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import httpx
from sqlalchemy import text

from app import auth
from app.main import app
from app.services import audit_service
from tests.support import LedgerCase, intent


class ApiCase(LedgerCase):
    per_test_database = True

    async def asyncSetUp(self):
        await super().asyncSetUp()
        auth.clear_cache()
        self.tenant_a, self.tenant_b = uuid4(), uuid4()
        self.users: dict[str, dict] = {}
        self.token_admin_a = self.add_user("Admin", self.tenant_a)
        self.token_admin_b = self.add_user("Admin", self.tenant_b)
        self.token_super = self.add_user("SuperAdmin", None)
        self.token_uw = self.add_user("Underwriter", self.tenant_a)
        self.token_agent = self.add_user("Agent", self.tenant_a)
        self.token_inactive = self.add_user("Admin", self.tenant_a, active=False)
        self.token_tenantless_admin = self.add_user("Admin", None)

        async def fetch_me(token):
            if token not in self.users:
                return 401, {"detail": "Could not validate credentials"}
            return 200, self.users[token]

        self._original = auth.fetch_me
        auth.fetch_me = fetch_me
        base = datetime(2026, 3, 1, 9, 0, tzinfo=timezone.utc)
        await audit_service.ingest([
            intent(self.tenant_a, 1, module="policies", action="policy.issued", entity_type="policy", entity_id="POL-1", occurred_at=base),
            intent(self.tenant_a, 2, module="claims", action="claim.approved", entity_type="claim", entity_id="CLM-1", case_id="CASE-9", occurred_at=base + timedelta(days=1)),
            intent(self.tenant_a, 3, module="administration", action="auth.login.failed", entity_type="user", outcome="FAILURE", actor_id=None, actor_type="USER", metadata={"actor_name": "Zara Khan"}, occurred_at=base + timedelta(days=2)),
            intent(self.tenant_a, 4, module="underwriting", action="case.status_changed", entity_type="case", entity_id="CASE-9", case_id="CASE-9", correlation_id="corr-1", occurred_at=base + timedelta(days=3)),
            intent(self.tenant_b, 1, module="policies", action="policy.issued", entity_type="policy", entity_id="POL-B1", occurred_at=base),
            intent(self.tenant_b, 2, module="claims", action="claim.rejected", entity_type="claim", entity_id="CLM-B1", occurred_at=base),
            intent(None, 1, module="administration", action="tenant.created", entity_type="tenant", actor_role="SuperAdmin", occurred_at=base),
        ])
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://audit.test")

    async def asyncTearDown(self):
        await self.client.aclose()
        auth.fetch_me = self._original
        auth.clear_cache()
        await super().asyncTearDown()

    def add_user(self, role, tenant, active=True) -> str:
        token = f"token-{uuid4().hex}"
        self.users[token] = {"id": str(uuid4()), "tenant_id": str(tenant) if tenant else None, "role_name": role,
                             "full_name": f"{role} User", "email": f"{role.lower()}@example.test",
                             "is_active": active, "status": "ACTIVE" if active else "INACTIVE"}
        return token

    async def get(self, path, token=None, **params):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return await self.client.get(path, headers=headers, params=params)

    async def post(self, path, token=None, json=None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return await self.client.post(path, headers=headers, json=json or {})


class AccessControlTests(ApiCase):
    async def test_unauthenticated_requests_are_refused(self):
        for path in ("/v1/events", "/v1/events/facets", "/v1/chains", "/v1/verification/runs", "/v1/ops/status"):
            with self.subTest(path=path):
                self.assertEqual((await self.get(path)).status_code, 401)
        self.assertEqual((await self.post("/v1/verification/run")).status_code, 401)
        self.assertEqual((await self.get("/v1/events", "garbage-token-0000000000")).status_code, 401)

    async def test_a_revoked_session_is_refused(self):
        self.assertEqual((await self.get("/v1/events", "revoked-token-000000000000")).status_code, 401)

    async def test_roles_that_may_not_read_the_audit_trail(self):
        for token in (self.token_uw, self.token_agent):
            for path in ("/v1/events", "/v1/chains", "/v1/events/facets", "/v1/ops/status"):
                with self.subTest(path=path):
                    self.assertEqual((await self.get(path, token)).status_code, 403)
            self.assertEqual((await self.post("/v1/verification/run", token)).status_code, 403)

    async def test_inactive_and_tenantless_admin_accounts_are_refused(self):
        self.assertEqual((await self.get("/v1/events", self.token_inactive)).status_code, 403)
        self.assertEqual((await self.get("/v1/events", self.token_tenantless_admin)).status_code, 403)

    async def test_a_mismatched_tenant_header_is_refused(self):
        resp = await self.client.get("/v1/events", headers={"Authorization": f"Bearer {self.token_admin_a}", "X-Tenant-Id": str(self.tenant_b)})
        self.assertEqual(resp.status_code, 403)

    async def test_no_route_can_create_change_or_delete_an_audit_record(self):
        write_methods = {"POST", "PUT", "PATCH", "DELETE"}
        for route in app.routes:
            path = getattr(route, "path", "")
            methods = getattr(route, "methods", set()) or set()
            if path.startswith("/v1/events") or path == "/v1/chains" or path.startswith("/v1/ops"):
                self.assertFalse(methods & write_methods, f"{path} allows {methods & write_methods}")
        for method in ("post", "put", "patch", "delete"):
            for path in ("/v1/events", f"/v1/events/{uuid4()}", "/v1/chains"):
                with self.subTest(method=method, path=path):
                    resp = await getattr(self.client, method)(path, headers={"Authorization": f"Bearer {self.token_super}"})
                    self.assertEqual(resp.status_code, 405)


class IsolationTests(ApiCase):
    async def test_a_tenant_admin_sees_only_their_own_tenant(self):
        body = (await self.get("/v1/events", self.token_admin_a)).json()
        self.assertEqual(body["total"], 4)
        self.assertEqual({e["tenant_id"] for e in body["items"]}, {str(self.tenant_a)})
        other = (await self.get("/v1/events", self.token_admin_b)).json()
        self.assertEqual(other["total"], 2)
        self.assertEqual({e["tenant_id"] for e in other["items"]}, {str(self.tenant_b)})

    async def test_a_tenant_admin_cannot_ask_for_another_tenant_or_the_platform_chain(self):
        self.assertEqual((await self.get("/v1/events", self.token_admin_a, tenant=str(self.tenant_b))).status_code, 403)
        self.assertEqual((await self.get("/v1/events", self.token_admin_a, tenant="platform")).status_code, 403)
        own = await self.get("/v1/events", self.token_admin_a, tenant=str(self.tenant_a))
        self.assertEqual(own.json()["total"], 4)

    async def test_another_tenants_event_is_not_found(self):
        foreign = (await self.get("/v1/events", self.token_admin_b)).json()["items"][0]["event_id"]
        self.assertEqual((await self.get(f"/v1/events/{foreign}", self.token_admin_a)).status_code, 404)
        self.assertEqual((await self.get(f"/v1/events/{foreign}", self.token_admin_b)).status_code, 200)
        self.assertEqual((await self.get(f"/v1/events/{foreign}", self.token_super)).status_code, 200)

    async def test_filters_cannot_widen_a_tenants_scope(self):
        body = (await self.get("/v1/events", self.token_admin_a, q="CLM-B1")).json()
        self.assertEqual(body["total"], 0)
        body = (await self.get("/v1/events", self.token_admin_a, module="claims")).json()
        self.assertEqual([e["entity_id"] for e in body["items"]], ["CLM-1"])

    async def test_super_admin_sees_every_chain_including_the_platform_chain(self):
        body = (await self.get("/v1/events", self.token_super)).json()
        self.assertEqual(body["total"], 7)
        self.assertEqual((await self.get("/v1/events", self.token_super, tenant="platform")).json()["total"], 1)
        self.assertEqual((await self.get("/v1/events", self.token_super, tenant=str(self.tenant_b))).json()["total"], 2)
        chains = (await self.get("/v1/chains", self.token_super)).json()["items"]
        self.assertEqual(sorted(c["scope"] for c in chains), ["PLATFORM", "TENANT", "TENANT"])
        mine = (await self.get("/v1/chains", self.token_admin_a)).json()["items"]
        self.assertEqual([c["tenant_id"] for c in mine], [str(self.tenant_a)])

    async def test_facets_are_scoped_too(self):
        facets = (await self.get("/v1/events/facets", self.token_admin_b)).json()
        self.assertEqual(facets["actions"], ["claim.rejected", "policy.issued"])
        self.assertNotIn("tenant.created", (await self.get("/v1/events/facets", self.token_admin_a)).json()["actions"])


class SearchTests(ApiCase):
    async def test_events_are_newest_first_and_paginated(self):
        first = (await self.get("/v1/events", self.token_admin_a, page_size=3)).json()
        self.assertEqual((first["total"], first["page"], first["page_size"], len(first["items"])), (4, 1, 3, 3))
        second = (await self.get("/v1/events", self.token_admin_a, page_size=3, page=2)).json()
        self.assertEqual(len(second["items"]), 1)
        sequences = [e["sequence_number"] for e in first["items"] + second["items"]]
        self.assertEqual(sequences, [4, 3, 2, 1])
        self.assertEqual((await self.get("/v1/events", self.token_admin_a, page_size=101)).status_code, 422)

    async def test_each_filter(self):
        a = self.token_admin_a
        cases = [
            (dict(module="claims"), {"CLM-1"}), (dict(action="policy.issued"), {"POL-1"}), (dict(entity_type="case"), {"CASE-9"}),
            (dict(entity_id="POL-1"), {"POL-1"}), (dict(case_id="CASE-9"), {"CLM-1", "CASE-9"}), (dict(outcome="FAILURE"), {"POL-3"}),
            (dict(correlation_id="corr-1"), {"CASE-9"}), (dict(actor="Zara"), {"POL-3"}),
            (dict(actor="user-1"), {"POL-1", "CLM-1", "CASE-9"}), (dict(q="status_changed"), {"CASE-9"}),
            (dict(service_name="tenant-service"), {"POL-1", "CLM-1", "POL-3", "CASE-9"}),
        ]
        for params, expected in cases:
            with self.subTest(params=params):
                body = (await self.get("/v1/events", a, **params)).json()
                self.assertEqual({e["entity_id"] for e in body["items"]}, expected)

    async def test_chain_and_sequence_find_the_exact_event_a_verification_flagged(self):
        chain = await self.chain_id(self.tenant_a)
        body = (await self.get("/v1/events", self.token_admin_a, chain_id=chain, sequence=3)).json()
        self.assertEqual([(e["sequence_number"], e["action"]) for e in body["items"]], [(3, "auth.login.failed")])
        other_chain = await self.chain_id(self.tenant_b)
        self.assertEqual((await self.get("/v1/events", self.token_admin_a, chain_id=other_chain)).json()["total"], 0)

    async def test_date_range_filters_on_when_the_action_happened(self):
        body = (await self.get("/v1/events", self.token_admin_a, **{"from": "2026-03-02T00:00:00Z", "to": "2026-03-03T23:59:59Z"})).json()
        self.assertEqual(sorted(e["action"] for e in body["items"]), ["auth.login.failed", "claim.approved"])

    async def test_search_text_is_escaped(self):
        self.assertEqual((await self.get("/v1/events", self.token_admin_a, q="%")).json()["total"], 0)
        self.assertEqual((await self.get("/v1/events", self.token_admin_a, q="po_-1")).json()["total"], 0)

    async def test_invalid_filter_values(self):
        self.assertEqual((await self.get("/v1/events", self.token_admin_a, outcome="MAYBE")).status_code, 422)
        self.assertEqual((await self.get("/v1/events", self.token_super, tenant="not-a-uuid")).status_code, 422)

    async def test_event_detail_has_hashes_and_chain_neighbours(self):
        items = (await self.get("/v1/events", self.token_admin_a)).json()["items"]
        middle = next(e for e in items if e["sequence_number"] == 2)
        detail = (await self.get(f"/v1/events/{middle['event_id']}", self.token_admin_a)).json()
        previous, following = detail["previous_event"], detail["next_event"]
        self.assertEqual((previous["sequence_number"], following["sequence_number"]), (1, 3))
        self.assertEqual(detail["previous_hash"], previous["current_hash"])
        self.assertEqual(following["previous_hash"], detail["current_hash"])
        first = next(e for e in items if e["sequence_number"] == 1)
        self.assertIsNone((await self.get(f"/v1/events/{first['event_id']}", self.token_admin_a)).json()["previous_event"])
        for field in ("event_id", "tenant_id", "environment_id", "chain_id", "sequence_number", "timestamp", "actor_id", "actor_type", "actor_role",
                      "service_name", "action", "entity_type", "entity_id", "case_id", "correlation_id", "source_event_id", "previous_value",
                      "new_value", "outcome", "metadata", "previous_hash", "current_hash", "hash_version"):
            self.assertIn(field, detail)


class VerificationApiTests(ApiCase):
    async def test_tenant_admin_verifies_their_own_chain(self):
        resp = await self.post("/v1/verification/run", self.token_admin_a)
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual((body["status"], body["total_events_checked"], body["tenant_id"]), ("VALID", 4, str(self.tenant_a)))
        self.assertIsNone(body["first_invalid_sequence"])
        self.assertIsNone(body["reason"])

    async def test_a_tampered_chain_reports_the_first_invalid_sequence(self):
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE events SET new_value = '{\"status\": \"Hacked\"}'::jsonb WHERE tenant_id = :t AND sequence_number = 3"), {"t": self.tenant_a})
        body = (await self.post("/v1/verification/run", self.token_admin_a)).json()
        self.assertEqual((body["status"], body["first_invalid_sequence"], body["reason"], body["total_events_checked"]),
                         ("INVALID", 3, "EVENT_HASH_MISMATCH", 2))
        self.assertEqual((await self.post("/v1/verification/run", self.token_admin_b)).json()["status"], "VALID")
        chains = (await self.get("/v1/chains", self.token_admin_a)).json()["items"]
        self.assertEqual(chains[0]["last_verification"]["status"], "INVALID")
        runs = (await self.get("/v1/verification/runs", self.token_admin_a)).json()["items"]
        self.assertEqual([r["status"] for r in runs], ["INVALID"])
        status = (await self.get("/v1/ops/status", self.token_admin_a)).json()
        self.assertEqual(status["verification"]["invalid_chains"], 1)

    async def test_an_admin_cannot_verify_or_read_the_history_of_another_tenants_chain(self):
        other_chain = await self.chain_id(self.tenant_b)
        self.assertEqual((await self.post("/v1/verification/run", self.token_admin_a, {"chain_id": other_chain})).status_code, 404)
        await self.post("/v1/verification/run", self.token_admin_b)
        self.assertEqual((await self.get("/v1/verification/runs", self.token_admin_a, chain_id=other_chain)).json()["items"], [])

    async def test_super_admin_names_the_chain(self):
        self.assertEqual((await self.post("/v1/verification/run", self.token_super)).status_code, 422)
        platform = (await self.post("/v1/verification/run", self.token_super, {"tenant_id": "platform"})).json()
        self.assertEqual((platform["status"], platform["total_events_checked"], platform["tenant_id"]), ("VALID", 1, None))
        by_id = (await self.post("/v1/verification/run", self.token_super, {"chain_id": await self.chain_id(self.tenant_b)})).json()
        self.assertEqual(by_id["total_events_checked"], 2)
        everything = (await self.post("/v1/verification/run-all", self.token_super)).json()["results"]
        self.assertEqual(sorted(r["total_events_checked"] for r in everything), [1, 2, 4])
        self.assertEqual((await self.post("/v1/verification/run-all", self.token_admin_a)).status_code, 403)

    async def test_bounded_range_needs_a_trusted_hash(self):
        resp = await self.post("/v1/verification/run", self.token_admin_a, {"from_sequence": 3})
        self.assertEqual(resp.status_code, 422)
        trusted = (await self.fetch("SELECT current_hash FROM events WHERE tenant_id = :t AND sequence_number = 2", t=self.tenant_a))[0]["current_hash"]
        body = (await self.post("/v1/verification/run", self.token_admin_a, {"from_sequence": 3, "trusted_previous_hash": trusted})).json()
        self.assertEqual((body["status"], body["total_events_checked"], body["head_checked"]), ("VALID", 2, True))
        self.assertEqual((await self.post("/v1/verification/run", self.token_admin_a, {"trusted_previous_hash": "xyz"})).status_code, 422)
        self.assertEqual((await self.post("/v1/verification/run", self.token_admin_a, {"unknown": 1})).status_code, 422)

    async def test_nothing_to_verify_yet_for_a_new_tenant(self):
        newcomer = self.add_user("Admin", uuid4())
        self.assertEqual((await self.post("/v1/verification/run", newcomer)).status_code, 404)


class OpsTests(ApiCase):
    async def test_status_shapes(self):
        admin = (await self.get("/v1/ops/status", self.token_admin_a)).json()
        self.assertEqual((admin["ledger"]["events"], admin["ledger"]["chains"]), (4, 1))
        self.assertNotIn("dead_letters", admin)
        self.assertEqual(admin["verification"]["unverified_chains"], 1)
        super_status = (await self.get("/v1/ops/status", self.token_super)).json()
        self.assertEqual(super_status["ledger"]["events"], 7)
        self.assertIn("dead_letters", super_status)
        self.assertEqual((await self.get("/v1/ops/dead-letters", self.token_admin_a)).status_code, 403)
        self.assertEqual((await self.get("/v1/ops/dead-letters", self.token_super)).status_code, 200)

    async def test_health(self):
        resp = await self.client.get("/v1/healthz")
        self.assertEqual((resp.status_code, resp.json()["status"]), (200, "ok"))
