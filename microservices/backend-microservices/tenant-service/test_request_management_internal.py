"""Tenant-service's Request Management endpoints, against a disposable PostgreSQL database.

Run: docker compose exec -T tenant-service python test_request_management_internal.py
Creates a throwaway database with the Postgres admin credentials from .env (POSTGRES_USER / POSTGRES_PASSWORD) and
drops it afterwards. No existing data is read or changed.
"""
import os
os.environ["DISABLE_PGVECTOR"] = "true"
os.environ.setdefault("REQUEST_MGMT_SERVICE_KEY", "test-key-" + "x" * 32)
import asyncio
import json
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

from database import get_session
from routers.request_management_internal import router
from shared.models.core import Customer, Role, Tenant, User
from shared.models.request_integration import CustomerProfileCorrection
from shared.security.service_auth import sign

KEY = os.environ["REQUEST_MGMT_SERVICE_KEY"]
DB = "tenant_rm_test_" + uuid4().hex[:10]
ADMIN = f"postgresql+asyncpg://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}@host.docker.internal:5432"
factory = None


class InternalEndpoints(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async with factory() as s:
            self.tenant, self.other_tenant = Tenant(name=f"T {uuid4()}", code=uuid4().hex), Tenant(name=f"O {uuid4()}", code=uuid4().hex)
            s.add_all([self.tenant, self.other_tenant]); await s.commit()
            roles = {}
            for name in ("Admin", "Underwriter", "Agent"):
                r = (await s.exec(select(Role).where(Role.name == name))).first() or Role(name=name, description="")
                s.add(r); await s.flush(); roles[name] = r.id
            def user(tenant, role, active=True):
                return User(tenant_id=tenant.id, role_id=roles[role], email=f"{uuid4()}@example.invalid", username=uuid4().hex,
                            hashed_password="unused", full_name=f"{role} user", is_active=active)
            self.uw, self.agent, self.inactive_uw, self.foreign_admin = user(self.tenant, "Underwriter"), user(self.tenant, "Agent"), \
                user(self.tenant, "Underwriter", active=False), user(self.other_tenant, "Admin")
            s.add_all([self.uw, self.agent, self.inactive_uw, self.foreign_admin]); await s.commit()
            self.customer = Customer(tenant_id=self.tenant.id, name="Sara Ahmed", city="Lahore",
                                     details={"contact": {"email": "old@example.test", "mobile_number": "0300 1234567"}})
            s.add(self.customer); await s.commit()
        self.app = FastAPI(); self.app.include_router(router)
        async def session_dependency():
            async with factory() as s:
                yield s
        self.app.dependency_overrides[get_session] = session_dependency
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.http.aclose()

    async def call(self, method, path, body=None, key=KEY, tamper=False):
        data = json.dumps(body).encode() if body is not None else b""
        headers = sign(key, method, path, data)
        if tamper:
            data = data.replace(b"new@", b"evil@")
        return await self.http.request(method, path, content=data, headers={**headers, "Content-Type": "application/json"})

    def correction(self, **over):
        body = {"execution_key": f"rm:{uuid4()}:1", "request_id": str(uuid4()), "revision_no": 1,
                "requested_by": str(self.agent.id), "approved_by": str(self.uw.id),
                "changes": {"contact.email": {"before": "old@example.test", "after": "new@example.test"}}}
        body.update(over)
        return body

    def path(self, tenant=None, customer=None):
        return f"/internal/request-management/tenants/{tenant or self.tenant.id}/customers/{customer or self.customer.id}/profile-corrections"

    async def email(self):
        async with factory() as s:
            return (await s.get(Customer, self.customer.id)).details["contact"]["email"]

    async def test_unsigned_wrong_key_and_tampered_calls_are_refused(self):
        r = await self.http.post(self.path(), json=self.correction())
        self.assertEqual(r.status_code, 401)
        self.assertEqual((await self.call("POST", self.path(), self.correction(), key="another-key-entirely-123")).status_code, 401)
        self.assertEqual((await self.call("POST", self.path(), self.correction(), tamper=True)).status_code, 401)
        self.assertEqual(await self.email(), "old@example.test")

    async def test_applies_once_per_execution_key(self):
        body = self.correction()
        first = await self.call("POST", self.path(), body)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["status"], "APPLIED")
        again = await self.call("POST", self.path(), body)
        self.assertEqual(again.json()["status"], "ALREADY_APPLIED")
        self.assertEqual(await self.email(), "new@example.test")
        async with factory() as s:
            rows = (await s.exec(select(CustomerProfileCorrection).where(CustomerProfileCorrection.customer_id == self.customer.id))).all()
        self.assertEqual(len(rows), 1)
        reused = await self.call("POST", self.path(), {**body, "changes": {"city": {"before": "Lahore", "after": "Karachi"}}})
        self.assertEqual(reused.status_code, 409)
        self.assertEqual(reused.json()["detail"]["code"], "IDEMPOTENCY_MISMATCH")

    async def test_changed_record_is_a_conflict_not_an_overwrite(self):
        async with factory() as s:
            c = await s.get(Customer, self.customer.id)
            c.details = {"contact": {"email": "changed@example.test"}}; s.add(c); await s.commit()
        r = await self.call("POST", self.path(), self.correction())
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["detail"]["code"], "CONFLICT")
        self.assertEqual(await self.email(), "changed@example.test")

    async def test_actors_tenant_and_fields_are_enforced(self):
        cases = [
            (self.correction(approved_by=str(self.agent.id)), 403, "SELF_APPROVAL"),                 # requester approving
            (self.correction(approved_by=str(self.inactive_uw.id)), 403, "APPROVER_NOT_AUTHORIZED"),
            (self.correction(approved_by=str(self.foreign_admin.id)), 403, "APPROVER_NOT_AUTHORIZED"),
            (self.correction(changes={"name": {"before": "Sara Ahmed", "after": "Someone Else"}}), 422, "VALIDATION"),
            (self.correction(changes={"cnic": {"before": None, "after": "35202-1234567-1"}}), 422, "VALIDATION"),
        ]
        for body, status, code in cases:
            r = await self.call("POST", self.path(), body)
            self.assertEqual((r.status_code, r.json()["detail"]["code"]), (status, code), body)
        r = await self.call("POST", self.path(tenant=self.other_tenant.id), self.correction(approved_by=str(self.foreign_admin.id), requested_by=str(self.foreign_admin.id) ))
        self.assertIn(r.status_code, (403, 404))
        self.assertEqual(await self.email(), "old@example.test")

    async def test_directory_is_scoped_to_one_tenant(self):
        path = f"/internal/request-management/tenants/{self.tenant.id}/users?roles=Underwriter"
        r = await self.call("GET", path)
        self.assertEqual(r.status_code, 200)
        users = {u["id"]: u for u in r.json()}
        self.assertTrue(users[str(self.uw.id)]["is_active"])
        self.assertFalse(users[str(self.inactive_uw.id)]["is_active"])
        self.assertNotIn(str(self.foreign_admin.id), users)
        self.assertEqual((await self.http.get(path)).status_code, 401)


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
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(InternalEndpoints))
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
