"""Registration must never create another file for a corrected death date."""
import asyncio
from datetime import date
from types import SimpleNamespace as NS
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlmodel import select

from routers.claims import ClaimCreate, _same_claim_event, open_claim
from shared.models.core import Claim, ClaimStatusEnum


def existing(**values):
    return NS(**{"group_member_id": None, "group_dependent_id": None, "coverage_type": None,
              "claim_type": "Death Claim", "incident_date": date(2026, 10, 17),
                 "submitted_amount": 200000, **values})


def body(**values):
    return ClaimCreate(**{"policy_id": uuid4(), "claim_type": "Death Claim", "submitted_amount": 200000,
                       "incident_date": date(2026, 10, 18), **values})


def test_new_date_amount_or_claimant_does_not_create_a_second_death():
    assert _same_claim_event(existing(), None, body(submitted_amount=250000, claimant_name="Another heir"))


def test_other_insured_people_and_benefits_are_distinct():
    process = NS(covered_person_relationship="Spouse", covered_person_name="Sara", covered_person_cnic="111-22")
    assert not _same_claim_event(existing(), process, body())
    assert _same_claim_event(existing(), process, body(), covered_person_relationship="Spouse", covered_person_cnic="11122")
    assert not _same_claim_event(existing(), process, body(), covered_person_relationship="Spouse", covered_person_cnic="33344")
    assert not _same_claim_event(existing(group_member_id=uuid4()), None, body(), group_member_id=uuid4())
    member = uuid4()
    assert not _same_claim_event(existing(group_member_id=member, group_dependent_id=uuid4()), None, body(), group_member_id=member)
    assert not _same_claim_event(existing(), None, body(claim_type="Accidental Death"))


def test_non_death_events_on_different_dates_can_be_registered():
    old = existing(claim_type="Hospitalization")
    assert not _same_claim_event(old, None, body(claim_type="Hospitalization"))
    assert _same_claim_event(old, None, body(claim_type="Hospitalization", incident_date=old.incident_date))


@pytest.mark.parametrize("status", [ClaimStatusEnum.NEW, ClaimStatusEnum.DECLINED, ClaimStatusEnum.CLOSED])
def test_duplicate_is_rejected_before_any_write_even_after_rejection(status):
    class Session:
        def __init__(self):
            self.queries = []
        async def get(self, model, key):
            return NS(is_active=True) if model.__name__ == "Tenant" else None
        async def exec(self, query):
            self.queries.append(query)
            if len(self.queries) == 1:
                return NS(first=lambda: NS(id=policy_id, tenant_id=tenant_id, customer_id=uuid4()))
            if len(self.queries) == 2:
                return NS(all=lambda: [NS(**vars(existing()), id=uuid4(), claim_number="CLM-2026-0001", status=status)])
            return NS(first=lambda: None)
        def add(self, _):
            pytest.fail("Duplicate registration wrote a new row")
    tenant_id, policy_id = uuid4(), uuid4()
    session = Session()
    with pytest.raises(HTTPException) as error:
        asyncio.run(open_claim(session, tenant_id, NS(id=None), body(policy_id=policy_id)))
    assert error.value.status_code == 409
    assert "CLM-2026-0001" in error.value.detail and "No new claim" in error.value.detail
    assert session.queries[0]._for_update_arg is not None


def test_concurrent_death_registration_and_retry_use_one_file(monkeypatch):
    from database import _session_factory, engine
    from routers import claims

    async def test_number(*_):
        return f"CLM-TEST-{uuid4().hex}"
    # Test tenants share a database whose legacy case numbers are globally unique.
    monkeypatch.setattr(claims, "_generate_claim_number", test_number)
    from test_group_census import _setup
    from test_group_claims import _cleanup_all

    async def run():
        async with _session_factory() as setup:
            fx = await _setup(setup)
        async def register(day):
            async with _session_factory() as session:
                try:
                    claim, _, _ = await open_claim(session, fx["tenant_id"], NS(id=None), ClaimCreate(
                        policy_id=fx["individual_policy"], claim_type="Death Claim", submitted_amount=200000,
                        incident_date=date(2026, 10, day)))
                    return claim.id
                except HTTPException as exc:
                    assert exc.status_code == 409
                    return None
        try:
            results = await asyncio.wait_for(asyncio.gather(register(17), register(18)), timeout=20)
            assert sum(result is not None for result in results) == 1
            assert await register(18) is None
            async with _session_factory() as session:
                claims = (await session.exec(select(Claim).where(Claim.tenant_id == fx["tenant_id"]))).all()
                assert len(claims) == 1
        finally:
            async with _session_factory() as cleanup:
                await _cleanup_all(cleanup, fx)
            await engine.dispose()
    asyncio.run(run())


def test_workflow_registration_can_rollback_without_an_orphan_claim(monkeypatch):
    from database import _session_factory, engine
    from routers import claims

    async def test_number(*_):
        return f"CLM-TEST-{uuid4().hex}"
    # Test tenants share a database whose legacy case numbers are globally unique.
    monkeypatch.setattr(claims, "_generate_claim_number", test_number)
    from test_group_census import _setup
    from test_group_claims import _cleanup_all

    async def run():
        async with _session_factory() as setup:
            fx = await _setup(setup)
        try:
            async with _session_factory() as session:
                await open_claim(session, fx["tenant_id"], NS(id=None), ClaimCreate(
                    policy_id=fx["individual_policy"], claim_type="Death Claim", submitted_amount=200000), commit=False)
                await session.rollback()  # A later workflow setup failure must roll back FNOL too.
            async with _session_factory() as session:
                assert not (await session.exec(select(Claim).where(Claim.tenant_id == fx["tenant_id"]))).all()
        finally:
            async with _session_factory() as cleanup:
                await _cleanup_all(cleanup, fx)
            await engine.dispose()
    asyncio.run(run())
