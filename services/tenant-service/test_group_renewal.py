"""Tests for Group Life Phase 5 — annual renewal (services/group_renewal.py).

Pure rating and period rules first, then the flow against a live, migrated Postgres:
experience from real claims, a census refresh that becomes endorsements, the re-quote,
the employer's decision, the payment that starts the next period, and the scheduler.

Run with: docker compose exec tenant-service python test_group_renewal.py
"""

import asyncio
import os
from datetime import date, timedelta
from uuid import UUID

from sqlmodel import delete, select

from database import _session_factory
from routers.group_renewals import (
    accept_renewal,
    census_refresh,
    decline_renewal,
    list_renewals,
    renewal_payment,
    renewal_quote,
    start_renewal,
)
from schemas import GroupQuoteDecision, RenewalCensusRefresh, RenewalPayment, RenewalStart
from services.group_renewal import (
    TARGET_LOSS_RATIO,
    credibility,
    elapsed_fraction,
    experience_factor,
    next_period,
    run_renewal_cycle,
)
from shared.models.core import (
    Claim,
    ClaimStatusEnum,
    Customer,
    GroupEndorsement,
    GroupMember,
    GroupQuote,
    GroupRenewal,
    MasterPolicy,
    Policy,
)
from test_group_census import _census, _cleanup, _cnic, _expect_http, _row, _setup
from test_group_endorsements import _active_scheme
from test_group_issuance import _FakeProducer, _fake_request

TODAY = date(2026, 10, 6)           # 86 days before the test schemes expire (2026-12-31)
NO_DECISION = GroupQuoteDecision(decided_by="CFO")


# ═══════════════════════════════════════════════════════════════════════════
# Pure rules
# ═══════════════════════════════════════════════════════════════════════════

def test_next_period_is_the_following_year():
    assert next_period(date(2026, 12, 31)) == (date(2027, 1, 1), date(2027, 12, 31))
    assert next_period(date(2027, 2, 27)) == (date(2027, 2, 28), date(2028, 2, 27))
    start, end = next_period(date(2026, 12, 31))
    assert (end - start).days + 1 == 365
    start, end = next_period(date(2027, 12, 31))                          # 2028 is a leap year
    assert (end - start).days + 1 == 366


def test_credibility_grows_with_size_and_caps():
    assert credibility(0) == 0 and credibility(250) == 1.0 and credibility(1000) == 1.0
    assert credibility(10) < credibility(50) < credibility(200) < 1.0
    assert abs(credibility(25) - 0.3162) < 1e-3


def test_experience_factor_moves_with_the_loss_ratio_in_proportion_to_credibility():
    big = experience_factor(TARGET_LOSS_RATIO, 250)
    assert big["factor"] == 1.0 and big["raw_factor"] == 1.0                              # exactly on target: no change
    assert experience_factor(0.30, 250)["factor"] == 0.85                                  # clean year: the full discount…
    assert experience_factor(5.0, 250)["factor"] == 1.5                                    # …and the cap on a terrible one
    small = experience_factor(5.0, 25)
    assert 1.0 < small["factor"] < 1.5 and abs(small["factor"] - (1 + credibility(25) * 0.5)) < 1e-4   # a small group barely moves
    assert experience_factor(0.0, 25)["factor"] < 1.0 and experience_factor(0.0, 25)["factor"] > 0.85
    assert experience_factor(1.0, 100, target=0)["factor"] == 1.0                          # no target configured: leave the rate alone


def test_a_year_is_never_judged_on_less_than_a_quarter_of_it():
    assert elapsed_fraction(date(2026, 1, 1), date(2026, 12, 31), date(2026, 1, 3)) == 0.25
    assert elapsed_fraction(date(2026, 1, 1), date(2026, 12, 31), date(2026, 12, 31)) == 1.0
    assert elapsed_fraction(date(2026, 1, 1), date(2026, 12, 31), date(2027, 6, 1)) == 1.0
    assert abs(elapsed_fraction(date(2026, 1, 1), date(2026, 12, 31), date(2026, 7, 2)) - 183 / 365) < 1e-3


# ═══════════════════════════════════════════════════════════════════════════
# Integration
# ═══════════════════════════════════════════════════════════════════════════

async def _cleanup_all(session, fx):
    await session.close()
    async with _session_factory() as s:
        for model in (Claim,):
            await s.exec(delete(model).where(model.tenant_id == fx["tenant_id"]))
        await s.commit()
    await _cleanup(session, fx["tenant_id"])


def _claim(fx, policy_id, amount, status, incident=date(2026, 5, 1)):
    return Claim(tenant_id=fx["tenant_id"], policy_id=policy_id, claim_type="Death Claim", submitted_amount=amount,
                 approved_amount=amount if status in (ClaimStatusEnum.APPROVED, ClaimStatusEnum.SETTLED) else 0.0,
                 settlement_amount=amount if status == ClaimStatusEnum.SETTLED else None, status=status, incident_date=incident)


async def _open(session, fx, mp_id, **kw):
    r = await start_renewal(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, body=RenewalStart(**kw), session=session)
    return r


async def _roster_rows(session, mp_id):
    """The employer's workforce list as a census file would carry it — rebuilt from the roster,
    because _census() draws fresh random CNICs every call."""
    from shared.models.core import GroupBenefitClass
    classes = {c.id: c.name for c in (await session.exec(select(GroupBenefitClass).where(GroupBenefitClass.master_policy_id == mp_id))).all()}
    rows = []
    for m, c in (await session.exec(select(GroupMember, Customer).join(Customer, Customer.id == GroupMember.customer_id)
                                    .where(GroupMember.master_policy_id == mp_id).order_by(GroupMember.created_at))).all():
        row = {"cnic": c.cnic, "name": c.name, "dob": c.dob.isoformat(), "gender": c.gender, "occupation": c.occupation,
               "declared_income": c.declared_income, "basic_monthly_salary": m.basic_monthly_salary}
        if m.grade:
            row["grade"] = m.grade
        if m.benefit_class_id:
            row["benefit_class"] = classes[m.benefit_class_id]
        if m.joining_date:
            row["joining_date"] = m.joining_date.isoformat()
        rows.append(row)
    return rows


def _kw(fx, mp_id, session, **extra):
    return dict(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, session=session, **extra)


async def test_experience_is_measured_from_the_periods_real_claims():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx)
            members = (await session.exec(select(GroupMember).where(GroupMember.master_policy_id == mp_id))).all()
            pol = lambda i: members[i].policy_id
            session.add_all([
                _claim(fx, pol(0), 400_000.0, ClaimStatusEnum.SETTLED),
                _claim(fx, pol(1), 300_000.0, ClaimStatusEnum.APPROVED),
                _claim(fx, pol(2), 250_000.0, ClaimStatusEnum.UNDER_INVESTIGATION),              # open: reserved at face
                _claim(fx, pol(3), 900_000.0, ClaimStatusEnum.DECLINED),                         # costs nothing
                _claim(fx, pol(4), 700_000.0, ClaimStatusEnum.SETTLED, incident=date(2025, 11, 1)),   # last year's: outside the period
            ])
            await session.commit()

            from services.group_renewal import compute_experience
            mp = await session.get(MasterPolicy, mp_id)
            x = await compute_experience(session, mp, TODAY)
            assert x["claims_incurred"] == 950_000.0 and x["claims_paid"] == 400_000.0 and x["open_reserve"] == 250_000.0 and x["claim_count"] == 3
            fraction = (TODAY - date(2026, 1, 1)).days + 1
            assert abs(x["elapsed_fraction"] - fraction / 365) < 1e-3
            assert abs(x["premium_earned"] - round(quote.risk_premium * x["elapsed_fraction"], 2)) < 0.02
            assert abs(x["claims_ratio"] - round(950_000 / x["premium_earned"], 4)) < 1e-3
            assert x["member_count"] == 10 and x["factor"] == experience_factor(x["claims_ratio"], 10)["factor"]
            print("PASS test_experience_is_measured_from_the_periods_real_claims")
        finally:
            await _cleanup_all(session, fx)


async def test_full_renewal_cycle():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx)
            mp = await session.get(MasterPolicy, mp_id)
            members = (await session.exec(select(GroupMember).where(GroupMember.master_policy_id == mp_id))).all()
            session.add(_claim(fx, members[0].policy_id, 3_000_000.0, ClaimStatusEnum.SETTLED))        # a bad year for a 10-person group
            await session.commit()

            # Too early (the window opens 120 days out): the test's "today" is real today, so move expiry out.
            far = mp.expiry_date
            mp.expiry_date = date(2027, 12, 31)
            session.add(mp)
            await session.commit()
            await _expect_http(_open(session, fx, mp_id), 409)
            mp.expiry_date = far
            session.add(mp)
            await session.commit()

            from services.group_renewal import open_renewal
            renewal = await open_renewal(session, await session.get(MasterPolicy, mp_id), today=TODAY)
            rid = renewal.id            # a rejected request rolls the session back and expires loaded rows
            assert renewal.status == "Open" and renewal.period_no == 1
            assert (renewal.new_period_start, renewal.new_period_end) == (date(2027, 1, 1), date(2027, 12, 31))
            assert renewal.experience_factor > 1.0 and renewal.experience["claims_incurred"] == 3_000_000.0
            await _expect_http(_open(session, fx, mp_id), 409)                                          # one per period

            # Census refresh: one raise, one joiner, one absentee (kept unless asked).
            census = await _roster_rows(session, mp_id)
            staff = next(r for r in census if r.get("benefit_class") == "Staff" and r["name"] != "Ali Individual")
            raised = dict(staff, basic_monthly_salary=250_000)
            joiner = _row(_cnic(), 500)
            rows = [raised if r["cnic"] == staff["cnic"] else r for r in census if r["name"] != "Ali Individual"] + [joiner]   # drops the reused individual
            preview = await census_refresh(body=RenewalCensusRefresh(employees=rows, preview=True, effective_date=date(2026, 10, 10)),
                                           renewal_id=rid, **_kw(fx, mp_id, session))
            assert preview["applied"] is False and (preview["added"], preview["changed"], preview["removed"]) == (1, 1, 0), preview
            assert preview["not_in_file"] == ["Ali Individual"] and (await session.exec(select(GroupEndorsement))).all() == []

            producer = _FakeProducer()
            done = await census_refresh(body=RenewalCensusRefresh(employees=rows, effective_date=date(2026, 10, 10)),
                                        renewal_id=rid, request=_fake_request(producer), **_kw(fx, mp_id, session))
            assert done["applied"] is True and len(done["endorsements"]) == 2 and done["removed"] == 0
            kinds = sorted(e.endorsement_type for e in (await session.exec(select(GroupEndorsement))).all())
            assert kinds == ["ADD", "CHANGE"] and producer.sent
            members_now = (await session.exec(select(GroupMember).where(GroupMember.master_policy_id == mp_id))).all()
            assert len([m for m in members_now if m.status == "Active"]) == 11

            # Re-quote: the next period, the loaded rate, a PDF; the scheme stays Active throughout.
            q = await renewal_quote(renewal_id=rid, **_kw(fx, mp_id, session))
            assert q.renewal_id == rid and q.version == 2 and q.status == "Open" and q.member_count == 11
            assert q.breakdown["experience_factor"] > 1.0 and q.breakdown["renewal"]["new_period_start"] == "2027-01-01"
            assert q.rate_per_mille > quote.rate_per_mille * 0.95 and os.path.exists((await session.get(GroupQuote, q.id)).document_path)
            assert (await session.get(MasterPolicy, mp_id)).status == "Active"
            assert (await session.get(GroupRenewal, rid)).status == "Quoted"

            # Declined → a revised quote is allowed; then accept.
            declined = await decline_renewal(body=NO_DECISION, renewal_id=rid, **_kw(fx, mp_id, session))
            assert declined.status == "Declined"
            q2 = await renewal_quote(renewal_id=rid, **_kw(fx, mp_id, session))
            assert q2.version == 3

            # Roster changes after quoting block acceptance until re-quoted.
            await census_refresh(body=RenewalCensusRefresh(employees=[_row(_cnic(), 501)] + rows, effective_date=date(2026, 10, 11)),
                                 renewal_id=rid, **_kw(fx, mp_id, session))
            await _expect_http(accept_renewal(body=NO_DECISION, renewal_id=rid, **_kw(fx, mp_id, session)), 409)     # back to Open: no open quote
            q3 = await renewal_quote(renewal_id=rid, **_kw(fx, mp_id, session))
            assert q3.member_count == 12
            q3_id, total, by_life = q3.id, q3.total_premium, dict(q3.breakdown["by_life"])       # (rollbacks expire loaded rows)
            accepted = await accept_renewal(body=NO_DECISION, renewal_id=rid, **_kw(fx, mp_id, session))
            assert accepted.status == "Accepted" and (await session.get(GroupQuote, q3_id)).status == "Accepted"

            # Payment starts the next period.
            await _expect_http(renewal_payment(body=RenewalPayment(reference="R-1", amount=total - 500), renewal_id=rid,
                                               **_kw(fx, mp_id, session)), 422)
            producer = _FakeProducer()
            paid = await renewal_payment(body=RenewalPayment(reference="RENEW-1", amount=total), renewal_id=rid,
                                         request=_fake_request(producer), **_kw(fx, mp_id, session))
            assert paid.status == "Renewed" and paid.payment_reference == "RENEW-1" and paid.completed_at

            session.expunge_all()
            mp = await session.get(MasterPolicy, mp_id)
            assert (mp.effective_date, mp.expiry_date, mp.status) == (date(2027, 1, 1), date(2027, 12, 31), "Active")
            assert mp.payment_reference == "RENEW-1" and os.path.exists(mp.schedule_document_path)
            active = [m for m in (await session.exec(select(GroupMember).where(GroupMember.master_policy_id == mp_id))).all() if m.status == "Active"]
            assert len(active) == 12 and all(m.cover_start_date == date(2027, 1, 1) and m.cover_end_date == date(2027, 12, 31) for m in active)
            assert all(abs(m.annual_premium - by_life[str(m.id)]) < 0.02 for m in active if not [] )
            policy = await session.get(Policy, active[0].policy_id)
            assert (policy.effective_date, policy.expiry_date, policy.status) == (date(2027, 1, 1), date(2027, 12, 31), "Active")
            events = [m for _t, m, _k in producer.sent]
            assert len(events) == 12 and {e["event_type"] for e in events} == {"GroupRenewed"} and all(e["payload"]["to_status"] == "Active" for e in events)

            # The next period isn't renewable yet, and the finished renewal can't be paid twice.
            await _expect_http(_open(session, fx, mp_id), 409)
            await _expect_http(renewal_payment(body=RenewalPayment(reference="R-2", amount=total), renewal_id=rid,
                                               **_kw(fx, mp_id, session)), 409)
            assert [r.status for r in await list_renewals(**_kw(fx, mp_id, session))] == ["Renewed"]
            print("PASS test_full_renewal_cycle")
        finally:
            await _cleanup_all(session, fx)


async def test_remove_missing_turns_absentees_into_leavers():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx)
            from services.group_renewal import open_renewal
            renewal = await open_renewal(session, await session.get(MasterPolicy, mp_id), today=TODAY)
            rid = renewal.id            # a rejected request rolls the session back and expires loaded rows
            rows = (await _roster_rows(session, mp_id))[:-2]
            out = await census_refresh(body=RenewalCensusRefresh(employees=rows, remove_missing=True, effective_date=date(2026, 10, 12)),
                                       renewal_id=rid, **_kw(fx, mp_id, session))
            assert out["removed"] == 2 and out["premium_delta"] < 0 and len(out["endorsements"]) == 1
            cancelled = [m for m in (await session.exec(select(GroupMember).where(GroupMember.master_policy_id == mp_id))).all() if m.status == "Removed"]
            assert len(cancelled) == 2
            assert all([(await session.get(Customer, m.customer_id)) is not None for m in cancelled])
            # An empty file is refused rather than read as "everyone left".
            await _expect_http(census_refresh(body=RenewalCensusRefresh(employees=[], remove_missing=True), renewal_id=rid,
                                              **_kw(fx, mp_id, session)), 422)
            print("PASS test_remove_missing_turns_absentees_into_leavers")
        finally:
            await _cleanup_all(session, fx)


async def test_scheduler_opens_renewals_once_and_lapses_the_forgotten():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx)
            tenant = fx["tenant_id"]
            assert (await run_renewal_cycle(_session_factory, today=date(2026, 8, 1), tenant_id=tenant)) == {"opened": [], "lapsed": []}   # 152 days out
            first = await run_renewal_cycle(_session_factory, today=date(2026, 11, 10), tenant_id=tenant)                                   # 51 days out
            assert len(first["opened"]) == 1 and first["lapsed"] == []
            assert (await run_renewal_cycle(_session_factory, today=date(2026, 11, 11), tenant_id=tenant))["opened"] == []              # not twice
            renewal = (await session.exec(select(GroupRenewal).where(GroupRenewal.master_policy_id == mp_id))).one()
            assert renewal.source == "Scheduler" and renewal.status == "Open"

            # Still unrenewed 45 days after the period ended (grace is 30): lapsed.
            late = await run_renewal_cycle(_session_factory, today=date(2027, 2, 15), tenant_id=tenant)
            assert late["lapsed"] == [first["opened"][0]]
            await session.refresh(renewal)
            assert renewal.status == "Lapsed" and renewal.completed_at
            print("PASS test_scheduler_opens_renewals_once_and_lapses_the_forgotten")
        finally:
            await _cleanup_all(session, fx)


async def test_http_flow():
    import httpx
    import main as app_module
    from routers.auth import oauth2_scheme

    async with _session_factory() as session:
        fx = await _setup(session)
        app_module.app.dependency_overrides[oauth2_scheme] = lambda: ""
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx)
            from services.group_renewal import open_renewal
            renewal = await open_renewal(session, await session.get(MasterPolicy, mp_id), today=TODAY)
            rid = renewal.id            # a rejected request rolls the session back and expires loaded rows
            base = f"/tenants/{fx['tenant_id']}/organizations/{fx['org_id']}/master-policies/{mp_id}/renewals"
            transport = httpx.ASGITransport(app=app_module.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
                assert (await c.get(base)).json()[0]["id"] == str(rid)
                r = await c.post(f"{base}/{rid}/quote")
                assert r.status_code == 201 and r.json()["renewal_id"] == str(rid), r.text
                doc = await c.get(f"{base}/{rid}/quote/document")
                assert doc.status_code == 200 and doc.headers["content-type"] == "application/pdf"
                detail = (await c.get(f"{base}/{rid}")).json()
                assert detail["status"] == "Quoted" and len(detail["quotes"]) == 1 and detail["experience"]["member_count"] == 10
                assert (await c.post(f"{base}/{rid}/accept", json={"decided_by": "CFO"})).json()["status"] == "Accepted"
                pay = await c.post(f"{base}/{rid}/payments", json={"reference": "HTTP-1", "amount": r.json()["total_premium"]})
                assert pay.status_code == 200 and pay.json()["status"] == "Renewed", pay.text
                again = await c.post(f"{base}/{rid}/payments", json={"reference": "HTTP-2", "amount": 1})
                assert again.status_code == 409
                run = await c.post(f"/tenants/{fx['tenant_id']}/group-renewals/run")
                assert run.status_code == 200 and set(run.json()) == {"opened", "lapsed"}
            print("PASS test_http_flow")
        finally:
            app_module.app.dependency_overrides.pop(oauth2_scheme, None)
            await _cleanup_all(session, fx)


async def main():
    for fn in (test_experience_is_measured_from_the_periods_real_claims, test_full_renewal_cycle,
               test_remove_missing_turns_absentees_into_leavers, test_scheduler_opens_renewals_once_and_lapses_the_forgotten,
               test_http_flow):
        await fn()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn) and not asyncio.iscoroutinefunction(fn):
            fn()
            print(f"PASS {name}")
    asyncio.run(main())
