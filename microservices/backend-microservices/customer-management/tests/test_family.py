"""Family extensions of the portal: dashboard section, segments, servicing requests, claims for a covered person, renewals."""
from uuid import uuid4

from sqlalchemy import text

from app import db
from app.errors import ApiError
from tests.support import Base


def group(gid=None, name="Raza Family", role="head", plans=("LifeBundle",), coverage=10_000_000.0):
    return {"id": str(gid or uuid4()), "name": name, "role": role, "plan_types": list(plans),
            "arrangements": [{"family_policy_id": str(uuid4()), "plan_type": plans[0], "plan_label": "x", "status": "Active", "policy_count": 3}],
            "members": {"listed": 5, "insured": 3, "insured_total": 3, "nominees": 2},
            "totals": {"coverage": coverage, "policies_in_force": 3, "policies_total": 3, "next_premium": None, "outstanding": 0.0, "remaining": 0.0,
                       "open_claims": 0, "renewals_soon": []}}


class FamilyDashboard(Base):
    async def test_individual_only_customers_keep_the_original_dashboard(self):
        token, _ = await self.active_session()
        self.fake.routes.update({"/profile": {"name": "Z", "tenant": {}}, "/policies": [], "/claims": [], "/family": []})
        d = (await self.client.get("/v1/dashboard", headers=self.bearer(token))).json()
        self.assertIsNone(d["family"])
        self.assertTrue(d["sections"]["family"])
        self.assertEqual(d["summary"]["total_policies"], 0)

    async def test_family_section_is_added_without_touching_individual_numbers(self):
        token, _ = await self.active_session()
        g = group()
        self.fake.routes.update({"/profile": {"name": "Z", "tenant": {}}, "/policies": [], "/claims": [], "/family": [g]})
        d = (await self.client.get("/v1/dashboard", headers=self.bearer(token))).json()
        self.assertEqual(len(d["family"]), 1)
        self.assertEqual((d["family"][0]["totals"]["coverage"], d["family"][0]["members"]["insured"]), (10_000_000.0, 3))
        self.assertEqual(d["summary"]["coverage_total"], 0)             # the family cover is NOT folded into the individual figure

    async def test_a_family_outage_degrades_the_dashboard_instead_of_failing_it(self):
        token, _ = await self.active_session()
        self.fake.routes.update({"/profile": {"name": "Z", "tenant": {}}, "/policies": [], "/claims": [], "/family": ApiError(503, "DOMAIN_UNAVAILABLE", "x")})
        r = await self.client.get("/v1/dashboard", headers=self.bearer(token))
        self.assertEqual((r.status_code, r.json()["sections"]["family"], r.json()["family"]), (200, False, None))


class Segments(Base):
    async def test_segments_are_validated_and_forwarded_and_default_to_individual(self):
        token, _ = await self.active_session()
        self.fake.routes.update({"/policies": [], "/claims": [], "/documents": []})
        for path in ("/v1/policies", "/v1/claims", "/v1/documents"):
            await self.client.get(path, headers=self.bearer(token))
            await self.client.get(path + "?segment=family", headers=self.bearer(token))
            self.assertEqual((await self.client.get(path + "?segment=corporate", headers=self.bearer(token))).status_code, 422, path)
        sent = [q["segment"] for m, p, q in self.fake.calls if m == "GET" and q and "segment" in q]
        self.assertEqual(sent, ["individual", "family"] * 3)

    async def test_notifications_cover_individual_and_family_together(self):
        token, _ = await self.active_session()
        self.fake.routes.update({"/policies": [], "/claims": []})
        await self.client.get("/v1/notifications", headers=self.bearer(token))
        self.assertEqual({q["segment"] for m, p, q in self.fake.calls if q and "segment" in q}, {"all"})


class FamilyCalls(Base):
    async def test_family_ids_from_the_browser_never_change_who_the_call_is_for(self):
        token, _ = await self.active_session()
        mine = f"/scope/{self.tenant_id}/{self.customer_id}"
        other = uuid4()
        self.fake.routes["/members"] = {"items": []}
        await self.client.get(f"/v1/family/{other}/members?customer_id={other}&tenant_id={other}", headers={**self.bearer(token), "x-customer-id": str(other)})
        paths = [p for m, p, q in self.fake.calls if "/members" in p]
        self.assertEqual(paths, [f"{mine}/family/{other}/members"])         # the family id is only a request; the adapter decides if it is theirs
        self.assertEqual((await self.client.get("/v1/family/not-a-uuid", headers=self.bearer(token))).status_code, 422)
        self.assertEqual((await self.client.get("/v1/family")).status_code, 401)

    async def test_first_login_sessions_cannot_reach_family_data(self):
        await self.provision_account()
        first = (await self.login()).json()
        r = await self.client.get("/v1/family", headers=self.bearer(first["access_token"]))
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (403, "PASSWORD_CHANGE_REQUIRED"))


class Requests(Base):
    BODY = {"kind": "NOMINEE_CHANGE", "reason": "Added a child", "beneficiaries": [{"name": "A Child", "relationship": "Child", "share_pct": 100}]}

    async def test_a_request_is_recorded_once_and_replays_return_the_same_one(self):
        token, _ = await self.active_session()
        fid = uuid4()
        self.fake.routes[f"/family/{fid}/requests"] = lambda payload: {"ok": True, "policy_id": str(uuid4()), "policy_number": "PL-1", "summary": {"kind": payload["kind"]}}
        h = {**self.bearer(token), "Idempotency-Key": "fam-req-aaaa-01"}
        a = await self.client.post(f"/v1/family/{fid}/requests", headers=h, json=self.BODY)
        b = await self.client.post(f"/v1/family/{fid}/requests", headers=h, json=self.BODY)
        self.assertEqual((a.status_code, a.json()["status"], a.json()["duplicate"]), (201, "SUBMITTED", False))
        self.assertEqual((b.json()["reference"], b.json()["duplicate"]), (a.json()["reference"], True))
        self.assertEqual(sum(1 for m, p, _ in self.fake.calls if m == "POST" and p.endswith("/requests")), 1)       # the insurer was told once
        self.assertEqual((await self.client.post(f"/v1/family/{fid}/requests", headers=h, json={**self.BODY, "kind": "CANCELLATION"})).json()["error"]["code"], "IDEMPOTENCY_CONFLICT")
        self.assertEqual((await self.client.post(f"/v1/family/{fid}/requests", headers=self.bearer(token), json=self.BODY)).status_code, 422)      # no key

    async def test_refusals_keep_their_meaning_and_free_the_key(self):
        token, _ = await self.active_session()
        fid = uuid4()
        self.fake.routes[f"/family/{fid}/requests"] = ApiError(403, "NOT_AUTHORISED", "You can only change yourself")
        h = {**self.bearer(token), "Idempotency-Key": "fam-req-bbbb-02"}
        r = await self.client.post(f"/v1/family/{fid}/requests", headers=h, json={"kind": "MEMBER_REMOVE", "member_key": "x", "reason": "remove her"})
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (403, "NOT_AUTHORISED"))
        async with db.engine().connect() as c:
            self.assertEqual((await c.execute(text("SELECT count(*) FROM service_requests"))).scalar_one(), 0)
        self.fake.routes[f"/family/{fid}/requests"] = lambda p: {"ok": True, "policy_id": None, "policy_number": None, "summary": {}}
        self.assertEqual((await self.client.post(f"/v1/family/{fid}/requests", headers=h, json={"kind": "MEMBER_REMOVE", "member_key": "x", "reason": "remove her"})).status_code, 201)

    async def test_unknown_kinds_and_forged_fields_are_rejected_before_the_domain(self):
        token, _ = await self.active_session()
        fid = uuid4()
        h = {**self.bearer(token), "Idempotency-Key": "fam-req-cccc-03"}
        self.assertEqual((await self.client.post(f"/v1/family/{fid}/requests", headers=h, json={"kind": "TELEPORT"})).status_code, 422)
        self.assertEqual((await self.client.post(f"/v1/family/{fid}/requests", headers={**h, "Idempotency-Key": "fam-req-cccc-04"}, json={**self.BODY, "customer_id": str(uuid4()), "status": "APPROVED"})).status_code, 422)
        self.assertEqual(sum(1 for m, p, _ in self.fake.calls if m == "POST" and p.endswith("/requests")), 0)

    async def test_withdrawing_is_only_possible_for_your_own_pending_request(self):
        token, _ = await self.active_session()
        fid = uuid4()
        self.fake.routes[f"/family/{fid}/requests"] = lambda p: {"ok": True, "policy_id": str(uuid4()), "policy_number": "PL-1", "summary": {}}
        self.fake.routes["/requests/withdraw"] = {"ok": True}
        rid = (await self.client.post(f"/v1/family/{fid}/requests", headers={**self.bearer(token), "Idempotency-Key": "fam-req-dddd-05"}, json=self.BODY)).json()["id"]
        # a different customer cannot touch it
        other_tenant, other_customer = uuid4(), uuid4()
        await self.provision_account("PH-OTHER", tenant_id=other_tenant, customer_id=other_customer, tenant_code="OTHER")
        from tests.support import NEW_PASSWORD, TEMP_PASSWORD
        first = (await self.login("PH-OTHER")).json()
        other = (await self.client.post("/v1/auth/password/first-change", headers=self.bearer(first["access_token"]),
                                        json={"current_password": TEMP_PASSWORD, "new_password": NEW_PASSWORD})).json()["access_token"]
        self.assertEqual((await self.client.post(f"/v1/family/requests/{rid}/withdraw", headers=self.bearer(other))).status_code, 404)
        self.assertEqual((await self.client.get("/v1/family/requests", headers=self.bearer(other))).json()["total"], 0)
        self.assertEqual((await self.client.post(f"/v1/family/requests/{rid}/withdraw", headers=self.bearer(token))).json()["status"], "WITHDRAWN")
        self.assertEqual((await self.client.post(f"/v1/family/requests/{rid}/withdraw", headers=self.bearer(token))).status_code, 409)     # already withdrawn


class FamilyClaims(Base):
    async def test_covered_person_and_consent_are_forwarded_and_identity_fields_are_not_accepted(self):
        token, _ = await self.active_session()
        pid = uuid4()
        self.fake.routes["/claims"] = lambda payload: {"id": str(uuid4()), "claim_number": "CLM-F-1", "echo": payload}
        who = str(uuid4())
        body = {"category": "Hospitalization", "event_date": "2026-10-10", "description": "Admitted for surgery", "claimed_amount": 50000, "covered_person_id": who, "consent_confirmed": True}
        r = await self.client.post(f"/v1/policies/{pid}/claims", headers={**self.bearer(token), "Idempotency-Key": "fam-claim-aaaa-1"}, json=body)
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual((r.json()["echo"]["covered_person_id"], r.json()["echo"]["consent_confirmed"]), (who, True))
        forged = await self.client.post(f"/v1/policies/{pid}/claims", headers={**self.bearer(token), "Idempotency-Key": "fam-claim-bbbb-2"}, json={**body, "claimant_name": "Mallory", "customer_id": str(uuid4())})
        self.assertEqual(forged.status_code, 422)

    async def test_renewal_acceptance_is_a_passthrough_that_leaves_an_audit_trail(self):
        token, _ = await self.active_session()
        pid = uuid4()
        self.fake.routes["/renewal/acceptance"] = {"policy_id": str(pid), "case": None}
        r = await self.client.post(f"/v1/policies/{pid}/renewal/acceptance", headers=self.bearer(token), json={"accepted": True})
        self.assertEqual(r.status_code, 200)
        async with db.engine().connect() as c:
            self.assertEqual((await c.execute(text("SELECT count(*) FROM security_events WHERE kind = 'RENEWAL_TERMS_ACCEPTED'"))).scalar_one(), 1)
        self.assertEqual((await self.client.post(f"/v1/policies/{pid}/renewal/acceptance", headers=self.bearer(token), json={"accepted": True, "extra": 1})).status_code, 422)
