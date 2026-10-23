"""Helpers for the Streamlit demo (app.py). No Streamlit imports here, so everything is unit-testable."""

from __future__ import annotations

import io
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import Analysis
from .gemini_client import Settings
from .report import Finding, Report, Severity, Verdict

ROOT = Path(__file__).resolve().parents[1]
SAMPLES_DIR = ROOT / "data" / "layer2_testset"
RUN_DIRS = {"gemini": ROOT / "data" / "layer2_run", "groq": ROOT / "data" / "layer2_run_groq"}
DEMO_CALL_LOG = ROOT / "data" / "demo_calls.jsonl"

SEVERITY_ICON = {Severity.CRITICAL: "🔴", Severity.HIGH: "🟠", Severity.MEDIUM: "🟡", Severity.LOW: "🔵", Severity.INFO: "⚪"}


@dataclass(frozen=True)
class Provider:
    key: str
    label: str
    env_key: str
    min_interval_s: float  # seconds between requests the demo uses
    max_pages: int
    note: str


PROVIDERS = {
    "groq": Provider("groq", "Groq", "GROQ_API_KEY", 6.0, 2,
                     "Reads up to 2 pages per document. Limited by tokens per minute, so large documents can wait a little."),
    "gemini": Provider("gemini", "Google Gemini", "GEMINI_API_KEY", 15.0, 4,
                       "Reads up to 4 pages. The free tier allows only about 20 requests per day."),
}

VERDICTS: dict[Verdict, tuple[str, str, str]] = {
    Verdict.NO_EVIDENCE: ("info", "No evidence of tampering found",
                          "Nothing suspicious in the checks that ran. This is not proof the document is genuine: edits that leave "
                          "no trace in the file and keep the arithmetic consistent cannot be seen by these checks."),
    Verdict.REVIEW: ("warning", "Send to a human reviewer",
                     "At least one strong signal, or two medium ones. The findings below say exactly what and where."),
    Verdict.HIGH_RISK: ("error", "High risk: likely altered or machine-generated",
                        "The file itself shows an edit, or several strong signals agree. Do not accept without verification."),
    Verdict.INCONCLUSIVE: ("warning", "Could not be fully checked",
                           "A check could not run (see the reasons below), and nothing else was found. Treat as unverified, not clean."),
}


def layer_of(finding: Finding) -> str:
    return "Layer 2 · content" if finding.code.startswith("CONTENT_") else "Layer 1 · file"


def findings_rows(report: Report, include_info: bool = False) -> list[dict[str, str]]:
    """Findings as table rows, most severe first."""
    rows = []
    for f in report.sorted_findings():
        if f.severity is Severity.INFO and not include_info:
            continue
        rows.append({"Severity": f"{SEVERITY_ICON[f.severity]} {f.severity.name.title()}", "Layer": layer_of(f),
                     "Finding": f.title, "Detail": f.detail})
    return rows


def headline_findings(report: Report, n: int = 3) -> list[Finding]:
    """The findings a reviewer should read first (MEDIUM and above, most severe first)."""
    return [f for f in report.sorted_findings() if f.severity >= Severity.MEDIUM][:n]


def severity_counts(report: Report) -> dict[str, int]:
    out: dict[str, int] = {}
    for f in report.findings:
        if f.severity > Severity.INFO:
            out[f.severity.name.title()] = out.get(f.severity.name.title(), 0) + 1
    return out


# ---------------------------------------------------------------------------
# Provider and environment status
# ---------------------------------------------------------------------------

def provider_status() -> dict[str, dict[str, Any]]:
    """Whether each provider has a key (never the key itself) and which model it would use."""
    from .groq_client import settings_from_env

    models = {"groq": settings_from_env().model, "gemini": Settings.from_env().model}
    return {k: {"label": p.label, "has_key": bool(os.environ.get(p.env_key, "").strip()), "model": models[k]}
            for k, p in PROVIDERS.items()}


def active_test_runs(within_s: float = 240.0, now: float | None = None) -> list[str]:
    """Providers a batch test run has used in the last few minutes (its call log was touched recently)."""
    now = time.time() if now is None else now
    out = []
    for provider, folder in RUN_DIRS.items():
        log = folder / "calls.jsonl"
        try:
            if log.exists() and now - log.stat().st_mtime < within_s:
                out.append(provider)
        except OSError:
            continue
    return out


def load_samples() -> list[dict[str, Any]]:
    manifest = SAMPLES_DIR / "manifest.json"
    if not manifest.exists():
        return []
    return [d for d in json.loads(manifest.read_text(encoding="utf-8")) if (SAMPLES_DIR / d["path"]).exists()]


def sample_title(entry: dict[str, Any]) -> str:
    return f"{entry['kind'].title()} · {entry['path'].rsplit('.', 1)[0].replace('_', ' ')}"


def truth_text(entry: dict[str, Any]) -> str:
    if entry["label"] == "genuine":
        return "Ground truth: genuine, untouched."
    what = (entry.get("forged") or {}).get("what", "edited")
    old, new = (entry.get("forged") or {}).get("old"), (entry.get("forged") or {}).get("value_new") or (entry.get("forged") or {}).get("new")
    change = f" ({old} → {new})" if old and new else ""
    return f"Ground truth: forged. Edit: {what}{change}."


# ---------------------------------------------------------------------------
# Previews and figures
# ---------------------------------------------------------------------------

def thumbnails(data: bytes, file_type: str, pages: int = 2, width: int = 760) -> list[bytes]:
    """JPEG previews of the first pages. Empty if the file cannot be rendered (the analysis still runs)."""
    from PIL import Image, ImageOps

    out: list[bytes] = []
    try:
        if file_type == "pdf":
            import pypdfium2 as pdfium

            pdf = pdfium.PdfDocument(data)
            try:
                for i in range(min(len(pdf), pages)):
                    page = pdf[i]
                    w, _ = page.get_size()
                    images = [page.render(scale=max(0.5, width / w)).to_pil()]
                    page.close()
                    out += [_jpeg(im, width) for im in images]
            finally:
                pdf.close()
        else:
            img = Image.open(io.BytesIO(data))
            frames = getattr(img, "n_frames", 1)
            for i in range(min(frames, pages)):
                img.seek(i)
                out.append(_jpeg(ImageOps.exif_transpose(img.copy()), width))
    except Exception:  # noqa: BLE001 - a missing preview must never block the analysis
        return out
    return out


def _jpeg(img, width: int) -> bytes:
    img = img.convert("RGB")
    if img.width > width:
        img = img.resize((width, max(1, round(img.height * width / img.width))))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=82)
    return buf.getvalue()


def figures(analysis: Analysis) -> dict[str, Any]:
    """What layer 2 read, as display-ready pieces (no names or identifiers)."""
    result = analysis.layer2
    ex = result.extraction if result else None
    if ex is None:
        return {}
    scalars = {k: str(getattr(ex, k)) for k in ("subtotal", "discount", "tax", "total", "opening_balance", "closing_balance",
                                              "total_credits", "total_debits", "gross_pay", "total_deductions", "net_pay")
               if getattr(ex, k) is not None}
    return {
        "doc_type": ex.doc_type, "currency": ex.currency, "legibility": ex.legibility, "scalars": scalars,
        "items": [{"Description": i.description, "Qty": _s(i.qty), "Unit price": _s(i.unit_price), "Disc %": _s(i.discount_percent),
                   "Amount": _s(i.amount)} for i in ex.items],
        "transactions": [{"Date": t.date or "", "Description": t.description, "Debit": _s(t.debit), "Credit": _s(t.credit),
                          "Balance": _s(t.balance)} for t in ex.txns],
        "earnings": [{"Earnings": a.label, "Amount": str(a.amount)} for a in ex.earnings],
        "deductions": [{"Deductions": a.label, "Amount": str(a.amount)} for a in ex.deductions],
    }


def _s(value: Any) -> str:
    return "" if value is None else str(value)


def calls_rows(analysis: Analysis) -> list[dict[str, Any]]:
    result = analysis.layer2
    if not result:
        return []
    steps = {"extract": "Read the page", "confirm": "Re-read key figures", "visual": "Look for edited figures"}
    return [{"Step": steps.get(c["purpose"], c["purpose"]), "Result": c["status"], "Seconds": round(c["seconds"], 1),
             "Waited (rate limit)": round(c["waited_s"], 1), "Tokens in": c.get("tokens_in"), "Tokens out": c.get("tokens_out"),
             "Model": c.get("model", "")} for c in result.calls]


def report_json(analysis: Analysis, extra: dict[str, Any] | None = None) -> str:
    out = analysis.report.to_dict()
    if analysis.layer2:
        out["layer2"] = {"status": analysis.layer2.status, "calls": analysis.layer2.calls, "notes": analysis.layer2.notes}
    if extra:
        out["demo"] = extra
    return json.dumps(out, indent=2, default=str, ensure_ascii=False)
