"""Chat uses the same schedule credit and balance as manual policy payments; no gateway calls."""
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4
from fastapi import HTTPException
from routers import policies

class ChatPaymentBalanceTests(IsolatedAsyncioTestCase):
    async def test_initiation_exposes_credit_and_collects_only_remaining_balance(self):
        policy = SimpleNamespace(status="PendingPayment")
        schedule = SimpleNamespace(amount_due=128593.83,amount_paid=23380.70,payment_reference=None)
        session = SimpleNamespace(refresh=AsyncMock(),commit=AsyncMock(),add=Mock())
        intent = SimpleNamespace(reference="TEST-ONLY",to_dict=lambda:{"reference":"TEST-ONLY"})
        with patch.object(policies,"_get_policy",AsyncMock(return_value=policy)), patch.object(policies,"_pending_schedule",AsyncMock(return_value=schedule)), patch.object(policies.payment_gateway,"initiate_payment",Mock(return_value=intent)) as gateway, patch.object(policies.payment_gateway,"available_methods",return_value=[]):
            result = await policies.initiate_payment(uuid4(),uuid4(),policies.PaymentInitiateRequest(),session=session)
        self.assertEqual(result["amount_already_paid"],23380.70)
        self.assertEqual(result["premium_total"],128593.83)
        self.assertEqual(result["amount_due"],105213.13)
        self.assertEqual(gateway.call_args.args[0],105213.13)
