"""Benchmark several models on the same cases and compare them. Run inside eval-runner (envctl.py wraps it):

    python evals/environment/envctl.py benchmark --mode agent  --dataset individual-single-turn --version 1.0.6 \\
        --models mock/mock-oracle,mock/mock-lazy --judge mock/mock-judge --repeat 3
    python evals/environment/envctl.py benchmark --mode direct --dataset individual-single-turn --version 1.0.6 \\
        --models openai/gpt-4o-mini,gemini/gemini-2.5-flash,anthropic/claude-haiku-4-5 --judge openai/gpt-4o --repeat 5 --setting temperature=0

Two modes:
  agent   the real Individual Insurance agent answers, with only the underlying model changed (tools, permissions, skills, prompts, the
          database and the fixtures are the same for every model). Measures tool accuracy and workflow compliance as well.
  direct  the bare model is given the same question and the same reference information (no agent, no tools). Measures what the model does
          with the material, and how fast and how dearly.

Every model is one full run of the runner (verified, sealed, stored on its own) with the same bundle, cases, repetitions, judge and limits,
tied together by one benchmark id. Models run one after another, never side by side, so one does not slow another's timings. A model
whose provider has no key here is reported as `blocked_missing_credentials`; it is neither skipped silently nor failed. The comparison is
in shared/evaluation/benchmark.py: it names a better model only when the evidence supports it.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import signal
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
import calibrate_judge  # noqa: E402
from shared.evaluation import benchmark as bench  # noqa: E402

RUNS = Path(os.environ.get("EVAL_OUTPUT", "/work/runs"))
JUDGE_URL = os.environ.get("EVAL_JUDGE_URL")
OWNED = ("--model", "--kind", "--group-id", "--mode", "--calibrate")
MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,40}/[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$")
cancelled = False
child: Optional[asyncio.subprocess.Process] = None


def parse(argv: List[str]):
    p = argparse.ArgumentParser(prog="benchmark", description=__doc__.split("\n")[0])
    p.add_argument("--mode", choices=("agent", "direct"), required=True)
    p.add_argument("--models", required=True, help="provider/model,provider/model,... (at least two)")
    p.add_argument("--id", dest="benchmark_id")
    p.add_argument("--judge")
    p.add_argument("--calibrate", action="store_true", help="check the judge on answers of known quality once, and record it with the benchmark")
    args, forward = p.parse_known_args(argv)
    models = [m for m in args.models.split(",") if m]
    if len(models) < 2 or len(set(models)) != len(models) or not all(MODEL.match(m) for m in models):
        p.error("--models needs at least two different provider/model values")
    for flag in OWNED:
        if flag in forward:
            p.error(f"{flag} is set by the benchmark; do not pass it as well")
    if args.calibrate and not args.judge:
        p.error("--calibrate needs --judge")
    if args.judge:
        forward += ["--judge", args.judge]
    return args, models, forward


async def run_model(mode: str, label: str, benchmark_id: str, forward: List[str]) -> Dict[str, Any]:
    global child
    cmd = [sys.executable, "-m", "evals.tools.eval_runner", *forward, "--mode", mode, "--kind", f"benchmark_{mode}", "--group-id", benchmark_id, "--model", label]
    print(f"\n=== {label} ({mode}) ===", flush=True)
    child = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    folder: Optional[str] = None
    assert child.stdout is not None
    async for raw in child.stdout:
        line = raw.decode("utf-8", "replace").rstrip("\n")
        print(line, flush=True)
        m = re.match(r"results: (\S+)", line)
        if m:
            folder = m.group(1)
    code = await child.wait()
    child = None
    return {"label": label, "folder": folder, "exit_code": code}


def load(folder: Optional[str]):
    if not folder:
        return [], {}
    f = Path(folder)
    rows = [json.loads(l) for l in (f / "results.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()] if (f / "results.jsonl").is_file() else []
    summary = json.loads((f / "summary.json").read_text(encoding="utf-8")) if (f / "summary.json").is_file() else {}
    return rows, summary


async def judge_info(judge: Optional[str]) -> Dict[str, Any]:
    if not judge or not JUDGE_URL:
        return {}
    try:
        async with httpx.AsyncClient() as c:
            health = (await c.get(f"{JUDGE_URL}/health", timeout=10)).json()
        return {"deepeval_version": health.get("deepeval")}
    except Exception:                                        # noqa: BLE001 — an unreachable judge is recorded as unknown, not hidden
        return {"deepeval_version": None, "note": "the judge service did not answer /health"}


def _stop(*_: Any) -> None:
    global cancelled
    cancelled = True
    print("cancel requested: the model in progress finishes its case in flight, then the benchmark stops", flush=True)
    if child is not None and child.returncode is None:
        child.send_signal(signal.SIGTERM)


async def main(argv: List[str]) -> int:
    args, models, forward = parse(argv)
    benchmark_id = args.benchmark_id or f"bench-{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:4]}"
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,59}", benchmark_id):
        print("REFUSED: --id may use letters, digits and . _ - (up to 60 characters)", file=sys.stderr)
        return 4
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _stop)
    calibration = None
    if args.calibrate:
        async with httpx.AsyncClient() as c:
            calibration = await calibrate_judge.calibrate(c, url=JUDGE_URL, judge_model=args.judge)
        calibration.pop("rows", None)
        print(calibrate_judge.render({**calibration, "rows": []}))
    runs: List[Dict[str, Any]] = []
    for label in models:
        if cancelled:
            break
        r = await run_model(args.mode, label, benchmark_id, forward)
        if r["folder"] is None:
            if r["exit_code"] == 4:
                print(f"REFUSED while starting {label}; no benchmark can be built", file=sys.stderr)
                return 4
        rows, summary = load(r["folder"])
        runs.append({**r, "rows": rows, "summary": summary})
    if not runs:
        return 4
    result = bench.build_benchmark(benchmark_id=benchmark_id, mode=args.mode, runs=runs, judge_model=args.judge, judge_info=await judge_info(args.judge),
                                   calibration=calibration, created=time.strftime("%Y-%m-%dT%H:%M:%S"))
    if cancelled:
        result["complete"] = False
        result["notes"].append("CANCELLED: the benchmark stopped before every model had run")
    report = bench.render(result)
    (RUNS / "benchmarks").mkdir(parents=True, exist_ok=True)
    (RUNS / "groups").mkdir(parents=True, exist_ok=True)
    result["report"] = report
    (RUNS / "benchmarks" / f"{benchmark_id}.json").write_text(json.dumps(result, indent=1, default=str), encoding="utf-8")
    # the same list of run folders the comparison tool writes, so the runs of a benchmark are stored together
    (RUNS / "groups" / f"{benchmark_id}.json").write_text(json.dumps({"group_id": benchmark_id, "variants": [{"value": r["label"], "run_folder": r["folder"]} for r in runs]}), encoding="utf-8")
    print("\n" + report)
    print(f"benchmark: {benchmark_id}  ({RUNS / 'benchmarks' / (benchmark_id + '.json')})")
    return 0 if result["valid"] else 3


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
