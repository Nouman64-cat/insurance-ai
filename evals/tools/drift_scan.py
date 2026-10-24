"""Scan a golden dataset for drift. Read-only: it reads the cases and the code, writes only its own report, and changes nothing else.

    python -m evals.tools.drift_scan [--bundle DIR | --from-source] [--baseline-run ID --current-run ID] [--stage-list a,b] [--out DIR]

It runs in the evaluation runner (which has the application code and the repository), not in the platform:
  1. re-runs every case's pinned checks (`metadata.truth`) against the code as it is now: a mismatch means the expectation may be stale,
  2. flags unconfirmed, unpinned and long-unreviewed cases,
  3. measures coverage by workflow stage and scenario type, and drafts proposals for what is missing (a proposal has no expected value),
  4. when two runs are named, reports cases whose verdict or tool use changed and run-level movement in pass rate, latency and cost.

The result is `scan.json` in the output folder. A scan finds and proposes; it never edits a case, never writes to the lake and never decides
what is right. The platform stores the findings as review items for a person (shared/evaluation/drift.py states the rules).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from shared.evaluation import drift  # noqa: E402

RUNS = Path(os.environ.get("EVAL_RUNS_DIR", "/work/runs"))


def parse(argv: List[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="drift_scan", description=__doc__.split("\n")[0])
    p.add_argument("--bundle", help="an exported published version (checked against its manifest before use)")
    p.add_argument("--from-source", action="store_true", help="the repository's working files (not a published version)")
    p.add_argument("--baseline-run", help="a run id to compare from")
    p.add_argument("--current-run", help="a run id to compare to")
    p.add_argument("--stage-list", default="", help="comma separated workflow stages that must be covered (default: the workflow's own)")
    p.add_argument("--min-per-stage", type=int, default=drift.MIN_CASES_PER_STAGE)
    p.add_argument("--review-after-days", type=int, default=drift.REVIEW_AFTER_DAYS)
    p.add_argument("--out", default=str(RUNS / "drift"))
    a = p.parse_args(argv)
    if bool(a.bundle) == a.from_source:
        p.error("give exactly one of --bundle or --from-source")
    if bool(a.baseline_run) != bool(a.current_run):
        p.error("--baseline-run and --current-run go together")
    return a


def load_cases(args: argparse.Namespace):
    from shared.evaluation.run_report import load_bundle
    if args.bundle:
        bundle = load_bundle(Path(args.bundle))
        return bundle.cases, bundle.identity
    import casekit
    cases = [casekit.normalise(raw)[0] for _, raw in casekit.sources()]
    return cases, {"dataset": "repository-sources", "version": "working", "verified": False}


def run_pins(cases: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Re-run each case's pinned checks. An oracle that cannot run is reported as such, not as a mismatch."""
    import verify_dataset as vd
    results: Dict[str, List[Dict[str, Any]]] = {}
    for case in cases:
        truth = (case.get("metadata") or {}).get("truth") or []
        if not truth:
            continue
        os.environ["ENV_VAR"] = "demo" if (case.get("metadata") or {}).get("env_mode") == "demo" else "strict"      # the oracles read the same switch the services do
        out = []
        for item in truth:
            entry = {"oracle": item.get("oracle"), "inputs": item.get("inputs", {}), "expect": item.get("expect")}
            try:
                got = vd.run_truth(item)
                entry["got"] = item.get("expect") if vd.matches(got, item.get("expect")) else got                  # a difference inside the tolerance is not drift
            except Exception as exc:                                                                              # noqa: BLE001 - reported, not raised
                entry["error"] = f"{type(exc).__name__}: {exc}"
            out.append(entry)
        results[case["case_id"]] = out
    return results


def read_run(run_id: str) -> List[Dict[str, Any]]:
    path = RUNS / run_id / "results.jsonl"
    if not path.is_file():
        raise SystemExit(f"no results for run {run_id!r} at {path}")
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def preflight() -> Optional[str]:
    """The pinned checks read application source files and import application code. If the whole repository is not readable, every one of them
    would fail, and a flood of 'critical' findings would be noise. Say so once instead."""
    import oracles
    missing = [d for d in ("microservices", "shared", "evals") if not (oracles.REPO / d).is_dir()]
    return f"the repository at {oracles.REPO} is not fully readable (missing: {', '.join(missing)}); run the scan with the whole repository mounted read-only" if missing else None


def scan(args: argparse.Namespace) -> Dict[str, Any]:
    cases, identity = load_cases(args)
    truth = run_pins(cases)
    from shared.evaluation.workflows import get_workflow
    try:
        stages = [s for s in args.stage_list.split(",") if s] or list(dict(get_workflow(cases[0].get("workflow") or "individual-insurance").categories))
    except Exception:                                                                                           # noqa: BLE001 - coverage then uses only the stages the cases name
        stages = [s for s in args.stage_list.split(",") if s]
    findings: List[Dict[str, Any]] = []
    findings += drift.rule_findings(cases, truth)
    findings += drift.stale_findings(cases, review_after_days=args.review_after_days)
    coverage = drift.coverage_findings(cases, min_per_stage=args.min_per_stage, stages=stages)
    findings += coverage
    if args.baseline_run:
        base, cur = read_run(args.baseline_run), read_run(args.current_run)
        context = {"baseline_run": args.baseline_run, "current_run": args.current_run}
        findings += drift.behaviour_findings(base, cur, context=context)
        findings += drift.performance_findings(base, cur, context=context)
    findings = drift.sort_findings(findings)
    proposals = drift.candidate_proposals(cases, coverage)
    checks = sum(len(v) for v in truth.values())
    ok = sum(1 for v in truth.values() for r in v if not r.get("error") and r.get("got") == r.get("expect"))
    return {"scan_id": f"scan-{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:6]}", "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "dataset": identity,
            "compared": {"baseline_run": args.baseline_run, "current_run": args.current_run} if args.baseline_run else None,
            "counts": {"cases": len(cases), "pinned_checks": checks, "pinned_checks_still_true": ok, "cases_with_pins": len(truth)},
            "summary": drift.summarise(findings), "coverage": drift.coverage_matrix(cases), "findings": findings, "proposals": proposals,
            "rules": "A scan only finds and proposes. It changed no case, wrote nothing to the lake and decided nothing."}


def render(report: Dict[str, Any]) -> str:
    lines = [f"Drift scan {report['scan_id']}  dataset {report['dataset'].get('dataset')} {report['dataset'].get('version')}",
             f"  cases {report['counts']['cases']}   pinned checks {report['counts']['pinned_checks']}   still true {report['counts']['pinned_checks_still_true']}",
             f"  findings {report['summary']['total']}   by kind {report['summary']['by_kind']}   by severity {report['summary']['by_severity']}   proposals {len(report['proposals'])}"]
    for f in report["findings"][:25]:
        lines.append(f"  [{f['severity']:8}] {f['kind']:18} {f['summary'][:150]}")
    if len(report["findings"]) > 25:
        lines.append(f"  ... and {len(report['findings']) - 25} more in scan.json")
    lines.append("  Nothing was changed. Findings are for a person to review.")
    return "\n".join(lines)


def main(argv: List[str]) -> int:
    args = parse(argv)
    problem = preflight()
    if problem:
        print(f"REFUSED: {problem}", file=sys.stderr)
        return 4
    report = scan(args)
    out = Path(args.out) / report["scan_id"]
    out.mkdir(parents=True, exist_ok=True)
    (out / "scan.json").write_text(json.dumps(report, indent=1, default=str), encoding="utf-8")
    print(render(report))
    print(f"results: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
