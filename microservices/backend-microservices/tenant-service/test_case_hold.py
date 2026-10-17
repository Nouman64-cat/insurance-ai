"""Underwriting hold, against a disposable PostgreSQL database.

Run: docker compose exec -T tenant-service python test_case_hold.py
"""
import os
os.environ["DISABLE_PGVECTOR"] = "true"
import asyncio
import sys
import unittest
from uuid import uuid4

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from case_hold import refuse_writes_on_held_case
from database import get_session
from routers.auth import create_access_token
from routers.cases import router as cases_router
from shared.models.core import (Case, CaseHistory, CaseStatusEnum, CaseTypeEnum, Customer, Policy, PolicyEvent, Role, SourceChannelEnum, Tenant, User)

DB = "tenant_hold_test_" + uuid4().hex[:10]
ADMIN = f"postgresql+asyncpg://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}@host.docker.internal:5432"
factory = None


class Hold(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async with factory() as s:
            self.t = Tenant(name=f"T {uuid4()}", code="T" + uuid4().hex[:8]); s.add(self.t); await s.flush()
            roles = {}
            for n in ("Underwriter", "Agent", "Viewer"):
                r = (await s.exec(select(Role).where(Role.name == n))).first() or Role(name=n, description=""); s.add(r); await s.flush(); roles[n] = r.id
            def user(role): return User(tenant_id=self.t.id, role_id=roles[role], email=f"{uuid4()}@x.test", username=uuid4().hex, hashed_password="x", full_name=role)
            self.uw, self.ag = user("Underwriter"), user("Agent"); s.add_all([self.uw, self.ag]); await s.flush()
            cust = Customer(tenant_id=self.t.id, name="Held Person", cnic="35202-9999999-9"); s.add(cust); await s.flush()
            pol = Policy(tenant_id=self.t.id, customer_id=cust.id, product_name="Term Life", insurance_type="TERM_LIFE", coverage_amount=1_000_000.0, term_years=10, status="UnderReview")
            s.add(pol); await s.flush()
            def case(status): return Case(tenant_id=self.t.id, customer_id=cust.id, policy_id=pol.id, caseNumber="UW-" + uuid4().hex[:10], caseType=CaseTypeEnum.UNDERWRITING,
                                          caseStatus=status, sourceChannel=SourceChannelEnum.BRANCH)
            self.c1, self.c2, self.done = case(CaseStatusEnum.PENDING_DOCUMENTS), case(CaseStatusEnum.UNDER_REVIEW), case(CaseStatusEnum.APPROVED)
            s.add_all([self.c1, self.c2, self.done]); await s.commit()
            self.pol_id = pol.id
        self.app = FastAPI(); self.app.include_router(cases_router)
        self.app.middleware("http")(refuse_writes_on_held_case)

        async def dep():
            async with factory() as s:
                yield s
        self.app.dependency_overrides[get_session] = dep
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.uw_h = {"authorization": "Bearer " + create_access_token({"sub": str(self.uw.id)})}
        self.ag_h = {"authorization": "Bearer " + create_access_token({"sub": str(self.ag.id)})}

    async def asyncTearDown(self):
        await self.http.aclose()

    def url(self, case, tail=""):
        return f"/tenants/{self.t.id}/cases/{case.caseld}{tail}"

    async def row(self, case):
        async with factory() as s:
            return await s.get(Case, case.caseld)

    async def test_hold_freezes_every_write_and_release_resumes_from_the_same_step(self):
        r = await self.http.post(self.url(self.c1, "/hold"), json={"reason": "CNIC photo does not match"}, headers=self.uw_h)
        self.assertEqual(r.status_code, 200, r.text)
        b = r.json()
        self.assertEqual((b["on_hold"], b["hold_reason"], b["held_from_status"], b["caseStatus"]), (True, "CNIC photo does not match", "Pending Documents", "Pending Documents"))
        # every write to the case is refused, whichever router owns it
        for method, tail, body in (("PATCH", "/status", {"status": "Approved"}), ("PUT", "", {"priorityLevel": "High"}), ("POST", "/requirements/determine", {}),
                                   ("POST", "/workflow/advance", {"step": "risk_assessment"}), ("POST", "/compliance/run", {}), ("PUT", "/acr", {}),
                                   ("POST", "/medical-exam/schedule", {}), ("POST", "/ipp/initiate", {}), ("POST", "/insurance-history/run", {}),
                                   ("PUT", "/e-application/custom-questions", {}), ("POST", "/change-plan", {}), ("DELETE", "", None)):
            resp = await self.http.request(method, self.url(self.c1, tail), json=body, headers=self.uw_h)
            self.assertEqual((resp.status_code, resp.json()["detail"]["code"]), (409, "CASE_ON_HOLD"), f"{method} {tail}")
        row = await self.row(self.c1)
        self.assertEqual((row.caseStatus, row.on_hold), (CaseStatusEnum.PENDING_DOCUMENTS, True))          # nothing moved
        # reads and notes stay open; another case is unaffected
        self.assertEqual((await self.http.get(self.url(self.c1), headers=self.uw_h)).json()["on_hold"], True)
        self.assertNotEqual((await self.http.post(self.url(self.c1, "/comments"), json={"commentText": "chasing the customer"}, headers=self.uw_h)).status_code, 409)
        other = await self.http.patch(self.url(self.c2, "/status"), json={"status": "Rejected"}, headers=self.uw_h)
        self.assertEqual(other.status_code, 200, other.text)
        # release: same step, writes work again
        rel = await self.http.post(self.url(self.c1, "/release"), json={"note": "customer corrected the details"}, headers=self.uw_h)
        self.assertEqual(rel.status_code, 200, rel.text)
        rb = rel.json()
        self.assertEqual((rb["on_hold"], rb["caseStatus"], rb["hold_reason"], rb["held_from_status"]), (False, "Pending Documents", None, None))
        back = await self.http.patch(self.url(self.c1, "/status"), json={"status": "Under Review"}, headers=self.uw_h)
        self.assertEqual(back.status_code, 200, back.text)
        async with factory() as s:
            kinds = [e.event_type for e in (await s.exec(select(PolicyEvent).where(PolicyEvent.policy_id == self.pol_id).order_by(PolicyEvent.created_at))).all()]
            self.assertEqual([k for k in kinds if k.startswith("Underwriting")], ["UnderwritingHeld", "UnderwritingResumed"])
            self.assertGreaterEqual(len((await s.exec(select(CaseHistory).where(CaseHistory.caseld == self.c1.caseld))).all()), 2)

    async def test_who_may_hold_and_when(self):
        self.assertEqual((await self.http.post(self.url(self.c1, "/hold"), json={"reason": "not allowed"}, headers=self.ag_h)).status_code, 403)
        self.assertEqual((await self.http.post(self.url(self.c1, "/hold"), json={"reason": "x"}, headers=self.uw_h)).status_code, 422)          # reason required
        self.assertEqual((await self.http.post(self.url(self.c1, "/hold"), json={"reason": "no auth"})).status_code, 401)
        done = await self.http.post(self.url(self.done, "/hold"), json={"reason": "already decided"}, headers=self.uw_h)
        self.assertEqual((done.status_code, done.json()["detail"]["code"]), (409, "CASE_NOT_HOLDABLE"))
        self.assertEqual((await self.http.post(self.url(self.c1, "/hold"), json={"reason": "first hold"}, headers=self.uw_h)).status_code, 200)
        again = await self.http.post(self.url(self.c1, "/hold"), json={"reason": "second hold"}, headers=self.uw_h)
        self.assertEqual((again.status_code, again.json()["detail"]["code"]), (409, "CASE_ALREADY_ON_HOLD"))
        self.assertEqual((await self.http.post(self.url(self.c1, "/release"), json={}, headers=self.ag_h)).status_code, 403)               # an agent cannot lift it either
        notheld = await self.http.post(self.url(self.c2, "/release"), json={}, headers=self.uw_h)
        self.assertEqual((notheld.status_code, notheld.json()["detail"]["code"]), (409, "CASE_NOT_ON_HOLD"))

    async def test_hold_is_scoped_to_the_tenant_and_the_case(self):
        ghost = f"/tenants/{uuid4()}/cases/{self.c1.caseld}/hold"
        self.assertEqual((await self.http.post(ghost, json={"reason": "wrong tenant"}, headers=self.uw_h)).status_code, 404)
        await self.http.post(self.url(self.c1, "/hold"), json={"reason": "scoped check"}, headers=self.uw_h)
        # the same case id under another tenant's path is not found, and is not blocked by this hold either
        foreign = await self.http.patch(f"/tenants/{uuid4()}/cases/{self.c1.caseld}/status", json={"status": "Approved"}, headers=self.uw_h)
        self.assertNotEqual(foreign.json().get("detail", {}).get("code") if isinstance(foreign.json().get("detail"), dict) else None, "CASE_ON_HOLD")


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
    try:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Hold))
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
