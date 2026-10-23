"""Document information dictionary and XMP checks: tools, dates, inconsistencies."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

import pikepdf

from .. import xmp
from ..knowledge import TOOL_KIND_DESCRIPTION, ToolKind, identify_tools, pdf_tool_severity
from ..provenance import check_source_types
from ..report import Category, Finding, Severity
from .context import Context

_PDF_DATE = re.compile(
    r"^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:(Z)|([+\-])(\d{2})'?(\d{2})?'?)?"
)
# When one side of a comparison has no timezone, allow for any UTC offset.
_NAIVE_TOLERANCE = timedelta(hours=14, minutes=2)
_AWARE_TOLERANCE = timedelta(minutes=2)


class PdfDate:
    def __init__(self, value: datetime, aware: bool, raw: str):
        self.value, self.aware, self.raw = value, aware, raw

    def __str__(self) -> str:
        return self.value.isoformat()


def parse_pdf_date(raw: str | None) -> PdfDate | None:
    if not raw:
        return None
    m = _PDF_DATE.match(raw.strip())
    if not m:
        return None
    y, mo, d, h, mi, s, z, sign, oh, om = m.groups()
    try:
        value = datetime(int(y), int(mo or 1), int(d or 1), int(h or 0), int(mi or 0), int(s or 0))
    except ValueError:
        return None
    if z:
        return PdfDate(value.replace(tzinfo=timezone.utc), True, raw)
    if sign:
        offset = timedelta(hours=int(oh), minutes=int(om or 0)) * (1 if sign == "+" else -1)
        return PdfDate(value.replace(tzinfo=timezone(offset)), True, raw)
    return PdfDate(value, False, raw)


def parse_xmp_date(raw: str | None) -> PdfDate | None:
    if not raw:
        return None
    text = raw.strip().replace("Z", "+00:00")
    try:
        value = datetime.fromisoformat(text)
    except ValueError:
        return None
    return PdfDate(value, value.tzinfo is not None, raw)


def date_gap(a: PdfDate, b: PdfDate) -> tuple[timedelta, timedelta]:
    """(b - a, tolerance). Naive dates are compared as wall-clock times."""
    if a.aware and b.aware:
        return b.value - a.value, _AWARE_TOLERANCE
    return b.value.replace(tzinfo=None) - a.value.replace(tzinfo=None), _NAIVE_TOLERANCE


def _human(delta: timedelta) -> str:
    seconds = abs(delta.total_seconds())
    if seconds < 3600:
        return f"{seconds / 60:.0f} minutes"
    if seconds < 172800:
        return f"{seconds / 3600:.1f} hours"
    return f"{seconds / 86400:.0f} days"


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def read_info(pdf: pikepdf.Pdf) -> dict[str, str]:
    out = {}
    try:
        for key, value in pdf.docinfo.items():
            try:
                out[str(key).lstrip("/")] = str(value)
            except Exception:
                continue
    except Exception:
        pass
    return out


def read_xmp(pdf: pikepdf.Pdf) -> xmp.XmpData | None:
    try:
        stream = pdf.Root.get("/Metadata")
        if stream is None:
            return None
        return xmp.parse_packet(stream.read_bytes())
    except Exception:
        return None


def check_metadata(pdf: pikepdf.Pdf, ctx: Context) -> list[Finding]:
    findings: list[Finding] = []
    info = read_info(pdf)
    x = read_xmp(pdf)

    tool_fields: dict[str, str] = {}
    for key in ("Producer", "Creator"):
        if info.get(key):
            tool_fields[f"Info {key}"] = info[key]
    if x:
        for key in ("pdf:Producer", "xmp:CreatorTool"):
            if x.first(key):
                tool_fields[f"XMP {key}"] = x.first(key)
        agents = dict.fromkeys(e["softwareAgent"] for e in x.history if e.get("softwareAgent"))
        for i, agent in enumerate(agents):
            tool_fields[f"XMP history agent[{i}]"] = agent

    seen: dict[str, Finding] = {}
    identified = []
    for field_name, value in tool_fields.items():
        for tool in identify_tools(value):
            identified.append({"field": field_name, "value": value, "tool": tool.name, "kind": tool.kind.value})
            severity = pdf_tool_severity(tool.kind, ctx.doc_type)
            if severity < Severity.LOW or tool.name in seen:
                continue
            category = Category.AI_GENERATION if tool.kind is ToolKind.AI_GENERATOR else Category.EDITING_SOFTWARE
            doc_note = f" Declared document type: {ctx.doc_type}." if ctx.doc_type else ""
            seen[tool.name] = Finding(
                "PDF_TOOL_" + tool.kind.name, severity, category,
                f"PDF was produced or saved with {tool.name}",
                f"The {field_name} field reads '{value[:120]}', which is {TOOL_KIND_DESCRIPTION[tool.kind]}.{doc_note}",
                {"field": field_name, "value": value[:300], "tool": tool.name, "tool_kind": tool.kind.value},
            )
    findings += seen.values()

    findings += _script_defaults(info)

    if info.get("Producer") and x and x.first("pdf:Producer"):
        a, b = _norm(info["Producer"]), _norm(x.first("pdf:Producer"))
        if a != b and a not in b and b not in a:
            findings.append(Finding(
                "PRODUCER_MISMATCH", Severity.LOW, Category.METADATA,
                "Document info and XMP name different producers",
                "Two tools wrote this file: one updated the document info, the other wrote the XMP. "
                "Usually the file was re-saved by a second tool after it was created.",
                {"info_producer": info["Producer"], "xmp_producer": x.first("pdf:Producer")},
            ))

    findings += _date_checks(info, x, ctx)
    if x:
        findings += check_source_types(x.all("Iptc4xmpExt:DigitalSourceType"), "PDF metadata")

    findings.append(Finding(
        "PDF_METADATA", Severity.INFO, Category.CONTEXT, "PDF metadata",
        "; ".join(f"{k}: {v[:100]}" for k, v in tool_fields.items()) or "No producer or creator recorded.",
        {"info": {k: v[:300] for k, v in info.items()}, "tools": identified,
         "xmp_history": x.history[:20] if x else []},
    ))
    return findings


def _script_defaults(info: dict[str, str]) -> list[Finding]:
    """Default metadata from code libraries: production systems set their own, ad-hoc scripts do not."""
    producer = info.get("Producer", "") + " " + info.get("Creator", "")
    author, title = info.get("Author", "").strip().lower(), info.get("Title", "").strip().lower()
    reason = None
    if re.search(r"reportlab", producer, re.I) and (author == "anonymous" or title == "untitled"):
        reason = "ReportLab with its default 'anonymous' author / 'untitled' title"
    elif re.search(r"matplotlib", producer, re.I):
        reason = "the Matplotlib plotting library"
    if not reason:
        return []
    return [Finding(
        "SCRIPT_DEFAULT_METADATA", Severity.MEDIUM, Category.AI_GENERATION,
        "PDF was generated by a script with library defaults",
        f"The file was rendered by {reason}. Bank and payroll systems set their own metadata; "
        "untouched defaults are typical of one-off scripts, including those written by AI assistants.",
        {"producer": producer.strip(), "author": info.get("Author"), "title": info.get("Title")},
    )]


def _date_checks(info: dict[str, str], x: xmp.XmpData | None, ctx: Context) -> list[Finding]:
    findings = []
    created = parse_pdf_date(info.get("CreationDate"))
    modified = parse_pdf_date(info.get("ModDate"))
    x_created = parse_xmp_date(x.first("xmp:CreateDate")) if x else None
    x_modified = parse_xmp_date(x.first("xmp:ModifyDate")) if x else None

    if created and modified:
        gap, tol = date_gap(created, modified)
        if gap < -tol:
            findings.append(Finding(
                "MODDATE_BEFORE_CREATION", Severity.MEDIUM, Category.METADATA,
                "Modification date is earlier than creation date",
                f"Created {created}, modified {modified}. Software never writes this order; the dates were edited by hand or by a tool that rewrote one of them.",
                {"CreationDate": created.raw, "ModDate": modified.raw},
            ))
        elif gap > timedelta(days=1):
            findings.append(Finding(
                "MODIFIED_AFTER_CREATION", Severity.LOW, Category.METADATA,
                f"File was modified {_human(gap)} after it was created",
                "Statements and payslips are normally generated once and not saved again.",
                {"CreationDate": created.raw, "ModDate": modified.raw},
            ))

    now = PdfDate(ctx.now, True, "now")
    for label, d in (("CreationDate", created), ("ModDate", modified), ("XMP CreateDate", x_created), ("XMP ModifyDate", x_modified)):
        if d:
            gap, tol = date_gap(now, d)
            if gap > tol + timedelta(days=1):
                findings.append(Finding(
                    "DATE_IN_FUTURE", Severity.MEDIUM, Category.METADATA,
                    f"{label} is in the future",
                    f"{label} is {d}, after the time of analysis.",
                    {"field": label, "value": d.raw},
                ))

    for label, a, b in (("creation", created, x_created), ("modification", modified, x_modified)):
        if a and b:
            gap, tol = date_gap(a, b)
            if abs(gap) > tol:
                severity = Severity.MEDIUM if abs(gap) > timedelta(days=1) else Severity.LOW
                findings.append(Finding(
                    f"XMP_{label.upper()}_DATE_MISMATCH", severity, Category.METADATA,
                    f"Document info and XMP disagree on the {label} date",
                    f"Info says {a}, XMP says {b} ({_human(gap)} apart). Editing tools often update one copy and not the other.",
                    {"info": a.raw, "xmp": b.raw},
                ))
    return findings
