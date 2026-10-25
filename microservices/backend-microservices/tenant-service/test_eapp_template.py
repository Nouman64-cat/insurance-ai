"""The customer e-application with questions a Super Admin added to the Proposal template: the public link reads the published template, a draft save
checks the answers' shape and keeps them in `declaration.custom`, and submitting enforces the required ones. Against a disposable PostgreSQL database.

Run: docker exec insurance-tenant-service python test_eapp_template.py
"""
import os
os.environ["DISABLE_PGVECTOR"] = "true"
os.environ.setdefault("CM_TO_TENANT_KEY", "test-key-" + "y" * 32)
os.environ["GEMINI_API_KEY"] = "test"
import asyncio
import hashlib
import sys
import unittest
from datetime import datetime, timedelta
from uuid import uuid4

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

import test_walk_in as base
from database import get_session
from routers import e_application
from shared import doc_templates as dt
from shared.models.core import Case, CaseTypeEnum, Customer, CustomerEApplication, EApplicationStatusEnum, Role, Tenant, User, UserStatus
from shared.models.templates import DocumentTemplate, DocumentTemplateVersion


class EAppTemplate(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.raw = "tok-" + uuid4().hex
        async with base.factory() as s:
            t = Tenant(name=f"T {uuid4()}", code="E" + uuid4().hex[:8]); s.add(t); await s.flush()
            c = Customer(tenant_id=t.id, name="Eapp Test"); s.add(c); await s.flush()
            from shared.models.core import SourceChannelEnum
            case = Case(tenant_id=t.id, customer_id=c.id, caseNumber="C-" + uuid4().hex[:8], caseType=CaseTypeEnum.UNDERWRITING, sourceChannel=list(SourceChannelEnum)[0]); s.add(case); await s.flush()
            s.add(CustomerEApplication(tenant_id=t.id, case_id=case.caseld, customer_id=c.id, status=EApplicationStatusEnum.SENT,
                                       invite_token_hash=hashlib.sha256(self.raw.encode()).hexdigest(), invite_expires_at=datetime.utcnow() + timedelta(days=3)))
            await s.commit()
        self.app = FastAPI(); self.app.include_router(e_application.router)

        async def dep():
            async with base.factory() as s:
                yield s
        self.app.dependency_overrides[get_session] = dep
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        content = dt.seed_proposal()
        content["sections"][0]["fields"].append({"id": "referral_name", "label": "Who referred you?", "type": "text", "required": True, "binding": {"store": "details"}})
        content["sections"][1]["fields"].append({"id": "blood_group", "label": "Blood group", "type": "select", "binding": {"store": "details"}, "options": [{"id": "o", "label": "O+", "value": "O+"}]})
        async with base.factory() as s:
            t = (await s.exec(select(DocumentTemplate).where(DocumentTemplate.template_key == "proposal"))).first()
            if t is None:
                t = DocumentTemplate(template_key="proposal", kind="proposal", title="Proposal"); s.add(t); await s.flush()
            for v in (await s.exec(select(DocumentTemplateVersion).where(DocumentTemplateVersion.template_id == t.id, DocumentTemplateVersion.state == "published"))).all():
                v.state = "superseded"; s.add(v)
            await s.flush()
            top = max([v.version for v in (await s.exec(select(DocumentTemplateVersion).where(DocumentTemplateVersion.template_id == t.id))).all()] or [0])
            self.version = top + 1
            role = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
            if role is None:
                role = Role(name="SuperAdmin"); s.add(role); await s.flush()
            who = User(tenant_id=None, role_id=role.id, email=f"sa-{uuid4().hex[:6]}@x.test", username=f"sa-{uuid4().hex[:6]}", hashed_password="x", full_name="SA",
                       status=UserStatus.ACTIVE, is_active=True, last_login=datetime.utcnow())
            s.add(who); await s.flush()
            s.add(DocumentTemplateVersion(template_id=t.id, version=self.version, state="published", content=content, content_sha256=dt.content_hash(content), change_note="test",
                                          created_by=who.id, published_by=who.id, published_at=datetime.utcnow()))
            await s.commit()

    async def asyncTearDown(self):
        await self.http.aclose()

    async def test_the_link_reads_the_published_template_and_a_wrong_link_cannot(self):
        r = await self.http.get(f"/public/e-application/{self.raw}/template")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["version"], self.version)
        self.assertIn("referral_name", [f["id"] for s in r.json()["content"]["sections"] for f in s["fields"]])
        self.assertEqual((await self.http.get("/public/e-application/not-a-link/template")).status_code, 404)

    async def test_a_draft_keeps_the_answers_with_the_template_version_and_drops_unknown_ones(self):
        r = await self.http.put(f"/public/e-application/{self.raw}", json={"declaration": {"custom": {"blood_group": "O+", "made_up": "x"}}})
        self.assertEqual(r.status_code, 200, r.text)
        got = (await self.http.get(f"/public/e-application/{self.raw}")).json()
        self.assertEqual(got["declaration"]["custom"], {"blood_group": "O+"})
        self.assertEqual(got["declaration"]["template"], {"key": "proposal", "version": self.version})

    async def test_a_draft_may_leave_a_required_answer_empty_but_not_give_a_bad_one(self):
        ok = await self.http.put(f"/public/e-application/{self.raw}", json={"declaration": {"custom": {}}})
        self.assertEqual(ok.status_code, 200, ok.text)
        bad = await self.http.put(f"/public/e-application/{self.raw}", json={"declaration": {"custom": {"blood_group": "ZZ"}}})
        self.assertEqual(bad.status_code, 422, bad.text); self.assertIn("one of its options", bad.text)

    async def test_submitting_needs_the_required_added_answers(self):
        decl = {"confirms_accurate": True, "authorizes_records_access": True, "not_signed_blank": True, "understood_terms": True, "signature_name": "Eapp Test", "custom": {}}
        self.assertEqual((await self.http.put(f"/public/e-application/{self.raw}", json={"declaration": decl})).status_code, 200)
        r = await self.http.post(f"/public/e-application/{self.raw}/submit")
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn("Who referred you?", r.text)
        got = (await self.http.get(f"/public/e-application/{self.raw}")).json()
        self.assertNotEqual(got["status"], "Submitted", "a refused submit leaves the application open")

    async def test_the_forms_own_declaration_is_untouched_when_no_custom_is_sent(self):
        decl = {"confirms_accurate": True, "signature_name": "Eapp Test"}
        self.assertEqual((await self.http.put(f"/public/e-application/{self.raw}", json={"declaration": decl})).status_code, 200)
        got = (await self.http.get(f"/public/e-application/{self.raw}")).json()
        self.assertEqual(got["declaration"], decl, "a form that sends no custom answers is stored exactly as before")


if __name__ == "__main__":
    async def create():
        engine = create_async_engine(f"{base.ADMIN}/postgres", isolation_level="AUTOCOMMIT")
        async with engine.connect() as c:
            await c.execute(text(f'CREATE DATABASE "{base.DB}"'))
        await engine.dispose()
        target = create_async_engine(f"{base.ADMIN}/{base.DB}", poolclass=NullPool)
        async with target.begin() as c:
            await c.run_sync(SQLModel.metadata.create_all)
        return target

    async def drop(target):
        await target.dispose()
        engine = create_async_engine(f"{base.ADMIN}/postgres", isolation_level="AUTOCOMMIT")
        async with engine.connect() as c:
            await c.execute(text(f'DROP DATABASE IF EXISTS "{base.DB}" WITH (FORCE)'))
        await engine.dispose()

    target = asyncio.run(create())
    base.factory = async_sessionmaker(target, class_=AsyncSession, expire_on_commit=False)
    try:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(EAppTemplate))
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
