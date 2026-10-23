"""Print flagged files from an evaluate.py results file.

    python scripts/show_results.py results.json [--label genuine] [--code IMAGE_SOFTWARE] [--limit 20]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("results")
    parser.add_argument("--label")
    parser.add_argument("--code", default="")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--flagged-only", action="store_true")
    args = parser.parse_args()
    rows = json.loads(Path(args.results).read_text(encoding="utf-8"))
    shown = 0
    for r in rows:
        if args.label and r["label"] != args.label:
            continue
        if args.flagged_only and r["verdict"] not in ("review", "high_risk"):
            continue
        if args.code and not any(args.code in c for c in r["findings"]):
            continue
        print(f"{Path(r['path']).name} [{r['verdict']}]")
        for code, title in zip(r["findings"], r["titles"]):
            print(f"   {code:45s} {title}")
        shown += 1
        if shown >= args.limit:
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
