"""Build a labels.csv for the "Find it again!" receipt dataset.

    python scripts/labels_findit2.py data/findit2/findit2 data/findit2_eval.csv
"""

from __future__ import annotations

import ast
import csv
import sys
from pathlib import Path


def main() -> int:
    root, out = Path(sys.argv[1]), Path(sys.argv[2])
    rows = []
    for split in ("train", "val", "test"):
        with (root / f"{split}.txt").open(newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if not (root / split / r["image"]).exists():
                    print(f"  missing from archive: {split}/{r['image']}", file=sys.stderr)
                    continue
                forged = r["forged"].strip() == "1"
                software = ""
                if forged:
                    try:
                        software = ast.literal_eval(r["forgery annotations"]).get("file_attributes", {}).get("Software used", "")
                    except (ValueError, SyntaxError, AttributeError):
                        pass
                rows.append({"path": str((root / split / r["image"]).resolve()), "label": "forged" if forged else "genuine",
                             "group": software or ("authentic" if not forged else "unknown")})
    with out.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["path", "label", "group"])
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)} rows ({sum(r['label'] == 'forged' for r in rows)} forged) -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
