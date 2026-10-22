"""Real PostgreSQL confirmation/replay test; only a disposable schema is modified."""
import os
os.environ.setdefault('DISABLE_PGVECTOR', 'true')
import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock
from uuid import uuid4

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession
from shared.idempotency.tests import test_postgres
from shared.models.core import Customer, InitialPremiumPayment, IPPStatusEnum, InsuranceTypeEnum, Policy, PolicyStatusEnum, Tenant
from routers import initial_premium_payment as ipp


class ConfirmationReplay(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await test_postgres.PostgresTests.asyncSetUp(self)
        self.addAsyncCleanup(test_postgres.PostgresTests.asyncTearDown, self)
        async with self.engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
        self.factory = async_sessionmaker(self.engine, class_=AsyncSession, expire_on_commit=False)
        async with self.factory() as session:
            tenant = Tenant(name='Idempotency test', code=uuid4().hex[:8])
            session.add(tenant)
            await session.flush()
            customer = Customer(tenant_id=tenant.id, cnic='35202-1234567-1', name='Test only', dob=date(1990, 1, 1), gender='Male', occupation='Engineer')
            session.add(customer)
            await session.flush()
            policy = Policy(tenant_id=tenant.id, customer_id=customer.id, product_name='Term', insurance_type=InsuranceTypeEnum.TERM_LIFE, coverage_amount=100000,
                            term_years=10, status=PolicyStatusEnum.PROPOSED)
            session.add(policy)
            await session.flush()
            payment = InitialPremiumPayment(tenant_id=tenant.id, policy_id=policy.id, amount=100,
                method='JazzCash', reference='IPP-TEST-REFERENCE', status=IPPStatusEnum.INITIATED,
                proof_note='Private customer note')
            session.add(payment)
            await session.commit()
            self.tenant_id, self.policy_id = tenant.id, policy.id
        self.app = FastAPI()
        self.app.include_router(ipp.router)
        async def session_dependency():
            async with self.factory() as session:
                yield session
        self.app.dependency_overrides[ipp.get_session] = session_dependency

    async def test_confirmation_replays_without_second_payment_or_sensitive_receipt(self):
        identity = SimpleNamespace(id=uuid4())
        path = f'/tenants/{self.tenant_id}/policies/{self.policy_id}/ipp/confirm'
        headers = {'Authorization': 'Bearer test', 'Idempotency-Key': 'confirm-operation-123'}
        body = {'reference': 'IPP-TEST-REFERENCE', 'method': 'JazzCash', 'realize': True}
        with patch('services.idempotency.tenant_identity', AsyncMock(return_value=(identity, 'test'))), \
             patch('routers.policies._policy_in_scope', AsyncMock()), \
             patch.object(ipp, '_get_current_user_id', AsyncMock(return_value=identity.id)), \
             patch.object(ipp.payment_gateway, 'confirm_payment', wraps=ipp.payment_gateway.confirm_payment) as provider:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test') as client:
                first = await client.post(path, json=body, headers=headers)
                self.assertEqual(first.status_code, 200, first.text)
                await self.engine.dispose()  # receipt must survive all application connections
                replay = await client.post(path, json=body, headers=headers)
                self.assertEqual(replay.status_code, 200, replay.text)
                self.assertEqual(first.json(), replay.json())
                self.assertEqual(replay.headers['idempotency-replayed'], 'true')
                changed = await client.post(path, json={**body, 'reference': 'OTHER'}, headers=headers)
                self.assertEqual(changed.status_code, 409)
                other = await client.post(path, json=body, headers={**headers, 'Idempotency-Key': 'another-operation-123'})
                self.assertEqual(other.status_code, 409)
                self.assertEqual(provider.call_count, 1)
        async with self.engine.connect() as conn:
            receipt = (await conn.execute(text("SELECT response_json FROM idempotency_records WHERE status = 'COMPLETED'"))).scalar_one()
            rejected = (await conn.execute(text("SELECT status FROM idempotency_records WHERE idempotency_key = 'another-operation-123'"))).scalar_one()
            self.assertEqual(rejected, 'FAILED', 'a rejected request leaves a retryable marker, never a completed receipt')
            self.assertEqual(set(receipt), set(ipp.IPP_RECEIPT_FIELDS))
            self.assertNotIn('Private customer note', str(receipt))
            self.assertNotIn('link', receipt)


if __name__ == '__main__':
    unittest.main()
