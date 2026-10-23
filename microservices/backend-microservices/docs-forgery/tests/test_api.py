"""HTTP boundary tests; provider calls remain offline."""

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import main
from docforensics import Analysis
from docforensics.report import Report
from .test_layer2 import INVOICE_LINES, text_pdf


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def test_health(self):
        with patch.object(main, "availability", return_value=(True, "")):
            health = self.client.get("/health").json()
        self.assertEqual(health["service"], "docs-forgery")
        self.assertTrue(health["pixel_forensics"]["available"])

    def test_pixel_scores_and_heatmaps_survive_the_http_response(self):
        from docforensics.layer3 import Layer3Result
        result = Layer3Result(pages=[{"page": 1, "score": 0.73, "map_png_b64": "heatmap"}], seconds=3.5)
        with patch.object(main, "analyze_document", return_value=Analysis(
            Report("x.png", "png", "hash", 10, layer3_status="ok"), layer3=result,
        )), patch.object(main, "load_thresholds", return_value=None):
            response = self.client.post("/analyze", files={"file": ("x.pdf", b"%PDF-123")}, data={"layer3": "true"})
        self.assertEqual(response.status_code, 200, response.text)
        pixel = response.json()["pixel_forensics"]
        self.assertFalse(pixel["calibrated"])
        self.assertEqual(pixel["pages"][0]["map_png_b64"], "heatmap")
        self.assertEqual(pixel["pages"][0]["score"], 0.73)
        self.assertEqual(pixel["seconds"], 3.5)

    def test_real_pdf_defaults_to_local_analysis(self):
        with patch.object(main, "make_client") as provider:
            response = self.client.post("/analyze", files={"file": ("invoice.pdf", text_pdf(INVOICE_LINES))})
        self.assertEqual(response.status_code, 200, response.text)
        report = response.json()
        self.assertEqual(report["file_type"], "pdf")
        self.assertEqual(report["verdict"], "no_evidence")
        self.assertEqual(len(report["sha256"]), 64)
        self.assertIsNone(report["layer2_status"])
        provider.assert_not_called()

    def test_input_rejections(self):
        for content, status in ((b"", 400), (b"not a PDF", 415)):
            with self.subTest(status=status):
                response = self.client.post("/analyze", files={"file": ("fake.pdf", content)})
                self.assertEqual(response.status_code, status)
        with patch.object(main, "MAX_FILE_SIZE", 4):
            response = self.client.post("/analyze", files={"file": ("big.pdf", b"%PDF-123")})
        self.assertEqual(response.status_code, 413)

    def test_invalid_options(self):
        for options in ({"doc_type": "invalid"}, {"provider": "invalid"}, {"max_pages": "0"}, {"max_pages": "41"}):
            response = self.client.post("/analyze", data=options, files={"file": ("x.pdf", b"%PDF-123")})
            self.assertEqual(response.status_code, 422)
        self.assertEqual(self.client.post("/analyze").status_code, 422)

    def test_layer_failure_preserves_inconclusive_report_and_options(self):
        failed = Report("x.pdf", "pdf", "digest", 8, layer2_status="failed", incomplete=["layer2"])
        with patch.object(main, "make_client") as provider, patch.object(
            main, "analyze_document", return_value=Analysis(failed),
        ) as analyze:
            response = self.client.post("/analyze", files={"file": ("x.pdf", b"%PDF-123")},
                                        data={"layer2": "true", "provider": "groq", "doc_type": "invoice",
                                              "max_pages": "2", "visual": "true", "layer3": "true"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["verdict"], "inconclusive")
        self.assertEqual(response.json()["incomplete"], ["layer2"])
        provider.assert_called_once_with("groq")
        self.assertEqual(analyze.call_args.kwargs["options"].max_pages, 2)
        self.assertTrue(analyze.call_args.kwargs["options"].visual)
        self.assertTrue(analyze.call_args.kwargs["layer3"])

    def test_unreadable_pdf_is_inconclusive(self):
        response = self.client.post("/analyze", files={"file": ("broken.pdf", b"%PDF-broken")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["verdict"], "inconclusive")
