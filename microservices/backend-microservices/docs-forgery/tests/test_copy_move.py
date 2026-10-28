"""A digit copied from one place on a scanned page and pasted over another, and the images that must stay clean."""

import io
import unittest
import zlib
from unittest import mock

import numpy as np
import pikepdf
from pikepdf import Dictionary, Name
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from docforensics import Severity, Verdict, analyze_bytes
from docforensics import pixels

LINES = ["TOTAL SALES 1,286.40", "CASH 1,300.00", "CHANGE 13.60", "GST 6% 72.82", "ROUNDING 0.02", "INV 88104 8/8/2018"]


def scan(noise: float = 6.0, rules: bool = False, seed: int = 7) -> Image.Image:
    """A receipt as a scanner records it: soft glyph edges and paper noise, so no two prints of a digit are identical."""
    img = Image.new("L", (640, 420), 245)
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=26)
    for i, line in enumerate(LINES):
        draw.text((40, 30 + 60 * i), line, fill=40, font=font)
    if rules:
        draw.rectangle((10, 10, 629, 409), outline=60, width=3)
        for y in (85, 205, 325):
            draw.line((10, y, 629, y), fill=90, width=2)
    img = img.filter(ImageFilter.GaussianBlur(0.9))
    if noise:
        a = np.asarray(img, dtype=np.float64) + np.random.default_rng(seed).normal(0, noise, (img.height, img.width))
        img = Image.fromarray(np.clip(np.round(a), 0, 255).astype(np.uint8))
    return img


def paste(img: Image.Image, src=(40, 30, 64, 62), dst=(200, 270)) -> Image.Image:
    """What Paint's select, copy and paste does: the same pixels at a second place."""
    out = img.copy()
    out.paste(img.crop(src), dst)
    return out


def encode(img: Image.Image, fmt: str, **kwargs) -> bytes:
    buf = io.BytesIO()
    img.save(buf, fmt, **kwargs)
    return buf.getvalue()


def pdf_with_scan(img: Image.Image, jpeg: bool = False) -> bytes:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    if jpeg:
        stream = pikepdf.Stream(pdf, encode(img, "JPEG", quality=95), Filter=Name.DCTDecode)
    else:
        stream = pikepdf.Stream(pdf, zlib.compress(img.tobytes()), Filter=Name.FlateDecode)
    stream.Type, stream.Subtype = Name.XObject, Name.Image
    stream.Width, stream.Height, stream.ColorSpace, stream.BitsPerComponent = img.width, img.height, Name.DeviceGray, 8
    page.Resources = Dictionary(XObject=Dictionary(Im1=stream))
    page.Contents = pdf.make_stream(b"q 612 0 0 792 0 0 cm /Im1 Do Q\n")
    buf = io.BytesIO()
    pdf.save(buf)
    return buf.getvalue()


def copied(report):
    return [f for f in report.findings if f.code == "REGION_COPIED"]


def overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


class PastedRegion(unittest.TestCase):
    def test_pasted_digit_in_png(self):
        r = analyze_bytes(encode(paste(scan()), "PNG"), "receipt.png")
        found = copied(r)
        self.assertEqual(len(found), 1, sorted(f.code for f in r.findings))
        self.assertEqual(found[0].severity, Severity.HIGH)
        self.assertEqual(r.verdict, Verdict.REVIEW)
        region = found[0].evidence["regions"][0]
        self.assertEqual(region["shift"], [160, 240])
        self.assertTrue(overlaps(region["first"], (40, 30, 64, 62)), region)
        self.assertTrue(overlaps(region["second"], (200, 270, 224, 302)), region)

    def test_pasted_digit_in_colour_png_with_alpha(self):
        r = analyze_bytes(encode(paste(scan()).convert("RGBA"), "PNG"), "receipt.png")
        self.assertTrue(copied(r))

    def test_pasted_digit_in_lzw_tiff(self):
        r = analyze_bytes(encode(paste(scan()), "TIFF", compression="tiff_lzw"), "receipt.tif")
        self.assertTrue(copied(r))

    def test_pasted_digit_in_scanned_pdf(self):
        r = analyze_bytes(pdf_with_scan(paste(scan())), "receipt.pdf")
        found = copied(r)
        self.assertTrue(found, sorted(f.code for f in r.findings))
        self.assertIn("page 1", found[0].title)


class Clean(unittest.TestCase):
    def test_genuine_scan(self):
        self.assertFalse(copied(analyze_bytes(encode(scan(), "PNG"), "receipt.png")))

    def test_ruled_lines_and_border(self):
        self.assertFalse(copied(analyze_bytes(encode(scan(rules=True), "PNG"), "receipt.png")))

    def test_rendered_text_without_noise(self):
        # Every repeated glyph is identical in a rendered image, so the image repeats itself by nature: not judged.
        for img in (scan(noise=0), paste(scan(noise=0))):
            r = analyze_bytes(encode(img, "PNG"), "receipt.png")
            self.assertFalse(copied(r))
            self.assertIn("COPY_MOVE_NOT_CHECKED", {f.code for f in r.findings})

    def test_jpeg_is_not_judged(self):
        # A JPEG save erases exact repeats and makes new ones, so its pixels are not compared at all.
        r = analyze_bytes(encode(paste(scan()), "JPEG", quality=95), "receipt.jpg")
        self.assertFalse(copied(r))
        props = next(f for f in r.findings if f.code == "IMAGE_PROPERTIES")
        self.assertNotIn("pixels_checked", props.evidence)

    def test_jpeg_scan_in_pdf_is_not_judged(self):
        self.assertFalse(copied(analyze_bytes(pdf_with_scan(paste(scan()), jpeg=True), "receipt.pdf")))

    def test_too_large_is_reported_not_judged(self):
        with mock.patch.object(pixels, "MAX_PIXELS", 1000):
            r = analyze_bytes(encode(paste(scan()), "PNG"), "receipt.png")
        self.assertFalse(copied(r))
        self.assertIn("COPY_MOVE_NOT_CHECKED", {f.code for f in r.findings})
        self.assertEqual(r.verdict, Verdict.NO_EVIDENCE)


class Mechanics(unittest.TestCase):
    def test_strips_agree_with_one_pass(self):
        g = pixels.gray(paste(scan(), dst=(300, 330)))
        whole = pixels.copied_regions(g)
        with mock.patch.object(pixels, "STRIP", 37):
            self.assertEqual([r.to_dict() for r in pixels.copied_regions(g)], [r.to_dict() for r in whole])

    def test_sixteen_bit_greyscale(self):
        a = (np.asarray(paste(scan()), dtype=np.uint16) * 257)
        self.assertTrue(pixels.copied_regions(pixels.gray(Image.fromarray(a))))
