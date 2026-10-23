"""Layer 3: pixel forensics (experimental, optional, local).

A trained forgery-localisation model (TruFor) scores each rendered page. It runs in a SEPARATE Python environment that has
PyTorch (the main app's interpreter has none), driven by ``trufor_worker.py`` over stdin/stdout. Nothing leaves the machine
and nothing is written to disk.

Reliability: pixel models trained on photographs transfer weakly to documents (see docs/EXPERIMENTS_PIXEL_MODELS.md), so
this layer is deliberately conservative. A finding is only raised when a page scores above ``tmax``, the highest score any
genuine *calibration* page reached, and its severity is capped by what was measured (see ``thresholds.json``). It never
decides a verdict alone.

Licence: TruFor's weights are for informational and NONPROFIT use only (GRIP-UNINA). They are not part of this repository.

Configuration (environment):
    PIXEL_PYTHON   path to a python.exe/python with torch, timm, yacs, pillow, numpy (default: <repo>/venv_exp)
    TRUFOR_DIR     folder holding code/ and weights/ from GRIP-UNINA (default: <repo>/data/models/trufor)
"""

from __future__ import annotations

import io
import json
import os
import struct
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..report import Category, Finding, Severity

ROOT = Path(__file__).resolve().parents[2]
WORKER = Path(__file__).with_name("trufor_worker.py")
THRESHOLDS = Path(__file__).with_name("thresholds.json")
RENDER_DPI = 130  # the resolution the thresholds were calibrated at


@dataclass
class Layer3Options:
    max_pages: int = 1  # ~15 s per page on a laptop CPU, plus ~10 s to load the model
    max_side: int = 1024  # the worker downscales pages so the longer side is at most this (calibration used the same)
    timeout_s: float = 300.0


@dataclass
class Layer3Result:
    status: str = "ok"  # "ok" | "unavailable" (not set up) | "failed"
    findings: list[Finding] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    pages: list[dict[str, Any]] = field(default_factory=list)  # per-page scores (and a small heatmap) for display
    seconds: float = 0.0


def pixel_python() -> Path | None:
    candidates = [os.environ.get("PIXEL_PYTHON", ""), str(ROOT / "venv_exp" / "Scripts" / "python.exe"),
                  str(ROOT / "venv_exp" / "bin" / "python")]
    return next((Path(c) for c in candidates if c and Path(c).exists()), None)


def models_dir() -> Path:
    return Path(os.environ.get("TRUFOR_DIR", "") or ROOT / "data" / "models" / "trufor")


def availability() -> tuple[bool, str]:
    """Whether layer 3 can run here, and if not, the reason in plain words."""
    if pixel_python() is None:
        return False, "No Python with PyTorch found. Set PIXEL_PYTHON (see docs/EXPERIMENTS_PIXEL_MODELS.md)."
    if not (models_dir() / "code" / "test_docker" / "src").exists() or next(models_dir().rglob("trufor.pth.tar"), None) is None:
        return False, f"TruFor code and weights not found in {models_dir()} (set TRUFOR_DIR; download from GRIP-UNINA)."
    return True, ""


def load_thresholds() -> dict[str, Any] | None:
    try:
        return json.loads(THRESHOLDS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def render_pngs(data: bytes, file_type: str, max_pages: int) -> list[bytes]:
    """Lossless page images (no JPEG hop: re-encoding would add exactly the artefacts a pixel model reads)."""
    from PIL import Image

    out: list[bytes] = []
    if file_type == "pdf":
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(data)
        try:
            for i in range(min(len(pdf), max_pages)):
                page = pdf[i]
                buf = io.BytesIO()
                page.render(scale=RENDER_DPI / 72).to_pil().convert("RGB").save(buf, "PNG")
                page.close()
                out.append(buf.getvalue())
        finally:
            pdf.close()
    else:
        img = Image.open(io.BytesIO(data))
        for i in range(min(getattr(img, "n_frames", 1), max_pages)):
            img.seek(i)
            buf = io.BytesIO()
            img.convert("RGB").save(buf, "PNG")
            out.append(buf.getvalue())
    return out


def _subprocess_runner(pages: list[bytes], options: Layer3Options) -> list[dict[str, Any]]:
    python = pixel_python()
    payload = b"".join(struct.pack(">I", len(p)) + p for p in pages) + struct.pack(">I", 0)
    try:
        proc = subprocess.run([str(python), str(WORKER), str(models_dir()), str(options.max_side)], input=payload,
                              capture_output=True, timeout=options.timeout_s, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError(f"pixel model did not finish within {options.timeout_s:.0f}s") from exc
    lines = [json.loads(line) for line in proc.stdout.decode("utf-8", "replace").splitlines() if line.startswith("{")]
    if not lines:
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["no output"]
        raise RuntimeError(f"pixel worker produced no output (exit {proc.returncode}): {tail[0][:200]}")
    if "fatal" in lines[0]:
        raise RuntimeError(lines[0]["fatal"])
    return [ln for ln in lines if "ready" not in ln]


def grade(page: dict[str, Any], thresholds: dict[str, Any] | None, number: int) -> Finding | None:
    """Turn one page's scores into a finding, or None. Conservative by design."""
    if thresholds is None or "score" not in page:
        return None
    score, t95, tmax = float(page["score"]), thresholds["t95"], thresholds["tmax"]
    if score < t95:
        return None
    above_max = score >= tmax
    severity = Severity[thresholds.get("severity_at_tmax", "LOW")] if above_max else Severity.INFO
    measured = thresholds.get("measured", {})
    return Finding(
        "PIXEL_ANOMALY", severity, Category.TAMPERING,
        f"The pixel model rates page {number} as unusual" if above_max else f"The pixel model rates page {number} as slightly elevated",
        f"TruFor scored page {number} at {score:.2f}. "
        + (f"{'Every' if above_max else 'Most'} genuine page in the calibration set scored below "
           f"{'this' if above_max else 'this level'} (calibrated on {thresholds.get('n_calibration', '?')} genuine pages). ")
        + "Pixel models trained on photographs transfer weakly to documents"
        + (f": in testing it caught {measured['tpr_gap_tmax']:.0%} of the forgeries the other layers miss at this threshold, "
           f"with {measured['fpr_phone_tmax']:.0%} false alarms on phone-style recompressed genuine pages. " if measured else ". ")
        + "Treat this as a hint to look at the page, never as proof.",
        {"score": score, "t95": t95, "tmax": tmax, "map_p99": page.get("map_p99"), "page": number, "model": thresholds.get("model"),
         "source": "layer3"})


def run_layer3(data: bytes, file_type: str, options: Layer3Options | None = None,
               runner: Callable[[list[bytes], Layer3Options], list[dict[str, Any]]] | None = None) -> Layer3Result:
    options = options or Layer3Options()
    res = Layer3Result()
    started = time.time()
    if runner is None:
        ok, why = availability()
        if not ok:
            res.status = "unavailable"
            res.errors.append(f"layer3: unavailable: {why}")
            return res
        runner = _subprocess_runner
    try:
        pages = render_pngs(data, file_type, options.max_pages)
    except Exception as exc:  # noqa: BLE001
        res.status = "failed"
        res.errors.append(f"layer3: could not render this {file_type}: {type(exc).__name__}: {exc}")
        return res
    try:
        scored = runner(pages, options)
    except Exception as exc:  # noqa: BLE001 - any worker problem means the pages were not scored
        res.status = "failed"
        res.errors.append(f"layer3: {type(exc).__name__}: {exc}")
        return res
    thresholds = load_thresholds()
    for i, page in enumerate(scored, 1):
        if "error" in page:
            res.errors.append(f"layer3: page {i}: {page['error']}")
            res.status = "failed" if not res.pages else "ok"
            continue
        res.pages.append(page)
        finding = grade(page, thresholds, i)
        if finding:
            res.findings.append(finding)
    if len(scored) < len(pages):
        res.errors.append(f"layer3: only {len(scored)} of {len(pages)} pages were scored")
        res.status = "failed" if not res.pages else res.status
    if thresholds is None:
        res.errors.append("layer3: no calibrated thresholds installed, so scores are shown but no finding is raised")
    res.seconds = round(time.time() - started, 1)
    return res
