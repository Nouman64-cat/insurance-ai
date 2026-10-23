"""Run the same cases under two or more variants of ONE setting and compare them, paired by case: skills on vs off, prompt version
A vs B, or model A vs model B. Run inside eval-runner (envctl.py wraps it):

    python evals/environment/envctl.py variants --dataset individual-single-turn --version 1.0.6 \\
        --vary skills=on,off --model mock/mock-oracle --judge mock/mock-judge --repeat 3
    python evals/environment/envctl.py variants ... --vary prompt=none,concise-v1,cautious-v1 --model openai/gpt-4o-mini
    python evals/environment/envctl.py variants ... --vary model=mock/mock-oracle,mock/mock-lazy

Every variant is a full run of the runner (so each is verified, sealed and can be stored on its own) with the same bundle, cases,
repetitions and limits, tied together by one --group-id. The first value is the baseline; every other value is compared with it. The
comparison reports the mean change in pass rate with a bootstrap interval, how many cases got better and worse, which cases regressed,
and says plainly when the evidence is too thin to call a difference real (few cases, one repetition).

Inside the container: python -m evals.tools.variants --bundle DIR --vary DIM=a,b[,c] [any eval_runner option]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from shared.evaluation import stats

RUNS = Path(os.environ.get("EVAL_OUTPUT", "/work/runs"))
FLAGS = {"skills": "--skills", "prompt": "--prompt-version", "model": "--model"}


def parse(argv: List[str]):
    p = argparse.ArgumentParser(prog="variants", description=__doc__.split("\n")[0])
    p.add_argument("--vary", required=True, help="skills=on,off | prompt=none,concise-v1 | model=a,b  (the first is the baseline)")
    p.add_argument("--group-id")
    args, forward = p.parse_known_args(argv)
    dim, _, values = args.vary.partition("=")
    vals = [v for v in values.split(",") if v]
    if dim not in FLAGS or len(vals) < 2 or len(set(vals)) != len(vals):
        p.error("--vary needs a setting (skills, prompt or model) and at least two different values, e.g. skills=on,off")
    for flag in (FLAGS[dim], "--group-id", "--kind"):
        if flag in forward:
            p.error(f"{flag} is set by --vary / the group; do not pass it as well")
    if dim == "skills" and not set(vals) <= {"on", "off", "default"}:
        p.error("skills values are on, off or default")
    return dim, vals, args.group_id or f"grp-{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:4]}", forward


async def run_variant(dim: str, value: str, group_id: str, forward: List[str]) -> Dict[str, Any]:
    cmd = [sys.executable, "-m", "evals.tools.eval_runner", *forward, "--group-id", group_id]
    if not (dim == "prompt" and value == "none"):
        cmd += [FLAGS[dim], value]
    print(f"\n=== variant {dim}={value} ===", flush=True)
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    folder: Optional[str] = None
    assert proc.stdout is not None
    async for raw in proc.stdout:
        line = raw.decode("utf-8", "replace").rstrip("\n")
        print(line, flush=True)
        m = re.match(r"results: (\S+)", line)
        if m:
            folder = m.group(1)
    code = await proc.wait()
    return {"value": value, "exit_code": code, "folder": folder}


def load_rows(folder: str) -> List[Dict[str, Any]]:
    path = Path(folder) / "results.jsonl"
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()] if path.is_file() else []


def headline(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    rel = stats.run_reliability(rows)
    return {"executions": rel["executions"], "ran": rel["ran"], "pass_rate": rel["pass_rate"], "ci_low": rel["ci_low"], "ci_high": rel["ci_high"],
            "flaky_cases": rel["flaky_cases"], "critical_failure_rate": rel["critical_failure_rate"], "latency_p50_ms": rel["latency_ms"]["p50"],
            "cost_usd": rel["cost_usd"]["mean"], "unknown_cost_executions": rel["unknown_cost_executions"]}


def compare_variants(dim: str, results: List[Dict[str, Any]]) -> Dict[str, Any]:
    base = results[0]
    comparisons = []
    for other in results[1:]:
        a, b = base["rows"], other["rows"]
        paired = stats.paired_compare(a, b)
        comparisons.append({"baseline": base["value"], "variant": other["value"], "paired": {k: v for k, v in paired.items() if k != "rows"},
                            "changed_cases": [r for r in paired["rows"] if r["diff"] != 0], "regressions": stats.detect_regressions(a, b)})
    return {"dimension": dim, "baseline": base["value"], "variants": [{"value": r["value"], "run_folder": r["folder"], "exit_code": r["exit_code"],
                                                                       **headline(r["rows"])} for r in results], "comparisons": comparisons}


def render(group_id: str, comparison: Dict[str, Any]) -> str:
    out = ["", "=" * 78, f"Comparison {group_id}: {comparison['dimension']}  (baseline: {comparison['baseline']})", "-" * 78]
    for v in comparison["variants"]:
        rate = "n/a" if v["pass_rate"] is None else f"{v['pass_rate'] * 100:5.1f}% ({v['ci_low'] * 100:.0f}-{v['ci_high'] * 100:.0f}%)"
        out.append(f"  {comparison['dimension']}={v['value']:24} pass rate {rate:22} ran {v['ran']:4}  flaky {len(v['flaky_cases']):2}  "
                   f"p50 {v['latency_p50_ms'] if v['latency_p50_ms'] is not None else '-'} ms")
    for c in comparison["comparisons"]:
        p = c["paired"]
        out.append("-" * 78)
        out.append(f"  {c['variant']} vs {c['baseline']}: {p['cases_compared']} case(s) compared, {c['variant']} better on {p['b_better']}, {c['baseline']} better on {p['a_better']}")
        if p["mean_diff"] is not None:
            out.append(f"    mean change in pass rate {p['mean_diff'] * 100:+.1f} points (95% interval {p['diff_ci_low'] * 100:+.1f} to {p['diff_ci_high'] * 100:+.1f})"
                       + (f", sign test p = {p['sign_test_p']:.3f}" if p["sign_test_p"] is not None else ""))
        if p["note"]:
            out.append(f"    note: {p['note']}")
        for r in c["regressions"]:
            out.append(f"    REGRESSION {r['case']}: {r['from']:.2f} -> {r['to']:.2f}" + (" (critical case)" if r["critical"] else "") + f"  [{r['evidence']}]")
    out.append("=" * 78)
    return "\n".join(out)


async def main(argv: List[str]) -> int:
    dim, values, group_id, forward = parse(argv)
    results = []
    for value in values:
        r = await run_variant(dim, value, group_id, forward)
        if r["folder"] is None:
            print(f"variant {dim}={value} did not produce a run (exit {r['exit_code']}); no comparison is possible", file=sys.stderr)
            return 4
        results.append({**r, "rows": load_rows(r["folder"])})
    comparison = compare_variants(dim, results)
    comparison["group_id"] = group_id
    (RUNS / "groups").mkdir(parents=True, exist_ok=True)
    (RUNS / "groups" / f"{group_id}.json").write_text(json.dumps(comparison, indent=1, default=str), encoding="utf-8")
    print(render(group_id, comparison))
    print(f"group: {group_id}  ({RUNS / 'groups' / (group_id + '.json')})")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
