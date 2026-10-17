from contextlib import asynccontextmanager
from datetime import datetime
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

from services import policy_delivery as delivery


class Result:
    def __init__(self, rows): self.rows = rows
    def all(self): return self.rows
    def first(self): return self.rows[0] if self.rows else None


class DeliveryTests(IsolatedAsyncioTestCase):
    def setUp(self):
        self.policy = SimpleNamespace(id=uuid4(), tenant_id=uuid4(), customer_id=uuid4(), status="Active",
            policy_number="PL-TEST-001", current_version_id=None, product_name="Term Life", coverage_amount=1000000,
            effective_date=None, maturity_date=None, free_look_end_date=None)
        self.customer = SimpleNamespace(name="Test Customer", details={"email": "test@example.com"}, policyholder_id="PH-TEST")
        self.row = SimpleNamespace(welcome_kit_path="/tmp/test-welcome.pdf", welcome_sent_at=None, updated_at=None, welcome_channel=None)
        self.session = SimpleNamespace(get=AsyncMock(return_value=self.customer), exec=AsyncMock(return_value=Result([])), add=Mock())

    def job(self, kind):
        return SimpleNamespace(kind=kind, policy_id=self.policy.id, status="Pending", attempts=0,
                               last_error=None, completed_at=None, next_attempt_at=datetime.utcnow())

    async def test_enqueue_is_idempotent_and_only_in_force(self):
        self.session.exec.side_effect = [Result([self.policy]), Result([SimpleNamespace(kind=k) for k in delivery.KINDS])]
        await delivery.enqueue_delivery(self.session, self.policy)
        self.session.add.assert_not_called()
        self.policy.status = "PendingPayment"
        self.session.exec.reset_mock()
        await delivery.enqueue_delivery(self.session, self.policy)
        self.session.exec.assert_not_awaited()

    async def test_enqueue_all_required_steps(self):
        await delivery.enqueue_delivery(self.session, self.policy)
        self.assertEqual({c.args[0].kind for c in self.session.add.call_args_list}, set(delivery.KINDS))

    async def test_missing_email_never_claims_delivery(self):
        self.customer.details = {}
        with patch.object(delivery, "_onboarding", AsyncMock(return_value=self.row)), patch("email_utils.send_email", AsyncMock()) as send:
            reason = await delivery.execute_job(self.session, self.job("WelcomeEmail"), self.policy)
        self.assertIn("No customer email", reason)
        send.assert_not_awaited()
        self.assertIsNone(self.row.welcome_sent_at)

    async def test_welcome_failure_is_not_sent(self):
        with patch.object(delivery, "_onboarding", AsyncMock(return_value=self.row)), patch.object(delivery.os.path, "isfile", return_value=True), patch("email_utils.send_email", AsyncMock(return_value=False)), patch.object(delivery, "record_event") as audit:
            reason = await delivery.execute_job(self.session, self.job("WelcomeEmail"), self.policy)
        self.assertIn("failed", reason)
        self.assertIsNone(self.row.welcome_sent_at)
        self.assertEqual(audit.call_args.kwargs["event_type"], "WelcomeEmailFailed")

    async def test_welcome_attaches_kit_and_records_success(self):
        with patch.object(delivery, "_onboarding", AsyncMock(return_value=self.row)), patch.object(delivery.os.path, "isfile", return_value=True), patch("email_utils.send_email", AsyncMock(return_value=True)) as send, patch.object(delivery, "record_event") as audit:
            reason = await delivery.execute_job(self.session, self.job("WelcomeEmail"), self.policy)
        self.assertIsNone(reason)
        self.assertEqual(send.call_args.kwargs["attachments"], [self.row.welcome_kit_path])
        self.assertIsNotNone(self.row.welcome_sent_at)
        self.assertEqual(audit.call_args.kwargs["event_type"], "WelcomeSent")

    async def test_existing_welcome_is_not_resent(self):
        self.row.welcome_sent_at = datetime.utcnow()
        with patch.object(delivery, "_onboarding", AsyncMock(return_value=self.row)), patch("email_utils.send_email", AsyncMock()) as send:
            self.assertIsNone(await delivery.execute_job(self.session, self.job("WelcomeEmail"), self.policy))
        send.assert_not_awaited()

    async def test_issuance_skips_success_but_not_failed_history(self):
        self.session.exec.return_value = Result([SimpleNamespace(detail_json={"delivered": True})])
        with patch.object(delivery, "_onboarding", AsyncMock(return_value=self.row)), patch("email_utils.send_email", AsyncMock()) as send:
            self.assertIsNone(await delivery.execute_job(self.session, self.job("IssuanceEmail"), self.policy))
        send.assert_not_awaited()

    async def test_email_waits_for_kit(self):
        with patch.object(delivery, "_onboarding", AsyncMock(return_value=self.row)), patch.object(delivery.os.path, "isfile", return_value=False), patch("email_utils.send_email", AsyncMock()) as send:
            reason = await delivery.execute_job(self.session, self.job("WelcomeEmail"), self.policy)
        self.assertIn("Waiting", reason)
        send.assert_not_awaited()

    async def worker_cycle(self, reason=None, status="Active", exception=None):
        job = self.job("WelcomeEmail")
        self.policy.status = status
        self.session.exec.side_effect = [Result([job]), Result([self.policy])]
        self.session.commit = AsyncMock()
        @asynccontextmanager
        async def scope(): yield self.session
        self.session.begin_nested = scope
        with patch.object(delivery, "execute_job", AsyncMock(return_value=reason, side_effect=exception)) as execute:
            await delivery.run_delivery_cycle(scope, limit=1)
        return job, execute

    async def test_worker_retries_failure(self):
        job, _ = await self.worker_cycle("Email delivery failed")
        self.assertEqual(job.status, "Retry")
        self.assertEqual(job.attempts, 1)
        self.assertGreater(job.next_attempt_at, datetime.utcnow())
        self.assertIsNone(job.completed_at)

    async def test_worker_completes_success(self):
        job, _ = await self.worker_cycle()
        self.assertEqual(job.status, "Completed")
        self.assertIsNotNone(job.completed_at)

    async def test_worker_does_not_email_cancelled_policy(self):
        job, execute = await self.worker_cycle(status="Cancelled")
        self.assertEqual(job.status, "Skipped")
        execute.assert_not_awaited()

    async def test_generation_exception_is_retriable(self):
        with patch.object(delivery.log, "exception"):
            job, _ = await self.worker_cycle(exception=RuntimeError("renderer unavailable"))
        self.assertEqual(job.status, "Retry")
