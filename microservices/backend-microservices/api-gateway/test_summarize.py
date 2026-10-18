"""Gateway authentication, RBAC and proxy contract; no LLM, DB or Kafka calls."""
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jose import jwt

from database import get_session
from dependencies import JWT_ALGORITHM, JWT_SECRET_KEY
from routers import summarize
from shared.models.core import Role


class SummarizeGatewayTests(unittest.TestCase):
    def setUp(self):
        self.user = SimpleNamespace(id=str(uuid4()), role_id=uuid4(), is_active=True, is_deleted=False, status="ACTIVE")
        self.role = 'Underwriter'
        self.calls = []
        self.upstream_status = 200
        self.upstream_body = b'{"summary":"Draft note","token_usage":{"total_tokens":12}}'
        self.upstream_type = 'application/json'
        owner = self

        class Session:
            async def get(self, model, key):
                return SimpleNamespace(name=owner.role) if model is Role else owner.user

        async def session():
            yield Session()

        app = FastAPI()
        app.include_router(summarize.router)
        app.dependency_overrides[get_session] = session
        self.client = TestClient(app)
        real_client = httpx.AsyncClient

        def upstream(request):
            self.calls.append(request)
            return httpx.Response(self.upstream_status, content=self.upstream_body,
                                  headers={'Content-Type': self.upstream_type})

        self.patch = patch.object(summarize.httpx, 'AsyncClient',
                                  side_effect=lambda **kw: real_client(transport=httpx.MockTransport(upstream), **kw))
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.addCleanup(self.client.close)

    def headers(self, **claims):
        payload = {'sub': self.user.id, 'exp': datetime.now(timezone.utc) + timedelta(minutes=5)}
        payload.update(claims)
        return {'Authorization': 'Bearer ' + jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)}

    def test_no_token_invalid_and_expired_tokens_never_call_llm(self):
        for headers in ({}, {'Authorization': 'Bearer invalid'}, self.headers(exp=0)):
            for path in ('/summarize/underwriter-note', '/summarize/underwriting', '/summarize/stream', '/summarize'):
                self.assertEqual(self.client.post(path, headers=headers, json={'context': 'case'}).status_code, 401)
        self.assertEqual(self.calls, [])

    def test_forbidden_roles_and_inactive_accounts_never_call_llm(self):
        for role in ('Customer', 'Agent', 'Finance', 'Viewer'):
            self.role = role
            self.assertEqual(self.client.post('/summarize/underwriter-note', headers=self.headers(), json={}).status_code, 403)
        self.role = 'Underwriter'
        self.user.is_active = False
        self.assertEqual(self.client.post('/summarize/stream', headers=self.headers(), json={}).status_code, 403)
        self.user.is_active = True
        self.user.is_deleted = True
        self.assertEqual(self.client.post('/summarize/underwriter-note', headers=self.headers(), json={}).status_code, 403)
        self.user.is_deleted = False
        self.user.status = 'SUSPENDED'
        self.assertEqual(self.client.post('/summarize/underwriter-note', headers=self.headers(), json={}).status_code, 403)
        self.assertEqual(self.calls, [])

    def test_authenticated_underwriting_roles_preserve_contract(self):
        payload = {'context': 'Customer and risk evidence', 'max_words': 200}
        for role in ('Admin', 'SuperAdmin', 'Underwriter', 'Medical Underwriter', 'Financial Underwriter', 'ClaimsManager'):
            self.role = role
            response = self.client.post('/summarize/underwriter-note', headers=self.headers(), json=payload)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.content, self.upstream_body)
            request = self.calls[-1]
            self.assertEqual(str(request.url), 'http://text-summarizer:8005/summarize/underwriter-note')
            import json
            self.assertEqual(json.loads(request.content), payload)
            self.assertNotIn('authorization', request.headers)

    def test_upstream_validation_errors_are_preserved(self):
        self.upstream_status = 422
        self.upstream_body = b'{"detail":[{"msg":"context required"}]}'
        response = self.client.post('/summarize/underwriter-note', headers=self.headers(), json={})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.content, self.upstream_body)

    def test_existing_document_and_stream_contracts(self):
        for path in ('/summarize', '/summarize/underwriting'):
            self.assertEqual(self.client.post(path, headers=self.headers(), json={'documents': ['evidence']}).status_code, 200)
            self.assertTrue(str(self.calls[-1].url).endswith(path))
        self.upstream_body = b'data: {"type":"chunk","text":"Draft"}\n\ndata: {"type":"done","token_usage":{}}\n\n'
        self.upstream_type = 'text/event-stream'
        response = self.client.post('/summarize/stream', headers=self.headers(), json={'documents': ['evidence']})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, self.upstream_body)
        self.assertEqual(response.headers['x-accel-buffering'], 'no')
        self.upstream_status = 400
        self.upstream_type = 'application/json'
        self.upstream_body = b'{"detail":"Documents list must not be empty."}'
        response = self.client.post('/summarize/stream', headers=self.headers(), json={'documents': []})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.content, self.upstream_body)

    def test_upstream_failure_is_controlled(self):
        self.patch.stop()
        for error, status in ((httpx.ConnectError('offline'), 502), (httpx.ReadTimeout('timeout'), 504)):
            with patch.object(summarize.httpx, 'AsyncClient') as client:
                client.return_value.__aenter__.return_value.post.side_effect = error
                response = self.client.post('/summarize/underwriter-note', headers=self.headers(), json={'context': 'case'})
                self.assertEqual(response.status_code, status)


if __name__ == '__main__':
    unittest.main()
