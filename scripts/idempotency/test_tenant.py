"""Run selected tenant pytest modules in a disposable PostgreSQL schema.

Inside the tenant-service working directory, provide IDEMPOTENCY_TEST_DATABASE_URL
(or the existing container test-owner credentials), then run this script with test
module filenames. Application data is never modified. Tests may write their normal
scratch documents. pytest must be available in the test environment.
"""
import asyncio
import importlib
import os
import sys
from uuid import uuid4

os.environ['DISABLE_PGVECTOR'] = 'true'
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession
import database

url = os.environ.get('IDEMPOTENCY_TEST_DATABASE_URL')
if not url:
    url = make_url(os.environ['DATABASE_URL']).set(username=os.environ['POSTGRES_USER'], password=os.environ['POSTGRES_PASSWORD'])
schema = 'idem_suite_test_' + uuid4().hex
admin = create_async_engine(url, poolclass=NullPool)
engine = create_async_engine(url, poolclass=NullPool, connect_args={'server_settings': {'search_path': schema}})
database.engine = engine
database._session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
modules = sys.argv[1:]
if not modules:
    raise SystemExit('Provide specific tenant test module filenames')
for name in modules:
    importlib.import_module(name.removesuffix('.py'))
from shared.idempotency.models import metadata
from shared.events.outbox import BusinessOutbox
from shared.models.core import Role
from role_seed import SEED_ROLES


async def setup():
    async with admin.begin() as conn:
        await conn.execute(text(f'CREATE SCHEMA {schema}'))
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
        await conn.run_sync(metadata.create_all)
    async with database._session_factory() as session:
        session.add_all([Role(name=name, description=description) for name, description in SEED_ROLES])
        await session.commit()


async def cleanup():
    await engine.dispose()
    async with admin.begin() as conn:
        await conn.execute(text(f'DROP SCHEMA IF EXISTS {schema} CASCADE'))
    await admin.dispose()


try:
    asyncio.run(setup())
    import pytest
    result = pytest.main([*modules, '-q'])
finally:
    asyncio.run(cleanup())
raise SystemExit(result)
