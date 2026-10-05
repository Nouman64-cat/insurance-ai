"""Integration test for services/underwriting_gate.py (brief §23).

Needs a running, migrated Postgres — same requirement as the existing
test_db.py/test_docs.py scripts in this directory (no mocking infra exists
in this service, so this follows that established convention rather than
inventing a different one). Creates and cleans up its own throwaway rows.

Run with: docker compose exec tenant-service python test_underwriting_gate.py
"""

import asyncio
from datetime import date
from uuid import uuid4

from sqlmodel import delete, select

from database import get_session
from services import underwriting_gate
from shared.models.core import (
    Case,
    CaseRequirementStatusEnum,
    CaseStatusEnum,
    CaseTypeEnum,
    CaseWorkflow,
    Customer,
    CaseRequirement,
    Policy,
    SourceChannelEnum,
    Tenant,
    VerificationFinding,
)


async def _delete_case_cascade(session, case) -> None:
    """Mirrors routers/cases.py::delete_case's manual cascade — CaseRequirement/
    VerificationFinding/CaseWorkflow are FK'd to the case and must go first."""
    await session.exec(delete(CaseRequirement).where(CaseRequirement.case_id == case.caseld))
    await session.exec(delete(VerificationFinding).where(VerificationFinding.case_id == case.caseld))
    await session.exec(delete(CaseWorkflow).where(CaseWorkflow.caseld == case.caseld))
    await session.delete(case)


async def _make_tenant_customer_case(session):
    tenant = Tenant(name=f"Test Tenant {uuid4().hex[:6]}", code=f"T{uuid4().hex[:6].upper()}")
    session.add(tenant)
    await session.flush()

    customer = Customer(
        tenant_id=tenant.id, cnic=f"{uuid4().hex[:13]}", name="Gate Test Customer",
        dob=date(2000, 1, 1), gender="Male", occupation="Teacher",
        declared_income=1_200_000, is_smoker=False, height_cm=170, weight_kg=65,
    )
    session.add(customer)
    await session.flush()

    policy = Policy(
        tenant_id=tenant.id, customer_id=customer.id, product_name="Term Life",
        insurance_type="TERM_LIFE", coverage_amount=2_000_000, term_years=10,
    )
    session.add(policy)
    await session.flush()

    case = Case(
        tenant_id=tenant.id, customer_id=customer.id, policy_id=policy.id,
        caseNumber=f"CASE-TEST-{uuid4().hex[:8].upper()}", caseType=CaseTypeEnum.UNDERWRITING,
        caseStatus=CaseStatusEnum.NEW, sourceChannel=SourceChannelEnum.AGENT,
    )
    session.add(case)
    await session.flush()
    await session.commit()
    return tenant, customer, policy, case


async def test_compute_requirements_is_idempotent():
    async for session in get_session():
        tenant, customer, policy, case = await _make_tenant_customer_case(session)
        try:
            rows1, satisfied1 = await underwriting_gate.compute_requirements(session, tenant.id, case)
            await session.commit()
            count1 = len(rows1)

            rows2, satisfied2 = await underwriting_gate.compute_requirements(session, tenant.id, case)
            await session.commit()

            all_rows = (await session.exec(
                select(CaseRequirement).where(CaseRequirement.case_id == case.caseld)
            )).all()
            assert len(all_rows) == count1, (
                f"re-running compute_requirements duplicated rows: {count1} -> {len(all_rows)}"
            )
            assert satisfied1 is False  # no documents uploaded yet
            assert satisfied2 is False
            print("PASS test_compute_requirements_is_idempotent")
        finally:
            await _delete_case_cascade(session, case)
            await session.delete(policy)
            await session.delete(customer)
            await session.delete(tenant)
            await session.commit()


async def test_unmet_requirements_moves_case_to_pending_documents():
    async for session in get_session():
        tenant, customer, policy, case = await _make_tenant_customer_case(session)
        try:
            await underwriting_gate.compute_requirements(session, tenant.id, case)
            await session.commit()
            await session.refresh(case)
            assert case.caseStatus == CaseStatusEnum.PENDING_DOCUMENTS, case.caseStatus
            print("PASS test_unmet_requirements_moves_case_to_pending_documents")
        finally:
            await _delete_case_cascade(session, case)
            await session.delete(policy)
            await session.delete(customer)
            await session.delete(tenant)
            await session.commit()


async def test_waiving_a_requirement_is_not_reverted_by_recomputation():
    async for session in get_session():
        tenant, customer, policy, case = await _make_tenant_customer_case(session)
        try:
            rows, _ = await underwriting_gate.compute_requirements(session, tenant.id, case)
            await session.commit()
            cnic_row = next(r for r in rows if r.code == "CNIC")

            await underwriting_gate.waive_requirement(session, cnic_row, note="test waiver")
            await session.commit()

            rows2, _ = await underwriting_gate.compute_requirements(session, tenant.id, case)
            await session.commit()
            cnic_row2 = next(r for r in rows2 if r.code == "CNIC")
            assert cnic_row2.status == CaseRequirementStatusEnum.WAIVED, cnic_row2.status
            print("PASS test_waiving_a_requirement_is_not_reverted_by_recomputation")
        finally:
            await _delete_case_cascade(session, case)
            await session.delete(policy)
            await session.delete(customer)
            await session.delete(tenant)
            await session.commit()


async def test_tenant_isolation_on_case_requirements():
    """A requirements/evidence call scoped to tenant A must never see or
    touch tenant B's case, even if the case_id happens to be known."""
    async for session in get_session():
        tenant_a, customer_a, policy_a, case_a = await _make_tenant_customer_case(session)
        tenant_b, customer_b, policy_b, case_b = await _make_tenant_customer_case(session)
        try:
            await underwriting_gate.compute_requirements(session, tenant_a.id, case_a)
            await session.commit()

            # tenant_b's gate call against its OWN case must not see tenant_a's rows.
            rows_b, _ = await underwriting_gate.compute_requirements(session, tenant_b.id, case_b)
            await session.commit()
            assert all(r.tenant_id == tenant_b.id for r in rows_b)

            rows_a = (await session.exec(
                select(CaseRequirement).where(CaseRequirement.case_id == case_a.caseld)
            )).all()
            assert all(r.tenant_id == tenant_a.id for r in rows_a)
            print("PASS test_tenant_isolation_on_case_requirements")
        finally:
            for c, p, cust, t in ((case_a, policy_a, customer_a, tenant_a), (case_b, policy_b, customer_b, tenant_b)):
                await _delete_case_cascade(session, c)
                await session.delete(p)
                await session.delete(cust)
                await session.delete(t)
            await session.commit()


async def main():
    await test_compute_requirements_is_idempotent()
    await test_unmet_requirements_moves_case_to_pending_documents()
    await test_waiving_a_requirement_is_not_reverted_by_recomputation()
    await test_tenant_isolation_on_case_requirements()


if __name__ == "__main__":
    asyncio.run(main())
