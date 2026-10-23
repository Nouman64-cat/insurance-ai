import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from docforensics import layer3
from docforensics.report import Severity
from scripts.calibrate_pixel import make_thresholds


def records():
    return [{"split": "calibration", "sha256": f"cal-{i}", "score": i/100, "source": f"test-{i}"} for i in range(20)] + [
        {"split": "validation", "sha256": f"val-{i}", "score": .1 + i/20, "source": f"validation-{i}"} for i in range(5)]


class CalibrationTests(unittest.TestCase):
    def test_cutoffs_use_calibration_only_and_validation_is_measured_separately(self):
        result = make_thresholds(records(), "test_reference")
        self.assertAlmostEqual(result["t95"], .1805)
        self.assertEqual(result["tmax"], .19)
        self.assertEqual(result["n_calibration"], 20)
        self.assertEqual(result["validation"]["n_genuine"], 5)
        self.assertEqual(result["validation"]["above_tmax"], 3)
        self.assertEqual(result["validation"]["fpr_at_tmax"], .6)
        self.assertIsNone(result["validation"]["forged_detection_rate"])
        self.assertEqual(result["severity_at_tmax"], "LOW")

    def test_duplicate_content_and_small_sets_are_rejected(self):
        rows = records()
        rows[-1]["sha256"] = rows[0]["sha256"]
        with self.assertRaisesRegex(ValueError, "overlap"):
            make_thresholds(rows, "test")
        with self.assertRaisesRegex(ValueError, "at least 20"):
            make_thresholds(records()[1:], "test")

    def test_nonfinite_and_out_of_range_scores_are_rejected(self):
        for score in (float("nan"), float("inf"), -1, 1.01):
            rows = records()
            rows[0]["score"] = score
            with self.assertRaisesRegex(ValueError, "Invalid model score"):
                make_thresholds(rows, "test")

    def test_threshold_loader_fails_closed(self):
        valid = make_thresholds(records(), "test")
        invalid = [[], {}, {**valid, "t95": .5}, {**valid, "tmax": float("nan")},
                   {**valid, "severity_at_tmax": "CRITICAL"}, {**valid, "render_dpi": 300},
                   {**valid, "max_side": 512}, {**valid, "n_calibration": 1},
                   {**valid, "validation": []}, {**valid, "validation": {"fpr_at_tmax": 2}},
                   {**valid, "model": "different_detector"}, {**valid, "runtime": {"worker_sha256": "wrong"}}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"thresholds.json"
            with patch.dict("os.environ", {"PIXEL_THRESHOLDS": str(path)}):
                path.write_text(json.dumps(valid))
                self.assertIsNotNone(layer3.load_thresholds())
                for value in invalid:
                    path.write_text(json.dumps(value))
                    self.assertIsNone(layer3.load_thresholds(), value)

    def test_boundary_severity_is_never_above_low(self):
        thresholds = make_thresholds(records(), "test")
        self.assertIsNone(layer3.grade({"score": thresholds["t95"] - .01}, thresholds, 1))
        self.assertEqual(layer3.grade({"score": thresholds["t95"]}, thresholds, 1).severity, Severity.INFO)
        self.assertEqual(layer3.grade({"score": thresholds["tmax"]}, thresholds, 1).severity, Severity.LOW)
        self.assertEqual(layer3.grade({"score": 1}, {**thresholds, "severity_at_tmax": "CRITICAL"}, 1).severity, Severity.LOW)

    def test_mismatched_inference_size_does_not_use_thresholds(self):
        from tests.test_layer3 import png
        thresholds = make_thresholds(records(), "test")
        with patch.object(layer3, "load_thresholds", return_value=thresholds):
            result = layer3.run_layer3(png(), "png", layer3.Layer3Options(max_side=512), runner=lambda *_: [{"score": .9}])
        self.assertIsNone(result.calibration)
        self.assertEqual(result.findings, [])
        self.assertTrue(any("differs from calibration" in e for e in result.errors))

    def test_health_exposes_threshold_values_and_reference_scope(self):
        import main
        from fastapi.testclient import TestClient
        thresholds = make_thresholds(records(), "public_reference_baseline")
        with patch.object(main, "load_thresholds", return_value=thresholds):
            result = TestClient(main.app).get("/health").json()["pixel_forensics"]
        self.assertTrue(result["calibrated"])
        self.assertEqual(result["calibration"]["scope"], "public_reference_baseline")
        self.assertEqual(result["calibration"]["n_validation"], 5)
        self.assertEqual(result["calibration"]["tmax"], .19)
