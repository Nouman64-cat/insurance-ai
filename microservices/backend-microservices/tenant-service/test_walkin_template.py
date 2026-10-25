"""Walk-in and customer saves with the fields a Super Admin added to the Lead acquisition template: the walk-in route reads the published template,
validates the answers (types, required, options, hidden fields, unknown keys) and stores them in `details.custom` with the template version; customer
create and update do the same. Against a disposable PostgreSQL database (nothing of yours is touched), reusing the walk-in test harness.

Run: docker exec insurance-tenant-service python test_walkin_template.py
"""
import os
os.environ["DISABLE_PGVECTOR"] = "true"
os.environ.setdefault("CM_TO_TENANT_KEY", "test-key-" + "y" * 32)
os.environ["GEMINI_API_KEY"] = "test"
import asyncio
import copy
import sys
import unittest
from datetime import datetime
from uuid import uuid4

import test_walk_in as base
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

from services import lead_template
from shared import doc_templates as dt
from shared.models.core import Customer, Role, User, UserStatus
from shared.models.templates import DocumentTemplate, DocumentTemplateVersion

BASE = base.BASE


class WalkInTemplate(base.WalkIn):
    TOP = base.WalkIn.TOP + ("custom",)

    async def publish(self, content, version=None):
        async with base.factory() as s:
            t = (await s.exec(select(DocumentTemplate).where(DocumentTemplate.template_key == "lead_acquisition"))).first()
            if t is None:
                t = DocumentTemplate(template_key="lead_acquisition", kind="lead", title="Lead")
                s.add(t); await s.flush()
            for v in (await s.exec(select(DocumentTemplateVersion).where(DocumentTemplateVersion.template_id == t.id, DocumentTemplateVersion.state == "published"))).all():
                v.state = "superseded"; s.add(v)
            await s.flush()
            top = max([v.version for v in (await s.exec(select(DocumentTemplateVersion).where(DocumentTemplateVersion.template_id == t.id))).all()] or [0])
            version = top + 1
            s.add(DocumentTemplateVersion(template_id=t.id, version=version, state="published", content=content, content_sha256=dt.content_hash(content), change_note="test",
                                          created_by=self.admin.id, published_by=self.admin.id, published_at=datetime.utcnow()))
            await s.commit()
        return version

    def content(self):
        c = dt.seed_lead_acquisition()
        c["sections"][0]["fields"] += [
            {"id": "blood_group", "label": "Blood group", "type": "select", "required": True, "binding": {"store": "details"}, "options": [{"id": "o", "label": "O positive", "value": "O+"}]},
            {"id": "visit_note", "label": "Visit note", "type": "text", "max_length": 10, "binding": {"store": "details"}}]
        return c

    async def test_the_form_reads_the_published_template_not_a_draft(self):
        v = await self.publish(self.content())
        r = await self.call("GET", f"{BASE}/template")
        self.assertEqual(r.status_code, 200, r.text)
        ids = [f["id"] for s in r.json()["content"]["sections"] for f in s["fields"]]
        self.assertEqual(r.json()["version"], v)
        self.assertIn("blood_group", ids)

    async def test_added_answers_are_saved_with_the_lead_and_the_template_version(self):
        v = await self.publish(self.content())
        out = await self.submit(custom={"blood_group": "O positive", "visit_note": " hello "})
        async with base.factory() as s:
            c = (await s.exec(select(Customer).where(Customer.tenant_id == self.t.id))).one()
        self.assertEqual(c.details["custom"], {"blood_group": "O+", "visit_note": "hello"})
        self.assertEqual(c.details["template"], {"key": "lead_acquisition", "version": v})
        self.assertTrue(out["reference"].startswith("WI-"))

    async def test_a_missing_required_added_field_is_refused_and_nothing_is_stored(self):
        await self.publish(self.content())
        r = await self.call("POST", f"{BASE}/leads", self.body(custom={}))
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn("Blood group", r.text)
        async with base.factory() as s:
            self.assertEqual(len((await s.exec(select(Customer).where(Customer.tenant_id == self.t.id))).all()), 0)

    async def test_bad_values_unknown_keys_and_built_in_names_are_not_stored(self):
        await self.publish(self.content())
        r = await self.call("POST", f"{BASE}/leads", self.body(custom={"blood_group": "Z"}))
        self.assertEqual(r.status_code, 422); self.assertIn("one of its options", r.text)
        r = await self.call("POST", f"{BASE}/leads", self.body(custom={"blood_group": "O+", "visit_note": "x" * 11}))
        self.assertEqual(r.status_code, 422); self.assertIn("longer than 10", r.text)
        out = await self.submit(custom={"blood_group": "O+", "first_name": "Smuggled", "evil": "<script>"})
        async with base.factory() as s:
            c = (await s.exec(select(Customer).where(Customer.tenant_id == self.t.id))).one()
        self.assertEqual(c.details["custom"], {"blood_group": "O+"}, "only fields of the template are stored")
        self.assertNotEqual(c.name, "Smuggled")

    async def test_with_no_added_fields_the_walk_in_works_exactly_as_before(self):
        await self.publish(dt.seed_lead_acquisition())
        out = await self.submit()
        async with base.factory() as s:
            c = (await s.exec(select(Customer).where(Customer.tenant_id == self.t.id))).one()
        self.assertEqual(c.details.get("custom", {}), {})

    async def test_customer_create_and_update_check_answers_too(self):
        v = await self.publish(self.content())
        async with base.factory() as s:
            ok = await lead_template.check_custom(s, {"custom": {"blood_group": "O+"}}, creating=True)
            self.assertEqual(ok["custom"], {"blood_group": "O+"}); self.assertEqual(ok["template"]["version"], v)
            from fastapi import HTTPException
            with self.assertRaises(HTTPException) as e:
                await lead_template.check_custom(s, {"custom": {}}, creating=True)
            self.assertEqual(e.exception.status_code, 422); self.assertIn("Blood group: is required", e.exception.detail["problems"])
            # an existing record: not locked out by a newly required field, keeps the answer to a field since removed
            kept = await lead_template.check_custom(s, {"custom": {"visit_note": "ok"}}, existing={"old_removed": "still here"}, creating=False)
            self.assertEqual(kept["custom"], {"visit_note": "ok", "old_removed": "still here"})
            self.assertEqual(await lead_template.check_custom(s, {"other": 1}, creating=True), {"other": 1}, "details without custom pass through untouched")


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
        mine = ["test_the_form_reads_the_published_template_not_a_draft", "test_added_answers_are_saved_with_the_lead_and_the_template_version",
                "test_a_missing_required_added_field_is_refused_and_nothing_is_stored", "test_bad_values_unknown_keys_and_built_in_names_are_not_stored",
                "test_with_no_added_fields_the_walk_in_works_exactly_as_before", "test_customer_create_and_update_check_answers_too"]
        suite = unittest.TestSuite(WalkInTemplate(n) for n in mine)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
