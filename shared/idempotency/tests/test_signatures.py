import unittest
from shared.security.service_auth import sign, verify

class BoundSignatureTests(unittest.TestCase):
    def test_operation_and_tenant_headers_cannot_be_changed(self):
        headers=sign('test-secret','POST','/tickets',b'{}',caller='customer-management',now=100,
                     bound_headers={'Idempotency-Key':'operation-123','x-portal-tenant':'tenant-a','x-portal-customer':'customer-a'})
        self.assertTrue(verify('test-secret','POST','/tickets',b'{}',headers,now=100))
        for name in ('Idempotency-Key','x-portal-tenant','x-portal-customer','X-Service-Caller','X-Service-Signature-Version'):
            changed={**headers,name:'tampered'}
            self.assertFalse(verify('test-secret','POST','/tickets',b'{}',changed,now=100),name)
        stripped={k:v for k,v in headers.items() if k!='X-Service-Signature-Version'}
        self.assertFalse(verify('test-secret','POST','/tickets',b'{}',stripped,now=100))

    def test_legacy_callers_keep_their_original_signature_contract(self):
        headers=sign('test-secret','GET','/health',now=100)
        self.assertTrue(verify('test-secret','GET','/health',b'',headers,now=100))
        self.assertFalse(verify('test-secret','GET','/health',b'',headers,now=500))
