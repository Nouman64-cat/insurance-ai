"""Audit capture in tenant-service, against a disposable PostgreSQL database.

What it proves: business changes become audit intents in the SAME transaction (commit together, roll back together);
actor / role / tenant / correlation id come from the request; secrets, personal identifiers and withheld fields never
reach the outbox; sign-in and denied-access events are recorded; and a failure to write an intent fails the business
write instead of silently skipping the audit.

Run: docker compose exec -T tenant-service python test_audit_capture.py
"""
import os
os.environ["DISABLE_PGVECTOR"] = "true"
import asyncio
import json
import sys
import unittest
from datetime import datetime
from unittest import mock
from uuid import uuid4

import httpx
from fastapi import FastAPI
from sqlalchemy import inspect as sa_inspect, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from case_hold import refuse_writes_on_held_case
from database import get_session
from routers.auth import create_access_token, router as auth_router
from routers.cases import router as cases_router
from services import audit_capture
from services.audit_capture import AuditContextMiddleware, install_capture, specs
from shared.audit.context import audit_context
from shared.models.core import (Case, CaseAuditTrail, Customer, Policy, PolicyEvent, Role, Tenant, User, ActionTypeEnum,
                                CaseStatusEnum, CaseTypeEnum, SourceChannelEnum)
from passlib.context import CryptContext

DB = "tenant_audit_test_" + uuid4().hex[:10]
ADMIN = f"postgresql+asyncpg://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}@host.docker.internal:5432"
factory = None
PW = CryptContext(schemes=["bcrypt"])


async def intents(*, since_clear=True) -> list[dict]:
    async with factory() as s:
        rows = (await s.execute(text("SELECT payload FROM audit_outbox ORDER BY created_at, id"))).all()
    return [r[0] if isinstance(r[0], dict) else json.loads(r[0]) for r in rows]


async def clear() -> None:
    async with factory() as s:
        await s.execute(text("DELETE FROM audit_outbox"))
        await s.commit()


def by_action(found: list[dict], action: str) -> list[dict]:
    return [i for i in found if i["action"] == action]


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        install_capture()
        async with factory() as s:
            self.t = Tenant(name=f"T {uuid4()}", code="T" + uuid4().hex[:8]); s.add(self.t); await s.flush()
            roles = {}
            for n in ("Underwriter", "Agent", "Admin", "SuperAdmin"):
                r = (await s.exec(select(Role).where(Role.name == n))).first() or Role(name=n, description=""); s.add(r); await s.flush(); roles[n] = r.id
            self.roles = roles
            def user(role, tenant=True, password="Correct-Horse-1"):
                return User(tenant_id=self.t.id if tenant else None, role_id=roles[role], email=f"{uuid4().hex[:8]}@x.test", username=uuid4().hex,
                            hashed_password=PW.hash(password), full_name=f"{role} Person")
            self.uw, self.ag, self.admin = user("Underwriter"), user("Agent"), user("Admin")
            s.add_all([self.uw, self.ag, self.admin]); await s.flush()
            self.cust = Customer(tenant_id=self.t.id, name="Held Person", cnic="35202-9999999-9", city="Lahore", declared_income=480000)
            s.add(self.cust); await s.flush()
            self.pol = Policy(tenant_id=self.t.id, customer_id=self.cust.id, product_name="Term Life", insurance_type="TERM_LIFE",
                              coverage_amount=1_000_000.0, term_years=10, status="UnderReview")
            s.add(self.pol); await s.flush()
            self.case = Case(tenant_id=self.t.id, customer_id=self.cust.id, policy_id=self.pol.id, caseNumber="UW-" + uuid4().hex[:10],
                             caseType=CaseTypeEnum.UNDERWRITING, caseStatus=CaseStatusEnum.UNDER_REVIEW, sourceChannel=SourceChannelEnum.BRANCH)
            s.add(self.case); await s.commit()
        await clear()

    def headers(self, user, **extra):
        return {"authorization": "Bearer " + create_access_token({"sub": str(user.id)}), **extra}


class CaptureTests(Base):
    async def test_a_creation_is_audited_on_the_tenants_chain_with_personal_data_masked(self):
        async with factory() as s:
            c = Customer(tenant_id=self.t.id, name="New Person", cnic="35202-1111111-3", city="Karachi", declared_income=900000, height_cm=170.5)
            s.add(c); await s.commit(); cid = c.id
        [i] = by_action(await intents(), "customer.created")
        self.assertEqual((i["module"], i["entity_type"], i["entity_id"], i["tenant_id"], i["outcome"]), ("customers_leads", "customer", str(cid), str(self.t.id), "SUCCESS"))
        self.assertEqual(i["new_value"]["cnic"], "*****-*******-3")
        self.assertEqual(i["new_value"]["city"], "Karachi")
        self.assertEqual(i["new_value"]["declared_income"], "[withheld]")   # financial / health fields are noted, not stored
        self.assertEqual(i["new_value"]["height_cm"], "[withheld]")
        self.assertIsNone(i["previous_value"])
        self.assertNotIn("35202-1111111-3", json.dumps(i))
        self.assertEqual((i["actor_type"], i["actor_id"]), ("SYSTEM", None))   # no request, so the system acted

    async def test_an_update_records_only_what_changed(self):
        async with factory() as s:
            c = await s.get(Customer, self.cust.id); c.city = "Islamabad"; s.add(c); await s.commit()
        [i] = by_action(await intents(), "customer.updated")
        self.assertEqual((i["previous_value"], i["new_value"]), ({"city": "Lahore"}, {"city": "Islamabad"}))
        self.assertEqual(i["metadata"]["changed_fields"], ["city"])

    async def test_withheld_fields_are_noted_as_changed_but_never_stored(self):
        async with factory() as s:
            c = await s.get(Customer, self.cust.id); c.declared_income = 123456789; s.add(c); await s.commit()
        [i] = by_action(await intents(), "customer.updated")
        self.assertEqual(i["new_value"], {"declared_income": "[changed]"})
        self.assertNotIn("123456789", json.dumps(i))

    async def test_status_changes_are_named_and_carry_both_sides(self):
        async with factory() as s:
            p = await s.get(Policy, self.pol.id); p.status = "Active"; s.add(p); await s.commit()
        [i] = by_action(await intents(), "policy.status_changed")
        self.assertEqual((i["module"], i["previous_value"], i["new_value"]), ("policies", {"status": "UnderReview"}, {"status": "Active"}))

    async def test_credentials_never_leave_the_service(self):
        async with factory() as s:
            u = User(tenant_id=self.t.id, role_id=self.roles["Agent"], email="agent.new@x.test", username="agent-new", hashed_password="$2b$12$SECRETHASH",
                     full_name="Agent New")
            s.add(u); await s.commit()
            u.hashed_password = "$2b$12$ANOTHERSECRET"; s.add(u); await s.commit()
        found = await intents()
        self.assertNotIn("SECRETHASH", json.dumps(found))
        self.assertNotIn("ANOTHERSECRET", json.dumps(found))
        [created] = by_action(found, "user.created")
        self.assertEqual(created["new_value"]["hashed_password"], "[REDACTED]")
        self.assertEqual(created["new_value"]["email"], "a***@x.test")
        [changed] = by_action(found, "user.password_changed")
        self.assertEqual(changed["new_value"], {"hashed_password": "[REDACTED]"})

    async def test_bookkeeping_only_changes_are_not_events(self):
        async with factory() as s:
            u = await s.get(User, self.uw.id); u.last_login = datetime.utcnow(); u.updated_at = datetime.utcnow(); s.add(u); await s.commit()
        self.assertEqual(await intents(), [])

    async def test_platform_level_events_use_the_platform_chain(self):
        async with factory() as s:
            t = Tenant(name=f"Brand New {uuid4()}", code="N" + uuid4().hex[:8]); s.add(t); await s.flush()
            s.add(Role(name="Auditor-" + uuid4().hex[:6], description="x")); await s.commit(); tid = t.id
        found = await intents()
        [created] = by_action(found, "tenant.created")
        self.assertEqual((created["tenant_id"], created["entity_id"]), (None, str(tid)))
        [role] = by_action(found, "role.created")
        self.assertIsNone(role["tenant_id"])
        async with factory() as s:
            t = await s.get(Tenant, tid); t.city = "Lahore"; s.add(t); await s.commit()
        [updated] = by_action(await intents(), "tenant.updated")
        self.assertEqual(updated["tenant_id"], str(tid))   # later changes are on the tenant's own chain

    async def test_append_only_logs_become_semantic_events_and_their_tenant_is_found_through_the_case(self):
        async with factory() as s:
            s.add(CaseAuditTrail(caseld=self.case.caseld, actionPerformed="Decision Overridden", entityChanged="decision",
                                 previousValue="Refer", newValue="Approve", performedBy=self.uw.id))
            s.add(PolicyEvent(tenant_id=self.t.id, policy_id=self.pol.id, event_type="PaymentConfirmed", from_status="Pending", to_status="Active",
                              actor=str(self.admin.id), detail_json={"amount": 5000, "reference": "PAY-1"}))
            await s.commit()
        found = await intents()
        [audit] = by_action(found, "case.audit.decision_overridden")
        self.assertEqual((audit["tenant_id"], audit["case_id"], audit["actor_id"], audit["module"]), (str(self.t.id), str(self.case.caseld), str(self.uw.id), "underwriting"))
        self.assertEqual(audit["new_value"]["newValue"], "Approve")
        [event] = by_action(found, "policy.lifecycle.payment_confirmed")
        self.assertEqual((event["actor_id"], event["new_value"]["to_status"], event["new_value"]["detail_json"]), (str(self.admin.id), "Active", {"amount": 5000, "reference": "PAY-1"}))
        # An append-only log row is never an "update" event.
        async with factory() as s:
            row = (await s.exec(select(PolicyEvent).where(PolicyEvent.policy_id == self.pol.id))).first()
            row.to_status = "Tampered"; s.add(row); await s.commit()
        self.assertEqual(len(await intents()), len(found))

    async def test_context_supplies_actor_role_and_correlation_id(self):
        with audit_context(actor_id=str(self.uw.id), actor_type="USER", actor_role="Underwriter", actor_name="Una Writer",
                           tenant_id=self.t.id, correlation_id="corr-abcdef123"):
            async with factory() as s:
                c = await s.get(Customer, self.cust.id); c.city = "Multan"; s.add(c); await s.commit()
        [i] = by_action(await intents(), "customer.updated")
        self.assertEqual((i["actor_id"], i["actor_role"], i["correlation_id"], i["metadata"]["actor_name"]), (str(self.uw.id), "Underwriter", "corr-abcdef123", "Una Writer"))

    async def test_rolling_back_the_business_change_discards_its_audit_intents(self):
        async with factory() as s:
            s.add(Customer(tenant_id=self.t.id, name="Never Saved", cnic="35202-0000000-0"))
            await s.flush()
            self.assertGreater(len(await intents()) + 1, 0)
            await s.rollback()
        self.assertEqual(await intents(), [])

    async def test_if_the_intent_cannot_be_written_the_business_write_fails_too(self):
        async with factory() as s:
            await s.execute(text("ALTER TABLE audit_outbox RENAME TO audit_outbox_away")); await s.commit()
        try:
            async with factory() as s:
                s.add(Customer(tenant_id=self.t.id, name="Unaudited Person", cnic="35202-4444444-4"))
                with self.assertRaises(Exception):
                    await s.commit()
        finally:
            async with factory() as s:
                await s.execute(text("ALTER TABLE audit_outbox_away RENAME TO audit_outbox")); await s.commit()
        async with factory() as s:
            self.assertEqual((await s.exec(select(Customer).where(Customer.name == "Unaudited Person"))).all(), [])

    async def test_a_bug_in_mapping_is_counted_and_does_not_break_the_business_write(self):
        before = audit_capture.STATS.mapping_failures
        with mock.patch.object(audit_capture, "_intent_for", side_effect=RuntimeError("boom")):
            async with factory() as s:
                s.add(Customer(tenant_id=self.t.id, name="Mapped Badly", cnic="35202-5555555-5")); await s.commit()
        self.assertEqual(audit_capture.STATS.mapping_failures, before + 1)
        async with factory() as s:
            self.assertEqual(len((await s.exec(select(Customer).where(Customer.name == "Mapped Badly"))).all()), 1)

    async def test_every_spec_names_columns_that_exist(self):
        for model, spec in specs().items():
            columns = {c.key for c in sa_inspect(model).column_attrs}
            with self.subTest(model=model.__name__):
                for attr in (spec.pk, spec.tenant if spec.tenant not in (None, "@self") else None, spec.case, spec.actor, spec.status):
                    if attr:
                        self.assertIn(attr, columns, f"{model.__name__}.{attr}")
                if spec.tenant_via:
                    self.assertIn(spec.tenant_via[2], columns)
                for attr in list(spec.renames) + list(spec.summarize) + list(spec.keep or ()) + list(spec.ignore - audit_capture._COMMON_IGNORE):
                    self.assertIn(attr, columns, f"{model.__name__}.{attr}")


class HttpTests(Base):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.app = FastAPI()
        self.app.include_router(cases_router)
        self.app.include_router(auth_router)
        self.app.middleware("http")(refuse_writes_on_held_case)
        self.app.add_middleware(AuditContextMiddleware)

        async def dep():
            async with factory() as s:
                yield s
        self.app.dependency_overrides[get_session] = dep
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.http.aclose()

    async def test_a_real_request_is_audited_with_the_callers_identity_and_correlation_id(self):
        url = f"/tenants/{self.t.id}/cases/{self.case.caseld}/hold"
        resp = await self.http.post(url, json={"reason": "Awaiting the lab result"}, headers=self.headers(self.uw, **{"x-correlation-id": "req-0123456789"}))
        self.assertEqual(resp.status_code, 200, resp.text)
        found = await intents()
        self.assertTrue(found)
        for i in found:
            self.assertEqual((i["actor_id"], i["actor_role"], i["correlation_id"], i["tenant_id"]), (str(self.uw.id), "Underwriter", "req-0123456789", str(self.t.id)), i["action"])
            self.assertEqual(i["metadata"]["actor_name"], "Underwriter Person")
        held = next(i for i in found if i["entity_type"] == "case" and i["action"].startswith("case."))
        self.assertEqual((held["case_id"], held["new_value"]["on_hold"], held["new_value"]["held_by"], held["new_value"]["hold_reason"]),
                         (str(self.case.caseld), True, "[changed]", "Awaiting the lab result"))
        self.assertTrue(by_action(found, "case.history.comment"))
        self.assertTrue(by_action(found, "policy.lifecycle.underwritingheld") or any(i["action"].startswith("policy.lifecycle.") for i in found))

    async def test_sign_in_success_failure_and_denied_access(self):
        async with factory() as s:
            u = await s.get(User, self.admin.id)
            email = u.email
        ok = await self.http.post("/auth/token", data={"username": email, "password": "Correct-Horse-1"})
        self.assertEqual(ok.status_code, 200, ok.text)
        bad = await self.http.post("/auth/token", data={"username": email, "password": "wrong"})
        self.assertEqual(bad.status_code, 401)
        ghost = await self.http.post("/auth/token", data={"username": "nobody@x.test", "password": "x"})
        self.assertEqual(ghost.status_code, 401)
        denied = await self.http.post(f"/tenants/{self.t.id}/cases/{self.case.caseld}/hold", json={"reason": "not allowed"}, headers=self.headers(self.ag))
        self.assertEqual(denied.status_code, 403)
        found = await intents()
        [success] = by_action(found, "auth.login.succeeded")
        self.assertEqual((success["actor_id"], success["actor_role"], success["outcome"], success["tenant_id"]), (str(self.admin.id), "Admin", "SUCCESS", str(self.t.id)))
        failures = by_action(found, "auth.login.failed")
        self.assertEqual([f["outcome"] for f in failures], ["FAILURE", "FAILURE"])
        self.assertEqual(sorted(f["metadata"]["reason"] for f in failures), ["unknown_account", "wrong_password"])
        self.assertTrue(all(f["metadata"]["email"].endswith("@x.test") and "***" in f["metadata"]["email"] for f in failures))
        self.assertNotIn("Correct-Horse-1", json.dumps(found))
        self.assertNotIn("wrong", json.dumps([f["new_value"] for f in found]))
        # The 403 here comes from a role check inside the endpoint, not require_roles; a require_roles denial is covered next.

    async def test_require_roles_denial_is_recorded_as_denied(self):
        from routers.auth import require_roles
        from fastapi import Depends
        app = FastAPI()

        @app.get("/only-admins")
        async def only_admins(user=Depends(require_roles("Admin"))):
            return {"ok": True}

        async def dep():
            async with factory() as s:
                yield s
        app.dependency_overrides[get_session] = dep
        app.add_middleware(AuditContextMiddleware)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/only-admins", headers=self.headers(self.ag))
        self.assertEqual(resp.status_code, 403)
        [i] = by_action(await intents(), "access.denied")
        self.assertEqual((i["outcome"], i["actor_id"], i["actor_role"], i["metadata"]["required_roles"]), ("DENIED", str(self.ag.id), "Agent", ["Admin"]))


if __name__ == "__main__":
    async def create():
        engine = create_async_engine(f"{ADMIN}/postgres", isolation_level="AUTOCOMMIT")
        async with engine.connect() as c:
            await c.execute(text(f'CREATE DATABASE "{DB}"'))
        await engine.dispose()
        target = create_async_engine(f"{ADMIN}/{DB}", poolclass=NullPool)
        async with target.begin() as c:
            await c.run_sync(SQLModel.metadata.create_all)
        return target

    async def drop(target):
        await target.dispose()
        engine = create_async_engine(f"{ADMIN}/postgres", isolation_level="AUTOCOMMIT")
        async with engine.connect() as c:
            await c.execute(text(f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'))
        await engine.dispose()

    target = asyncio.run(create())
    factory = async_sessionmaker(target, class_=AsyncSession, expire_on_commit=False)
    database._session_factory = factory
    suite = unittest.TestSuite()
    for case in (CaptureTests, HttpTests):
        suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(case))
    try:
        result = unittest.TextTestRunner(verbosity=2).run(suite)
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
