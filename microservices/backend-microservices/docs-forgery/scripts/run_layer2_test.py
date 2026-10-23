"""Run layer 2 on the labelled test set, politely and resumably.

    python scripts/make_layer2_testset.py data/layer2_testset         # once: build the 20 documents
    python scripts/run_layer2_test.py --dry-run                       # see the plan, no API calls
    python scripts/run_layer2_test.py                                 # run on Gemini (resumes where it stopped)
    python scripts/run_layer2_test.py --provider groq                 # run on Groq, results in data/layer2_run_groq

Defaults depend on the provider (Gemini: 15 s cooldown, 18-call budget, 4 pages; Groq: 6 s, 150 calls, 2 pages).

Rate limiting
  --cooldown S   minimum seconds between API requests (default 15, about 4 per minute)
  --doc-gap S    extra pause after each document (default 5)
  --max-calls N  API call budget for this session (default 18). The free tier allowed 20 requests per day
                 when this was written, and a document costs 2-3 calls (read, visual, +confirm when a
                 mismatch is found on a scan/photo), so the default stops before the daily quota does.
                 On a paid key raise it, e.g. --max-calls 100.
  --no-visual    skip the visual inspection call: 1-2 calls per document instead of 2-3

Safety
  * Results are appended to <out>/results.jsonl after every document; run again to resume.
  * A document whose reading failed is NOT counted as clean: it is "failed", excluded from the
    rates, and retried on the next run.
  * The run stops at once on a spent daily quota, a bad key, or 3 failed documents in a row.
  * Every API attempt (status, seconds, time waited) is logged to <out>/calls.jsonl.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import os
import sys
import time
from collections import Counter
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from docforensics.gemini_client import GeminiClient, Settings, make_client  # noqa: E402
from docforensics.layer2 import Options, run_layer2  # noqa: E402
from docforensics.report import Severity, Verdict, verdict_from_findings  # noqa: E402

FLAGGED = {Verdict.REVIEW.value, Verdict.HIGH_RISK.value}

# Gemini's free tier counts requests per day (20 seen); Groq's counts tokens per minute (8,000 seen on the
# vision model) with ~1,000 requests per day, and a request that needs more than 8,000 tokens can never succeed,
# so Groq reads at most 2 pages per document.
PROVIDER_DEFAULTS = {
    "gemini": {"cooldown": 15.0, "doc_gap": 5.0, "max_calls": 18, "max_pages": 4, "out": "layer2_run"},
    "groq": {"cooldown": 6.0, "doc_gap": 3.0, "max_calls": 150, "max_pages": 2, "out": "layer2_run_groq"},
}


def settings_for(provider: str) -> Settings:
    if provider == "groq":
        from docforensics.groq_client import settings_from_env

        return settings_from_env()
    return Settings.from_env()
STOP_KINDS = ("quota_exhausted", "(auth)", "(config)")
MAX_CONSECUTIVE_FAILURES = 3


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 1.0
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def _dec(value) -> Decimal | None:
    try:
        return Decimal(str(value))
    except InvalidOperation:
        return None


def localised(findings, new_value) -> bool:
    """Does any numeric finding point at the figure the forger planted?"""
    target = _dec(new_value)
    if target is None:
        return False
    for f in findings:
        involved = (f.evidence or {}).get("involved") or {}
        if any(_dec(v) == target for v in involved.values()):
            return True
    return False


def score(entry: dict, result) -> dict:
    findings = result.findings
    verdict = Verdict.INCONCLUSIVE.value if result.status == "failed" else verdict_from_findings(findings).value
    flagged_any = [f for f in findings if f.severity >= Severity.LOW]
    forged = entry.get("forged") or {}
    return {
        "id": entry["id"], "label": entry["label"], "kind": entry["kind"], "format": entry["format"],
        "expectation": entry["expectation"], "status": result.status, "verdict": verdict,
        "max_severity": max((f.severity for f in findings), default=Severity.INFO).name,
        "findings": [{"code": f.code, "severity": f.severity.name, "title": f.title, "detail": f.detail[:400],
                      "involved": (f.evidence or {}).get("involved"), "verified_by": (f.evidence or {}).get("verified_by")}
                     for f in findings if f.severity >= Severity.LOW],
        "visual_flag": any(f.code == "CONTENT_VISUAL_INCONSISTENCY" for f in flagged_any),
        "right_reason": bool(entry["label"] == "forged" and localised(findings, forged.get("value_new"))),
        "errors": result.errors, "notes": result.notes, "calls": result.calls,
        "calls_made": len(result.calls),
        "seconds": round(sum(c["seconds"] + c["waited_s"] for c in result.calls), 1),
    }


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------

def load_results(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rec = json.loads(line)
            out[rec["id"]] = rec  # later lines win: a retried document replaces its failed record
    return out


def worst_case_calls(entry: dict, options: Options) -> int:
    return 1 + (1 if options.visual else 0) + (1 if entry["format"] == "image" else 0)


def run_session(manifest: list[dict], data_dir: Path, out_dir: Path, client: GeminiClient, options: Options,
                max_calls: int, doc_gap: float, only: list[str] | None = None, sleep=time.sleep, log=print) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "extractions").mkdir(exist_ok=True)
    results_path = out_dir / "results.jsonl"
    existing = load_results(results_path)
    todo = [e for e in manifest if (not only or e["id"] in only) and existing.get(e["id"], {}).get("status") not in ("ok", "partial")]
    log(f"{len(manifest)} documents; {len(todo)} to run ({len(manifest) - len(todo)} already done or not selected); budget {max_calls} calls")

    used, consecutive_failures, stopped = 0, 0, None
    for i, entry in enumerate(todo, 1):
        need = worst_case_calls(entry, options)
        if used + need > max_calls:
            stopped = f"call budget reached ({used}/{max_calls} used; the next document may need {need})"
            break
        data = (data_dir / entry["path"]).read_bytes()
        file_type = "pdf" if entry["path"].lower().endswith(".pdf") else ("jpeg" if entry["path"].lower().endswith((".jpg", ".jpeg")) else "png")
        result = run_layer2(data, entry["path"], file_type, entry["doc_type"], client=client, options=options)
        rec = score(entry, result)
        rec["model"] = client.settings.model
        used += rec["calls_made"]
        with results_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
        if result.extraction is not None:
            (out_dir / "extractions" / f"{entry['id']}.json").write_text(
                json.dumps(dataclasses.asdict(result.extraction), indent=1, default=str), encoding="utf-8")
        if result.raw is not None:  # the model's own reply: lets scripts/replay_layer2.py re-score without API calls
            (out_dir / "extractions" / f"{entry['id']}.raw.json").write_text(json.dumps(result.raw, indent=1), encoding="utf-8")
        if result.raw_visual is not None:
            (out_dir / "extractions" / f"{entry['id']}.visual.json").write_text(json.dumps(result.raw_visual, indent=1), encoding="utf-8")
        log(f"[{i}/{len(todo)}] {entry['id']:44s} {rec['status']:8s} {rec['verdict']:13s} calls={rec['calls_made']} "
            f"{rec['seconds']:5.0f}s  {'; '.join(result.errors)[:90]}")

        consecutive_failures = consecutive_failures + 1 if result.status == "failed" else 0
        text = " ".join(result.errors)
        if result.status == "failed" and any(k in text for k in STOP_KINDS):
            stopped = f"stopped: {text[:160]}"
            break
        if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
            stopped = f"stopped: {MAX_CONSECUTIVE_FAILURES} documents in a row could not be read (outage?)"
            break
        if i < len(todo):
            sleep(doc_gap)

    all_results = load_results(results_path)
    summary = summarize([all_results[e["id"]] for e in manifest if e["id"] in all_results], len(manifest))
    summary["stopped"] = stopped
    summary["calls_this_session"] = used
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

def _rate(k: int, n: int) -> str:
    lo, hi = wilson(k, n)
    return f"{k}/{n}" + (f" = {k / n:.0%} (95% CI {lo:.0%}-{hi:.0%})" if n else "")


def summarize(records: list[dict], total_docs: int) -> dict:
    analysed = [r for r in records if r["status"] in ("ok", "partial")]
    failed = [r for r in records if r["status"] == "failed"]
    genuine = [r for r in analysed if r["label"] == "genuine"]
    forged = [r for r in analysed if r["label"] == "forged"]
    arithmetic = [r for r in forged if r["expectation"] == "arithmetic"]
    unknown = [r for r in forged if r["expectation"] == "unknown"]  # forged receipts: arithmetic may or may not be broken
    calls = [c for r in records for c in r["calls"]]
    statuses = Counter((c["purpose"], c["status"]) for c in calls)
    return {
        "documents": total_docs, "run": len(records), "analysed": len(analysed), "failed": len(failed),
        "partial": sum(r["status"] == "partial" for r in analysed),
        "genuine": {"n": len(genuine), "flagged": sum(r["verdict"] in FLAGGED for r in genuine),
                    "any_finding": [r["id"] for r in genuine if r["findings"]]},
        "forged_arithmetic": {"n": len(arithmetic), "caught": sum(r["verdict"] in FLAGGED for r in arithmetic),
                              "right_reason": sum(r["right_reason"] for r in arithmetic),
                              "missed": [r["id"] for r in arithmetic if r["verdict"] not in FLAGGED]},
        "forged_unknown": {"n": len(unknown), "caught": sum(r["verdict"] in FLAGGED for r in unknown),
                           "right_reason": sum(r["right_reason"] for r in unknown),
                           "flagged_any": sum(bool(r["findings"]) for r in unknown),
                           "visual_flag": sum(r["visual_flag"] for r in unknown)},
        "calls": {"total": len(calls), "by_purpose_status": {f"{p}:{s}": n for (p, s), n in sorted(statuses.items())},
                  "seconds_waiting": round(sum(c["waited_s"] for c in calls), 1)},
        "failed_ids": [r["id"] for r in failed],
    }


def print_summary(s: dict, records: list[dict], log=print) -> None:
    g, a, v = s["genuine"], s["forged_arithmetic"], s["forged_unknown"]
    log("\n" + "=" * 78)
    log(f"Documents: {s['documents']} | run: {s['run']} | analysed: {s['analysed']} ({s['partial']} partial) | "
        f"FAILED (not read, excluded below): {s['failed']}")
    log(f"Genuine, analysed       : false alarms (review/high_risk) {_rate(g['flagged'], g['n'])}"
        + (f"; any finding: {', '.join(g['any_finding'])}" if g["any_finding"] else ""))
    log(f"Forged, arithmetic      : caught {_rate(a['caught'], a['n'])}; pointing at the edited figure: {a['right_reason']}")
    if a["missed"]:
        log(f"   missed: {', '.join(a['missed'])}")
    log(f"Forged receipts (?)    : caught {_rate(v['caught'], v['n'])}; any finding {v['flagged_any']}; visual flag {v['visual_flag']} "
        "(these forgers sometimes kept the arithmetic consistent, which no content check can see)")
    c = s["calls"]
    log(f"API calls: {c['total']} ({', '.join(f'{k}={n}' for k, n in c['by_purpose_status'].items())}); waited {c['seconds_waiting']}s")
    if s.get("stopped"):
        log(f"\nSTOPPED EARLY: {s['stopped']}\nRun the same command again to resume; finished documents are skipped.")
    log("-" * 78)
    for r in records:
        mark = {"forged": "F", "genuine": "G"}[r["label"]]
        log(f"{mark} {r['id']:44s} {r['status']:8s} {r['verdict']:13s} {', '.join(f['code'].replace('CONTENT_', '') + '/' + f['severity'][0] for f in r['findings'])[:70]}")
    log("Small sample: with 10 documents per side these rates carry wide uncertainty (see the CI).")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", choices=("gemini", "groq"), default=os.environ.get("LLM_PROVIDER", "gemini"),
                    help="which model reads the pages (default: gemini)")
    ap.add_argument("--manifest", default=str(ROOT / "data" / "layer2_testset" / "manifest.json"))
    ap.add_argument("--out", help="results folder (default: data/layer2_run, or data/layer2_run_groq for groq)")
    ap.add_argument("--cooldown", type=float, help=f"seconds between requests (default {PROVIDER_DEFAULTS['gemini']['cooldown']:.0f} gemini, "
                                                    f"{PROVIDER_DEFAULTS['groq']['cooldown']:.0f} groq)")
    ap.add_argument("--doc-gap", type=float, help="extra seconds after each document (default 5 gemini, 3 groq)")
    ap.add_argument("--max-calls", type=int, help="API call budget for this session (default 18 gemini, 150 groq)")
    ap.add_argument("--no-visual", action="store_true")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--reset", action="store_true", help="discard saved results and start over")
    args = ap.parse_args(argv)
    defaults = PROVIDER_DEFAULTS[args.provider]
    for name in ("cooldown", "doc_gap", "max_calls"):
        if getattr(args, name) is None:
            setattr(args, name, defaults[name])
    args.out = args.out or str(ROOT / "data" / defaults["out"])

    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        print(f"{manifest_path} not found. Run scripts/make_layer2_testset.py first.")
        return 2
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    out_dir = Path(args.out)
    options = Options(visual=not args.no_visual, max_pages=defaults["max_pages"])
    if args.reset and (out_dir / "results.jsonl").exists():
        (out_dir / "results.jsonl").rename(out_dir / f"results.{int(time.time())}.bak")

    existing = load_results(out_dir / "results.jsonl")
    todo = [e for e in manifest if (not args.only or e["id"] in args.only) and existing.get(e["id"], {}).get("status") not in ("ok", "partial")]
    worst = sum(worst_case_calls(e, options) for e in todo)
    typical = sum(1 + (1 if options.visual else 0) for e in todo)
    seconds = typical * args.cooldown + len(todo) * args.doc_gap
    model = settings_for(args.provider).model
    print(f"Provider: {args.provider} ({model}); results in {out_dir}; at most {options.max_pages} pages per document.")
    print(f"Plan: {len(todo)} documents to run ({len(manifest) - len(todo)} already done).")
    print(f"  API calls: about {typical}, at most {worst}. This session's budget: {args.max_calls}.")
    print(f"  Cooldown {args.cooldown:.0f}s between requests + {args.doc_gap:.0f}s per document: at least ~{seconds / 60:.0f} minutes.")
    if worst > args.max_calls:
        print(f"  The budget will not cover everything: expect to run this {math.ceil(typical / max(args.max_calls, 1))} times (resumes automatically).")
    if args.dry_run:
        for e in todo:
            print(f"  would run {e['id']}  ({worst_case_calls(e, options)} calls max)")
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)
    client = make_client(args.provider, min_interval_s=args.cooldown, call_log=str(out_dir / "calls.jsonl"))
    try:
        summary = run_session(manifest, manifest_path.parent, out_dir, client, options, args.max_calls, args.doc_gap,
                              only=args.only)
    except KeyboardInterrupt:
        print("\nInterrupted. Finished documents are saved; run again to resume.")
        return 130
    results = load_results(out_dir / "results.jsonl")
    print_summary(summary, [results[e["id"]] for e in manifest if e["id"] in results])
    return 0


if __name__ == "__main__":
    sys.exit(main())
