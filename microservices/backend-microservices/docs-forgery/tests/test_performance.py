import concurrent.futures
import unittest
from unittest.mock import patch

from benchmarking import summarize
from docforensics import analyze_document, Report
from performance import Metrics, percentile


class QualityTests(unittest.TestCase):
    def test_confusion_matrix_and_abstentions(self):
        cases = [("forged", "high_risk", True), ("genuine", "no_evidence", True),
                 ("genuine", "review", True), ("forged", "no_evidence", True),
                 ("forged", "inconclusive", False), ("genuine", "no_evidence", False)]
        rows = [dict(label=label, verdict=verdict, complete=complete, http_status=200, client_seconds=i+1)
                for i, (label, verdict, complete) in enumerate(cases)]
        report = summarize(rows, 12)
        self.assertEqual(report["abstentions"], 2)
        self.assertAlmostEqual(report["coverage"], 4/6)
        for key in ("true_positive", "true_negative", "false_positive", "false_negative"):
            self.assertEqual(report["quality"][key], 1)
        self.assertEqual(report["quality"]["precision"], .5)
        self.assertEqual(report["quality"]["f1"], .5)
        self.assertAlmostEqual(report["quality"]["end_to_end_forged_detection_rate"], 1/3)
        self.assertEqual(report["runtime"]["requests_per_second"], .5)
        self.assertEqual(report["runtime"]["p50_seconds"], 3.5)

    def test_undefined_metrics_are_null_not_perfect(self):
        report = summarize([], 0)
        self.assertIsNone(report["quality"]["precision"])
        self.assertIsNone(report["quality"]["recall"])
        self.assertIsNone(report["quality"]["resolved_accuracy"])
        self.assertIsNone(percentile([], .95))


class RuntimeTests(unittest.TestCase):
    def test_bounded_concurrent_observations_and_histograms(self):
        collector = Metrics()
        sample = {"total_seconds": .5, "input_bytes": 10, "complete": True, "layer_seconds": {"layer1": .5}}
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _: collector.observe(sample, "no_evidence", False, False), range(300)))
        snapshot = collector.snapshot()
        self.assertEqual(snapshot["analyses"], 300)
        self.assertEqual(snapshot["modes"]["file_only"]["percentile_sample_count"], 256)
        self.assertEqual(snapshot["modes"]["file_only"]["p95_seconds"], .5)
        text = collector.prometheus()
        self.assertIn('le="0.5"} 300', text)
        self.assertIn('le="+Inf"} 300', text)

    def test_modes_do_not_mix_fast_file_checks_with_pixel_latency(self):
        collector = Metrics()
        for seconds, pixel in ((.1, False), (30, True)):
            collector.observe(dict(total_seconds=seconds,input_bytes=20,complete=not pixel,layer_seconds={"layer1":.1}), "no_evidence", False, pixel)
        modes = collector.snapshot()["modes"]
        self.assertEqual(modes["pixel"]["p95_seconds"], 30)
        self.assertEqual(modes["pixel"]["completion_rate"], 0)
        self.assertEqual(modes["file_only"]["p95_seconds"], .1)

    def test_failed_layer_is_timed_and_incomplete(self):
        with patch("docforensics.analyze_bytes", return_value=Report("x", "pdf", "", 3)), patch(
            "docforensics.run_layer2", side_effect=RuntimeError("provider unavailable"),
        ):
            analysis = analyze_document(b"abc", layer2=True)
        self.assertIn("layer2", analysis.performance["layer_seconds"])
        self.assertFalse(analysis.performance["complete"])
        self.assertGreaterEqual(analysis.performance["total_seconds"], sum(analysis.performance["layer_seconds"].values()))
        self.assertIsNone(analysis.performance["model_input_tokens"])

    def test_api_exposes_request_metrics_and_counts_invalid_uploads(self):
        import main
        from fastapi.testclient import TestClient
        from tests.test_layer2 import INVOICE_LINES, text_pdf
        collector = Metrics()
        import os
        with patch.object(main, "metrics", collector), patch.dict(os.environ,{"INTERNAL_API_SECRET":"test-internal"}):
            client = TestClient(main.app, headers={"X-Internal-Secret":"test-internal"})
            response = client.post("/analyze", files={"file": ("invoice.pdf", text_pdf(INVOICE_LINES))})
            self.assertTrue(response.json()["performance"]["complete"])
            client.post("/analyze", files={"file": ("empty.pdf", b"")})
            summary = client.get("/performance").json()
            self.assertEqual(summary["http_status_counts"], {"200": 1, "400": 1})
            self.assertEqual(summary["analyses"], 1)
            self.assertIn("forgery_analysis_duration_seconds", client.get("/metrics").text)
