"""A run that cannot be stored must never be reported as stored. Pure test: the subprocess calls are replaced, nothing is run.

    docker run --rm -i --network none -v "$PWD":/work:ro -w /work -e PYTHONPATH=/work insurance-ai-eval-backend python -B evals/tools/test_ingest_failure.py"""
import subprocess
import sys
from types import SimpleNamespace

sys.path.insert(0, "evals/environment")
import envctl  # noqa: E402

FAILS = 0


def check(name, ok, detail=""):
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


def fake(results):
    calls = []

    def run(cmd, **kw):
        calls.append(cmd)
        rc, out, err = results(cmd)
        return SimpleNamespace(returncode=rc, stdout=out, stderr=err)
    return run, calls


real = subprocess.run
try:
    # 1. the database refuses the insert: the cause (its last lines) is recorded and the later steps are not run
    envctl.INGEST_FAILURES.clear()
    run, calls = fake(lambda c: (1, "", "Traceback\nvalue too long for type character varying(20)") if "run-ingest" in c else (0, "", ""))
    envctl.subprocess.run = run
    envctl.ingest_run("20260101T000000-abcdef", 0)
    check("a failed run-ingest step is recorded with its real error message", len(envctl.INGEST_FAILURES) == 1 and "varying(20)" in envctl.INGEST_FAILURES[0] and "20260101T000000-abcdef" in envctl.INGEST_FAILURES[0], envctl.INGEST_FAILURES)
    # 2. the first failing step stops the rest
    envctl.INGEST_FAILURES.clear()
    run, calls = fake(lambda c: (1, "", "no such container") if c[:2] == ["docker", "cp"] else (0, "", ""))
    envctl.subprocess.run = run
    envctl.ingest_run("r1", 0)
    check("a failing first step stops the remaining steps, and says which run", len(calls) == 1 and envctl.INGEST_FAILURES and "r1" in envctl.INGEST_FAILURES[0] and "no such container" in envctl.INGEST_FAILURES[0], [calls, envctl.INGEST_FAILURES])
    # 3. a clean ingest records nothing
    envctl.INGEST_FAILURES.clear()
    run, calls = fake(lambda c: (0, "stored: run r2", ""))
    envctl.subprocess.run = run
    envctl.ingest_run("r2", 0)
    check("a clean ingest records no failure and runs all five steps", not envctl.INGEST_FAILURES and len(calls) == 5, [len(calls), envctl.INGEST_FAILURES])
    # 4. the exit status of the run itself is unchanged (a failed ingest is reported through INGEST_FAILURES, which the worker turns into a failed job)
    envctl.INGEST_FAILURES.clear()
    run, calls = fake(lambda c: (1, "", "boom") if "run-ingest" in c else (0, "", ""))
    envctl.subprocess.run = run
    check("ingest_run still returns the run's own status; the failure is in INGEST_FAILURES for the worker to act on", envctl.ingest_run("r3", 0) == 0 and bool(envctl.INGEST_FAILURES))
finally:
    envctl.subprocess.run = real
src = open("evals/environment/job_worker.py", encoding="utf-8").read()
check("the worker marks the job failed (with the cause and the retry command) when anything was not stored", "envctl.INGEST_FAILURES" in src and 'state, error = "failed"' in src and "ingest-group" in src)
print("PASS: all ingest-failure tests, 0 failed" if not FAILS else f"FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
