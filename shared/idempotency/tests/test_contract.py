import unittest
from starlette.requests import Request
from unittest.mock import patch
from shared.idempotency import validate_key, fingerprint, IdempotencyError
from shared.idempotency.http import key_from_request

class ContractTests(unittest.TestCase):
    def test_rejects_missing_and_malformed_keys(self):
        for key in (None, '', 'short', 'a b c d e', ' xxxxxxxx', 'x'*129, 'ümlaut123'):
            with self.subTest(key=key), self.assertRaises(IdempotencyError):
                validate_key(key)
        self.assertEqual(validate_key('operation-123'), 'operation-123')

    def test_only_header_is_read(self):
        req = Request({'type': 'http', 'headers': [], 'query_string': b'idempotency_key=operation-123'})
        with patch.dict('os.environ', {'IDEMPOTENCY_ENFORCEMENT': 'required'}), self.assertRaises(IdempotencyError) as ctx:
            key_from_request(req, 'test')
        self.assertEqual(ctx.exception.status, 400)

    def test_duplicate_headers_rejected(self):
        req = Request({'type': 'http', 'headers': [(b'idempotency-key', b'operation-123')]*2})
        with self.assertRaises(IdempotencyError): key_from_request(req, 'test')

    def test_fingerprint_is_order_independent_but_actor_sensitive(self):
        self.assertEqual(fingerprint({'b': 2, 'a': 1}, actor_id='a'), fingerprint({'a': 1, 'b': 2}, actor_id='a'))
        self.assertNotEqual(fingerprint({'a': 1}, actor_id='a'), fingerprint({'a': 1}, actor_id='b'))
