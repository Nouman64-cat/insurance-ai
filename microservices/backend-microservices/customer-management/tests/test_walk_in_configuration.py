"""Registration setup errors must not be presented as an unknown email/customer."""
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
from fastapi import FastAPI

from app.config import settings
from app.errors import ApiError, api_error_handler
from app.routers import walk_in


class WalkInConfiguration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.code = settings.walkin_tenant_code
        self.demo = settings.demo
        object.__setattr__(settings, 'walkin_tenant_code', 'CONFIGURED')
        object.__setattr__(settings, 'demo', True)
        walk_in._tenant_cache.clear()
        self.tenant = AsyncMock()
        self.patch = patch.object(walk_in.tenant_client, 'get_client', return_value=self.tenant)
        self.patch.start()
        app = FastAPI()
        app.include_router(walk_in.router)
        app.add_exception_handler(ApiError, api_error_handler)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test')

    async def asyncTearDown(self):
        await self.client.aclose()
        self.patch.stop()
        walk_in._tenant_cache.clear()
        object.__setattr__(settings, 'walkin_tenant_code', self.code)
        object.__setattr__(settings, 'demo', self.demo)

    async def test_missing_tenant_or_adapter_returns_registration_unavailable(self):
        self.tenant.get.side_effect = ApiError(404, 'NOT_FOUND', 'Record not found')
        for method, path, body in (
            ('GET', '/v1/walk-in/plans', None),
            ('POST', '/v1/walk-in/otp/request', {'email': 'new@example.com'}),
            ('POST', '/v1/walk-in/otp/verify', {'email': 'new@example.com'}),
        ):
            response = await self.client.request(method, path, **({'json': body} if body else {}))
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()['error']['code'], 'WALK_IN_UNAVAILABLE')
        self.assertEqual(walk_in._tenant_cache, {})
        self.tenant.post.assert_not_called()

    async def test_unconfigured_tenant_never_uses_another_insurer(self):
        object.__setattr__(settings, 'walkin_tenant_code', '')
        response = await self.client.post('/v1/walk-in/otp/request', json={'email': 'new@example.com'})
        self.assertEqual(response.status_code, 503)
        self.tenant.get.assert_not_called()

    async def test_new_email_is_allowed_when_tenant_resolves(self):
        tid = str(uuid4())
        self.tenant.get.return_value = {'tenant_id': tid}
        response = await self.client.post('/v1/walk-in/otp/request', json={'email': 'brand-new@example.com'})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['demo'])
        self.tenant.get.assert_awaited_once_with(f'{walk_in.PREFIX}/tenant', code='CONFIGURED')
        self.assertEqual(await walk_in.tenant_id(), tid)
        self.tenant.get.assert_awaited_once()  # cached only after successful resolution

    async def test_other_upstream_errors_are_not_changed(self):
        self.tenant.get.side_effect = ApiError(503, 'DOMAIN_UNAVAILABLE', 'Unavailable')
        response = await self.client.post('/v1/walk-in/otp/request', json={'email': 'new@example.com'})
        self.assertEqual(response.json()['error']['code'], 'DOMAIN_UNAVAILABLE')
