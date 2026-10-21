import unittest
from shared.idempotency import IdempotencyError
from shared.idempotency.external import execute_external, ProviderResult
from . import test_postgres


class Provider:
    def __init__(self): self.calls=0; self.result=None; self.timeout=True
    async def submit(self, reference, payload):
        self.calls+=1
        self.result=ProviderResult('COMPLETED', reference, {'reference':reference,'amount':payload['amount']})
        if self.timeout: raise TimeoutError('response lost after provider charged')
        return self.result
    async def lookup(self, reference): return self.result


class ExternalTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp=test_postgres.PostgresTests.asyncSetUp
    asyncTearDown=test_postgres.PostgresTests.asyncTearDown

    async def test_timeout_reconciles_original_reference_without_second_charge(self):
        p=Provider()
        args=dict(scope_id='tenant:a',operation='payment',key='operation-123', business_id='installment-1',
                  actor_id='actor',payload={'amount':10},receipt_fields=('reference','amount'),http_status=201)
        with self.assertRaises(IdempotencyError): await execute_external(self.engine,p,**args)
        status,receipt=await execute_external(self.engine,p,**args)
        self.assertEqual((status,receipt['amount'],p.calls),(201,10,1))
        await execute_external(self.engine,p,**args)
        self.assertEqual(p.calls,1)

    async def test_changed_payload_cannot_reconcile_another_charge(self):
        p=Provider()
        args=dict(scope_id='tenant:a',operation='payment',key='operation-123',business_id='installment-1',
                  actor_id='actor',payload={'amount':10},receipt_fields=('reference','amount'))
        with self.assertRaises(IdempotencyError): await execute_external(self.engine,p,**args)
        with self.assertRaises(IdempotencyError) as ctx:
            await execute_external(self.engine,p,**(args|{'payload':{'amount':20}}))
        self.assertEqual(ctx.exception.code,'IDEMPOTENCY_CONFLICT')
        self.assertEqual(p.calls,1)
