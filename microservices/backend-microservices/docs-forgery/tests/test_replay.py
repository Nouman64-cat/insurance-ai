"""The replay tool must reproduce a live run's checks from saved replies. Offline."""

from __future__ import annotations

import dataclasses
import importlib.util
import json
import unittest
from pathlib import Path

from docforensics.gemini_client import GeminiClient, Settings
from docforensics.layer2 import Options, run_layer2
from docforensics.layer2.schema import parse_extraction

from .test_layer2 import INVOICE_LINES, NOW, invoice, ledger, statement, text_pdf

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("replay_layer2", ROOT / "scripts" / "replay_layer2.py")
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)


def saved_dump(model_json: dict) -> dict:
    """What run_layer2_test.py writes to extractions/<id>.json (dataclass dump, Decimals as strings)."""
    return json.loads(json.dumps(dataclasses.asdict(parse_extraction(model_json)), default=str))


class ConversionTests(unittest.TestCase):
    def test_dump_converts_back_to_an_equivalent_extraction(self):
        for doc in (invoice(), statement(ledger(8)),
                    {"doc_type": "payslip", "earnings": [{"label": "Basic", "amount": 100}], "gross_pay": 100, "net_pay": 90,
                     "identifiers": [{"label": "IBAN", "value": "GB82 WEST 1234 5698 7654 32"}]}):
            original = parse_extraction(doc)
            back = parse_extraction(replay.dump_to_model_json(saved_dump(doc)))
            self.assertEqual(dataclasses.asdict(back), dataclasses.asdict(original))

    def test_keys_resolve_like_a_second_read(self):
        ex = parse_extraction(invoice())
        self.assertEqual(replay.resolve(ex, "total"), ex.total)
        self.assertEqual(replay.resolve(ex, "items[1].amount"), ex.items[1].amount)
        self.assertIsNone(replay.resolve(ex, "items[99].amount"))
        self.assertIsNone(replay.resolve(ex, "nonsense key"))


class ReplayRunTests(unittest.TestCase):
    def run_replay(self, doc, lines, data=None):
        client = GeminiClient(Settings(min_interval_s=0, max_retries=0), transport=replay.ReplayTransport(doc), sleep=lambda s: None)
        return run_layer2(data or text_pdf(lines), "x.pdf", "pdf", client=client, now=NOW, options=Options(visual=False))

    def test_replay_matches_a_live_run(self):
        forged = [line.replace("7,370.00", "9,370.00") for line in INVOICE_LINES]
        result = self.run_replay(invoice(total=9370), forged)
        self.assertIn("CONTENT_TOTAL_MISMATCH", {f.code for f in result.findings})
        self.assertEqual(result.status, "ok")

    def test_replay_answers_a_second_read_from_the_saved_reply(self):
        import io

        from PIL import Image

        buf = io.BytesIO()
        Image.effect_noise((300, 400), 30).convert("RGB").save(buf, "PNG")
        client = GeminiClient(Settings(min_interval_s=0, max_retries=0), transport=replay.ReplayTransport(invoice(total=9370)),
                              sleep=lambda s: None)
        result = run_layer2(buf.getvalue(), "x.png", "png", client=client, now=NOW, options=Options(visual=False))
        finding = next(f for f in result.findings if f.code == "CONTENT_TOTAL_MISMATCH")
        self.assertEqual(finding.evidence["verified_by"], "second_read")

    def test_replay_refuses_a_call_it_cannot_answer(self):
        from docforensics.gemini_client import Request

        with self.assertRaises(RuntimeError):
            replay.ReplayTransport(invoice())(Request("p", purpose="visual"), Settings())


if __name__ == "__main__":
    unittest.main()
