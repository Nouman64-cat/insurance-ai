import unittest
from types import SimpleNamespace
from unittest.mock import patch
import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession
from shared.idempotency.http import database_operation
from . import test_postgres


class HttpTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_postgres.PostgresTests.asyncSetUp
    asyncTearDown = test_postgres.PostgresTests.asyncTearDown

    async def client(self):
        factory = async_sessionmaker(self.engine, class_=AsyncSession, expire_on_commit=False)
        async def session():
            async with factory() as s: yield s
        async def user(request: Request):
            if request.headers.get('authorization') != 'Bearer allowed': raise HTTPException(403)
            return SimpleNamespace(id='actor')
        app = FastAPI()
        @app.post('/tenants/{tenant_id}/payments', status_code=201)
        @database_operation('test.payment', response_fields=('id',), status_code=201)
        async def pay(tenant_id: str, body: dict, request: Request, session=Depends(session), user=Depends(user)):
            await session.execute(text('INSERT INTO business VALUES (:id, 10)'), {'id': body['id']})
            await session.commit()  # Must NOT escape the adapter's outer transaction.
            await session.execute(text('INSERT INTO outbox VALUES (:id)'), {'id': body['id']})
            await session.commit()
            if body.get('crash'): raise HTTPException(503)
            return {'id': body['id']}
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test')

    async def test_http_replays_status_and_reauthorizes(self):
        async with await self.client() as c:
            headers={'Authorization': 'Bearer allowed', 'Idempotency-Key': 'operation-123'}
            a=await c.post('/tenants/a/payments', json={'id': 1}, headers=headers)
            b=await c.post('/tenants/a/payments', json={'id': 1}, headers=headers)
            self.assertEqual((a.status_code,b.status_code), (201,201))
            self.assertEqual(a.json(),b.json())
            self.assertEqual(b.headers['idempotency-replayed'],'true')
            denied=await c.post('/tenants/a/payments', json={'id':1},headers={'Idempotency-Key':'operation-123'})
            self.assertEqual(denied.status_code,403)
            conflict=await c.post('/tenants/a/payments',json={'id':2},headers=headers)
            self.assertEqual(conflict.status_code,409)

    async def test_required_header_and_body_key_not_accepted(self):
        with patch.dict('os.environ', {'IDEMPOTENCY_ENFORCEMENT':'required'}):
            async with await self.client() as c:
                r=await c.post('/tenants/a/payments',json={'id':1,'idempotency_key':'operation-123'},headers={'Authorization':'Bearer allowed'})
                self.assertEqual(r.status_code,400)

    async def test_handler_commits_cannot_escape_crash_rollback(self):
        async with await self.client() as c:
            r=await c.post('/tenants/a/payments',json={'id':1,'crash':True},headers={'Authorization':'Bearer allowed','Idempotency-Key':'operation-123'})
            self.assertEqual(r.status_code,503)
        async with self.engine.connect() as conn:
            for table in ('business','outbox','idempotency_records'):
                self.assertEqual((await conn.execute(text(f'SELECT count(*) FROM {table}'))).scalar(),0)

    async def test_resource_replay_keeps_sensitive_fields_out_of_receipt(self):
        factory = async_sessionmaker(self.engine, class_=AsyncSession, expire_on_commit=False)
        async def session():
            async with factory() as s:
                yield s
        async def user():
            return SimpleNamespace(id='actor')
        async def hydrate(values, receipt):
            return {**receipt, 'link': 'fresh-authorized-link'}
        app = FastAPI()
        @app.post('/tenants/{tenant_id}/resources')
        @database_operation('test.resource', response_fields=('id', 'link'),
                            receipt_fields=('id',), replay_response=hydrate)
        async def create(tenant_id: str, session=Depends(session), user=Depends(user)):
            await session.execute(text('INSERT INTO business VALUES (1, 10)'))
            await session.commit()
            return {'id': 1, 'link': 'original-sensitive-link'}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            headers = {'Idempotency-Key': 'resource-key-123'}
            first = await client.post('/tenants/a/resources', headers=headers)
            replay = await client.post('/tenants/a/resources', headers=headers)
            self.assertEqual(first.json(), {'id': 1, 'link': 'original-sensitive-link'})
            self.assertEqual(replay.json(), {'id': 1, 'link': 'fresh-authorized-link'})
            self.assertEqual(replay.headers['idempotency-replayed'], 'true')
        async with self.engine.connect() as conn:
            self.assertEqual((await conn.execute(text('SELECT response_json FROM idempotency_records'))).scalar_one(), {'id': 1})
            self.assertEqual((await conn.execute(text('SELECT count(*) FROM business'))).scalar_one(), 1)
