"""Evaluate docforensics on a labelled set of files.

    python scripts/evaluate.py labels.csv [--doc-type payslip] [--out results.json]

labels.csv has columns ``path,label`` where label is ``genuine`` or ``forged``
(any extra columns are carried into the output). Reports the false-alarm rate on
genuine files, the detection rate on forged files, and which findings fired.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from docforensics import Severity, Verdict, analyze  # noqa: E402

FLAGGED = {Verdict.REVIEW, Verdict.HIGH_RISK}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("labels")
    parser.add_argument("--doc-type")
    parser.add_argument("--out")
    args = parser.parse_args()

    with open(args.labels, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    base = Path(args.labels).parent
    results = []
    started = time.perf_counter()
    for i, row in enumerate(rows, 1):
        path = Path(row["path"])
        path = path if path.is_absolute() else base / path
        t0 = time.perf_counter()
        report = analyze(path, doc_type=args.doc_type)
        results.append({**row, "verdict": report.verdict.value, "seconds": round(time.perf_counter() - t0, 3),
                        "findings": [f"{f.severity.name}:{f.code}" for f in report.sorted_findings() if f.severity >= Severity.LOW],
                        "titles": [f.title for f in report.sorted_findings() if f.severity >= Severity.LOW],
                        "errors": report.errors})
        if i % 50 == 0:
            print(f"  {i}/{len(rows)}", file=sys.stderr)
    elapsed = time.perf_counter() - started

    for label in ("genuine", "forged"):
        subset = [r for r in results if r["label"] == label]
        if not subset:
            continue
        verdicts = Counter(r["verdict"] for r in subset)
        flagged = sum(verdicts[v.value] for v in FLAGGED)
        rate_name = "false-alarm rate" if label == "genuine" else "detection rate"
        print(f"\n{label}: {len(subset)} files  {rate_name}: {flagged}/{len(subset)} = {flagged / len(subset):.1%}")
        print("  verdicts: " + ", ".join(f"{k}={v}" for k, v in sorted(verdicts.items())))
        groups = sorted({r.get("group") for r in subset if r.get("group")})
        for g in groups if len(groups) > 1 else []:
            in_group = [r for r in subset if r.get("group") == g]
            n = sum(r["verdict"] in ("review", "high_risk") for r in in_group)
            print(f"    {g:28s} {n}/{len(in_group)} = {n / len(in_group):.1%}")
        codes = Counter(c for r in subset for c in r["findings"])
        for code, n in codes.most_common(15):
            print(f"  {n:4d}  {code}")
        errored = [r for r in subset if r["errors"]]
        if errored:
            print(f"  files with check errors: {len(errored)} (e.g. {errored[0]['errors'][0][:120]})")
    print(f"\n{len(results)} files in {elapsed:.1f}s ({elapsed / max(len(results), 1) * 1000:.0f} ms/file)")

    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=2, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
