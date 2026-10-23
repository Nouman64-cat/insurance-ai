"""Load TruFor and time it on a few images (the CPU is shared with other jobs, so timings are upper bounds)."""

import csv
import sys
import time
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from adapters import ROOT, TruFor  # noqa: E402

EVAL = ROOT / "data" / "pixel_eval"
t = time.time()
ad = TruFor()
ad.load()
print(f"loaded in {time.time() - t:.1f}s")
rows = list(csv.DictReader((EVAL / "manifest.csv").open(encoding="utf-8")))
for grp in ("receipt_genuine", "receipt_forged_paint", "pdf_genuine", "pdf_forged_redact"):
    r = next(x for x in rows if x["group"] == grp)
    img = Image.open(EVAL / r["path"])
    t = time.time()
    s = ad.score(img)
    print(f"{grp:24s} {img.size}  {time.time() - t:5.1f}s  score={s['score']:.3f}  map_p99={s['map_p99']:.3f}  scale={s['scale']:.2f}")
