"""Versioned migrations and the database privilege boundary (on the disposable test database)."""
import asyncio
import unittest

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app import migrate
from tests.support import APP_PW, OWNER_PW, TEST_DB, create_database, drop_database, url


def setUpModule():
    asyncio.run(create_database())


def tearDownModule():
    asyncio.run(drop_database())


class Migrations(unittest.IsolatedAsyncioTestCase):
    async def test_rerun_applies_nothing_and_edited_migrations_are_refused(self):
        owner = url("request_mgmt_owner", OWNER_PW, TEST_DB)
        self.assertEqual(await migrate.run(owner, "request_management"), [])
        engine = create_async_engine(owner)
        async with engine.begin() as c:
            await c.execute(text("UPDATE request_management.schema_migrations SET checksum = 'edited' WHERE version = '0001'"))
        with self.assertRaises(RuntimeError):
            await migrate.run(owner, "request_management")
        async with engine.begin() as c:
            await c.execute(text("UPDATE request_management.schema_migrations SET checksum = :c WHERE version = '0001'"),
                            {"c": migrate.checksum(migrate.migration_files()[0][2])})
        await engine.dispose()

    async def test_application_role_is_confined_to_its_schema(self):
        engine = create_async_engine(url("request_mgmt_app", APP_PW, TEST_DB))
        denied = {
            "DDL": "CREATE TABLE request_management.sneaky (id int)",
            "public schema": "CREATE TABLE public.sneaky (id int)",
            "audit update": "UPDATE request_management.audit_events SET reason = 'x'",
            "audit delete": "DELETE FROM request_management.audit_events",
            "migration history": "DELETE FROM request_management.schema_migrations",
        }
        for name, sql in denied.items():
            async with engine.connect() as c:
                with self.assertRaises(Exception, msg=name):
                    await c.execute(text(sql))
        async with engine.connect() as c:
            await c.execute(text("SELECT count(*) FROM request_management.requests"))
        await engine.dispose()


if __name__ == "__main__":
    unittest.main()
