"""Walk-in access: email one-time code, restricted token, application, status, and isolation from the full portal."""
from uuid import uuid4

from sqlalchemy import text

from app import db
from app.config import settings
from app.errors import ApiError
from app.routers import walk_in
from tests.support import Base

TID = str(uuid4())


class WalkIn(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        walk_in._tenant_cache.clear()
        object.__setattr__(settings, "walkin_tenant_code", "PAG34")
        object.__setattr__(settings, "walkin_dev_otp", "")
        object.__setattr__(settings, "demo", False)
        self.sent = []

        def mail(payload):
            self.sent.append(payload)
            return {"delivered": self.delivered}
        self.delivered = True
        self.leads = []
        self.fake.routes.update({
            "/walk-in/tenant": {"tenant_id": TID, "name": "T"},
            "/walk-in/plans": {"plans": [{"id": str(uuid4()), "code": "TL", "label": "Term Life", "category": "Individual"}]},
            "/walk-in/otp-email": mail,
            "/walk-in/leads": lambda payload: ({"reference": "WI-2026-ABC123", "duplicate": False} if payload and "request_key" in payload else {"leads": self.leads}),
        })

    async def asyncTearDown(self):
        object.__setattr__(settings, "walkin_dev_otp", "")
        await super().asyncTearDown()

    async def otp(self, email="Walk@Example.com"):
        r = await self.client.post("/v1/walk-in/otp/request", json={"email": email})
        return r

    async def session(self, email="walk@example.com"):
        r = await self.otp(email)
        self.assertEqual(r.status_code, 200, r.text)
        v = await self.client.post("/v1/walk-in/otp/verify", json={"email": email, "code": self.sent[-1]["code"]})
        self.assertEqual(v.status_code, 200, v.text)
        return v.json()["access_token"]

    def app_body(self, **kw):
        profile = {"first_name": "Walk", "last_name": "In", "date_of_birth": "1990-05-05", "gender": "Male", "mobile_number": "+923001234567", "city": "Lahore"}
        return {"profile": profile, "plan_id": str(uuid4()), "consent": True, **kw}

    async def test_plans_are_public_and_unpriced(self):
        r = await self.client.get("/v1/walk-in/plans")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["plans"][0]["code"], "TL")

    async def test_new_customer_verifies_email_and_gets_a_restricted_session(self):
        token = await self.session()
        me = await self.client.get("/v1/walk-in/me", headers=self.bearer(token))
        self.assertEqual(me.json()["email"], "walk@example.com")                 # normalised
        self.assertEqual(self.sent[-1]["email"], "walk@example.com")

    async def test_wrong_code_expires_after_attempts_and_code_is_single_use(self):
        await self.otp()
        right = self.sent[-1]["code"]
        wrong = "000000" if right != "000000" else "111111"
        for _ in range(settings.walkin_otp_attempts):
            r = await self.client.post("/v1/walk-in/otp/verify", json={"email": "walk@example.com", "code": wrong})
            self.assertEqual(r.status_code, 400)
        r = await self.client.post("/v1/walk-in/otp/verify", json={"email": "walk@example.com", "code": right})
        self.assertEqual(r.status_code, 400)                                     # locked even for the right code
        await self.otp()
        ok = await self.client.post("/v1/walk-in/otp/verify", json={"email": "walk@example.com", "code": self.sent[-1]["code"]})
        self.assertEqual(ok.status_code, 200)
        again = await self.client.post("/v1/walk-in/otp/verify", json={"email": "walk@example.com", "code": self.sent[-1]["code"]})
        self.assertEqual(again.status_code, 400)

    async def test_requesting_too_many_codes_is_throttled(self):
        for _ in range(settings.walkin_otp_per_email):
            self.assertEqual((await self.otp()).status_code, 200)
        self.assertEqual((await self.otp()).status_code, 429)

    async def test_undeliverable_email_is_a_503_not_a_fake_success(self):
        self.delivered = False
        r = await self.otp()
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (503, "OTP_DELIVERY_UNAVAILABLE"))
        v = await self.client.post("/v1/walk-in/otp/verify", json={"email": "walk@example.com", "code": self.sent[-1]["code"]})
        self.assertEqual(v.status_code, 400)                                     # the code that never arrived is dead

    async def test_dev_code_only_outside_production(self):
        self.delivered = False
        object.__setattr__(settings, "walkin_dev_otp", "246810")
        r = await self.otp()
        self.assertTrue(r.json().get("dev_mode"))
        v = await self.client.post("/v1/walk-in/otp/verify", json={"email": "walk@example.com", "code": "246810"})
        self.assertEqual(v.status_code, 200)
        object.__setattr__(settings, "env", "production")
        try:
            self.assertEqual((await self.otp("other@example.com")).status_code, 503)
        finally:
            object.__setattr__(settings, "env", "development")

    async def test_walk_in_token_is_useless_on_every_customer_endpoint(self):
        token = await self.session()
        for path in ("/v1/dashboard", "/v1/policies", "/v1/claims", "/v1/documents", "/v1/profile", "/v1/notifications", "/v1/payments", "/v1/family"):
            r = await self.client.get(path, headers=self.bearer(token))
            self.assertIn(r.status_code, (401, 404), (path, r.status_code))
        full, _ = await self.active_session()                                    # and a full customer token is useless here
        self.assertEqual((await self.client.get("/v1/walk-in/me", headers=self.bearer(full))).status_code, 401)

    async def test_application_requires_session_idempotency_key_and_consent(self):
        self.assertEqual((await self.client.post("/v1/walk-in/application", json=self.app_body(), headers={"idempotency-key": "abcdefgh12"})).status_code, 401)
        h = self.bearer(await self.session())
        self.assertEqual((await self.client.post("/v1/walk-in/application", json=self.app_body(), headers=h)).status_code, 422)
        self.assertEqual((await self.client.post("/v1/walk-in/application", json=self.app_body(consent=False), headers={**h, "idempotency-key": "abcdefgh12"})).status_code, 422)
        ok = await self.client.post("/v1/walk-in/application", json=self.app_body(), headers={**h, "idempotency-key": "abcdefgh12"})
        self.assertEqual((ok.status_code, ok.json()["reference"]), (200, "WI-2026-ABC123"))

    async def test_the_verified_email_not_the_form_is_sent_upstream(self):
        h = self.bearer(await self.session())
        r = await self.client.post("/v1/walk-in/application", json={**self.app_body(), "email": "evil@example.com"}, headers={**h, "idempotency-key": "abcdefgh12"})
        self.assertEqual(r.status_code, 422)                                     # unknown field refused
        await self.client.post("/v1/walk-in/application", json=self.app_body(), headers={**h, "idempotency-key": "abcdefgh12"})
        sent = [c for c in self.fake.calls if c[1].endswith("/walk-in/leads") and c[0] == "POST"][-1][2]
        self.assertEqual((sent["email"], sent["tenant_id"]), ("walk@example.com", TID))
        self.assertTrue(sent["request_key"].endswith(":abcdefgh12"))

    async def test_status_lists_only_the_verified_emails_requests_and_strips_internals(self):
        h = self.bearer(await self.session())
        cust = uuid4()
        self.leads = [{"customer_id": str(cust), "reference": "WI-1", "stage": "Agent Assigned", "handoff": {"available": True, "account_ready": False}}]
        r = (await self.client.get("/v1/walk-in/application", headers=h)).json()
        self.assertNotIn("customer_id", r["leads"][0])
        q = [c for c in self.fake.calls if c[1].endswith("/walk-in/leads") and c[0] == "GET"][-1][2]
        self.assertEqual(q["email"], "walk@example.com")

    async def test_handoff_flags_when_a_full_account_exists_and_keeps_both_logins(self):
        h = self.bearer(await self.session())
        await self.provision_account(customer_id=self.customer_id, tenant_id=__import__("uuid").UUID(TID))
        self.leads = [{"customer_id": str(self.customer_id), "reference": "WI-1", "stage": "Policy Issued", "handoff": {"available": True, "account_ready": False}}]
        r = (await self.client.get("/v1/walk-in/application", headers=h)).json()
        self.assertTrue(r["leads"][0]["handoff"]["account_ready"])
        async with db.transaction() as conn:
            self.assertEqual((await conn.execute(text("SELECT count(*) FROM walk_in_identities WHERE handed_off_at IS NOT NULL"))).scalar_one(), 1)
            self.assertEqual((await conn.execute(text("SELECT count(*) FROM accounts"))).scalar_one(), 1)         # no duplicate identity
        self.assertEqual((await self.login()).status_code, 200)                                                    # credentials untouched
        self.assertEqual((await self.client.get("/v1/walk-in/me", headers=h)).status_code, 200)

    async def test_logout_revokes_the_session(self):
        h = self.bearer(await self.session())
        self.assertEqual((await self.client.post("/v1/walk-in/logout", headers=h)).status_code, 200)
        self.assertEqual((await self.client.get("/v1/walk-in/me", headers=h)).status_code, 401)

    async def test_unconfigured_tenant_is_unavailable(self):
        walk_in._tenant_cache.clear()
        object.__setattr__(settings, "walkin_tenant_code", "")
        self.assertEqual((await self.client.get("/v1/walk-in/plans")).status_code, 503)

    # paying from the customer's side -------------------------------------------
    PAY = "a" * 32 + "." + "b" * 40

    async def test_payment_link_needs_no_session_and_only_reaches_its_own_payment(self):
        self.fake.routes[f"/pay/{self.PAY}"] = {"state": "Open", "amount": 1000.0}
        r = await self.client.get(f"/v1/walk-in/pay/{self.PAY}")                  # no Authorization header
        self.assertEqual((r.status_code, r.json()["state"]), (200, "Open"))
        for bad in ("short", "z" * 32 + "." + "b" * 40, self.PAY + "x", "../x"):
            self.assertEqual((await self.client.get(f"/v1/walk-in/pay/{bad}")).status_code, 404, bad)

    async def test_screenshot_upload_is_relayed_and_checked(self):
        self.fake.routes[f"/pay/{self.PAY}/proof"] = {"state": "ProofSubmitted"}
        ok = await self.client.post(f"/v1/walk-in/pay/{self.PAY}/proof", files={"file": ("p.png", b"\x89PNG", "image/png")}, data={"note": "paid"})
        self.assertEqual((ok.status_code, ok.json()["state"]), (200, "ProofSubmitted"))
        self.assertEqual((await self.client.post(f"/v1/walk-in/pay/{self.PAY}/proof", files={"file": ("p.png", b"", "image/png")})).status_code, 422)
        big = await self.client.post(f"/v1/walk-in/pay/{self.PAY}/proof", files={"file": ("p.png", b"x" * (10 * 1024 * 1024 + 1), "image/png")})
        self.assertEqual(big.status_code, 413)

    FAMILY = {"family_name": "Walk Family", "contact_phone": "+923001234567", "city": "Lahore", "policy_type": "Floater", "total_sum_insured": 5000000, "term_years": 1,
              "members": [
                  {"relationship": "Self", "name": "Walk In", "cnic": "35201-1111111-1", "dob": "1985-01-01", "gender": "Male", "occupation": "Engineer", "declared_income": 3000000},
                  {"relationship": "Spouse", "name": "Sara In", "is_insured": True, "cnic": "35201-7654321-2", "dob": "1992-02-02", "gender": "Female", "occupation": "Teacher", "declared_income": 900000, "share_pct": 50},
                  {"relationship": "Child", "name": "Ali In", "dob": "2015-03-03", "share_pct": 50}]}

    async def test_family_application_is_validated_and_forwarded(self):
        h = {**self.bearer(await self.session()), "idempotency-key": "famkey12345"}
        ok = {"applicant_type": "Family", "family": self.FAMILY, "plan_id": str(uuid4()), "consent": True}
        self.assertEqual((await self.client.post("/v1/walk-in/application", json=ok, headers=h)).status_code, 200)
        sent = [c for c in self.fake.calls if c[1].endswith("/walk-in/leads") and c[0] == "POST"][-1][2]
        self.assertEqual((sent["applicant_type"], len(sent["family"]["members"]), "profile" in sent), ("Family", 3, False))
        m = self.FAMILY["members"]
        for bad in ({**ok, "family": None}, {**ok, "family": {**self.FAMILY, "members": [m[0]]}},
                    {**ok, "family": {**self.FAMILY, "members": [m[0], {**m[1], "share_pct": 10}, m[2]]}},
                    {**ok, "family": {**self.FAMILY, "members": [m[1], m[2]]}},
                    {**ok, "family": {**self.FAMILY, "total_sum_insured": None}},
                    {**ok, "profile": self.app_body()["profile"]},
                    {**self.app_body(), "family": self.FAMILY}):
            self.assertEqual((await self.client.post("/v1/walk-in/application", json=bad, headers=h)).status_code, 422)

    async def test_customer_can_say_they_have_paid_without_a_receipt(self):
        self.fake.routes[f"/pay/{self.PAY}/declare"] = lambda payload: {"state": "ProofSubmitted", "echo": payload}
        r = await self.client.post(f"/v1/walk-in/pay/{self.PAY}/declare", json={"method": "JazzCash", "reference": "TX123", "note": "paid today"})   # no session
        self.assertEqual((r.status_code, r.json()["echo"]["reference"]), (200, "TX123"))
        self.assertEqual((await self.client.post(f"/v1/walk-in/pay/{self.PAY}/declare", json={"amount": 1})).status_code, 422)                       # unknown field
        self.assertEqual((await self.client.post("/v1/walk-in/pay/short/declare", json={})).status_code, 404)

    async def test_receipt_carries_the_method_and_reference(self):
        self.fake.routes[f"/pay/{self.PAY}/proof"] = lambda payload: {"state": "ProofSubmitted", "echo": payload}
        r = await self.client.post(f"/v1/walk-in/pay/{self.PAY}/proof", files={"file": ("p.png", b"\x89PNG", "image/png")}, data={"method": "Easypaisa", "reference": "R9"})
        self.assertEqual((r.json()["echo"]["method"], r.json()["echo"]["reference"]), ("Easypaisa", "R9"))

    async def test_demo_mode_signs_an_email_in_without_a_code(self):
        object.__setattr__(settings, "demo", True)
        try:
            self.assertTrue((await self.client.get("/v1/walk-in/config")).json()["demo"])
            r = await self.client.post("/v1/walk-in/otp/request", json={"email": "Demo@Example.com"})
            self.assertEqual((r.status_code, r.json()["demo"], self.sent), (200, True, []))          # nothing was emailed
            v = await self.client.post("/v1/walk-in/otp/verify", json={"email": "demo@example.com"})   # no code
            self.assertEqual(v.status_code, 200, v.text)
            me = await self.client.get("/v1/walk-in/me", headers=self.bearer(v.json()["access_token"]))
            self.assertEqual(me.json()["email"], "demo@example.com")
        finally:
            object.__setattr__(settings, "demo", False)
        self.assertFalse((await self.client.get("/v1/walk-in/config")).json()["demo"])
        self.assertEqual((await self.client.post("/v1/walk-in/otp/verify", json={"email": "demo@example.com"})).status_code, 400)   # outside demo a code is required

