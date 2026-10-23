"""CORS policy checks without database, Kafka or service startup."""
import unittest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
from cors_config import cors_options

ORIGINS = [f"https://{name}.getinsuredai.com" for name in ("app", "ai", "underwriting", "claims", "customer", "support", "requests")]

class Cors(unittest.TestCase):
    def client(self, value):
        app = FastAPI()
        app.add_middleware(CORSMiddleware, **cors_options(value))
        @app.get('/health')
        def health(): return {'ok': True}
        return TestClient(app)

    def test_all_seven_frontends_allow_credentialed_preflight(self):
        client = self.client(','.join(ORIGINS))
        for origin in ORIGINS:
            with self.subTest(origin=origin):
                response = client.options('/tenants/example/claims', headers={
                    'Origin': origin, 'Access-Control-Request-Method': 'POST',
                    'Access-Control-Request-Headers': 'authorization,content-type,x-tenant-id,last-event-id'})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers['access-control-allow-origin'], origin)
                self.assertEqual(response.headers['access-control-allow-credentials'], 'true')
                self.assertIn('Origin', response.headers['vary'])
                self.assertIn('x-tenant-id', response.headers['access-control-allow-headers'])

    def test_idempotency_header_is_allowed_in_and_exposed_from_cross_origin_calls(self):
        client = self.client(','.join(ORIGINS))
        preflight = client.options('/health', headers={'Origin': ORIGINS[0], 'Access-Control-Request-Method': 'POST',
                                                       'Access-Control-Request-Headers': 'idempotency-key,authorization'})
        self.assertEqual(preflight.status_code, 200)
        self.assertIn('idempotency-key', preflight.headers['access-control-allow-headers'].lower())
        options = cors_options(','.join(ORIGINS))
        self.assertTrue({'Idempotency-Replayed', 'Retry-After'} <= set(options['expose_headers']))
        simple = client.get('/health', headers={'Origin': ORIGINS[0]})
        self.assertIn('idempotency-replayed', simple.headers['access-control-expose-headers'].lower())

    def test_unlisted_origins_and_lookalike_domains_are_rejected(self):
        client = self.client(','.join(ORIGINS))
        for origin in ['https://evil.example', 'https://app.getinsuredai.com.evil.example', 'http://app.getinsuredai.com', 'http://localhost:3000', 'null']:
            response = client.options('/health', headers={'Origin': origin, 'Access-Control-Request-Method': 'GET'})
            self.assertEqual(response.status_code, 400)
            self.assertNotIn('access-control-allow-origin', response.headers)

    def test_unicode_whitespace_duplicates_empty_entries_and_trailing_slash(self):
        options = cors_options(f' , {ORIGINS[0]}/, {ORIGINS[-1]}\u00a0, {ORIGINS[0]}, ')
        self.assertEqual(options['allow_origins'], [ORIGINS[0], ORIGINS[-1]])
        self.assertIsNone(options['allow_origin_regex'])

    def test_normal_and_error_responses_keep_origin_header(self):
        client = self.client(','.join(ORIGINS))
        for path in ['/health', '/missing']:
            response = client.get(path, headers={'Origin': ORIGINS[0]})
            self.assertEqual(response.headers['access-control-allow-origin'], ORIGINS[0])

    def test_empty_setting_allows_only_local_development_origins(self):
        client = self.client('')
        for origin, expected in [('http://localhost:3000',200),('http://127.0.0.1:3004',200),('http://[::1]:3005',200),('https://evil.example',400),('http://localhost.evil.example',400)]:
            response = client.options('/health', headers={'Origin': origin, 'Access-Control-Request-Method': 'GET'})
            self.assertEqual(response.status_code, expected)

    def test_invalid_origin_configuration_is_not_silently_accepted(self):
        for origin in ['*','https://host.example/path','https://user:password@host.example','https://host.example?x=1','https://host.example#fragment','https://host.example:bad']:
            with self.subTest(origin=origin), self.assertRaises(ValueError): cors_options(origin)

if __name__ == '__main__': unittest.main()
