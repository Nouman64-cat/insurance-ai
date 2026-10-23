"""The view-receipt mode of the atomic adapter and the side-effect adapter, on real PostgreSQL."""
import asyncio
import unittest
from types import SimpleNamespace

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.idempotency.http import database_operation, side_effect_operation
from . import test_postgres

HEADERS = {'Authorization': 'Bearer allowed'}


class ModeTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_postgres.PostgresTests.asyncSetUp
    asyncTearDown = test_postgres.PostgresTests.asyncTearDown

    def build(self):
        factory = async_sessionmaker(self.engine, class_=AsyncSession, expire_on_commit=False)
        self.sent = []
        self.crash_after_send = False
        self.fail_with = None

        async def session():
            async with factory() as s:
                yield s

        async def user(request: Request):
            if request.headers.get('authorization') != 'Bearer allowed':
                raise HTTPException(403)
            return SimpleNamespace(id='actor')

        async def view(values, receipt):
            return {'rebuilt': True, **receipt}

        app = FastAPI()

        @app.post('/tenants/{tenant_id}/cases/{case_id}/advance')
        @database_operation('test.advance', response_fields=None, receipt_fields=('case_id',), replay_response=view,
                            view_receipt=lambda values: {'case_id': str(values['case_id'])})
        async def advance(tenant_id: str, case_id: str, session=Depends(session), user=Depends(user)):
            await session.execute(text('INSERT INTO business VALUES (:i, 1)'), {'i': int(case_id)})
            await session.commit()
            return {'big': 'view', 'with': ['many', 'unreviewed', 'fields'], 'pii': 'Ali Khan'}

        @app.post('/tenants/{tenant_id}/notify')
        @side_effect_operation('test.notify', response_fields=('id', 'sent'), recover='retry')
        async def notify(tenant_id: str, body: dict, session=Depends(session), user=Depends(user)):
            if self.fail_with:
                raise self.fail_with
            self.sent.append(body['to'])
            if self.crash_after_send:
                raise asyncio.CancelledError()      # a client disconnect / process stop after the side effect
            return {'id': 7, 'sent': True, 'recipient': body['to']}

        @app.post('/tenants/{tenant_id}/pay')
        @side_effect_operation('test.pay', response_fields=('id',))
        async def pay(tenant_id: str, body: dict, session=Depends(session), user=Depends(user)):
            self.sent.append(body['to'])
            if self.crash_after_send:
                raise asyncio.CancelledError()
            return {'id': 1}
        async def settle_view(values, receipt):
            return {'settled': True, 'case_id': receipt['case_id']}

        async def settle_evidence(values, record):
            return self.evidence_verdict

        @app.post('/tenants/{tenant_id}/cases/{case_id}/settle')
        @side_effect_operation('test.settle', response_fields=None, view_receipt=lambda values, payload: {'case_id': str(values['case_id'])},
                               receipt_fields=('case_id',), replay_response=settle_view, evidence=settle_evidence)
        async def settle(tenant_id: str, case_id: str, session=Depends(session), user=Depends(user)):
            self.sent.append(case_id)
            if self.crash_after_send:
                raise asyncio.CancelledError()
            return {'settled': True, 'case_id': case_id, 'private': 'Ali Khan'}
        self.evidence_verdict = None
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test')

    async def abandon(self, c, key):
        h = HEADERS | {'Idempotency-Key': key}
        self.crash_after_send = True
        with self.assertRaises(BaseException):
            await c.post('/tenants/a/cases/9/settle', headers=h)
        self.crash_after_send = False
        async with self.engine.begin() as conn:
            await conn.execute(text("UPDATE idempotency_records SET lease_expires_at = clock_timestamp() - interval '1 second'"))
        return h

    async def test_evidence_that_the_work_happened_completes_the_attempt_without_repeating_it(self):
        async with self.build() as c:
            h = await self.abandon(c, 'settle-operation-1')
            self.evidence_verdict = True
            retry = await c.post('/tenants/a/cases/9/settle', headers=h)
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json(), {'settled': True, 'case_id': '9'})
        self.assertEqual(self.sent, ['9'], 'the domain proved it happened, so it was not run again')
        (row,) = await self.records()
        self.assertEqual((row['status'], row['response_json']), ('COMPLETED', {'case_id': '9'}))

    async def test_evidence_that_nothing_happened_allows_exactly_one_new_run(self):
        async with self.build() as c:
            h = await self.abandon(c, 'settle-operation-2')
            self.evidence_verdict = False
            retry = await c.post('/tenants/a/cases/9/settle', headers=h)
            again = await c.post('/tenants/a/cases/9/settle', headers=h)
        self.assertEqual((retry.status_code, again.status_code), (200, 200))
        self.assertEqual(again.headers['idempotency-replayed'], 'true')
        self.assertEqual(self.sent, ['9', '9'], 'the first run was abandoned before it counted; the retry ran once, the replay did not')

    async def test_no_evidence_leaves_the_operation_in_reconciliation(self):
        async with self.build() as c:
            h = await self.abandon(c, 'settle-operation-3')
            self.evidence_verdict = None
            retry = await c.post('/tenants/a/cases/9/settle', headers=h)
        self.assertEqual(retry.status_code, 409)
        self.assertEqual(retry.json()['detail']['code'], 'IDEMPOTENCY_RECONCILIATION_REQUIRED')
        self.assertEqual(self.sent, ['9'])

    async def records(self):
        async with self.engine.connect() as conn:
            return (await conn.execute(text('SELECT operation, status, response_json, last_error_code FROM idempotency_records'))).mappings().all()

    # ── view receipts ───────────────────────────────────────────────────────────
    async def test_view_receipt_stores_identifiers_only_and_rebuilds_on_replay(self):
        async with self.build() as c:
            h = HEADERS | {'Idempotency-Key': 'advance-operation-1'}
            first = await c.post('/tenants/a/cases/5/advance', headers=h)
            replay = await c.post('/tenants/a/cases/5/advance', headers=h)
        self.assertEqual(first.json()['pii'], 'Ali Khan')
        self.assertEqual(replay.json(), {'rebuilt': True, 'case_id': '5'})
        self.assertEqual(replay.headers['idempotency-replayed'], 'true')
        (row,) = await self.records()
        self.assertEqual(row['response_json'], {'case_id': '5'})
        self.assertNotIn('Ali Khan', str(row))

    async def test_view_receipt_is_bound_to_the_resource_in_the_path(self):
        async with self.build() as c:
            h = HEADERS | {'Idempotency-Key': 'advance-operation-2'}
            await c.post('/tenants/a/cases/5/advance', headers=h)
            other = await c.post('/tenants/a/cases/6/advance', headers=h)
        self.assertEqual(other.status_code, 409, 'the same key on another case is a different request')

    # ── side-effect adapter ─────────────────────────────────────────────────────
    async def test_a_completed_notification_is_not_sent_again(self):
        async with self.build() as c:
            h = HEADERS | {'Idempotency-Key': 'notify-operation-1'}
            a = await c.post('/tenants/a/notify', json={'to': 'x@example.test'}, headers=h)
            b = await c.post('/tenants/a/notify', json={'to': 'x@example.test'}, headers=h)
            changed = await c.post('/tenants/a/notify', json={'to': 'y@example.test'}, headers=h)
        self.assertEqual((a.status_code, b.status_code, changed.status_code), (200, 200, 409))
        self.assertEqual(b.headers['idempotency-replayed'], 'true')
        self.assertEqual(self.sent, ['x@example.test'])
        (row,) = await self.records()
        self.assertEqual(row['response_json'], {'id': 7, 'sent': True}, 'only reviewed fields are stored')

    async def test_a_rejected_request_leaves_the_key_retryable(self):
        async with self.build() as c:
            self.fail_with = HTTPException(422, 'bad recipient')
            h = HEADERS | {'Idempotency-Key': 'notify-operation-2'}
            first = await c.post('/tenants/a/notify', json={'to': 'x@example.test'}, headers=h)
            self.fail_with = None
            retry = await c.post('/tenants/a/notify', json={'to': 'x@example.test'}, headers=h)
        self.assertEqual((first.status_code, retry.status_code), (422, 200))
        self.assertEqual(self.sent, ['x@example.test'])

    async def test_an_abandoned_notification_may_be_repeated_when_recovery_is_retry(self):
        async with self.build() as c:
            h = HEADERS | {'Idempotency-Key': 'notify-operation-3'}
            self.crash_after_send = True
            with self.assertRaises(BaseException):
                await c.post('/tenants/a/notify', json={'to': 'x@example.test'}, headers=h)
            self.crash_after_send = False
            (stuck,) = await self.records()
            self.assertEqual(stuck['status'], 'PROCESSING', 'a cancelled request leaves a lease behind')
            async with self.engine.begin() as conn:                  # let the lease run out
                await conn.execute(text("UPDATE idempotency_records SET lease_expires_at = clock_timestamp() - interval '1 second'"))
            retry = await c.post('/tenants/a/notify', json={'to': 'x@example.test'}, headers=h)
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(self.sent, ['x@example.test', 'x@example.test'], 'at-least-once for notifications, and it is documented')

    async def test_an_abandoned_payment_like_operation_is_never_blindly_repeated(self):
        async with self.build() as c:
            h = HEADERS | {'Idempotency-Key': 'pay-operation-1'}
            self.crash_after_send = True
            with self.assertRaises(BaseException):
                await c.post('/tenants/a/pay', json={'to': 'acct-1'}, headers=h)
            self.crash_after_send = False
            async with self.engine.begin() as conn:
                await conn.execute(text("UPDATE idempotency_records SET lease_expires_at = clock_timestamp() - interval '1 second'"))
            retry = await c.post('/tenants/a/pay', json={'to': 'acct-1'}, headers=h)
        self.assertEqual(retry.status_code, 409)
        self.assertEqual(retry.json()['detail']['code'], 'IDEMPOTENCY_RECONCILIATION_REQUIRED')
        self.assertEqual(self.sent, ['acct-1'], 'the side effect ran once and the retry did not run it again')

    async def test_concurrent_identical_requests_run_the_side_effect_once(self):
        async with self.build() as c:
            h = HEADERS | {'Idempotency-Key': 'notify-operation-4'}
            rs = await asyncio.gather(*[c.post('/tenants/a/notify', json={'to': 'x@example.test'}, headers=h) for _ in range(6)])
        self.assertTrue(all(r.status_code in (200, 409) for r in rs), [r.status_code for r in rs])
        self.assertEqual(self.sent, ['x@example.test'])

    async def test_authorization_is_repeated_on_replay_and_tenants_are_isolated(self):
        async with self.build() as c:
            h = HEADERS | {'Idempotency-Key': 'notify-operation-5'}
            await c.post('/tenants/a/notify', json={'to': 'x@example.test'}, headers=h)
            denied = await c.post('/tenants/a/notify', json={'to': 'x@example.test'}, headers={'Idempotency-Key': 'notify-operation-5'})
            other_tenant = await c.post('/tenants/b/notify', json={'to': 'x@example.test'}, headers=h)
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(other_tenant.status_code, 200)
        self.assertEqual(self.sent, ['x@example.test', 'x@example.test'], 'the same key in another tenant is a different operation')


if __name__ == '__main__':
    unittest.main()


class SchemaTests(unittest.TestCase):
    def test_flat_nested_and_list_schemas(self):
        from shared.idempotency.http import schema_ok
        self.assertTrue(schema_ok({'a': 1}, ('a', 'b')))
        self.assertFalse(schema_ok({'a': 1, 'c': 2}, ('a', 'b')))
        self.assertFalse(schema_ok([{'a': 1}], ('a',)))
        spec = {'id': None, 'offer': ('x', 'y'), 'rows': [('n', 'm')]}
        self.assertTrue(schema_ok({'id': 1, 'offer': {'x': 1}, 'rows': [{'n': 1}, {'m': 2}]}, spec))
        self.assertFalse(schema_ok({'id': 1, 'offer': {'z': 1}}, spec))
        self.assertFalse(schema_ok({'id': 1, 'rows': [{'name': 'leak'}]}, spec))
        self.assertTrue(schema_ok([{'a': 1}, {'b': 2}], [('a', 'b')]))
        self.assertFalse(schema_ok({'a': 1}, [('a',)]))
        self.assertTrue(schema_ok([], [('a',)]))


class UploadFingerprintTests(unittest.IsolatedAsyncioTestCase):
    async def test_an_uploaded_file_is_fingerprinted_by_content_and_rewound(self):
        import io
        from starlette.datastructures import UploadFile
        from shared.idempotency.http import _encodable
        a = UploadFile(io.BytesIO(b'same bytes'), filename='x.pdf')
        b = UploadFile(io.BytesIO(b'same bytes'), filename='x.pdf')
        c = UploadFile(io.BytesIO(b'other bytes'), filename='x.pdf')
        ea, eb, ec = await _encodable(a), await _encodable(b), await _encodable(c)
        self.assertEqual(ea, eb)
        self.assertNotEqual(ea['sha256'], ec['sha256'])
        self.assertEqual(await a.read(), b'same bytes', 'the handler must still see the whole file')
