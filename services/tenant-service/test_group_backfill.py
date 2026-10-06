"""Integration tests for group_backfill.py — numbering and quoting master
policies that were marked Active before group issuance existed.

Same conventions as test_group_issuance.py: functions called directly against a
live, migrated Postgres; scoped to the test's own tenant; self-cleaning.

Run with: docker compose exec tenant-service python test_group_backfill.py
"""

import asyncio
from datetime import date

from sqlmodel import select

from database import _session_factory
from group_backfill import LEGACY_DECIDER, backfill_legacy_master_policies
from routers.group_policies import list_group_quotes
from shared.models.core import (
    GroupMember,
    GroupMemberStatus,
    GroupQuote,
    MasterPolicy,
    Policy,
    PolicyStatusEnum,
)
from test_group_census import _add_classes, _census, _cleanup, _enroll, _master_policy, _setup


async def _legacy_scheme(session, fx, plan_code=None, fcl=1e9):
    """An enrolled scheme forced into the shape the old census-only flow left it
    in: master policy and certificates Active, nothing numbered, no quote."""
    mp_id = await _master_policy(session, fx, plan_code=plan_code, fcl=fcl)
    await _add_classes(session, fx, mp_id)
    await _enroll(session, fx, mp_id, _census(fx))
    mp = await session.get(MasterPolicy, mp_id)
    mp.status = "Active"
    session.add(mp)
    for member in (await session.exec(select(GroupMember).where(GroupMember.master_policy_id == mp_id))).all():
        member.status = GroupMemberStatus.ACTIVE.value
        session.add(member)
        policy = await session.get(Policy, member.policy_id)
        policy.status = PolicyStatusEnum.ACTIVE.value
        policy.policy_number = None
        session.add(policy)
    await session.commit()
    return mp_id


async def test_dry_run_writes_nothing():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _legacy_scheme(session, fx)
            report = await backfill_legacy_master_policies(session, apply=False, tenant_id=fx["tenant_id"])
            assert [r["action"] for r in report] == ["would backfill"] and report[0]["quote_created"]
            await session.refresh(await session.get(MasterPolicy, mp_id))
            assert (await session.get(MasterPolicy, mp_id)).policy_number is None
            assert not (await session.exec(select(GroupQuote).where(GroupQuote.master_policy_id == mp_id))).all()
            print("PASS test_dry_run_writes_nothing")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_apply_numbers_and_quotes_then_is_idempotent():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _legacy_scheme(session, fx)
            report = await backfill_legacy_master_policies(session, apply=True, tenant_id=fx["tenant_id"])
            assert [r["action"] for r in report] == ["backfilled"]

            mp = await session.get(MasterPolicy, mp_id)
            assert mp.policy_number.startswith(f"GL-{date.today().year}-")
            assert mp.expiry_date == date(2026, 12, 31) and mp.status == "Active"   # status untouched
            members = (await session.exec(select(GroupMember).where(GroupMember.master_policy_id == mp_id))).all()
            certs = [(await session.get(Policy, m.policy_id)).policy_number for m in members]
            assert len(set(certs)) == len(certs) == 10 and all(c.startswith(mp.policy_number + "/") for c in certs)
            assert all(m.annual_premium and m.annual_premium > 0 for m in members)

            quotes = (await session.exec(select(GroupQuote).where(GroupQuote.master_policy_id == mp_id))).all()
            assert len(quotes) == 1
            q = quotes[0]
            assert (q.status, q.version, q.decided_by) == ("Accepted", 1, LEGACY_DECIDER)
            assert q.breakdown["legacy_backfill"] and q.wakala_fee_pct is None
            # Member shares add up to the contribution being charged.
            assert abs(sum(m.annual_premium for m in members) - q.risk_premium) < 0.05
            assert len(q.breakdown["covered"]) == 10

            # Readable by the issuance-era endpoints now.
            listed = await list_group_quotes(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, session=session)
            assert [x.status for x in listed] == ["Accepted"]

            again = await backfill_legacy_master_policies(session, apply=True, tenant_id=fx["tenant_id"])
            assert again == []                                              # numbered schemes are left alone
            assert len((await session.exec(select(GroupQuote).where(GroupQuote.master_policy_id == mp_id))).all()) == 1
            print("PASS test_apply_numbers_and_quotes_then_is_idempotent")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_takaful_scheme_gets_gt_number_and_split():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _legacy_scheme(session, fx, plan_code="GROUP_FAMILY_TAKAFUL")
            await backfill_legacy_master_policies(session, apply=True, tenant_id=fx["tenant_id"])
            mp = await session.get(MasterPolicy, mp_id)
            assert mp.policy_number.startswith(f"GT-{date.today().year}-")
            q = (await session.exec(select(GroupQuote).where(GroupQuote.master_policy_id == mp_id))).one()
            assert q.business_type == "Takaful" and q.wakala_fee_pct == 30.0
            assert abs(q.wakala_fee + q.ptf_allocation - q.risk_premium) < 0.01
            print("PASS test_takaful_scheme_gets_gt_number_and_split")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_existing_numbers_kept_and_unpriceable_scheme_skipped():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _legacy_scheme(session, fx)
            members = (await session.exec(select(GroupMember).where(GroupMember.master_policy_id == mp_id))).all()
            keep = await session.get(Policy, members[0].policy_id)
            keep.policy_number = "LEGACY-0001"
            session.add(keep)
            await session.commit()
            await backfill_legacy_master_policies(session, apply=True, tenant_id=fx["tenant_id"])
            assert (await session.get(Policy, members[0].policy_id)).policy_number == "LEGACY-0001"

            # A scheme with an above-FCL member who never got a decision can't be priced.
            stuck_id = await _legacy_scheme(session, fx)
            stuck = await session.get(MasterPolicy, stuck_id)
            stuck.free_cover_limit = 1_000_000          # lowered after enrolment so no risk-engine call is made
            session.add(stuck)
            for m in (await session.exec(select(GroupMember).where(GroupMember.master_policy_id == stuck_id))).all():
                (p := await session.get(Policy, m.policy_id)).status = PolicyStatusEnum.QUOTED.value
                session.add(p)
            await session.commit()
            report = await backfill_legacy_master_policies(session, apply=True, tenant_id=fx["tenant_id"])
            assert [r["action"] for r in report] == ["skipped"] and "underwriting decision" in report[0]["reason"]
            assert (await session.get(MasterPolicy, stuck_id)).policy_number is None
            print("PASS test_existing_numbers_kept_and_unpriceable_scheme_skipped")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_empty_roster_is_numbered_without_a_quote():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _master_policy(session, fx)
            mp = await session.get(MasterPolicy, mp_id)
            mp.status = "Active"
            session.add(mp)
            await session.commit()
            report = await backfill_legacy_master_policies(session, apply=True, tenant_id=fx["tenant_id"])
            assert report[0]["action"] == "backfilled" and report[0]["quote_created"] is False
            assert (await session.get(MasterPolicy, mp_id)).policy_number
            assert not (await session.exec(select(GroupQuote).where(GroupQuote.master_policy_id == mp_id))).all()
            print("PASS test_empty_roster_is_numbered_without_a_quote")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_numbers_are_sequential_within_a_tenant():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            ids = [await _legacy_scheme(session, fx) for _ in range(2)]
            await backfill_legacy_master_policies(session, apply=True, tenant_id=fx["tenant_id"])
            numbers = sorted([(await session.get(MasterPolicy, i)).policy_number for i in ids])
            prefix = f"GL-{date.today().year}-"
            assert numbers == [f"{prefix}0001", f"{prefix}0002"], numbers
            print("PASS test_numbers_are_sequential_within_a_tenant")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def main():
    await test_dry_run_writes_nothing()
    await test_apply_numbers_and_quotes_then_is_idempotent()
    await test_takaful_scheme_gets_gt_number_and_split()
    await test_existing_numbers_kept_and_unpriceable_scheme_skipped()
    await test_empty_roster_is_numbered_without_a_quote()
    await test_numbers_are_sequential_within_a_tenant()


if __name__ == "__main__":
    asyncio.run(main())
