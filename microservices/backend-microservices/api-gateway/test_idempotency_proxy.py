"""The gateway is a transparent hop for idempotency: it forwards the key and returns the replay markers."""
import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import main


class Proxy(unittest.TestCase):
    def test_key_goes_upstream_and_replay_headers_come_back(self):
        seen = {}

        def upstream(request: httpx.Request):
            seen['key'] = request.headers.get('idempotency-key')
            seen['auth'] = request.headers.get('authorization')
            return httpx.Response(409, json={'detail': {'code': 'IDEMPOTENCY_IN_PROGRESS'}},
                                  headers={'Retry-After': '2', 'Idempotency-Replayed': 'true'})
        real = httpx.AsyncClient

        def client_with_transport(*args, **kwargs):
            return real(*args, transport=httpx.MockTransport(upstream), **kwargs)
        app = FastAPI()

        @app.post('/tenants/{tenant_id}/payments')
        async def hop(request: Request):
            return await main._proxy_to_tenant(request, 'http://tenant-service:8001/tenants/t/payments')
        with patch.object(main.httpx, 'AsyncClient', client_with_transport):
            r = TestClient(app).post('/tenants/t/payments', json={}, headers={'Idempotency-Key': 'gateway-operation-1', 'Authorization': 'Bearer x'})
        self.assertEqual(seen, {'key': 'gateway-operation-1', 'auth': 'Bearer x'})
        self.assertEqual((r.status_code, r.headers['retry-after'], r.headers['idempotency-replayed']), (409, '2', 'true'))


if __name__ == '__main__':
    unittest.main()
