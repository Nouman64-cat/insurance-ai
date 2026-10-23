import io
import unittest

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from docforensics import Severity, Verdict, analyze_bytes
from docforensics.provenance import _interpret_c2pa

from .builders import AI_XMP, document_photo, jpeg_bytes, with_exif_thumbnail


def codes(report, min_severity=Severity.LOW):
    return {f.code for f in report.findings if f.severity >= min_severity}


def phone_exif(software: str | None = None) -> Image.Exif:
    exif = Image.Exif()
    exif[0x010F], exif[0x0110] = "samsung", "SM-S918B"
    exif[0x0132] = "2025:01:05 10:15:00"
    if software:
        exif[0x0131] = software
    exif.get_ifd(0x8769)[0x9003] = "2025:01:05 10:15:00"
    return exif


class GenuineImages(unittest.TestCase):
    def test_heavily_compressed_phone_photo(self):
        for quality in (95, 60, 30, 10):
            r = analyze_bytes(jpeg_bytes(document_photo(), quality, phone_exif("S918BXXU3BWK5")), "p.jpg")
            self.assertEqual(codes(r), set(), f"quality {quality}")

    def test_downscaled_whatsapp_style_copy(self):
        img = document_photo().resize((400, 500))
        self.assertEqual(analyze_bytes(jpeg_bytes(img, 50), "p.jpg").verdict, Verdict.NO_EVIDENCE)

    def test_matching_thumbnail_survives_compression(self):
        img = document_photo()
        thumb = jpeg_bytes(img.resize((128, 160)), 60)
        r = analyze_bytes(with_exif_thumbnail(jpeg_bytes(img, 40), thumb), "p.jpg")
        self.assertFalse(codes(r) & {"THUMBNAIL_MISMATCH", "THUMBNAIL_DIFFERS"})


class ManipulatedImages(unittest.TestCase):
    def test_photoshop_software_tag(self):
        r = analyze_bytes(jpeg_bytes(document_photo(), 90, phone_exif("Adobe Photoshop 25.0 (Windows)")), "p.jpg")
        self.assertIn("IMAGE_SOFTWARE_PHOTO_EDITOR", codes(r, Severity.HIGH))

    def test_edited_after_capture(self):
        exif = phone_exif()
        exif[0x0132] = "2025:02:10 18:00:00"
        r = analyze_bytes(jpeg_bytes(document_photo(), 90, exif), "p.jpg")
        self.assertIn("IMAGE_MODIFIED_AFTER_CAPTURE", codes(r))

    def test_stale_thumbnail(self):
        original, edited = document_photo(seed=1), document_photo(seed=7)
        thumb = jpeg_bytes(original.resize((128, 160)), 80)
        r = analyze_bytes(with_exif_thumbnail(jpeg_bytes(edited, 85), thumb), "p.jpg")
        self.assertTrue(codes(r) & {"THUMBNAIL_MISMATCH", "THUMBNAIL_DIFFERS"})

    def test_stable_diffusion_png(self):
        meta = PngInfo()
        meta.add_text("parameters", "salary slip, corporate\nNegative prompt: blurry\nSteps: 30, Sampler: Euler a, CFG scale: 7")
        buf = io.BytesIO()
        document_photo().save(buf, "PNG", pnginfo=meta)
        r = analyze_bytes(buf.getvalue(), "p.png")
        self.assertIn("AI_GENERATION_PARAMETERS", codes(r, Severity.CRITICAL))

    def test_iptc_ai_source_type(self):
        r = analyze_bytes(jpeg_bytes(document_photo(), 90, xmp=AI_XMP), "p.jpg")
        self.assertIn("IPTC_AI_SOURCE_TYPE", codes(r, Severity.CRITICAL))
        self.assertEqual(r.verdict, Verdict.HIGH_RISK)

    def test_extension_mismatch(self):
        r = analyze_bytes(jpeg_bytes(document_photo()), "statement.pdf")
        self.assertIn("EXTENSION_MISMATCH", codes(r))


class C2paInterpretation(unittest.TestCase):
    def store(self, actions, failures=()):
        return {"active_manifest": "m1", "manifests": {"m1": {
            "claim_generator_info": [{"name": "ChatGPT", "version": "1.0"}],
            "signature_info": {"issuer": "OpenAI"},
            "assertions": [{"label": "c2pa.actions.v2", "data": {"actions": actions}}]}},
            "validation_status": list(failures)}

    def test_ai_created(self):
        findings = _interpret_c2pa(self.store([{"action": "c2pa.created", "digitalSourceType":
                                                "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"}]), "image")
        self.assertEqual(findings[0].code, "C2PA_AI_GENERATED")
        self.assertEqual(findings[0].severity, Severity.CRITICAL)

    def test_hash_mismatch(self):
        findings = _interpret_c2pa(self.store([{"action": "c2pa.opened"}], [{"code": "assertion.dataHash.mismatch"}]), "image")
        self.assertIn("C2PA_HASH_MISMATCH", {f.code for f in findings})

    def test_untrusted_signer_is_not_tampering(self):
        findings = _interpret_c2pa(self.store([{"action": "c2pa.created", "digitalSourceType": "digitalCapture"}],
                                              [{"code": "signingCredential.untrusted"}]), "image")
        self.assertEqual({f.code for f in findings}, {"C2PA_PRESENT"})


if __name__ == "__main__":
    unittest.main()
