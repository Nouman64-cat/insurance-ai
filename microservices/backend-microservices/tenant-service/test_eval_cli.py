"""The command line of the evaluation lake against the real database and MinIO: listing runs, reading one, verifying its stored files, its reliability and comparing two runs.
It reads; it changes nothing.

Run: docker compose exec -T tenant-service python test_eval_cli.py
"""
import subprocess
import sys

import asyncio
from sqlmodel import select

import database
from shared.models.evaluation import EvalRun

FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


def cli(*args: str):
    p = subprocess.run([sys.executable, "-B", "-W", "ignore", "eval_lake_cli.py", *args], capture_output=True, text=True, timeout=120)
    return p.returncode, p.stdout, p.stderr


async def two_runs():
    async with database._session_factory() as s:
        rs = (await s.exec(select(EvalRun).where(EvalRun.state == "complete", EvalRun.synthetic_model == False, EvalRun.model_label != None, EvalRun.dataset_slug == "individual-single-turn", EvalRun.executions >= 40)  # noqa: E712
                           .order_by(EvalRun.started_at.desc()).limit(2))).all()
        return [r.run_id for r in rs], [(r.executions, r.passed) for r in rs]


def main() -> int:
    ids, shape = asyncio.run(two_runs())
    check("two real stored runs are on hand", len(ids) == 2)
    if len(ids) < 2:
        return 1
    newer, older = ids
    code, out, _ = cli("runs", "--limit", "500")
    check("runs lists the stored runs with their pass rate and cost", code == 0 and newer in out and "pass" in out and "$" in out, out[:200])
    code, out, _ = cli("run", newer)
    check("run shows one run's summary", code == 0 and newer in out and '"run_id"' in out, out[:200])
    code, out, _ = cli("run", newer, "--report")
    check("run --report prints the stored text report", code == 0 and len(out) > 100, out[:100])
    code, out, _ = cli("run-verify", newer)
    check("run-verify re-reads every stored file and finds them intact", code == 0 and out.startswith("OK") and "result rows" in out, out[:200])
    code, out, _ = cli("run-reliability", newer)
    check("run-reliability prints the pass rate with its interval", code == 0 and "pass rate" in out and "95% interval" in out, out[:200])
    code, out, _ = cli("run-compare", older, newer)
    check("run-compare names both runs and counts the cases that changed", code == 0 and older in out and newer in out and "cases compared" in out and "pass rate" in out, out[:300])
    code, _, err = cli("run-compare", older, older)
    check("comparing a run with itself is refused with a message, not a traceback", code != 0 and "different runs" in err and "Traceback" not in err, err[:200])
    code, _, err = cli("run-verify", "no-such-run")
    check("verifying an unknown run is refused with a message", code != 0 and "No such run" in err and "Traceback" not in err, err[:200])
    print(f"\n{'PASS' if not FAILS else 'FAILED'}: {FAILS} failed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
