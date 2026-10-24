"""Persisted SuperAdmin agent control, using a disposable PostgreSQL database.

Run: docker compose exec -T tenant-service python test_document_forgery.py
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
from routers import document_forgery
from shared.models.core import Role, User, DocumentForgeryConfig, DocumentForgeryUsage

factory = None


class ForgeryConfigTests(unittest.IsolatedAsyncioTestCase):
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
            current = await session.get(DocumentForgeryConfig, 'default')
            if current: await session.delete(current); await session.commit()
        self.app = FastAPI(); self.app.include_router(document_forgery.router)
        async def dependency():
            async with factory() as session: yield session
        self.app.dependency_overrides[get_session] = dependency
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')

    async def asyncTearDown(self):
        await self.http.aclose()

    async def test_config_persistence_and_validation(self):
        path = '/platform/document-forgery/config'
        result = await self.http.get(path, headers=self.headers['SuperAdmin'])
        self.assertEqual(result.status_code, 200, result.text)
        body = result.json()['settings']
        body.update(threshold_mode='manual', t95=.2, tmax=.8, max_pages=2, pixel_per_hour=1.5)
        saved = await self.http.put(path, headers=self.headers['SuperAdmin'], json=body)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()['updated_by'], str(self.superadmin_id))
        async with factory() as session:
            self.assertEqual((await session.get(DocumentForgeryConfig, 'default')).settings['t95'], .2)
        for change in ({'t95': .9, 'tmax': .1}, {'tmax': 2}, {'max_pages': 41}, {'pixel_timeout_seconds': 541}, {'enabled':'false'}, {'pixel_per_hour':-1}, {'extra':1}):
            response = await self.http.put(path, headers=self.headers['SuperAdmin'], json=body | change)
            self.assertEqual(response.status_code, 422, response.text)

    async def test_rbac_and_internal_fail_closed(self):
        for path in ('/platform/document-forgery/config','/platform/document-forgery/performance','/platform/document-forgery/usage?start_date=2026-01-01&end_date=2026-12-31'):
            self.assertEqual((await self.http.get(path)).status_code, 401)
            for role in ('Admin','Viewer'):
                self.assertEqual((await self.http.get(path, headers=self.headers[role])).status_code, 403)
        for role in ('Admin','Viewer'):
            self.assertEqual((await self.http.put('/platform/document-forgery/config',headers=self.headers[role],json={})).status_code,403)
        with patch.dict(os.environ, {'INTERNAL_API_SECRET':'SYNTHETIC-INTERNAL'}):
            self.assertEqual((await self.http.get('/internal/document-forgery/config')).status_code,401)
            self.assertEqual((await self.http.get('/internal/document-forgery/config',headers={'X-Internal-Secret':'SYNTHETIC-INTERNAL'})).status_code,200)
            self.assertEqual((await self.http.post('/internal/document-forgery/usage',json={})).status_code,401)
        with patch.dict(os.environ, {'INTERNAL_API_SECRET':''}):
            self.assertEqual((await self.http.get('/internal/document-forgery/config')).status_code,503)

    async def test_metering_idempotency_and_historical_rates(self):
        async with factory() as session:
            from sqlalchemy import delete
            await session.exec(delete(DocumentForgeryUsage)); await session.commit()
        body = {'id':str(uuid4()), 'models':[{'model':'test-model','input_tokens':1000,'output_tokens':200,'input_rate':2,'output_rate':5}],
                'pixel_pages':2,'pixel_seconds':1800,'pixel_rate':.1,'complete':False,'config_revision':'test'}
        with patch.dict(os.environ, {'INTERNAL_API_SECRET':'SYNTHETIC-INTERNAL'}):
            for _ in range(2):
                response = await self.http.post('/internal/document-forgery/usage',headers={'X-Internal-Secret':'SYNTHETIC-INTERNAL'},json=body)
                self.assertEqual(response.status_code,200,response.text)
        # A future rate change cannot reprice an existing row.
        config = document_forgery.Settings(pixel_per_hour=99).model_dump()
        await self.http.put('/platform/document-forgery/config',headers=self.headers['SuperAdmin'],json=config)
        from datetime import date
        today = date.today().isoformat()
        response = await self.http.get(f'/platform/document-forgery/usage?start_date={today}&end_date={today}',headers=self.headers['SuperAdmin'])
        self.assertEqual(response.status_code,200,response.text)
        summary = response.json()['summary']
        self.assertEqual(summary['analyses'],1)
        self.assertEqual(summary['incomplete'],1)
        self.assertEqual(summary['pixel_pages'],2)
        self.assertEqual(summary['input_tokens'],1000)
        self.assertAlmostEqual(summary['known_cost_usd'],.053)
        self.assertEqual(summary['unpriced_components'],0)
        self.assertEqual((await self.http.get('/platform/document-forgery/usage?start_date=2026-10-01&end_date=2026-01-01',headers=self.headers['SuperAdmin'])).status_code,400)

    async def test_unknown_costs_are_not_reported_as_free(self):
        body = document_forgery.Usage(id=uuid4(),models=[document_forgery.ModelUsage(model='unknown',input_tokens=10)],pixel_pages=1,pixel_seconds=1,complete=True)
        self.assertEqual(document_forgery.price(body)['unpriced_components'],3)
        self.assertEqual(document_forgery.price(body)['known_cost_usd'],0)


if __name__ == '__main__':
    db_name = 'document_forgery_test_'+uuid4().hex[:12]
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
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ForgeryConfigTests))
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
