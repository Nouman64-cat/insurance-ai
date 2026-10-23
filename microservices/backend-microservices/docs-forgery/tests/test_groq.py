"""Groq backend tests. The HTTP layer is mocked (httpx.MockTransport): no request leaves this machine."""

from __future__ import annotations

import base64
import json
import os
import unittest

import httpx

from docforensics.gemini_client import (
    AuthError, BadRequest, BadResponse, ConfigError, GeminiClient, QuotaExhausted, RateLimited, Request, ServiceError,
    Timeout, make_client)
from docforensics.groq_client import (
    DEFAULT_MODEL, MAX_B64_BYTES, GroqTransport, estimate_tokens, parse_duration, settings_from_env)
from docforensics.layer2 import Options, run_layer2

from .test_layer2 import INVOICE_LINES, NOW, invoice, text_pdf

KEY = "gsk_test_key_not_real_0123456789"
OK_BODY = {"choices": [{"message": {"role": "assistant", "content": '{"ok": true}'}, "finish_reason": "stop"}]}
JPEG = b"\xff\xd8\xff\xe0" + b"x" * 200


def reply(status=200, body=None, headers=None):
    return httpx.Response(status, json=OK_BODY if body is None else body, headers=headers or {})


def error(status, message, headers=None, code="rate_limit_exceeded"):
    return reply(status, {"error": {"message": message, "type": "x", "code": code}}, headers)


class Harness:
    """A GroqTransport over a mock server that records requests and answers from a script."""

    def __init__(self, *responses, clock=None):
        self.responses, self.requests, self.sleeps = list(responses), [], []
        self.now = [0.0]

        def handler(request):
            self.requests.append(request)
            item = self.responses.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        self.transport = GroqTransport(http=httpx.Client(transport=httpx.MockTransport(handler)),
                                       clock=lambda: self.now[0], sleep=self._sleep)

    def _sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now[0] += seconds

    def client(self, **kw):
        settings = settings_from_env(min_interval_s=0, max_retries=kw.pop("max_retries", 3), backoff_base_s=0, backoff_cap_s=0, **kw)
        return GeminiClient(settings, transport=self.transport, sleep=self._sleep)

    def body(self, i=0):
        return json.loads(self.requests[i].content)


class GroqBase(unittest.TestCase):
    def setUp(self):
        self._old = os.environ.get("GROQ_API_KEY")
        os.environ["GROQ_API_KEY"] = KEY

    def tearDown(self):
        if self._old is None:
            os.environ.pop("GROQ_API_KEY", None)
        else:
            os.environ["GROQ_API_KEY"] = self._old


class RequestTests(GroqBase):
    def test_request_shape(self):
        h = Harness(reply())
        h.client().generate(Request("read it", [(JPEG, "image/jpeg")] * 2, purpose="extract"))
        req, body = h.requests[0], h.body()
        self.assertEqual(str(req.url), "https://api.groq.com/openai/v1/chat/completions")
        self.assertEqual(req.headers["authorization"], f"Bearer {KEY}")
        self.assertEqual((body["model"], body["temperature"], body["response_format"]), (DEFAULT_MODEL, 0, {"type": "json_object"}))
        content = body["messages"][0]["content"]
        self.assertEqual(content[0], {"type": "text", "text": "read it"})
        self.assertEqual(len(content), 3)
        url = content[1]["image_url"]["url"]
        self.assertTrue(url.startswith("data:image/jpeg;base64,"))
        self.assertEqual(base64.b64decode(url.split(",", 1)[1]), JPEG)

    def test_output_is_capped_per_purpose_to_fit_the_token_allowance(self):
        for purpose, cap in (("extract", 4096), ("confirm", 600), ("visual", 700)):  # small calls stay under 1,000 output tokens/min
            h = Harness(reply())
            h.client().generate(Request("p", [(JPEG, "image/jpeg")], purpose=purpose))
            self.assertEqual(h.body()["max_completion_tokens"], cap, purpose)

    def test_plain_text_requests_omit_json_mode(self):
        h = Harness(reply())
        h.client().generate(Request("p", purpose="ask", json_mode=False))
        self.assertNotIn("response_format", h.body())

    def test_reply_text_and_finish_reason(self):
        self.assertEqual(Harness(reply()).client().generate_json(Request("p")), {"ok": True})
        cut = reply(body={"choices": [{"message": {"content": '{"a": [1,'}, "finish_reason": "length"}]})
        with self.assertRaises(BadResponse):
            Harness(cut).client().generate(Request("p"))

    def test_malformed_success_body_is_an_error_not_an_empty_result(self):
        with self.assertRaises(Exception) as ctx:
            Harness(reply(body={"unexpected": 1})).client().generate(Request("p"))
        self.assertNotIsInstance(ctx.exception, AssertionError)

    def test_missing_key(self):
        os.environ.pop("GROQ_API_KEY")
        with self.assertRaises(ConfigError):
            Harness(reply()).client().generate(Request("p"))

    def test_limits_are_enforced_before_any_request(self):
        h = Harness(reply())
        with self.assertRaises(BadRequest):
            h.client().generate(Request("p", [(JPEG, "image/jpeg")] * 6))
        big = b"\xff" * int(MAX_B64_BYTES * 0.8)
        with self.assertRaises(BadRequest):
            h.client().generate(Request("p", [(big, "image/jpeg")]))
        self.assertEqual(h.requests, [])


class ErrorTests(GroqBase):
    def run_error(self, response, **kw):
        h = Harness(response, *kw.get("then", []))
        try:
            h.client(max_retries=kw.get("max_retries", 0)).generate(Request("p"))
        except Exception as exc:  # noqa: BLE001
            return exc, h
        self.fail("expected an error")

    def test_per_minute_token_limit_is_retryable_and_honours_retry_after(self):
        exc, _ = self.run_error(error(429, "Rate limit reached ... on tokens per minute (TPM): Limit 8000, Used 7000, Requested 3000. "
                                           "Please try again in 7.5s.", {"retry-after": "8"}))
        self.assertIsInstance(exc, RateLimited)
        self.assertEqual(exc.retry_after, 8.0)

    def test_retry_then_success(self):
        h = Harness(error(429, "tokens per minute (TPM) ... try again in 3s", {"retry-after": "3"}), reply())
        self.assertEqual(h.client().generate_json(Request("p")), {"ok": True})
        self.assertEqual([c.status for c in h.client().calls], [])  # fresh client has no calls; the one above did
        self.assertEqual(len(h.requests), 2)

    def test_daily_limit_is_not_retried(self):
        exc, h = self.run_error(error(429, "Rate limit reached on requests per day (RPD): Limit 1000, Used 1000. Please try again in 21m3.5s."),
                                max_retries=3, then=[reply()])
        self.assertIsInstance(exc, QuotaExhausted)
        self.assertEqual(len(h.requests), 1)
        self.assertAlmostEqual(exc.retry_after, 21 * 60 + 3.5)

    def test_http_statuses_map_to_typed_errors(self):
        cases = [(413, BadRequest, "Request too large for model on tokens per minute (TPM): Limit 8000, Requested 9000"),
                 (401, AuthError, "Invalid API Key"), (403, AuthError, "forbidden"), (400, BadRequest, "bad image"),
                 (503, ServiceError, "over capacity")]
        for status, kind, message in cases:
            exc, _ = self.run_error(error(status, message, code="x"))
            self.assertIsInstance(exc, kind, status)

    def test_server_errors_are_retried(self):
        h = Harness(error(503, "over capacity", code="x"), reply())
        self.assertEqual(h.client().generate_json(Request("p")), {"ok": True})

    def test_network_failures(self):
        exc, _ = self.run_error(httpx.ReadTimeout("slow"))
        self.assertIsInstance(exc, Timeout)
        exc, _ = self.run_error(httpx.ConnectError("no route"))
        self.assertIsInstance(exc, ServiceError)

    def test_the_key_never_appears_in_an_error(self):
        exc, _ = self.run_error(error(401, f"Invalid API Key {KEY} for this org", code="invalid_api_key"))
        self.assertNotIn(KEY, str(exc))


class TokenWindowTests(GroqBase):
    def headers(self, remaining, reset):
        return {"x-ratelimit-remaining-tokens": str(remaining), "x-ratelimit-reset-tokens": reset}

    def test_waits_for_the_window_when_the_allowance_is_nearly_spent(self):
        h = Harness(reply(headers=self.headers(300, "12s")), reply(headers=self.headers(7000, "1s")))
        client = h.client()
        client.generate(Request("a", [(JPEG, "image/jpeg")], purpose="extract"))
        self.assertEqual(h.sleeps, [])
        client.generate(Request("b", [(JPEG, "image/jpeg")], purpose="extract"))  # needs ~5k, only 300 left
        self.assertEqual(len(h.sleeps), 1)
        self.assertAlmostEqual(h.sleeps[0], 12.5)

    def test_no_wait_when_there_is_room(self):
        h = Harness(reply(headers=self.headers(7000, "5s")), reply())
        client = h.client()
        client.generate(Request("a", purpose="confirm"))
        client.generate(Request("b", purpose="confirm"))
        self.assertEqual(h.sleeps, [])

    def test_estimate_grows_with_pages_and_output(self):
        small = estimate_tokens(Request("x" * 100, [(JPEG, "image/jpeg")]), 1000)
        big = estimate_tokens(Request("x" * 100, [(JPEG, "image/jpeg")] * 3), 4096)
        self.assertGreater(big, small + 2000)

    def test_duration_parsing(self):
        for text, want in (("16.74s", 16.74), ("1m26.4s", 86.4), ("250ms", 0.25), ("2h3m", 7380), ("8", 8.0), ("45m0s", 2700)):
            self.assertAlmostEqual(parse_duration(text), want, msg=text)
        self.assertIsNone(parse_duration("soon"))
        self.assertIsNone(parse_duration(None))


class ProviderTests(GroqBase):
    def test_make_client_selects_the_provider(self):
        groq = make_client("groq", min_interval_s=7)
        self.assertEqual((groq.settings.model, groq.settings.min_interval_s), (DEFAULT_MODEL, 7))
        self.assertIsInstance(groq.transport, GroqTransport)
        gemini = make_client("gemini")
        self.assertNotIsInstance(gemini.transport, GroqTransport)
        self.assertEqual(gemini.settings.model, "gemini-2.5-flash")
        with self.assertRaises(ConfigError):
            make_client("nonsense")

    def test_environment_selects_provider_and_model(self):
        os.environ["LLM_PROVIDER"], os.environ["GROQ_MODEL"] = "groq", "some/other-model"
        try:
            client = make_client()
            self.assertEqual(client.settings.model, "some/other-model")
        finally:
            os.environ.pop("LLM_PROVIDER"), os.environ.pop("GROQ_MODEL")

    def test_each_call_is_logged_with_its_model(self):
        h = Harness(reply())
        client = h.client()
        client.generate(Request("p", purpose="extract"))
        self.assertEqual(client.calls[0].to_dict()["model"], DEFAULT_MODEL)


class EndToEndTests(GroqBase):
    def test_layer2_runs_on_groq_and_reads_at_most_the_allowed_pages(self):
        forged = [line.replace("7,370.00", "9,370.00") for line in INVOICE_LINES]
        h = Harness(reply(body={"choices": [{"message": {"content": json.dumps(invoice(total=9370))}, "finish_reason": "stop"}]}))
        result = run_layer2(text_pdf(forged), "x.pdf", "pdf", client=h.client(), now=NOW, options=Options(visual=False, max_pages=2))
        self.assertEqual(result.status, "ok")
        self.assertIn("CONTENT_TOTAL_MISMATCH", {f.code for f in result.findings})
        self.assertLessEqual(sum(1 for part in h.body()["messages"][0]["content"] if part["type"] == "image_url"), 2)

    def test_a_groq_failure_is_a_failed_status_not_a_clean_result(self):
        h = Harness(error(429, "requests per day (RPD): Limit 1000. try again in 20m", code="x"))
        result = run_layer2(text_pdf(INVOICE_LINES), "x.pdf", "pdf", client=h.client(), now=NOW, options=Options(visual=False))
        self.assertEqual((result.status, result.findings), ("failed", []))
        self.assertIn("quota_exhausted", result.errors[0])


if __name__ == "__main__":
    unittest.main()
