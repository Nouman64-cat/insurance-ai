"""Medical / financial underwriting tracks, against a disposable PostgreSQL database.

Run: docker compose exec -T tenant-service python test_underwriting_tracks.py
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
from specialist_access import restrict_specialist_writes
from database import get_session
from routers.auth import create_access_token
from routers.cases import router as cases_router
from routers.underwriting_tracks import router as tracks_router
from shared.models.core import (Case, CaseAuditTrail, CaseStatusEnum, CaseTypeEnum, Customer, Policy, Role, SourceChannelEnum, Tenant, User)

DB = "tenant_tracks_test_" + uuid4().hex[:10]
ADMIN = f"postgresql+asyncpg://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}@host.docker.internal:5432"
factory = None


class Tracks(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async with factory() as s:
            self.t = Tenant(name=f"T {uuid4()}", code="T" + uuid4().hex[:8]); s.add(self.t); await s.flush()
            roles = {}
            for n in ("Admin", "Medical Underwriter", "Financial Underwriter", "Agent"):
                r = (await s.exec(select(Role).where(Role.name == n))).first() or Role(name=n, description=""); s.add(r); await s.flush(); roles[n] = r.id
            def user(role, name): return User(tenant_id=self.t.id, role_id=roles[role], email=f"{uuid4()}@x.test", username=uuid4().hex, hashed_password="x", full_name=name)
            self.admin, self.med, self.fin, self.agent = (user("Admin", "Ayla Admin"), user("Medical Underwriter", "Dr Mehreen"),
                                                          user("Financial Underwriter", "Faisal Fin"), user("Agent", "Ali Agent"))
            s.add_all([self.admin, self.med, self.fin, self.agent]); await s.flush()
            cust = Customer(tenant_id=self.t.id, name="Track Person", cnic="35202-1111111-1"); s.add(cust); await s.flush()
            pol = Policy(tenant_id=self.t.id, customer_id=cust.id, product_name="Term Life", insurance_type="TERM_LIFE", coverage_amount=1_000_000.0, term_years=10, status="UnderReview")
            s.add(pol); await s.flush()
            self.case = Case(tenant_id=self.t.id, customer_id=cust.id, policy_id=pol.id, caseNumber="UW-" + uuid4().hex[:10], caseType=CaseTypeEnum.UNDERWRITING,
                             caseStatus=CaseStatusEnum.UNDER_REVIEW, sourceChannel=SourceChannelEnum.BRANCH)
            s.add(self.case); await s.commit()
        self.app = FastAPI(); self.app.include_router(cases_router); self.app.include_router(tracks_router)
        self.app.middleware("http")(refuse_writes_on_held_case)
        self.app.middleware("http")(restrict_specialist_writes)

        async def dep():
            async with factory() as s:
                yield s
        self.app.dependency_overrides[get_session] = dep
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        h = lambda u: {"authorization": "Bearer " + create_access_token({"sub": str(u.id)})}
        self.admin_h, self.med_h, self.fin_h, self.agent_h = h(self.admin), h(self.med), h(self.fin), h(self.agent)

    async def asyncTearDown(self):
        await self.http.aclose()

    def url(self, track):
        return f"/tenants/{self.t.id}/cases/{self.case.caseld}/underwriting-tracks/{track}"

    async def listed(self):
        r = await self.http.get(f"/tenants/{self.t.id}/cases", headers=self.admin_h)
        self.assertEqual(r.status_code, 200, r.text)
        return next(c for c in r.json() if c["caseld"] == str(self.case.caseld))

    async def test_untouched_case_reads_pending_on_both_tracks(self):
        row = await self.listed()
        self.assertEqual((row["medical_review"]["status"], row["financial_review"]["status"]), ("PENDING", "PENDING"))
        self.assertIsNone(row["medical_review"]["assigned_user_name"])

    async def test_admin_assigns_and_the_list_shows_it(self):
        r = await self.http.put(self.url("medical"), json={"assigned_user_id": str(self.med.id)}, headers=self.admin_h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["status"], r.json()["assigned_user_name"]), ("IN_REVIEW", "Dr Mehreen"))  # picking it up puts it in review
        row = await self.listed()
        self.assertEqual((row["medical_review"]["assigned_user_name"], row["financial_review"]["status"]), ("Dr Mehreen", "PENDING"))
        async with factory() as s:
            trail = (await s.exec(select(CaseAuditTrail).where(CaseAuditTrail.caseld == self.case.caseld))).all()
        self.assertTrue(any(a.entityChanged == "CaseUnderwritingTrack" for a in trail))

    async def test_each_specialist_works_only_their_own_track(self):
        self.assertEqual((await self.http.put(self.url("medical"), json={"status": "CLEARED"}, headers=self.fin_h)).status_code, 403)
        mine = await self.http.put(self.url("financial"), json={"assigned_user_id": str(self.fin.id), "status": "CLEARED", "note": "Income verified"}, headers=self.fin_h)
        self.assertEqual(mine.status_code, 200, mine.text)
        self.assertEqual((mine.json()["status"], mine.json()["note"]), ("CLEARED", "Income verified"))
        # a specialist may pick a review up for themselves, not hand it to someone else
        self.assertEqual((await self.http.put(self.url("medical"), json={"assigned_user_id": str(self.fin.id)}, headers=self.med_h)).status_code, 403)
        self.assertEqual((await self.http.put(self.url("financial"), json={"status": "CLEARED"}, headers=self.agent_h)).status_code, 403)

    async def test_assignee_must_be_able_to_take_that_track(self):
        r = await self.http.put(self.url("medical"), json={"assigned_user_id": str(self.fin.id)}, headers=self.admin_h)
        self.assertEqual(r.status_code, 422, r.text)
        other = await self.http.put(f"/tenants/{uuid4()}/cases/{self.case.caseld}/underwriting-tracks/medical", json={"status": "CLEARED"}, headers=self.admin_h)
        self.assertEqual(other.status_code, 403)

    async def test_underwriters_list_says_which_track_each_can_take(self):
        r = await self.http.get(f"/tenants/{self.t.id}/underwriting/underwriters", headers=self.admin_h)
        self.assertEqual(r.status_code, 200, r.text)
        tracks = {u["full_name"]: u["tracks"] for u in r.json()}
        self.assertEqual(tracks, {"Dr Mehreen": ["medical"], "Faisal Fin": ["financial"]})

    async def test_a_held_case_refuses_track_changes(self):
        hold = await self.http.post(f"/tenants/{self.t.id}/cases/{self.case.caseld}/hold", json={"reason": "awaiting CNIC copy"}, headers=self.admin_h)
        self.assertEqual(hold.status_code, 200, hold.text)
        self.assertEqual((await self.http.put(self.url("medical"), json={"status": "CLEARED"}, headers=self.admin_h)).status_code, 409)

    async def test_specialist_workspace_is_track_scoped(self):
        root = f"/tenants/{self.t.id}/underwriting/reviews"
        for headers, track, present, absent in [(self.med_h, 'medical', 'Medical questionnaire', 'Declared income (PKR)'),
                                                (self.fin_h, 'financial', 'Declared income (PKR)', 'Medical questionnaire')]:
            queue = await self.http.get(root, headers=headers)
            self.assertEqual(queue.status_code, 200, queue.text)
            self.assertEqual(queue.json()[0]['id'], str(self.case.caseld))
            detail = await self.http.get(root + f"/{self.case.caseld}", headers=headers)
            self.assertEqual(detail.status_code, 200, detail.text)
            self.assertEqual(detail.json()['track'], track)
            self.assertIn(present, detail.json()['evidence'])
            self.assertNotIn(absent, detail.json()['evidence'])
            self.assertIsNone(detail.json()['assessment'])
        self.assertEqual((await self.http.get(root, headers=self.agent_h)).status_code, 403)
        self.assertEqual((await self.http.get(f"/tenants/{uuid4()}/underwriting/reviews", headers=self.med_h)).status_code, 403)

    async def test_specialist_cannot_take_or_edit_another_assignee(self):
        # General underwriters can own either track, but a specialist cannot overwrite that owner.
        async with factory() as s:
            role = Role(name='Underwriter'); s.add(role); await s.flush()
            other = User(tenant_id=self.t.id, role_id=role.id, email=uuid4().hex+'@test.local', full_name='Other reviewer', username=uuid4().hex, hashed_password='unused')
            s.add(other); await s.commit()
        assigned = await self.http.put(self.url('medical'), json={'assigned_user_id': str(other.id)}, headers=self.admin_h)
        self.assertEqual(assigned.status_code, 200, assigned.text)
        denied = await self.http.put(self.url('medical'), json={'status':'CLEARED','note':'Attempt overwrite'}, headers=self.med_h)
        self.assertEqual(denied.status_code, 403)
        root=f"/tenants/{self.t.id}/underwriting/reviews"
        self.assertEqual((await self.http.get(root, headers=self.med_h)).json(), [])
        self.assertEqual((await self.http.get(root+f"/{self.case.caseld}",headers=self.med_h)).status_code,403)

    async def test_specialist_decision_requires_reason_and_self_assignment(self):
        self.assertEqual((await self.http.put(self.url('medical'),json={'status':'CLEARED'},headers=self.med_h)).status_code,422)
        saved=await self.http.put(self.url('medical'),json={'status':'REFERRED','note':'Need cardiology evidence'},headers=self.med_h)
        self.assertEqual(saved.status_code,200,saved.text)
        self.assertEqual(saved.json()['assigned_user_id'],str(self.med.id))
        self.assertEqual((await self.http.put(self.url('medical'),json={'clear_assignee':True},headers=self.med_h)).status_code,403)
        row=await self.listed()
        self.assertEqual(row['medical_review']['status'],'REFERRED')
        self.assertEqual(row['financial_review']['status'],'PENDING')

    async def test_specialists_cannot_mutate_general_workflows(self):
        for headers in (self.med_h,self.fin_h):
            for path in [f"/tenants/{self.t.id}/cases/{self.case.caseld}/compliance/run",
                         f"/tenants/{self.t.id}/cases/{self.case.caseld}/hold",
                         f"/tenants/{self.t.id}/policies/any/issue"]:
                response=await self.http.post(path,json={},headers=headers)
                self.assertEqual(response.status_code,403,response.text)


    async def test_closed_application_is_not_available_for_specialist_review(self):
        async with factory() as s:
            c=await s.get(Case,self.case.caseld); c.caseStatus=CaseStatusEnum.CLOSED; s.add(c); await s.commit()
        root=f"/tenants/{self.t.id}/underwriting/reviews"
        self.assertEqual((await self.http.get(root,headers=self.med_h)).json(),[])
        detail=await self.http.get(root+f"/{self.case.caseld}",headers=self.med_h)
        self.assertTrue(detail.json()['read_only'])
        response=await self.http.put(self.url('medical'),json={'status':'CLEARED','note':'Attempt late change'},headers=self.med_h)
        self.assertEqual(response.status_code,409,response.text)


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
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Tracks))
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
