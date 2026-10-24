import json
import os
import unittest
from unittest.mock import patch

import httpx

from docforensics import platform_client as pc
from docforensics.gemini_client import BadRequest, Reply, Request


class PlatformClientTests(unittest.TestCase):
    def config(self, provider="gemini", key="central-secret", model="central-vision"):
        return {"provider": provider, "api_key": key, "model": model}

    def test_central_model_and_key_override_environment_without_mutation(self):
        with patch.dict(os.environ, {"GEMINI_API_KEY":"env-secret", "GEMINI_MODEL":"env-model"}), patch.object(pc,"_sdk_transport",return_value=Reply('ok','STOP',tokens_in=4,tokens_out=2)) as sdk:
            first=pc.make_platform_client(self.config())
            second=pc.make_platform_client(self.config(key="second-key",model="second-model"))
            first.generate(Request('read',[]))
            second.generate(Request('read',[]))
            self.assertEqual([c.kwargs['api_key'] for c in sdk.call_args_list],['central-secret','second-key'])
            self.assertEqual(first.calls[0].model,'central-vision')
            self.assertEqual(second.calls[0].model,'second-model')
            self.assertEqual(os.environ['GEMINI_API_KEY'],'env-secret')

    def test_provider_images_and_reported_tokens(self):
        for provider in ('openai','anthropic'):
            captured=[]
            def handle(req):
                captured.append(req)
                if provider == 'openai':
                    return httpx.Response(200,json={'choices':[{'message':{'content':'{"ok":true}'},'finish_reason':'stop'}], 'usage':{'prompt_tokens':11,'completion_tokens':3}})
                return httpx.Response(200,json={'content':[{'type':'text','text':'{"ok":true}'}], 'stop_reason':'end_turn', 'usage':{'input_tokens':5,'cache_read_input_tokens':4,'cache_creation_input_tokens':2,'output_tokens':3}})
            http=httpx.Client(transport=httpx.MockTransport(handle))
            with patch.object(pc.httpx,'Client',return_value=http):
                client=pc.make_platform_client(self.config(provider))
                self.assertEqual(client.generate_json(Request('read',[(b'png','image/png')],json_mode=True)),{'ok':True})
            self.assertEqual(client.calls[0].tokens_in,11)
            self.assertEqual(client.calls[0].tokens_out,3)
            body=json.loads(captured[0].content)
            self.assertEqual(body['model'],'central-vision')
            self.assertIn('cG5n',str(body))
            self.assertIn('central-secret',captured[0].headers.get('authorization') or captured[0].headers.get('x-api-key'))

    def test_provider_errors_do_not_disclose_credentials(self):
        http=httpx.Client(transport=httpx.MockTransport(lambda req:httpx.Response(400,text='central-secret')))
        with patch.object(pc.httpx,'Client',return_value=http):
            client=pc.make_platform_client(self.config('openai'))
            with self.assertRaises(BadRequest) as raised:
                client.generate(Request('read',[]))
        self.assertNotIn('central-secret',str(raised.exception))
        self.assertNotIn('central-secret',str(client.calls))
