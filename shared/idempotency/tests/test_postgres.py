"""Real PostgreSQL tests, isolated random schema; no business tenant rows touched.
Run in tenant-service: python -m unittest shared.idempotency.tests.test_postgres -v
"""
import asyncio
import os
import unittest
from uuid import uuid4

from sqlalchemy import text, select
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool
from shared.idempotency import (reserve, complete, fingerprint, fail, reconcile, expire_responses, IdempotencyError)
from shared.idempotency.models import metadata, idempotency_records as records


class PostgresTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.url = os.environ.get('IDEMPOTENCY_TEST_DATABASE_URL') or os.environ.get('DATABASE_URL')
        if not self.url:
            self.skipTest('PostgreSQL URL required')
        self.schema = 'idem_test_' + uuid4().hex
        self.admin = create_async_engine(self.url, poolclass=NullPool)
        async with self.admin.begin() as conn:
            await conn.execute(text(f'CREATE SCHEMA {self.schema}'))
        self.engine = create_async_engine(self.url, poolclass=NullPool,
            connect_args={'server_settings': {'search_path': self.schema}})
        async with self.engine.begin() as conn:
            await conn.run_sync(metadata.create_all)
            await conn.execute(text('CREATE TABLE business (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)'))
            await conn.execute(text('CREATE TABLE outbox (id INTEGER PRIMARY KEY)'))
        self.kw = dict(scope_id='tenant:a', operation='test.payment', key='operation-123', request_hash=fingerprint({'amount': 10}, actor_id='actor'))

    async def asyncTearDown(self):
        if hasattr(self, 'engine'):
            await self.engine.dispose()
            async with self.admin.begin() as conn:
                await conn.execute(text(f'DROP SCHEMA {self.schema} CASCADE'))
            await self.admin.dispose()

    async def execute(self, **overrides):
        async with self.engine.begin() as conn:
            r = await reserve(conn, **(self.kw | overrides))
            if not r.replay:
                await conn.execute(text('INSERT INTO business VALUES (1, 10)'))
                await conn.execute(text('INSERT INTO outbox VALUES (1)'))
                await complete(conn, r, http_status=201, response={'id': 1})
            return r

    async def test_commit_and_restart_replays_original_status(self):
        await self.execute()
        await self.engine.dispose()
        r = await self.execute()
        self.assertTrue(r.replay)
        self.assertEqual((r.http_status, r.response), (201, {'id': 1}))
        async with self.engine.connect() as conn:
            self.assertEqual((await conn.execute(text('SELECT count(*) FROM business'))).scalar(), 1)
            self.assertEqual((await conn.execute(text('SELECT count(*) FROM outbox'))).scalar(), 1)

    async def test_a_rejected_request_frees_the_key_even_for_different_content_but_an_executed_one_does_not(self):
        async with self.engine.begin() as conn:
            r = await reserve(conn, **self.kw)
            await fail(conn, r, uncertain=False, error_code='HTTP_422')
        other = fingerprint({'amount': 99}, actor_id='actor')
        async with self.engine.begin() as conn:
            r2 = await reserve(conn, **(self.kw | {'request_hash': other}))     # nothing was applied: a corrected request may reuse the key
            self.assertFalse(r2.replay)
            await complete(conn, r2, http_status=200, response={'id': 2})
        with self.assertRaises(IdempotencyError) as ctx:                         # it executed now: other content conflicts
            await self.execute(request_hash=fingerprint({'amount': 5}, actor_id='actor'))
        self.assertEqual(ctx.exception.code, 'IDEMPOTENCY_CONFLICT')

    async def test_payload_conflict(self):
        await self.execute()
        with self.assertRaises(IdempotencyError) as ctx:
            await self.execute(request_hash=fingerprint({'amount': 20}, actor_id='actor'))
        self.assertEqual(ctx.exception.code, 'IDEMPOTENCY_CONFLICT')

    async def test_concurrent_inflight_never_executes_twice(self):
        async with self.engine.begin() as conn:
            r = await reserve(conn, **self.kw)
            async def contender():
                with self.assertRaises(IdempotencyError) as ctx:
                    await self.execute()
                self.assertEqual(ctx.exception.code, 'IDEMPOTENCY_PROCESSING')
                self.assertEqual(ctx.exception.retry_after, 2)
            await asyncio.gather(*(contender() for _ in range(8)))
            await complete(conn, r, http_status=201, response={'id': 1})

    async def test_crash_before_commit_rolls_back_everything(self):
        with self.assertRaises(RuntimeError):
            async with self.engine.begin() as conn:
                r = await reserve(conn, **self.kw)
                await conn.execute(text('INSERT INTO business VALUES (1, 10)'))
                await conn.execute(text('INSERT INTO outbox VALUES (1)'))
                await complete(conn, r, http_status=201, response={'id': 1})
                raise RuntimeError('simulated crash before commit')
        self.assertFalse((await self.execute()).replay)

    async def test_tenants_are_isolated_and_new_keys_are_distinct(self):
        async with self.engine.begin() as conn:
            a = await reserve(conn, **self.kw)
            b = await reserve(conn, **(self.kw | {'scope_id': 'tenant:b'}))
            c = await reserve(conn, **(self.kw | {'key': 'new-operation-123'}))
            self.assertEqual(len({a.id, b.id, c.id}), 3)

    async def test_unknown_and_expired_lease_require_reconciliation(self):
        async with self.engine.begin() as conn:
            r = await reserve(conn, **self.kw)
            await conn.execute(text("UPDATE idempotency_records SET lease_expires_at=now()-interval '1 second'"))
        with self.assertRaises(IdempotencyError) as ctx:
            await self.execute()
        self.assertEqual(ctx.exception.code, 'IDEMPOTENCY_RECONCILIATION_REQUIRED')
        async with self.engine.begin() as conn:
            await reconcile(conn, r.id, expected_token=r.token, response={'id': 1}, http_status=201)
        self.assertTrue((await self.execute()).replay)
        async with self.engine.begin() as conn:
            with self.assertRaises(IdempotencyError):
                await complete(conn, r, http_status=200, response={'id': 'stale worker'})

    async def test_known_failed_attempt_can_retry_unknown_cannot(self):
        async with self.engine.begin() as conn:
            r = await reserve(conn, **self.kw)
            await fail(conn, r, uncertain=False, error_code='TRANSACTION_NOT_SENT')
        async with self.engine.begin() as conn:
            retry = await reserve(conn, **self.kw)
            self.assertNotEqual(r.token, retry.token)
            await fail(conn, retry, uncertain=True, error_code='PROVIDER_TIMEOUT')
        with self.assertRaises(IdempotencyError) as ctx:
            await self.execute()
        self.assertEqual(ctx.exception.code, 'IDEMPOTENCY_RECONCILIATION_REQUIRED')

    async def test_response_cleanup_preserves_financial_tombstone(self):
        await self.execute()
        async with self.engine.begin() as conn:
            await conn.execute(text("UPDATE idempotency_records SET expires_at=now()-interval '1 second'"))
            self.assertEqual(await expire_responses(conn), 1)
        with self.assertRaises(IdempotencyError) as ctx:
            await self.execute()
        self.assertEqual(ctx.exception.code, 'IDEMPOTENCY_RESPONSE_EXPIRED')

    async def test_authorized_actor_bound_to_request(self):
        await self.execute()
        with self.assertRaises(IdempotencyError):
            await self.execute(request_hash=fingerprint({'amount': 10}, actor_id='different-actor'))
