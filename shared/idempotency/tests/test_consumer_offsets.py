import unittest
from types import SimpleNamespace
from shared.events.consumer import process_partition


class Consumer:
    def __init__(self):
        self.commits, self.seeks = [], []
    async def commit(self, offsets):
        self.commits.append(offsets)
    def seek(self, partition, offset):
        self.seeks.append((partition, offset))


class OffsetTests(unittest.IsolatedAsyncioTestCase):
    async def test_failure_does_not_acknowledge_later_fetched_messages(self):
        consumer = Consumer()
        seen = []
        async def handler(message):
            seen.append(message.offset)
            if message.offset == 11:
                raise TimeoutError()
        messages = [SimpleNamespace(offset=n) for n in (10, 11, 12)]
        self.assertFalse(await process_partition(consumer, 'partition-a', messages, handler))
        self.assertEqual(seen, [10, 11])
        self.assertEqual(consumer.commits, [{'partition-a': 11}])
        self.assertEqual(consumer.seeks, [('partition-a', 11)])
        async def successful(message):
            seen.append(message.offset)
        await process_partition(consumer, 'partition-b', [SimpleNamespace(offset=8)], successful)
        self.assertEqual(consumer.commits[-1], {'partition-b': 9})
        await process_partition(consumer, 'partition-a', messages[1:], successful)
        self.assertEqual(consumer.commits[-2:], [{'partition-a': 12}, {'partition-a': 13}])

    async def test_commit_failure_retries_the_same_message(self):
        consumer = Consumer()
        async def fail(offsets):
            raise ConnectionError()
        consumer.commit = fail
        async def handler(message):
            pass
        self.assertFalse(await process_partition(consumer, 'a', [SimpleNamespace(offset=3)], handler))
        self.assertEqual(consumer.seeks, [('a', 3)])
