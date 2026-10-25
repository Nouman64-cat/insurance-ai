"""PDF file and metadata checks."""

from __future__ import annotations

import io
import re

import pikepdf

from ..provenance import check_c2pa
from ..report import Category, Finding, Severity
from .context import Context
from .fonts import check_fonts
from .images import check_embedded_images
from .layout import check_layout, extract_layouts
from .meta import check_metadata
from .revisions import check_revisions, revision_ends
from .signatures import check_signatures

__all__ = ["Context", "check_pdf"]


def _run(name: str, fn, errors: list[str], *args):
    """Run one check; a failure in one check must never hide the results of the others."""
    try:
        return fn(*args)
    except Exception as exc:
        errors.append(f"{name}: {type(exc).__name__}: {exc}")
        return None


def check_structure(data: bytes, pdf: pikepdf.Pdf) -> list[Finding]:
    findings = []
    header = data.find(b"%PDF-")
    if header > 0:
        findings.append(Finding(
            "PDF_HEADER_OFFSET", Severity.LOW, Category.STRUCTURE,
            "Data before the PDF header",
            f"The file has {header} bytes before '%PDF-'. Generators start the file with the header.",
            {"offset": header},
        ))
    ends = revision_ends(data)
    if ends:
        tail = data[ends[-1]:].strip(b"\x00\r\n\t \x1a")
        if len(tail) > 32:
            findings.append(Finding(
                "PDF_TRAILING_DATA", Severity.LOW, Category.STRUCTURE,
                "Data after the end of the PDF",
                f"{len(tail)} bytes follow the final %%EOF marker. Readers ignore it; it can hide content or come from a broken save.",
                {"bytes": len(tail), "preview": tail[:80].decode("latin-1")},
            ))
    warnings = [str(w) for w in getattr(pdf, "get_warnings", lambda: [])()]
    if warnings:
        findings.append(Finding(
            "PDF_STRUCTURE_REPAIRED", Severity.LOW, Category.STRUCTURE,
            "PDF structure is damaged",
            f"The parser repaired {len(warnings)} structural error(s). Bank and payroll systems write valid files; "
            "hand-edited or badly re-saved files often do not.",
            {"warnings": warnings[:10]},
        ))
    root = pdf.Root
    names = root.get("/Names")
    embedded = names.get("/EmbeddedFiles") if names is not None else None
    if embedded is not None:
        files = [str(x) for x in (embedded.get("/Names") or [])[::2]]
        findings.append(Finding(
            "PDF_ATTACHMENTS", Severity.INFO, Category.CONTEXT, "PDF contains attached files",
            "Attachments: " + (", ".join(files[:10]) or "unnamed") + ". They are not analysed here.",
            {"files": files[:50]},
        ))
    if root.get("/OpenAction") is not None and re.search(rb"/JavaScript|/JS\s", data):
        findings.append(Finding(
            "PDF_JAVASCRIPT", Severity.LOW, Category.STRUCTURE, "PDF contains JavaScript",
            "Statements and payslips do not need scripts.", {},
        ))
    return findings


def check_pdf(data: bytes, ctx: Context) -> tuple[list[Finding], list[str], bool]:
    """Run every PDF check. Returns (findings, errors, parsed)."""
    findings: list[Finding] = []
    errors: list[str] = []
    try:
        pdf = pikepdf.open(io.BytesIO(data))
    except pikepdf.PasswordError:
        return [Finding(
            "PDF_PASSWORD_PROTECTED", Severity.MEDIUM, Category.STRUCTURE,
            "PDF is password protected",
            "The file cannot be opened without a password, so it cannot be checked. Ask for an unprotected copy.",
            {},
        )], [], False
    except Exception as exc:
        return [], [f"pdf: cannot open: {exc}"], False

    with pdf:
        for name, fn, args in (
            ("structure", check_structure, (data, pdf)),
            ("metadata", check_metadata, (pdf, ctx)),
        ):
            findings += _run(name, fn, errors, *args) or []

        layouts_result = _run("layout", extract_layouts, errors, data, ctx.max_pages)
        layouts = []
        if layouts_result:
            layouts, layout_errors = layouts_result
            errors += layout_errors

        for name, fn, args in (
            ("revisions", check_revisions, (data, ctx)),
            ("signatures", check_signatures, (data,)),
            ("embedded images", check_embedded_images, (pdf, ctx, layouts)),
        ):
            result = _run(name, fn, errors, *args)
            if result:
                findings += result[0]
                errors += result[1]
        findings += _run("layout", check_layout, errors, pdf, layouts) or []
        findings += _run("fonts", check_fonts, errors, pdf, layouts) or []
        if len(pdf.pages) > ctx.max_pages:
            errors.append(f"layout/fonts/images: only the first {ctx.max_pages} of {len(pdf.pages)} pages analysed")

    if b"c2pa" in data:
        c2pa_findings, c2pa_errors = check_c2pa(data, "application/pdf", "PDF")
        findings += c2pa_findings
        errors += c2pa_errors
    return findings, errors, True
