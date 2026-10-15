import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from jose import jwt
from sqlalchemy import text

from app import accounts, db, migrate, security
from app.config import settings
from tests.support import NEW_PASSWORD, TEMP_PASSWORD, Base


class Provisioning(Base):
    async def test_post_issuance_credentials_log_in_and_force_a_password_change(self):
        out = await self.provision_account()
        self.assertEqual(out["status"], "created")
        r = await self.login()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual((body["scope"], body["must_change_password"]), ("pwd_change", True))
        # a first-login token can change the password but cannot read data
        self.assertEqual((await self.client.get("/v1/policies", headers=self.bearer(body["access_token"]))).json()["error"]["code"], "PASSWORD_CHANGE_REQUIRED")
        ok = await self.client.post("/v1/auth/password/first-change", headers=self.bearer(body["access_token"]),
                                    json={"current_password": TEMP_PASSWORD, "new_password": NEW_PASSWORD})
        self.assertEqual((ok.status_code, ok.json()["scope"]), (200, "full"))
        # temp password no longer works, the new one does, and the first-login session is gone
        self.assertEqual((await self.login()).status_code, 401)
        self.assertEqual((await self.login(password=NEW_PASSWORD)).status_code, 200)
        self.assertEqual((await self.client.get("/v1/me", headers=self.bearer(body["access_token"]))).status_code, 401)

    async def test_duplicate_provisioning_never_resets_an_active_customer(self):
        await self.active_session()
        again = await self.provision_account(password="Another9Temp1")  # e.g. ops opening a second policy
        self.assertEqual(again["status"], "already_active")
        self.assertEqual((await self.login(password=NEW_PASSWORD)).status_code, 200)  # password untouched
        self.assertEqual((await self.login(password="Another9Temp1")).status_code, 401)
        self.assertEqual((await self.provision_account(password="Another9Temp1", mode="reset"))["status"], "reset")  # only an explicit staff reset
        self.assertEqual((await self.login(password="Another9Temp1")).json()["scope"], "pwd_change")

    async def test_reissue_before_first_login_and_idempotent_replay(self):
        await self.provision_account()
        # same hash replayed -> unchanged; a new temp password before first use -> replaces the old one
        async with db.transaction() as conn:
            h = security.hash_password("Reissued9Pass")
            r = await accounts.ensure_account(conn, tenant_id=self.tenant_id, tenant_code="PAG34", customer_id=self.customer_id, username="PH-2026-000001",
                                              password_hash=h, display_name="x", credential_expires_at=None, mode="ensure", reason=None)
            r2 = await accounts.ensure_account(conn, tenant_id=self.tenant_id, tenant_code="PAG34", customer_id=self.customer_id, username="PH-2026-000001",
                                               password_hash=h, display_name="x", credential_expires_at=None, mode="ensure", reason=None)
        self.assertEqual((r["status"], r2["status"]), ("reset", "unchanged"))
        self.assertEqual((await self.login(password=TEMP_PASSWORD)).status_code, 401)
        self.assertEqual((await self.login(password="Reissued9Pass")).status_code, 200)

    async def test_one_account_per_customer_and_username_unique_per_tenant(self):
        await self.provision_account()
        other_customer = uuid4()
        with self.assertRaises(Exception) as ctx:
            await self.provision_account(customer_id=other_customer)  # same username, same tenant
        self.assertEqual(getattr(ctx.exception, "code", ""), "USERNAME_TAKEN")
        await self.provision_account(tenant_id=uuid4(), customer_id=other_customer, tenant_code="OTHER")  # same username, other tenant: fine

    async def test_same_username_in_two_companies_needs_a_company_code(self):
        await self.provision_account()
        await self.provision_account(tenant_id=uuid4(), customer_id=uuid4(), tenant_code="OTHER")
        self.assertEqual((await self.login()).json()["error"]["code"], "TENANT_CODE_REQUIRED")
        self.assertEqual((await self.login(tenant_code="pag34")).status_code, 200)

    async def test_internal_endpoint_requires_the_tenant_service_signature(self):
        from shared.security.service_auth import sign
        import json
        payload = {"tenant_id": str(self.tenant_id), "tenant_code": "PAG34", "customer_id": str(self.customer_id), "username": "PH-1", "password_hash": security.hash_password("x" * 12)}
        body = json.dumps(payload).encode()
        path = "/internal/v1/accounts"
        self.assertEqual((await self.client.put(path, content=body, headers={"content-type": "application/json"})).status_code, 401)
        bad = sign("wrong-key", "PUT", path, body, caller="tenant-service")
        self.assertEqual((await self.client.put(path, content=body, headers={"content-type": "application/json", **bad})).status_code, 401)
        wrong_caller = sign(settings.from_tenant_key, "PUT", path, body, caller="request-management")
        self.assertEqual((await self.client.put(path, content=body, headers={"content-type": "application/json", **wrong_caller})).status_code, 401)
        good = sign(settings.from_tenant_key, "PUT", path, body, caller="tenant-service")
        r = await self.client.put(path, content=body, headers={"content-type": "application/json", **good})
        self.assertEqual((r.status_code, r.json()["status"]), (200, "created"))
        self.assertNotIn("password", json.dumps(r.json()).lower())
        # a plaintext (non-bcrypt) value is refused outright
        payload["password_hash"] = "plaintext-password-here-123"
        body = json.dumps(payload).encode()
        r = await self.client.put(path, content=body, headers={"content-type": "application/json", **sign(settings.from_tenant_key, "PUT", path, body, caller="tenant-service")})
        self.assertEqual(r.status_code, 422)


class SignIn(Base):
    async def test_failures_are_generic_and_lock_the_account(self):
        await self.provision_account()
        codes = [(await self.login(password="wrong-pass-1")).json()["error"]["code"] for _ in range(5)]
        self.assertEqual(set(codes), {"INVALID_CREDENTIALS"})
        self.assertEqual((await self.login(username="nobody-here")).json()["error"]["code"], "INVALID_CREDENTIALS")
        locked = await self.login()  # even the right password is refused during the lockout
        self.assertEqual((locked.status_code, locked.json()["error"]["code"]), (429, "TOO_MANY_ATTEMPTS"))

    async def test_throttling_does_not_reveal_which_usernames_exist(self):
        for _ in range(5):
            await self.login(username="ghost-user", password="whatever-1")
        r = await self.login(username="ghost-user", password="whatever-1")
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (429, "TOO_MANY_ATTEMPTS"))

    async def test_suspended_expired_and_closed_accounts_cannot_sign_in(self):
        await self.provision_account()
        async with db.engine().connect() as c:
            aid = (await c.execute(text("SELECT id FROM accounts"))).scalar_one()
        async with db.transaction() as conn:
            await accounts.set_state(conn, aid, "SUSPENDED", "fraud review")
        r = await self.login()
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (403, "ACCOUNT_SUSPENDED"))
        self.assertEqual((await self.login(password="wrong-pass-1")).json()["error"]["code"], "INVALID_CREDENTIALS")  # no hint without the password
        async with db.transaction() as conn:
            await accounts.set_state(conn, aid, "ACTIVE", None)
            await conn.execute(text("UPDATE accounts SET credential_expires_at = now() - interval '1 day'"))
        self.assertEqual((await self.login()).json()["error"]["code"], "CREDENTIAL_EXPIRED")

    async def test_suspending_revokes_live_sessions(self):
        token, _ = await self.active_session()
        self.assertEqual((await self.client.get("/v1/me", headers=self.bearer(token))).status_code, 200)
        async with db.engine().connect() as c:
            aid = (await c.execute(text("SELECT id FROM accounts"))).scalar_one()
        async with db.transaction() as conn:
            await accounts.set_state(conn, aid, "SUSPENDED", "review")
        self.assertEqual((await self.client.get("/v1/me", headers=self.bearer(token))).status_code, 401)

    async def test_refresh_rotates_and_reuse_kills_the_session(self):
        token, refresh = await self.active_session()
        r1 = await self.client.post("/v1/auth/refresh", json={"refresh_token": refresh})
        self.assertEqual(r1.status_code, 200)
        self.assertNotEqual(r1.json()["refresh_token"], refresh)
        racing = await self.client.post("/v1/auth/refresh", json={"refresh_token": refresh})   # a second tab, a moment later
        self.assertEqual((racing.status_code, racing.json()["error"]["code"]), (409, "REFRESH_IN_PROGRESS"))
        self.assertEqual((await self.client.get("/v1/me", headers=self.bearer(r1.json()["access_token"]))).status_code, 200)  # session survives a race
        async with db.transaction() as conn:
            await conn.execute(text("UPDATE sessions SET rotated_at = now() - interval '1 minute'"))
        self.assertEqual((await self.client.post("/v1/auth/refresh", json={"refresh_token": refresh})).status_code, 401)  # replay long after: theft
        self.assertEqual((await self.client.get("/v1/me", headers=self.bearer(r1.json()["access_token"]))).status_code, 401)  # session revoked

    async def test_idle_and_absolute_expiry_end_the_session(self):
        token, refresh = await self.active_session()
        async with db.transaction() as conn:
            await conn.execute(text("UPDATE sessions SET idle_expires_at = now() - interval '1 minute' WHERE scope = 'full'"))
        self.assertEqual((await self.client.get("/v1/me", headers=self.bearer(token))).status_code, 401)
        self.assertEqual((await self.client.post("/v1/auth/refresh", json={"refresh_token": refresh})).status_code, 401)

    async def test_logout_ends_the_session(self):
        token, _ = await self.active_session()
        self.assertEqual((await self.client.post("/v1/auth/logout", headers=self.bearer(token))).status_code, 200)
        self.assertEqual((await self.client.get("/v1/me", headers=self.bearer(token))).status_code, 401)

    async def test_password_rules_and_change(self):
        token, _ = await self.active_session()
        h = self.bearer(token)
        bad = await self.client.post("/v1/auth/password/change", headers=h, json={"current_password": NEW_PASSWORD, "new_password": "short1"})
        self.assertEqual(bad.json()["error"]["details"]["problems"], ["TOO_SHORT"])
        wrong = await self.client.post("/v1/auth/password/change", headers=h, json={"current_password": "not-my-password", "new_password": "Brand#New2026x"})
        self.assertEqual(wrong.json()["error"]["code"], "CURRENT_PASSWORD_INCORRECT")
        ok = await self.client.post("/v1/auth/password/change", headers=h, json={"current_password": NEW_PASSWORD, "new_password": "Brand#New2026x"})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual((await self.client.get("/v1/me", headers=h)).status_code, 401)  # other sessions revoked
        # change is not allowed with a first-login token in the "change" flow once set
        again = await self.client.post("/v1/auth/password/first-change", headers=self.bearer(ok.json()["access_token"]),
                                       json={"current_password": "Brand#New2026x", "new_password": "Third#Pass2026x"})
        self.assertEqual(again.json()["error"]["code"], "NOT_REQUIRED")

    async def test_secrets_never_reach_the_audit_trail(self):
        await self.active_session()
        async with db.engine().connect() as c:
            rows = (await c.execute(text("SELECT kind, detail::text FROM security_events"))).all()
        blob = " ".join(f"{k} {d}" for k, d in rows)
        for secret in (TEMP_PASSWORD, NEW_PASSWORD, "$2b$"):
            self.assertNotIn(secret, blob)
        self.assertIn("LOGIN_SUCCESS", blob)


class TokenSeparation(Base):
    def forge(self, **over):
        claims = {"iss": settings.jwt_issuer, "aud": settings.jwt_audience, "sub": str(uuid4()), "sid": str(uuid4()), "tid": str(uuid4()),
                  "cid": str(uuid4()), "scp": "full", "iat": 0, "exp": 4102444800, **over}
        return claims

    async def test_staff_style_and_foreign_tokens_are_rejected(self):
        staff_secret = os.environ.get("JWT_SECRET_KEY", "staff-secret")
        # a staff token: different secret, no iss/aud/typ
        staff = jwt.encode({"sub": "staff@example.com", "tenant_id": str(uuid4()), "role_id": str(uuid4())}, staff_secret, algorithm="HS256")
        self.assertEqual((await self.client.get("/v1/dashboard", headers=self.bearer(staff))).status_code, 401)
        for headers, claims in [({"typ": "JWT"}, self.forge()),                      # right secret, wrong token type
                                ({"typ": "at+jwt"}, self.forge(aud="staff")),       # wrong audience
                                ({"typ": "at+jwt"}, self.forge(iss="insurance-ai/tenant-service")),
                                ({"typ": "at+jwt"}, self.forge(exp=1))]:            # expired
            tok = jwt.encode(claims, settings.jwt_secret, algorithm="HS256", headers=headers)
            self.assertEqual((await self.client.get("/v1/dashboard", headers=self.bearer(tok))).status_code, 401, headers)
        # a validly signed token for a session that does not exist
        tok = jwt.encode(self.forge(), settings.jwt_secret, algorithm="HS256", headers={"typ": "at+jwt"})
        self.assertEqual((await self.client.get("/v1/dashboard", headers=self.bearer(tok))).status_code, 401)
        self.assertEqual((await self.client.get("/v1/dashboard")).status_code, 401)

    async def test_customer_accounts_have_no_administrative_surface(self):
        token, _ = await self.active_session()
        for path in ("/internal/v1/accounts", "/admin", "/v1/admin/accounts", "/tenants", "/internal/v1/accounts/by-customer/" + str(self.customer_id)):
            r = await self.client.get(path, headers=self.bearer(token))
            self.assertIn(r.status_code, (401, 404, 405, 422), path)


class Migrations(Base):
    async def test_migrations_are_idempotent_and_detect_edits(self):
        from sqlalchemy.engine import make_url
        owner = make_url(os.environ["CM_DATABASE_URL"]).set(database=self.dbname, username="customer_management_owner",
                                                           password=os.environ["CM_DB_OWNER_PASSWORD"]).render_as_string(hide_password=False)
        self.assertEqual(await migrate.run(owner), [])  # second run: nothing to do
        async with db.transaction() as conn:
            pass
        app_role_cannot_ddl = False
        try:
            async with db.transaction() as conn:
                await conn.execute(text("CREATE TABLE sneaky (id int)"))
        except Exception:
            app_role_cannot_ddl = True
        self.assertTrue(app_role_cannot_ddl)
        async with db.engine().connect() as c:
            with self.assertRaises(Exception):
                await c.execute(text("SELECT 1 FROM public.tenants LIMIT 1"))  # no access to other services' tables
        with self.assertRaises(Exception):
            async with db.transaction() as conn:
                await conn.execute(text("UPDATE security_events SET kind = 'x'"))  # audit rows are append-only


class LegacyImport(Base):
    async def test_already_issued_credentials_keep_working_and_import_is_idempotent(self):
        from app import backfill
        from app.errors import ApiError  # noqa: F401
        legacy = [{"tenant_id": str(self.tenant_id), "tenant_code": "PAG34", "customer_id": str(self.customer_id), "username": "PH-2026-000007",
                   "password_hash": security.hash_password(TEMP_PASSWORD), "display_name": "Legacy Customer", "must_reset": True,
                   "credential_expires_at": (datetime.now(timezone.utc) + timedelta(days=3)).replace(tzinfo=None).isoformat(), "last_login_at": None},
                  {"tenant_id": str(self.tenant_id), "tenant_code": "PAG34", "customer_id": str(uuid4()), "username": "PH-2026-000008",
                   "password_hash": "not-a-bcrypt-hash", "display_name": "Bad", "must_reset": True, "credential_expires_at": None, "last_login_at": None}]
        self.fake.legacy_accounts = lambda offset, limit=200: _async(legacy if offset == 0 else [])
        first = await backfill.run()
        self.assertEqual(dict(first), {"imported": 1, "skipped_bad_hash": 1})
        self.assertEqual(dict(await backfill.run()), {"skipped_exists": 1, "skipped_bad_hash": 1})   # idempotent
        r = await self.login("PH-2026-000007")
        self.assertEqual((r.status_code, r.json()["scope"]), (200, "pwd_change"))     # the password ops already handed out still works
        self.assertEqual(dict(await backfill.run(dry_run=True)), {"would_import": 2})


async def _async(value):
    return value

    async def test_demo_mode_goes_straight_in_with_the_temporary_password(self):
        from app.config import settings
        await self.provision_account()
        object.__setattr__(settings, "demo", True)
        try:
            r = await self.login()
            self.assertEqual(r.status_code, 200, r.text)
            body = r.json()
            self.assertEqual((body["scope"], body["must_change_password"]), ("full", False))                 # no "set your own password" step
            ok = await self.client.get("/v1/dashboard", headers=self.bearer(body["access_token"]))
            self.assertNotIn(ok.status_code, (401, 403))                                                       # a full session
        finally:
            object.__setattr__(settings, "demo", False)
        # the account stays activated, and production behaviour is untouched for a fresh account
        await self.provision_account(username="PH-2026-000002", customer_id=__import__("uuid").uuid4())
        r2 = await self.login(username="PH-2026-000002")
        self.assertEqual((r2.json()["scope"], r2.json()["must_change_password"]), ("pwd_change", True))

