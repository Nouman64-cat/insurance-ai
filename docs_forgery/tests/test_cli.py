"""The command line must run at all: it was once broken by a tuple + list concatenation."""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from docforensics import __main__ as cli
from docforensics.report import Report

from .test_layer2 import INVOICE_LINES, text_pdf


class CliTests(unittest.TestCase):
    def setUp(self):
        self.path = Path(tempfile.mkdtemp()) / "invoice.pdf"
        self.path.write_bytes(text_pdf(INVOICE_LINES))

    def run_cli(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli.main([str(self.path), *args])
        return code, out.getvalue()

    def test_layer1_runs_and_accepts_every_doc_type(self):
        for doc_type in ("bank_statement", "payslip", "other", "invoice", "receipt"):
            code, out = self.run_cli("--doc-type", doc_type)
            self.assertEqual(code, 0, doc_type)
            self.assertIn("NO_EVIDENCE", out, doc_type)

    def test_json_output(self):
        code, out = self.run_cli("--json")
        report = json.loads(out)
        self.assertEqual((code, report["verdict"], report["layer2_status"], report["incomplete"]), (0, "no_evidence", None, []))

    def test_layer2_status_is_shown_and_a_failure_is_not_clean(self):
        failed = Report("x.pdf", "pdf", "", 10, errors=["layer2: could not read the document (quota_exhausted): daily"],
                        layer2_status="failed", incomplete=["layer2"])
        with mock.patch.object(cli, "analyze_with_content", return_value=failed):
            code, out = self.run_cli("--layer2")
        self.assertIn("INCONCLUSIVE", out)
        self.assertIn("layer 2: failed", out)
        self.assertIn("quota_exhausted", out)


if __name__ == "__main__":
    unittest.main()
