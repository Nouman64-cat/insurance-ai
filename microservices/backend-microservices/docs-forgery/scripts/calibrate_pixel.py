"""Measure conservative pixel thresholds from disjoint genuine reference sets."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from docforensics import detect_type
from docforensics.layer3 import WORKER, RENDER_DPI, models_dir, pixel_python, render_pngs
from performance import percentile

IRS = "f1040 f1040s1 f1040s2 f1040s3 f1040sa f1040sb f1040sc f1040sd f1040se f1040sse f1040es f1040x f1040sr f1040v f1065 f1120 f1120s f2441 f4562 f4868".split()
INVOICES = "AmazonWebServices AzureInterior FlipkartInvoice NetpresseInvoice QualityHosting SammyMaystoneLinesTest coolblue1 coolblue2 free_fiber oyo".split()


def make_thresholds(records, scope):
    calibration = [r for r in records if r["split"] == "calibration"]
    validation = [r for r in records if r["split"] == "validation"]
    if len(calibration) < 20 or len(validation) < 5:
        raise ValueError("Need at least 20 calibration and 5 separate validation documents")
    hashes = [r["sha256"] for r in records]
    if len(set(hashes)) != len(hashes):
        raise ValueError("Duplicate content or calibration/validation overlap")
    if any(not math.isfinite(r["score"]) or not 0 <= r["score"] <= 1 for r in records):
        raise ValueError("Invalid model score")
    scores = [r["score"] for r in calibration]
    t95, tmax = percentile(scores, .95), max(scores)
    return {
        "schema_version": 1, "model": "trufor", "t95": t95, "tmax": tmax,
        "severity_at_tmax": "LOW", "n_calibration": len(calibration),
        "scope": scope, "render_dpi": RENDER_DPI, "max_side": 1024,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "validation": {"n_genuine": len(validation),
                       "above_t95": sum(r["score"] >= t95 for r in validation),
                       "above_tmax": sum(r["score"] >= tmax for r in validation),
                       "fpr_at_t95": sum(r["score"] >= t95 for r in validation) / len(validation),
                       "fpr_at_tmax": sum(r["score"] >= tmax for r in validation) / len(validation),
                       "forged_detection_rate": None},
        "limitations": "Provisional genuine-reference baseline, not validated for customer submissions. No forged-case sensitivity measured. First page only; original PDFs; no phone-photo/compression validation. Findings remain LOW severity.",
        "records": records,
    }


def score_pages(pages):
    """One model load, streaming progress, bounded stderr, hard process timeout."""
    python = pixel_python()
    if python is None:
        raise RuntimeError("Run calibration in the docs-forgery Docker container")
    payload = b"".join(struct.pack(">I", len(p)) + p for p in pages) + struct.pack(">I", 0)
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen([str(python), str(WORKER), str(models_dir()), "1024"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors)
        def feed():
            try:
                process.stdin.write(payload)
                process.stdin.close()
            except BrokenPipeError:
                pass
        writer = threading.Thread(target=feed, daemon=True)
        writer.start()
        timer = threading.Timer(1800, process.kill)
        timer.start()
        output = []
        try:
            for line in process.stdout:
                if not line.startswith(b"{"):
                    continue
                result = json.loads(line)
                if "fatal" in result or "error" in result:
                    raise RuntimeError(result.get("fatal") or result["error"])
                if "ready" in result:
                    print("Model loaded; scoring reference pages", flush=True)
                    continue
                output.append(result["score"])
                print(f"Scored {len(output)}/{len(pages)}: {result['score']:.6f}", flush=True)
            if process.wait() != 0 or len(output) != len(pages):
                raise RuntimeError("Calibration worker failed or did not score every reference")
            return output
        finally:
            timer.cancel()
            if process.poll() is None:
                process.kill()
            process.wait()
            writer.join(timeout=5)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sources = parser.add_mutually_exclusive_group(required=True)
    sources.add_argument("--reference", action="store_true", help="Public IRS forms and invoice2data fixtures; provisional baseline")
    sources.add_argument("--labels", type=Path, help="CSV: path,label,split; genuine only, explicit calibration/validation split")
    parser.add_argument("--cache", type=Path, default=Path("data/calibration"))
    parser.add_argument("--out", type=Path, default=Path("docforensics/layer3/thresholds.json"))
    args = parser.parse_args(argv)
    args.cache.mkdir(parents=True, exist_ok=True)
    if args.reference:
        entries = [{"name": name, "group": "irs", "source": f"https://www.irs.gov/pub/irs-pdf/{name}.pdf"} for name in IRS]
        entries += [{"name": name, "group": "invoice2data", "source": f"https://raw.githubusercontent.com/invoice-x/invoice2data/master/tests/compare/{name}.pdf"} for name in INVOICES]
        def fetch(entry):
            path = args.cache / f"{entry['group']}-{entry['name']}.pdf"
            if not path.exists():
                with urllib.request.urlopen(entry["source"], timeout=60) as response:
                    data = response.read()
                if not data.startswith(b"%PDF"):
                    raise ValueError(f"Not a PDF: {entry['source']}")
                path.write_bytes(data)
            return {**entry, "path": str(path)}
        with ThreadPoolExecutor(max_workers=4) as pool:
            entries = list(pool.map(fetch, entries))
        # Source-stratified split chosen before scores are observed.
        for group in ("irs", "invoice2data"):
            subset = [e for e in entries if e["group"] == group]
            for i, entry in enumerate(subset):
                entry["split"] = "validation" if i % 3 == 2 else "calibration"
        scope = "public_reference_baseline"
    else:
        with args.labels.open(newline="", encoding="utf-8") as stream:
            entries = list(csv.DictReader(stream))
        if any(not e.get("path") or e.get("label") != "genuine" or e.get("split") not in ("calibration", "validation") for e in entries):
            parser.error("Each row must be genuine and explicitly calibration or validation")
        entries = [{**e, "path": str(args.labels.parent / e["path"])} for e in entries]
        scope = "user_supplied_genuine_baseline"
    records, pages = [], []
    for entry in entries:
        data = Path(entry["path"]).read_bytes()
        records.append({"source": entry.get("source", Path(entry["path"]).name), "group": entry.get("group", "user"),
                        "sha256": hashlib.sha256(data).hexdigest(), "split": entry["split"], "score": 0.})
        rendered = render_pngs(data, detect_type(data), 1)
        if len(rendered) != 1:
            raise ValueError(f"Reference has no readable first page: {entry['path']}")
        pages.extend(rendered)
    # Validate counts and disjointness before spending inference time.
    make_thresholds(records, scope)
    print(f"Scoring {len(pages)} reference documents at {RENDER_DPI} DPI / 1024px", flush=True)
    scores = score_pages(pages)
    for record, score in zip(records, scores, strict=True):
        record["score"] = score
    thresholds = make_thresholds(records, scope)
    with next(models_dir().rglob("trufor.pth.tar")).open("rb") as weights:
        weights_sha256 = hashlib.file_digest(weights, "sha256").hexdigest()
    thresholds["runtime"] = {
        "worker_sha256": hashlib.sha256(WORKER.read_bytes()).hexdigest(),
        "weights_sha256": weights_sha256,
        "upstream_revision": (models_dir()/"REVISION").read_text().strip() if (models_dir()/"REVISION").is_file() else "unknown/manual installation",
        "packages": json.loads(subprocess.check_output([str(pixel_python()), "-c",
            "import importlib.metadata as m,json; print(json.dumps({k:m.version(k) for k in ('torch','torchvision','numpy','timm','pillow')}))"], text=True)),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.out.with_suffix(".tmp")
    temporary.write_text(json.dumps(thresholds, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.out)
    print(json.dumps({k:v for k,v in thresholds.items() if k != "records"}, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
