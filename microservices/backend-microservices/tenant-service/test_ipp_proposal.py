"""The initial premium is paid on the PROPOSAL, after Start Review, and an individual application cannot open its underwriting
case until that payment has cleared.

Run with: docker compose exec tenant-service python test_ipp_proposal.py   (needs a migrated Postgres; cleans up after itself)
"""

import asyncio
from datetime import date, datetime
from types import SimpleNamespace
from uuid import uuid4

from fastapi import HTTPException
from sqlmodel import select

import routers.cases as cases_router
import routers.initial_premium_payment as ipp
from database import _session_factory
from schemas import CaseCreate
from shared.models.core import (
    Case, CaseTypeEnum, Customer, InitialPremiumPayment, InsuranceTypeEnum, IPPStatusEnum, Policy, PolicyStatusEnum, SourceChannelEnum, Tenant, User,
)
from test_group_census import _cleanup


async def _fixture(session, status=PolicyStatusEnum.PROPOSED):
    tenant = Tenant(name=f"IPP {uuid4().hex[:6]}", code=f"IP{uuid4().hex[:6].upper()}")
    session.add(tenant)
    await session.flush()
    customer = Customer(tenant_id=tenant.id, cnic=f"35202-{uuid4().int % 10**7:07d}-1", name="Proposal Pay", dob=date(1990, 1, 1),
                        gender="Male", occupation="Engineer", declared_income=2_400_000)
    session.add(customer)
    await session.flush()
    policy = Policy(tenant_id=tenant.id, customer_id=customer.id, product_name="Term", insurance_type=InsuranceTypeEnum.TERM_LIFE,
                    coverage_amount=5_000_000, term_years=10, status=status)
    session.add(policy)
    await session.commit()
    return tenant.id, customer.id, policy.id


async def expect(code, coro):
    try:
        await coro
    except HTTPException as exc:
        assert exc.status_code == code, (code, exc.status_code, exc.detail)
        return exc
    raise AssertionError(f"expected {code}")


async def test_payment_after_review_then_case_opens():
    async with _session_factory() as s:
        tenant_id, customer_id, policy_id = await _fixture(s)
    saved = (ipp._get_current_user_id, cases_router._get_current_user, cases_router._role_name)
    ipp._get_current_user_id = lambda token: asyncio.sleep(0)
    async def fake_user(token, session): return SimpleNamespace(id=(await session.exec(select(User.id))).first())
    async def fake_role(user, session): return "Admin"
    cases_router._get_current_user, cases_router._role_name = fake_user, fake_role
    try:
        async def initiate():
            async with _session_factory() as s:
                return await ipp.initiate_policy_ipp(tenant_id, policy_id, ipp.IPPInitiateRequest(), token="t", session=s)

        async def create_case():
            async with _session_factory() as s:
                return await cases_router.create_case(tenant_id, CaseCreate(customer_id=customer_id, policy_id=policy_id, caseType=CaseTypeEnum.UNDERWRITING,
                                                                            sourceChannel=SourceChannelEnum.ONLINE), s, "t")

        # 1. before Start Review there is nothing to pay
        await expect(409, initiate())
        async with _session_factory() as s:
            p = await s.get(Policy, policy_id); p.status = PolicyStatusEnum.UNDER_REVIEW; s.add(p); await s.commit()

        # 2. no payment -> no underwriting case
        exc = await expect(409, create_case())
        assert "initial premium" in exc.detail

        # 3. pay: initiate, then confirm
        res = await initiate()
        assert res.amount > 0
        async with _session_factory() as s:
            row = (await s.exec(select(InitialPremiumPayment).where(InitialPremiumPayment.policy_id == policy_id))).one()
            assert row.case_id is None and row.status == IPPStatusEnum.INITIATED
        await expect(409, create_case())                       # initiated is not paid
        async with _session_factory() as s:
            out = await ipp.confirm_policy_ipp(tenant_id, policy_id, ipp.IPPConfirmRequest(reference=res.payment["reference"], method=res.payment["method"]), token="t", session=s)
            assert out.status == IPPStatusEnum.REALIZED
        await expect(409, initiate())                          # cannot pay twice

        # 4. the case opens and takes the payment with it
        case = await create_case()
        async with _session_factory() as s:
            row = (await s.exec(select(InitialPremiumPayment).where(InitialPremiumPayment.policy_id == policy_id))).one()
            assert row.case_id == case.caseld
            via_case = await ipp.get_ipp(tenant_id, case.caseld, token="t", session=s)
            assert via_case.status == IPPStatusEnum.REALIZED
        print("PASS test_payment_after_review_then_case_opens")
    finally:
        ipp._get_current_user_id, cases_router._get_current_user, cases_router._role_name = saved
        async with _session_factory() as s:
            from sqlalchemy import delete
            await s.exec(delete(InitialPremiumPayment).where(InitialPremiumPayment.tenant_id == tenant_id))
            await s.commit()
            await _cleanup(s, tenant_id)


async def test_customer_pays_by_link_and_staff_confirm():
    """Staff ask the customer to pay: a secure link is emailed. The customer uploads a screenshot, staff are told and
    confirm it, and only then can underwriting open."""
    import io
    from fastapi import UploadFile
    import routers.customer_portal_walkin as walkin
    from services import payment_requests as pr
    async with _session_factory() as s:
        tenant_id, customer_id, policy_id = await _fixture(s, PolicyStatusEnum.UNDER_REVIEW)
        c = await s.get(Customer, customer_id); c.details = {"contact_email": "cust@x.test"}; s.add(c); await s.commit()
    mails = []
    async def fake_send(to, subject, body):
        mails.append((to, subject, body)); return True
    saved = (ipp._get_current_user_id, cases_router._get_current_user, cases_router._role_name, pr._send, walkin._upload_to_s3, ipp._staff_name)
    ipp._get_current_user_id = lambda token: asyncio.sleep(0, result=uuid4())
    async def fake_staff(session, uid): return "Sam Staff"
    ipp._staff_name = fake_staff
    pr._send = fake_send
    from services import lead_routing
    saved_recipients = lead_routing.staff_recipients
    async def fake_recipients(session, tenant, branch): return [SimpleNamespace(id=uuid4(), email='admin@x.test')]
    lead_routing.staff_recipients = fake_recipients
    walkin._upload_to_s3 = lambda data, key, ctype: f"local://{key}"
    async def fake_user(token, session): return SimpleNamespace(id=(await session.exec(select(User.id))).first())
    async def fake_role(user, session): return "Admin"
    cases_router._get_current_user, cases_router._role_name = fake_user, fake_role
    try:
        async with _session_factory() as s:
            out = await ipp.request_policy_payment(tenant_id, policy_id, token="t", session=s)
        assert out.emailed and out.link.startswith("http") and "/walk-in/pay/" in out.link
        assert mails[0][0] == "cust@x.test" and out.link in mails[0][2], mails
        token = out.link.rsplit("/", 1)[1]

        async with _session_factory() as s:
            view = await walkin.pay_details(token, session=s)
            assert view["state"] == "Open" and view["amount"] > 0 and view["plan_label"] == "Term"
            try:
                await walkin.pay_details(token[:-3] + "abc", session=s); raise AssertionError("forged token accepted")
            except HTTPException as exc:
                assert exc.status_code == 404
            try:
                await walkin.pay_upload_proof(token, file=UploadFile(file=io.BytesIO(b"x"), filename="evil.exe"), note=None, method=None, reference=None, session=s); raise AssertionError("exe accepted")
            except HTTPException as exc:
                assert exc.status_code == 422

        async with _session_factory() as s:
            await expect(409, ipp.review_policy_payment_proof(tenant_id, policy_id, ipp.IPPReviewRequest(decision="accept"), token="t", session=s))   # nothing to review yet
        async with _session_factory() as s:
            after = await walkin.pay_upload_proof(token, file=UploadFile(file=io.BytesIO(b"\x89PNG"), filename="proof.png"), note="paid via JazzCash", method=None, reference=None, session=s)
            assert after["state"] == "ProofSubmitted"
        assert any("Payment proof received" in m[1] for m in mails), mails           # staff were told
        async with _session_factory() as s:
            st = await ipp.get_policy_ipp(tenant_id, policy_id, token="t", session=s)
            assert st.proof_status == "Submitted" and st.proof_artifact_id and st.status == IPPStatusEnum.INITIATED
        await expect(409, create_case_for(tenant_id, customer_id, policy_id))         # a screenshot alone does not clear the payment

        async with _session_factory() as s:    # staff reject first: the customer is asked again
            r = await ipp.review_policy_payment_proof(tenant_id, policy_id, ipp.IPPReviewRequest(decision="reject", note="blurry"), token="t", session=s)
            assert r.proof_status == "Rejected"
        assert any("could not confirm" in m[1] for m in mails)
        async with _session_factory() as s:
            v = await walkin.pay_details(token, session=s)
            assert v["state"] == "Rejected" and v["review_note"] == "blurry"
            await walkin.pay_upload_proof(token, file=UploadFile(file=io.BytesIO(b"\x89PNG"), filename="again.png"), note=None, method=None, reference=None, session=s)
        async with _session_factory() as s:
            r = await ipp.review_policy_payment_proof(tenant_id, policy_id, ipp.IPPReviewRequest(decision="accept"), token="t", session=s)
            assert r.status == IPPStatusEnum.REALIZED and r.proof_status == "Accepted"
        async with _session_factory() as s:
            assert (await walkin.pay_details(token, session=s))["state"] == "Paid"
            await expect(409, walkin.pay_upload_proof(token, file=UploadFile(file=io.BytesIO(b"x"), filename="a.png"), note=None, method=None, reference=None, session=s))
        case = await create_case_for(tenant_id, customer_id, policy_id)               # now underwriting opens
        assert case.caseld

        # asking again retires the old link
        async with _session_factory() as s:
            await expect(409, ipp.request_policy_payment(tenant_id, policy_id, token="t", session=s))   # already paid
        print("PASS test_customer_pays_by_link_and_staff_confirm")
    finally:
        ipp._get_current_user_id, cases_router._get_current_user, cases_router._role_name, pr._send, walkin._upload_to_s3, ipp._staff_name = saved
        lead_routing.staff_recipients = saved_recipients
        async with _session_factory() as s:
            from sqlalchemy import delete
            from shared.models.core import Artifact
            await s.exec(delete(Artifact).where(Artifact.tenant_id == tenant_id))
            await s.exec(delete(InitialPremiumPayment).where(InitialPremiumPayment.tenant_id == tenant_id))
            await s.commit()
            await _cleanup(s, tenant_id)


async def create_case_for(tenant_id, customer_id, policy_id):
    async with _session_factory() as s:
        return await cases_router.create_case(tenant_id, CaseCreate(customer_id=customer_id, policy_id=policy_id, caseType=CaseTypeEnum.UNDERWRITING,
                                                                    sourceChannel=SourceChannelEnum.ONLINE), s, "t")


async def test_every_way_a_payment_can_arrive():
    """Staff mark it received without any link; or: request, remind, withdraw, renew, customer declares they paid, staff mark received."""
    import routers.customer_portal_walkin as walkin
    from services import lead_routing, payment_requests as pr
    async with _session_factory() as s:
        tenant_id, customer_id, policy_a = await _fixture(s, PolicyStatusEnum.UNDER_REVIEW)
        c = await s.get(Customer, customer_id); c.details = {"contact_email": "cust@x.test"}; s.add(c)
        p2 = Policy(tenant_id=tenant_id, customer_id=customer_id, product_name="Term B", insurance_type=InsuranceTypeEnum.TERM_LIFE, coverage_amount=2_000_000, term_years=10, status=PolicyStatusEnum.UNDER_REVIEW)
        s.add(p2); await s.commit(); policy_b = p2.id
    mails = []
    async def fake_send(to, subject, body):
        mails.append((to, subject, body)); return True
    async def fake_recipients(session, tenant, branch): return [SimpleNamespace(id=uuid4(), email="admin@x.test")]
    async def fake_staff(session, uid): return "Sam Staff"
    saved = (ipp._get_current_user_id, ipp._staff_name, pr._send, lead_routing.staff_recipients)
    ipp._get_current_user_id = lambda token: asyncio.sleep(0, result=uuid4())
    ipp._staff_name, pr._send, lead_routing.staff_recipients = fake_staff, fake_send, fake_recipients
    S = _session_factory
    try:
        # A. nothing requested: the amount is known, and staff can record the payment (cash at the office)
        async with S() as s:
            before = await ipp.get_policy_ipp(tenant_id, policy_a, token="t", session=s)
            assert before.status == IPPStatusEnum.NOT_STARTED and before.amount_due and before.amount_due > 0
            # the amount asked for before underwriting is the amount issuance will carry: the same calculation, with its breakdown
            import routers.policies as pol
            priced, _ = await pol._price_breakdown(s, tenant_id, await s.get(Policy, policy_a))
            # RS-PAY-001: 20% is asked for before underwriting, the other 80% at issuance; the breakdown still describes the whole premium
            sp = before.breakdown_due["split"]
            assert before.breakdown_due["total_premium"] == round(priced.total_premium, 2)
            assert (sp["upfront_pct"], sp["remaining_pct"]) == (20.0, 80.0)
            assert before.amount_due == sp["upfront_amount"] == round(priced.total_premium * 0.2, 2)
            assert abs(sp["upfront_amount"] + sp["remaining_amount"] - sp["total"]) < 0.011 and "80%" in sp["message_remaining"]
            assert {"base_premium", "loading_amount", "policy_fee", "stamp_duty_amount", "tax_amount"} <= set(before.breakdown_due)
            await expect(422, ipp.mark_policy_payment_received(tenant_id, policy_a, ipp.IPPReceivedRequest(method=" "), token="t", session=s))
            done = await ipp.mark_policy_payment_received(tenant_id, policy_a, ipp.IPPReceivedRequest(method="Cash", reference="RCPT-1", note="paid at the branch"), token="t", session=s)
        assert (done.status, done.method, done.proof_status, done.proof_reviewed_by) == (IPPStatusEnum.REALIZED, "Cash", "Accepted", "Sam Staff")
        assert any("We received your payment" in m[1] for m in mails)
        async with S() as s:
            rc = await ipp.policy_payment_receipt(tenant_id, policy_a, token="t", session=s)
            assert rc["receipt_no"].startswith("RCT-") and rc["amount"] == before.amount_due and rc["method"] == "Cash" and rc["reference"] == "RCPT-1"
            assert (rc["customer_name"], rc["plan_label"], rc["confirmed_by"]) == ("Proposal Pay", "Term", "Sam Staff")
            assert rc["breakdown"]["total_premium"] > rc["amount"] and rc["breakdown"]["split"]["upfront_amount"] == rc["amount"] and rc["breakdown"]["base_premium"] > 0
            await expect(409, ipp.policy_payment_receipt(tenant_id, policy_b, token="t", session=s))               # nothing received on B yet
        async with S() as s:
            await expect(409, ipp.mark_policy_payment_received(tenant_id, policy_a, ipp.IPPReceivedRequest(method="Cash"), token="t", session=s))

        # B. request -> reminder -> withdraw -> the link is dead -> a reminder renews it
        async with S() as s:
            req = await ipp.request_policy_payment(tenant_id, policy_b, token="t", session=s)
        old = req.link.rsplit("/", 1)[1]
        async with S() as s:
            r = await ipp.remind_policy_payment(tenant_id, policy_b, token="t", session=s)
            assert r.ipp.reminder_count == 1 and r.ipp.last_reminded_at and r.link == req.link and r.emailed
        assert any(m[1].startswith("Reminder") for m in mails)
        async with S() as s:
            w = await ipp.withdraw_policy_payment_request(tenant_id, policy_b, token="t", session=s)
            assert w.link_expired
            assert (await walkin.pay_details(old, session=s))["state"] == "Expired"
            await expect(410, walkin.pay_declare(old, walkin.DeclareBody(method="Cash"), session=s))
        async with S() as s:
            r = await ipp.remind_policy_payment(tenant_id, policy_b, token="t", session=s)       # expired: a fresh link is issued
            new = r.link.rsplit("/", 1)[1]
            assert new != old and not r.ipp.link_expired and r.ipp.reminder_count == 2
            try:
                await walkin.pay_details(old, session=s); raise AssertionError("the old link still works")
            except HTTPException as exc:
                assert exc.status_code == 404

        # C. the customer says they have paid, with no receipt: staff see it at once, nothing is cleared yet
        async with S() as s:
            out = await walkin.pay_declare(new, walkin.DeclareBody(method="JazzCash", reference="TX-77", note="paid just now"), session=s)
            assert out["state"] == "ProofSubmitted" and out["has_receipt"] is False and out["proof_reference"] == "TX-77"
        assert any("told us they have paid" in m[2] and "TX-77" in m[2] for m in mails)
        async with S() as s:
            st = await ipp.get_policy_ipp(tenant_id, policy_b, token="t", session=s)
            assert (st.proof_status, st.proof_artifact_id, st.proof_method, st.status) == ("Submitted", None, "JazzCash", IPPStatusEnum.INITIATED)
        # D. staff check their bank and mark it received (instead of confirm/reject): clears, and the link then says Paid
        async with S() as s:
            done = await ipp.mark_policy_payment_received(tenant_id, policy_b, ipp.IPPReceivedRequest(method="Bank transfer", reference="TX-77"), token="t", session=s)
            assert done.status == IPPStatusEnum.REALIZED and done.reference == "TX-77"
            view = await walkin.pay_details(new, session=s)
            assert view["state"] == "Paid" and view["receipt"]["reference"] == "TX-77" and view["receipt"]["method"] == "Bank transfer"
            await expect(409, ipp.remind_policy_payment(tenant_id, policy_b, token="t", session=s))
        print("PASS test_every_way_a_payment_can_arrive")
    finally:
        ipp._get_current_user_id, ipp._staff_name, pr._send, lead_routing.staff_recipients = saved
        async with S() as s:
            from sqlalchemy import delete
            await s.exec(delete(InitialPremiumPayment).where(InitialPremiumPayment.tenant_id == tenant_id))
            await s.commit()
            await _cleanup(s, tenant_id)


async def test_received_payment_activates_cover_without_a_second_payment():
    """A policy sitting in PENDING_PAYMENT whose initial premium was received is activated from that payment: no gateway, no new amount."""
    from datetime import timedelta
    import routers.policies as pol
    from shared.models.core import PremiumSchedule, PremiumScheduleStatusEnum
    async with _session_factory() as s:
        tenant_id, customer_id, policy_id = await _fixture(s, PolicyStatusEnum.PENDING_PAYMENT)
        p = await s.get(Policy, policy_id); p.policy_number = "POLICY-T-1"; p.effective_date = date.today(); s.add(p)
        s.add(InitialPremiumPayment(tenant_id=tenant_id, policy_id=policy_id, amount=400_000.0, status=IPPStatusEnum.REALIZED, method="Cash", reference="RCPT-9", realized_at=datetime.utcnow()))
        s.add(PremiumSchedule(policy_id=policy_id, billing_frequency="Annual", due_date=date.today() + timedelta(days=1), amount_due=900_000.0, installment_no=1, status="Pending"))
        await s.commit()
    try:
        async with _session_factory() as s:
            st = await pol.prepaid_status(tenant_id, policy_id, session=s)
            assert (st["received"], st["amount"], st["premium"], st["settled"], st["awaiting_activation"]) == (True, 400000.0, 900000.0, False, True)
        async with _session_factory() as s:
            req = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(kafka_producer=None)))
            out = await pol.apply_prepaid(tenant_id, policy_id, req, session=s)
            assert out["status"] == "Active" and out["payment"]["amount"] == 400000.0
        async with _session_factory() as s:
            row = (await s.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy_id))).one()
            assert row.status == PremiumScheduleStatusEnum.PAID and row.amount_paid == 400000.0 and row.payment_reference == "RCPT-9"
            await expect(400, pol.apply_prepaid(tenant_id, policy_id, req, session=s))      # already active: cannot be applied twice
        print("PASS test_received_payment_activates_cover_without_a_second_payment")
    finally:
        async with _session_factory() as s:
            from sqlalchemy import delete
            from sqlalchemy import text
            # binding cover wrote documents, events and so on against the policy: clear everything that points at it
            await s.execute(text("delete from commission_accruals where receipt_id in (select id from premium_receipts where policy_id = :p)"), {"p": policy_id})
            for (tbl,) in (await s.execute(text("select table_name from information_schema.columns where column_name='policy_id' and table_schema=current_schema() and table_name<>'policies'"))).all():
                await s.execute(text(f'delete from "{tbl}" where policy_id = :p'), {"p": policy_id})
            await s.commit()
            await _cleanup(s, tenant_id)


async def test_split_payment_leaves_a_balance_for_issuance():
    """RS-PAY-001: with only part of the premium paid at the proposal, the policy shows the balance and cannot be activated from that part alone."""
    from datetime import timedelta
    import routers.policies as pol
    from shared.models.core import PremiumSchedule
    async with _session_factory() as s:
        tenant_id, customer_id, policy_id = await _fixture(s, PolicyStatusEnum.PENDING_PAYMENT)
        p = await s.get(Policy, policy_id); p.policy_number = "POLICY-T-2"; p.effective_date = date.today(); s.add(p)
        split = {"upfront_pct": 20.0, "upfront_amount": 180_000.0, "remaining_pct": 80.0, "remaining_amount": 720_000.0, "total": 900_000.0,
                 "message_remaining": "You paid 20% before. The remaining 80% is due now."}
        s.add(InitialPremiumPayment(tenant_id=tenant_id, policy_id=policy_id, amount=180_000.0, status=IPPStatusEnum.REALIZED, method="Cash", reference="RCPT-S",
                                    realized_at=datetime.utcnow(), breakdown_json={"total_premium": 900_000.0, "split": split}))
        s.add(PremiumSchedule(policy_id=policy_id, billing_frequency="Annual", due_date=date.today() + timedelta(days=1), amount_due=900_000.0,
                              amount_paid=180_000.0, installment_no=1, status="Pending"))
        await s.commit()
    try:
        async with _session_factory() as s:
            st = await pol.prepaid_status(tenant_id, policy_id, session=s)
            assert st["received"] and st["remaining_due"] == 720000.0 and "80%" in st["remaining_message"]
            req = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(kafka_producer=None)))
            await expect(409, pol.apply_prepaid(tenant_id, policy_id, req, session=s))
        print("PASS test_split_payment_leaves_a_balance_for_issuance")
    finally:
        async with _session_factory() as s:
            from sqlalchemy import delete
            await s.exec(delete(InitialPremiumPayment).where(InitialPremiumPayment.tenant_id == tenant_id))
            await s.exec(delete(PremiumSchedule).where(PremiumSchedule.policy_id == policy_id))
            await s.commit()
            await _cleanup(s, tenant_id)


async def test_issuance_adds_only_the_loading_to_a_split_premium():
    """RS-PAY-001: the proposal premium carries fee, duty and tax but no loading; issuing adds the underwriting loading and nothing else."""
    import routers.policies as pol
    from services.pricing_engine import PremiumBreakdown
    full = PremiumBreakdown(base_premium=1000.0, loading_amount=400.0, policy_fee=50.0, tax_amount=300.0, total_premium=1750.0,
                            rating_basis="x", loading_pct=40.0, stamp_duty_amount=20.0)
    quoted = {"base_premium": 1000.0, "loading_amount": 0.0, "policy_fee": 50.0, "stamp_duty_amount": 20.0, "tax_amount": 90.0, "total_premium": 1160.0,
              "split": {"total": 1160.0, "upfront_amount": 232.0, "remaining_amount": 928.0}}
    saved = (pol._price_breakdown, pol._realized_ipp)
    async def fake_price(*a, **k): return full, 40.0
    async def fake_ipp(*a, **k): return SimpleNamespace(breakdown_json=quoted)
    pol._price_breakdown, pol._realized_ipp = fake_price, fake_ipp
    try:
        b, _, info = await pol._issuance_breakdown(None, None, None)
        assert (b.base_premium, b.policy_fee, b.stamp_duty_amount, b.tax_amount, b.loading_amount) == (1000.0, 50.0, 20.0, 90.0, 400.0)
        assert b.total_premium == 1560.0 and info == {"quoted_total": 1160.0, "loading": 400.0}      # 1160 quoted + 400 loading, no extra fee/duty/tax
        quoted.pop("split")
        b2, _, info2 = await pol._issuance_breakdown(None, None, None)
        assert b2.total_premium == 1750.0 and info2 is None                                            # no split: the full price, as before
    finally:
        pol._price_breakdown, pol._realized_ipp = saved
    print("PASS test_issuance_adds_only_the_loading_to_a_split_premium")


async def test_other_tenants_proposal_is_not_found():
    async with _session_factory() as s:
        tenant_id, _, policy_id = await _fixture(s)
        other, _, _ = await _fixture(s)
    saved, ipp._get_current_user_id = ipp._get_current_user_id, (lambda token: asyncio.sleep(0))
    try:
        async with _session_factory() as s:
            await expect(404, ipp.get_policy_ipp(other, policy_id, token="t", session=s))
        print("PASS test_other_tenants_proposal_is_not_found")
    finally:
        ipp._get_current_user_id = saved
        async with _session_factory() as s:
            await _cleanup(s, tenant_id); await _cleanup(s, other)


async def main():
    await test_payment_after_review_then_case_opens()
    await test_customer_pays_by_link_and_staff_confirm()
    await test_every_way_a_payment_can_arrive()
    await test_received_payment_activates_cover_without_a_second_payment()
    await test_split_payment_leaves_a_balance_for_issuance()
    await test_issuance_adds_only_the_loading_to_a_split_premium()
    await test_other_tenants_proposal_is_not_found()


if __name__ == "__main__":
    asyncio.run(main())
