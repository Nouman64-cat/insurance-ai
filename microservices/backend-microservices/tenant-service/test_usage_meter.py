"""Token counts read from raw provider responses (services/usage_meter.py); no network or DB."""
import unittest

from services.usage_meter import model_of, usage_from_response


class UsageFromResponse(unittest.TestCase):
    def test_gemini_counts_thinking_as_output(self):
        body = {"modelVersion": "gemini-2.5-flash", "usageMetadata": {
            "promptTokenCount": 1200, "candidatesTokenCount": 40, "thoughtsTokenCount": 300, "cachedContentTokenCount": 1000}}
        self.assertEqual(usage_from_response("gemini", body),
                         {"input_tokens": 1200, "output_tokens": 340, "cached_tokens": 1000, "total_tokens": 1540})
        self.assertEqual(model_of("gemini", body, "requested"), "gemini-2.5-flash")

    def test_openai(self):
        body = {"model": "gpt-4o-mini-2024-07-18", "usage": {"prompt_tokens": 14186, "completion_tokens": 7,
                                                             "prompt_tokens_details": {"cached_tokens": 1024}}}
        self.assertEqual(usage_from_response("openai", body),
                         {"input_tokens": 14186, "output_tokens": 7, "cached_tokens": 1024, "total_tokens": 14193})

    def test_anthropic_input_includes_cache_reads_and_writes(self):
        body = {"model": "claude-haiku-5-5", "usage": {"input_tokens": 50, "output_tokens": 20,
                                                       "cache_read_input_tokens": 900, "cache_creation_input_tokens": 100}}
        self.assertEqual(usage_from_response("anthropic", body),
                         {"input_tokens": 1050, "output_tokens": 20, "cached_tokens": 900, "total_tokens": 1070})

    def test_no_usage_records_nothing(self):
        self.assertIsNone(usage_from_response("openai", {}))
        self.assertIsNone(usage_from_response("unknown", {"usage": {"prompt_tokens": 5}}))
        self.assertEqual(model_of("openai", {}, "requested-model"), "requested-model")


if __name__ == "__main__":
    unittest.main(verbosity=2)
