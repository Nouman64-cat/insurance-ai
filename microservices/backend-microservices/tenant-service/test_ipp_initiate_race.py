"""Initiating the initial premium payment twice at once (the payment window asks as it opens, and can be mounted
twice in development) used to fail the second request with a 500 — both saw no row and one insert lost to the unique
index on case_id. Initiating is now idempotent.

Run with: docker compose exec tenant-service python test_ipp_initiate_race.py   (needs a migrated Postgres)
"""

import asyncio
from datetime import date
from uuid import uuid4

from fastapi import HTTPException
from sqlmodel import select

import routers.initial_premium_payment as ipp_router
from database import _session_factory
from shared.models.core import (
    Case, CaseStatusEnum, CaseTypeEnum, Customer, InitialPremiumPayment, InsuranceTypeEnum, IPPStatusEnum, Policy,
    PolicyStatusEnum, SourceChannelEnum, Tenant,
)
from test_group_census import _cleanup


async def _fixture(session):
    tenant = Tenant(name=f"IPP {uuid4().hex[:6]}", code=f"IP{uuid4().hex[:6].upper()}")
    session.add(tenant)
    await session.flush()
    customer = Customer(tenant_id=tenant.id, cnic=f"35202-{uuid4().int % 10**7:07d}-1", name="Race Test", dob=date(1990, 1, 1),
                        gender="Male", occupation="Engineer", declared_income=2_400_000)
    session.add(customer)
    await session.flush()
    policy = Policy(tenant_id=tenant.id, customer_id=customer.id, product_name="Term", insurance_type=InsuranceTypeEnum.TERM_LIFE,
                    coverage_amount=5_000_000, term_years=10, status=PolicyStatusEnum.QUOTED)
    session.add(policy)
    await session.flush()
    case = Case(tenant_id=tenant.id, customer_id=customer.id, policy_id=policy.id, caseNumber=f"CASE-T-{uuid4().hex[:8].upper()}",
                caseType=CaseTypeEnum.UNDERWRITING, caseStatus=CaseStatusEnum.NEW, sourceChannel=SourceChannelEnum.AGENT)
    session.add(case)
    await session.commit()
    return tenant.id, case.caseld


async def _initiate(tenant_id, case_id):
    async with _session_factory() as session:
        return await ipp_router.initiate_ipp(tenant_id, case_id, ipp_router.IPPInitiateRequest(), token="t", session=session)


async def test_concurrent_initiations_both_succeed_and_leave_one_row():
    async with _session_factory() as session:
        tenant_id, case_id = await _fixture(session)
    saved, ipp_router._get_current_user_id = ipp_router._get_current_user_id, (lambda token: asyncio.sleep(0))
    real_amount = ipp_router._latest_quote_amount

    async def slow_amount(*a, **kw):            # every request has looked for the row (found none) before any inserts
        await asyncio.sleep(0.3)
        return await real_amount(*a, **kw)
    ipp_router._latest_quote_amount = slow_amount
    try:
        results = await asyncio.gather(*[_initiate(tenant_id, case_id) for _ in range(6)], return_exceptions=True)
        failures = [r for r in results if isinstance(r, Exception)]
        assert not failures, failures
        async with _session_factory() as session:
            rows = (await session.exec(select(InitialPremiumPayment).where(InitialPremiumPayment.case_id == case_id))).all()
            assert len(rows) == 1 and rows[0].status == IPPStatusEnum.INITIATED and rows[0].amount > 0
            # Once paid, initiating again is refused, as before.
            rows[0].status = IPPStatusEnum.REALIZED
            session.add(rows[0])
            await session.commit()
        try:
            await _initiate(tenant_id, case_id)
            raise AssertionError("expected 409")
        except HTTPException as exc:
            assert exc.status_code == 409
        print("PASS test_concurrent_initiations_both_succeed_and_leave_one_row")
    finally:
        ipp_router._get_current_user_id, ipp_router._latest_quote_amount = saved, real_amount
        async with _session_factory() as session:
            from sqlalchemy import delete
            await session.exec(delete(InitialPremiumPayment).where(InitialPremiumPayment.tenant_id == tenant_id))
            await session.commit()
            await _cleanup(session, tenant_id)


async def main():
    await test_concurrent_initiations_both_succeed_and_leave_one_row()


if __name__ == "__main__":
    asyncio.run(main())
