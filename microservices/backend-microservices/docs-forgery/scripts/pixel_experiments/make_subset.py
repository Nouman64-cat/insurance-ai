"""A stratified subset of the evaluation set for slow models (TruFor on CPU): data/pixel_eval/subset_trufor.txt.

Keeps every forgery type that layers 1 and 2 miss, and genuine images from each source, deterministically.
"""

import csv
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVAL = ROOT / "data" / "pixel_eval"
QUOTA = {  # group -> how many
    "receipt_genuine": 22, "pdf_genuine": 14, "l2_genuine": 10,
    "receipt_forged_paint": 12, "receipt_forged_preview": 6, "receipt_forged_paint3d": 4, "receipt_forged_gimp": 8,
    "pdf_forged_redact": 12, "pdf_forged_overlay": 4, "l2_forged": 10,
}
rows = list(csv.DictReader((EVAL / "manifest.csv").open(encoding="utf-8")))
rnd = random.Random(20261020)
chosen = []
for group, n in QUOTA.items():
    pool = [r for r in rows if r["group"] == group]
    rnd.shuffle(pool)
    chosen += pool[:n]
(EVAL / "subset_trufor.txt").write_text("\n".join(r["id"] for r in chosen), encoding="utf-8")
g = sum(r["label"] == "genuine" for r in chosen)
cal = sum(r["split"] == "calibration" for r in chosen if r["label"] == "genuine")
print(f"subset: {len(chosen)} images ({g} genuine of which {cal} calibration, {len(chosen) - g} forged)")
