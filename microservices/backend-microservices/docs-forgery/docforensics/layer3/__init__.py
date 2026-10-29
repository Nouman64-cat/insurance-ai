"""Layer 3: pixel forensics (experimental, optional, local).

A trained forgery-localisation model (TruFor) scores each rendered page. It runs in a SEPARATE Python environment that has
PyTorch (the main app's interpreter has none), driven by ``trufor_worker.py`` over stdin/stdout. Nothing leaves the machine
and nothing is written to disk.

Reliability: pixel models trained on photographs transfer weakly to documents (see docs/EXPERIMENTS_PIXEL_MODELS.md), so
this layer is deliberately conservative. Scores at t95 yield informational findings; scores at tmax yield at most LOW.
The packaged thresholds are a provisional public-reference baseline, not validated for customer submissions.
It never decides a verdict alone.

Licence: TruFor's weights are for informational and NONPROFIT use only (GRIP-UNINA). They are not part of this repository.

Configuration (environment):
    PIXEL_PYTHON   path to a python.exe/python with torch, timm, yacs, pillow, numpy (default: <repo>/venv_exp)
    TRUFOR_DIR     folder holding code/ and weights/ from GRIP-UNINA (default: <repo>/data/models/trufor)
"""

from __future__ import annotations

import io
import json
import math
import os
import struct
import subprocess
import sys
import time
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..report import Category, Finding, Severity

ROOT = Path(__file__).resolve().parents[2]
WORKER = Path(__file__).with_name("trufor_worker.py")
THRESHOLDS = Path(__file__).with_name("thresholds.json")
RENDER_DPI = 130  # the resolution the thresholds were calibrated at
_WORKER_LOCK = threading.Lock()  # bound peak memory when public callers request pixel inference


@dataclass
class Layer3Options:
    max_pages: int = 1  # ~15 s per page on a laptop CPU, plus ~10 s to load the model
    max_side: int = 1024  # the worker downscales pages so the longer side is at most this (calibration used the same)
    timeout_s: float = 300.0
    thresholds: dict[str, Any] | None = None  # immutable per-request platform override


@dataclass
class Layer3Result:
    status: str = "ok"  # "ok" | "partial" | "unavailable" (not set up) | "failed"
    findings: list[Finding] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    pages: list[dict[str, Any]] = field(default_factory=list)  # per-page scores (and a small heatmap) for display
    seconds: float = 0.0
    calibration: dict[str, Any] | None = None


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
        value = json.loads(Path(os.environ.get("PIXEL_THRESHOLDS", "") or THRESHOLDS).read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            return None
        if not isinstance(value.get("model", "trufor"), str) or value.get("model", "trufor").lower() != "trufor":
            return None
        t95, tmax = value["t95"], value["tmax"]
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (t95, tmax)):
            return None
        if not 0 <= t95 <= tmax <= 1 or value.get("severity_at_tmax", "LOW") not in ("INFO", "LOW"):
            return None
        if value.get("render_dpi", RENDER_DPI) != RENDER_DPI or value.get("max_side", 1024) != 1024:
            return None
        if not isinstance(value.get("n_calibration"), int) or value["n_calibration"] < 2:
            return None
        validation = value.get("validation", {})
        if not isinstance(validation, dict) or not isinstance(value.get("scope", "reference"), str):
            return None
        if not isinstance(validation.get("n_genuine", 0), int) or validation.get("n_genuine", 0) < 0:
            return None
        fpr = validation.get("fpr_at_tmax")
        if fpr is not None and (isinstance(fpr, bool) or not isinstance(fpr, (int, float)) or not math.isfinite(fpr) or not 0 <= fpr <= 1):
            return None
        if value.get("created_at") is not None and not isinstance(value["created_at"], str):
            return None
        runtime = value.get("runtime", {})
        if not isinstance(runtime, dict):
            return None
        if runtime.get("worker_sha256"):
            import hashlib
            if hashlib.sha256(WORKER.read_bytes()).hexdigest() != runtime["worker_sha256"]:
                return None
        revision_file = models_dir()/"REVISION"
        if runtime.get("upstream_revision") and revision_file.is_file() and revision_file.read_text().strip() != runtime["upstream_revision"]:
            return None
        return value
    except (OSError, ValueError, KeyError, TypeError):
        return None


def threshold_summary(value):
    if value is None:
        return None
    validation = value.get("validation", {})
    return {"t95": value["t95"], "tmax": value["tmax"], "n_calibration": value["n_calibration"],
            "scope": value.get("scope", "unspecified_reference_baseline"),
            "n_validation": validation.get("n_genuine", 0), "fpr_at_tmax": validation.get("fpr_at_tmax"),
            "created_at": value.get("created_at"), "provisional": True}


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


def _parse_lines(stdout: bytes | None) -> list[dict[str, Any]]:
    out = []
    for line in (stdout or b"").decode("utf-8", "replace").splitlines():
        if line.startswith("{"):
            try:
                out.append(json.loads(line))
            except ValueError:
                continue  # a line cut off when the worker was killed
    return out


def _subprocess_runner(pages: list[bytes], options: Layer3Options) -> list[dict[str, Any]]:
    python = pixel_python()
    payload = b"".join(struct.pack(">I", len(p)) + p for p in pages) + struct.pack(">I", 0)
    try:
        with _WORKER_LOCK:
            proc = subprocess.run([str(python), str(WORKER), str(models_dir()), str(options.max_side)], input=payload,
                                  capture_output=True, timeout=options.timeout_s, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired as exc:
        # Pages scored before the deadline are still valid; keep them and mark the next page as not finished.
        done = [ln for ln in _parse_lines(exc.stdout) if "ready" not in ln and "fatal" not in ln]
        if not done:
            raise TimeoutError(f"pixel model did not finish within {options.timeout_s:.0f}s") from exc
        return done + [{"error": f"not scored: the pixel model ran out of time ({options.timeout_s:.0f}s)"}]
    lines = _parse_lines(proc.stdout)
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
    severity = min(Severity[thresholds.get("severity_at_tmax", "LOW")], Severity.LOW) if above_max else Severity.INFO
    measured = thresholds.get("measured", {})
    return Finding(
        "PIXEL_ANOMALY", severity, Category.TAMPERING,
        f"The pixel model rates page {number} as unusual" if above_max else f"The pixel model rates page {number} as slightly elevated",
        f"TruFor scored page {number} at {score:.2f}. "
        + ("Using SuperAdmin manual thresholds " if thresholds.get("scope") == "superadmin_manual" else f"Compared against {thresholds.get('n_calibration', '?')} reference calibration pages ")
        + f"(t95={t95:.6f}, tmax={tmax:.6f}). These thresholds are provisional and not validated for customer submissions. "
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
    thresholds = options.thresholds if options.thresholds is not None else load_thresholds()
    if thresholds is not None and options.max_side != thresholds.get("max_side", 1024):
        res.errors.append("layer3: inference size differs from calibration; cutoffs were not applied")
        thresholds = None
    res.calibration = threshold_summary(thresholds)
    for i, page in enumerate(scored, 1):
        if "error" in page:
            res.errors.append(f"layer3: page {i}: {page['error']}")
            res.status = "partial"
            continue
        page["page"] = i
        res.pages.append(page)
        finding = grade(page, thresholds, i)
        if finding:
            res.findings.append(finding)
    if len(scored) < len(pages):
        res.errors.append(f"layer3: only {len(scored)} of {len(pages)} pages were scored")
        res.status = "partial"
    if not res.pages:
        res.status = "failed"
    if thresholds is None:
        res.errors.append("layer3: no calibrated thresholds installed, so scores are shown but no finding is raised")
    res.seconds = round(time.time() - started, 1)
    return res
