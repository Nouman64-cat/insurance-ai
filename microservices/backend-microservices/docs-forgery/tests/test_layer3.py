"""Layer 3 (pixel forensics): grading, availability, failure handling and the worker protocol. No PyTorch needed."""

from __future__ import annotations

import io
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from docforensics import Layer3Options, analyze_document
from docforensics import layer3 as l3
from docforensics.report import Severity, Verdict

from .test_layer2 import INVOICE_LINES, text_pdf

THRESHOLDS = {"model": "trufor", "t95": 0.10, "tmax": 0.30, "severity_at_tmax": "LOW", "n_calibration": 16,
              "measured": {"tpr_gap_tmax": 0.12, "fpr_phone_tmax": 0.04}}


def png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (400, 500), "white").save(buf, "PNG")
    return buf.getvalue()


def runner_returning(*pages):
    return lambda page_bytes, options: [dict(p) for p in pages][: len(page_bytes)]


class GradeTests(unittest.TestCase):
    def test_below_the_95th_percentile_is_silent(self):
        self.assertIsNone(l3.grade({"score": 0.05}, THRESHOLDS, 1))

    def test_between_the_percentile_and_the_maximum_is_informational(self):
        f = l3.grade({"score": 0.2}, THRESHOLDS, 1)
        self.assertEqual((f.code, f.severity), ("PIXEL_ANOMALY", Severity.INFO))

    def test_above_the_calibration_maximum_uses_the_measured_severity(self):
        f = l3.grade({"score": 0.5, "map_p99": 0.4}, THRESHOLDS, 2)
        self.assertEqual(f.severity, Severity.LOW)
        self.assertIn("page 2", f.title)
        self.assertIn("never as proof", f.detail)
        self.assertIn("12%", f.detail)  # what was measured is stated, not implied
        self.assertEqual(f.evidence["source"], "layer3")

    def test_no_thresholds_means_no_finding(self):
        self.assertIsNone(l3.grade({"score": 0.99}, None, 1))


class RunTests(unittest.TestCase):
    def run_l3(self, runner, data=None, file_type="png", thresholds=THRESHOLDS, **kw):
        with mock.patch.object(l3, "load_thresholds", return_value=thresholds):
            return l3.run_layer3(data or png(), file_type, runner=runner, **kw)

    def test_a_high_score_becomes_a_finding(self):
        r = self.run_l3(runner_returning({"score": 0.6, "map_p99": 0.5, "map_png_b64": ""}))
        self.assertEqual((r.status, len(r.findings), len(r.pages)), ("ok", 1, 1))

    def test_a_clean_page_has_scores_but_no_finding(self):
        r = self.run_l3(runner_returning({"score": 0.02}))
        self.assertEqual((r.status, r.findings, len(r.pages)), ("ok", [], 1))

    def test_pdf_pages_are_rendered_losslessly(self):
        seen = []
        r = self.run_l3(lambda pages, o: seen.append(pages) or [{"score": 0.0}], data=text_pdf(INVOICE_LINES), file_type="pdf")
        self.assertEqual(r.status, "ok")
        self.assertTrue(seen[0][0].startswith(b"\x89PNG"))

    def test_only_max_pages_are_sent(self):
        seen = []
        self.run_l3(lambda pages, o: seen.append(len(pages)) or [{"score": 0.0}] * len(pages), data=text_pdf(INVOICE_LINES),
                    file_type="pdf", options=Layer3Options(max_pages=1))
        self.assertEqual(seen, [1])

    def test_a_worker_error_is_a_failure_not_a_clean_page(self):
        def boom(pages, options):
            raise RuntimeError("out of memory")

        r = self.run_l3(boom)
        self.assertEqual((r.status, r.findings), ("failed", []))
        self.assertIn("out of memory", r.errors[0])

    def test_a_page_the_worker_could_not_score_is_reported(self):
        r = self.run_l3(runner_returning({"error": "ValueError: bad image"}))
        self.assertEqual(r.status, "failed")
        self.assertIn("bad image", r.errors[0])

    def test_unrenderable_input_fails_cleanly(self):
        r = self.run_l3(runner_returning({"score": 0.0}), data=b"not an image")
        self.assertEqual(r.status, "failed")
        self.assertIn("could not render", r.errors[0])

    def test_missing_calibration_is_stated(self):
        r = self.run_l3(runner_returning({"score": 0.99}), thresholds=None)
        self.assertEqual(r.findings, [])
        self.assertTrue(any("no calibrated thresholds" in e for e in r.errors))

    def test_partial_results_keep_page_numbers_and_cannot_look_clean(self):
        from docforensics.layer3 import Layer3Result
        with mock.patch.object(l3, "render_pngs", return_value=[png(), png()]), mock.patch.object(l3, "load_thresholds", return_value=None):
            result = l3.run_layer3(b"x", "png", runner=runner_returning({"error": "bad page"}, {"score": 0.2}))
        self.assertEqual(result.status, "partial")
        self.assertEqual(result.pages[0]["page"], 2)
        with mock.patch("docforensics.run_layer3", return_value=result):
            analysis = analyze_document(text_pdf(INVOICE_LINES), "x.pdf", layer3=True)
        self.assertIn("layer3", analysis.report.incomplete)
        self.assertEqual(analysis.report.verdict, Verdict.INCONCLUSIVE)


class AvailabilityTests(unittest.TestCase):
    def test_unavailable_is_reported_and_never_clean(self):
        with mock.patch.object(l3, "availability", return_value=(False, "No Python with PyTorch found.")):
            analysis = analyze_document(text_pdf(INVOICE_LINES), "x.pdf", layer3=True)
        report = analysis.report
        self.assertEqual((report.layer3_status, report.incomplete), ("unavailable", ["layer3"]))
        self.assertEqual(report.verdict, Verdict.INCONCLUSIVE)

    def test_layer3_is_off_by_default(self):
        analysis = analyze_document(text_pdf(INVOICE_LINES), "x.pdf")
        self.assertEqual((analysis.layer3, analysis.report.layer3_status), (None, None))

    def test_a_single_low_pixel_finding_never_decides_a_verdict(self):
        with mock.patch.object(l3, "load_thresholds", return_value=THRESHOLDS):
            analysis = analyze_document(text_pdf(INVOICE_LINES), "x.pdf", layer3=True, layer3_runner=runner_returning({"score": 0.9}))
        self.assertEqual(analysis.report.layer3_status, "ok")
        self.assertTrue(any(f.code == "PIXEL_ANOMALY" for f in analysis.report.findings))
        self.assertEqual(analysis.report.verdict, Verdict.NO_EVIDENCE)

    def test_the_worker_does_not_import_the_main_package(self):
        source = l3.WORKER.read_text(encoding="utf-8")
        self.assertNotIn("import docforensics", source)
        self.assertNotIn("from docforensics", source)
        self.assertNotIn("cv2", source)


FAKE_WORKER = textwrap.dedent('''
    import json, struct, sys
    print(json.dumps({"ready": True, "load_seconds": 0.0}), flush=True)
    n = 0
    while True:
        header = sys.stdin.buffer.read(4)
        if len(header) < 4:
            break
        (length,) = struct.unpack(">I", header)
        if length == 0:
            break
        data = sys.stdin.buffer.read(length)
        n += 1
        print(json.dumps({"score": len(data) / 1e6, "size": [1, 1], "page_bytes": len(data), "arg_models": sys.argv[1],
                          "arg_side": sys.argv[2]}), flush=True)
''')


class WorkerProtocolTests(unittest.TestCase):
    def test_frames_round_trip_through_a_real_subprocess(self):
        with tempfile.TemporaryDirectory() as d:
            worker = Path(d, "fake_worker.py")
            worker.write_text(FAKE_WORKER, encoding="utf-8")
            pages = [png(), png() + b"extra"]
            with mock.patch.object(l3, "WORKER", worker), mock.patch.object(l3, "pixel_python", return_value=Path(sys.executable)), \
                    mock.patch.object(l3, "models_dir", return_value=Path(d)):
                out = l3._subprocess_runner(pages, Layer3Options(max_side=777, timeout_s=60))
        self.assertEqual([o["page_bytes"] for o in out], [len(p) for p in pages])
        self.assertEqual(out[0]["arg_side"], "777")

    def test_a_worker_that_dies_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            worker = Path(d, "dead.py")
            worker.write_text("import sys; sys.stderr.write('boom: no torch'); sys.exit(3)", encoding="utf-8")
            with mock.patch.object(l3, "WORKER", worker), mock.patch.object(l3, "pixel_python", return_value=Path(sys.executable)), \
                    mock.patch.object(l3, "models_dir", return_value=Path(d)):
                with self.assertRaises(RuntimeError) as ctx:
                    l3._subprocess_runner([png()], Layer3Options(timeout_s=30))
        self.assertIn("no torch", str(ctx.exception))

    def test_a_fatal_load_error_is_surfaced(self):
        with tempfile.TemporaryDirectory() as d:
            worker = Path(d, "fatal.py")
            worker.write_text('import json; print(json.dumps({"fatal": "weights missing"}))', encoding="utf-8")
            with mock.patch.object(l3, "WORKER", worker), mock.patch.object(l3, "pixel_python", return_value=Path(sys.executable)), \
                    mock.patch.object(l3, "models_dir", return_value=Path(d)):
                with self.assertRaises(RuntimeError) as ctx:
                    l3._subprocess_runner([png()], Layer3Options(timeout_s=30))
        self.assertIn("weights missing", str(ctx.exception))

    def test_environment_overrides(self):
        with mock.patch.dict(os.environ, {"PIXEL_PYTHON": sys.executable, "TRUFOR_DIR": "C:/somewhere"}):
            self.assertEqual(l3.pixel_python(), Path(sys.executable))
            self.assertEqual(l3.models_dir(), Path("C:/somewhere"))


if __name__ == "__main__":
    unittest.main()
