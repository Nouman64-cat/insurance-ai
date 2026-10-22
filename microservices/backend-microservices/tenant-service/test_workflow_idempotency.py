"""Renewal, reinstatement and exit workflow steps: idempotency wiring on real PostgreSQL.

Each workflow's CANCEL/WITHDRAW step is used as the representative state change (it needs the least setup but runs through exactly the
same adapter, authorization, receipt and replay code as the payment steps)."""
import asyncio
import unittest
from datetime import date
from unittest.mock import AsyncMock, patch

from sqlmodel import select

from idem_testkit import RouteCase
from routers import policy_exit, reinstatement, renewals
from shared.models.core import PolicyExit, PolicyReinstatement, PolicyRenewal, PolicyStatusEnum


class WorkflowCase:
    """Mixin: subclasses provide `module`, `path`, `body`, `make_case`, `event`."""
    module = None
    path = ''
    body: dict = {}
    event = ''

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.stub_role_dependencies()
        self.p = await self.make_policy(status=PolicyStatusEnum.ACTIVE, schedule=False)
        self.case_id = await self.make_case()
        self.url = self.base(self.p.policy_id) + self.path.format(case_id=self.case_id)

    async def events(self):
        return await self.scalar("SELECT count(*) FROM policy_events WHERE policy_id = :p AND event_type = :t", p=self.p.policy_id, t=self.event)

    async def test_retry_replays_the_overview_and_cancels_once(self):
        async with self.client() as c:
            h = self.headers('workflow-operation-001')
            first = await c.post(self.url, json=self.body, headers=h)
            self.assertEqual(first.status_code, 200, first.text)
            await self.engine.dispose()
            replay = await c.post(self.url, json=self.body, headers=h)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.headers['idempotency-replayed'], 'true')
        self.assertEqual(await self.events(), 1)
        (row,) = [r for r in await self.receipts() if r['status'] == 'COMPLETED']
        self.assertEqual(set(row['response_json']), {'policy_id', 'case_id'}, 'only identifiers are stored; the overview is rebuilt on replay')

    async def test_another_key_cannot_close_a_closed_case_again(self):
        async with self.client() as c:
            await c.post(self.url, json=self.body, headers=self.headers('workflow-operation-002'))
            other = await c.post(self.url, json=self.body, headers=self.headers('workflow-operation-003'))
            changed = await c.post(self.url, json={**self.body, 'reason': 'something else entirely'}, headers=self.headers('workflow-operation-002'))
        self.assertEqual(other.status_code, 409)
        self.assertEqual(changed.status_code, 409)
        self.assertEqual(await self.events(), 1)

    async def test_concurrent_identical_requests_close_it_once(self):
        async with self.client() as c:
            rs = await asyncio.gather(*[c.post(self.url, json=self.body, headers=self.headers('workflow-operation-004')) for _ in range(6)])
        self.assertTrue(all(r.status_code in (200, 409) for r in rs), [r.status_code for r in rs])
        self.assertGreaterEqual(sum(r.status_code == 200 for r in rs), 1)
        self.assertEqual(await self.events(), 1)

    async def test_the_receipt_is_bound_to_this_case_and_other_cases_are_untouched(self):
        other_case = await self.make_case()
        other_url = self.base(self.p.policy_id) + self.path.format(case_id=other_case)
        async with self.client() as c:
            await c.post(self.url, json=self.body, headers=self.headers('workflow-operation-005'))
            reuse = await c.post(other_url, json=self.body, headers=self.headers('workflow-operation-005'))
        self.assertEqual(reuse.status_code, 409, 'the same key on a different case is a different request')
        self.assertEqual(await self.events(), 1)


class RenewalCancel(WorkflowCase, RouteCase):
    routers = (renewals,)
    path = '/renewals/{case_id}/cancel'
    body = {'reason': 'customer declined', 'actor': 'ops'}
    event = 'RenewalCancelled'

    async def make_case(self):
        async with self.factory() as s:
            n = (await s.exec(select(PolicyRenewal).where(PolicyRenewal.policy_id == self.p.policy_id))).all()
            case = PolicyRenewal(tenant_id=self.tenant_id, policy_id=self.p.policy_id, renewal_no=f'RW-TEST-{len(n) + 1:05d}',
                                 renewal_type='PremiumRenewal', due_date=date.today(), status='Open')
            s.add(case)
            await s.commit()
            return case.id


class ReinstatementWithdraw(WorkflowCase, RouteCase):
    routers = (reinstatement,)
    path = '/reinstatement/{case_id}/withdraw'
    body = {'reason': 'no longer needed', 'actor': 'ops'}
    event = 'ReinstatementWithdrawn'

    async def make_case(self):
        async with self.factory() as s:
            n = (await s.exec(select(PolicyReinstatement).where(PolicyReinstatement.policy_id == self.p.policy_id))).all()
            case = PolicyReinstatement(tenant_id=self.tenant_id, policy_id=self.p.policy_id, case_no=f'RI-TEST-{len(n) + 1:05d}')
            s.add(case)
            await s.commit()
            return case.id


class ExitCancel(WorkflowCase, RouteCase):
    routers = (policy_exit,)
    path = '/exit/{case_id}/cancel'
    body = {'reason': 'policyholder changed their mind'}
    event = 'ExitCancelled'

    async def make_case(self):
        async with self.factory() as s:
            n = (await s.exec(select(PolicyExit).where(PolicyExit.policy_id == self.p.policy_id))).all()
            case = PolicyExit(tenant_id=self.tenant_id, policy_id=self.p.policy_id, exit_no=f'EX-TEST-{len(n) + 1:05d}', exit_type='Surrender')
            s.add(case)
            await s.commit()
            return case.id


class RenewalPayment(RouteCase):
    """The renewal premium is collected by the SAME installment path as ordinary collection: the outer workflow step and the inner
    collection adapter must compose into exactly one payment."""
    routers = (renewals,)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.stub_role_dependencies()
        patcher = patch('routers.post_issuance.document_generator.generate_receipt', return_value={'file_path': '/tmp/receipt-test.pdf'})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.p = await self.make_policy(status=PolicyStatusEnum.ACTIVE, schedule=False)
        async with self.factory() as s:
            case = PolicyRenewal(tenant_id=self.tenant_id, policy_id=self.p.policy_id, renewal_no='RW-TEST-PAY-1', renewal_type='PremiumRenewal',
                                 due_date=date.today(), status='Open', quoted_amount=7000.0, risk_required=False, quote_json={'frequency': 'Annual'})
            s.add(case)
            await s.commit()
            self.case_id = case.id
        self.url = self.base(self.p.policy_id) + f'/renewals/{self.case_id}/payment'
        self.body = {'method': 'BankTransfer', 'reference': 'RENEWAL-REF-1'}

    async def receipts_count(self):
        return await self.scalar("SELECT count(*) FROM premium_receipts WHERE policy_id = :p", p=self.p.policy_id)

    async def test_a_retried_renewal_payment_posts_one_receipt(self):
        async with self.client() as c:
            h = self.headers('renewal-pay-operation-1')
            first = await c.post(self.url, json=self.body, headers=h)
            self.assertEqual(first.status_code, 200, first.text)
            replay = await c.post(self.url, json=self.body, headers=h)
            other = await c.post(self.url, json=self.body, headers=self.headers('renewal-pay-operation-2'))
        self.assertEqual((replay.status_code, replay.headers['idempotency-replayed']), (200, 'true'))
        self.assertEqual(other.status_code, 409, 'the instalment is already settled')
        self.assertEqual(await self.receipts_count(), 1)
        self.assertEqual(await self.scalar("SELECT COALESCE(sum(total_amount), 0) FROM premium_receipts WHERE policy_id = :p", p=self.p.policy_id), 7000)

    async def test_concurrent_renewal_payments_collect_once(self):
        async with self.client() as c:
            rs = await asyncio.gather(*[c.post(self.url, json=self.body, headers=self.headers('renewal-pay-operation-3')) for _ in range(5)])
            rs += await asyncio.gather(*[c.post(self.url, json=self.body, headers=self.headers(f'renewal-pay-other-{i:03d}-key')) for i in range(3)])
        self.assertTrue(all(r.status_code in (200, 409) for r in rs), [(r.status_code, r.text[:60]) for r in rs])
        self.assertEqual(await self.receipts_count(), 1)


if __name__ == '__main__':
    unittest.main()
