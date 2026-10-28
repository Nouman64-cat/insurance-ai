"""File and metadata forensics for customer-submitted documents.

    from docforensics import analyze
    report = analyze("statement.pdf", doc_type="bank_statement")
    report.verdict, report.sorted_findings()
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .gemini_client import GeminiClient
from .image_checks import check_image
from .isolation import call_with_timeout
from .layer2 import Layer2Result
from .layer2 import Options as Layer2Options
from .layer2 import run_layer2
from .layer3 import Layer3Options, Layer3Result, run_layer3
from .pdf import Context, check_pdf
from .report import Category, Finding, Report, Severity, Verdict

__all__ = [
    "analyze", "analyze_bytes", "analyze_with_content", "analyze_document", "Analysis", "Layer2Options", "Layer3Options",
    "Context", "Report", "Finding", "Severity", "Category", "Verdict",
]

MAX_FILE_SIZE = 100 * 1024 * 1024

_EXTENSIONS = {
    "pdf": {".pdf"},
    "jpeg": {".jpg", ".jpeg", ".jpe", ".jfif"},
    "png": {".png"},
    "webp": {".webp"},
    "tiff": {".tif", ".tiff"},
    "gif": {".gif"},
    "heic": {".heic", ".heif"},
    "bmp": {".bmp"},
}


def detect_type(data: bytes) -> str:
    head = data[:1024]
    if b"%PDF-" in head:
        return "pdf"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[4:8] == b"ftyp" and data[8:12] in (b"heic", b"heix", b"mif1", b"msf1", b"heim", b"heis"):
        return "heic"
    if data[:2] == b"BM":
        return "bmp"
    return "unknown"


def analyze_bytes(data: bytes, name: str = "<bytes>", doc_type: str | None = None, ctx: Context | None = None) -> Report:
    ctx = ctx or Context(doc_type=doc_type)
    file_type = detect_type(data)
    report = Report(path=name, file_type=file_type, sha256=hashlib.sha256(data).hexdigest(), size=len(data))

    if len(data) > MAX_FILE_SIZE:
        report.parsed = False
        report.errors.append(f"file larger than {MAX_FILE_SIZE // (1024 * 1024)} MB, not analysed")
        return report

    suffix = Path(name).suffix.lower()
    if suffix and file_type in _EXTENSIONS and suffix not in _EXTENSIONS[file_type]:
        report.findings.append(Finding(
            "EXTENSION_MISMATCH", Severity.LOW, Category.STRUCTURE,
            f"File extension does not match its content",
            f"Named '{suffix}' but the content is {file_type.upper()}.",
            {"extension": suffix, "detected": file_type},
        ))

    if file_type == "pdf":
        findings, errors, parsed = check_pdf(data, ctx)
    elif file_type == "unknown":
        findings, errors, parsed = [], ["unsupported file type"], False
    else:
        findings, errors, parsed = check_image(data, "image", file_type.upper())
        if file_type == "heic":
            parsed = True  # Pillow cannot decode HEIC without a plugin; metadata checks still ran on the bytes
    report.findings += findings
    report.errors += errors
    report.parsed = parsed
    return report


def analyze(path: str | Path, doc_type: str | None = None, ctx: Context | None = None) -> Report:
    path = Path(path)
    return analyze_bytes(path.read_bytes(), str(path), doc_type, ctx)


def analyze_with_content(
    path: str | Path,
    doc_type: str | None = None,
    ctx: Context | None = None,
    layer2: bool = True,
    client: GeminiClient | None = None,
    options: Layer2Options | None = None,
) -> Report:
    """Run Layer 1 (file/metadata) and, optionally, Layer 2 (content checks read by Gemini).

    If layer 2 is requested but cannot read the document (quota, outage, unreadable
    file), the report says so: ``layer2_status`` is ``"failed"``, ``incomplete`` lists
    ``"layer2"``, and a document with no layer-1 findings is ``inconclusive`` rather than
    ``no_evidence``. A failure never counts as a clean result.
    """
    path = Path(path)
    return analyze_document(path.read_bytes(), str(path), doc_type, ctx, layer2, client, options).report


@dataclass
class Analysis:
    """A report plus what layers 2 and 3 saw (None when a layer was not requested or could not start)."""
    report: Report
    layer2: Layer2Result | None = None
    layer3: Layer3Result | None = None
    performance: dict = field(default_factory=dict)


_TYPOGRAPHY = {"NUMBER_FONT_MISMATCH", "NUMBER_SIZE_MISMATCH", "NUMBER_BASELINE_SHIFT"}


def _corroborate(findings: list[Finding]) -> None:
    """Raise a typography finding to HIGH when Layer 2's arithmetic independently flagged the same figure.

    Each signal alone has innocent explanations (a design choice, a misread); two unrelated methods pointing at
    one amount do not.
    """
    flagged: set[Decimal] = set()
    for f in findings:
        if f.evidence.get("source") == "layer2" and f.severity >= Severity.MEDIUM:
            for value in (f.evidence.get("involved") or {}).values():
                try:
                    flagged.add(abs(Decimal(str(value))))
                except InvalidOperation:
                    continue
    if not flagged:
        return
    for f in findings:
        if f.code not in _TYPOGRAPHY or f.severity >= Severity.HIGH:
            continue
        matched = sorted(str(v) for v in flagged if v in {Decimal(a) for a in f.evidence.get("amounts", [])})
        if matched:
            f.severity = Severity.HIGH
            f.detail += f" Layer 2's arithmetic check independently flagged the same amount ({', '.join(matched)})."
            f.evidence["corroborated_by"] = "layer2"


def _layer1(data: bytes, name: str, doc_type: str | None, ctx: Context | None, timeout: float | None) -> Report:
    if not timeout:
        return analyze_bytes(data, name, doc_type, ctx)
    try:
        return call_with_timeout(analyze_bytes, (data, name, doc_type, ctx), timeout)
    except Exception as exc:  # noqa: BLE001 - an unfinished layer 1 is inconclusive, never clean
        report = Report(path=name, file_type=detect_type(data), sha256=hashlib.sha256(data).hexdigest(), size=len(data))
        report.parsed = False
        report.errors.append(f"layer1: {type(exc).__name__}: {exc}")
        return report


def analyze_document(data: bytes, name: str = "<upload>", doc_type: str | None = None, ctx: Context | None = None,
                     layer2: bool = False, client: GeminiClient | None = None,
                     options: Layer2Options | None = None,
                     layer3: bool = False, layer3_options: Layer3Options | None = None,
                     layer3_runner=None, layer1_timeout: float | None = None) -> Analysis:
    """Analyse in-memory bytes (nothing is written to disk).

    Layer 1 always runs; with ``layer1_timeout`` it runs in a child process that is killed at the deadline, and the
    report is then inconclusive. Layer 2 is opt-in: it sends the pages to the model provider. Layer 3 is opt-in and local
    (an experimental pixel model in a separate PyTorch environment); nothing leaves the machine. A requested layer that
    cannot run is listed in ``report.incomplete``, so it can never make a document look clean.
    """
    started = time.perf_counter()
    report = _layer1(data, name, doc_type, ctx, layer1_timeout)
    analysis = Analysis(report)
    durations = {"layer1": time.perf_counter() - started}
    if layer2:
        layer_started = time.perf_counter()
        now = ctx.now if ctx is not None else None
        try:
            result = run_layer2(data, name, report.file_type, doc_type, client=client, now=now, options=options)
        except Exception as exc:  # noqa: BLE001 - layer 2 must never take the whole analysis down
            report.layer2_status = "failed"
            report.incomplete.append("layer2")
            report.errors.append(f"layer2: unexpected {type(exc).__name__}: {exc}")
        else:
            report.findings += result.findings
            report.errors += result.errors
            report.layer2_status = result.status
            if result.status == "failed":
                report.incomplete.append("layer2")
            analysis.layer2 = result
        durations["layer2"] = time.perf_counter() - layer_started
    if layer3:
        layer_started = time.perf_counter()
        try:
            pixel = run_layer3(data, report.file_type, layer3_options, runner=layer3_runner)
        except Exception as exc:  # noqa: BLE001 - layer 3 must never take the whole analysis down
            report.layer3_status = "failed"
            report.incomplete.append("layer3")
            report.errors.append(f"layer3: unexpected {type(exc).__name__}: {exc}")
        else:
            report.findings += pixel.findings
            report.errors += pixel.errors
            report.layer3_status = pixel.status
            if pixel.status in ("failed", "unavailable", "partial"):
                report.incomplete.append("layer3")
            analysis.layer3 = pixel
        durations["layer3"] = time.perf_counter() - layer_started
    _corroborate(report.findings)
    calls = analysis.layer2.calls if analysis.layer2 else []
    analysis.performance = {
        "total_seconds": time.perf_counter() - started,
        "layer_seconds": durations,
        "input_bytes": len(data),
        "model_calls": len(calls),
        "model_input_tokens": sum(c["tokens_in"] for c in calls if c.get("tokens_in") is not None) if any(c.get("tokens_in") is not None for c in calls) else None,
        "model_output_tokens": sum(c["tokens_out"] for c in calls if c.get("tokens_out") is not None) if any(c.get("tokens_out") is not None for c in calls) else None,
        "pixel_pages_scored": len(analysis.layer3.pages) if analysis.layer3 else 0,
        "pixel_inference_seconds": sum(p.get("seconds", 0) for p in analysis.layer3.pages) if analysis.layer3 else 0,
        "complete": report.parsed and not report.incomplete and report.layer2_status not in ("partial", "failed"),
    }
    return analysis
