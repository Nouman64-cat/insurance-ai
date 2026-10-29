"""Turn a document into the page images sent to the model, and read a PDF's own text layer.

The text layer is the ground truth for what a PDF says: a figure the model
reports that is not in the text layer was misread (or the text layer lies),
which is how layer 2 tells a digit misread apart from a real inconsistency.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation

from PIL import Image, ImageOps

PAGE_LONG_SIDE = 1800  # pixels
IMAGE_LONG_SIDE = 2200
JPEG_QUALITY = 90


@dataclass
class Rendered:
    pages: list[tuple[bytes, str]] = field(default_factory=list)  # (jpeg bytes, mime)
    pages_total: int = 1
    notes: list[str] = field(default_factory=list)


def _to_jpeg(img: Image.Image, long_side: int) -> bytes:
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        background = Image.new("RGB", img.size, "white")
        background.paste(img, mask=img.split()[-1])
        img = background
    elif img.mode != "RGB":
        img = img.convert("RGB")
    scale = long_side / max(img.size)
    if scale < 1:
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


def render_document(data: bytes, file_type: str, max_pages: int = 4) -> Rendered:
    """Render a PDF or image to JPEG pages. Raises on a document that cannot be rendered."""
    out = Rendered()
    if file_type == "pdf":
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(data)
        try:
            out.pages_total = len(pdf)
            if out.pages_total == 0:
                raise ValueError("PDF has no pages")
            for i in range(min(out.pages_total, max_pages)):
                page = pdf[i]
                try:
                    width, height = page.get_size()
                    scale = min(max(PAGE_LONG_SIDE / max(width, height), 1.0), 4.0)
                    out.pages.append((_to_jpeg(page.render(scale=scale).to_pil(), PAGE_LONG_SIDE), "image/jpeg"))
                finally:
                    page.close()
        finally:
            pdf.close()
    else:
        img = Image.open(io.BytesIO(data))
        frames = getattr(img, "n_frames", 1)
        out.pages_total = frames
        for i in range(min(frames, max_pages)):
            img.seek(i)
            out.pages.append((_to_jpeg(img.copy(), IMAGE_LONG_SIDE), "image/jpeg"))
    if out.pages_total > max_pages:
        out.notes.append(f"only the first {max_pages} of {out.pages_total} pages were read")
    return out


# ---------------------------------------------------------------------------
# Text layer
# ---------------------------------------------------------------------------

_NUMBER = re.compile(r"\d[\d,. ' ]*\d|\d")


@dataclass
class TextLayer:
    numbers: set[Decimal] = field(default_factory=set)
    strings: str = ""  # lower-cased text with whitespace removed, for matching identifiers
    has_text: bool = False


def _variants(token: str) -> set[Decimal]:
    """Every reasonable reading of a printed number (comma or dot as the decimal mark)."""
    token = token.replace(" ", " ").strip(" .,'")
    out: set[Decimal] = set()
    compact = token.replace(" ", "").replace("'", "")
    for candidate in (compact.replace(",", ""),                       # 1,234.56  /  2,26,010.00
                      compact.replace(".", "").replace(",", ".")):    # 1.234,56
        try:
            out.add(Decimal(candidate))
        except InvalidOperation:
            continue
    return out


def read_text_layer(data: bytes, max_pages: int = 8) -> TextLayer:
    """Numbers and text a PDF visibly shows. Empty for scans (no text layer).

    Only visible text counts: an original value left hidden under a box, clipped away or overprinted by an edit
    is still in the file, and must not "confirm" a figure. If visibility cannot be worked out, nothing is confirmed.
    """
    from ..pdf.layout import visible_text

    layer = TextLayer()
    try:
        text = visible_text(data, max_pages)
    except Exception:
        return layer
    layer.strings = re.sub(r"\s+", "", text).lower()
    for m in _NUMBER.finditer(text):
        raw = m.group(0)
        layer.numbers |= _variants(raw)
        for part in raw.split():  # "10 20" must also yield 10 and 20
            layer.numbers |= _variants(part)
    layer.has_text = len(re.findall(r"\d", text)) >= 10 and len(layer.strings) >= 80
    return layer
