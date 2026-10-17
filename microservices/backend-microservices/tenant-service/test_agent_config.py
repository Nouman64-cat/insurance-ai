"""Persisted SuperAdmin agent control, using a disposable PostgreSQL database.

Run: docker compose exec -T tenant-service python test_agent_config.py
"""
import os
os.environ['DISABLE_PGVECTOR'] = 'true'
import asyncio
import sys
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import DATABASE_URL, get_session
from routers.auth import create_access_token
from routers import agent_config
from shared.models.core import Role, User, PlatformAgentConfig

factory = None


class AgentConfigTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async with factory() as session:
            self.headers = {}
            for role in ('SuperAdmin', 'Admin', 'Viewer'):
                from sqlmodel import select
                existing = (await session.exec(select(Role).where(Role.name == role))).first()
                row = existing or Role(name=role)
                session.add(row); await session.flush()
                user = User(role_id=row.id, full_name='SYNTHETIC Config Test', username=uuid4().hex,
                            email=uuid4().hex+'@synthetic.invalid', hashed_password='SYNTHETIC-NO-LOGIN')
                session.add(user); await session.flush()
                self.headers[role] = {'Authorization': 'Bearer '+create_access_token({'sub': str(user.id)})}
                if role == 'SuperAdmin': self.superadmin_id = user.id
            await session.commit()
            current = await session.get(PlatformAgentConfig, 'default')
            if current: await session.delete(current); await session.commit()
        self.app = FastAPI(); self.app.include_router(agent_config.router)
        async def dependency():
            async with factory() as session: yield session
        self.app.dependency_overrides[get_session] = dependency
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')

    async def asyncTearDown(self):
        await self.http.aclose()

    async def test_default_and_persisted_setting_survive_new_sessions(self):
        response = await self.http.get('/platform/agent-config', headers=self.headers['SuperAdmin'])
        self.assertTrue(response.json()['skill_agent_enabled'])
        saved = await self.http.put('/platform/agent-config', json={'skill_agent_enabled': False}, headers=self.headers['SuperAdmin'])
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertFalse(saved.json()['skill_agent_enabled'])
        self.assertEqual(saved.json()['updated_by'], str(self.superadmin_id))
        self.assertIsNotNone(saved.json()['updated_at'])
        async with factory() as session:
            self.assertFalse((await session.get(PlatformAgentConfig, 'default')).skill_agent_enabled)
        response = await self.http.get('/platform/agent-config', headers=self.headers['SuperAdmin'])
        self.assertFalse(response.json()['skill_agent_enabled'])
        enabled = await self.http.put('/platform/agent-config', json={'skill_agent_enabled': True}, headers=self.headers['SuperAdmin'])
        self.assertTrue(enabled.json()['skill_agent_enabled'])

    async def test_non_superadmin_cannot_read_or_change_configuration(self):
        for role in ('Admin', 'Viewer'):
            for method in ('GET', 'PUT'):
                response = await self.http.request(method, '/platform/agent-config', headers=self.headers[role],
                                                   **({'json': {'skill_agent_enabled': False}} if method == 'PUT' else {}))
                self.assertEqual(response.status_code, 403, response.text)

    async def test_unauthenticated_requests_are_refused(self):
        self.assertEqual((await self.http.get('/platform/agent-config')).status_code, 401)

    async def test_payload_rejects_strings_and_unknown_fields(self):
        for body in ({'skill_agent_enabled': 'false'}, {'skill_agent_enabled': True, 'tenant_id': str(uuid4())}, {}):
            response = await self.http.put('/platform/agent-config', json=body, headers=self.headers['SuperAdmin'])
            self.assertEqual(response.status_code, 422)

    async def test_internal_secret_and_runtime_response(self):
        with patch.object(agent_config, 'INTERNAL_API_SECRET', 'SYNTHETIC-INTERNAL'):
            self.assertEqual((await self.http.get('/internal/agent-config')).status_code, 401)
            result = await self.http.get('/internal/agent-config', headers={'X-Internal-Secret': 'SYNTHETIC-INTERNAL'})
            self.assertEqual(result.status_code, 200)
            self.assertTrue(result.json()['skill_agent_enabled'])
            self.assertNotIn('api_key', result.json())


if __name__ == '__main__':
    db_name = 'agent_config_test_'+uuid4().hex[:12]
    from sqlalchemy.engine import URL
    admin_url = make_url(os.environ['TEST_DATABASE_ADMIN_URL']) if os.getenv('TEST_DATABASE_ADMIN_URL') else URL.create(
        'postgresql+asyncpg', username=os.environ['POSTGRES_USER'], password=os.environ['POSTGRES_PASSWORD'],
        host='host.docker.internal', port=5432, database='postgres')
    target_url = admin_url.set(database=db_name)
    async def create():
        admin = create_async_engine(admin_url, isolation_level='AUTOCOMMIT')
        async with admin.connect() as connection: await connection.execute(text(f'CREATE DATABASE "{db_name}"'))
        await admin.dispose()
        target = create_async_engine(target_url, poolclass=NullPool)
        async with target.begin() as connection: await connection.run_sync(SQLModel.metadata.create_all)
        return target
    async def drop(target):
        await target.dispose()
        admin = create_async_engine(admin_url, isolation_level='AUTOCOMMIT')
        async with admin.connect() as connection: await connection.execute(text(f'DROP DATABASE "{db_name}" WITH (FORCE)'))
        await admin.dispose()
    target = asyncio.run(create())
    factory = async_sessionmaker(target, class_=AsyncSession, expire_on_commit=False)
    try:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(AgentConfigTests))
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
