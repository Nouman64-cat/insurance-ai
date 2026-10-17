"""Bulk-upload document matching, against a disposable PostgreSQL database. The LLM is stubbed.

Run: docker compose exec -T tenant-service python test_document_classify.py
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
import routers.llm_config as llm_config
import services.report_llm as report_llm
from database import get_session
from routers.auth import create_access_token
from routers.underwriting_tracks import router as tracks_router
from shared.models.core import (Case, CaseStatusEnum, CaseTypeEnum, CaseUnderwritingTrack, Customer, MedicalExamOrder, Policy, Role,
                                SourceChannelEnum, Tenant, User)
from specialist_access import restrict_specialist_writes

DB = "tenant_classify_test_" + uuid4().hex[:10]
ADMIN = f"postgresql+asyncpg://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}@host.docker.internal:5432"
factory = None
PDF = b"%PDF-1.4 fake"
PNG = b"\x89PNG\r\n\x1a\n fake"

# What the stub "reads" in each file, keyed by its bytes.
ANSWERS = {
    b"%PDF-1.4 lipid": {"match": "LIPID", "confidence": 0.93, "reason": "Lipid profile table"},
    b"%PDF-1.4 ecg": {"match": "ECG", "confidence": 0.88, "reason": "12-lead ECG tracing"},
    b"%PDF-1.4 unsure": {"match": "ECG", "confidence": 0.3, "reason": "Unclear"},
    b"%PDF-1.4 invented": {"match": "MRI_BRAIN", "confidence": 0.99, "reason": "Not a required test"},
    b"%PDF-1.4 payslip": {"match": "Salary Slip", "confidence": 0.95, "reason": "Monthly pay slip"},
}


async def fake_ask_json(session, files, prompt, label, providers=None):
    return ANSWERS.get(files[0][0])


async def fake_providers(session):
    return [{"provider": "stub", "model": "stub", "api_key": "x"}]


class Classify(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        report_llm.ask_json = fake_ask_json
        llm_config.resolved_providers = fake_providers
        async with factory() as s:
            self.t = Tenant(name=f"T {uuid4()}", code="T" + uuid4().hex[:8]); s.add(self.t); await s.flush()
            roles = {}
            for n in ("Medical Underwriter", "Financial Underwriter"):
                r = (await s.exec(select(Role).where(Role.name == n))).first() or Role(name=n, description=""); s.add(r); await s.flush(); roles[n] = r.id
            def user(role): return User(tenant_id=self.t.id, role_id=roles[role], email=f"{uuid4()}@x.test", username=uuid4().hex, hashed_password="x", full_name=role)
            self.med, self.fin = user("Medical Underwriter"), user("Financial Underwriter"); s.add_all([self.med, self.fin]); await s.flush()
            cust = Customer(tenant_id=self.t.id, name="Bulk Person", cnic="35202-2222222-2"); s.add(cust); await s.flush()
            pol = Policy(tenant_id=self.t.id, customer_id=cust.id, product_name="Term Life", insurance_type="TERM_LIFE", coverage_amount=5_000_000.0, term_years=10, status="UnderReview")
            s.add(pol); await s.flush()
            self.case = Case(tenant_id=self.t.id, customer_id=cust.id, policy_id=pol.id, caseNumber="UW-" + uuid4().hex[:10], caseType=CaseTypeEnum.UNDERWRITING,
                             caseStatus=CaseStatusEnum.UNDER_REVIEW, sourceChannel=SourceChannelEnum.BRANCH)
            s.add(self.case); await s.flush()
            s.add(MedicalExamOrder(tenant_id=self.t.id, case_id=self.case.caseld, customer_id=cust.id, policy_id=pol.id,
                                   required_tests=[{"code": "LIPID", "name": "Lipid Profile"}, {"code": "ECG", "name": "Resting ECG"}]))
            s.add_all([CaseUnderwritingTrack(tenant_id=self.t.id, case_id=self.case.caseld, track="MEDICAL", status="IN_REVIEW", assigned_user_id=self.med.id),
                       CaseUnderwritingTrack(tenant_id=self.t.id, case_id=self.case.caseld, track="FINANCIAL", status="IN_REVIEW", assigned_user_id=self.fin.id)])
            await s.commit()
        self.app = FastAPI(); self.app.include_router(tracks_router)
        self.app.middleware("http")(restrict_specialist_writes)

        async def dep():
            async with factory() as s:
                yield s
        self.app.dependency_overrides[get_session] = dep
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        h = lambda u: {"authorization": "Bearer " + create_access_token({"sub": str(u.id)})}
        self.med_h, self.fin_h = h(self.med), h(self.fin)

    async def asyncTearDown(self):
        await self.http.aclose()

    async def classify(self, files, headers):
        url = f"/tenants/{self.t.id}/cases/{self.case.caseld}/underwriting-documents/classify"
        return await self.http.post(url, files=[("files", (name, data)) for name, data in files], headers=headers)

    async def test_medical_files_are_matched_to_required_tests(self):
        r = await self.classify([("scan1.pdf", b"%PDF-1.4 lipid"), ("scan2.pdf", b"%PDF-1.4 ecg")], self.med_h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([x["match"] for x in r.json()["results"]], ["LIPID", "ECG"])

    async def test_unsure_or_invented_answers_stay_unmatched(self):
        r = await self.classify([("a.pdf", b"%PDF-1.4 unsure"), ("b.pdf", b"%PDF-1.4 invented")], self.med_h)
        self.assertEqual([x["match"] for x in r.json()["results"]], [None, None])

    async def test_unreadable_formats_are_skipped_not_guessed(self):
        r = await self.classify([("photo.heic", b"\x00\x00\x00 ftypheic")], self.med_h)
        self.assertEqual(r.json()["results"][0]["match"], None)

    async def test_financial_files_match_financial_types(self):
        r = await self.classify([("doc.pdf", b"%PDF-1.4 payslip")], self.fin_h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["results"][0]["match"], "Salary Slip")
        # a medical answer is not a financial document type
        r = await self.classify([("doc.pdf", b"%PDF-1.4 lipid")], self.fin_h)
        self.assertIsNone(r.json()["results"][0]["match"])

    async def test_only_the_assigned_specialist_may_classify(self):
        async with factory() as s:
            row = (await s.exec(select(CaseUnderwritingTrack).where(CaseUnderwritingTrack.track == "MEDICAL", CaseUnderwritingTrack.case_id == self.case.caseld))).first()
            row.assigned_user_id = None; s.add(row); await s.commit()
        r = await self.classify([("scan1.pdf", b"%PDF-1.4 lipid")], self.med_h)
        self.assertEqual(r.status_code, 403, r.text)


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
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Classify))
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
