"""Draw-order analysis of page content.

pdfminer is run without layout analysis so every glyph, filled shape and image
comes back in the order it was painted. Later items paint over earlier ones,
which exposes the classic edit: cover the old value with a box, type a new one.

Fill transparency matters here: a translucent highlight drawn after text does
not hide it. pdfminer ignores the ``gs`` operator, so the interpreter below
records fill alpha, blend mode and soft masks from ExtGState.
"""

from __future__ import annotations

import io
import logging
import re
from dataclasses import dataclass, field

import numpy as np
import pikepdf
from pdfminer.converter import PDFLayoutAnalyzer
from pdfminer.layout import LTChar, LTCurve, LTFigure, LTImage, LTPage, LTRect
from pdfminer.pdfdocument import PDFDocument
from pdfminer.pdfinterp import PDFGraphicState, PDFPageInterpreter, PDFResourceManager
from pdfminer.pdfpage import PDFPage
from pdfminer.pdfparser import PDFParser
from pdfminer.pdftypes import dict_value, resolve1
from pdfminer.psparser import PSLiteral

from ..report import Category, Finding, Severity

logging.getLogger("pdfminer").setLevel(logging.ERROR)

_INVISIBLE_RENDER_MODES = {3, 7}
_DIGIT = re.compile(r"\d")


class _GraphicState(PDFGraphicState):
    def __init__(self) -> None:
        super().__init__()
        self.fill_alpha = 1.0
        self.normal_blend = True

    def copy(self) -> "_GraphicState":
        obj = _GraphicState()
        obj.__dict__.update(self.__dict__)
        return obj


class _Interpreter(PDFPageInterpreter):
    def init_resources(self, resources) -> None:
        super().init_resources(resources)
        try:
            self._extgstate = dict_value(resources.get("ExtGState")) if resources else {}
        except Exception:
            self._extgstate = {}

    def init_state(self, ctm) -> None:
        super().init_state(ctm)
        self.graphicstate = _GraphicState()

    def do_gs(self, name) -> None:
        key = name.name if isinstance(name, PSLiteral) else str(name)
        try:
            params = dict_value(self._extgstate.get(key))
        except Exception:
            return
        if "ca" in params:
            try:
                self.graphicstate.fill_alpha = float(resolve1(params["ca"]))
            except (TypeError, ValueError):
                pass
        blend = resolve1(params.get("BM"))
        if isinstance(blend, list):
            blend = resolve1(blend[0]) if blend else None
        if isinstance(blend, PSLiteral):
            self.graphicstate.normal_blend = blend.name in ("Normal", "Compatible")
        smask = resolve1(params.get("SMask"))
        if smask is not None and not (isinstance(smask, PSLiteral) and smask.name == "None"):
            self.graphicstate.normal_blend = False


class _Device(PDFLayoutAnalyzer):
    def __init__(self, rsrcmgr) -> None:
        super().__init__(rsrcmgr, pageno=1, laparams=None)
        self.pages: list[LTPage] = []
        self._render_mode = 0

    def receive_layout(self, ltpage: LTPage) -> None:
        self.pages.append(ltpage)

    def render_string(self, textstate, seq, ncs, graphicstate) -> None:
        self._render_mode = textstate.render
        super().render_string(textstate, seq, ncs, graphicstate)

    def render_char(self, matrix, font, fontsize, scaling, rise, cid, ncs, graphicstate) -> float:
        adv = super().render_char(matrix, font, fontsize, scaling, rise, cid, ncs, graphicstate)
        item = self.cur_item._objs[-1]
        item.render_mode = self._render_mode
        item.fill_alpha = getattr(graphicstate, "fill_alpha", 1.0)
        # pdfminer's fontname comes from the FontDescriptor, which may be absent; BaseFont is always set.
        item.basefont = getattr(font, "basefont", None) or item.fontname
        return adv

    def paint_path(self, gstate, stroke, fill, evenodd, path) -> None:
        before = len(self.cur_item._objs)
        super().paint_path(gstate, stroke, fill, evenodd, path)
        for item in self.cur_item._objs[before:]:
            item.fill_alpha = getattr(gstate, "fill_alpha", 1.0)
            item.normal_blend = getattr(gstate, "normal_blend", True)


@dataclass
class Glyph:
    order: int
    text: str
    bbox: tuple[float, float, float, float]
    font: str
    visible: bool


@dataclass
class Shape:
    order: int
    bbox: tuple[float, float, float, float]
    opaque: bool
    luminance: float | None
    color: object
    name: str | None = None  # XObject name, for images


@dataclass
class PageLayout:
    number: int
    width: float
    height: float
    rotate: int
    origin: tuple[float, float]
    glyphs: list[Glyph] = field(default_factory=list)
    shapes: list[Shape] = field(default_factory=list)
    images: list[Shape] = field(default_factory=list)

    def image_coverage(self, name: str) -> float:
        """Largest fraction of the page drawn by the named image (0 when not drawn)."""
        area = self.width * self.height or 1.0
        return max(((b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) / area for b in self.images if b.name == name),
                   default=0.0)

    def visible_text_by_font(self) -> dict[str, str]:
        out: dict[str, list[str]] = {}
        for g in self.glyphs:
            if g.visible:
                out.setdefault(g.font, []).append(g.text)
        return {k: "".join(v) for k, v in out.items()}


def _luminance(color) -> float | None:
    if isinstance(color, tuple) and len(color) == 2 and isinstance(color[1], str):
        color = color[0]  # (components, pattern name)
    if isinstance(color, (int, float)):
        return float(color)
    if isinstance(color, (list, tuple)):
        c = [float(v) for v in color if isinstance(v, (int, float))]
        if len(c) == 1:
            return c[0]
        if len(c) == 3:
            return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
        if len(c) == 4:
            k = c[3]
            r, g, b = ((1 - c[0]) * (1 - k), (1 - c[1]) * (1 - k), (1 - c[2]) * (1 - k))
            return 0.299 * r + 0.587 * g + 0.114 * b
    return None


def _is_rect_like(item: LTCurve) -> bool:
    """A straight-edged path whose points are exactly the four corners of its bbox.

    Writers differ in how they close a box (PyMuPDF emits ``h`` twice), so the point
    count varies; the corner test does not.
    """
    path = getattr(item, "original_path", None) or []
    if any(seg[0] not in ("m", "l", "h") for seg in path):
        return False
    pts = getattr(item, "pts", None) or []
    tol = 0.75
    corners = set()
    for x, y in pts:
        cx = 0 if abs(x - item.x0) < tol else 1 if abs(x - item.x1) < tol else None
        cy = 0 if abs(y - item.y0) < tol else 1 if abs(y - item.y1) < tol else None
        if cx is None or cy is None:
            return False
        corners.add((cx, cy))
    return len(corners) == 4


def _flatten(container, out: list) -> None:
    for item in container:
        if isinstance(item, LTFigure):
            _flatten(item, out)
        else:
            out.append(item)


def extract_layouts(data: bytes, max_pages: int) -> tuple[list[PageLayout], list[str]]:
    errors: list[str] = []
    layouts: list[PageLayout] = []
    try:
        parser = PDFParser(io.BytesIO(data))
        document = PDFDocument(parser, password="")
    except Exception as exc:
        return [], [f"layout: could not open with pdfminer: {exc}"]
    rsrcmgr = PDFResourceManager(caching=True)
    device = _Device(rsrcmgr)
    interpreter = _Interpreter(rsrcmgr, device)
    for number, page in enumerate(PDFPage.create_pages(document), start=1):
        if number > max_pages:
            break
        try:
            interpreter.process_page(page)
        except Exception as exc:
            errors.append(f"layout: page {number}: {exc}")
            continue
        lt = device.pages.pop()
        x0, y0, x1, y1 = page.mediabox
        layout = PageLayout(number, lt.width, lt.height, int(page.rotate or 0) % 360, (float(x0), float(y0)))
        items: list = []
        _flatten(lt, items)
        for order, item in enumerate(items):
            if isinstance(item, LTChar):
                text = item.get_text()
                visible = (getattr(item, "render_mode", 0) not in _INVISIBLE_RENDER_MODES
                           and getattr(item, "fill_alpha", 1.0) > 0.05)
                layout.glyphs.append(Glyph(order, text, item.bbox, str(getattr(item, "basefont", item.fontname)), visible))
            elif isinstance(item, (LTRect, LTCurve)) and item.fill:
                if isinstance(item, LTCurve) and not isinstance(item, LTRect) and not _is_rect_like(item):
                    continue
                opaque = getattr(item, "fill_alpha", 1.0) >= 0.98 and getattr(item, "normal_blend", True)
                color = item.non_stroking_color
                layout.shapes.append(Shape(order, item.bbox, opaque, _luminance(color), color))
            elif isinstance(item, LTImage):
                layout.images.append(Shape(order, item.bbox, True, None, None, str(item.name).lstrip("/")))
        layouts.append(layout)
    return layouts, errors


def _coverage(boxes: np.ndarray, rect: tuple[float, float, float, float]) -> np.ndarray:
    """Fraction of each box's area that lies inside rect."""
    ix = np.clip(np.minimum(boxes[:, 2], rect[2]) - np.maximum(boxes[:, 0], rect[0]), 0, None)
    iy = np.clip(np.minimum(boxes[:, 3], rect[3]) - np.maximum(boxes[:, 1], rect[1]), 0, None)
    area = np.clip((boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1]), 1e-6, None)
    return (ix * iy) / area


def _reading_order(glyphs: list[Glyph]) -> str:
    ordered = sorted(glyphs, key=lambda g: (-round(g.bbox[1] / 3), g.bbox[0]))
    return "".join(g.text for g in ordered).strip()


def _norm_text(s: str) -> str:
    return re.sub(r"\s+", "", s).lower()


def check_overlays(page: PageLayout) -> list[Finding]:
    """Text painted over by an opaque box, and what was painted on top of the box."""
    visible = [g for g in page.glyphs if g.visible and g.text.strip()]
    if not visible or not page.shapes:
        return []
    boxes = np.array([g.bbox for g in visible], dtype=float)
    orders = np.array([g.order for g in visible])
    page_area = page.width * page.height
    instances = []
    for shape in page.shapes:
        if not shape.opaque:
            continue
        w, h = shape.bbox[2] - shape.bbox[0], shape.bbox[3] - shape.bbox[1]
        if w * h < 4 or w * h > 0.5 * page_area:
            continue
        cov = _coverage(boxes, shape.bbox) >= 0.6
        under = [visible[i] for i in np.where(cov & (orders < shape.order))[0]]
        if not any(c.text.isalnum() for c in under):
            continue
        over = [visible[i] for i in np.where(cov & (orders > shape.order))[0]]
        hidden, shown = _reading_order(under), _reading_order(over)
        instances.append({"bbox": [round(v, 1) for v in shape.bbox], "hidden_text": hidden[:200],
                          "text_on_top": shown[:200], "box_luminance": None if shape.luminance is None else round(shape.luminance, 2),
                          "box_color": str(shape.color)[:60]})
    if not instances:
        return []

    findings = []
    replaced = [i for i in instances if i["text_on_top"] and _norm_text(i["text_on_top"]) != _norm_text(i["hidden_text"])
                and (_DIGIT.search(i["hidden_text"]) or _DIGIT.search(i["text_on_top"]))]
    overlaid = [i for i in instances if i["text_on_top"] and i not in replaced]
    whited = [i for i in instances if not i["text_on_top"] and (i["box_luminance"] or 0) >= 0.85]
    redacted = [i for i in instances if not i["text_on_top"] and i["box_luminance"] is not None and i["box_luminance"] <= 0.15]
    other = [i for i in instances if not i["text_on_top"] and i not in whited and i not in redacted]
    p = page.number
    if replaced:
        first = replaced[0]
        findings.append(Finding(
            "TEXT_REPLACED_UNDER_BOX", Severity.CRITICAL, Category.TAMPERING,
            f"Value covered with a box and retyped (page {p})",
            f"Under an opaque box the page still contains '{first['hidden_text']}'; on top of the box it shows "
            f"'{first['text_on_top']}'. This is how a value is edited by hand in a PDF.",
            {"page": p, "instances": replaced[:20]},
        ))
    if overlaid:
        findings.append(Finding(
            "TEXT_OVERLAID", Severity.HIGH, Category.TAMPERING,
            f"Text drawn on top of a box that hides other text (page {p})",
            f"Hidden: '{overlaid[0]['hidden_text']}'. Shown on top: '{overlaid[0]['text_on_top']}'.",
            {"page": p, "instances": overlaid[:20]},
        ))
    if whited:
        findings.append(Finding(
            "TEXT_WHITED_OUT", Severity.HIGH, Category.TAMPERING,
            f"Text hidden under a background-coloured box (page {p})",
            f"'{whited[0]['hidden_text']}' is painted over by a light box, which erases it from view without deleting it.",
            {"page": p, "instances": whited[:20]},
        ))
    if other:
        findings.append(Finding(
            "TEXT_HIDDEN_UNDER_SHAPE", Severity.MEDIUM, Category.TAMPERING,
            f"Text hidden under a coloured shape (page {p})",
            f"'{other[0]['hidden_text']}' is covered by an opaque shape.",
            {"page": p, "instances": other[:20]},
        ))
    if redacted:
        findings.append(Finding(
            "TEXT_UNDER_BLACK_BOX", Severity.LOW, Category.CONTEXT,
            f"Text covered by a black box (page {p})",
            "Looks like a manual redaction. The covered text is still in the file.",
            {"page": p, "instances": redacted[:20]},
        ))
    return findings


def check_scanned_overlay(page: PageLayout) -> list[Finding]:
    """Real text typed on top of a page that is a scanned image."""
    page_area = page.width * page.height
    full = [im for im in page.images if (im.bbox[2] - im.bbox[0]) * (im.bbox[3] - im.bbox[1]) >= 0.85 * page_area]
    if not full:
        return []
    scan = full[0]
    ocr_glyphs = sum(1 for g in page.glyphs if not g.visible)
    on_top = [g for g in page.glyphs if g.visible and g.text.strip() and g.order > scan.order]
    if not on_top:
        return []
    text = _reading_order(on_top)
    if ocr_glyphs >= 20:
        severity, why = Severity.MEDIUM, "The page is a scan with an invisible OCR layer, and separate visible text was added on top."
    elif len(on_top) <= 60:
        severity, why = Severity.LOW, "A few characters of real text sit on top of a full-page image (often page numbers or stamps)."
    else:
        return []  # a generated document drawn over a full-page background image
    return [Finding(
        "TEXT_ON_SCANNED_PAGE", severity, Category.TAMPERING,
        f"Typed text on top of a scanned page (page {page.number})",
        f"{why} Text: '{text[:120]}'.",
        {"page": page.number, "text": text[:500], "glyphs": len(on_top), "ocr_glyphs": ocr_glyphs},
    )]


_COVERING_ANNOTS = {"/FreeText": Severity.MEDIUM, "/Square": Severity.MEDIUM, "/Polygon": Severity.MEDIUM,
                    "/Redact": Severity.MEDIUM, "/Ink": Severity.LOW, "/Stamp": Severity.LOW}


def check_annotations(pdf: pikepdf.Pdf, layouts: list[PageLayout]) -> list[Finding]:
    """Annotations placed over page text, e.g. a FreeText box showing a different number."""
    findings = []
    for layout in layouts:
        if layout.rotate or layout.number > len(pdf.pages):
            continue
        visible = [g for g in layout.glyphs if g.visible and g.text.strip()]
        if not visible:
            continue
        boxes = np.array([g.bbox for g in visible], dtype=float)
        page = pdf.pages[layout.number - 1].obj
        for annot in page.get("/Annots") or []:
            subtype = str(annot.get("/Subtype", ""))
            if subtype not in _COVERING_ANNOTS:
                continue
            try:
                r = [float(v) for v in annot["/Rect"]]
            except Exception:
                continue
            ox, oy = layout.origin
            rect = (min(r[0], r[2]) - ox, min(r[1], r[3]) - oy, max(r[0], r[2]) - ox, max(r[1], r[3]) - oy)
            covered = [visible[i] for i in np.where(_coverage(boxes, rect) >= 0.6)[0]]
            if not any(c.text.isalnum() for c in covered):
                continue
            contents = str(annot.get("/Contents", ""))
            severity = _COVERING_ANNOTS[subtype]
            if subtype == "/FreeText" and _DIGIT.search(contents):
                severity = Severity.HIGH
            findings.append(Finding(
                "ANNOTATION_OVER_TEXT", severity, Category.TAMPERING,
                f"{subtype.lstrip('/')} annotation placed over text (page {layout.number})",
                f"An annotation covers '{_reading_order(covered)[:80]}'"
                + (f" and displays '{contents[:80]}'." if contents else "."),
                {"page": layout.number, "subtype": subtype, "rect": [round(v, 1) for v in rect],
                 "covered_text": _reading_order(covered)[:200], "annotation_text": contents[:200]},
            ))
    return findings


def check_layout(pdf: pikepdf.Pdf, layouts: list[PageLayout]) -> list[Finding]:
    findings: list[Finding] = []
    for layout in layouts:
        findings += check_overlays(layout)
        findings += check_scanned_overlay(layout)
    findings += check_annotations(pdf, layouts)
    return findings
