"""Font-subset forensics.

A generator embeds each font once per document, as a subset named
``ABCDEF+FontName``. A PDF editor that changes text cannot extend that subset,
so it embeds a second subset of the same font with a new prefix. Two subsets
of one font in the same content stream, with the second one drawing only a few
digits, is the fingerprint of an edited value.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import pikepdf

from ..report import Category, Finding, Severity
from .layout import PageLayout

_SUBSET = re.compile(r"^([A-Z]{6})\+(.+)$")
_DIGIT = re.compile(r"\d")


@dataclass(frozen=True)
class FontUse:
    basefont: str  # as written, including any subset prefix
    family: str  # without prefix, normalised
    prefix: str | None
    subtype: str
    composite: bool  # Type0
    scope: str  # "page" or the form XObject that uses it


def _family(name: str) -> tuple[str, str | None]:
    m = _SUBSET.match(name)
    prefix, base = (m.group(1), m.group(2)) if m else (None, name)
    return re.sub(r"[\s,]+", "-", base).lower(), prefix


def page_fonts(page: pikepdf.Dictionary) -> list[FontUse]:
    out: list[FontUse] = []
    seen: set = set()

    def visit(resources, scope: str, depth: int) -> None:
        if resources is None or depth > 8:
            return
        for _, font in (resources.get("/Font") or {}).items():
            try:
                basefont = str(font.get("/BaseFont", "")).lstrip("/")
                subtype = str(font.get("/Subtype", ""))
            except Exception:
                continue
            if not basefont or subtype == "/Type3":
                continue
            family, prefix = _family(basefont)
            out.append(FontUse(basefont, family, prefix, subtype, subtype == "/Type0", scope))
        for _, xo in (resources.get("/XObject") or {}).items():
            try:
                if xo.get("/Subtype") != "/Form":
                    continue
                key = xo.objgen
            except Exception:
                continue
            if key in seen:
                continue
            seen.add(key)
            visit(xo.get("/Resources"), f"form {key[0]}", depth + 1)

    node, resources = page, None
    for _ in range(32):
        if node is None:
            break
        if "/Resources" in node:
            resources = node["/Resources"]
            break
        node = node.get("/Parent")
    visit(resources, "page", 0)
    return out


def check_fonts(pdf: pikepdf.Pdf, layouts: list[PageLayout]) -> list[Finding]:
    findings = []
    for layout in layouts:
        if layout.number > len(pdf.pages):
            continue
        uses = page_fonts(pdf.pages[layout.number - 1].obj)
        text_by_font = layout.visible_text_by_font()
        by_family: dict[str, set[FontUse]] = {}
        for u in uses:
            by_family.setdefault(u.family, set()).add(u)
        for family, variants in by_family.items():
            names = {u.basefont for u in variants}
            if len(names) < 2:
                continue
            # Word and LibreOffice embed one simple and one Type0 subset of the same font when a
            # document mixes character sets; that pairing is normal and is ignored.
            simple = {u.basefont for u in variants if not u.composite}
            composite = {u.basefont for u in variants if u.composite}
            if len(simple) <= 1 and len(composite) <= 1:
                continue
            group = simple if len(simple) > 1 else composite
            members = [u for u in variants if u.basefont in group]
            scopes = {u.basefont: {m.scope for m in members if m.basefont == u.basefont} for u in members}
            shared_scope = any(scopes[a] & scopes[b] for a in scopes for b in scopes if a < b)
            usage = {name: text_by_font.get(name, "") for name in group}
            drawn = {n: t for n, t in usage.items() if t.strip()}
            if len(drawn) < 2:
                continue  # one of the copies draws nothing on this page
            minority = min(drawn, key=lambda n: len(drawn[n].strip()))
            minority_text = drawn[minority].strip()
            others = set("".join(t for n, t in drawn.items() if n != minority))
            repeated = {c for c in minority_text if c.isalnum()} & others
            if not repeated:
                severity = Severity.LOW
                why = ("The copies hold different characters, consistent with a generator splitting one large font "
                       "into several subsets.")
            elif not shared_scope:
                severity = Severity.LOW
                why = "The copies are used in different layers (e.g. a template and the data printed onto it), which some generators do."
            elif len(minority_text) <= 40 and _DIGIT.search(minority_text):
                severity = Severity.HIGH
                why = "The second copy draws only a short piece of text containing digits, which is what editing a value produces."
            else:
                severity = Severity.MEDIUM
                why = "Generators embed each font once; a second copy in the same layer usually comes from an editor."
            findings.append(Finding(
                "DUPLICATE_FONT_SUBSET", severity, Category.TAMPERING,
                f"Font '{family}' embedded more than once on page {layout.number}",
                f"{why} Text drawn with the smaller copy ({minority}): '{minority_text[:80]}'.",
                {"page": layout.number, "family": family, "subsets": sorted(group),
                 "scopes": {k: sorted(v) for k, v in scopes.items()},
                 "text_per_subset": {k: v[:200] for k, v in usage.items()}},
            ))
    return findings
