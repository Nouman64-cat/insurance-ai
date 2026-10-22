import asyncio
import json
import unittest
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession
from shared.events.outbox import BusinessOutbox, deliver_one
from . import test_postgres


class Broker:
    def __init__(self):
        self.messages = []
        self.fail_after_acceptance = False

    async def send_and_wait(self, topic, value, key):
        self.messages.append((topic, json.loads(value), key))
        if self.fail_after_acceptance:
            raise TimeoutError('acknowledgement lost')


class BusinessOutboxTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = test_postgres.PostgresTests.asyncTearDown

    async def asyncSetUp(self):
        await test_postgres.PostgresTests.asyncSetUp(self)
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda sync: BusinessOutbox.__table__.create(sync))
        self.factory = async_sessionmaker(self.engine, class_=AsyncSession, expire_on_commit=False)
        self.id = uuid4()
        self.broker = Broker()

    async def enqueue(self, crash=False):
        async with self.factory() as session:
            async with session.begin():
                await session.execute(text('INSERT INTO business VALUES (1, 10)'))
                session.add(BusinessOutbox(id=self.id, topic='test.events', message_key='tenant:a',
                                          payload={'event_id': str(self.id), 'amount': 10}))
                await session.flush()
                if crash:
                    raise RuntimeError('crash before commit')

    async def test_rollback_and_restart_delivery(self):
        with self.assertRaises(RuntimeError):
            await self.enqueue(crash=True)
        self.assertFalse(await deliver_one(self.factory, self.broker))
        await self.enqueue()
        await self.engine.dispose()
        self.assertTrue(await deliver_one(self.factory, self.broker))
        self.assertFalse(await deliver_one(self.factory, self.broker))
        self.assertEqual(len(self.broker.messages), 1)
        self.assertEqual(self.broker.messages[0][1]['event_id'], str(self.id))

    async def test_lost_ack_redelivery_keeps_the_same_identity(self):
        await self.enqueue()
        self.broker.fail_after_acceptance = True
        await deliver_one(self.factory, self.broker)
        async with self.engine.begin() as conn:
            await conn.execute(text('UPDATE business_outbox SET available_at=clock_timestamp()'))
        self.broker.fail_after_acceptance = False
        await self.engine.dispose()
        await deliver_one(self.factory, self.broker)
        self.assertEqual(self.broker.messages[0], self.broker.messages[1])
        async with self.engine.connect() as conn:
            row = (await conn.execute(text('SELECT attempts, published_at FROM business_outbox'))).one()
            self.assertEqual(row.attempts, 2)
            self.assertIsNotNone(row.published_at)

    async def test_concurrent_relays_and_expired_worker_lease(self):
        await self.enqueue()
        async with self.engine.begin() as conn:
            await conn.execute(text("UPDATE business_outbox SET lease_token=:token, lease_until=clock_timestamp() + interval '1 minute'"), {'token': uuid4()})
        self.assertFalse(await deliver_one(self.factory, self.broker))
        async with self.engine.begin() as conn:
            await conn.execute(text("UPDATE business_outbox SET lease_until=clock_timestamp() - interval '1 second'"))
        await asyncio.gather(*(deliver_one(self.factory, self.broker) for _ in range(5)))
        self.assertEqual(len(self.broker.messages), 1)
