"""Shared harness for route-level idempotency tests in tenant-service.

Real PostgreSQL (a random schema in IDEMPOTENCY_TEST_DATABASE_URL), the real decorated routers and the real shared
idempotency tables. Only identity is stubbed: the adapters still call the same authorize callbacks, so replays are
re-authorized exactly as in production. Nothing outside the random schema is touched.
"""
import os
os.environ.setdefault('DISABLE_PGVECTOR', 'true')
import unittest
from datetime import date, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.idempotency.tests import test_postgres
from shared.models.core import (Customer, InsuranceTypeEnum, Policy, PolicyStatusEnum, PolicyVersion, PremiumSchedule,
                                PremiumScheduleStatusEnum, Tenant)


class RouteCase(unittest.IsolatedAsyncioTestCase):
    """Subclass, set `routers` (modules exposing `.router` and `get_session`) and call `await self.make_policy(...)`."""
    routers: tuple = ()

    async def asyncSetUp(self):
        await test_postgres.PostgresTests.asyncSetUp(self)
        self.addAsyncCleanup(test_postgres.PostgresTests.asyncTearDown, self)
        async with self.engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
        self.factory = async_sessionmaker(self.engine, class_=AsyncSession, expire_on_commit=False)
        self.identity = SimpleNamespace(id=uuid4())
        self.app = FastAPI()
        for module in self.routers:
            self.app.include_router(module.router)

            async def session_dependency():
                async with self.factory() as session:
                    yield session
            self.app.dependency_overrides[module.get_session] = session_dependency
        async with self.factory() as session:
            tenant = Tenant(name='Idempotency route test', code=uuid4().hex[:8])
            session.add(tenant)
            await session.commit()
            self.tenant_id = tenant.id
        # Override the route's scope dependency by its ORIGINAL function object (before it is patched for the adapter's own check).
        from routers import policies
        self.app.dependency_overrides[policies._policy_in_scope] = lambda: None
        self._patches = [
            patch('services.idempotency.tenant_identity', AsyncMock(return_value=(self.identity, 'test-token'))),
            patch('routers.policies._policy_in_scope', AsyncMock()),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)

    def stub_role_dependencies(self, user=None):
        """Replace every `require_roles(...)` dependency of the included routers with a fixed signed-in user. The adapter still runs its own
        authorize callback on every call, so only the role gate (a separate, already tested concern) is stubbed."""
        user = user or SimpleNamespace(id=self.identity.id, tenant_id=self.tenant_id, full_name='Test Admin', email='admin@example.test',
                                       is_active=True, status='ACTIVE', username='admin')
        for route in self.app.routes:
            dependant = getattr(route, 'dependant', None)
            if dependant is None:
                continue
            for dep in dependant.dependencies:
                call = getattr(dep, 'call', None)
                if call is not None and 'require_roles' in getattr(call, '__qualname__', ''):
                    self.app.dependency_overrides[call] = lambda: user
        return user

    # ── fixtures ────────────────────────────────────────────────────────────────
    async def make_policy(self, *, status=PolicyStatusEnum.PENDING_PAYMENT, amount_due=12000.0, policy_number='POL-IDEM-1', schedule=True,
                          installments=None, free_look_days=None, **policy_fields):
        """A policy with one version and a premium ledger. `installments` = [(amount_due, PremiumScheduleStatusEnum, days_from_today)];
        `free_look_days` opens a free-look window ending that many days from today."""
        async with self.factory() as session:
            customer = Customer(tenant_id=self.tenant_id, cnic=f'35202-{uuid4().int % 10**7:07d}-1', name='Test only',
                                dob=date(1990, 1, 1), gender='Male', occupation='Engineer')
            session.add(customer)
            await session.flush()
            policy = Policy(tenant_id=self.tenant_id, customer_id=customer.id, product_name='Term', insurance_type=InsuranceTypeEnum.TERM_LIFE,
                            coverage_amount=1_000_000, term_years=10, status=status, policy_number=policy_number,
                            effective_date=date.today(), expiry_date=date.today() + timedelta(days=3650), **policy_fields)
            if free_look_days is not None:
                policy.delivery_date = date.today()
                policy.free_look_end_date = date.today() + timedelta(days=free_look_days)
            session.add(policy)
            await session.flush()
            version = PolicyVersion(policy_id=policy.id, version_number='1.0', effective_from=date.today(), base_premium=amount_due,
                                    loading_amount=0, policy_fee=0, tax_amount=0, total_premium=amount_due, created_by='test', event_type='Issuance')
            session.add(version)
            await session.flush()
            policy.current_version_id = version.id
            rows = installments if installments is not None else ([(amount_due, PremiumScheduleStatusEnum.PENDING, 0)] if schedule else [])
            ids = []
            for number, (amount, state, offset) in enumerate(rows, start=1):
                row = PremiumSchedule(policy_id=policy.id, policy_version_id=version.id, due_date=date.today() + timedelta(days=offset),
                                      amount_due=amount, amount_paid=amount if state == PremiumScheduleStatusEnum.PAID else 0.0, status=state,
                                      installment_no=number, payment_reference='PAID-REF' if state == PremiumScheduleStatusEnum.PAID else None)
                session.add(row)
                await session.flush()
                ids.append(row.id)
            await session.commit()
            return SimpleNamespace(policy_id=policy.id, schedule_id=ids[0] if ids else None, schedule_ids=ids, customer_id=customer.id)

    # ── HTTP helpers ────────────────────────────────────────────────────────────
    def client(self):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')

    def base(self, policy_id):
        return f'/tenants/{self.tenant_id}/policies/{policy_id}'

    @staticmethod
    def headers(key=None, **extra):
        out = {'Authorization': 'Bearer test'}
        if key:
            out['Idempotency-Key'] = key
        return out | extra

    async def scalar(self, sql, **params):
        async with self.engine.connect() as conn:
            return (await conn.execute(text(sql), params)).scalar()

    async def receipts(self):
        async with self.engine.connect() as conn:
            return (await conn.execute(text('SELECT operation, status, response_json FROM idempotency_records ORDER BY created_at'))).mappings().all()
