"""Write a labels.csv for scripts/evaluate.py from folders of files.

    python scripts/make_labels.py out.csv genuine=data/pdf_genuine forged=data/pdf_forged
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}


def main() -> int:
    out = Path(sys.argv[1])
    rows = []
    for spec in sys.argv[2:]:
        label, folder = spec.split("=", 1)
        for path in sorted(Path(folder).rglob("*")):
            if path.suffix.lower() in EXTENSIONS:
                rows.append({"path": str(path.resolve()), "label": label, "group": path.parent.name})
    with out.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["path", "label", "group"])
        writer.writeheader()
        writer.writerows(rows)
    print(f"{len(rows)} rows -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
