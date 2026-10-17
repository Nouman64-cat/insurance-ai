"""Integration tests for Group Life Phase 1 — plan link, benefit classes,
census → GroupMember, customer reuse, and safe removal.

Calls the router functions directly against a live, migrated Postgres (same
convention as test_group_isolation.py). The free cover limit is pinned high so
no risk-engine calls are made. Creates and cleans up its own tenant.

Run with: docker compose exec tenant-service python test_group_census.py
"""

import asyncio
import os
import random
import shutil
from datetime import date
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlmodel import delete, select

from database import _session_factory
from routers.customers import delete_customer
from routers.organizations import (
    confirm_employee_census,
    create_benefit_class,
    create_master_policy,
    delete_organization,
    delete_organization_employee,
    list_organization_cases,
    list_organization_employees,
    validate_employee_census,
)
from schemas import BenefitClassCreate, CensusRequest, MasterPolicyCreate
from seeds.insurance_plans_seed import INSURANCE_PLAN_SEED_DATA, seed_insurance_plans
from services.document_generator import MEDIA_ROOT
from shared.models.core import (
    Beneficiary,
    BeneficiaryVersion,
    Case,
    CaseStatusEnum,
    CaseTypeEnum,
    Customer,
    GroupBenefitClass,
    GroupClassCoverage,
    GroupMember,
    GroupMemberDependent,
    GroupQuote,
    InsurancePlan,
    InsuranceTypeEnum,
    MasterPolicy,
    Organization,
    Policy,
    PolicyEvent,
    PolicyStatusEnum,
    PremiumQuote,
    RiskAssessment,
    SourceChannelEnum,
    Tenant,
)


def _cnic() -> str:
    d = "".join(random.choices("0123456789", k=13))
    return f"{d[:5]}-{d[5:12]}-{d[12]}"


def _row(cnic: str, i: int, **kw) -> dict:
    row = {"cnic": cnic, "name": f"Employee {i}", "dob": "1988-03-15", "gender": "Male",
           "occupation": "Analyst", "declared_income": 1_200_000, "employee_id": f"E{i:03d}"}
    row.update(kw)
    return row


async def _setup(session) -> dict:
    tenant = Tenant(name=f"Group Census {uuid4().hex[:6]}", code=f"GC{uuid4().hex[:6].upper()}")
    session.add(tenant)
    await session.flush()
    await seed_insurance_plans(session, tenant.id)

    org = Organization(tenant_id=tenant.id, name="TechCorp Pakistan")
    individual = Customer(tenant_id=tenant.id, cnic=_cnic(), name="Ali Individual", dob=date(1985, 5, 1),
                          gender="Male", occupation="Engineer", declared_income=2_400_000)
    session.add_all([org, individual])
    await session.flush()
    ind_policy = Policy(tenant_id=tenant.id, customer_id=individual.id, product_name="Term Life",
                        insurance_type=InsuranceTypeEnum.TERM_LIFE, coverage_amount=5_000_000,
                        term_years=10, status=PolicyStatusEnum.ACTIVE)
    session.add(ind_policy)
    await session.flush()
    ind_case = Case(tenant_id=tenant.id, customer_id=individual.id, policy_id=ind_policy.id,
                    caseNumber=f"CASE-TEST-{uuid4().hex[:8].upper()}", caseType=CaseTypeEnum.UNDERWRITING,
                    caseStatus=CaseStatusEnum.NEW, sourceChannel=SourceChannelEnum.AGENT)
    session.add(ind_case)
    await session.commit()
    return {"tenant_id": tenant.id, "org_id": org.id, "individual_id": individual.id,
            "individual_cnic": individual.cnic, "individual_policy": ind_policy.id, "individual_case": ind_case.caseld}


async def _master_policy(session, fx, plan_code=None, fcl=1e9) -> UUID:
    mp = await create_master_policy(
        tenant_id=fx["tenant_id"], org_id=fx["org_id"], session=session,
        body=MasterPolicyCreate(sum_assured_multiple=24, term_years=1, effective_date=date(2026, 1, 1), plan_code=plan_code),
    )
    row = await session.get(MasterPolicy, mp.id)
    row.free_cover_limit = fcl   # keep every member guaranteed-issue → no risk-engine calls
    session.add(row)
    await session.commit()
    return mp.id


async def _add_classes(session, fx, mp_id) -> None:
    for body in (
        BenefitClassCreate(name="Management", basis="Flat", flat_amount=10_000_000, grades=["M1"]),
        BenefitClassCreate(name="Staff", basis="SalaryMultiple", salary_multiple=24, max_cover=5_000_000, is_default=True),
        BenefitClassCreate(name="Tenure", basis="ServiceBanded",
                           service_bands=[{"min_years": 0, "amount": 1_000_000}, {"min_years": 5, "amount": 2_000_000}]),
    ):
        await create_benefit_class(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, body=body, session=session)


async def _enroll(session, fx, mp_id, rows):
    return await confirm_employee_census(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id,
                                         body=CensusRequest(employees=rows), session=session)


def _census(fx) -> list:
    """10 rows (GROUP_LIFE's minimum): 1 manager, 1 tenure, 7 staff, + the
    tenant's existing individual customer as staff."""
    rows = [_row(_cnic(), 0, grade="M1"),
            _row(_cnic(), 1, benefit_class="Tenure", joining_date="2019-06-01")]
    rows += [_row(_cnic(), i) for i in range(2, 9)]
    rows.append(_row(fx["individual_cnic"], 9, name="Ali (as employee)", declared_income=3_600_000))
    return rows


async def _cleanup(test_session, tenant_id: UUID) -> None:
    # End the test's own transaction first: an idle-in-transaction session
    # holding locks would stall these deletes (and any migration the
    # --reload server runs meanwhile) without Postgres seeing a deadlock.
    await test_session.close()
    async with _session_factory() as session:
        # Generated quote / schedule PDFs live on the mounted media volume.
        for mp_id in (await session.exec(select(MasterPolicy.id).where(MasterPolicy.tenant_id == tenant_id))).all():
            shutil.rmtree(os.path.join(MEDIA_ROOT, "group", str(mp_id)), ignore_errors=True)
        for model in (GroupMemberDependent, GroupMember, GroupQuote, GroupClassCoverage, GroupBenefitClass,
                      PremiumQuote, RiskAssessment, PolicyEvent, BeneficiaryVersion, Beneficiary,
                      Case, Policy, MasterPolicy, Customer, Organization, InsurancePlan):
            await session.exec(delete(model).where(model.tenant_id == tenant_id))
        await session.exec(delete(Tenant).where(Tenant.id == tenant_id))
        await session.commit()


async def _expect_http(coro, code: int) -> HTTPException:
    try:
        await coro
    except HTTPException as exc:
        assert exc.status_code == code, f"expected {code}, got {exc.status_code}: {exc.detail}"
        return exc
    raise AssertionError(f"expected HTTP {code}")


# ── Tests ──────────────────────────────────────────────────────────────────

async def test_master_policy_plan_link():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            body = lambda code: MasterPolicyCreate(sum_assured_multiple=24, term_years=1,
                                                   effective_date=date(2026, 1, 1), plan_code=code)
            args = dict(tenant_id=fx["tenant_id"], org_id=fx["org_id"], session=session)

            default = await create_master_policy(body=body(None), **args)
            assert (default.plan_code, default.business_type) == ("GROUP_LIFE", "Conventional")
            takaful = await create_master_policy(body=body("GROUP_FAMILY_TAKAFUL"), **args)
            assert (takaful.plan_code, takaful.business_type) == ("GROUP_FAMILY_TAKAFUL", "Takaful")

            await _expect_http(create_master_policy(body=body("NO_SUCH_PLAN"), **args), 422)
            individual_code = next(p["code"] for p in INSURANCE_PLAN_SEED_DATA if p["category"] == "Individual")
            await _expect_http(create_master_policy(body=body(individual_code), **args), 422)
            print("PASS test_master_policy_plan_link")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_census_classes_reuse_and_members():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _master_policy(session, fx)
            await _add_classes(session, fx, mp_id)
            ids = dict(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, session=session)

            # First census below GROUP_LIFE's minimum of 10 is rejected.
            small = await validate_employee_census(body=CensusRequest(employees=_census(fx)[:3]), **ids)
            assert not small.is_valid and any("at least 10" in e for e in small.errors)

            rows = _census(fx)
            assert (await validate_employee_census(body=CensusRequest(employees=rows), **ids)).is_valid
            result = await _enroll(session, fx, mp_id, rows)
            by_name = {o.benefit_class: o for o in result.employees}
            assert len(result.employees) == 10

            cover = {o.group_member_id: o.coverage_amount for o in result.employees}
            members = {m.id: m for m in (await session.exec(select(GroupMember).where(GroupMember.master_policy_id == mp_id))).all()}
            assert set(members) == set(cover)
            classes = {c.id: c.name for c in (await session.exec(select(GroupBenefitClass))).all()}
            expected = {"Management": 10_000_000, "Tenure": 2_000_000}  # 6.5y service by 2026-01-01
            for mid, m in members.items():
                name = classes[m.benefit_class_id]
                if name in expected:
                    assert m.coverage_amount == expected[name], (name, m.coverage_amount)
                else:
                    assert name == "Staff"
                    assert m.coverage_amount == min(24 * m.basic_monthly_salary, 5_000_000)
                assert m.status == "Pending" and m.policy_id and m.cover_start_date == date(2026, 1, 1)
            assert by_name["Management"].coverage_amount == 10_000_000

            # The existing individual customer was reused, not duplicated or changed.
            reused = [o for o in result.employees if o.reused_existing_customer]
            assert len(reused) == 1 and reused[0].customer_id == fx["individual_id"]
            same_cnic = (await session.exec(select(Customer).where(
                Customer.tenant_id == fx["tenant_id"], Customer.cnic == fx["individual_cnic"]))).all()
            assert len(same_cnic) == 1
            individual = same_cnic[0]
            await session.refresh(individual)
            assert individual.organization_id is None and individual.name == "Ali Individual"
            assert individual.declared_income == 2_400_000
            ind_policy = await session.get(Policy, fx["individual_policy"])
            assert ind_policy.master_policy_id is None and ind_policy.status == PolicyStatusEnum.ACTIVE

            # Roster shows the reused member; the org's case list doesn't show their individual case.
            roster = await list_organization_employees(tenant_id=fx["tenant_id"], org_id=fx["org_id"], session=session)
            assert fx["individual_id"] in {c.id for c in roster} and len(roster) == 10
            cases = await list_organization_cases(tenant_id=fx["tenant_id"], org_id=fx["org_id"], session=session)
            assert str(fx["individual_case"]) not in {c["case_id"] for c in cases}

            # Classes are frozen once members exist; re-enrolling a member is a duplicate.
            await _expect_http(create_benefit_class(body=BenefitClassCreate(name="Late", basis="Flat", flat_amount=1), **ids), 409)
            dup = await _expect_http(_enroll(session, fx, mp_id, [rows[0], _row(_cnic(), 50)]), 422)
            assert rows[0]["cnic"] in dup.detail["duplicate_cnics"]

            # Top-up batches aren't held to the plan minimum.
            topup = await _enroll(session, fx, mp_id, [_row(_cnic(), 60), _row(_cnic(), 61)])
            assert len(topup.employees) == 2
            print("PASS test_census_classes_reuse_and_members")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_legacy_scheme_without_classes_unchanged():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _master_policy(session, fx)
            rows = [_row(_cnic(), i) for i in range(10)]
            result = await _enroll(session, fx, mp_id, rows)
            assert all(o.coverage_amount == 24 * 100_000 and o.benefit_class is None for o in result.employees)
            print("PASS test_legacy_scheme_without_classes_unchanged")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_remove_employee_keeps_individual():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _master_policy(session, fx)
            result = await _enroll(session, fx, mp_id, _census(fx))
            ids = dict(tenant_id=fx["tenant_id"], org_id=fx["org_id"], session=session)

            # Reused individual: certificate + membership go, person + individual policy stay.
            reused = next(o for o in result.employees if o.reused_existing_customer)
            await delete_organization_employee(employee_id=fx["individual_id"], **ids)
            session.expunge_all()
            assert await session.get(Policy, reused.policy_id) is None
            assert await session.get(GroupMember, reused.group_member_id) is None
            assert await session.get(Customer, fx["individual_id"]) is not None
            assert await session.get(Policy, fx["individual_policy"]) is not None

            # Census-created employee: removed entirely, as before.
            created = next(o for o in result.employees if not o.reused_existing_customer)
            await delete_organization_employee(employee_id=created.customer_id, **ids)
            session.expunge_all()
            assert await session.get(Customer, created.customer_id) is None

            # A customer who isn't this org's employee is a 404.
            await _expect_http(delete_organization_employee(employee_id=fx["individual_id"], **ids), 404)
            print("PASS test_remove_employee_keeps_individual")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_delete_organization_keeps_individual():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _master_policy(session, fx)
            await _add_classes(session, fx, mp_id)
            await _enroll(session, fx, mp_id, _census(fx))

            await delete_organization(tenant_id=fx["tenant_id"], org_id=fx["org_id"], session=session)
            session.expunge_all()
            t = fx["tenant_id"]
            for model in (MasterPolicy, GroupBenefitClass, GroupMember, Organization):
                assert not (await session.exec(select(model).where(model.tenant_id == t))).all(), model.__name__
            remaining = (await session.exec(select(Customer).where(Customer.tenant_id == t))).all()
            assert [c.id for c in remaining] == [fx["individual_id"]]
            assert await session.get(Policy, fx["individual_policy"]) is not None
            print("PASS test_delete_organization_keeps_individual")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_customer_delete_still_works_for_group_members():
    """The individual-side customer delete must not hit a group_members FK."""
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _master_policy(session, fx)
            result = await _enroll(session, fx, mp_id, _census(fx))
            employee = next(o for o in result.employees if not o.reused_existing_customer)

            await delete_customer(tenant_id=fx["tenant_id"], customer_id=employee.customer_id, session=session)
            session.expunge_all()
            assert await session.get(GroupMember, employee.group_member_id) is None
            print("PASS test_customer_delete_still_works_for_group_members")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def main():
    await test_master_policy_plan_link()
    await test_census_classes_reuse_and_members()
    await test_legacy_scheme_without_classes_unchanged()
    await test_remove_employee_keeps_individual()
    await test_delete_organization_keeps_individual()
    await test_customer_delete_still_works_for_group_members()


if __name__ == "__main__":
    asyncio.run(main())
