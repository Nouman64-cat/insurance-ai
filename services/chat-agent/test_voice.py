"""Voice auth and provider-boundary tests; no live provider or DB writes."""
import os
import unittest
from unittest.mock import AsyncMock, patch
import httpx
from fastapi import HTTPException
from routers import voice


class VoiceTests(unittest.IsolatedAsyncioTestCase):
    def client(self, response):
        client = AsyncMock()
        client.get.return_value = response
        client.post.return_value = response
        client.__aenter__.return_value = client
        return client

    async def test_unauthenticated_never_contacts_provider(self):
        with patch.object(voice, 'voice_key', new=AsyncMock()) as key:
            with self.assertRaises(HTTPException) as error:
                await voice.voice_session(voice.VoiceSessionRequest(sdp='v=0\r\n' + 'x'*30), '', '')
            self.assertEqual(error.exception.status_code, 401)
            key.assert_not_awaited()

    async def test_identity_and_tenant_checked_server_side(self):
        response = httpx.Response(200, json={'id': 'u1', 'tenant_id': 't1', 'role_name': 'Agent', 'is_active': True, 'status': 'ACTIVE'})
        with patch.object(voice.httpx, 'AsyncClient', return_value=self.client(response)):
            self.assertEqual((await voice.voice_user('Bearer test', 't1'))['id'], 'u1')
            with self.assertRaises(HTTPException) as error: await voice.voice_user('Bearer test', 't2')
            self.assertEqual(error.exception.status_code, 403)

    async def test_inactive_and_expired_session_rejected(self):
        for response, status in [(httpx.Response(401), 401), (httpx.Response(200, json={'is_active': False, 'status': 'ACTIVE'}), 403)]:
            with patch.object(voice.httpx, 'AsyncClient', return_value=self.client(response)):
                with self.assertRaises(HTTPException) as error: await voice.voice_user('Bearer test', 't1')
                self.assertEqual(error.exception.status_code, status)

    async def test_openai_key_uses_registered_provider(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(voice, 'resolve', new=AsyncMock(return_value={
            'primary': {'provider': 'gemini', 'api_key': 'not-openai'}, 'fallback': {'provider': 'openai', 'api_key': 'test-private-key'},
        })):
            self.assertEqual(await voice.voice_key(), 'test-private-key')

    async def test_dedicated_key_takes_precedence(self):
        with patch.dict(os.environ, {'OPENAI_REALTIME_API_KEY': 'dedicated', 'OPENAI_API_KEY': 'general'}):
            self.assertEqual(await voice.voice_key(), 'dedicated')

    async def test_missing_key_reports_configuration(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(voice, 'resolve', new=AsyncMock(return_value={})):
            with self.assertRaises(HTTPException) as error: await voice.voice_key()
            self.assertEqual(error.exception.status_code, 503)

    async def test_sdp_exchange_keeps_key_server_side_and_model_pinned(self):
        client = self.client(httpx.Response(201, text='v=0\r\nanswer'))
        with patch.object(voice, 'voice_user', new=AsyncMock(return_value={'id': 'user-1'})), patch.object(voice, 'voice_key', new=AsyncMock(return_value='PRIVATE')), patch.object(voice.httpx, 'AsyncClient', return_value=client):
            response = await voice.voice_session(voice.VoiceSessionRequest(sdp='v=0\r\n'+'x'*30, locale='ur'), 'Bearer session', 'tenant')
            self.assertEqual(response.body, b'v=0\r\nanswer')
            self.assertNotIn(b'PRIVATE', response.body)
            call = client.post.call_args
            self.assertEqual(call.args[0], 'https://api.openai.com/v1/realtime/calls')
            import json
            config = json.loads(call.kwargs['files']['session'][1])
            self.assertEqual(config['model'], 'gpt-realtime-2.1-mini')
            self.assertEqual([t['name'] for t in config['tools']], ['platform_request'])
            self.assertTrue(config['audio']['input']['turn_detection']['interrupt_response'])
            self.assertIn('Start in Urdu', config['instructions'])
            self.assertNotEqual(call.kwargs['headers']['OpenAI-Safety-Identifier'], 'user-1')

    async def test_provider_errors_do_not_leak_payloads(self):
        for code, expected in [(401,502),(403,502),(404,502),(429,429),(500,502)]:
            with self.assertRaises(HTTPException) as error: voice.provider_error(httpx.Response(code, text='SECRET'))
            self.assertEqual(error.exception.status_code, expected)
            self.assertNotIn('SECRET', error.exception.detail)

    async def test_invalid_offer_does_not_create_call(self):
        with patch.object(voice, 'voice_user', new=AsyncMock(return_value={'id': 'u'})), patch.object(voice, 'voice_key', new=AsyncMock()) as key:
            with self.assertRaises(HTTPException) as error: await voice.voice_session(voice.VoiceSessionRequest(sdp='invalid'*5))
            self.assertEqual(error.exception.status_code, 422)
            key.assert_not_awaited()


if __name__ == '__main__': unittest.main(verbosity=2)
