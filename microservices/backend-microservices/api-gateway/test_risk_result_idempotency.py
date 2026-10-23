"""Real PostgreSQL redelivery/concurrency coverage for the risk result worker."""
import os
os.environ.setdefault('DISABLE_PGVECTOR', 'true')
import asyncio
import unittest
from datetime import date
from unittest.mock import patch
from uuid import uuid4
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession
from shared.idempotency.tests import test_postgres
from shared.events.kafka_events import RiskEvaluatedEvent
from shared.models.core import Customer, Tenant, Policy, PolicyStatusEnum, InsuranceTypeEnum
import risk_result_worker as worker


class ResultTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await test_postgres.PostgresTests.asyncSetUp(self)
        self.addAsyncCleanup(test_postgres.PostgresTests.asyncTearDown, self)
        async with self.engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
        self.factory = async_sessionmaker(self.engine, class_=AsyncSession, expire_on_commit=False)
        async with self.factory() as session:
            tenant = Tenant(name='Risk test', code=uuid4().hex[:8])
            session.add(tenant)
            await session.flush()
            customer = Customer(tenant_id=tenant.id, name='Test only', cnic='35202-1111111-1',
                                dob=date(1990,1,1), gender='Male', occupation='Engineer')
            session.add(customer)
            await session.flush()
            policy = Policy(tenant_id=tenant.id, customer_id=customer.id, product_name='Term',
                insurance_type=InsuranceTypeEnum.TERM_LIFE, coverage_amount=100000, term_years=10,
                status=PolicyStatusEnum.UNDER_REVIEW)
            session.add(policy)
            await session.commit()
            self.event = RiskEvaluatedEvent(correlation_id=uuid4(), payload={
                'proposal_id': str(uuid4()), 'tenant_id': str(tenant.id), 'customer_id': str(customer.id),
                'policy_id': str(policy.id), 'scores': {'medical_score': 10, 'financial_score': 10,
                'fraud_probability': 0.0, 'composite_risk_score': 10}, 'ai_decision': 'Auto Approve', 'reasons': []})

    async def test_concurrent_redelivery_writes_one_assessment(self):
        with patch.object(worker, '_session_factory', self.factory):
            await asyncio.gather(*(worker._process(self.event) for _ in range(5)))
            await self.engine.dispose()
            await worker._process(self.event)
        async with self.engine.connect() as conn:
            self.assertEqual((await conn.execute(text('SELECT count(*) FROM risk_assessments'))).scalar_one(), 1)
        with patch.object(worker, '_session_factory', self.factory):
            await worker._process(self.event.model_copy(update={'correlation_id': uuid4(), 'event_id': uuid4()}))
        async with self.engine.connect() as conn:
            self.assertEqual((await conn.execute(text('SELECT count(*) FROM risk_assessments'))).scalar_one(), 2)
