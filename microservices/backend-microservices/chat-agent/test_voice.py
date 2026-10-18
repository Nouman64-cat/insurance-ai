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
        with patch.object(voice, 'voice_settings', new=AsyncMock()) as key:
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
            settings = await voice.voice_settings()
            self.assertEqual(settings['key'], 'test-private-key')
            self.assertEqual((settings['model'], settings['voice'], settings['transcription_model']), ('gpt-realtime-2.1-mini', 'cedar', 'gpt-transcribe'))

    async def test_dedicated_key_takes_precedence(self):
        with patch.dict(os.environ, {'OPENAI_REALTIME_API_KEY': 'dedicated', 'OPENAI_API_KEY': 'general'}), \
                patch.object(voice, 'resolve', new=AsyncMock(return_value={})):
            self.assertEqual((await voice.voice_settings())['key'], 'dedicated')

    async def test_live_voice_choice_wins(self):
        """A model, voice and transcription model chosen on the LLM Configuration page beat the env and defaults."""
        chosen = {'provider': 'openai', 'model': 'gpt-realtime-2.2', 'api_key': 'stored-key', 'voice': 'marin', 'transcription_model': 'gpt-transcribe-2'}
        with patch.dict(os.environ, {'OPENAI_REALTIME_API_KEY': 'dedicated', 'OPENAI_REALTIME_VOICE': 'cedar'}), \
                patch.object(voice, 'resolve', new=AsyncMock(return_value={'live_voice': chosen})):
            self.assertEqual(await voice.voice_settings(), {'key': 'stored-key', 'model': 'gpt-realtime-2.2', 'voice': 'marin', 'transcription_model': 'gpt-transcribe-2'})

    async def test_missing_key_reports_configuration(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(voice, 'resolve', new=AsyncMock(return_value={})):
            with self.assertRaises(HTTPException) as error: await voice.voice_settings()
            self.assertEqual(error.exception.status_code, 503)

    async def test_sdp_exchange_keeps_key_server_side_and_model_pinned(self):
        client = self.client(httpx.Response(201, text='v=0\r\nanswer'))
        with patch.object(voice, 'voice_user', new=AsyncMock(return_value={'id': 'user-1'})), patch.object(voice, 'voice_settings', new=AsyncMock(return_value={'key': 'PRIVATE', 'model': 'gpt-realtime-2.1-mini', 'voice': 'cedar', 'transcription_model': 'gpt-transcribe'})), patch.object(voice.httpx, 'AsyncClient', return_value=client):
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

    async def test_sdp_exchange_uses_the_chosen_model_voice_and_transcription(self):
        client = self.client(httpx.Response(201, text='v=0\r\nanswer'))
        chosen = {'key': 'K', 'model': 'gpt-realtime-2.2', 'voice': 'marin', 'transcription_model': 'gpt-transcribe-2'}
        with patch.object(voice, 'voice_user', new=AsyncMock(return_value={'id': 'u'})), patch.object(voice, 'voice_settings', new=AsyncMock(return_value=chosen)), patch.object(voice.httpx, 'AsyncClient', return_value=client):
            await voice.voice_session(voice.VoiceSessionRequest(sdp='v=0\r\n'+'x'*30), 'Bearer s', 't')
            import json
            config = json.loads(client.post.call_args.kwargs['files']['session'][1])
            self.assertEqual(config['model'], 'gpt-realtime-2.2')
            self.assertEqual(config['audio']['output']['voice'], 'marin')
            self.assertEqual(config['audio']['input']['transcription']['model'], 'gpt-transcribe-2')
            self.assertEqual(client.post.call_args.kwargs['headers']['Authorization'], 'Bearer K')

    async def test_provider_errors_do_not_leak_payloads(self):
        for code, expected in [(401,502),(403,502),(404,502),(429,429),(500,502)]:
            with self.assertRaises(HTTPException) as error: voice.provider_error(httpx.Response(code, text='SECRET'))
            self.assertEqual(error.exception.status_code, expected)
            self.assertNotIn('SECRET', error.exception.detail)

    async def test_invalid_offer_does_not_create_call(self):
        with patch.object(voice, 'voice_user', new=AsyncMock(return_value={'id': 'u'})), patch.object(voice, 'voice_settings', new=AsyncMock()) as key:
            with self.assertRaises(HTTPException) as error: await voice.voice_session(voice.VoiceSessionRequest(sdp='invalid'*5))
            self.assertEqual(error.exception.status_code, 422)
            key.assert_not_awaited()


class MeteringTests(unittest.IsolatedAsyncioTestCase):
    """Live voice usage reaches the Token Economy: the call's responses, its captions and voice messages."""

    async def test_meter_records_responses_and_captions_until_the_call_ends(self):
        import json
        events = [
            {'type': 'session.created'},
            {'type': 'response.done', 'response': {'usage': {
                'total_tokens': 673, 'input_tokens': 600, 'output_tokens': 73,
                'input_token_details': {'text_tokens': 590, 'audio_tokens': 10, 'cached_tokens': 64, 'cached_tokens_details': {'text_tokens': 64, 'audio_tokens': 0}},
                'output_token_details': {'text_tokens': 37, 'audio_tokens': 36}}}},
            {'type': 'conversation.item.input_audio_transcription.completed', 'usage': {'type': 'duration', 'seconds': 3}},
        ]

        class Socket:
            def __init__(self): self.frames = [json.dumps(e) for e in events]
            async def __aenter__(self): return self
            async def __aexit__(self, *exc): return False
            def __aiter__(self): return self
            async def __anext__(self):
                if not self.frames: raise StopAsyncIteration  # the call ended
                return self.frames.pop(0)

        settings = {'key': 'K', 'model': 'gpt-realtime-2.1-mini', 'voice': 'cedar', 'transcription_model': 'gpt-transcribe'}
        with patch.object(voice.websockets, 'connect', return_value=Socket()) as connect, patch.object(voice.usage, 'record_counts') as record:
            await voice.meter_call('rtc_123', settings, 'tenant-1')
        self.assertEqual(connect.call_args.args[0], 'wss://api.openai.com/v1/realtime?call_id=rtc_123')
        self.assertEqual(connect.call_args.kwargs['additional_headers'], {'Authorization': 'Bearer K'})
        (call_counts, call_kw), (caption_counts, caption_kw) = [(c.args[0], c.kwargs) for c in record.call_args_list]
        self.assertEqual(call_counts, {'input_tokens': 600, 'output_tokens': 73, 'cached_tokens': 64, 'audio_input_tokens': 10,
                                       'audio_output_tokens': 36, 'audio_cached_tokens': 0, 'total_tokens': 673})
        self.assertEqual((call_kw['service_name'], call_kw['model_name'], call_kw['tenant_id']), ('Live Voice', 'gpt-realtime-2.1-mini', 'tenant-1'))
        self.assertEqual(caption_counts, {'audio_seconds': 3.0})
        self.assertEqual((caption_kw['service_name'], caption_kw['model_name']), ('Live Voice — Captions', 'gpt-transcribe'))

    async def test_meter_failure_never_raises(self):
        with patch.object(voice.websockets, 'connect', side_effect=OSError('network down')):
            await voice.meter_call('rtc_1', {'key': 'K', 'model': 'm', 'voice': 'v', 'transcription_model': 't'}, 't')

    async def test_session_starts_the_meter_with_the_call_id(self):
        client = AsyncMock()
        client.post.return_value = httpx.Response(201, text='v=0\r\nanswer', headers={'Location': '/v1/realtime/calls/rtc_abc'})
        client.__aenter__.return_value = client
        settings = {'key': 'K', 'model': 'gpt-realtime-2.1-mini', 'voice': 'cedar', 'transcription_model': 'gpt-transcribe'}
        with patch.object(voice, 'voice_user', new=AsyncMock(return_value={'id': 'u'})), patch.object(voice, 'voice_settings', new=AsyncMock(return_value=settings)), \
                patch.object(voice.httpx, 'AsyncClient', return_value=client), patch.object(voice, 'start_meter') as start:
            await voice.voice_session(voice.VoiceSessionRequest(sdp='v=0\r\n'+'x'*30), 'Bearer s', 'tenant-9')
        start.assert_called_once_with('rtc_abc', settings, 'tenant-9')

    def test_transcription_usage_formats(self):
        self.assertEqual(voice.usage.transcription_usage({'type': 'duration', 'seconds': 2}), {'audio_seconds': 2.0})
        self.assertEqual(voice.usage.transcription_usage({'type': 'tokens', 'total_tokens': 29, 'input_tokens': 18, 'output_tokens': 11,
                                                          'input_token_details': {'text_tokens': 0, 'audio_tokens': 18}}),
                         {'input_tokens': 18, 'output_tokens': 11, 'audio_input_tokens': 18, 'total_tokens': 29})
        self.assertIsNone(voice.usage.transcription_usage({}))


if __name__ == '__main__': unittest.main(verbosity=2)


def test_voice_languages_prefer_urdu_and_english_without_hindi():
    chosen = {'model': 'gpt-realtime-2.1-mini', 'voice': 'cedar', 'transcription_model': 'gpt-transcribe'}
    config = voice.session_config('en', chosen)
    assert config['audio']['input']['transcription']['languages'] == ['ur', 'en']
    assert 'اردو' in config['audio']['input']['transcription']['prompt']
    assert 'CURRENT AUDIO' in config['instructions']
    assert 'portal locale sets only the opening greeting' in config['instructions']
    assert 'never Hindi or Devanagari' in config['instructions']


def test_transcription_hints_preserve_selected_model_compatibility():
    assert voice.transcription_config('gpt-4o-transcribe')['model'] == 'gpt-4o-transcribe'
    assert 'languages' not in voice.transcription_config('gpt-4o-transcribe')
    assert voice.transcription_config('gpt-live-transcribe')['languages'] == ['ur', 'en']
    assert voice.transcription_config('gpt-realtime-whisper') == {'model': 'gpt-realtime-whisper'}
