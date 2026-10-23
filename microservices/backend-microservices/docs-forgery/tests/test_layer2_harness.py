"""Tests for scripts/run_layer2_test.py: budget, cooldown, stop conditions and resume. Offline."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from docforensics.gemini_client import GeminiClient, QuotaExhausted, Settings, Timeout
from docforensics.layer2 import Options

from .test_layer2 import INVOICE_LINES, VISUAL_OK, Script, invoice, png_bytes, text_pdf

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("run_layer2_test", ROOT / "scripts" / "run_layer2_test.py")
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)

FORGED_LINES = [line.replace("7,370.00", "9,370.00") for line in INVOICE_LINES]


def client_for(script, **kw):
    settings = Settings(min_interval_s=kw.pop("min_interval_s", 0), max_retries=0, backoff_base_s=0, backoff_cap_s=0)
    return GeminiClient(settings, transport=script, sleep=lambda s: None)


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.data = self.tmp / "set"
        self.data.mkdir()
        files = {"g1.pdf": text_pdf(INVOICE_LINES), "f1.pdf": text_pdf(FORGED_LINES), "g2.pdf": text_pdf(INVOICE_LINES),
                 "f2.pdf": text_pdf(FORGED_LINES)}
        self.manifest = []
        for name, data in files.items():
            (self.data / name).write_bytes(data)
            forged = name.startswith("f")
            self.manifest.append({"id": name[:-4], "path": name, "label": "forged" if forged else "genuine", "kind": "invoice",
                                  "doc_type": "invoice", "format": "pdf", "expectation": "arithmetic" if forged else "clean",
                                  **({"forged": {"value_new": "9370.00"}} if forged else {})})
        self.out = self.tmp / "run"

    def session(self, script, max_calls=50, **kw):
        sleeps = []
        summary = harness.run_session(self.manifest, self.data, self.out, client_for(script), Options(visual=kw.pop("visual", False)),
                                      max_calls, doc_gap=kw.pop("doc_gap", 5), sleep=sleeps.append, log=lambda *_: None, **kw)
        return summary, sleeps

    def test_full_run_scores_caught_forgeries_and_clean_genuine(self):
        script = Script(invoice(), invoice(total=9370), invoice(), invoice(total=9370))
        summary, _ = self.session(script)
        self.assertEqual((summary["analysed"], summary["failed"], summary["stopped"]), (4, 0, None))
        self.assertEqual(summary["genuine"], {"n": 2, "flagged": 0, "any_finding": []})
        self.assertEqual((summary["forged_arithmetic"]["n"], summary["forged_arithmetic"]["caught"],
                          summary["forged_arithmetic"]["right_reason"]), (2, 2, 2))

    def test_documents_are_spaced_by_the_gap(self):
        _, sleeps = self.session(Script(invoice(), invoice(total=9370), invoice(), invoice(total=9370)), doc_gap=7)
        self.assertEqual(sleeps, [7, 7, 7])  # between 4 documents, none after the last

    def test_quota_stops_the_run_and_resume_skips_finished_documents(self):
        first, _ = self.session(Script(invoice(), QuotaExhausted("daily quota")))
        self.assertIn("quota_exhausted", first["stopped"])
        self.assertEqual((first["analysed"], first["failed"]), (1, 1))
        lines = (self.out / "results.jsonl").read_text().splitlines()
        self.assertEqual(len(lines), 2)  # nothing lost: one finished, one recorded as failed

        script = Script(invoice(total=9370), invoice(), invoice(total=9370))
        second, _ = self.session(script)
        self.assertEqual(len(script.requests), 3)  # the finished document was not re-run
        self.assertEqual((second["analysed"], second["failed"], second["stopped"]), (4, 0, None))

    def test_failed_documents_are_never_counted_as_clean(self):
        summary, _ = self.session(Script(QuotaExhausted("daily quota")))
        self.assertEqual(summary["genuine"]["n"], 0)
        self.assertEqual(summary["failed_ids"], ["g1"])

    def test_budget_stops_before_overspending(self):
        script = Script(invoice(), invoice(total=9370), invoice(), invoice(total=9370))
        summary, _ = self.session(script, max_calls=2)
        self.assertEqual(len(script.requests), 2)
        self.assertIn("call budget reached", summary["stopped"])

    def test_budget_counts_the_visual_call(self):
        script = Script(invoice(), VISUAL_OK, invoice(total=9370), VISUAL_OK)
        summary, _ = self.session(script, max_calls=4, visual=True)
        self.assertEqual(summary["calls_this_session"], 4)
        self.assertEqual(len(script.requests), 4)

    def test_repeated_failures_trip_the_breaker(self):
        script = Script(*[Timeout("t")] * 10)
        summary, _ = self.session(script)
        self.assertIn("in a row", summary["stopped"])
        self.assertEqual(summary["failed"], 3)

    def test_only_selected_documents_run(self):
        script = Script(invoice(total=9370))
        summary, _ = self.session(script, only=["f2"])
        self.assertEqual((len(script.requests), summary["run"]), (1, 1))

    def test_summary_excludes_failed_documents_from_rates(self):
        summary, _ = self.session(Script(invoice(), invoice(total=9370), Timeout("t"), Timeout("t")))
        self.assertEqual(summary["analysed"], 2)
        self.assertEqual(summary["genuine"]["n"], 1)

    def test_call_log_records_every_attempt(self):
        settings = Settings(min_interval_s=0, max_retries=0, call_log=str(self.tmp / "calls.jsonl"))
        client = GeminiClient(settings, transport=Script(invoice(), QuotaExhausted("q")), sleep=lambda s: None)
        harness.run_session(self.manifest[:2], self.data, self.out, client, Options(visual=False), 10, 0, sleep=lambda s: None, log=lambda *_: None)
        rows = [json.loads(line) for line in (self.tmp / "calls.jsonl").read_text().splitlines()]
        self.assertEqual([(r["purpose"], r["status"]) for r in rows], [("extract", "ok"), ("extract", "quota_exhausted")])

    def test_wilson_interval(self):
        lo, hi = harness.wilson(0, 10)
        self.assertEqual(lo, 0.0)
        self.assertAlmostEqual(hi, 0.278, places=2)
        self.assertEqual(harness.wilson(0, 0), (0.0, 1.0))

    def test_image_documents_budget_for_a_possible_second_read(self):
        entry = {"format": "image"}
        self.assertEqual(harness.worst_case_calls(entry, Options(visual=True)), 3)
        self.assertEqual(harness.worst_case_calls({"format": "pdf"}, Options(visual=True)), 2)


class DryRunTests(unittest.TestCase):
    def test_dry_run_makes_no_calls_and_prints_the_plan(self):
        manifest = ROOT / "data" / "layer2_testset" / "manifest.json"
        if not manifest.exists():
            self.skipTest("test set not built")
        import contextlib
        import io

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = harness.main(["--dry-run", "--out", tempfile.mkdtemp()])
        out = buf.getvalue()
        self.assertEqual(code, 0)
        self.assertIn("Plan: 20 documents", out)
        self.assertIn("Cooldown 15s", out)


if __name__ == "__main__":
    unittest.main()
