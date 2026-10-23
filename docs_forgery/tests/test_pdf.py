import unittest

from pikepdf import Array, Dictionary, Name

from docforensics import Severity, Verdict, analyze_bytes
from docforensics.pdf.revisions import revision_ends

from .builders import (PAYSLIP, VALUE_BOX, append_update, content_object_number, document_photo, helvetica, jpeg_bytes,
                       make_pdf, sign_pdf)


def codes(report, min_severity=Severity.LOW):
    return {f.code for f in report.findings if f.severity >= min_severity}


class GenuineDocuments(unittest.TestCase):
    """Controls: none of these may raise a finding of LOW or above."""

    def test_report_engine_payslip(self):
        r = analyze_bytes(make_pdf(info={"Producer": "iText 7.2.5", "CreationDate": "D:20250105101500+05'00'",
                                         "ModDate": "D:20250105101500+05'00'"}), "slip.pdf")
        self.assertEqual(codes(r), set())
        self.assertEqual(r.verdict, Verdict.NO_EVIDENCE)

    def test_linearized_file_is_one_version(self):
        data = make_pdf(info={"Producer": "JasperReports Library version 6.20"}, linearize=True)
        self.assertEqual(len(revision_ends(data)), 1)
        self.assertEqual(codes(analyze_bytes(data, "s.pdf")), set())

    def test_translucent_highlight_over_text_is_not_hiding(self):
        content = PAYSLIP + b"/GS1 gs 1 1 0 rg " + VALUE_BOX
        r = analyze_bytes(make_pdf(content, extgstate={"GS1": Dictionary(ca=0.3)}), "s.pdf")
        self.assertEqual(codes(r), set())

    def test_background_box_drawn_before_text(self):
        content = b"0.9 0.9 0.9 rg " + VALUE_BOX + b"0 0 0 rg " + PAYSLIP
        self.assertEqual(codes(analyze_bytes(make_pdf(content), "s.pdf")), set())

    def test_intact_signature(self):
        r = analyze_bytes(sign_pdf(make_pdf(info={"Producer": "iText 7.2.5"})), "s.pdf")
        self.assertIn("SIGNATURE_INTACT", {f.code for f in r.findings})
        self.assertEqual(r.verdict, Verdict.NO_EVIDENCE)

    def test_office_payslip_from_small_employer(self):
        r = analyze_bytes(make_pdf(info={"Producer": "Microsoft® Excel® for Microsoft 365"}), "s.pdf", doc_type="payslip")
        self.assertEqual(r.verdict, Verdict.NO_EVIDENCE)

    def test_compressed_with_utility_stays_below_review(self):
        r = analyze_bytes(make_pdf(info={"Producer": "iLovePDF"}), "s.pdf")
        self.assertEqual(r.verdict, Verdict.NO_EVIDENCE)


class EditedDocuments(unittest.TestCase):
    def test_incremental_edit_recovers_original_value(self):
        original = make_pdf(info={"Producer": "iText 7.2.5"})
        edited = append_update(original, content_object_number(original), PAYSLIP.replace(b"45,000", b"85,000"),
                               producer="PDFescape Online")
        r = analyze_bytes(edited, "s.pdf")
        finding = next(f for f in r.findings if f.code == "REVISION_TEXT_CHANGED")
        change = finding.evidence["pages"][0]["changes"][0]
        self.assertEqual((change["before"], change["after"]), ("45,000", "85,000"))
        self.assertIn("PDF_TOOL_PDF_EDITOR", codes(r))
        self.assertEqual(r.verdict, Verdict.HIGH_RISK)

    def test_whiteout_and_retype(self):
        content = PAYSLIP + b"1 1 1 rg " + VALUE_BOX + b"0 0 0 rg BT /F1 12 Tf 121.4 700 Td (85,000) Tj ET\n"
        r = analyze_bytes(make_pdf(content), "s.pdf")
        finding = next(f for f in r.findings if f.code == "TEXT_REPLACED_UNDER_BOX")
        self.assertEqual(finding.evidence["instances"][0]["hidden_text"], "45,000")
        self.assertEqual(finding.evidence["instances"][0]["text_on_top"], "85,000")
        self.assertEqual(r.verdict, Verdict.HIGH_RISK)

    def test_whiteout_drawn_as_closed_path(self):
        # PyMuPDF (and editors built on it) draw boxes as m/l/l/l/h/h paths, not "re".
        box = b"115 695 m 165 695 l 165 715 l 115 715 l h h f\n"
        content = PAYSLIP + b"1 1 1 rg " + box + b"0 0 0 rg BT /F1 12 Tf 121.4 700 Td (85,000) Tj ET\n"
        self.assertIn("TEXT_REPLACED_UNDER_BOX", codes(analyze_bytes(make_pdf(content), "s.pdf")))

    def test_whiteout_only(self):
        r = analyze_bytes(make_pdf(PAYSLIP + b"1 1 1 rg " + VALUE_BOX), "s.pdf")
        self.assertIn("TEXT_WHITED_OUT", codes(r))

    def test_black_redaction_is_low(self):
        r = analyze_bytes(make_pdf(PAYSLIP + b"0 0 0 rg " + VALUE_BOX), "s.pdf")
        self.assertIn("TEXT_UNDER_BLACK_BOX", {f.code for f in r.findings})
        self.assertEqual(r.verdict, Verdict.NO_EVIDENCE)

    def test_second_font_subset_drawing_digits(self):
        content = (b"BT /F1 12 Tf 72 700 Td (Net Pay ) Tj ET\n"
                   b"BT /F1 12 Tf 72 680 Td (Basic Salary 30,000 Allowances 15,000) Tj ET\n"
                   b"BT /F2 12 Tf 121 700 Td (85,000) Tj ET\n")
        fonts = {"F1": helvetica("ABCDEF+Helvetica"), "F2": helvetica("GHIJKL+Helvetica")}
        r = analyze_bytes(make_pdf(content, fonts=fonts), "s.pdf")
        finding = next(f for f in r.findings if f.code == "DUPLICATE_FONT_SUBSET")
        self.assertEqual(finding.severity, Severity.HIGH)

    def test_font_split_with_disjoint_glyphs_is_low(self):
        content = (b"BT /F1 12 Tf 72 700 Td (Net Pay Basic Salary) Tj ET\n"
                   b"BT /F2 12 Tf 72 680 Td (45,000 30,000) Tj ET\n")
        fonts = {"F1": helvetica("ABCDEF+Helvetica"), "F2": helvetica("GHIJKL+Helvetica")}
        r = analyze_bytes(make_pdf(content, fonts=fonts), "s.pdf")
        finding = next(f for f in r.findings if f.code == "DUPLICATE_FONT_SUBSET")
        self.assertEqual(finding.severity, Severity.LOW)

    def test_freetext_annotation_over_amount(self):
        annot = Dictionary(Type=Name.Annot, Subtype=Name.FreeText, Rect=Array([115, 695, 165, 715]),
                           Contents="85,000", DA="/Helv 12 Tf 0 g")
        r = analyze_bytes(make_pdf(annots=[annot]), "s.pdf")
        finding = next(f for f in r.findings if f.code == "ANNOTATION_OVER_TEXT")
        self.assertEqual(finding.severity, Severity.HIGH)

    def test_text_typed_onto_scan(self):
        scan = jpeg_bytes(document_photo().resize((612, 792)))
        content = (b"q 612 0 0 792 0 0 cm /Im1 Do Q\n"
                   + b"3 Tr " + PAYSLIP * 3
                   + b"0 Tr BT /F1 12 Tf 300 400 Td (85,000) Tj ET\n")
        r = analyze_bytes(make_pdf(content, image=scan), "s.pdf")
        self.assertIn("TEXT_ON_SCANNED_PAGE", codes(r, Severity.MEDIUM))

    def test_signature_broken_by_byte_edit(self):
        signed = sign_pdf(make_pdf(info={"Producer": "iText 7.2.5"}))
        tampered = signed.replace(b"45,000", b"85,000", 1)
        r = analyze_bytes(tampered, "s.pdf")
        self.assertIn("SIGNATURE_BROKEN", codes(r))
        self.assertEqual(r.verdict, Verdict.HIGH_RISK)

    def test_edit_after_signing(self):
        signed = sign_pdf(make_pdf(info={"Producer": "iText 7.2.5"}))
        edited = append_update(signed, content_object_number(signed), PAYSLIP.replace(b"45,000", b"85,000"))
        r = analyze_bytes(edited, "s.pdf")
        self.assertTrue({"MODIFIED_AFTER_SIGNING", "REVISION_TEXT_CHANGED"} <= codes(r))


class MetadataRules(unittest.TestCase):
    def test_design_tool_depends_on_document_type(self):
        data = make_pdf(info={"Producer": "Canva", "Creator": "Canva"})
        finding = lambda r: next(f for f in r.findings if f.code == "PDF_TOOL_DESIGN_TOOL")
        self.assertEqual(finding(analyze_bytes(data, "s.pdf")).severity, Severity.MEDIUM)
        self.assertEqual(finding(analyze_bytes(data, "s.pdf", doc_type="bank_statement")).severity, Severity.HIGH)

    def test_moddate_before_creation(self):
        r = analyze_bytes(make_pdf(info={"CreationDate": "D:20250105101500Z", "ModDate": "D:20240105101500Z"}), "s.pdf")
        self.assertIn("MODDATE_BEFORE_CREATION", codes(r))

    def test_naive_dates_tolerate_timezones(self):
        r = analyze_bytes(make_pdf(info={"CreationDate": "D:20250105101500", "ModDate": "D:20250105001500Z"}), "s.pdf")
        self.assertNotIn("MODDATE_BEFORE_CREATION", codes(r))

    def test_reportlab_defaults(self):
        r = analyze_bytes(make_pdf(info={"Producer": "ReportLab PDF Library - www.reportlab.com",
                                         "Author": "anonymous", "Title": "untitled"}), "s.pdf")
        self.assertIn("SCRIPT_DEFAULT_METADATA", codes(r))

    def test_photoshop_pdf(self):
        r = analyze_bytes(make_pdf(info={"Creator": "Adobe Photoshop 25.0 (Windows)"}), "s.pdf")
        self.assertIn("PDF_TOOL_PHOTO_EDITOR", codes(r, Severity.HIGH))

    def test_unparseable_pdf_is_inconclusive(self):
        r = analyze_bytes(b"%PDF-1.7\n garbage", "s.pdf")
        self.assertEqual(r.verdict, Verdict.INCONCLUSIVE)


if __name__ == "__main__":
    unittest.main()
