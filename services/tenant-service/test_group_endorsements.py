"""Tests for Group Life Phase 4 — mid-term endorsements (services/group_endorsement_engine.py).

The arithmetic tests are pure. The rest run the router functions directly against a
live, migrated Postgres, like test_group_issuance.py (whose helpers they reuse), and
clean up after themselves. The risk engine is stubbed out: an above-limit addition
must open an underwriting case, never call a model.

Run with: docker compose exec tenant-service python test_group_endorsements.py
"""

import asyncio
import json
import os
from datetime import date
from uuid import UUID

from sqlmodel import select

import routers.organizations as organizations
from database import _session_factory
from group_pricing import life_premium
from routers.group_endorsements import (
    create as create_endorsement_endpoint,
    list_endorsements,
    preview as preview_endpoint,
    resolve as resolve_endpoint,
    settle as settle_endpoint,
)
from routers.group_policies import (
    accept_group_quote,
    generate_group_quote_endpoint,
    issue_master_policy,
    list_group_members,
    record_group_payment,
)
from schemas import EndorsementRequest, EndorsementSettle, GroupPaymentCreate, GroupQuoteDecision
from services.group_endorsement_engine import (
    EndorsementError,
    adjustment_totals,
    next_certificate_sequence,
    pro_rata,
)
from shared.events.kafka_events import POLICY_LIFECYCLE_TOPIC
from shared.models.core import (
    Case,
    CaseStatusEnum,
    Customer,
    GroupMember,
    GroupMemberDependent,
    MasterPolicy,
    Policy,
    PolicyStatusEnum,
)
from shared.pricing.calculator import STAMP_DUTY_RATE
from test_group_census import _add_classes, _census, _cleanup, _cnic, _enroll, _expect_http, _master_policy, _row, _setup
from test_group_issuance import _FakeProducer, _fake_request

NO_DECISION = GroupQuoteDecision(decided_by="HR Director")
EXPIRY = date(2026, 12, 31)          # test schemes run 2026-01-01 → 2026-12-31 (365 days)


# ═══════════════════════════════════════════════════════════════════════════
# Pure arithmetic
# ═══════════════════════════════════════════════════════════════════════════

def test_pro_rata_days_are_inclusive():
    start, expiry = date(2026, 1, 1), date(2026, 12, 31)
    assert pro_rata(date(2026, 1, 1), start, expiry) == (365, 365, 1.0)
    assert pro_rata(date(2026, 12, 31), start, expiry) == (1, 365, round(1 / 365, 6))
    days, period, factor = pro_rata(date(2026, 7, 1), start, expiry)
    assert (days, period) == (184, 365) and abs(factor - 184 / 365) < 1e-6
    assert pro_rata(date(2025, 6, 1), start, expiry)[2] == 1.0                      # before the period: the whole period
    try:
        pro_rata(date(2027, 1, 1), start, expiry)
    except ValueError as exc:
        assert "after the scheme expires" in str(exc)
    else:
        raise AssertionError("an effective date past expiry must be rejected")


def test_adjustment_totals_refunds_are_negative_and_takaful_splits():
    lines = [{"action": "ADD", "status": "Applied", "risk_delta": 1000.0, "before": {"cover": None}, "after": {"cover": 500_000}},
             {"action": "DELETE", "status": "Applied", "risk_delta": -400.0, "before": {"cover": 300_000}, "after": {"cover": 0}},
             {"action": "ADD", "status": "PendingUnderwriting", "risk_delta": 0.0, "before": {"cover": None}, "after": {"cover": 9_000_000}}]
    conv = adjustment_totals(lines, "Conventional", None)
    assert conv["risk_delta"] == 600.0 and conv["stamp_duty_delta"] == round(600 * STAMP_DUTY_RATE, 2)
    assert conv["premium_delta"] == round(600 + 600 * STAMP_DUTY_RATE, 2) and conv["wakala_fee_delta"] is None
    assert conv["member_count_delta"] == 0 and conv["sum_assured_delta"] == 200_000   # the pending line isn't counted
    refund = adjustment_totals([{"action": "DELETE", "status": "Applied", "risk_delta": -1000.0,
                                 "before": {"cover": 1}, "after": {"cover": 0}}], "Conventional", None)
    assert refund["premium_delta"] < 0 and refund["stamp_duty_delta"] < 0
    tk = adjustment_totals(lines, "Takaful", 30.0)
    assert tk["wakala_fee_delta"] == 180.0 and tk["ptf_delta"] == 420.0 and tk["wakala_fee_delta"] + tk["ptf_delta"] == tk["risk_delta"]


def test_certificate_numbers_are_never_reused():
    assert next_certificate_sequence("GL-2026-0001", []) == 1
    assert next_certificate_sequence("GL-2026-0001", ["GL-2026-0001/0001", "GL-2026-0001/0010", None, "OTHER/0099", "GL-2026-0001/x"]) == 11


# ═══════════════════════════════════════════════════════════════════════════
# Fixtures
# ═══════════════════════════════════════════════════════════════════════════

def _ids(fx, mp_id, session):
    return dict(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, session=session)


async def _active_scheme(session, fx, plan_code=None):
    """An in-force 10-member scheme: enrolled, quoted, accepted, issued and paid."""
    mp_id = await _master_policy(session, fx, plan_code=plan_code, fcl=1e9)
    await _add_classes(session, fx, mp_id)
    enrolled = await _enroll(session, fx, mp_id, _census(fx))
    ids = _ids(fx, mp_id, session)
    quote = await generate_group_quote_endpoint(**ids)
    await accept_group_quote(quote_id=quote.id, body=NO_DECISION, **ids)
    await issue_master_policy(**ids)
    await record_group_payment(body=GroupPaymentCreate(reference="PAY-0", amount=quote.total_premium), **ids)
    return mp_id, enrolled, quote, ids


def _req(kind, effective, members, **kw):
    return EndorsementRequest(endorsement_type=kind, effective_date=effective, members=members, **kw)


def _new_rows(n, **extra):
    return [_row(_cnic(), 100 + i, **extra) for i in range(n)]


async def _unlimited_fcl(session, mp_id, fcl):
    mp = await session.get(MasterPolicy, mp_id)
    mp.free_cover_limit = fcl
    session.add(mp)
    await session.commit()


class _NoRiskEngine:
    """Stand-in for the risk engine: unreachable, so the new member's case just stays New."""

    def __enter__(self):
        self.original = organizations.evaluate_group_member

        async def _none(*a, **k):
            return None
        organizations.evaluate_group_member = _none

    def __exit__(self, *exc):
        organizations.evaluate_group_member = self.original


# ═══════════════════════════════════════════════════════════════════════════
# Integration
# ═══════════════════════════════════════════════════════════════════════════

async def test_add_members_prices_pro_rata_and_issues_certificates():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx)
            rows = _new_rows(2)
            effective = date(2026, 7, 1)

            # Preview writes nothing.
            before = len((await list_group_members(**ids)))
            preview = await preview_endpoint(body=_req("ADD", effective, rows), **ids)
            assert preview["days_remaining"] == 184 and len(preview["lines"]) == 2
            assert len((await list_group_members(**ids))) == before
            assert (await list_endorsements(**ids)) == []

            producer = _FakeProducer()
            e = await create_endorsement_endpoint(body=_req("ADD", effective, rows, reason="Two joiners"),
                                                  request=_fake_request(producer), **ids)
            assert e.number.endswith("-001") and e.status == "Applied" and e.settlement_status == "Due"
            factor = 184 / 365
            staff_cover = {l["name"]: l["after"]["cover"] for l in e.lines}
            expected_risk = sum(round(life_premium(c, quote.rate_per_mille) * factor, 2) for c in staff_cover.values())
            assert abs(e.risk_delta - expected_risk) < 0.05 and e.premium_delta > e.risk_delta > 0
            assert e.stamp_duty_delta == round(e.risk_delta * STAMP_DUTY_RATE, 2)
            assert e.member_count_delta == 2 and e.sum_assured_delta == sum(staff_cover.values())

            session.expunge_all()
            roster = await list_group_members(**ids)
            assert len(roster) == before + 2
            new = [m for m in roster if m.name in staff_cover]
            assert sorted(m.certificate_number[-4:] for m in new) == ["0011", "0012"]       # continues the numbering
            assert all(m.certificate_status == "Active" and m.status == "Active" for m in new)
            member = await session.get(GroupMember, new[0].id)
            assert member.cover_start_date == effective and member.cover_end_date == EXPIRY and member.annual_premium > 0
            policy = await session.get(Policy, member.policy_id)
            assert policy.effective_date == effective and policy.expiry_date == EXPIRY and policy.policy_number == new[0].certificate_number
            assert os.path.exists(e.document_path)

            events = [m for _t, m, _k in producer.sent]
            assert {x["event_type"] for x in events} == {"GroupEndorsementAdd"}
            assert {x["payload"]["to_status"] for x in events} >= {"Active"}
            assert all(x["payload"]["detail"]["endorsement"] == e.number for x in events)

            # Duplicate of an enrolled employee is refused, nothing written.
            await _expect_http(create_endorsement_endpoint(body=_req("ADD", effective, rows), **ids), 422)
            assert len(await list_group_members(**ids)) == before + 2
            print("PASS test_add_members_prices_pro_rata_and_issues_certificates")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_delete_members_cancels_certificates_and_refunds():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx)
            leaver = next(o for o in enrolled.employees if o.benefit_class == "Staff" and not o.reused_existing_customer)
            member = await session.get(GroupMember, leaver.group_member_id)
            annual = member.annual_premium
            session.add(GroupMemberDependent(tenant_id=fx["tenant_id"], group_member_id=member.id, name="Child", relationship="Child",
                                             dob=date(2018, 1, 1), covered_amount=100_000, status="Active"))
            await session.commit()

            e = await create_endorsement_endpoint(
                body=_req("DELETE", date(2026, 10, 1), [{"member_id": str(member.id), "reason": "Resigned"}]), **ids)
            factor = (EXPIRY - date(2026, 10, 1)).days + 1
            assert e.risk_delta == round(-annual * factor / 365, 2) and e.premium_delta < 0
            assert e.member_count_delta == -1 and e.settlement_status == "Due"

            session.expunge_all()
            member = await session.get(GroupMember, leaver.group_member_id)
            assert member.status == "Removed" and member.cover_end_date == date(2026, 10, 1)
            assert (await session.get(Policy, member.policy_id)).status == PolicyStatusEnum.CANCELLED.value
            assert all(d.status == "Removed" for d in (await session.exec(
                select(GroupMemberDependent).where(GroupMemberDependent.group_member_id == member.id))).all())
            customer = await session.get(Customer, member.customer_id)
            assert customer is not None                                    # the person's record is never deleted

            # The number is retired, not reused.
            add = await create_endorsement_endpoint(body=_req("ADD", date(2026, 10, 2), _new_rows(1)), **ids)
            assert add.lines[0]["certificate_number"].endswith("/0011")
            # A removed member can't be removed twice.
            await _expect_http(create_endorsement_endpoint(
                body=_req("DELETE", date(2026, 10, 5), [{"member_id": str(member.id)}]), **ids), 409)
            await _expect_http(create_endorsement_endpoint(
                body=_req("DELETE", date(2026, 10, 5), [{"cnic": "00000-0000000-0"}]), **ids), 404)
            print("PASS test_delete_members_cancels_certificates_and_refunds")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_cannot_remove_everyone():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx)
            everyone = [{"member_id": str(o.group_member_id)} for o in enrolled.employees]
            await _expect_http(create_endorsement_endpoint(body=_req("DELETE", date(2026, 8, 1), everyone), **ids), 409)
            assert (await list_endorsements(**ids)) == []
            print("PASS test_cannot_remove_everyone")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_change_reprices_cover_and_keeps_class_unless_grade_moves():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx)
            staff = next(o for o in enrolled.employees if o.benefit_class == "Staff" and not o.reused_existing_customer)
            member = await session.get(GroupMember, staff.group_member_id)
            old_cover, old_salary = member.coverage_amount, member.basic_monthly_salary

            # Staff is SalaryMultiple (24x, capped 5M): a raise changes cover.
            e = await create_endorsement_endpoint(
                body=_req("CHANGE", date(2026, 7, 1), [{"member_id": str(member.id), "basic_monthly_salary": old_salary * 1.5}]), **ids)
            line = e.lines[0]
            assert line["status"] == "Applied" and line["after"]["cover"] > old_cover and line["after"]["class"] == "Staff"
            assert e.risk_delta > 0
            session.expunge_all()
            member = await session.get(GroupMember, staff.group_member_id)
            assert member.coverage_amount == line["after"]["cover"] and member.basic_monthly_salary == old_salary * 1.5
            assert (await session.get(Policy, member.policy_id)).coverage_amount == member.coverage_amount

            # A grade that belongs to the Management class moves them there (flat 10M).
            moved = await create_endorsement_endpoint(
                body=_req("CHANGE", date(2026, 7, 1), [{"member_id": str(member.id), "grade": "M1", "designation": "Head of Ops"}]), **ids)
            assert moved.lines[0]["after"]["class"] == "Management" and moved.lines[0]["after"]["cover"] == 10_000_000
            session.expunge_all()
            member = await session.get(GroupMember, staff.group_member_id)
            assert member.grade == "M1" and member.designation == "Head of Ops" and member.coverage_amount == 10_000_000

            # No fields, or a no-op, are rejected / free. (A rejected request rolls the session back,
            # which expires loaded rows — so keep the id.)
            mid = str(member.id)
            await _expect_http(create_endorsement_endpoint(
                body=_req("CHANGE", date(2026, 7, 1), [{"member_id": mid}]), **ids), 422)
            same = await create_endorsement_endpoint(
                body=_req("CHANGE", date(2026, 7, 1), [{"member_id": mid, "designation": "Head of Ops"}]), **ids)
            assert same.premium_delta == 0 and same.settlement_status == "NotDue"
            print("PASS test_change_reprices_cover_and_keeps_class_unless_grade_moves")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_above_limit_addition_waits_for_underwriting_then_resolves():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx)
            await _unlimited_fcl(session, mp_id, 1_000_000)               # the existing 10 are all fine: they were enrolled earlier
            # Two Management hires at 10M (above the 1M limit) and one on the 1M service band (guaranteed).
            rows = [_row(_cnic(), 200, grade="M1"), _row(_cnic(), 201, grade="M1"),
                    _row(_cnic(), 202, benefit_class="Tenure", joining_date="2025-06-01")]
            with _NoRiskEngine():
                e = await create_endorsement_endpoint(body=_req("ADD", date(2026, 8, 1), rows), **ids)
            statuses = sorted(l["status"] for l in e.lines)
            assert statuses == ["Applied", "PendingUnderwriting", "PendingUnderwriting"] and e.status == "PendingUnderwriting"
            assert e.member_count_delta == 1 and e.risk_delta > 0              # the guaranteed hire is already live and charged
            risk_before = e.risk_delta                                          # (the ORM row is shared, so keep the number)
            pending = [l for l in e.lines if l["status"] == "PendingUnderwriting"]
            assert all(l["certificate_number"] is None and l["risk_delta"] == 0 for l in pending)

            # Nothing decided yet: resolving changes nothing.
            again = await resolve_endpoint(endorsement_id=e.id, **ids)
            assert again.status == "PendingUnderwriting" and again.risk_delta == risk_before

            # Underwriters rule: first approved with loading, second declined (→ restricted to the FCL).
            first, second = pending[0], pending[1]
            m1, m2 = await session.get(GroupMember, UUID(first["member_id"])), await session.get(GroupMember, UUID(second["member_id"]))
            p1, p2 = await session.get(Policy, m1.policy_id), await session.get(Policy, m2.policy_id)
            p1.status, p2.status = PolicyStatusEnum.APPROVED.value, PolicyStatusEnum.DECLINED.value
            session.add_all([p1, p2])
            await session.commit()

            done = await resolve_endpoint(endorsement_id=e.id, request=_fake_request(_FakeProducer()), **ids)
            assert done.status == "Applied" and all(l["status"] == "Applied" for l in done.lines)
            by_name = {l["name"]: l for l in done.lines}
            assert by_name[first["name"]]["after"]["cover"] == 10_000_000
            assert by_name[second["name"]]["after"]["cover"] == 1_000_000            # restricted to the Free Cover Limit
            assert done.risk_delta > risk_before and done.settlement_status == "Due"
            session.expunge_all()
            roster = {m.name: m for m in await list_group_members(**ids)}
            assert roster[first["name"]].certificate_status == "Active" and roster[second["name"]].coverage_amount == 1_000_000
            print("PASS test_above_limit_addition_waits_for_underwriting_then_resolves")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_above_limit_change_needs_an_approved_case():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx)
            await _unlimited_fcl(session, mp_id, 1_000_000)
            staff = next(o for o in enrolled.employees if o.benefit_class == "Staff" and not o.reused_existing_customer)
            member = await session.get(GroupMember, staff.group_member_id)
            old_cover = member.coverage_amount
            e = await create_endorsement_endpoint(
                body=_req("CHANGE", date(2026, 8, 1), [{"member_id": str(member.id), "grade": "M1"}]), **ids)    # → 10M, above the FCL
            line = e.lines[0]
            assert line["status"] == "PendingUnderwriting" and line["case_id"] and e.risk_delta == 0
            session.expunge_all()
            assert (await session.get(GroupMember, staff.group_member_id)).coverage_amount == old_cover       # unchanged until decided

            case = await session.get(Case, UUID(line["case_id"]))
            case.caseStatus = CaseStatusEnum.APPROVED
            session.add(case)
            await session.commit()
            done = await resolve_endpoint(endorsement_id=e.id, **ids)
            assert done.status == "Applied" and done.lines[0]["status"] == "Applied" and done.risk_delta > 0
            session.expunge_all()
            assert (await session.get(GroupMember, staff.group_member_id)).coverage_amount == 10_000_000

            # A rejected case leaves cover alone.
            other = next(o for o in enrolled.employees if o.benefit_class == "Staff" and o.group_member_id != staff.group_member_id
                         and not o.reused_existing_customer)
            e2 = await create_endorsement_endpoint(
                body=_req("CHANGE", date(2026, 8, 1), [{"member_id": str(other.group_member_id), "grade": "M1"}]), **ids)
            case2 = await session.get(Case, UUID(e2.lines[0]["case_id"]))
            case2.caseStatus = CaseStatusEnum.REJECTED
            session.add(case2)
            await session.commit()
            declined = await resolve_endpoint(endorsement_id=e2.id, **ids)
            assert declined.lines[0]["status"] == "Declined" and declined.status == "Applied" and declined.risk_delta == 0
            print("PASS test_above_limit_change_needs_an_approved_case")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_settlement_takaful_split_and_guards():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx, plan_code="GROUP_FAMILY_TAKAFUL")
            assert quote.wakala_fee_pct == 30.0
            e = await create_endorsement_endpoint(body=_req("ADD", date(2026, 6, 1), _new_rows(1)), **ids)
            assert e.wakala_fee_delta == round(e.risk_delta * 0.30, 2) and abs(e.wakala_fee_delta + e.ptf_delta - e.risk_delta) < 0.011

            await _expect_http(settle_endpoint(endorsement_id=e.id, body=EndorsementSettle(reference="X", amount=1.0), **ids), 422)
            settled = await settle_endpoint(endorsement_id=e.id, body=EndorsementSettle(reference="IBFT-1", amount=e.premium_delta), **ids)
            assert settled.settlement_status == "Settled" and settled.settlement_reference == "IBFT-1"
            await _expect_http(settle_endpoint(endorsement_id=e.id, body=EndorsementSettle(reference="X", amount=e.premium_delta), **ids), 409)

            # Bad requests.
            await _expect_http(create_endorsement_endpoint(body=_req("ADD", date(2027, 3, 1), _new_rows(1)), **ids), 422)   # past expiry
            await _expect_http(create_endorsement_endpoint(body=_req("MOVE", date(2026, 6, 1), _new_rows(1)), **ids), 422)
            await _expect_http(create_endorsement_endpoint(body=_req("ADD", date(2026, 6, 1), []), **ids), 422)
            print("PASS test_settlement_takaful_split_and_guards")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_only_an_active_scheme_can_be_endorsed():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _master_policy(session, fx, fcl=1e9)
            await _add_classes(session, fx, mp_id)
            await _enroll(session, fx, mp_id, _census(fx))
            ids = _ids(fx, mp_id, session)
            await _expect_http(create_endorsement_endpoint(body=_req("ADD", date(2026, 6, 1), _new_rows(1)), **ids), 409)
            await _expect_http(preview_endpoint(body=_req("ADD", date(2026, 6, 1), _new_rows(1)), **ids), 409)
            print("PASS test_only_an_active_scheme_can_be_endorsed")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_http_flow():
    import httpx
    import main as app_module
    from routers.auth import oauth2_scheme

    async with _session_factory() as session:
        fx = await _setup(session)
        app_module.app.dependency_overrides[oauth2_scheme] = lambda: ""
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx)
            base = f"/tenants/{fx['tenant_id']}/organizations/{fx['org_id']}/master-policies/{mp_id}/endorsements"
            transport = httpx.ASGITransport(app=app_module.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
                body = {"endorsement_type": "ADD", "effective_date": "2026-09-01", "reason": "joiner",
                        "members": [_row(_cnic(), 300)]}
                r = await c.post(base + "/preview", json=body)
                assert r.status_code == 200 and r.json()["lines"][0]["status"] == "Applied", r.text
                r = await c.post(base, json=body)
                assert r.status_code == 201, r.text
                eid = r.json()["id"]
                assert (await c.get(base)).json()[0]["id"] == eid
                assert (await c.get(f"{base}/{eid}")).status_code == 200
                doc = await c.get(f"{base}/{eid}/document")
                assert doc.status_code == 200 and doc.headers["content-type"] == "application/pdf"
                r = await c.post(f"{base}/{eid}/settle", json={"reference": "BANK-9", "amount": r.json()["premium_delta"]})
                assert r.status_code == 200 and r.json()["settlement_status"] == "Settled", r.text
                r = await c.post(base, json={**body, "members": [{"cnic": "bad"}]})
                assert r.status_code == 422                                # validation detail comes back structured
                assert "missing_fields" in json.dumps(r.json()["detail"]) or "errors" in json.dumps(r.json()["detail"])
            print("PASS test_http_flow")
        finally:
            app_module.app.dependency_overrides.pop(oauth2_scheme, None)
            await _cleanup(session, fx["tenant_id"])


async def main():
    for fn in (test_add_members_prices_pro_rata_and_issues_certificates, test_delete_members_cancels_certificates_and_refunds,
               test_cannot_remove_everyone, test_change_reprices_cover_and_keeps_class_unless_grade_moves,
               test_above_limit_addition_waits_for_underwriting_then_resolves, test_above_limit_change_needs_an_approved_case,
               test_settlement_takaful_split_and_guards, test_only_an_active_scheme_can_be_endorsed, test_http_flow):
        await fn()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn) and not asyncio.iscoroutinefunction(fn):
            fn()
            print(f"PASS {name}")
    asyncio.run(main())
