"""Tests for the Streamlit demo: its helpers, and the app itself driven headlessly. Offline: no real model is called."""

from __future__ import annotations

import io
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image
from streamlit.testing.v1 import AppTest

from docforensics import analyze_document, demo
from docforensics.gemini_client import GeminiClient, Settings
from docforensics.layer2 import Options
from docforensics.report import Category, Finding, Report, Severity, Verdict

from .test_layer2 import INVOICE_LINES, Script, invoice, png_bytes, text_pdf

ROOT = Path(__file__).resolve().parents[1]
APP = str(ROOT / "app.py")
FORGED_LINES = [line.replace("7,370.00", "9,370.00") for line in INVOICE_LINES]


def fake_client(*replies):
    script = Script(*replies)
    return GeminiClient(Settings(min_interval_s=0, max_retries=0), transport=script, sleep=lambda s: None), script


class HelperTests(unittest.TestCase):
    def test_findings_table_is_ordered_and_hides_info_by_default(self):
        report = Report("x", "pdf", "", 0, findings=[
            Finding("A", Severity.LOW, Category.METADATA, "low one", "d"),
            Finding("CONTENT_B", Severity.HIGH, Category.TAMPERING, "high one", "d"),
            Finding("C", Severity.INFO, Category.CONTEXT, "info one", "d")])
        rows = demo.findings_rows(report)
        self.assertEqual([r["Finding"] for r in rows], ["high one", "low one"])
        self.assertEqual(rows[0]["Layer"], "Layer 2 · content")
        self.assertEqual(rows[1]["Layer"], "Layer 1 · file")
        self.assertEqual(len(demo.findings_rows(report, include_info=True)), 3)

    def test_headline_findings_and_counts(self):
        report = Report("x", "pdf", "", 0, findings=[Finding(str(i), s, Category.TAMPERING, f"t{i}", "d") for i, s in
                                                      enumerate([Severity.LOW, Severity.MEDIUM, Severity.HIGH, Severity.CRITICAL, Severity.INFO])])
        self.assertEqual([f.title for f in demo.headline_findings(report, 2)], ["t3", "t2"])
        self.assertEqual(demo.severity_counts(report), {"Low": 1, "Medium": 1, "High": 1, "Critical": 1})

    def test_every_verdict_has_a_message_that_never_calls_a_document_genuine(self):
        self.assertEqual(set(demo.VERDICTS), set(Verdict))
        self.assertIn("not proof", demo.VERDICTS[Verdict.NO_EVIDENCE][2])
        for _, title, blurb in demo.VERDICTS.values():
            self.assertNotIn("authentic", (title + blurb).lower().replace("not proof the document is genuine", ""))

    def test_provider_status_never_reveals_a_key(self):
        os.environ["GROQ_API_KEY"], os.environ["GEMINI_API_KEY"] = "gsk_secret_value_123456", "AIza_secret_value_123456"
        try:
            status = demo.provider_status()
        finally:
            os.environ.pop("GROQ_API_KEY"), os.environ.pop("GEMINI_API_KEY")
        self.assertTrue(status["groq"]["has_key"] and status["gemini"]["has_key"])
        self.assertNotIn("secret", json.dumps(status))

    def test_active_test_run_detection(self):
        with tempfile.TemporaryDirectory() as d:
            groq, gemini = Path(d, "g"), Path(d, "m")
            groq.mkdir(), gemini.mkdir()
            (groq / "calls.jsonl").write_text("{}")
            (gemini / "calls.jsonl").write_text("{}")
            old = time.time() - 3600
            os.utime(gemini / "calls.jsonl", (old, old))
            with mock.patch.dict(demo.RUN_DIRS, {"groq": groq, "gemini": gemini}):
                self.assertEqual(demo.active_test_runs(within_s=240), ["groq"])
                self.assertEqual(sorted(demo.active_test_runs(within_s=7200)), ["gemini", "groq"])

    def test_thumbnails_for_pdf_and_image_and_garbage(self):
        self.assertEqual(len(demo.thumbnails(text_pdf(INVOICE_LINES), "pdf")), 1)
        buf = io.BytesIO()
        Image.new("RGB", (2000, 1500), "white").save(buf, "PNG")
        (thumb,) = demo.thumbnails(buf.getvalue(), "png", width=500)
        self.assertEqual(Image.open(io.BytesIO(thumb)).width, 500)
        self.assertEqual(demo.thumbnails(b"not a file", "png"), [])

    def test_sample_truth_text(self):
        self.assertIn("genuine", demo.truth_text({"label": "genuine"}))
        text = demo.truth_text({"label": "forged", "forged": {"what": "net pay inflated", "old": "10.00", "value_new": "20.00"}})
        self.assertIn("net pay inflated (10.00 → 20.00)", text)

    def test_analyze_document_in_memory_with_layer2(self):
        client, script = fake_client(invoice(total=9370))
        analysis = analyze_document(text_pdf(FORGED_LINES), "inv.pdf", "invoice", layer2=True, client=client, options=Options(visual=False))
        self.assertEqual(analysis.report.verdict, Verdict.REVIEW)
        self.assertEqual(analysis.layer2.status, "ok")
        figures = demo.figures(analysis)
        self.assertEqual(figures["scalars"]["total"], "9370")
        self.assertEqual(len(figures["items"]), 3)
        self.assertEqual(demo.calls_rows(analysis)[0]["Step"], "Read the page")
        blob = demo.report_json(analysis, {"truth": None})
        self.assertEqual(json.loads(blob)["verdict"], "review")
        self.assertNotIn("Northwind", blob)  # issuer/customer names are not exported with the figures

    def test_layer2_is_off_unless_requested(self):
        analysis = analyze_document(text_pdf(INVOICE_LINES), "inv.pdf")
        self.assertIsNone(analysis.layer2)
        self.assertIsNone(analysis.report.layer2_status)


class AppTests(unittest.TestCase):
    def setUp(self):
        import streamlit as st

        st.cache_resource.clear()
        self.env = {k: os.environ.get(k) for k in ("GROQ_API_KEY", "GEMINI_API_KEY")}
        os.environ["GROQ_API_KEY"], os.environ["GEMINI_API_KEY"] = "gsk_test_not_real_0123456789", "AIza_test_not_real_0123456789"

    def tearDown(self):
        for k, v in self.env.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)

    def app(self):
        return AppTest.from_file(APP, default_timeout=120).run()

    def test_loads_with_no_errors_and_layer2_off(self):
        at = self.app()
        self.assertEqual(len(at.exception), 0)
        self.assertEqual(at.title[0].value, "🔎 Document Forensics")
        self.assertFalse(at.toggle(key="use_l2").value)
        self.assertTrue(at.button(key="analyze_uploads").disabled)  # nothing uploaded yet

    def test_upload_and_analyse_with_layer1_only(self):
        at = self.app()
        at.file_uploader(key="uploads").upload("invoice.pdf", text_pdf(INVOICE_LINES), "application/pdf")
        at = at.run()
        at.button(key="analyze_uploads").click().run()
        self.assertEqual(len(at.exception), 0)
        self.assertEqual(at.subheader[0].value, "invoice.pdf")
        self.assertIn("No evidence of tampering found", at.info[0].value)

    def test_consent_is_required_before_any_page_leaves_the_machine(self):
        made = []
        with mock.patch("docforensics.gemini_client.make_client", side_effect=lambda *a, **k: made.append(a) or fake_client()[0]):
            at = self.app()
            at.toggle(key="use_l2").set_value(True).run()
            at.file_uploader(key="uploads").upload("invoice.pdf", text_pdf(FORGED_LINES), "application/pdf")
            at = at.run()
            self.assertEqual(len(at.exception), 0)
            self.assertTrue(any("Tick the box" in i.value for i in at.info))
            at.button(key="analyze_uploads").click().run()
        self.assertEqual(made, [])  # no model client was even created
        self.assertEqual(len(at.exception), 0)

    def test_layer2_flow_flags_a_forged_total(self):
        client, script = fake_client(invoice(total=9370))
        with mock.patch("docforensics.gemini_client.make_client", return_value=client):
            at = self.app()
            at.toggle(key="use_l2").set_value(True).run()
            at.checkbox(key="visual").uncheck().run()
            at.checkbox(key="consent").check().run()
            at.file_uploader(key="uploads").upload("forged.pdf", text_pdf(FORGED_LINES), "application/pdf")
            at = at.run()
            at.selectbox(key="doc_type").select("Invoice").run()
            at.button(key="analyze_uploads").click().run()
        self.assertEqual(len(at.exception), 0, [e.value for e in at.exception])
        self.assertEqual(script.purposes, ["extract"])
        self.assertTrue(any("Send to a human reviewer" in w.value for w in at.warning))
        self.assertTrue(any("do not add up" in m.value.lower() or "total" in m.value.lower() for m in at.markdown))

    def test_a_layer2_outage_is_shown_as_could_not_be_checked(self):
        from docforensics.gemini_client import QuotaExhausted

        client, _ = fake_client(QuotaExhausted("daily quota spent"))
        with mock.patch("docforensics.gemini_client.make_client", return_value=client):
            at = self.app()
            at.toggle(key="use_l2").set_value(True).run()
            at.checkbox(key="visual").uncheck().run()
            at.checkbox(key="consent").check().run()
            at.file_uploader(key="uploads").upload("scan.png", png_bytes(), "image/png")
            at = at.run()
            at.button(key="analyze_uploads").click().run()
        self.assertEqual(len(at.exception), 0)
        self.assertTrue(any("Could not be fully checked" in w.value for w in at.warning))
        self.assertFalse(any("No evidence of tampering" in i.value for i in at.info))

    def test_sample_button_reveals_the_ground_truth(self):
        if not demo.load_samples():
            self.skipTest("sample documents not built")
        at = self.app()
        at.button(key="analyze_sample").click().run()
        self.assertEqual(len(at.exception), 0)
        self.assertTrue(any("Ground truth" in c.value for c in at.caption))

    def test_clear_results(self):
        at = self.app()
        at.file_uploader(key="uploads").upload("invoice.pdf", text_pdf(INVOICE_LINES), "application/pdf")
        at = at.run()
        at.button(key="analyze_uploads").click().run()
        self.assertEqual(len(at.subheader), 1)
        at.button(key="clear").click().run()
        self.assertEqual(len(at.subheader), 0)


if __name__ == "__main__":
    unittest.main()
