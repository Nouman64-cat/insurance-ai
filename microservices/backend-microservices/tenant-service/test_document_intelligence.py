"""Persisted SuperAdmin agent control, using a disposable PostgreSQL database.

Run: docker compose exec -T tenant-service python test_document_forgery.py
"""
import os
os.environ['DISABLE_PGVECTOR'] = 'true'
import asyncio
import sys
import unittest
from unittest.mock import patch, AsyncMock
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
from routers import document_intelligence
from shared.models.core import Role, User, Tenant

factory = None


class IntelligenceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async with factory() as session:
            self.headers = {}; self.users = {}; self.tenants = {}
            for role in ('SuperAdmin', 'Admin', 'Viewer', 'OtherAdmin'):
                from sqlmodel import select
                existing = (await session.exec(select(Role).where(Role.name == ('Admin' if role == 'OtherAdmin' else role)))).first()
                row = existing or Role(name='Admin' if role == 'OtherAdmin' else role)
                session.add(row); await session.flush()
                tenant = Tenant(name='SYNTHETIC '+uuid4().hex,code=uuid4().hex); session.add(tenant); await session.flush()
                self.tenants[role] = tenant.id
                user = User(tenant_id=tenant.id,role_id=row.id, full_name='SYNTHETIC Config Test', username=uuid4().hex,
                            email=uuid4().hex+'@synthetic.invalid', hashed_password='SYNTHETIC-NO-LOGIN')
                session.add(user); await session.flush()
                self.users[role] = user.id
                self.headers[role] = {'Authorization': 'Bearer '+create_access_token({'sub': str(user.id)})}
                if role == 'SuperAdmin': self.superadmin_id = user.id
            await session.commit()
        audit=patch.object(document_intelligence,'audit_standalone',new=AsyncMock(return_value=True));audit.start();self.addCleanup(audit.stop)
        self.app = FastAPI(); self.app.include_router(document_intelligence.router)
        async def dependency():
            async with factory() as session: yield session
        self.app.dependency_overrides[get_session] = dependency
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')

    async def asyncTearDown(self):
        await self.http.aclose()

    async def upload(self, role='Admin'):
        return await self.http.post('/document-intelligence/analyze',headers=self.headers[role],files={'file':('sample.pdf',b'%PDF-synthetic')},data={'max_pages':'1','tenant_id':str(self.tenants['OtherAdmin'])})

    async def test_only_api_calls_reach_result_owner(self):
        report={'id':str(uuid4()),'status':'completed','report':{'verdict':'no_evidence','findings':[]}}
        seen=[]
        def handle(request):
            seen.append(request)
            self.assertEqual(request.headers['X-Internal-Secret'],'SYNTHETIC-INTERNAL')
            self.assertEqual(request.headers['X-Tenant-Id'],str(self.tenants['Admin']))
            self.assertEqual(request.headers['X-Actor-Id'],str(self.users['Admin']))
            self.assertEqual(request.url.path,'/results/analyze')
            self.assertIn(b'%PDF-synthetic',request.content)
            return httpx.Response(200,json=report)
        internal=httpx.AsyncClient(transport=httpx.MockTransport(handle))
        with patch.dict(os.environ,{'INTERNAL_API_SECRET':'SYNTHETIC-INTERNAL','DOCS_FORGERY_URL':'http://engine.invalid'}),patch.object(document_intelligence.httpx,'AsyncClient',return_value=internal):
            response=await self.upload()
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json(),report)
        self.assertEqual(len(seen),1)

    async def test_history_and_missing_results_are_forwarded_with_verified_identity(self):
        user=type('Identity',(),{'id':self.users['Admin'],'tenant_id':self.tenants['Admin']})()
        responses=[httpx.Response(200,json={'items':[],'total':0}),httpx.Response(404,json={'detail':'Analysis not found'})]
        async def remote(method,path,identity,**kwargs):
            self.assertEqual(identity.tenant_id,self.tenants['Admin'])
            self.assertEqual(identity.id,self.users['Admin'])
            if path=='/results': return {'items':[],'total':0}
            from fastapi import HTTPException
            raise HTTPException(404,'Analysis not found')
        with patch.object(document_intelligence,'engine_request',side_effect=remote):
            response=await self.http.get('/document-intelligence/results',headers=self.headers['Admin'])
            self.assertEqual(response.json()['items'],[])
            response=await self.http.get('/document-intelligence/results/'+str(uuid4()),headers=self.headers['Admin'])
            self.assertEqual(response.status_code,404)

    async def test_authentication_role_active_and_tenant_checks(self):
        with patch.object(document_intelligence,'engine_request',new=AsyncMock()) as engine:
            for path in ('/document-intelligence/health','/document-intelligence/results'):
                self.assertEqual((await self.http.get(path)).status_code,401)
                for role in ('Viewer','SuperAdmin'):
                    self.assertEqual((await self.http.get(path,headers=self.headers[role])).status_code,403)
            for role in ('Viewer','SuperAdmin'):
                self.assertEqual((await self.upload(role)).status_code,403)
            async with factory() as session:
                tenant=await session.get(Tenant,self.tenants['Admin']);tenant.is_active=False;session.add(tenant);await session.commit()
            self.assertEqual((await self.upload()).status_code,403)
            async with factory() as session:
                tenant=await session.get(Tenant,self.tenants['Admin']);tenant.is_active=True;session.add(tenant);await session.commit()
                user=await session.get(User,self.users['Admin']);user.is_active=False;session.add(user);await session.commit()
            self.assertEqual((await self.upload()).status_code,403)
            engine.assert_not_called()

if __name__ == '__main__':
    db_name = 'document_intelligence_test_'+uuid4().hex[:12]
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
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(IntelligenceTests))
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
