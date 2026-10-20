"""Test harness: a disposable PostgreSQL database with the real migrations and the real least-privilege roles.

Run inside the service container (it has the Postgres credentials from .env):
    docker compose exec -T audit-service python -m unittest discover -s tests -v

Each test class gets its own database, so every class starts from a fresh environment id (and fresh chains). Within a
class, tests use their own tenant ids, so their chains never overlap.
"""
import asyncio
import os
import unittest
import uuid
from contextlib import asynccontextmanager
from typing import Optional
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app import db, migrate, provision
from shared.audit.schema import AuditIntent

ADMIN_USER = os.environ.get("POSTGRES_USER", "postgres")
ADMIN_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "")
HOST = os.environ.get("TEST_DB_HOST", "host.docker.internal:5432")
OWNER_PW = os.environ["AUDIT_DB_OWNER_PASSWORD"]
APP_PW = os.environ["AUDIT_DB_APP_PASSWORD"]
SIGNER_PW = os.environ.get("AUDIT_DB_SIGNER_PASSWORD") or "signer-test-password-0123456789"
SCHEMA = "audit"


def url(user: str, password: str, database: str) -> str:
    return f"postgresql+asyncpg://{user}:{password}@{HOST}/{database}"


class TestDatabase:
    def __init__(self):
        self.name = f"audit_test_{uuid.uuid4().hex[:10]}"

    @property
    def app_url(self) -> str:
        return url("audit_app", APP_PW, self.name)

    @property
    def signer_url(self) -> str:
        return url("audit_signer", SIGNER_PW, self.name)

    @property
    def owner_url(self) -> str:
        return url("audit_owner", OWNER_PW, self.name)

    async def create(self) -> None:
        admin = create_async_engine(url(ADMIN_USER, ADMIN_PASSWORD, "postgres"), isolation_level="AUTOCOMMIT")
        async with admin.connect() as conn:
            await conn.execute(text(f'CREATE DATABASE "{self.name}"'))
        await admin.dispose()
        await provision.provision(url(ADMIN_USER, ADMIN_PASSWORD, self.name), SCHEMA, "audit_owner", OWNER_PW, "audit_app", APP_PW,
                                  "audit_signer", SIGNER_PW)
        await migrate.run(self.owner_url, SCHEMA)

    async def create_schema(self, name: str) -> None:
        """A scratch schema owned by the audit owner role (stands in for another service's schema)."""
        admin = create_async_engine(url(ADMIN_USER, ADMIN_PASSWORD, self.name))
        async with admin.begin() as conn:
            await conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {name} AUTHORIZATION audit_owner"))
        await admin.dispose()

    async def drop(self) -> None:
        admin = create_async_engine(url(ADMIN_USER, ADMIN_PASSWORD, "postgres"), isolation_level="AUTOCOMMIT")
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP DATABASE IF EXISTS "{self.name}" WITH (FORCE)'))
        await admin.dispose()


def intent(tenant_id: Optional[UUID], n: int = 0, **overrides) -> AuditIntent:
    fields = dict(
        source_service="tenant-service", source_event_id=str(uuid.uuid4()), tenant_id=tenant_id,
        actor_id="user-1", actor_type="USER", actor_role="Admin", module="policies", action="policy.issued",
        entity_type="policy", entity_id=f"POL-{n}", new_value={"status": "Active", "n": n}, metadata={"actor_name": "Test Admin"},
    )
    fields.update(overrides)
    return AuditIntent(**fields)


class LedgerCase(unittest.IsolatedAsyncioTestCase):
    """A fresh database per class (or per test, with per_test_database = True); the application engine (audit_app) per test."""
    database: TestDatabase
    per_test_database = False

    @classmethod
    def setUpClass(cls):
        if not cls.per_test_database:
            cls.database = TestDatabase()
            asyncio.run(cls.database.create())

    @classmethod
    def tearDownClass(cls):
        if not cls.per_test_database:
            asyncio.run(cls.database.drop())

    async def asyncSetUp(self):
        if self.per_test_database:
            self.database = TestDatabase()
            await self.database.create()
        db.configure(self.database.app_url)
        self.owner = create_async_engine(self.database.owner_url, connect_args={"server_settings": {"search_path": SCHEMA}})

    async def asyncTearDown(self):
        await db.dispose()
        await self.owner.dispose()
        if self.per_test_database:
            await self.database.drop()

    @asynccontextmanager
    async def privileged(self):
        """The schema owner with the append-only triggers switched off: what an attacker with database administration
        rights could do. Used only to simulate tampering that verification must catch."""
        async with self.owner.begin() as conn:
            for table in ("events", "chains", "checkpoints"):
                await conn.execute(text(f"ALTER TABLE {table} DISABLE TRIGGER USER"))
            try:
                yield conn
            finally:
                for table in ("events", "chains", "checkpoints"):
                    await conn.execute(text(f"ALTER TABLE {table} ENABLE TRIGGER USER"))

    async def fetch(self, sql: str, **params):
        async with db.engine().connect() as conn:
            return (await conn.execute(text(sql), params)).mappings().all()

    async def environment_id(self) -> UUID:
        return (await self.fetch("SELECT environment_id FROM environment"))[0]["environment_id"]

    async def chain_id(self, tenant_id: Optional[UUID]) -> str:
        env = await self.environment_id()
        return f"{env}:{tenant_id if tenant_id else 'platform'}"
