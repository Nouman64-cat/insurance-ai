"""Metadata of images embedded in a PDF, and pasted regions in scanned pages.

JPEG images (DCTDecode) are stored byte-for-byte, so their EXIF, XMP and C2PA
data survive inside the PDF: a scan edited in Photoshop and then wrapped in a
PDF still says so. A page image stored losslessly (Flate, LZW) is also checked
for regions copied and pasted inside it (pixels.py).

Only images that make up the page (scans, photos) are judged like standalone
images. Logos and stamps on generated documents are made by designers in
Photoshop or Illustrator as a matter of course, so for those the editing
software is context, and AI provenance is capped at MEDIUM.
"""

from __future__ import annotations

import pikepdf

from .. import xmp
from ..image_checks import check_image
from ..pixels import MAX_PIXELS, check_copy_move
from ..provenance import check_source_types
from ..report import Category, Finding, Severity
from .context import Context
from .layout import PageLayout

PAGE_IMAGE_COVERAGE = 0.5  # fraction of the page an image must cover to count as the document itself
# Lossy pixels cannot show an exact repeat; bilevel codecs have no noise, and JBIG2 reuses one bitmap per symbol.
_NOT_LOSSLESS = {"/DCTDecode", "/JPXDecode", "/JBIG2Decode", "/CCITTFaxDecode"}


def _image_xobjects(pdf: pikepdf.Pdf, max_pages: int):
    seen: set = set()

    def visit(resources, page_no: int, depth: int):
        if resources is None or depth > 8:
            return
        for name, xo in (resources.get("/XObject") or {}).items():
            try:
                key = xo.objgen
                subtype = xo.get("/Subtype")
            except Exception:
                continue
            if key in seen:
                continue
            seen.add(key)
            if subtype == "/Image":
                yield page_no, str(name).lstrip("/"), xo
            elif subtype == "/Form":
                yield from visit(xo.get("/Resources"), page_no, depth + 1)

    for page_no, page in enumerate(pdf.pages, start=1):
        if page_no > max_pages:
            break
        yield from visit(page.obj.get("/Resources"), page_no, 0)


def _filters(xo) -> list[str]:
    f = xo.get("/Filter")
    if f is None:
        return []
    return [str(x) for x in f] if isinstance(f, pikepdf.Array) else [str(f)]


def _copy_move(xo, where: str, errors: list[str]) -> list[Finding]:
    """Regions pasted inside a lossless page image (a scan stored with Flate or LZW)."""
    try:
        if int(xo.get("/Width", 0)) * int(xo.get("/Height", 0)) > MAX_PIXELS:
            return []
        img = pikepdf.PdfImage(xo).as_pil_image()
    except Exception as exc:
        errors.append(f"copy-move ({where}): could not decode the image: {exc}")
        return []
    found, copy_errors = check_copy_move(img, where)
    errors += copy_errors
    return found


def _as_asset(finding: Finding) -> Finding | None:
    """Re-grade a finding from a logo-sized image."""
    if finding.category is Category.AI_GENERATION:
        finding.severity = min(finding.severity, Severity.MEDIUM)
        finding.detail += " The image is a small element on the page (logo, stamp or signature), not the page itself."
        return finding
    return None


def check_embedded_images(pdf: pikepdf.Pdf, ctx: Context, layouts: list[PageLayout]) -> tuple[list[Finding], list[str]]:
    findings: list[Finding] = []
    errors: list[str] = []
    by_page = {layout.number: layout for layout in layouts}
    for page_no, name, xo in _image_xobjects(pdf, ctx.max_pages):
        where = f"page {page_no} image {name}"
        layout = by_page.get(page_no)
        is_page_image = layout is not None and layout.image_coverage(name) >= PAGE_IMAGE_COVERAGE
        image_findings: list[Finding] = []
        metadata = xo.get("/Metadata")
        if metadata is not None:
            try:
                packet = xmp.parse_packet(metadata.read_bytes())
                if packet:
                    image_findings += check_source_types(packet.all("Iptc4xmpExt:DigitalSourceType"), where)
            except Exception as exc:
                errors.append(f"image xmp ({where}): {exc}")
        if _filters(xo) == ["/DCTDecode"]:
            try:
                found, image_errors, _ = check_image(xo.read_raw_bytes(), where, "JPEG")
                image_findings += found
                errors += image_errors
            except Exception as exc:
                errors.append(f"image ({where}): {exc}")
        elif is_page_image and not set(_filters(xo)) & _NOT_LOSSLESS:
            image_findings += _copy_move(xo, where, errors)
        for f in image_findings:
            if not is_page_image:
                f = _as_asset(f)
            # Context-only findings for every embedded image would bury the signal.
            if f is not None and f.severity >= Severity.LOW:
                findings.append(f)
    return findings, errors
