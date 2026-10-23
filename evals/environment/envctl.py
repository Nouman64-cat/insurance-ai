"""Control script for the evaluation stack (see README.md in this folder).

    python evals/environment/envctl.py provision        # create eval.env with fresh random secrets (never overwrites)
    python evals/environment/envctl.py up               # build and start the isolated stack and the runner
    python evals/environment/envctl.py status           # what is running, and the guard's verdict
    python evals/environment/envctl.py down [--volumes] # stop; --volumes also deletes the evaluation database
    python evals/environment/envctl.py snapshot|seed|reset|fresh|guard   # inside the runner: see evals/tools/runner.py
    python evals/environment/envctl.py run --dataset SLUG --version X.Y.Z [options]   # the full runner on a published version (evals/tools/eval_runner.py)
    python evals/environment/envctl.py benchmark --mode agent|direct --models a,b[,c] --dataset SLUG --version X [options]   # multi-model benchmark
    python evals/environment/envctl.py variants --dataset SLUG --version X --vary skills=on,off|prompt=none,v1|model=a,b [options]   # paired comparison
    python evals/environment/envctl.py worker [--once]                      # claim and run evaluation jobs queued on the platform
    python evals/environment/envctl.py cases [IDS]      # the older, smaller runner (evals/tools/http_runner.py)
    python evals/environment/envctl.py test-chat        # chat evaluation against the live stack (real agent, scripted model, judge)
    python evals/environment/envctl.py test             # the integration tests (evals/tools/test_environment_integration.py)

It only ever drives `docker compose -p insurance-ai-eval -f docker-compose.eval.yml`: a different project, network and
volume from the application's stack, and it passes `--env-file eval.env` so compose never reads the repository .env.
"""
from __future__ import annotations

import secrets
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPOSE = ["docker", "compose", "-p", "insurance-ai-eval", "-f", str(HERE / "docker-compose.eval.yml"),
           "--env-file", str(HERE / "eval.env")]
ENV_FILE = HERE / "eval.env"
BACKEND = ["eval-postgres", "eval-tenant-service", "eval-api-gateway", "eval-ocr-engine", "eval-mock-llm", "eval-judge", "eval-chat-agent"]


def provision() -> int:
    if ENV_FILE.exists():
        print(f"{ENV_FILE.name} already exists: left as it is")
        return 0
    password = secrets.token_urlsafe(24)
    ENV_FILE.write_text(
        f"POSTGRES_PASSWORD={password}\n"
        f"DATABASE_URL=postgresql+asyncpg://eval_app:{password}@eval-postgres:5432/insurance_eval\n"
        f"JWT_SECRET_KEY={secrets.token_urlsafe(48)}\n"
        f"INTERNAL_API_SECRET={secrets.token_urlsafe(32)}\n"
        f"EVAL_MARKER_TOKEN={secrets.token_urlsafe(24)}\n"       # ties the database marker to this environment
        f"EVAL_USER_PASSWORD={secrets.token_urlsafe(18)}\n"      # the password of every synthetic user
        "# The model-backed OCR cases. A DEDICATED evaluation key (own project, own spending limit), never the production one.\n"
        "# Empty: those cases are reported blocked_missing_credentials. Production's OCR model is OpenAI gpt-4o-mini.\n"
        "OPENAI_API_KEY=\n"
        "OPENAI_FALLBACK_MODEL=gpt-4o-mini\n"
        "# Providers an evaluation may call (a key for any other provider is refused by the guard), and the run's spending cap.\n"
        "EVAL_ALLOWED_PROVIDERS=openai\n"
        "EVAL_BUDGET_USD=1.00\n")
    ENV_FILE.chmod(0o600)
    print(f"wrote {ENV_FILE.name} (mode 600, fresh random secrets, not printed)")
    return 0


# Eval image name <- the image the application's stack already built. Same dependencies, same layers; the code is mounted.
# Tagging adds a new name only: the production tags are never moved. If the source image is missing, compose builds it.
IMAGES = {"insurance-ai-eval-backend": "insurance-ai-tenant-service", "insurance-ai-eval-gateway": "insurance-ai-api-gateway",
          "insurance-ai-eval-ocr": "insurance-ai-ocr-engine", "insurance-ai-eval-chat": "insurance-ai-chat-agent"}


def ensure_images() -> None:
    for eval_name, source in IMAGES.items():
        have = subprocess.run(["docker", "image", "inspect", eval_name], capture_output=True).returncode == 0
        src = subprocess.run(["docker", "image", "inspect", source], capture_output=True).returncode == 0
        if not have and src:
            subprocess.run(["docker", "tag", source, eval_name], check=True)
            print(f"tagged {source} as {eval_name}")


def compose(*args: str, check: bool = False) -> int:
    if not ENV_FILE.exists():
        print("no eval.env: run `provision` first", file=sys.stderr)
        return 2
    # The exit status is the answer (a failing case is exit 1, a case that could not run is 2): pass it on, no traceback.
    return subprocess.run([*COMPOSE, *args], check=check).returncode


ROOT = HERE.parents[1]


def prepare_bundle(dataset: str, version: str) -> "str | None":
    """Export a published Gold version from the lake (which re-checks every checksum) into the runner container. Returns the bundle's name
    under /work/runs/bundles, or None if a step failed."""
    import tempfile
    name = f"{dataset}-{version}"
    sh = lambda *cmd: subprocess.run(list(cmd), cwd=ROOT).returncode
    with tempfile.TemporaryDirectory() as tmp:
        steps = [
            ("export from the lake", ["docker", "compose", "exec", "-T", "tenant-service", "sh", "-c",
                                      f"rm -rf /tmp/bundle && python eval_lake_cli.py bundle {dataset} {version} --out /tmp/bundle"]),
            ("copy out", ["docker", "compose", "cp", "tenant-service:/tmp/bundle", f"{tmp}/bundle"]),
            ("clear old copy", ["docker", "exec", "eval-runner", "sh", "-c", f"mkdir -p /work/runs/bundles && rm -rf /work/runs/bundles/{name}"]),
            ("copy in", ["docker", "cp", f"{tmp}/bundle", f"eval-runner:/work/runs/bundles/{name}"]),
        ]
        for label, cmd in steps:
            if sh(*cmd):
                print(f"run: step failed: {label}", file=sys.stderr)
                return None
    return name


def run_cases(rest: list[str], module: str = "evals.tools.eval_runner") -> int:
    """`run --dataset SLUG --version X [runner options]`: export the published version from MinIO (the lake re-checks every checksum),
    hand it to the runner container, and run. `run --from-source [options]` runs the repository files instead (not verified)."""
    import tempfile
    runner = ["exec", "-T", "eval-runner", "python", "-m", module]
    ingest = "--no-ingest" not in rest
    rest = [a for a in rest if a != "--no-ingest"]
    if "--from-source" in rest:
        return ingest_after(compose(*runner, *rest), ingest, group=module.endswith(("variants", "benchmark")), benchmark=module.endswith("benchmark"))
    opts: dict[str, str] = {}
    passthrough, i = [], 0
    while i < len(rest):
        if rest[i] in ("--dataset", "--version") and i + 1 < len(rest):
            opts[rest[i]] = rest[i + 1]
            i += 2
        else:
            passthrough.append(rest[i])
            i += 1
    if "--dataset" not in opts or "--version" not in opts:
        print("usage: envctl.py run --dataset SLUG --version X.Y.Z [options]  |  run --from-source [options]", file=sys.stderr)
        return 2
    name = prepare_bundle(opts["--dataset"], opts["--version"])
    if name is None:
        return 2
    return ingest_after(compose(*runner, "--bundle", f"/work/runs/bundles/{name}", *passthrough), ingest, group=module.endswith(("variants", "benchmark")), benchmark=module.endswith("benchmark"))


def group_run_ids() -> list[str]:
    """The run ids of the newest comparison group (written by evals.tools.variants)."""
    import json
    newest = subprocess.run(["docker", "exec", "eval-runner", "sh", "-c", "ls -t /work/runs/groups/*.json 2>/dev/null | head -1"], capture_output=True, text=True).stdout.strip()
    if not newest:
        return []
    text = subprocess.run(["docker", "exec", "eval-runner", "cat", newest], capture_output=True, text=True).stdout
    return [Path(v["run_folder"]).name for v in json.loads(text).get("variants", []) if v.get("run_folder")]


def ingest_benchmark(status: int) -> int:
    """Store the newest benchmark's comparison (after its runs, which it refers to)."""
    import tempfile
    newest = subprocess.run(["docker", "exec", "eval-runner", "sh", "-c", "ls -t /work/runs/benchmarks/*.json 2>/dev/null | head -1"], capture_output=True, text=True).stdout.strip()
    if not newest:
        return status
    with tempfile.TemporaryDirectory() as tmp:
        steps = [["docker", "cp", f"eval-runner:{newest}", f"{tmp}/benchmark.json"],
                 ["docker", "compose", "cp", f"{tmp}/benchmark.json", "tenant-service:/tmp/benchmark.json"],
                 ["docker", "compose", "exec", "-T", "tenant-service", "python", "eval_lake_cli.py", "benchmark-ingest", "/tmp/benchmark.json"]]
        for cmd in steps:
            if subprocess.run(cmd, cwd=ROOT).returncode:
                print(f"ingest: step failed: {' '.join(cmd[:4])}", file=sys.stderr)
                return status
    return status


def ingest_after(status: int, ingest: bool, group: bool = False, benchmark: bool = False) -> int:
    """Keep the run just finished on the platform side (database + MinIO). The isolated worker never sees the platform: the run
    folder is copied out of it and into tenant-service, which ingests it (re-checking every checksum the worker pinned).
    A failed ingestion is reported but does not change the run's own exit status; the folder stays in the worker's runs/ folder."""
    import tempfile
    if not ingest or status in (4,):                       # 4: the runner refused to start, there is no run
        return status
    if group:
        for run_id in group_run_ids():
            status = ingest_run(run_id, status)
        return ingest_benchmark(status) if benchmark else status
    found = subprocess.run(["docker", "exec", "eval-runner", "sh", "-c", "ls -t /work/runs | grep -E '^[0-9]{8}T' | head -1"], capture_output=True, text=True)
    run_id = found.stdout.strip()
    if not run_id:
        print("ingest: no run folder found", file=sys.stderr)
        return status
    return ingest_run(run_id, status)


def ingest_run(run_id: str, status: int) -> int:
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        steps = [["docker", "cp", f"eval-runner:/work/runs/{run_id}", f"{tmp}/{run_id}"],
                 ["docker", "compose", "exec", "-T", "tenant-service", "rm", "-rf", f"/tmp/runs/{run_id}"],
                 ["docker", "compose", "exec", "-T", "tenant-service", "mkdir", "-p", "/tmp/runs"],
                 ["docker", "compose", "cp", f"{tmp}/{run_id}", f"tenant-service:/tmp/runs/{run_id}"],
                 ["docker", "compose", "exec", "-T", "tenant-service", "python", "eval_lake_cli.py", "run-ingest", f"/tmp/runs/{run_id}"]]
        for cmd in steps:
            if subprocess.run(cmd, cwd=ROOT, stdout=subprocess.DEVNULL if cmd[-2:-1] != ["run-ingest"] and "run-ingest" not in cmd else None).returncode:
                print(f"ingest: step failed: {' '.join(cmd[:4])}", file=sys.stderr)
                return status
    return status


def main(argv: list[str]) -> int:
    cmd, rest = (argv[0] if argv else "status"), argv[1:]
    if cmd == "provision":
        return provision()
    if cmd == "up":
        ensure_images()
        rc = compose("up", "-d", *BACKEND)
        return rc or compose("--profile", "runner", "up", "-d", "eval-runner")
    if cmd == "down":
        return compose("--profile", "runner", "down", *(["--volumes"] if "--volumes" in rest else []))
    if cmd == "status":
        return compose("--profile", "runner", "ps", check=False)
    if cmd == "test":
        return compose("exec", "-T", "eval-runner", "python", "-m", "evals.tools.test_environment_integration", *rest)
    if cmd == "test-runs":
        return compose("exec", "-T", "eval-runner", "python", "-m", "evals.tools.test_runs_integration", *rest)
    if cmd == "test-chat":
        return compose("exec", "-T", "eval-runner", "python", "-m", "evals.tools.test_chat_integration", *rest)
    if cmd == "test-runner":
        return compose("exec", "-T", "eval-runner", "python", "-m", "evals.tools.test_runner_integration", *rest)
    if cmd == "run":
        return run_cases(rest)
    if cmd == "worker":
        import job_worker
        return job_worker.main(rest)
    if cmd == "benchmark":
        return run_cases(rest, module="evals.tools.benchmark")
    if cmd == "variants":
        return run_cases(rest, module="evals.tools.variants")
    if cmd == "calibrate":                                  # calibrate --judge provider/model
        return compose("exec", "-T", "eval-runner", "python", "-m", "evals.tools.calibrate_judge", *rest)
    if cmd == "cases":
        return compose("exec", "-T", "eval-runner", "python", "-m", "evals.tools.http_runner", *rest)
    if cmd in ("seed", "reset", "snapshot", "fresh", "guard"):
        return compose("exec", "-T", "eval-runner", "python", "-m", "evals.tools.runner", cmd, *rest)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
