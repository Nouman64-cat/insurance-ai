"""Consistency of figures within a column.

A generator prints every amount in a column the same way: one font, one size,
one baseline relative to its row label. A value retyped in an editor is often
the one exception: a fallback font, 11.5 pt among 12 pt, or nudged off the
baseline. Each check needs at least two agreeing neighbours, so a column of
two proves nothing, and totals set in bold or a clearly larger size (design
emphasis) are not counted as exceptions.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from ..report import Category, Finding, Severity
from .layout import Glyph, PageLayout

_AMOUNT = re.compile(r"^\(?-?\d[\d,.' ]*\d\)?-?$")
_SUBSET = re.compile(r"^[A-Z]{6}\+")
_STYLE = re.compile(r"[-,]?(bold|semibold|demibold|black|heavy|italic|oblique|regular|roman|book|medium|light|mt|ps)+$")


def family(font: str) -> str:
    """'ABCDEF+Arial-BoldMT' -> 'arial'. Weight and slant are design choices, not a different font."""
    name = _SUBSET.sub("", font).lower().replace(" ", "")
    previous = None
    while previous != name:
        previous, name = name, _STYLE.sub("", name)
    return name or font.lower()


def amounts(text: str) -> list[Decimal]:
    """Every reasonable reading of a printed amount (comma or dot as the decimal mark), as absolute values."""
    compact = text.strip("()-").replace(" ", "").replace("'", "")
    english, european = compact.replace(",", ""), compact.replace(".", "").replace(",", ".")
    if "," in compact and "." in compact:  # with both marks, the last one is the decimal point
        candidates = (english,) if compact.rfind(".") > compact.rfind(",") else (european,)
    else:
        candidates = (english, european)
    out = []
    for candidate in candidates:
        try:
            value = abs(Decimal(candidate))
        except InvalidOperation:
            continue
        if value not in out:
            out.append(value)
    return out


@dataclass
class Token:
    glyphs: list[Glyph]
    text: str
    family: str
    size: float
    baseline: float
    x0: float
    x1: float
    y0: float
    y1: float


def _tokens(glyphs: list[Glyph]) -> list[Token]:
    """Amounts printed on the page: runs of digits and separators on one baseline with no word gap."""
    out = []
    lines: list[list[Glyph]] = []
    for g in sorted(glyphs, key=lambda g: (-g.baseline, g.bbox[0])):
        if lines and abs(lines[-1][0].baseline - g.baseline) <= 0.3 * max(g.size, 1.0):
            lines[-1].append(g)
        else:
            lines.append([g])
    for line in lines:
        run: list[Glyph] = []
        for g in sorted(line, key=lambda g: g.bbox[0]) + [None]:
            joins = (g is not None and run and len(g.text) == 1 and g.text in "0123456789,.'()-"
                     and g.bbox[0] - run[-1].bbox[2] <= 0.25 * max(g.size, 1.0))
            if joins:
                run.append(g)
                continue
            text = "".join(c.text for c in run)
            if run and _AMOUNT.match(text) and sum(c.isdigit() for c in text) >= 3 and re.search(r"[,.]", text):
                digits = [c for c in run if c.text.isdigit()]
                fonts = Counter(family(c.font) for c in digits)
                out.append(Token(run, text, fonts.most_common(1)[0][0], max(c.size for c in digits),
                                 sum(c.baseline for c in digits) / len(digits), run[0].bbox[0], run[-1].bbox[2],
                                 min(c.bbox[1] for c in run), max(c.bbox[3] for c in run)))
            run = [g] if g is not None and len(g.text) == 1 and g.text in "0123456789(-" else []
    return out


def _columns(tokens: list[Token]) -> list[list[Token]]:
    """Amounts sharing a right edge (the usual alignment of figures), one per row."""
    columns: list[list[Token]] = []
    for t in sorted(tokens, key=lambda t: t.x1):
        if columns and abs(columns[-1][-1].x1 - t.x1) <= 1.5:
            columns[-1].append(t)
        else:
            columns.append([t])
    out = []
    for column in columns:
        rows: dict[int, Token] = {}
        for t in column:
            rows.setdefault(round(t.baseline), t)
        if len(rows) >= 3:
            out.append(list(rows.values()))
    return out


def _row_partner(token: Token, glyphs: list[Glyph]) -> Glyph | None:
    """The nearest character to the left on the same row, e.g. the last letter of the label."""
    best = None
    own = {id(c) for c in token.glyphs}
    for g in glyphs:
        if id(g) in own or not g.text.strip() or g.bbox[2] > token.x0 + 0.5:
            continue
        overlap = min(g.bbox[3], token.y1) - max(g.bbox[1], token.y0)
        if overlap < 0.5 * min(g.bbox[3] - g.bbox[1], token.y1 - token.y0):
            continue
        if best is None or g.bbox[2] > best.bbox[2]:
            best = g
    return best


def _outlier(values: list, same) -> int | None:
    """Index of the one value that differs from all the others, which agree with each other."""
    for i, v in enumerate(values):
        rest = values[:i] + values[i + 1:]
        if len(rest) >= 2 and all(same(r, rest[0]) for r in rest) and not same(v, rest[0]):
            return i
    return None


def check_number_columns(layouts: list[PageLayout]) -> list[Finding]:
    findings = []
    for layout in layouts:
        if layout.rotate:
            continue
        visible = [g for g in layout.glyphs if g.visible and not g.clipped and g.text.strip()]
        found: dict[str, list[dict]] = {"font": [], "size": [], "baseline": []}
        for column in _columns(_tokens(visible)):
            i = _outlier([t.family for t in column], lambda a, b: a == b)
            if i is not None:
                others = column[:i] + column[i + 1:]
                found["font"].append({"value": column[i].text, "font": column[i].family, "column_font": others[0].family})
                continue
            sizes = [t.size for t in column]
            i = _outlier(sizes, lambda a, b: abs(a - b) <= 0.05)
            if i is not None:
                peer = sizes[i - 1] if i else sizes[1]
                change = abs(sizes[i] - peer) / peer
                if 0.01 <= change <= 0.08:  # a clearly larger total is emphasis; a fraction of a point is not
                    found["size"].append({"value": column[i].text, "size": round(sizes[i], 2), "column_size": round(peer, 2)})
                continue
            if max(sizes) - min(sizes) > 0.05:
                continue  # mixed sizes (e.g. a large total): their labels are aligned differently by design
            offsets = []
            for t in column:
                partner = _row_partner(t, visible)
                offsets.append(None if partner is None or abs(partner.size - t.size) > 0.05 else t.baseline - partner.baseline)
            known = [(t, o) for t, o in zip(column, offsets) if o is not None]
            i = _outlier([o for _, o in known], lambda a, b: abs(a - b) <= 0.25)
            if i is not None:
                token, offset = known[i]
                peer = known[i - 1][1] if i else known[1][1]
                if 0.6 <= abs(offset - peer) <= 0.5 * token.size:
                    found["baseline"].append({"value": token.text, "offset_pt": round(offset - peer, 2)})
        for kind, code, title, why in (
            ("font", "NUMBER_FONT_MISMATCH", "An amount is set in a different font from its column",
             "Every other amount in the column uses one font; this one does not. A value retyped in an editor often "
             "falls back to a different font."),
            ("size", "NUMBER_SIZE_MISMATCH", "An amount is a fraction of a point off its column's size",
             "Every other amount in the column has one size; this one is slightly different, which retyping produces "
             "and design emphasis (a clearly larger total) does not."),
            ("baseline", "NUMBER_BASELINE_SHIFT", "An amount sits off the baseline of its row",
             "The other amounts in the column sit level with their row labels; this one is shifted, which is what "
             "placing a value by hand produces."),
        ):
            instances = found[kind]
            if not instances:
                continue
            values = sorted({str(v) for inst in instances for v in amounts(inst["value"])})
            findings.append(Finding(
                code, Severity.MEDIUM, Category.TAMPERING, f"{title} (page {layout.number})",
                f"{why} Value: '{instances[0]['value']}'.",
                {"page": layout.number, "instances": instances[:20], "amounts": values},
            ))
    return findings
