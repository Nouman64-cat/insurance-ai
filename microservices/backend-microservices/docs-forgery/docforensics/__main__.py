"""Command line: python -m docforensics FILE [FILE ...] [--doc-type bank_statement] [--json] [--layer2]"""

from __future__ import annotations

import argparse
import json
import sys

from . import analyze, analyze_with_content
from .pdf.context import DOC_TYPES
from .report import Severity

_MARK = {Severity.CRITICAL: "CRITICAL", Severity.HIGH: "HIGH    ", Severity.MEDIUM: "MEDIUM  ",
         Severity.LOW: "LOW     ", Severity.INFO: "info    "}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="docforensics",
        description="File and metadata forensics for documents (layer 1 + optional layer 2 via Gemini).",
    )
    parser.add_argument("files", nargs="+")
    parser.add_argument("--doc-type", choices=[*DOC_TYPES, "invoice", "receipt"],
                        help="tightens rules that depend on who issues the document")
    parser.add_argument("--json", action="store_true", help="print JSON reports")
    parser.add_argument("--all", action="store_true", help="also print informational findings")
    parser.add_argument(
        "--layer2", action="store_true",
        help="run Gemini content-consistency checks (arithmetic, dates, visual; requires GEMINI_API_KEY in .env)",
    )
    args = parser.parse_args(argv)

    _analyze = analyze_with_content if args.layer2 else analyze
    reports = [_analyze(f, doc_type=args.doc_type) for f in args.files]

    if args.json:
        out = [r.to_dict() for r in reports]
        json.dump(out[0] if len(out) == 1 else out, sys.stdout, indent=2, default=str, ensure_ascii=False)
        print()
        return 0

    for r in reports:
        l2_count = sum(1 for f in r.findings if f.code.startswith("CONTENT_"))
        layer_tag = f" | layer 2: {r.layer2_status}, {l2_count} findings" if args.layer2 else ""
        print(f"\n{r.path}  [{r.verdict.value.upper()}]  {r.file_type}, {r.size:,} bytes{layer_tag}")
        for f in r.sorted_findings():
            if f.severity is Severity.INFO and not args.all:
                continue
            layer = " [L2]" if f.code.startswith("CONTENT_") else ""
            print(f"  {_MARK[f.severity]}{layer} {f.title}")
            print(f"           {f.detail}")
        for e in r.errors:
            print(f"  error    {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
