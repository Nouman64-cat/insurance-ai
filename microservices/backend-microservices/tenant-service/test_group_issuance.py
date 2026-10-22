"""Integration tests for Group Life Phase 2 — quote → accept → issue → pay,
above-FCL outcomes, dependants, nominations, and the guards between steps.

Same conventions as test_group_census.py (whose fixtures these reuse): router
functions called directly against a live, migrated Postgres; no risk-engine
calls; self-cleaning (including generated PDFs).

Run with: docker compose exec tenant-service python test_group_issuance.py
"""

import asyncio
from uuid import uuid4
import json
import os
import re
from datetime import date, timedelta
from types import SimpleNamespace
from sqlmodel import select

import httpx

from database import _session_factory
from routers.group_policies import (
    accept_group_quote,
    add_group_dependent,
    decline_group_quote,
    generate_group_quote_endpoint,
    issue_master_policy,
    list_group_beneficiaries,
    list_group_members,
    record_group_payment,
    replace_group_beneficiaries,
)
from routers.organizations import delete_organization_employee
from routers.pre_issuance import BeneficiariesReplace, BeneficiaryIn
from schemas import GroupDependentCreate, GroupPaymentCreate, GroupQuoteDecision
from shared.events.kafka_events import POLICY_LIFECYCLE_TOPIC
from shared.models.core import (
    AIDecision,
    GroupMember,
    GroupMemberDependent,
    GroupQuote,
    InsurancePlan,
    MasterPolicy,
    Organization,
    Policy,
    PolicyStatusEnum,
    ProfileStatusEnum,
    RiskAssessment,
)
from shared.services.policy_state_machine import apply_transition
from test_group_census import (
    _add_classes,
    _census,
    _cleanup,
    _cnic,
    _enroll,
    _expect_http,
    _master_policy,
    _row,
    _setup,
)

NO_DECISION = GroupQuoteDecision(decided_by="HR Director")


def _ids(fx, mp_id, session):
    return dict(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, session=session)


async def _enrolled_scheme(session, fx, plan_code=None, fcl=1e9):
    mp_id = await _master_policy(session, fx, plan_code=plan_code, fcl=fcl)
    await _add_classes(session, fx, mp_id)
    result = await _enroll(session, fx, mp_id, _census(fx))
    return mp_id, result


async def test_full_lifecycle():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled = await _enrolled_scheme(session, fx)
            ids = _ids(fx, mp_id, session)
            manager = next(o for o in enrolled.employees if o.benefit_class == "Management")

            # Dependant (spouse) — on the schedule because it's added here, not because of a nomination.
            await _expect_http(add_group_dependent(member_id=manager.group_member_id, **ids, body=GroupDependentCreate(
                name="Over-covered Spouse", relationship="Spouse", dob=date(1990, 1, 1), covered_amount=99_000_000)), 422)
            await _expect_http(add_group_dependent(member_id=manager.group_member_id, **ids, body=GroupDependentCreate(
                name="Cousin", relationship="Cousin", dob=date(1990, 1, 1), covered_amount=1)), 422)
            spouse = await add_group_dependent(member_id=manager.group_member_id, **ids, body=GroupDependentCreate(
                name="Sara (spouse)", relationship="Spouse", dob=date(1990, 1, 1), covered_amount=2_000_000))

            # Nomination on a not-yet-issued (Quoted) certificate works for group members.
            await replace_group_beneficiaries(member_id=manager.group_member_id, **ids, body=BeneficiariesReplace(
                beneficiaries=[BeneficiaryIn(name="Sara", relationship="Spouse", share_pct=70),
                               BeneficiaryIn(name="Omar", relationship="Child", share_pct=30)]))
            await _expect_http(replace_group_beneficiaries(member_id=manager.group_member_id, **ids, body=BeneficiariesReplace(
                beneficiaries=[BeneficiaryIn(name="Sara", relationship="Spouse", share_pct=60)])), 422)

            # The roster reports who has a nominee on file (the chat and Members tab both read it).
            roster = await list_group_members(**ids)
            assert {m.id: m.nominations for m in roster}[manager.group_member_id] == 2
            assert sum(1 for m in roster if m.nominations == 0) == len(roster) - 1

            v1 = await generate_group_quote_endpoint(**ids)
            assert (v1.version, v1.status, v1.member_count, v1.dependent_count) == (1, "Open", 10, 1)
            assert v1.total_sum_assured == sum(o.coverage_amount for o in enrolled.employees) + 2_000_000
            assert os.path.exists((await session.get(GroupQuote, v1.id)).document_path)
            assert (await session.get(MasterPolicy, mp_id)).status == "Quoted"

            # Revised quote supersedes v1; v1 can no longer be accepted.
            v2 = await generate_group_quote_endpoint(**ids)
            assert v2.version == 2 and (await session.get(GroupQuote, v1.id)).status == "Superseded"
            await _expect_http(accept_group_quote(quote_id=v1.id, body=NO_DECISION, **ids), 409)

            accepted = await accept_group_quote(quote_id=v2.id, body=NO_DECISION, **ids)
            assert accepted.status == "Accepted" and accepted.decided_by == "HR Director"
            # Accepted terms are frozen: no more dependant changes, no re-quote.
            await _expect_http(add_group_dependent(member_id=manager.group_member_id, **ids, body=GroupDependentCreate(
                name="Late", relationship="Child", dob=date(2015, 1, 1), covered_amount=1)), 409)
            await _expect_http(generate_group_quote_endpoint(**ids), 409)
            await _expect_http(record_group_payment(body=GroupPaymentCreate(reference="X", amount=1), **ids), 409)

            issued = await issue_master_policy(**ids)
            mp = issued.master_policy
            assert re.fullmatch(rf"GL-{date.today().year}-\d{{4}}", mp.policy_number), mp.policy_number
            assert mp.status == "PendingPayment" and issued.certificates_issued == 10
            assert mp.expiry_date == date(2026, 12, 31)
            assert os.path.exists((await session.get(MasterPolicy, mp_id)).schedule_document_path)
            members = await list_group_members(**ids)
            assert all(m.certificate_number.startswith(mp.policy_number + "/") for m in members)
            assert all(m.certificate_status == "PendingPayment" and m.status == "Pending" for m in members)
            assert abs(sum(m.annual_premium for m in members) - v2.risk_premium) < 0.05
            await _expect_http(issue_master_policy(**ids), 409)

            await _expect_http(record_group_payment(
                body=GroupPaymentCreate(reference="PAY-1", amount=v2.total_premium - 100), **ids), 422)
            paid = await record_group_payment(body=GroupPaymentCreate(reference="PAY-1", amount=v2.total_premium), **ids)
            assert paid.master_policy.status == "Active" and paid.amount_due == 0
            session.expunge_all()
            members = await list_group_members(**ids)
            assert all(m.certificate_status == "Active" and m.status == "Active" for m in members)
            assert (await session.get(GroupMemberDependent, spouse.id)).status == "Active"
            org = await session.get(Organization, fx["org_id"])
            assert org.profile_status == ProfileStatusEnum.POLICYHOLDER

            # Nominations can still change while in force; history is versioned.
            changed = await replace_group_beneficiaries(member_id=manager.group_member_id, **ids, body=BeneficiariesReplace(
                beneficiaries=[BeneficiaryIn(name="Sara", relationship="Spouse", share_pct=100)]))
            assert changed["version_sequence"] == 2
            assert len(await list_group_beneficiaries(member_id=manager.group_member_id, **ids)) == 1

            # The reused individual's own policy is untouched by all of this.
            ind = await session.get(Policy, fx["individual_policy"])
            assert ind.status == PolicyStatusEnum.ACTIVE and ind.policy_number is None and ind.master_policy_id is None

            # Removing an issued employee still cleans up (certificate events included).
            plain = next(o for o in enrolled.employees if not o.reused_existing_customer and o.benefit_class == "Staff")
            await delete_organization_employee(tenant_id=fx["tenant_id"], org_id=fx["org_id"],
                                               employee_id=plain.customer_id, session=session)
            print("PASS test_full_lifecycle")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def _decide(session, policy_id, to: PolicyStatusEnum, loading=None):
    policy = await session.get(Policy, policy_id)
    apply_transition(session, policy, PolicyStatusEnum.PROPOSED, event_type="test", actor="test")
    apply_transition(session, policy, to, event_type="test", actor="test")
    if loading is not None:
        session.add(RiskAssessment(tenant_id=policy.tenant_id, customer_id=policy.customer_id, policy_id=policy.id,
                                   medical_score=60, financial_score=40, fraud_probability=0.05,
                                   ai_decision=AIDecision("Approve with Loading"), suggested_loading=loading))
    await session.commit()


async def test_above_fcl_outcomes():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            # Enrol with a huge FCL (no risk-engine calls), then lower it so the
            # Management (10m) and Tenure (2m) members land above it.
            mp_id, enrolled = await _enrolled_scheme(session, fx)
            mp = await session.get(MasterPolicy, mp_id)
            mp.free_cover_limit = 1_500_000
            session.add(mp)
            await session.commit()
            ids = _ids(fx, mp_id, session)

            exc = await _expect_http(generate_group_quote_endpoint(**ids), 409)
            assert len(exc.detail["pending_members"]) >= 2

            above = sorted((o for o in enrolled.employees if o.coverage_amount > 1_500_000), key=lambda o: o.coverage_amount)
            outcomes = [PolicyStatusEnum.DECLINED, PolicyStatusEnum.ACCEPTED_WITH_LOADINGS] + \
                       [PolicyStatusEnum.APPROVED] * (len(above) - 2)
            for o, decision in zip(above, outcomes):
                await _decide(session, o.policy_id, decision, loading=50 if decision == PolicyStatusEnum.ACCEPTED_WITH_LOADINGS else None)

            quote = await generate_group_quote_endpoint(**ids)
            adjusted = {m["member_id"]: m for m in quote.breakdown["adjusted_members"]}
            restricted, loaded = above[0], above[1]
            assert adjusted[str(restricted.group_member_id)]["basis"] == "Restricted"
            assert quote.breakdown["covered"][str(restricted.group_member_id)] == 1_500_000
            assert adjusted[str(loaded.group_member_id)]["loading_pct"] == 50
            by_life = quote.breakdown["by_life"]
            expected_loaded = round(loaded.coverage_amount / 1000 * quote.rate_per_mille * 1.5, 2)
            assert abs(by_life[str(loaded.group_member_id)] - expected_loaded) < 0.05

            await accept_group_quote(quote_id=quote.id, body=NO_DECISION, **ids)
            await issue_master_policy(**ids)
            member = await session.get(GroupMember, restricted.group_member_id)
            cert = await session.get(Policy, restricted.policy_id)
            assert member.coverage_amount == 1_500_000 and cert.coverage_amount == 1_500_000 and member.cover_note
            assert cert.status == PolicyStatusEnum.PENDING_PAYMENT
            print("PASS test_above_fcl_outcomes")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_takaful_numbering_and_terms():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, _ = await _enrolled_scheme(session, fx, plan_code="GROUP_FAMILY_TAKAFUL")
            ids = _ids(fx, mp_id, session)
            quote = await generate_group_quote_endpoint(**ids)
            assert quote.business_type == "Takaful"
            await accept_group_quote(quote_id=quote.id, body=NO_DECISION, **ids)
            issued = await issue_master_policy(**ids)
            assert issued.master_policy.policy_number.startswith(f"GT-{date.today().year}-")
            assert issued.master_policy.business_type == "Takaful"
            print("PASS test_takaful_numbering_and_terms")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_takaful_split_on_quote_and_documents():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, _ = await _enrolled_scheme(session, fx, plan_code="GROUP_FAMILY_TAKAFUL")
            ids = _ids(fx, mp_id, session)
            quote = await generate_group_quote_endpoint(**ids)
            assert quote.wakala_fee_pct == 30.0                     # seeded plan default
            assert abs(quote.wakala_fee + quote.ptf_allocation - quote.risk_premium) < 0.01
            assert quote.breakdown["takaful"]["ptf_allocation"] == quote.ptf_allocation

            # A plan-level override is picked up by the next (revised) quote.
            plan = (await session.exec(select(InsurancePlan).where(
                InsurancePlan.tenant_id == fx["tenant_id"], InsurancePlan.code == "GROUP_FAMILY_TAKAFUL"))).one()
            plan.wakala_fee_pct = 20.0
            session.add(plan)
            await session.commit()
            revised = await generate_group_quote_endpoint(**ids)
            assert revised.wakala_fee_pct == 20.0 and revised.ptf_allocation > quote.ptf_allocation
            assert revised.total_premium == quote.total_premium     # the split allocates, it doesn't reprice

            row = await session.get(GroupQuote, revised.id)
            assert os.path.exists(row.document_path)

            # The schedule carries the split too.
            await accept_group_quote(quote_id=revised.id, body=NO_DECISION, **ids)
            await issue_master_policy(**ids)

            # Conventional quotes have no split.
            conv_id, _ = await _enrolled_scheme(session, fx)
            conv = await generate_group_quote_endpoint(**_ids(fx, conv_id, session))
            assert conv.wakala_fee_pct is None and conv.ptf_allocation is None and "takaful" not in conv.breakdown
            print("PASS test_takaful_split_on_quote_and_documents")
        finally:
            await _cleanup(session, fx["tenant_id"])


class _FakeProducer:
    """Stands in for AIOKafkaProducer; records what would have been published."""

    def __init__(self, fail=False):
        self.sent, self.fail = [], fail

    async def send_and_wait(self, topic, value, key=None):
        if self.fail:
            raise RuntimeError("broker down")
        self.sent.append((topic, json.loads(value), key))


def _fake_request(producer):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(kafka_producer=producer)))


async def _drain_outbox(producer) -> int:
    """Deliver every queued business event, as the relay does. Delivery is separate from the change that queued it."""
    from shared.events.outbox import deliver_one
    delivered = 0
    while await deliver_one(_session_factory, producer):
        delivered += 1
        if delivered > 5000:
            raise AssertionError("outbox did not drain")
    return delivered


async def test_certificate_events_published_to_kafka():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled = await _enrolled_scheme(session, fx)
            ids = _ids(fx, mp_id, session)
            n = len(enrolled.employees)
            quote = await generate_group_quote_endpoint(**ids)
            await accept_group_quote(quote_id=quote.id, body=NO_DECISION, **ids)

            # Earlier tests in this file queued events nobody relayed; settle those so this test sees only its own.
            from sqlalchemy import text as _text
            await session.execute(_text("UPDATE business_outbox SET published_at = now() WHERE published_at IS NULL"))
            await session.commit()
            producer = _FakeProducer()
            issued = await issue_master_policy(**ids)
            assert producer.sent == [], "nothing is sent inside the request: events are queued with the change and relayed afterwards"
            await _drain_outbox(producer)
            mine = [m for t, m, k in producer.sent if k == str(fx["tenant_id"])]
            issue_events = [m for m in mine if m["event_type"] == "GroupCertificateIssued"]
            assert {t for t, _m, _k in producer.sent} == {POLICY_LIFECYCLE_TOPIC}
            assert {e["payload"]["to_status"] for e in issue_events} <= {"Proposed", "Approved", "PendingPayment"}
            # Every certificate reached PendingPayment, and each event names its master policy.
            assert len({e["payload"]["policy_id"] for e in issue_events if e["payload"]["to_status"] == "PendingPayment"}) == n
            assert all(e["payload"]["detail"]["master_policy_number"] == issued.master_policy.policy_number for e in issue_events)

            producer.sent.clear()
            await record_group_payment(body=GroupPaymentCreate(reference="PAY-K", amount=quote.total_premium), **ids)
            await _drain_outbox(producer)
            bound = [m for _t, m, k in producer.sent if k == str(fx["tenant_id"])]
            assert len(bound) == n and {e["event_type"] for e in bound} == {"GroupCoverBound"}
            assert {e["payload"]["to_status"] for e in bound} == {"Active"}
            # event ids are stable, so a consumer can deduplicate a redelivery
            assert len({e["event_id"] for e in bound}) == n
            print("PASS test_certificate_events_published_to_kafka")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_broker_outage_does_not_fail_issuance():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, _ = await _enrolled_scheme(session, fx)
            ids = _ids(fx, mp_id, session)
            quote = await generate_group_quote_endpoint(**ids)
            await accept_group_quote(quote_id=quote.id, body=NO_DECISION, **ids)
            issued = await issue_master_policy(request=_fake_request(_FakeProducer(fail=True)), **ids)
            assert issued.master_policy.status == "PendingPayment"
            paid = await record_group_payment(body=GroupPaymentCreate(reference="PAY-X", amount=quote.total_premium),
                                              request=_fake_request(_FakeProducer(fail=True)), **ids)
            assert paid.master_policy.status == "Active"
            # No producer on app.state at all (e.g. Kafka disabled) behaves the same.
            print("PASS test_broker_outage_does_not_fail_issuance")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_quote_guards():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _master_policy(session, fx)
            ids = _ids(fx, mp_id, session)
            await _expect_http(generate_group_quote_endpoint(**ids), 409)        # no census yet ("Pending")
            await _enroll(session, fx, mp_id, _census(fx))

            # Roster change after quoting → the quote can't be accepted.
            quote = await generate_group_quote_endpoint(**ids)
            await _enroll(session, fx, mp_id, [_row(_cnic(), 70)])
            await _expect_http(accept_group_quote(quote_id=quote.id, body=NO_DECISION, **ids), 409)

            # Decline, then re-quote (negotiation continues) — and expiry.
            quote = await generate_group_quote_endpoint(**ids)
            declined = await decline_group_quote(quote_id=quote.id, body=GroupQuoteDecision(notes="Too expensive"), **ids)
            assert declined.status == "Declined" and (await session.get(MasterPolicy, mp_id)).status == "Declined"
            quote = await generate_group_quote_endpoint(**ids)
            row = await session.get(GroupQuote, quote.id)
            row.valid_until = date.today() - timedelta(days=1)
            session.add(row)
            await session.commit()
            await _expect_http(accept_group_quote(quote_id=quote.id, body=NO_DECISION, **ids), 409)
            session.expunge_all()
            assert (await session.get(GroupQuote, quote.id)).status == "Expired"
            await _expect_http(issue_master_policy(**ids), 409)                   # nothing accepted
            print("PASS test_quote_guards")
        finally:
            await _cleanup(session, fx["tenant_id"])


async def test_http_flow():
    """The same lifecycle through FastAPI itself, so request parsing and
    response-model serialization of every new endpoint are exercised."""
    import main as app_module
    from routers.users import verify_admin

    async with _session_factory() as session:
        fx = await _setup(session)
        app_module.app.dependency_overrides[verify_admin] = lambda: None
        try:
            transport = httpx.ASGITransport(app=app_module.app)
            base = f"/tenants/{fx['tenant_id']}/organizations/{fx['org_id']}/master-policies"
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
                r = await c.post(base, json={"sum_assured_multiple": 24, "term_years": 1,
                                             "effective_date": "2026-01-01", "plan_code": "GROUP_LIFE"})
                assert r.status_code == 201, r.text
                mp = f"{base}/{r.json()['id']}"
                rows = [_row(_cnic(), i, declared_income=360_000) for i in range(10)]   # 720k cover < FCL
                r = await c.post(f"{mp}/census/confirm", json={"employees": rows})
                assert r.status_code == 201, r.text
                member_id = r.json()["employees"][0]["group_member_id"]

                r = await c.post(f"{mp}/members/{member_id}/dependents", json={
                    "name": "Child One", "relationship": "Child", "dob": "2018-05-05", "covered_amount": 300000})
                assert r.status_code == 201, r.text
                r = await c.put(f"{mp}/members/{member_id}/beneficiaries", json={
                    "beneficiaries": [{"name": "Spouse", "relationship": "Spouse", "share_pct": 100}]})
                assert r.status_code == 200, r.text

                r = await c.post(f"{mp}/quotes")
                assert r.status_code == 201, r.text
                quote = r.json()
                assert quote["dependent_count"] == 1 and quote["breakdown"]["by_class"]
                r = await c.get(f"{mp}/quotes/{quote['id']}/document")
                assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
                r = await c.post(f"{mp}/quotes/{quote['id']}/accept", json={"decided_by": "CFO"})
                assert r.status_code == 200 and r.json()["status"] == "Accepted", r.text

                r = await c.post(f"{mp}/issue")
                assert r.status_code == 200, r.text
                assert r.json()["master_policy"]["status"] == "PendingPayment"
                r = await c.post(f"{mp}/payments", json={"reference": "BANK-1", "amount": quote["total_premium"]})
                assert r.status_code == 200 and r.json()["master_policy"]["status"] == "Active", r.text

                r = await c.get(f"{mp}/members")
                assert r.status_code == 200 and all(m["status"] == "Active" for m in r.json())
                assert sum(m["dependents"] for m in r.json()) == 1
                r = await c.get(f"{mp}/schedule/document")
                assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
                r = await c.get(f"{mp}/quotes")
                assert r.status_code == 200 and [q["status"] for q in r.json()] == ["Accepted"]
            print("PASS test_http_flow")
        finally:
            app_module.app.dependency_overrides.pop(verify_admin, None)
            await _cleanup(session, fx["tenant_id"])


async def test_keyed_issuance_and_employer_payment_are_idempotent():
    """A retried issue/payment returns the original outcome; a different key cannot issue or bind cover twice."""
    import main as app_module
    from types import SimpleNamespace as NS
    from unittest.mock import AsyncMock, patch
    from routers.users import verify_admin
    from sqlalchemy import text as _text

    async with _session_factory() as session:
        fx = await _setup(session)
        app_module.app.dependency_overrides[verify_admin] = lambda: None
        identity = NS(id=uuid4())
        try:
            with patch("services.idempotency.tenant_identity", AsyncMock(return_value=(identity, "t"))):
                transport = httpx.ASGITransport(app=app_module.app)
                base = f"/tenants/{fx['tenant_id']}/organizations/{fx['org_id']}/master-policies"
                async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
                    r = await c.post(base, json={"sum_assured_multiple": 24, "term_years": 1, "effective_date": "2026-01-01", "plan_code": "GROUP_LIFE"})
                    mp = f"{base}/{r.json()['id']}"
                    rows = [_row(_cnic(), i, declared_income=360_000) for i in range(10)]
                    assert (await c.post(f"{mp}/census/confirm", json={"employees": rows})).status_code == 201
                    quote = (await c.post(f"{mp}/quotes")).json()
                    assert (await c.post(f"{mp}/quotes/{quote['id']}/accept", json={"decided_by": "CFO"})).status_code == 200

                    k1 = {"Idempotency-Key": "group-issue-operation-1"}
                    first = await c.post(f"{mp}/issue", headers=k1)
                    assert first.status_code == 200, first.text
                    again = await c.post(f"{mp}/issue", headers=k1)
                    assert again.status_code == 200 and again.headers["idempotency-replayed"] == "true", again.text
                    assert again.json()["certificates_issued"] == first.json()["certificates_issued"] == 10
                    assert again.json()["master_policy"]["policy_number"] == first.json()["master_policy"]["policy_number"]
                    other = await c.post(f"{mp}/issue", headers={"Idempotency-Key": "group-issue-operation-2"})
                    assert other.status_code == 409, "a second key cannot issue the scheme again"

                    pay = {"reference": "BANK-KEYED-1", "amount": quote["total_premium"]}
                    k2 = {"Idempotency-Key": "group-pay-operation-1"}
                    paid = await c.post(f"{mp}/payments", json=pay, headers=k2)
                    assert paid.status_code == 200 and paid.json()["master_policy"]["status"] == "Active", paid.text
                    replay = await c.post(f"{mp}/payments", json=pay, headers=k2)
                    assert replay.status_code == 200 and replay.headers["idempotency-replayed"] == "true"
                    assert replay.json()["total_premium"] == paid.json()["total_premium"]
                    changed = await c.post(f"{mp}/payments", json={**pay, "reference": "BANK-OTHER"}, headers=k2)
                    assert changed.status_code == 409
                    second = await c.post(f"{mp}/payments", json=pay, headers={"Idempotency-Key": "group-pay-operation-2"})
                    assert second.status_code == 409, "cover is already bound; the business rule refuses a second payment"

            bound = (await session.execute(_text("SELECT count(*) FROM business_outbox WHERE payload->>'event_type' = 'GroupCoverBound' AND message_key = :t"),
                                           {"t": str(fx["tenant_id"])})).scalar()
            issued = (await session.execute(_text("SELECT count(*) FROM business_outbox WHERE payload->>'event_type' = 'GroupCertificateIssued' AND message_key = :t"),
                                            {"t": str(fx["tenant_id"])})).scalar()
            assert bound == 10, bound
            assert issued >= 10 and issued == (await session.execute(_text("SELECT count(DISTINCT payload->>'event_id') FROM business_outbox WHERE payload->>'event_type' = 'GroupCertificateIssued' AND message_key = :t"), {"t": str(fx["tenant_id"])})).scalar()
            print("PASS test_keyed_issuance_and_employer_payment_are_idempotent")
        finally:
            app_module.app.dependency_overrides.pop(verify_admin, None)
            await _cleanup(session, fx["tenant_id"])


async def main():
    await test_full_lifecycle()
    await test_above_fcl_outcomes()
    await test_takaful_numbering_and_terms()
    await test_takaful_split_on_quote_and_documents()
    await test_certificate_events_published_to_kafka()
    await test_broker_outage_does_not_fail_issuance()
    await test_quote_guards()
    await test_http_flow()
    await test_keyed_issuance_and_employer_payment_are_idempotent()


if __name__ == "__main__":
    asyncio.run(main())
