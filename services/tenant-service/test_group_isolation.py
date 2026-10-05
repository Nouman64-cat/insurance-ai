"""Regression guard: Group Life work must not change individual/family behaviour.

Phase 0 of GROUP_LIFE_PLAN.md. Each test builds an isolated throwaway tenant
holding one individual policy, one family certificate and one group-life
certificate side by side, then checks that every place the individual flow
shares with group stays individual-only where it should.

Needs a running, migrated Postgres — same convention as test_underwriting_gate.py
(no mocking infra in this service). Creates and cleans up its own rows.

Run with: docker compose exec tenant-service python test_group_isolation.py
"""

import asyncio
import random
from datetime import date, timedelta
from uuid import UUID, uuid4

from sqlalchemy.exc import IntegrityError
from sqlmodel import delete, select

from database import _session_factory
from routers.policies import list_policies, upcoming_renewals
from routers.renewal_scheduler import renewal_candidates_query
from shared.models.core import (
    Customer,
    FamilyGroup,
    FamilyPlanTypeEnum,
    FamilyPolicy,
    InsuranceTypeEnum,
    MasterPolicy,
    Organization,
    Policy,
    PolicyStatusEnum,
    Tenant,
)


def _cnic() -> str:
    d = "".join(random.choices("0123456789", k=13))
    return f"{d[:5]}-{d[5:12]}-{d[12]}"


def _customer(tenant_id: UUID, name: str, **extra) -> Customer:
    return Customer(
        tenant_id=tenant_id, cnic=_cnic(), name=name, dob=date(1985, 5, 1),
        gender="Male", occupation="Engineer", declared_income=2_400_000, **extra,
    )


def _active_policy(tenant_id: UUID, customer_id: UUID, product: str, itype: InsuranceTypeEnum, **extra) -> Policy:
    return Policy(
        tenant_id=tenant_id, customer_id=customer_id, product_name=product,
        insurance_type=itype, coverage_amount=5_000_000, term_years=1,
        status=PolicyStatusEnum.ACTIVE, expiry_date=date.today() + timedelta(days=10),
        policy_number=f"T-{uuid4().hex[:8].upper()}", **extra,
    )


async def _make_fixture(session) -> dict:
    """Tenant with an individual policy, a family certificate and a group certificate."""
    tenant = Tenant(name=f"Group Isolation {uuid4().hex[:6]}", code=f"GI{uuid4().hex[:6].upper()}")
    session.add(tenant)
    await session.flush()

    individual = _customer(tenant.id, "Individual Customer")
    session.add(individual)

    org = Organization(tenant_id=tenant.id, name="Isolation Test Ltd")
    family = FamilyGroup(tenant_id=tenant.id, name="Isolation Family")
    session.add_all([org, family])
    await session.flush()

    employee = _customer(tenant.id, "Group Employee", organization_id=org.id)
    member = _customer(tenant.id, "Family Member", family_group_id=family.id, family_relationship="Self")
    session.add_all([employee, member])

    mp = MasterPolicy(
        tenant_id=tenant.id, organization_id=org.id, insurance_type=InsuranceTypeEnum.GROUP_LIFE,
        sum_assured_multiple=24, term_years=1, effective_date=date.today(), status="Active",
    )
    fp = FamilyPolicy(
        tenant_id=tenant.id, family_group_id=family.id, plan_type=FamilyPlanTypeEnum.LIFE_BUNDLE,
        term_years=1, effective_date=date.today(), status="Active",
    )
    session.add_all([mp, fp])
    await session.flush()

    ind_policy = _active_policy(tenant.id, individual.id, "Term Life", InsuranceTypeEnum.TERM_LIFE)
    fam_policy = _active_policy(tenant.id, member.id, "Term Life", InsuranceTypeEnum.TERM_LIFE, family_policy_id=fp.id)
    grp_policy = _active_policy(tenant.id, employee.id, "Group Life", InsuranceTypeEnum.GROUP_LIFE, master_policy_id=mp.id)
    session.add_all([ind_policy, fam_policy, grp_policy])
    await session.commit()

    return {
        "tenant_id": tenant.id,
        "individual": individual,
        "individual_policy": ind_policy.id,
        "family_policy": fam_policy.id,
        "group_policy": grp_policy.id,
    }


async def _cleanup(test_session, tenant_id: UUID) -> None:
    """FK order: certificates → contracts → people → groups → tenant."""
    # End the test's own transaction first: an idle-in-transaction session
    # holding locks would stall these deletes (and any migration the
    # --reload server runs meanwhile) without Postgres seeing a deadlock.
    await test_session.close()
    async with _session_factory() as session:
        for model in (Policy, MasterPolicy, FamilyPolicy, Customer, Organization, FamilyGroup):
            await session.exec(delete(model).where(model.tenant_id == tenant_id))
        await session.exec(delete(Tenant).where(Tenant.id == tenant_id))
        await session.commit()


async def test_renewal_scheduler_skips_group_certificates():
    async with _session_factory() as session:
        fx = await _make_fixture(session)
        try:
            q = renewal_candidates_query().where(Policy.tenant_id == fx["tenant_id"])
            ids = {p.id for p in (await session.exec(q)).all()}
            assert fx["individual_policy"] in ids, "individual policy must stay a renewal candidate"
            assert fx["family_policy"] in ids, "family certificate must stay a renewal candidate"
            assert fx["group_policy"] not in ids, "group certificate must not renew per employee"
            print("PASS test_renewal_scheduler_skips_group_certificates")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_upcoming_renewals_skips_group_certificates():
    async with _session_factory() as session:
        fx = await _make_fixture(session)
        try:
            rows = await upcoming_renewals(tenant_id=fx["tenant_id"], days=90, session=session)
            ids = {UUID(r["policy_id"]) for r in rows}
            assert fx["individual_policy"] in ids
            assert fx["family_policy"] in ids
            assert fx["group_policy"] not in ids
            print("PASS test_upcoming_renewals_skips_group_certificates")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_policy_list_segments_unchanged():
    async with _session_factory() as session:
        fx = await _make_fixture(session)
        try:
            rows = await list_policies(
                tenant_id=fx["tenant_id"], status=None, customer_id=None,
                assigned_agent_id=None, family_group_id=None, session=session,
            )
            segment = {r["id"]: r["segment"] for r in rows}
            assert segment[str(fx["individual_policy"])] == "individual"
            assert segment[str(fx["family_policy"])] == "family"
            assert segment[str(fx["group_policy"])] == "organization"
            print("PASS test_policy_list_segments_unchanged")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_individual_cnic_still_unique_per_tenant():
    async with _session_factory() as session:
        fx = await _make_fixture(session)
        try:
            dup = _customer(fx["tenant_id"], "Duplicate")
            dup.cnic = fx["individual"].cnic
            session.add(dup)
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
            else:
                raise AssertionError("duplicate CNIC within a tenant must be rejected")
            print("PASS test_individual_cnic_still_unique_per_tenant")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def main():
    await test_renewal_scheduler_skips_group_certificates()
    await test_upcoming_renewals_skips_group_certificates()
    await test_policy_list_segments_unchanged()
    await test_individual_cnic_still_unique_per_tenant()


if __name__ == "__main__":
    asyncio.run(main())
