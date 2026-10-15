"""Shared test fixtures: a disposable database (real Postgres, real migrations, real least-privilege role) and a fake
tenant-service adapter that records exactly what Customer Management asks it for."""
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

import httpx
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app import db, migrate, provision, security, tenant_client
from app.config import settings
from app.errors import ApiError
from app.main import app

TEMP_PASSWORD = "Tmp9xKq2LmA"
NEW_PASSWORD = "Better#Portal2026"


class FakeTenant:
    """Stands in for tenant-service. `routes` maps a path suffix to a response (or an ApiError to raise)."""

    def __init__(self):
        self.calls: list[tuple[str, str, object]] = []
        self.routes: dict[str, object] = {}

    def scope(self, tenant_id, customer_id) -> str:
        return f"/scope/{tenant_id}/{customer_id}"

    def _answer(self, method, path, payload=None):
        self.calls.append((method, path, payload))
        for suffix, value in self.routes.items():
            if path.endswith(suffix):
                if isinstance(value, Exception):
                    raise value
                return value(payload) if callable(value) else value
        raise ApiError(404, "NOT_FOUND", "Record not found")

    async def get(self, path, **q):
        return self._answer("GET", path, q or None)

    async def post(self, path, payload=None):
        return self._answer("POST", path, payload)

    async def patch(self, path, payload):
        return self._answer("PATCH", path, payload)

    async def upload(self, path, filename, content, content_type, note, fields=None):
        return self._answer("UPLOAD", path, {"filename": filename, "note": note, **(fields or {})})

    async def download(self, path, **q):
        return self._answer("GET", path)


class Base(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        base = make_url(os.environ["CM_DATABASE_URL"])
        admin = base.set(username=os.environ.get("POSTGRES_USER", "postgres"), password=os.environ.get("POSTGRES_PASSWORD", ""))
        self.dbname = "cm_test_" + uuid4().hex[:10]
        self.admin = create_async_engine(admin, isolation_level="AUTOCOMMIT")
        async with self.admin.connect() as c:
            await c.execute(text("CREATE DATABASE " + self.dbname))
        test_admin = admin.set(database=self.dbname).render_as_string(hide_password=False)
        await provision.provision(test_admin, "customer_management", "customer_management_owner", os.environ["CM_DB_OWNER_PASSWORD"],
                                  "customer_management_app", os.environ["CM_DB_APP_PASSWORD"])
        owner = base.set(database=self.dbname, username="customer_management_owner", password=os.environ["CM_DB_OWNER_PASSWORD"]).render_as_string(hide_password=False)
        await migrate.run(owner)
        db.configure(base.set(database=self.dbname).render_as_string(hide_password=False))
        object.__setattr__(settings, "demo", False)       # these tests are the production behaviour; demo has its own test
        self.fake = FakeTenant()
        tenant_client.set_client(self.fake)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.tenant_id, self.customer_id = uuid4(), uuid4()

    async def asyncTearDown(self):
        await self.client.aclose()
        await db.dispose()
        async with self.admin.connect() as c:
            await c.execute(text("DROP DATABASE " + self.dbname + " WITH (FORCE)"))
        await self.admin.dispose()

    # helpers ---------------------------------------------------------------
    async def provision_account(self, username="PH-2026-000001", password=TEMP_PASSWORD, tenant_id=None, customer_id=None, tenant_code="PAG34", **extra):
        async with db.transaction() as conn:
            from app import accounts
            return await accounts.ensure_account(
                conn, tenant_id=tenant_id or self.tenant_id, tenant_code=tenant_code, customer_id=customer_id or self.customer_id, username=username,
                password_hash=security.hash_password(password), display_name="Test Customer",
                credential_expires_at=extra.get("expires", datetime.now(timezone.utc) + timedelta(days=7)), mode=extra.get("mode", "ensure"), reason=None)

    async def login(self, username="PH-2026-000001", password=TEMP_PASSWORD, **extra):
        return await self.client.post("/v1/auth/login", json={"username": username, "password": password, **extra})

    async def active_session(self, username="PH-2026-000001", **kw):
        """Provision, sign in, change the temporary password; returns (access_token, refresh_token)."""
        await self.provision_account(username=username, **kw)
        first = (await self.login(username)).json()
        r = await self.client.post("/v1/auth/password/first-change", headers={"authorization": "Bearer " + first["access_token"]},
                                   json={"current_password": TEMP_PASSWORD, "new_password": NEW_PASSWORD})
        assert r.status_code == 200, r.text
        return r.json()["access_token"], r.json()["refresh_token"]

    @staticmethod
    def bearer(token):
        return {"authorization": "Bearer " + token}
