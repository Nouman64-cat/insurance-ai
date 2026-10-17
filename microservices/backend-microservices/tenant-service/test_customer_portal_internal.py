"""Tenant-service's customer-portal adapter, against a disposable PostgreSQL database.

Run: docker compose exec -T tenant-service python test_customer_portal_internal.py
Creates a throwaway database with the Postgres admin credentials from .env (POSTGRES_USER / POSTGRES_PASSWORD) and drops it
afterwards. No existing data is read or changed.
"""
import os
os.environ["DISABLE_PGVECTOR"] = "true"
os.environ.setdefault("CM_TO_TENANT_KEY", "test-key-" + "y" * 32)
import asyncio
import json
import sys
import unittest
from datetime import date, datetime, timedelta
from uuid import uuid4

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.customer_portal_internal import router
from shared.models.core import (Claim, Customer, CustomerPortalAccount, Policy, PolicyEvent, PremiumReceipt, PremiumSchedule, Tenant)
from shared.security.service_auth import sign

KEY = os.environ["CM_TO_TENANT_KEY"]
DB = "tenant_cp_test_" + uuid4().hex[:10]
ADMIN = f"postgresql+asyncpg://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}@host.docker.internal:5432"
factory = None
BASE = "/internal/customer-portal/v1"


class Adapter(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        today = date.today()
        async with factory() as s:
            self.t1, self.t2 = Tenant(name=f"T1 {uuid4()}", code="T" + uuid4().hex[:8]), Tenant(name=f"T2 {uuid4()}", code="T" + uuid4().hex[:8])
            s.add_all([self.t1, self.t2]); await s.commit()
            self.a = Customer(tenant_id=self.t1.id, name="Alice A", cnic="35202-1234567-1", policyholder_id="PH-1", city="Lahore", details={"contact_email": "a@x.test"})
            self.b = Customer(tenant_id=self.t1.id, name="Bob B", cnic="35202-7654321-9", policyholder_id="PH-2")
            self.c = Customer(tenant_id=self.t2.id, name="Carol C", cnic="42101-1111111-1", policyholder_id="PH-1")
            s.add_all([self.a, self.b, self.c]); await s.commit()

            def pol(cust, status, num, cover=1_000_000, **kw):
                return Policy(tenant_id=cust.tenant_id, customer_id=cust.id, product_name="Term Life", insurance_type="TERM_LIFE", coverage_amount=cover,
                              term_years=10, status=status, policy_number=num, effective_date=today - timedelta(days=40), **kw)
            self.pa, self.pa_lapsed, self.pa_quote = pol(self.a, "Active", "PL-A1"), pol(self.a, "Lapsed", "PL-A2"), pol(self.a, "Quoted", "PL-A3")
            self.pb, self.pc = pol(self.b, "Active", "PL-B1"), pol(self.c, "Active", "PL-C1")
            s.add_all([self.pa, self.pa_lapsed, self.pa_quote, self.pb, self.pc]); await s.commit()
            for p in (self.pa, self.pb):
                s.add(PolicyEvent(tenant_id=p.tenant_id, policy_id=p.id, event_type="PaymentConfirmed", from_status="PendingPayment", to_status="Active",
                                  created_at=datetime.utcnow() - timedelta(days=40)))
            # A: installment 1 overdue (past due, in grace), installment 2 upcoming.
            self.s1 = PremiumSchedule(policy_id=self.pa.id, billing_frequency="Quarterly", due_date=today - timedelta(days=5), amount_due=10000.0, installment_no=1, status="Pending")
            self.s2 = PremiumSchedule(policy_id=self.pa.id, billing_frequency="Quarterly", due_date=today + timedelta(days=80), amount_due=10000.0, installment_no=2, status="Pending")
            self.sb = PremiumSchedule(policy_id=self.pb.id, billing_frequency="Annual", due_date=today - timedelta(days=1), amount_due=5000.0, installment_no=1, status="Pending")
            s.add_all([self.s1, self.s2, self.sb])
            s.add(PremiumReceipt(tenant_id=self.t1.id, policy_id=self.pb.id, receipt_no="RCPT-B-1", base_amount=1.0, total_amount=1.0, commission_amount=123.0, commission_agent_id="agent-x"))
            self.cb = Claim(tenant_id=self.t1.id, policy_id=self.pb.id, claim_number="CLM-B-1", claim_type="Hospitalization / Reimbursement", submitted_amount=100.0,
                            fraud_probability=0.91, duplicate_flag=True, claimant_relationship="Self")
            s.add(self.cb); await s.commit()
        self.app = FastAPI(); self.app.include_router(router)

        async def session_dependency():
            async with factory() as s:
                yield s
        self.app.dependency_overrides[get_session] = session_dependency
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.http.aclose()

    def scope(self, tenant, customer):
        return f"{BASE}/tenants/{tenant.id}/customers/{customer.id}"

    async def call(self, method, path, body=None, key=KEY, caller="customer-management"):
        data = json.dumps(body).encode() if body is not None else b""
        headers = sign(key, method, path, data, caller=caller)
        return await self.http.request(method, path, content=data, headers={**headers, "Content-Type": "application/json"})

    # service authentication ---------------------------------------------------
    async def test_requires_the_customer_management_signature(self):
        p = self.scope(self.t1, self.a) + "/policies"
        self.assertEqual((await self.http.get(p)).status_code, 401)
        self.assertEqual((await self.call("GET", p, key="wrong-key")).status_code, 401)
        self.assertEqual((await self.call("GET", p, caller="request-management")).status_code, 401)
        self.assertEqual((await self.call("GET", p)).status_code, 200)

    # isolation ----------------------------------------------------------------
    async def test_list_has_only_this_customers_visible_individual_policies(self):
        r = await self.call("GET", self.scope(self.t1, self.a) + "/policies")
        self.assertEqual(sorted(p["policy_number"] for p in r.json()), ["PL-A1", "PL-A2"])   # quote hidden, B and C absent

    async def test_other_customers_and_other_tenants_policies_are_404(self):
        for tenant, cust, policy in ((self.t1, self.a, self.pb), (self.t1, self.a, self.pc), (self.t2, self.c, self.pa), (self.t2, self.a, self.pa)):
            r = await self.call("GET", f"{self.scope(tenant, cust)}/policies/{policy.id}")
            self.assertEqual(r.status_code, 404, (cust.name, policy.policy_number))
        self.assertEqual((await self.call("GET", f"{self.scope(self.t1, self.a)}/policies/{self.pa_quote.id}")).status_code, 404)  # a quote is not a policy yet
        self.assertEqual((await self.call("GET", f"{self.scope(self.t1, self.a)}/policies/{self.pa.id}")).status_code, 200)

    async def test_nothing_below_a_policy_leaks_across_customers(self):
        a = self.scope(self.t1, self.a)
        self.assertEqual((await self.call("GET", f"{a}/policies/{self.pb.id}/premiums")).status_code, 404)
        self.assertEqual((await self.call("GET", f"{a}/claims/{self.cb.id}")).status_code, 404)
        self.assertEqual((await self.call("GET", f"{a}/claims")).json(), [])
        self.assertEqual((await self.call("POST", f"{a}/policies/{self.pb.id}/premiums/{self.sb.id}/pay",
                                          {"method": "Card", "reference": "SIM-ABCDEFGH", "expected_amount": 5000})).status_code, 404)
        r = await self.call("GET", f"{a}/documents")
        self.assertTrue(all(d["policy_number"] in ("PL-A1", "PL-A2") for d in r.json()))
        h = f"receipt:{self.pb.id}:{uuid4()}"
        self.assertEqual((await self.call("GET", f"{a}/documents/download?handle={h}")).status_code, 404)
        h2 = f"receipt:{self.pa.id}:{(await self._receipt_id_of_b())}"          # B's receipt id under A's policy
        self.assertEqual((await self.call("GET", f"{a}/documents/download?handle={h2}")).status_code, 404)

    async def _receipt_id_of_b(self):
        async with factory() as s:
            return (await s.exec(select(PremiumReceipt).where(PremiumReceipt.policy_id == self.pb.id))).first().id

    async def test_customer_must_belong_to_the_named_tenant(self):
        async with factory() as s:
            emp = Customer(tenant_id=self.t1.id, name="Emp", family_group_id=None, organization_id=None)
            s.add(emp); await s.commit()
        self.assertEqual((await self.call("GET", self.scope(self.t1, emp) + "/policies")).status_code, 200)   # an individual with no policies
        self.assertEqual((await self.call("GET", self.scope(self.t2, self.a) + "/policies")).status_code, 404)  # wrong tenant for this customer

    # customer-safe views ------------------------------------------------------
    async def test_views_never_contain_staff_only_fields(self):
        a = self.scope(self.t1, self.a)
        blob = json.dumps([(await self.call("GET", f"{a}/policies/{self.pa.id}")).json(), (await self.call("GET", f"{a}/policies")).json(),
                           (await self.call("GET", f"{a}/policies/{self.pa.id}/premiums")).json(), (await self.call("GET", f"{a}/profile")).json()]).lower()
        for banned in ("commission", "fraud", "duplicate_flag", "demo_bypass", "assigned_underwriter", "password", "35202-1234567-1"):
            self.assertNotIn(banned, blob, banned)
        self.assertIn("35202-*******-1", blob)   # CNIC is masked

    async def test_premium_view_counts_only_what_is_payable_today_as_outstanding(self):
        r = (await self.call("GET", f"{self.scope(self.t1, self.a)}/policies/{self.pa.id}/premiums")).json()
        s = r["summary"]
        self.assertEqual(s["remaining"], 20000.0)
        self.assertEqual(s["due_now"], 10200.0)                  # installment 1 + 2% late surcharge; installment 2 is not due yet
        self.assertEqual(r["payable_installment_id"], str(self.s1.id))
        self.assertEqual([i["payable_now"] for i in r["installments"]], [True, False])

    # paying a premium ---------------------------------------------------------
    async def pay(self, schedule, amount, ref="SIM-ABCDEFGH01", policy=None):
        return await self.call("POST", f"{self.scope(self.t1, self.a)}/policies/{(policy or self.pa).id}/premiums/{schedule.id}/pay",
                               {"method": "JazzCash", "reference": ref, "expected_amount": amount})

    async def test_payment_rules(self):
        self.assertEqual((await self.pay(self.s2, 10000.0)).json()["detail"]["code"], "PAY_OLDEST_FIRST")
        self.assertEqual((await self.pay(self.s1, 10000.0)).json()["detail"]["code"], "AMOUNT_CHANGED")   # surcharge applies, so 10,000 is stale
        r = await self.pay(self.s1, 10200.0)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["simulated"], r.json()["receipt"]["total"]), (True, 10200.0))
        self.assertEqual((await self.pay(self.s1, 10200.0, ref="SIM-ABCDEFGH02")).json()["detail"]["code"], "ALREADY_PAID")   # no double charge
        async with factory() as s:
            self.assertEqual(len((await s.exec(select(PremiumReceipt).where(PremiumReceipt.schedule_id == self.s1.id))).all()), 1)
        nxt = await self.pay(self.s2, 10000.0, ref="SIM-ABCDEFGH03")
        self.assertEqual(nxt.status_code, 200)

    async def test_cannot_pay_on_a_lapsed_policy(self):
        async with factory() as s:
            sc = PremiumSchedule(policy_id=self.pa_lapsed.id, billing_frequency="Annual", due_date=date.today() - timedelta(days=200), amount_due=900.0, installment_no=1, status="Overdue")
            s.add(sc); await s.commit()
        r = await self.pay(sc, 900.0, policy=self.pa_lapsed)
        self.assertEqual(r.json()["detail"]["code"], "POLICY_NOT_PAYABLE")

    # claims -------------------------------------------------------------------
    async def test_death_claims_are_refused_for_self_service(self):
        r = await self.call("POST", f"{self.scope(self.t1, self.a)}/policies/{self.pa.id}/claims",
                            {"category": "Death", "event_date": date.today().isoformat(), "description": "not allowed online", "claimed_amount": 1000})
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (422, "CLAIM_TYPE_NOT_SUPPORTED_ONLINE"))

    async def test_claim_types_the_plan_does_not_cover_are_refused(self):
        r = await self.call("POST", f"{self.scope(self.t1, self.a)}/policies/{self.pa.id}/claims",
                            {"category": "Hospitalization", "event_date": date.today().isoformat(), "description": "Admitted overnight", "claimed_amount": 1000})
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (422, "INELIGIBLE_CLAIM_TYPE"))   # a term-life plan has no hospital benefit

    async def test_claim_options_list_only_self_claim_categories(self):
        r = (await self.call("GET", f"{self.scope(self.t1, self.a)}/policies/{self.pa.id}/claims/options")).json()
        self.assertEqual([c["key"] for c in r["categories"]], ["Hospitalization", "Disability"])
        self.assertIn("Death", r["out_of_scope"])

    # contact ------------------------------------------------------------------
    async def test_contact_update_validates_and_leaves_identity_alone(self):
        p = self.scope(self.t1, self.a) + "/profile/contact"
        self.assertEqual((await self.call("PATCH", p, {"email": "not-an-email"})).status_code, 422)
        self.assertEqual((await self.call("PATCH", p, {"phone": "abc"})).status_code, 422)
        self.assertEqual((await self.call("PATCH", p, {})).status_code, 422)
        r = await self.call("PATCH", p, {"email": "new@x.test", "phone": "+92 300 1112223"})
        self.assertEqual((r.json()["email"], r.json()["name"], r.json()["cnic_masked"]), ("new@x.test", "Alice A", "35202-*******-1"))
        self.assertEqual((await self.call("GET", self.scope(self.t1, self.b) + "/profile")).json()["email"], None)   # B untouched

    # credential hand-off ------------------------------------------------------
    async def test_legacy_export_and_sync_back(self):
        async with factory() as s:
            s.add(CustomerPortalAccount(tenant_id=self.t1.id, customer_id=self.a.id, username="PH-1", password_hash="$2b$12$" + "a" * 53, status="Active", must_reset=True))
            await s.commit()
        rows = (await self.call("GET", f"{BASE}/legacy-accounts")).json()
        mine = [r for r in rows if r["customer_id"] == str(self.a.id)][0]
        self.assertEqual((mine["username"], mine["tenant_code"], mine["must_reset"]), ("PH-1", self.t1.code, True))
        r = await self.call("POST", f"{self.scope(self.t1, self.a)}/portal-sync", {"password_hash": "$2b$12$" + "b" * 53, "must_reset": False})
        self.assertEqual(r.status_code, 200)
        async with factory() as s:
            acct = (await s.exec(select(CustomerPortalAccount).where(CustomerPortalAccount.customer_id == self.a.id))).first()
            self.assertEqual((acct.must_reset, acct.password_hash[-1]), (False, "b"))
        self.assertEqual((await self.call("POST", f"{self.scope(self.t1, self.b)}/portal-sync", {"must_reset": False})).status_code, 404)


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
    try:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Adapter))
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
