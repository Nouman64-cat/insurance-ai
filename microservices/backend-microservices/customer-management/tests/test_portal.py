"""Portal data rules: which customer a request is for, what the dashboard counts, payment idempotency, claims hand-off."""
from datetime import date, timedelta
from uuid import uuid4

from sqlalchemy import text

from app import db, notices
from app.errors import ApiError
from tests.support import Base


def policy(pid=None, number="PL-2026-0001", status="Active", sum_assured=1_000_000, in_force=True, due=None, due_now=0.0, remaining=0.0, **over):
    base = {"id": str(pid or uuid4()), "policy_number": number, "status": status, "in_force": in_force, "pending_issuance": False, "reinstated": False,
            "sum_assured": sum_assured, "expiry_date": None, "maturity_date": None,
            "premium": {"next_due_date": due, "next_due_amount": 5000.0 if due else None, "next_due_state": "upcoming" if due else None,
                        "due_now": due_now, "remaining": remaining, "arrears_count": 0, "in_grace": False, "grace_until": None, "grace_days_left": None,
                        "lapse_due": False}, "claims": {"open": 0, "total": 0}}
    base.update(over)
    return base


class Isolation(Base):
    async def test_every_upstream_call_names_the_signed_in_account_not_the_browser(self):
        token, _ = await self.active_session()
        mine = f"/scope/{self.tenant_id}/{self.customer_id}"
        other_customer = uuid4()
        self.fake.routes.update({"/policies": [], "/claims": [], "/profile": {"name": "A", "tenant": {"name": "T"}}, "/documents": []})
        for url in (f"/v1/dashboard?customer_id={other_customer}&tenant_id={uuid4()}", f"/v1/policies?customer_id={other_customer}",
                    "/v1/claims", "/v1/documents", "/v1/profile", "/v1/payments"):
            await self.client.get(url, headers={**self.bearer(token), "x-customer-id": str(other_customer), "x-tenant-id": str(uuid4())})
        self.assertTrue(self.fake.calls)
        for method, path, _ in self.fake.calls:
            self.assertTrue(path.startswith(mine + "/"), path)
            self.assertNotIn(str(other_customer), path)

    async def test_two_customers_each_see_only_their_own_scope(self):
        a, _ = await self.active_session("PH-A")
        b_tenant, b_customer = uuid4(), uuid4()
        await self.provision_account("PH-B", tenant_id=b_tenant, customer_id=b_customer, tenant_code="OTHER")
        from tests.support import TEMP_PASSWORD, NEW_PASSWORD
        first = (await self.login("PH-B")).json()
        b = (await self.client.post("/v1/auth/password/first-change", headers=self.bearer(first["access_token"]),
                                    json={"current_password": TEMP_PASSWORD, "new_password": NEW_PASSWORD})).json()["access_token"]
        self.fake.routes["/policies"] = []
        await self.client.get("/v1/policies", headers=self.bearer(a))
        await self.client.get("/v1/policies", headers=self.bearer(b))
        paths = [p for _, p, _ in self.fake.calls if p.endswith("/policies")]
        self.assertEqual(paths[0], f"/scope/{self.tenant_id}/{self.customer_id}/policies")
        self.assertEqual(paths[1], f"/scope/{b_tenant}/{b_customer}/policies")

    async def test_upstream_not_found_is_a_plain_404_and_upstream_failure_leaks_nothing(self):
        token, _ = await self.active_session()
        pid = uuid4()
        self.assertEqual((await self.client.get(f"/v1/policies/{pid}", headers=self.bearer(token))).status_code, 404)  # fake has no route => not found
        self.fake.routes[f"/policies/{pid}"] = ApiError(503, "DOMAIN_UNAVAILABLE", "This service is temporarily unavailable. Please try again shortly.")
        r = await self.client.get(f"/v1/policies/{pid}", headers=self.bearer(token))
        self.assertEqual(r.status_code, 503)
        self.assertNotIn("Traceback", r.text)
        self.assertEqual((await self.client.get("/v1/policies/not-a-uuid", headers=self.bearer(token))).status_code, 422)


class Dashboard(Base):
    async def test_counts_only_in_force_cover_and_what_is_payable_today(self):
        token, _ = await self.active_session()
        soon = (date.today() + timedelta(days=9)).isoformat()
        self.fake.routes.update({
            "/profile": {"name": "Zeeshan", "policyholder_id": "PH-2026-000001", "tenant": {"name": "Pak-Gulf"}},
            "/policies": [policy(number="A", status="Active", sum_assured=1_000_000, due=soon, due_now=0, remaining=30_000),
                          policy(number="B", status="GracePeriod", sum_assured=500_000, due=soon, due_now=7_500, remaining=7_500),
                          policy(number="C", status="Lapsed", sum_assured=9_000_000, in_force=False, due_now=99_000, remaining=99_000),
                          policy(number="D", status="Cancelled", sum_assured=4_000_000, in_force=False),
                          policy(number="E", status="Matured", sum_assured=2_000_000, in_force=False)],
            "/family": [],
            "/claims": [{"id": str(uuid4()), "status_key": "assessment", "policy_id": None, "policy_number": "A", "last_update": date.today().isoformat(), "claim_number": "C1"},
                        {"id": str(uuid4()), "status_key": "settled", "policy_id": None, "policy_number": "A", "last_update": date.today().isoformat(), "claim_number": "C2"}]})
        d = (await self.client.get("/v1/dashboard", headers=self.bearer(token))).json()
        s = d["summary"]
        self.assertEqual((s["total_policies"], s["active_policies"], s["in_force_policies"]), (5, 1, 2))
        self.assertEqual(s["coverage_total"], 1_500_000)          # not the lapsed / cancelled / matured cover
        self.assertEqual(s["outstanding_amount"], 7_500)           # payable now, from in-force policies only
        self.assertEqual(s["remaining_amount"], 37_500)
        self.assertEqual(s["open_claims"], 1)
        self.assertEqual(s["next_premium"]["date"], soon)
        self.assertEqual(d["customer"]["name"], "Zeeshan")
        self.assertTrue(all(d["sections"].values()))

    async def test_a_failing_section_degrades_the_page_instead_of_failing_it(self):
        token, _ = await self.active_session()
        self.fake.routes.update({"/profile": {"name": "Z", "tenant": {}}, "/policies": [policy(number="A", due_now=100)], "/family": [],
                                 "/claims": ApiError(503, "DOMAIN_UNAVAILABLE", "x")})
        r = await self.client.get("/v1/dashboard", headers=self.bearer(token))
        d = r.json()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(d["sections"], {"profile": True, "policies": True, "claims": False, "family": True})
        self.assertEqual(d["summary"]["total_policies"], 1)
        self.assertEqual(d["summary"]["open_claims"], 0)   # falls back to the per-policy counts

    async def test_empty_customer_gets_an_empty_dashboard(self):
        token, _ = await self.active_session()
        self.fake.routes.update({"/profile": {"name": "Z", "tenant": {}}, "/policies": [], "/claims": [], "/family": []})
        d = (await self.client.get("/v1/dashboard", headers=self.bearer(token))).json()
        self.assertEqual((d["summary"]["total_policies"], d["summary"]["coverage_total"], d["summary"]["next_premium"]), (0, 0, None))
        self.assertEqual((d["notices"], d["unread_notices"]), ([], 0))


class Payments(Base):
    async def test_idempotency_key_required_and_replays_do_not_pay_twice(self):
        token, _ = await self.active_session()
        pid, sid = uuid4(), uuid4()
        path = f"/v1/policies/{pid}/premiums/{sid}/pay"
        body = {"method": "JazzCash", "expected_amount": 5000}
        self.fake.routes["/pay"] = lambda payload: {"status": "PAID", "simulated": True, "receipt": {"receipt_no": "RCPT-1"}}
        self.assertEqual((await self.client.post(path, headers=self.bearer(token), json=body)).status_code, 422)  # no key
        h = {**self.bearer(token), "Idempotency-Key": "pay-key-aaaa-0001"}
        r1 = await self.client.post(path, headers=h, json=body)
        r2 = await self.client.post(path, headers=h, json=body)
        self.assertEqual((r1.status_code, r1.json()["simulated"], r1.json()["duplicate"]), (200, True, False))
        self.assertEqual((r2.json()["duplicate"], r2.json()["receipt"]["receipt_no"]), (True, "RCPT-1"))
        self.assertEqual(sum(1 for m, p, _ in self.fake.calls if p.endswith("/pay")), 1)       # the gateway was called once
        # the same key cannot be reused for a different installment
        other = await self.client.post(f"/v1/policies/{pid}/premiums/{uuid4()}/pay", headers=h, json=body)
        self.assertEqual(other.json()["error"]["code"], "IDEMPOTENCY_CONFLICT")

    async def test_declined_payment_is_recorded_and_no_receipt_is_invented(self):
        token, _ = await self.active_session()
        self.fake.routes["/pay"] = ApiError(402, "PAYMENT_DECLINED", "The payment was not completed. Nothing was charged.")
        h = {**self.bearer(token), "Idempotency-Key": "pay-key-bbbb-0002"}
        r = await self.client.post(f"/v1/policies/{uuid4()}/premiums/{uuid4()}/pay", headers=h, json={"method": "Card", "expected_amount": 100})
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (402, "PAYMENT_DECLINED"))
        async with db.engine().connect() as c:
            self.assertEqual((await c.execute(text("SELECT status FROM payment_attempts"))).scalar_one(), "FAILED")

    async def test_unknown_method_and_gateway_outage(self):
        token, _ = await self.active_session()
        h = {**self.bearer(token), "Idempotency-Key": "pay-key-cccc-0003"}
        p = f"/v1/policies/{uuid4()}/premiums/{uuid4()}/pay"
        self.assertEqual((await self.client.post(p, headers=h, json={"method": "Bitcoin", "expected_amount": 100})).status_code, 422)
        self.fake.routes["/pay"] = ApiError(503, "DOMAIN_UNAVAILABLE", "x")
        self.assertEqual((await self.client.post(p, headers=h, json={"method": "Card", "expected_amount": 100})).status_code, 503)
        async with db.engine().connect() as c:  # an unknown outcome must not wedge the key
            self.assertEqual((await c.execute(text("SELECT count(*) FROM payment_attempts"))).scalar_one(), 0)


class Claims(Base):
    async def test_submission_is_idempotent_and_never_trusts_the_browser_for_identity(self):
        token, _ = await self.active_session()
        pid = uuid4()
        self.fake.routes["/claims"] = lambda payload: {"id": str(uuid4()), "claim_number": "CLM-2026-0001", "status_key": "documents_needed"}
        body = {"category": "Hospitalization", "event_date": "2026-10-10", "description": "Admitted for surgery", "claimed_amount": 50000}
        self.assertEqual((await self.client.post(f"/v1/policies/{pid}/claims", headers=self.bearer(token), json=body)).status_code, 422)  # no key
        h = {**self.bearer(token), "Idempotency-Key": "claim-key-aaaa-01"}
        a = await self.client.post(f"/v1/policies/{pid}/claims", headers=h, json=body)
        b = await self.client.post(f"/v1/policies/{pid}/claims", headers=h, json=body)
        self.assertEqual((a.status_code, a.json()["id"] == b.json()["id"]), (201, True))
        self.assertEqual(sum(1 for m, p, _ in self.fake.calls if m == "POST" and p.endswith("/claims")), 1)
        diff = await self.client.post(f"/v1/policies/{pid}/claims", headers=h, json={**body, "claimed_amount": 1})
        self.assertEqual(diff.json()["error"]["code"], "IDEMPOTENCY_CONFLICT")
        # claimant fields and customer ids in the payload are rejected, not forwarded
        forged = await self.client.post(f"/v1/policies/{pid}/claims", headers={**self.bearer(token), "Idempotency-Key": "claim-key-bbbb-02"},
                                        json={**body, "claimant_name": "Someone Else", "customer_id": str(uuid4())})
        self.assertEqual(forged.status_code, 422)

    async def test_failed_submission_frees_the_key_for_a_retry(self):
        token, _ = await self.active_session()
        pid = uuid4()
        self.fake.routes["/claims"] = ApiError(503, "DOMAIN_UNAVAILABLE", "x")
        h = {**self.bearer(token), "Idempotency-Key": "claim-key-cccc-03"}
        body = {"category": "Hospitalization", "event_date": "2026-10-10", "description": "Admitted for surgery", "claimed_amount": 50000}
        self.assertEqual((await self.client.post(f"/v1/policies/{pid}/claims", headers=h, json=body)).status_code, 503)
        self.fake.routes["/claims"] = {"id": str(uuid4()), "claim_number": "CLM-2026-0002"}
        self.assertEqual((await self.client.post(f"/v1/policies/{pid}/claims", headers=h, json=body)).status_code, 201)

    async def test_oversized_and_empty_uploads_are_refused_before_they_reach_the_domain(self):
        token, _ = await self.active_session()
        url = f"/v1/claims/{uuid4()}/documents/claim_form"
        self.fake.routes["/documents/claim_form"] = {"ok": True}
        empty = await self.client.post(url, headers=self.bearer(token), files={"file": ("a.pdf", b"", "application/pdf")})
        self.assertEqual(empty.json()["error"]["code"], "FILE_EMPTY")
        from app.config import settings
        big = await self.client.post(url, headers=self.bearer(token), files={"file": ("a.pdf", b"x" * (settings.max_upload_bytes + 10), "application/pdf")})
        self.assertEqual(big.status_code, 413)
        bad_key = await self.client.post(f"/v1/claims/{uuid4()}/documents/..%2Fpasswd", headers=self.bearer(token), files={"file": ("a.pdf", b"x", "application/pdf")})
        self.assertIn(bad_key.status_code, (404, 422))
        self.assertEqual(sum(1 for m, *_ in self.fake.calls if m == "UPLOAD"), 0)

    async def test_a_supplied_operation_key_reaches_the_domain_namespaced_by_account_and_none_is_invented(self):
        token, _ = await self.active_session()
        url = f"/v1/claims/{uuid4()}/documents/claim_form"
        self.fake.routes["/documents/claim_form"] = {"ok": True}
        files = {"file": ("a.pdf", b"%PDF-1.4 x", "application/pdf")}
        await self.client.post(url, headers=self.bearer(token), files=files)
        await self.client.post(url, headers={**self.bearer(token), "Idempotency-Key": "upload-key-aaaa-01"}, files=files)
        self.assertIsNone(self.fake.operation_keys[-2])
        self.assertTrue(self.fake.operation_keys[-1].endswith(":upload-key-aaaa-01"))
        bad = await self.client.post(url, headers={**self.bearer(token), "Idempotency-Key": "x"}, files=files)
        self.assertEqual(bad.status_code, 422)


class Profile(Base):
    async def test_contact_change_needs_the_password_and_never_forwards_identity_fields(self):
        token, _ = await self.active_session()
        self.fake.routes["/profile/contact"] = lambda payload: {"email": payload.get("email")}
        wrong = await self.client.patch("/v1/profile/contact", headers=self.bearer(token), json={"current_password": "nope-nope-1", "email": "a@b.co"})
        self.assertEqual(wrong.json()["error"]["code"], "CURRENT_PASSWORD_INCORRECT")
        from tests.support import NEW_PASSWORD
        ok = await self.client.patch("/v1/profile/contact", headers=self.bearer(token), json={"current_password": NEW_PASSWORD, "email": "a@b.co"})
        self.assertEqual(ok.status_code, 200)
        sent = [p for m, path, p in self.fake.calls if m == "PATCH"][0]
        self.assertNotIn("current_password", sent)
        # name / CNIC / date of birth are not editable here
        forged = await self.client.patch("/v1/profile/contact", headers=self.bearer(token), json={"current_password": NEW_PASSWORD, "name": "Mallory", "cnic": "1"})
        self.assertEqual(forged.status_code, 422)


class Notifications(Base):
    def test_notices_are_derived_from_live_data(self):
        today = date(2026, 10, 13)
        overdue = policy(number="A", due="2026-10-01", due_now=9000)
        overdue["premium"].update(arrears_count=1, grace_until="2026-10-31", grace_days_left=18)
        soon = policy(number="B", due="2026-10-20", due_now=0)
        lapsed = policy(number="C", status="Lapsed", in_force=False)
        expiring = policy(number="D", due=None, expiry_date="2026-11-15")
        claims = [{"id": "c1", "status_key": "documents_needed", "policy_number": "A", "policy_id": overdue["id"], "last_update": "2026-10-12", "claim_number": "CLM-1"},
                  {"id": "c2", "status_key": "settled", "policy_number": "A", "policy_id": overdue["id"], "last_update": "2026-01-01", "claim_number": "CLM-0"}]
        kinds = {n["kind"] for n in notices.build([overdue, soon, lapsed, expiring], claims, today)}
        self.assertEqual(kinds, {"premium_overdue", "premium_due", "policy_lapsed", "policy_expiry", "claim_documents_needed"})  # old settled claim is not news

    async def test_read_state_is_per_account(self):
        token, _ = await self.active_session()
        self.fake.routes.update({"/policies": [policy(number="A", status="Lapsed", in_force=False)], "/claims": []})
        first = (await self.client.get("/v1/notifications", headers=self.bearer(token))).json()
        self.assertEqual((first["unread"], first["total"]), (1, 1))
        await self.client.post("/v1/notifications/read", headers=self.bearer(token), json={"keys": [first["items"][0]["key"]]})
        self.assertEqual((await self.client.get("/v1/notifications", headers=self.bearer(token))).json()["unread"], 0)
