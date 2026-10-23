"""Repeatable HTTP benchmark. Synthetic mode verifies function, never estimates accuracy."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from benchmarking import summarize


def synthetic_cases():
    import pikepdf
    def document(edited):
        pdf = pikepdf.Pdf.new()
        page = pdf.add_blank_page(page_size=(595, 842))
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=pikepdf.Dictionary(
            Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica,
        )))
        content = b"BT /F1 12 Tf 72 760 Td (SYNTHETIC TEST INVOICE - NOT VALID) Tj 0 -30 Td (Total: 110.00) Tj ET\n"
        if edited:
            content += b"q 1 1 1 rg 70 725 160 20 re f Q BT /F1 12 Tf 72 730 Td (Total: 910.00) Tj ET\n"
        page.Contents = pikepdf.Stream(pdf, content)
        output = io.BytesIO()
        pdf.save(output)
        return output.getvalue()
    return [{"name": f"synthetic-{label}.pdf", "label": label, "group": "synthetic_overlay", "data": document(label == "forged")}
            for label in ("genuine", "forged")]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sources = parser.add_mutually_exclusive_group(required=True)
    sources.add_argument("--labels", type=Path, help="CSV: path,label[,group]; labels genuine or forged")
    sources.add_argument("--synthetic", action="store_true", help="Two synthetic smoke cases; not an accuracy dataset")
    parser.add_argument("--url", default="http://localhost:8032", help="Backend URL, or frontend URL with --frontend")
    parser.add_argument("--frontend", action="store_true")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--concurrency", type=int, choices=range(1, 33), default=1)
    parser.add_argument("--layer2", action="store_true", help="Send benchmark pages to the external model provider")
    parser.add_argument("--provider", choices=("gemini", "groq"), default="gemini")
    parser.add_argument("--layer3", action="store_true")
    parser.add_argument("--max-pages", type=int, choices=range(1, 41), default=1)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.repeat < 1:
        parser.error("--repeat must be positive")
    if args.synthetic:
        cases = synthetic_cases()
    else:
        with args.labels.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
        if not rows or any(r.get("label") not in ("genuine", "forged") or not r.get("path") for r in rows):
            parser.error("Labels must contain path,label and at least one genuine/forged row")
        cases = [{"name": Path(r["path"]).name, "label": r["label"], "group": r.get("group", "ungrouped"),
                  "path": args.labels.parent / r["path"]} for r in rows]
    settings = {"layer2": str(args.layer2).lower(), "layer3": str(args.layer3).lower(),
                "provider": args.provider, "max_pages": str(args.max_pages), "visual": "false"}
    endpoint = args.url.rstrip("/") + ("/api/analyze" if args.frontend else "/analyze")
    with httpx.Client(timeout=660) as client:
        def run(case):
            started = time.perf_counter()
            result = {"name": case["name"], "label": case["label"], "group": case["group"], "complete": False}
            try:
                payload = case.get("data") if "data" in case else case["path"].read_bytes()
                response = client.post(endpoint, files={"file": (case["name"], payload)}, data=settings)
                result["http_status"] = response.status_code
                if response.status_code == 200:
                    report = response.json()
                    result.update(verdict=report["verdict"], complete=report.get("performance", {}).get("complete", False),
                                  performance=report.get("performance"), errors=report.get("errors", []))
                else:
                    result["error"] = f"HTTP {response.status_code}"
            except (OSError, ValueError, httpx.HTTPError) as exc:
                result["error"] = type(exc).__name__
            result["client_seconds"] = time.perf_counter() - started
            return result
        started = time.perf_counter()
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            results = list(pool.map(run, cases * args.repeat))
        elapsed = time.perf_counter() - started
    report = {"created_at": datetime.now(timezone.utc).isoformat(), "dataset": "synthetic_smoke" if args.synthetic else str(args.labels),
              "interpretation": "Functional smoke test only; not a real-world accuracy estimate." if args.synthetic else "Dataset-specific measurements; use a held-out labelled set and report coverage.",
              "settings": {**settings, "repeat": args.repeat, "concurrency": args.concurrency},
              "summary": summarize(results, elapsed),
              "groups": {group: summarize([r for r in results if r["group"] == group], elapsed) for group in sorted({r["group"] for r in results})},
              "results": results}
    # Per-group runtime wall throughput is not meaningful when groups run concurrently.
    for summary in report["groups"].values():
        summary.pop("runtime")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"dataset": report["dataset"], "summary": report["summary"], "output": str(args.out)}, indent=2))
    return 0 if report["summary"]["http_failures"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
