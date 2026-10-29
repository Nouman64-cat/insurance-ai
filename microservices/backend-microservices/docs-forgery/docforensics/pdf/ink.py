"""Which characters actually show on the rendered page.

The draw-order checks model how a PDF hides text (boxes, clipping, invisible
modes). Rendering the page answers the question directly, whatever the method:
a letter or digit whose box on the rendered page holds no ink is not visible,
whether it was painted in the background colour, clipped, pushed under an image
inside a form, or hidden some way no rule here anticipates.

Annotations are left out of the render; ``check_annotations`` covers them.
"""

from __future__ import annotations

import numpy as np

from .layout import NO_INK, OFF_PAGE, PageLayout

SCALE = 2.0  # 144 dpi: a 6 pt digit is 12 px tall
MIN_CONTRAST = 24.0  # luminance step that counts as an edge of ink (light grey text on white still counts)
MIN_INK = 0.02  # fraction of the box that must be ink edges; a "1" or an "i" is well above this
MAX_GLYPHS = 20_000  # per page; beyond this the page is skipped rather than slowing every request


def _render(page) -> np.ndarray:
    try:
        bitmap = page.render(scale=SCALE, may_draw_forms=False, draw_annots=False)
    except TypeError:  # older pypdfium2 without these options
        bitmap = page.render(scale=SCALE)
    return np.asarray(bitmap.to_pil().convert("L"), dtype=np.float32)


def _edge_counts(pixels: np.ndarray) -> np.ndarray:
    """Summed-area table of ink edges: any box's edge count is then four lookups.

    Edges rather than dark pixels, so light text on a dark band counts as ink just as dark text on paper does.
    """
    edges = np.zeros(pixels.shape, dtype=bool)
    edges[:, :-2] |= np.abs(pixels[:, 2:] - pixels[:, :-2]) > MIN_CONTRAST
    edges[:-2, :] |= np.abs(pixels[2:, :] - pixels[:-2, :]) > MIN_CONTRAST
    table = np.zeros((pixels.shape[0] + 1, pixels.shape[1] + 1), dtype=np.int64)
    table[1:, 1:] = edges.cumsum(0).cumsum(1)
    return table


def uninked_glyphs(data: bytes, layouts: list[PageLayout]) -> dict[int, dict[int, str]]:
    """Per page number: paint order -> why that letter or digit shows no ink (``OFF_PAGE`` or ``NO_INK``).

    Pages that are rotated, empty of text or unrenderable are absent: no answer, not "all visible".
    """
    import pypdfium2 as pdfium

    out: dict[int, dict[int, str]] = {}
    pdf = pdfium.PdfDocument(data)
    try:
        for layout in layouts:
            glyphs = [g for g in layout.glyphs if g.visible and g.text.isalnum()]
            if layout.rotate or not glyphs or len(glyphs) > MAX_GLYPHS or layout.number > len(pdf):
                continue
            page = pdf[layout.number - 1]
            try:
                left, _, _, top = page.get_cropbox()
                pixels = _render(page)
            finally:
                page.close()
            height, width = pixels.shape
            table = _edge_counts(pixels)
            ox, oy = layout.origin  # pdfminer coordinates are relative to the media box origin
            boxes = np.array([g.bbox for g in glyphs], dtype=float)
            orders = np.array([g.order for g in glyphs])
            w, h = boxes[:, 2] - boxes[:, 0], boxes[:, 3] - boxes[:, 1]
            # Trim each box to the glyph's own cell so a neighbour's ink is not counted.
            px0 = np.floor((boxes[:, 0] + 0.15 * w + ox - left) * SCALE).astype(int)
            px1 = np.ceil((boxes[:, 2] - 0.15 * w + ox - left) * SCALE).astype(int)
            py0 = np.floor((top - (boxes[:, 3] - 0.1 * h + oy)) * SCALE).astype(int)
            py1 = np.ceil((top - (boxes[:, 1] + 0.1 * h + oy)) * SCALE).astype(int)
            off_page = (px1 <= 0) | (py1 <= 0) | (px0 >= width) | (py0 >= height)
            px0, px1 = np.clip(px0, 0, width), np.clip(px1, 0, width)
            py0, py1 = np.clip(py0, 0, height), np.clip(py1, 0, height)
            area = (px1 - px0) * (py1 - py0)
            ink = table[py1, px1] - table[py0, px1] - table[py1, px0] + table[py0, px0]
            judged = (w > 0.5) & (h > 1) & (area > 0)  # smaller boxes are too small to judge
            blank = judged & (ink < np.maximum(2, MIN_INK * area)) & ~off_page
            reasons = {int(o): OFF_PAGE for o in orders[off_page]}
            reasons.update({int(o): NO_INK for o in orders[blank]})
            out[layout.number] = reasons
    finally:
        pdf.close()
    return out
