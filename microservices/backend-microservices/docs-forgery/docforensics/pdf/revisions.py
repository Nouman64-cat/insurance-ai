"""Incremental-update analysis.

A PDF saved incrementally keeps every earlier version intact in front of the
new data. Each version ends at its own ``startxref N %%EOF``, so truncating the
file there reproduces that version exactly. Comparing successive versions shows
what each save changed, down to the replaced text.
"""

from __future__ import annotations

import difflib
import hashlib
import io
import re
from dataclasses import dataclass, field

import pikepdf
from pdfminer.high_level import extract_text

from ..report import Category, Finding, Severity
from .context import Context

_REV_END = re.compile(rb"startxref\s+(\d+)\s*%%EOF")
_OBJ_AT = re.compile(rb"\s*\d+\s+\d+\s+obj\b")


def revision_ends(data: bytes) -> list[int]:
    """Byte offsets where each saved version of the file ends."""
    found: list[tuple[int, int]] = []
    for m in _REV_END.finditer(data):
        offset = int(m.group(1))
        if offset <= 0 or offset >= m.start():
            continue  # linearization placeholders ("startxref 0") and garbage
        head = data[offset:offset + 40]
        if not (head.lstrip().startswith(b"xref") or _OBJ_AT.match(head)):
            continue  # %%EOF inside an embedded file or a stream, not a real trailer
        found.append((m.end(), offset))
    ends = []
    for i, (end, offset) in enumerate(found):
        # Linearized files repeat the first-page startxref at the very end; that is one version, not two.
        if any(later == offset for _, later in found[i + 1:]):
            continue
        ends.append(end)
    return ends


def _inherited(page: pikepdf.Dictionary, key: str):
    node, depth = page, 0
    while node is not None and depth < 32:
        if key in node:
            return node[key]
        node, depth = node.get("/Parent"), depth + 1
    return None


def _hash_resources(resources, h, seen: set, depth: int = 0) -> None:
    if resources is None or depth > 8:
        return
    xobjects = resources.get("/XObject")
    if xobjects is not None:
        for name in sorted(xobjects.keys()):
            xo = xobjects[name]
            key = xo.objgen if xo.is_indirect else None
            h.update(name.encode())
            if key in seen:
                continue
            if key:
                seen.add(key)
            try:
                h.update(xo.read_raw_bytes())
            except Exception:
                pass
            if xo.get("/Subtype") == "/Form":
                _hash_resources(xo.get("/Resources"), h, seen, depth + 1)
    fonts = resources.get("/Font")
    if fonts is not None:
        for name in sorted(fonts.keys()):
            h.update(name.encode() + str(fonts[name].get("/BaseFont", "")).encode())


def page_fingerprint(page: pikepdf.Dictionary) -> str:
    h = hashlib.sha256()
    contents = page.get("/Contents")
    streams = list(contents) if isinstance(contents, pikepdf.Array) else ([contents] if contents is not None else [])
    for s in streams:
        try:
            h.update(s.read_bytes())
        except Exception:
            try:
                h.update(s.read_raw_bytes())
            except Exception:
                pass
    _hash_resources(_inherited(page, "/Resources"), h, set())
    return h.hexdigest()


def _annotation_keys(page: pikepdf.Dictionary) -> frozenset:
    keys = set()
    for annot in page.get("/Annots") or []:
        try:
            rect = tuple(round(float(v)) for v in annot.get("/Rect", []))
            keys.add((str(annot.get("/Subtype", "")), rect, str(annot.get("/Contents", ""))[:200]))
        except Exception:
            continue
    return frozenset(keys)


def _form_values(pdf: pikepdf.Pdf) -> dict[str, str]:
    out: dict[str, str] = {}
    acro = pdf.Root.get("/AcroForm")
    if acro is None:
        return out

    def walk(field, prefix: str, depth: int) -> None:
        if depth > 16:
            return
        name = prefix + ("." if prefix else "") + str(field.get("/T", "")) if "/T" in field else prefix
        if "/V" in field:
            value = field["/V"]
            out[name] = "<signature>" if field.get("/FT") == "/Sig" or _inherited(field, "/FT") == "/Sig" else str(value)[:200]
        for kid in field.get("/Kids") or []:
            walk(kid, name, depth + 1)

    for f in acro.get("/Fields") or []:
        walk(f, "", 0)
    return out


@dataclass
class Snapshot:
    end: int
    producer: str = ""
    mod_date: str = ""
    pages: list[str] = field(default_factory=list)
    annotations: list[frozenset] = field(default_factory=list)
    form: dict[str, str] = field(default_factory=dict)
    error: str | None = None


def take_snapshot(data: bytes, end: int) -> Snapshot:
    snap = Snapshot(end)
    try:
        with pikepdf.open(io.BytesIO(data[:end])) as pdf:
            info = pdf.trailer.get("/Info")
            if info is not None:
                snap.producer = str(info.get("/Producer", ""))
                snap.mod_date = str(info.get("/ModDate", ""))
            for page in pdf.pages:
                snap.pages.append(page_fingerprint(page.obj))
                snap.annotations.append(_annotation_keys(page.obj))
            snap.form = _form_values(pdf)
    except Exception as exc:
        snap.error = str(exc)[:300]
    return snap


def _page_text(data: bytes, end: int, index: int) -> str:
    try:
        return extract_text(io.BytesIO(data[:end]), page_numbers=[index])
    except Exception:
        return ""


def diff_text(before: str, after: str, limit: int = 12) -> list[dict[str, str]]:
    a, b = before.split(), after.split()
    matcher = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    changes = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        changes.append({
            "change": tag,
            "before": " ".join(a[i1:i2])[:200],
            "after": " ".join(b[j1:j2])[:200],
            "context": " ".join(a[max(0, i1 - 5):i1])[-100:],
        })
        if len(changes) >= limit:
            break
    return changes


def check_revisions(data: bytes, ctx: Context) -> tuple[list[Finding], list[str]]:
    ends = revision_ends(data)
    if len(ends) <= 1:
        return [], []
    errors: list[str] = []
    if len(ends) > ctx.max_revisions:
        errors.append(f"revisions: {len(ends)} versions, only the first and last {ctx.max_revisions - 1} compared")
        ends = [ends[0], *ends[-(ctx.max_revisions - 1):]]
    snaps = [take_snapshot(data, e) for e in ends]
    for i, s in enumerate(snaps):
        if s.error:
            errors.append(f"revisions: version {i + 1} unreadable: {s.error}")

    findings: list[Finding] = []
    history = []
    for i in range(1, len(snaps)):
        prev, cur = snaps[i - 1], snaps[i]
        if prev.error or cur.error:
            continue
        version = i + 1
        entry = {"version": version, "producer": cur.producer, "mod_date": cur.mod_date, "changes": []}
        common = min(len(prev.pages), len(cur.pages))
        changed_pages = [p for p in range(common) if prev.pages[p] != cur.pages[p]]
        annot_pages = [p + 1 for p in range(common) if prev.annotations[p] != cur.annotations[p]]
        form_changes = {k: v for k, v in cur.form.items() if prev.form.get(k) != v}

        if len(prev.pages) != len(cur.pages):
            entry["changes"].append("page count")
            findings.append(Finding(
                "REVISION_PAGES_CHANGED", Severity.HIGH, Category.TAMPERING,
                f"Pages were added or removed in a later save (version {version})",
                f"Version {version - 1} had {len(prev.pages)} page(s); version {version} has {len(cur.pages)}. "
                f"Saved by: {cur.producer or 'unknown'}.",
                {"version": version, "pages_before": len(prev.pages), "pages_after": len(cur.pages), "producer": cur.producer},
            ))

        text_changes = []
        for p in changed_pages[:5]:
            changes = diff_text(_page_text(data, prev.end, p), _page_text(data, cur.end, p))
            if changes:
                text_changes.append({"page": p + 1, "changes": changes})
        if text_changes:
            entry["changes"].append("text")
            sample = text_changes[0]["changes"][0]
            findings.append(Finding(
                "REVISION_TEXT_CHANGED", Severity.CRITICAL, Category.TAMPERING,
                f"Text was changed after the document was first saved (version {version})",
                f"The earlier version is still inside the file. Page {text_changes[0]['page']}: "
                f"'{sample['before'] or '(nothing)'}' became '{sample['after'] or '(nothing)'}'. "
                f"Saved by: {cur.producer or 'unknown'}.",
                {"version": version, "producer": cur.producer, "original_producer": snaps[0].producer,
                 "pages": text_changes},
            ))
        elif changed_pages:
            entry["changes"].append("graphics")
            findings.append(Finding(
                "REVISION_CONTENT_CHANGED", Severity.HIGH, Category.TAMPERING,
                f"Page content was changed in a later save (version {version})",
                f"Page(s) {', '.join(str(p + 1) for p in changed_pages)} were redrawn with the same text but different "
                f"graphics, images or fonts. Saved by: {cur.producer or 'unknown'}.",
                {"version": version, "pages": [p + 1 for p in changed_pages], "producer": cur.producer},
            ))

        if annot_pages or form_changes:
            entry["changes"].append("annotations/forms")
            findings.append(Finding(
                "REVISION_ANNOTATIONS", Severity.INFO, Category.CONTEXT,
                f"Annotations, form fields or signatures added in a later save (version {version})",
                "These sit on top of the page content and do not change it. Signatures and filled-in forms produce this.",
                {"version": version, "annotation_pages": annot_pages,
                 "form_fields": dict(list(form_changes.items())[:20]), "producer": cur.producer},
            ))
        history.append(entry)

    findings.append(Finding(
        "PDF_REVISIONS", Severity.INFO, Category.CONTEXT,
        f"File was saved {len(ends)} times",
        f"The first version was produced by {snaps[0].producer or 'unknown'}; "
        f"the last by {snaps[-1].producer or 'unknown'}.",
        {"versions": len(ends), "first_producer": snaps[0].producer, "history": history},
    ))
    return findings, errors
