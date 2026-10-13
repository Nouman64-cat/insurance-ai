"""Commission integration tests in a disposable PostgreSQL schema.

Run: docker compose exec -T tenant-service python test_commission_earnings.py
No existing tenant rows are read or changed. The schema is removed in finally.
"""
import os
os.environ["DISABLE_PGVECTOR"] = "true"
import asyncio
import unittest
from datetime import date, datetime
from decimal import Decimal
from uuid import uuid4
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import create_access_token
from routers.commissions import router
from services.commission_engine import accrue_receipt, record_binding_receipt
from shared.commissions.calculator import allocate, policy_year
from shared.models.core import (Tenant, Role, User, Customer, Policy, InsuranceTypeEnum,
    AcquisitionSource, AcquisitionSourceType, PremiumReceipt, PremiumSchedule, PremiumScheduleStatusEnum)
from shared.models.commission import CommissionAgreement, CommissionAssignment, CommissionAccrual, CommissionEarning

factory = None


class CommissionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tenant = Tenant(name=f"Commission test {uuid4()}", code=uuid4().hex)
        self.role = Role(name=f"role-{uuid4()}", description="test")
        async with factory() as s:
            s.add_all([self.tenant, self.role]); await s.commit()
            self.users = [User(tenant_id=self.tenant.id, role_id=self.role.id, email=f"{uuid4()}@example.invalid",
                username=uuid4().hex, hashed_password="unused", full_name=f"User {i}") for i in range(3)]
            s.add_all(self.users); await s.commit()
            self.customer = Customer(tenant_id=self.tenant.id, name="Test insured")
            s.add(self.customer); await s.commit()
            self.policy = Policy(tenant_id=self.tenant.id, customer_id=self.customer.id, product_name="Test term",
                insurance_type=InsuranceTypeEnum.TERM_LIFE, coverage_amount=100000, term_years=10,
                effective_date=date(2025, 1, 1))
            self.source = AcquisitionSource(tenant_id=self.tenant.id, name="Producer", code="P1",
                source_type=AcquisitionSourceType.AGENT, user_id=self.users[2].id)
            s.add_all([self.policy, self.source]); await s.commit()
            self.agreement = CommissionAgreement(tenant_id=self.tenant.id, code="TEST", version=1, name="Contract",
                first_year_pct=Decimal('10'), renewal_pct=Decimal('5'), effective_from=date(2024, 1, 1),
                created_by=self.users[0].id, approved_by=self.users[1].id, status="APPROVED")
            self.schedule = PremiumSchedule(policy_id=self.policy.id, due_date=date(2025, 1, 1),
                amount_due=1000, amount_paid=1000, status=PremiumScheduleStatusEnum.PAID)
            s.add_all([self.agreement, self.schedule]); await s.commit()
            self.assignment = CommissionAssignment(tenant_id=self.tenant.id, policy_id=self.policy.id,
                source_id=self.source.id, agreement_id=self.agreement.id, split_pct=100, created_by=self.users[0].id)
            self.receipt = PremiumReceipt(tenant_id=self.tenant.id, policy_id=self.policy.id, schedule_id=self.schedule.id,
                receipt_no=uuid4().hex, base_amount=1000, surcharge_amount=100, total_amount=1100,
                created_at=datetime(2025, 1, 15))
            s.add_all([self.assignment, self.receipt]); await s.commit()
        self.app = FastAPI(); self.app.include_router(router)
        async def session_dependency():
            async with factory() as s:
                yield s
        self.app.dependency_overrides[get_session] = session_dependency

    async def client(self, index=0, role="Admin"):
        # Separate roles per actor so source scoping and maker/checker use real auth.
        async with factory() as s:
            r = Role(name=role, description="test")
            existing = (await s.exec(select(Role).where(Role.name == role))).first()
            if existing: r = existing
            else: s.add(r); await s.flush()
            user = await s.get(User, self.users[index].id)
            user.role_id = r.id; s.add(user); await s.commit()
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test",
            headers={"Authorization": "Bearer " + create_access_token({"sub": str(self.users[index].id)})})

    def url(self, suffix):
        return f"/tenants/{self.tenant.id}/commissions/{suffix}"

    async def post_receipt(self):
        async with factory() as s:
            receipt = await s.get(PremiumReceipt, self.receipt.id)
            result = await accrue_receipt(s, receipt); await s.commit()
            return result

    async def test_persisted_decimal_earning_and_snapshot(self):
        self.assertEqual((await self.post_receipt()).status, "POSTED")
        async with factory() as s:
            entry = (await s.exec(select(CommissionEarning).where(CommissionEarning.receipt_id == self.receipt.id))).one()
            self.assertEqual(entry.gross_amount, Decimal("100.00"))  # excludes surcharge
            self.assertEqual(entry.snapshot['agreement_version'], 1)
            self.assertEqual(entry.policy_year, 1)
            # Changing producer identity later never rewrites the financial snapshot.
            source = await s.get(AcquisitionSource, self.source.id); source.name = "Renamed"; s.add(source); await s.commit()
        await self.post_receipt()
        async with factory() as s:
            entry = (await s.exec(select(CommissionEarning).where(CommissionEarning.receipt_id == self.receipt.id))).one()
            self.assertEqual(entry.snapshot['payee_name'], "Producer")

    async def test_concurrent_redelivery_posts_once(self):
        await asyncio.gather(*(self.post_receipt() for _ in range(8)))
        async with factory() as s:
            rows = (await s.exec(select(CommissionEarning).where(CommissionEarning.receipt_id == self.receipt.id))).all()
            self.assertEqual(len(rows), 1)

    async def test_missing_configuration_is_retryable_exception(self):
        async with factory() as s:
            a = await s.get(CommissionAgreement, self.agreement.id); a.status = 'DRAFT'; s.add(a); await s.commit()
        self.assertEqual((await self.post_receipt()).status, 'EXCEPTION')
        async with factory() as s:
            self.assertFalse((await s.exec(select(CommissionEarning).where(CommissionEarning.receipt_id == self.receipt.id))).all())
            a = await s.get(CommissionAgreement, self.agreement.id); a.status = 'APPROVED'; s.add(a); await s.commit()
        self.assertEqual((await self.post_receipt()).status, 'POSTED')

    async def test_renewal_uses_due_date_not_collection_date(self):
        async with factory() as s:
            schedule = await s.get(PremiumSchedule, self.schedule.id); schedule.due_date = date(2026, 1, 1); s.add(schedule); await s.commit()
        await self.post_receipt()
        async with factory() as s:
            row = (await s.exec(select(CommissionEarning).where(CommissionEarning.receipt_id == self.receipt.id))).one()
            self.assertEqual((row.policy_year, row.gross_amount), (2, Decimal('50.00')))

    async def test_receipt_outside_effective_period_is_exception(self):
        async with factory() as s:
            a = await s.get(CommissionAgreement, self.agreement.id); a.effective_from = date(2026, 1, 1); s.add(a); await s.commit()
        self.assertIn('effective period', (await self.post_receipt()).reason)

    async def test_binding_receipt_is_stable_and_not_backfilled_from_status(self):
        async with factory() as s:
            policy = await s.get(Policy, self.policy.id)
            await record_binding_receipt(s, policy, {'method': 'BankTransfer', 'payment_reference': 'TEST'})
            await s.commit()
        async with factory() as s:
            policy = await s.get(Policy, self.policy.id)
            await record_binding_receipt(s, policy, {'method': 'BankTransfer', 'payment_reference': 'TEST'})
            await s.commit()
            receipts = (await s.exec(select(PremiumReceipt).where(PremiumReceipt.policy_id == policy.id))).all()
            self.assertEqual(len(receipts), 2)  # original fixture + exactly one binding receipt

    async def test_auth_tenant_and_agent_scope(self):
        await self.post_receipt()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test') as c:
            self.assertEqual((await c.get(self.url('earnings'))).status_code, 401)
        async with await self.client(2, 'Agent') as c:
            res = await c.get(self.url('earnings')); self.assertEqual(res.status_code, 200, res.text)
            self.assertEqual(res.json()['total'], 1)
            self.assertEqual((await c.get(self.url('agreements'))).status_code, 403)
            self.assertEqual((await c.get(f'/tenants/{uuid4()}/commissions/earnings')).status_code, 403)
        async with await self.client(1, 'Agent') as c:
            self.assertEqual((await c.get(self.url('earnings'))).json()['total'], 0)
            self.assertEqual((await c.get(self.url('summary'))).json()['entries'], 0)

    async def test_maker_checker_duplicate_version_and_immutable_approval(self):
        body = dict(code='NEW', version=1, name='New', first_year_pct='12.5', renewal_pct='3', effective_from='2024-01-01')
        async with await self.client() as c:
            res = await c.post(self.url('agreements'), json=body); self.assertEqual(res.status_code, 201, res.text)
            aid = res.json()['id']
            self.assertEqual((await c.post(self.url('agreements'), json=body)).status_code, 409)
            self.assertEqual((await c.post(self.url(f'agreements/{aid}/approve'))).status_code, 403)
        async with await self.client(1) as c:
            self.assertEqual((await c.post(self.url(f'agreements/{aid}/approve'))).status_code, 200)
            self.assertEqual((await c.post(self.url(f'agreements/{aid}/approve'))).status_code, 409)

    async def test_assignment_validation_and_freeze(self):
        async with await self.client() as c:
            body = {'producers': [{'source_id': str(self.source.id), 'agreement_id': str(self.agreement.id), 'split_pct': '99'}]}
            url = self.url(f'policies/{self.policy.id}/assignments')
            self.assertEqual((await c.put(url, json=body)).status_code, 422)
            body['producers'][0]['split_pct'] = '100'
            self.assertEqual((await c.put(url, json=body)).status_code, 200)
            await self.post_receipt()
            self.assertEqual((await c.put(url, json=body)).status_code, 409)

    async def test_transaction_rollback_leaves_no_partial_ledger(self):
        async with factory() as s:
            await accrue_receipt(s, await s.get(PremiumReceipt, self.receipt.id)); await s.rollback()
        async with factory() as s:
            self.assertFalse((await s.exec(select(CommissionAccrual).where(CommissionAccrual.receipt_id == self.receipt.id))).all())
            self.assertFalse((await s.exec(select(CommissionEarning).where(CommissionEarning.receipt_id == self.receipt.id))).all())

    async def test_first_premium_short_payment_cannot_activate_policy(self):
        from routers.policies import confirm_payment, PaymentConfirmRequest
        from shared.models.core import PolicyStatusEnum
        from fastapi import HTTPException
        async with factory() as s:
            policy = await s.get(Policy, self.policy.id); policy.status = PolicyStatusEnum.PENDING_PAYMENT
            schedule = await s.get(PremiumSchedule, self.schedule.id)
            schedule.amount_paid, schedule.status = 200, PremiumScheduleStatusEnum.PENDING
            s.add_all([policy, schedule]); await s.commit()
            with self.assertRaises(HTTPException) as err:
                await confirm_payment(self.tenant.id, policy.id, None,
                    PaymentConfirmRequest(amount=500, reference='TEST'), s)
            self.assertEqual(err.exception.status_code, 422)
            await s.refresh(schedule)
            self.assertEqual(schedule.amount_paid, 200)

    async def test_first_premium_topup_posts_total_once(self):
        from routers.policies import confirm_payment, PaymentConfirmRequest, initiate_payment, PaymentInitiateRequest
        from shared.models.core import PolicyStatusEnum
        async with factory() as s:
            policy = await s.get(Policy, self.policy.id); policy.status = PolicyStatusEnum.PENDING_PAYMENT
            schedule = await s.get(PremiumSchedule, self.schedule.id)
            schedule.amount_paid, schedule.status = 200, PremiumScheduleStatusEnum.PENDING
            s.add_all([policy, schedule]); await s.commit()
            initiated = await initiate_payment(self.tenant.id, policy.id, PaymentInitiateRequest(method='BankTransfer'), s)
            self.assertEqual(initiated['amount_due'], 800)
            self.assertEqual(initiated['payment']['amount'], 800)
            with patch('routers.policies.generate_and_store_documents', new=AsyncMock()):
                result = await confirm_payment(self.tenant.id, policy.id, None,
                    PaymentConfirmRequest(amount=800, reference='TEST', method='BankTransfer'), s)
            self.assertEqual(result['status'], 'Active')
        async with factory() as s:
            rows = (await s.exec(select(CommissionEarning).where(CommissionEarning.policy_id == self.policy.id))).all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].basis_amount, Decimal('1000.00'))

    async def test_collection_handler_posts_partial_receipt_and_final_balance(self):
        from routers.post_issuance import bulk_collect_premiums, BulkCollectBody, collect_installment, CollectBody
        from shared.models.core import PolicyStatusEnum
        async with factory() as s:
            policy = await s.get(Policy, self.policy.id); policy.status = PolicyStatusEnum.ACTIVE
            schedule = await s.get(PremiumSchedule, self.schedule.id)
            schedule.due_date = date.today(); schedule.amount_paid = 0; schedule.status = PremiumScheduleStatusEnum.PENDING
            s.add_all([policy, schedule]); await s.commit()
            with patch('routers.post_issuance.document_generator.generate_receipt', return_value={'file_path': 'test-only.pdf'}), patch('routers.post_issuance.compute_billing', new=AsyncMock(return_value={})):
                await bulk_collect_premiums(self.tenant.id, policy.id, BulkCollectBody(amount=400, manual=True, reference='PARTIAL'), None, s)
                await collect_installment(self.tenant.id, policy.id, schedule.id, CollectBody(manual=True, reference='BALANCE'), None, s)
        async with factory() as s:
            rows = (await s.exec(select(CommissionEarning).where(CommissionEarning.policy_id == self.policy.id))).all()
            self.assertEqual(sorted(r.basis_amount for r in rows), [Decimal('400.00'), Decimal('600.00')])
            self.assertEqual(sum(r.gross_amount for r in rows), Decimal('50.00'))  # year 2

    async def test_cross_tenant_producer_and_receipt_are_rejected(self):
        async with factory() as s:
            foreign = Tenant(name=str(uuid4()), code=uuid4().hex); s.add(foreign); await s.commit()
            source = AcquisitionSource(tenant_id=foreign.id, name='Foreign', code='FOREIGN', source_type=AcquisitionSourceType.AGENT)
            s.add(source); await s.commit()
        async with await self.client() as c:
            body = {'producers': [{'source_id': str(source.id), 'agreement_id': str(self.agreement.id), 'split_pct': '100'}]}
            self.assertEqual((await c.put(self.url(f'policies/{self.policy.id}/assignments'), json=body)).status_code, 422)
        async with factory() as s:
            receipt = await s.get(PremiumReceipt, self.receipt.id)
            receipt.tenant_id = foreign.id; s.add(receipt); await s.commit()
        async with await self.client() as c:
            self.assertEqual((await c.post(self.url('reconcile'), json={'receipt_ids': [str(self.receipt.id)]})).status_code, 404)

    async def test_rounding_conserves_total_and_leap_anniversary(self):
        self.assertEqual(sum(allocate('0.05', [('a', 100, 50), ('b', 100, 50)]).values()), Decimal('0.05'))
        self.assertEqual(allocate('0.05', [('a', 100, 50), ('b', 100, 50)])['a'], Decimal('0.03'))
        self.assertEqual(policy_year(date(2024, 2, 29), date(2025, 2, 28)), 2)

    async def test_reconcile_is_idempotent_and_tenant_scoped(self):
        async with await self.client() as c:
            payload = {'receipt_ids': [str(self.receipt.id)]}
            for _ in range(2):
                r = await c.post(self.url('reconcile'), json=payload); self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual((await c.get(self.url('earnings'))).json()['total'], 1)
            self.assertEqual((await c.get(self.url('summary'))).json()['accrued_gross'], '100.00')
            self.assertEqual((await c.post(self.url('reconcile'), json={'receipt_ids': [str(uuid4())]})).status_code, 404)


if __name__ == '__main__':
    import sys
    schema = 'commission_test_' + uuid4().hex
    db_url = os.environ['COMMISSION_TEST_DATABASE_URL']
    # NullPool makes the factory safe across unittest's per-test event loops.
    from sqlalchemy.pool import NullPool
    engine = create_async_engine(db_url, poolclass=NullPool, connect_args={'server_settings': {'search_path': schema}})
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async def setup():
        async with engine.begin() as c:
            await c.execute(text(f'CREATE SCHEMA "{schema}"'))
            await c.run_sync(SQLModel.metadata.create_all)
    async def cleanup():
        async with engine.begin() as c:
            await c.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await engine.dispose()
    try:
        asyncio.run(setup())
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(CommissionTests))
        sys.exit(not result.wasSuccessful())
    finally:
        asyncio.run(cleanup())
