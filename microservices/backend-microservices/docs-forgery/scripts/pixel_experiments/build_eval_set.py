"""Build the evaluation set for the pixel-forensics model experiments.

    venv_exp\\Scripts\\python.exe scripts/pixel_experiments/build_eval_set.py

Output: data/pixel_eval/images/*.png|jpg and data/pixel_eval/manifest.csv with columns
    id, path, label (genuine|forged), group, source

Groups (what the image is, and for forgeries how it was made):
    receipt_genuine / receipt_forged_<program>       real receipts ("Find it again!", L3i), forged by people
    pdf_genuine / pdf_forged_overlay / pdf_forged_redact   page 1 of genuine PDFs and of their forged copies
    l2_genuine / l2_forged                           the 20 layer-2 test documents (phone-style JPEGs included)

Genuine images are split deterministically (by hash of the id) into `calibration` and `eval` so a model's decision
threshold is chosen on one part and judged on the other. Nothing is trained here.
"""

from __future__ import annotations

import ast
import csv
import hashlib
import json
import random
import shutil
import sys
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
OUT = DATA / "pixel_eval"
SEED = 20261020
RENDER_DPI = 130


def render_pdf(path: Path, dest: Path) -> bool:
    try:
        pdf = pdfium.PdfDocument(str(path))
        page = pdf[0]
        page.render(scale=RENDER_DPI / 72).to_pil().convert("RGB").save(dest, "PNG")
        page.close(), pdf.close()
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"  skip {path.name}: {exc}")
        return False


def split_of(doc_id: str) -> str:
    return "calibration" if int(hashlib.sha256(doc_id.encode()).hexdigest(), 16) % 100 < 35 else "eval"


def receipts(rnd: random.Random, n_genuine: int, n_forged: int) -> list[dict]:
    base = DATA / "findit2" / "findit2"
    genuine, forged = [], {}
    for split in ("train", "val", "test"):
        with (base / f"{split}.txt").open(newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                path = base / split / r["image"]
                if not path.exists():
                    continue
                if r["forged"] == "0" and r["digital annotation"] == "0" and r["handwritten annotation"] == "0":
                    genuine.append(path)
                elif r["forged"] == "1":
                    try:
                        info = ast.literal_eval(r["forgery annotations"])
                    except (ValueError, SyntaxError):
                        continue
                    if not isinstance(info, dict):
                        continue
                    software = str(info.get("file_attributes", {}).get("Software used", "")).lower()
                    key = "preview" if ("aper" in software or "preview" in software) else (software or "unknown")
                    forged.setdefault(key, []).append(path)
    rnd.shuffle(genuine)
    rows = [{"src": p, "label": "genuine", "group": "receipt_genuine", "source": f"findit2/{p.name}"} for p in genuine[:n_genuine]]
    total = sum(len(v) for v in forged.values())
    for key, paths in sorted(forged.items()):
        rnd.shuffle(paths)
        take = max(1, round(n_forged * len(paths) / total))
        rows += [{"src": p, "label": "forged", "group": f"receipt_forged_{key}", "source": f"findit2/{p.name}"} for p in paths[:take]]
    return rows


def main() -> int:
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "images").mkdir(parents=True)
    rnd = random.Random(SEED)
    rows: list[dict] = []

    # 1. real receipts
    for r in receipts(rnd, 60, 60):
        dest = OUT / "images" / f"rc_{r['src'].stem}.png"
        Image.open(r["src"]).convert("RGB").save(dest, "PNG")
        rows.append({**r, "path": dest})

    # 2. PDFs: genuine sources, and forged copies of the same sources
    genuine_pdfs = sorted((DATA / "pdf_genuine").rglob("*.pdf"))
    rnd.shuffle(genuine_pdfs)
    paired = genuine_pdfs[:15]
    for src in genuine_pdfs[:30]:
        dest = OUT / "images" / f"pg_{src.parent.name}_{src.stem}.png"
        if render_pdf(src, dest):
            rows.append({"path": dest, "label": "genuine", "group": "pdf_genuine", "source": f"pdf_genuine/{src.parent.name}/{src.name}"})
    for technique, group in (("overlay_rewrite", "pdf_forged_overlay"), ("redact_rewrite", "pdf_forged_redact")):
        for src in paired:
            forged = DATA / "pdf_forged" / technique / f"{src.parent.name}_{src.stem}.pdf"
            dest = OUT / "images" / f"pf_{technique}_{src.parent.name}_{src.stem}.png"
            if forged.exists() and render_pdf(forged, dest):
                rows.append({"path": dest, "label": "forged", "group": group, "source": f"pdf_forged/{technique}/{forged.name}"})

    # 3. the 20 layer-2 test documents
    l2 = DATA / "layer2_testset"
    if (l2 / "manifest.json").exists():
        for d in json.loads((l2 / "manifest.json").read_text(encoding="utf-8")):
            src = l2 / d["path"]
            dest = OUT / "images" / f"l2_{src.stem}.png"
            if src.suffix.lower() == ".pdf":
                ok = render_pdf(src, dest)
            else:
                Image.open(src).convert("RGB").save(dest, "PNG")
                ok = True
            if ok:
                rows.append({"path": dest, "label": d["label"], "group": "l2_" + d["label"], "source": f"layer2_testset/{d['path']}"})

    manifest = OUT / "manifest.csv"
    with manifest.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["id", "path", "label", "group", "split", "source", "width", "height"])
        w.writeheader()
        for r in rows:
            p = Path(r["path"])
            with Image.open(p) as im:
                width, height = im.size
            doc_id = p.stem
            w.writerow({"id": doc_id, "path": str(p.relative_to(OUT)), "label": r["label"], "group": r["group"],
                        "split": split_of(doc_id) if r["label"] == "genuine" else "eval", "source": r["source"],
                        "width": width, "height": height})
    by = {}
    for r in rows:
        by[(r["label"], r["group"])] = by.get((r["label"], r["group"]), 0) + 1
    print(f"{len(rows)} images -> {manifest}")
    for (label, group), n in sorted(by.items()):
        print(f"  {label:8s} {group:28s} {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
