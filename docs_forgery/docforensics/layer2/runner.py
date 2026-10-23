"""Layer 2 pipeline: render, read once with the model, check in code, verify, report.

Calls per document: 1 to read; +1 to confirm figures when a mismatch is found on a
document with no text layer; +1 for the optional visual inspection. Every failure
is recorded and surfaces as ``status != "ok"``; nothing is ever treated as "clean"
because a call failed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from ..gemini_client import GeminiClient, GeminiError, Request, get_client
from ..report import Category, Finding, Severity
from .checks import Candidate, run_checks
from .prompts import VISUAL_PROMPT, confirm_prompt, extract_prompt
from .render import Rendered, TextLayer, read_text_layer, render_document
from .schema import Extraction, parse_extraction, to_decimal

MAX_CONFIRM_KEYS = 60


@dataclass
class Options:
    visual: bool = True  # one extra call: the model looks for visibly edited figures (weak evidence, capped at MEDIUM)
    verify: bool = True  # second read to confirm figures behind a mismatch (only for documents without a text layer)
    max_pages: int = 4
    visual_pages: int = 1  # pages shown to the visual inspection (the first page carries the figures; fewer tokens)
    cross_read: bool = True  # photos/scans only: re-read the key figures to catch a transcription that "auto-corrected" an edit


@dataclass
class Layer2Result:
    findings: list[Finding] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    status: str = "ok"  # "ok" | "partial" (a secondary call failed) | "failed" (the document was not read)
    calls: list[dict[str, Any]] = field(default_factory=list)
    extraction: Extraction | None = None
    raw: Any = None  # the model's reply as parsed JSON, kept so results can be re-scored without new API calls
    raw_visual: Any = None  # likewise for the visual inspection reply
    notes: list[str] = field(default_factory=list)


@dataclass
class Verification:
    """How well the figures behind one numeric finding are backed up."""
    how: str | None = None  # "text_layer" or "second_read" when every figure was confirmed
    attempted: str | None = None  # which method was tried: "text_layer", "second_read" or None
    failed: list[str] = field(default_factory=list)  # figures that did not check out


def _grounded(value: Decimal, layer: TextLayer) -> bool:
    return abs(value) in layer.numbers


def _verify_identifiers(idents: list[Candidate], layer: TextLayer) -> dict[int, Verification]:
    """A string the model read is trusted only if the PDF's own text contains it (no text layer: unconfirmed)."""
    out = {}
    for c in idents:
        value = re.sub(r"[\s-]", "", str(c.evidence.get("value", ""))).lower()
        if not layer.has_text:
            out[id(c)] = Verification()
        elif value and value in layer.strings:
            out[id(c)] = Verification("text_layer", "text_layer")
        else:
            out[id(c)] = Verification(None, "text_layer", ["identifier"])
    return out


def _verify(numeric: list[Candidate], layer: TextLayer, rendered: Rendered, client: GeminiClient,
            options: Options, res: Layer2Result) -> dict[int, Verification]:
    if not numeric:
        return {}
    if layer.has_text:
        out = {}
        for c in numeric:
            missing = [k for k, v in c.involved.items() if not _grounded(v, layer)]
            out[id(c)] = Verification("text_layer" if not missing else None, "text_layer", missing)
        return out

    unverified = {id(c): Verification() for c in numeric}
    if not options.verify:
        return unverified
    figures: dict[str, str] = {}
    expected: dict[str, Decimal] = {}
    for c in numeric:
        for k, v in c.involved.items():
            figures.setdefault(k, c.describe.get(k, k))
            expected[k] = v
    if len(figures) > MAX_CONFIRM_KEYS:
        res.notes.append(f"{len(figures)} figures are involved; too many for a second read, so findings stay unverified")
        return unverified
    try:
        reply = client.generate_json(Request(confirm_prompt(figures), rendered.pages, purpose="confirm"))
    except GeminiError as exc:
        res.errors.append(f"layer2: confirm read failed ({exc.kind}): {exc}")
        res.status = "partial"
        return unverified
    values = reply.get("values") if isinstance(reply, dict) and isinstance(reply.get("values"), dict) else {}
    disagree = {k for k, v in expected.items() if to_decimal(values.get(k)) != v}
    res.notes.append("second read: " + (f"{len(disagree)} of {len(expected)} figures differed" if disagree
                                        else "all figures agreed"))
    out = {}
    for c in numeric:
        bad = [k for k in c.involved if k in disagree]
        out[id(c)] = Verification("second_read" if not bad else None, "second_read", bad)
    return out


def _severity(c: Candidate, v: Verification, ex: Extraction) -> Severity:
    if c.kind == "identifier":
        return c.severity if v.how else Severity.LOW
    if c.kind != "numeric":
        return c.severity
    if v.how is None and v.attempted == "second_read" and v.failed:
        return Severity.LOW  # an independent second read disagreed: a misread is the likelier explanation
    severity = c.severity if v.how else min(c.severity, Severity.MEDIUM)
    if c.soft or ex.legibility == "poor":
        severity = min(severity, Severity.MEDIUM)
    return severity


def _to_finding(c: Candidate, v: Verification, ex: Extraction) -> Finding:
    detail = c.detail
    if c.kind == "numeric":
        names = ", ".join(c.describe.get(k, k) for k in v.failed[:4])
        if v.how == "text_layer":
            detail += " Every figure involved was confirmed against the PDF's own text."
        elif v.how == "second_read":
            detail += " A second, independent reading of the page gave the same figures."
        elif v.failed and v.attempted == "second_read":
            detail += f" A second reading of the page gave different figures for {names}, so a misread is likely."
        elif v.failed:
            detail += f" These figures are not in the PDF's text layer, so they may have been misread: {names}."
        else:
            detail += " The figures could not be independently confirmed."
        if ex.legibility == "poor":
            detail += " The page was marked hard to read."
    elif c.kind == "identifier":
        if v.how == "text_layer":
            detail += " The value is exactly as it appears in the PDF's own text."
        elif v.failed:
            detail += " The value is NOT in the PDF's own text, so the model most likely misread it."
        else:
            detail += " It was read from an image, so a misread digit cannot be ruled out."
    evidence = dict(c.evidence)
    if c.involved:
        evidence["involved"] = {k: str(val) for k, val in c.involved.items()}
        evidence["where"] = c.describe
        evidence["verified_by"] = v.how
        if v.failed:
            evidence["unverified_figures"] = v.failed[:12]
    if c.kind == "identifier":
        evidence["verified_by"] = v.how
    evidence["source"] = "layer2"
    return Finding(c.code, _severity(c, v, ex), c.category, c.title, detail, evidence)


_KEY_FIGURES = ("total", "subtotal", "tax", "net_pay", "gross_pay", "total_deductions", "opening_balance", "closing_balance")


def _cross_read(ex: Extraction, rendered: Rendered, client: GeminiClient, res: Layer2Result) -> set[Decimal]:
    """Re-read the key figures with a differently phrased request and compare with the first transcription.

    A transcription can "auto-correct" an edited figure (a forged 6,868.41 read as 68.41) and then look perfectly
    consistent, so arithmetic checks never fire. A second, focused read of the same figures exposes that. Returns the
    figures involved in any disagreement, so the visual inspection can corroborate them.
    """
    figures = {k: k.replace("_", " ") for k in _KEY_FIGURES if getattr(ex, k) is not None}
    if not figures:
        return set()
    try:
        reply = client.generate_json(Request(confirm_prompt(figures), rendered.pages, purpose="confirm"))
    except GeminiError as exc:
        res.errors.append(f"layer2: key-figure re-read failed ({exc.kind}): {exc}")
        res.status = "partial"
        return set()
    values = reply.get("values") if isinstance(reply, dict) and isinstance(reply.get("values"), dict) else {}
    differing = {}
    for key in figures:
        second = to_decimal(values.get(key))
        if second is not None and second != getattr(ex, key):
            differing[key] = (getattr(ex, key), second)
    res.notes.append("key-figure re-read: " + (f"{len(differing)} of {len(figures)} figures differed" if differing else "all agreed"))
    if not differing:
        return set()
    shown = "; ".join(f"{k.replace('_', ' ')}: first read {a:,.2f}, second read {b:,.2f}" for k, (a, b) in differing.items())
    res.findings.append(Finding(
        "CONTENT_READ_DISAGREEMENT", Severity.MEDIUM, Category.TAMPERING,
        "Two readings of the same page disagree on a key figure",
        f"{shown}. One reading is wrong. A misread digit is the usual cause, but a reader can also silently 'correct' an "
        "edited figure to match the rest of the page, which is how an edit hides. A person should look at the page.",
        {"differences": {k: {"first": str(a), "second": str(b)} for k, (a, b) in differing.items()},
         "involved": {k: str(b) for k, (_, b) in differing.items()}, "source": "layer2"}))
    return {abs(v) for pair in differing.values() for v in pair}


def _quoted_numbers(text: str) -> set[Decimal]:
    """Numbers appearing in a string the model quoted, as absolute values."""
    out = set()
    for token in re.findall(r"\d[\d.,]*\d|\d", str(text)):
        value = to_decimal(token)
        if value is not None:
            out.add(abs(value))
    return out


def _visual(rendered: Rendered, client: GeminiClient, res: Layer2Result, flagged_figures: set[Decimal],
            pages: int) -> None:
    try:
        reply = client.generate_json(Request(VISUAL_PROMPT, rendered.pages[:pages], purpose="visual"))
    except GeminiError as exc:
        res.errors.append(f"layer2: visual inspection failed ({exc.kind}): {exc}")
        res.status = "partial"
        return
    if not isinstance(reply, dict):
        res.errors.append("layer2: visual inspection returned an unusable reply")
        res.status = "partial"
        return
    res.raw_visual = reply
    found = [f for f in (reply.get("findings") or []) if isinstance(f, dict)][:10]
    overall, confidence = str(reply.get("overall", "consistent")), str(reply.get("confidence", "low"))
    if not found or overall == "consistent":
        return
    # A font or sharpness difference is common on genuine thermal and dot-matrix receipts, so on its own it is LOW.
    # It rises to MEDIUM only when the figure it points at is one an arithmetic check also flagged.
    corroborated = any(_quoted_numbers(f.get("value", "")) & flagged_figures for f in found)
    first = found[0]
    res.findings.append(Finding(
        "CONTENT_VISUAL_INCONSISTENCY", Severity.MEDIUM if corroborated else Severity.LOW, Category.TAMPERING,
        "A figure looks visually different from its neighbours",
        f"The model reports, at {str(first.get('where', 'an unspecified place'))[:120]}, the value "
        f"'{str(first.get('value', '?'))[:60]}': {str(first.get('evidence', ''))[:200]}. "
        + ("This is the same figure an arithmetic check flagged. " if corroborated else
           "No arithmetic check flagged it, and fonts differ on many genuine receipts. ")
        + "It is a model's opinion of the image, not a measurement, so it never decides a verdict alone.",
        {"findings": [{k: str(val)[:200] for k, val in f.items()} for f in found], "overall": overall,
         "confidence": confidence, "corroborated": corroborated, "source": "layer2_visual"}))


def _summary(ex: Extraction, res: Layer2Result, layer: TextLayer, rendered: Rendered) -> Finding:
    figures = {k: str(getattr(ex, k)) for k in ("subtotal", "discount", "tax", "total", "opening_balance", "closing_balance",
                                              "gross_pay", "total_deductions", "net_pay") if getattr(ex, k) is not None}
    return Finding(
        "CONTENT_EXTRACTED", Severity.INFO, Category.CONTEXT, "Layer 2 read the document",
        f"Read as {ex.doc_type}: {len(ex.items)} line items, {len(ex.txns)} transactions, {len(ex.earnings)} earnings, "
        f"{len(ex.deductions)} deductions, {len(ex.dates)} dates. "
        + ("Figures were cross-checked against the PDF text layer. " if layer.has_text else "No text layer; figures come from the image. ")
        + " ".join(res.notes),
        {"doc_type": ex.doc_type, "currency": ex.currency, "legibility": ex.legibility, "figures": figures,
         "counts": {"items": len(ex.items), "transactions": len(ex.txns), "earnings": len(ex.earnings),
                    "deductions": len(ex.deductions), "dates": len(ex.dates)},
         "text_layer": layer.has_text, "pages_read": len(rendered.pages), "pages_total": rendered.pages_total,
         "notes": list(res.notes), "source": "layer2"})


def run_layer2(data: bytes, name: str, file_type: str, doc_type: str | None = None,
               client: GeminiClient | None = None, now: datetime | None = None,
               options: Options | None = None) -> Layer2Result:
    client = client or get_client()
    options = options or Options()
    now = now or datetime.now(timezone.utc)
    res = Layer2Result()
    calls_before = len(client.calls)

    def finish(status: str | None = None, error: str | None = None) -> Layer2Result:
        if status:
            res.status = status
        if error:
            res.errors.append(error)
        res.calls = [c.to_dict() for c in client.calls[calls_before:]]
        return res

    try:
        rendered = render_document(data, file_type, options.max_pages)
    except Exception as exc:  # noqa: BLE001 - any rendering problem means the document was not read
        return finish("failed", f"layer2: could not render this {file_type}: {type(exc).__name__}: {exc}")
    layer = read_text_layer(data, options.max_pages) if file_type == "pdf" else TextLayer()

    try:
        raw = client.generate_json(Request(extract_prompt(doc_type), rendered.pages, purpose="extract"))
    except GeminiError as exc:
        return finish("failed", f"layer2: could not read the document ({exc.kind}): {exc}")
    ex = parse_extraction(raw)
    if ex is None:
        return finish("failed", "layer2: could not read the document (bad_response): the reply was not a JSON object")
    res.extraction, res.raw = ex, raw
    res.notes += rendered.notes
    if ex.warnings:
        res.notes.append(f"{len(ex.warnings)} unreadable value(s) in the reply were ignored")

    candidates, ledger_notes = run_checks(ex, now)
    res.notes += ledger_notes
    verification = _verify([c for c in candidates if c.kind == "numeric"], layer, rendered, client, options, res)
    verification.update(_verify_identifiers([c for c in candidates if c.kind == "identifier"], layer))
    for c in candidates:
        res.findings.append(_to_finding(c, verification.get(id(c), Verification()), ex))

    if not ex.has_content():
        res.findings.append(Finding(
            "CONTENT_NOT_APPLICABLE", Severity.INFO, Category.CONTEXT, "No amounts or dates to check",
            "The model found no totals, line items, balances or dates in this document, so no content check applied.",
            {"doc_type": ex.doc_type, "source": "layer2"}))
    res.findings.append(_summary(ex, res, layer, rendered))

    flagged = {abs(v) for c in candidates if c.kind == "numeric" for v in c.involved.values()}
    # Photos and scans have no text layer to check against. If no mismatch triggered a second read, spend one small call
    # re-reading the key figures, because an auto-corrected transcription looks consistent and nothing else would fire.
    if options.cross_read and not layer.has_text and not any(c.kind == "numeric" for c in candidates):
        flagged |= _cross_read(ex, rendered, client, res)
    if options.visual:
        _visual(rendered, client, res, flagged, options.visual_pages)
    return finish()
