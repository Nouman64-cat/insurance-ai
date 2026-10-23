import unittest

from sqlalchemy import text
from shared.idempotency import complete, fail, fingerprint, reserve
from shared.idempotency import maintenance
from . import test_postgres


class MaintenanceTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_postgres.PostgresTests.asyncSetUp
    asyncTearDown = test_postgres.PostgresTests.asyncTearDown

    async def put(self, key, finish):
        async with self.engine.begin() as conn:
            r = await reserve(conn, scope_id='tenant:a', operation='test.payment', key=key, request_hash=fingerprint({'k': key}, actor_id='x'), retention_days=1)
            if finish == 'complete':
                await complete(conn, r, http_status=201, response={'id': key})
            elif finish == 'unknown':
                await fail(conn, r, uncertain=True, error_code='TIMEOUT')

    async def test_cleanup_erases_only_expired_bodies_and_status_reports_the_backlog(self):
        await self.put('operation-complete-1', 'complete')
        await self.put('operation-complete-2', 'complete')
        await self.put('operation-unknown-1', 'unknown')
        async with self.engine.begin() as conn:
            await conn.execute(text("UPDATE idempotency_records SET expires_at = now() - interval '1 day' WHERE idempotency_key = 'operation-complete-1'"))
        before = await maintenance.status(self.engine)
        self.assertEqual((before['expired_bodies_pending_cleanup'], before['unknown_awaiting_decision']), (1, 1))
        self.assertEqual(await maintenance.cleanup_once(self.engine), 1)
        after = await maintenance.status(self.engine)
        self.assertEqual(after['expired_bodies_pending_cleanup'], 0)
        async with self.engine.connect() as conn:
            rows = dict((await conn.execute(text('SELECT idempotency_key, response_json IS NULL FROM idempotency_records'))).all())
        self.assertEqual(rows, {'operation-complete-1': True, 'operation-complete-2': False, 'operation-unknown-1': True})
        self.assertEqual(sum(after['records'].values()), 3, 'identity rows are kept')
