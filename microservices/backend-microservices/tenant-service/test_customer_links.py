from datetime import datetime
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from services import customer_links


class CustomerLinkEmailTests(IsolatedAsyncioTestCase):
    def session(self, details):
        customer = SimpleNamespace(name="Usman Farooq", details=details)
        tenant = SimpleNamespace(name="Crescent Life", contact_phone=None, contact_email=None)
        return SimpleNamespace(get=AsyncMock(side_effect=lambda model, _id: customer if model.__name__ == "Customer" else tenant))

    def case(self):
        return SimpleNamespace(customer_id=uuid4(), caseNumber="CASE-1")

    async def test_no_address_on_record_sends_nothing(self):
        with patch("email_utils.send_email", AsyncMock()) as send:
            out = await customer_links.email_customer_link(
                self.session({}), kind="e_application", tenant_id=uuid4(), case=self.case(),
                link_path="/e-application/abc", expires_at=datetime(2026, 10, 21))
        self.assertEqual(out, {"emailed_to": None, "email_status": "no_email"})
        send.assert_not_awaited()

    async def test_link_is_emailed_with_the_public_url(self):
        with patch("email_utils.send_email", AsyncMock(return_value=True)) as send:
            out = await customer_links.email_customer_link(
                self.session({"contact_email": "usman@example.com"}), kind="medical_exam", tenant_id=uuid4(),
                case=self.case(), link_path="/medical-exam/abc", expires_at=datetime(2026, 11, 4), tests=["Lipid Profile"])
        self.assertEqual(out, {"emailed_to": "usman@example.com", "email_status": "sent"})
        to, subject, text, html = send.await_args.args
        self.assertEqual(to, "usman@example.com")
        self.assertIn(f"{customer_links.PORTAL_PUBLIC_URL}/medical-exam/abc", text)
        self.assertIn("Lipid Profile", html)

    async def test_mail_failure_is_reported_not_raised(self):
        with patch("email_utils.send_email", AsyncMock(return_value=False)):
            out = await customer_links.email_customer_link(
                self.session({"email": "u@example.com"}), kind="e_application", tenant_id=uuid4(), case=self.case(),
                link_path="/e-application/abc", expires_at=datetime(2026, 10, 21))
        self.assertEqual(out["email_status"], "failed")
