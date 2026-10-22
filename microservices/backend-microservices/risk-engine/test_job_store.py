"""Real PostgreSQL evaluation receipt tests; no LLM/network calls."""
import asyncio
import unittest
from uuid import uuid4
from sqlalchemy import select
from shared.idempotency import IdempotencyError
from shared.idempotency.models import idempotency_records
from shared.idempotency.tests import test_postgres
from job_store import EvaluationJobs, metadata, results


class JobTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = test_postgres.PostgresTests.asyncTearDown

    async def asyncSetUp(self):
        await test_postgres.PostgresTests.asyncSetUp(self)
        async with self.engine.begin() as conn:
            await conn.run_sync(metadata.create_all)
        self.jobs = EvaluationJobs(self.engine)
        self.tenant = uuid4()
        self.kw = dict(tenant_id=self.tenant, operation_id=uuid4(), content={'policy_id': 'test-policy'})
        self.calls = 0

    async def evaluate(self):
        self.calls += 1
        return {'event_id': 'stable-event', 'reasons': ['Private domain-only assessment']}

    async def test_restart_redelivery_reuses_result_without_llm_cost(self):
        first = await self.jobs.run(**self.kw, evaluate=self.evaluate)
        await self.engine.dispose()
        replay = await EvaluationJobs(self.engine).run(**self.kw, evaluate=self.evaluate)
        self.assertEqual(first, replay)
        self.assertEqual(self.calls, 1)
        async with self.engine.connect() as conn:
            receipt = (await conn.execute(select(idempotency_records.c.response_json))).scalar_one()
            self.assertEqual(set(receipt), {'result_id'})
            self.assertNotIn('Private', str(receipt))
            self.assertEqual((await conn.execute(select(results.c.result_json))).scalar_one(), first)

    async def test_uncertain_failure_does_not_run_llm_again(self):
        async def failure():
            self.calls += 1
            raise TimeoutError()
        with self.assertRaises(TimeoutError):
            await self.jobs.run(**self.kw, evaluate=failure)
        with self.assertRaises(IdempotencyError) as error:
            await self.jobs.run(**self.kw, evaluate=failure)
        self.assertEqual(error.exception.code, 'IDEMPOTENCY_RECONCILIATION_REQUIRED')
        self.assertEqual(self.calls, 1)

    async def test_concurrent_duplicate_and_conflicting_content(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def slow():
            started.set()
            await release.wait()
            return await self.evaluate()
        task = asyncio.create_task(self.jobs.run(**self.kw, evaluate=slow))
        await started.wait()
        try:
            with self.assertRaises(IdempotencyError) as error:
                await self.jobs.run(**self.kw, evaluate=self.evaluate)
            self.assertEqual(error.exception.code, 'IDEMPOTENCY_PROCESSING')
        finally:
            release.set()
            await task
        with self.assertRaises(IdempotencyError) as error:
            await self.jobs.run(**{**self.kw, 'content': {'policy_id': 'different'}}, evaluate=self.evaluate)
        self.assertEqual(error.exception.code, 'IDEMPOTENCY_CONFLICT')
        await self.jobs.run(**{**self.kw, 'operation_id': uuid4()}, evaluate=self.evaluate)
        self.assertEqual(self.calls, 2)  # a genuinely new evaluation is permitted

    async def test_same_operation_id_is_isolated_between_tenants(self):
        await self.jobs.run(**self.kw, evaluate=self.evaluate)
        await self.jobs.run(**{**self.kw, 'tenant_id': uuid4()}, evaluate=self.evaluate)
        self.assertEqual(self.calls, 2)

    async def test_broker_failure_after_evaluation_does_not_repeat_work(self):
        from unittest.mock import patch
        import consumer
        from shared.events.kafka_events import ProposalSubmittedEvent
        event = ProposalSubmittedEvent(tenant_id=self.tenant, payload={
            'proposal_id': str(uuid4()),
            'customer': {'cnic': 'test-only', 'dob': '1990-01-01', 'gender': 'Male',
                         'occupation': 'Engineer', 'declared_income': 100000},
            'policy': {'product_name': 'Term', 'insurance_type': 'TermLife', 'coverage_amount': 100000, 'term_years': 10}})
        class Broker:
            def __init__(self): self.messages = []
            async def send_and_wait(self, topic, value, key):
                self.messages.append((topic, value, key))
                if len(self.messages) == 1:
                    raise TimeoutError()
        broker = Broker()
        result = {'medical_score': 1, 'financial_score': 1, 'fraud_probability': 0.0,
                  'composite_risk_score': 1, 'ai_decision': 'Approve', 'is_valid': True}
        with patch.object(consumer.job_store, 'get_store', return_value=self.jobs), \
             patch.object(consumer, 'run_evaluation', return_value=result) as llm, \
             patch.object(consumer, 'write_customer_to_graph'):
            with self.assertRaises(TimeoutError):
                await consumer._process(event, broker)
            await self.engine.dispose()
            await consumer._process(event, broker)
            self.assertEqual(llm.call_count, 1)
            self.assertEqual(broker.messages[0], broker.messages[1])
