"""The evaluation job worker. Runs on the host (plain Python, no packages): it claims jobs the platform has queued, drives the isolated
evaluation stack, streams progress back as events and finishes the job with the run it produced.

    python evals/environment/envctl.py worker            # claim and run jobs until stopped (Ctrl-C finishes the job in flight first)
    python evals/environment/envctl.py worker --once     # run at most one job, then exit

The platform side is tenant-service (routers/eval_jobs.py): the worker only uses its internal endpoints, with the shared
INTERNAL_API_SECRET from the repository .env (never printed). The evaluation stack itself never talks to the platform: the worker is
the only bridge, and it passes the run folder through the existing ingestion (envctl.ingest_run).

What a job does here
  1. turns the job's config into runner arguments from a fixed list of options (a value that is not a plain token is refused, so a
     config can never smuggle in an option);
  2. exports the published dataset version into the runner (the lake re-checks every checksum);
  3. starts the runner; every `@event {...}` line it prints is forwarded (batched, about once a second), which is the live monitor;
  4. every few seconds it sends a heartbeat; if the platform says the job was cancelled, the runner gets SIGTERM and finishes the case in
     flight, writes what it has and exits;
  5. ingests the run(s) and finishes the job (succeeded, cancelled or failed). A job is `succeeded` when the evaluation RAN, whatever
     it found: failed cases are the result, not a failure of the job.
"""
from __future__ import annotations

import json
import os
import queue
import re
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import envctl  # noqa: E402

SCAN_IMAGE = os.environ.get("EVAL_SCAN_IMAGE", "insurance-ai-eval-backend")
PLATFORM = os.environ.get("EVAL_PLATFORM_URL", "http://localhost:8011").rstrip("/")
TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:=,+-]{0,160}$")
FLAG_VALUES = {                      # config key -> (flag, kind)
    "suite": ("--suite", "value"), "model": ("--model", "value"), "skills": ("--skills", "value"), "prompt_version": ("--prompt-version", "value"),
    "judge": ("--judge", "value"), "repeat": ("--repeat", "value"), "kind": ("--kind", "value"), "retries": ("--retries", "value"),
    "concurrency": ("--concurrency", "value"), "timeout": ("--timeout", "value"), "chat_timeout": ("--chat-timeout", "value"),
    "budget_usd": ("--budget-usd", "value"), "max_latency_ms": ("--max-latency-ms", "value"), "max_tokens": ("--max-tokens", "value"),
    "max_cost_usd": ("--max-cost-usd", "value"), "gate_min_pass_rate": ("--gate-min-pass-rate", "value"),
    "gate_min_repetitions": ("--gate-min-repetitions", "value"),
    "metrics": ("--metrics", "value"),
    "allow_same_judge": ("--allow-same-judge", "flag"), "stop_on_critical": ("--stop-on-critical", "flag"), "gate": ("--gate", "flag"), "strict": ("--strict", "flag"),
}
LIST_VALUES = {"case_ids": "--case", "categories": "--category", "operations": "--operation"}


class ConfigError(Exception):
    pass


def args_from_config(config: Dict[str, Any], job_id: str) -> List[str]:
    """Runner arguments for a job config. Only known keys; every value must be a plain token."""
    out: List[str] = []
    benchmark = str(config.get("kind", "suite")).startswith("benchmark_")
    for key, (flag, kind) in FLAG_VALUES.items():
        if config.get(key) is None or (benchmark and key in ("kind", "model")):         # the benchmark sets the kind and each model itself
            continue
        if kind == "flag":
            if config[key] is True:
                out.append(flag)
            continue
        if key == "skills" and config[key] == "default":
            continue
        value = ",".join(config[key]) if isinstance(config[key], list) else str(config[key])
        if isinstance(config[key], list) and not config[key]:
            continue
        if not TOKEN.match(value):
            raise ConfigError(f"the value of {key} is not a plain token: {value!r}")
        out += [flag, value]
    for key, flag in LIST_VALUES.items():
        values = [str(v) for v in config.get(key) or []]
        if values:
            if not all(TOKEN.match(v) and not v.startswith("-") for v in values):
                raise ConfigError(f"{key} holds a value that is not a plain identifier")
            out += [flag, *values]
    if benchmark:
        models = [str(m) for m in config.get("models") or []]
        if len(models) < 2 or not all(TOKEN.match(m) and not m.startswith("-") for m in models):
            raise ConfigError("a benchmark needs at least two models, each a plain provider/model")
        out += ["--mode", str(config["kind"]).split("_", 1)[1], "--models", ",".join(models)]
        for setting in config.get("settings") or []:
            if not re.fullmatch(r"(temperature|top_p|max_tokens|seed)=-?[0-9]+(\.[0-9]+)?", str(setting)):
                raise ConfigError(f"{setting!r} is not a model setting")
            out += ["--setting", setting]
    out += ["--job-id", job_id]
    return out


def read_secret() -> str:
    secret = os.environ.get("INTERNAL_API_SECRET", "").strip()
    if secret:
        return secret
    env = envctl.ROOT / ".env"
    if env.is_file():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("INTERNAL_API_SECRET="):
                return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit("INTERNAL_API_SECRET is not set (environment or repository .env): the worker cannot reach the platform")


class Platform:
    def __init__(self, secret: str, worker_id: str) -> None:
        self.secret, self.worker_id = secret, worker_id

    def call(self, method: str, path: str, body: Optional[Dict[str, Any]] = None, timeout: float = 20.0) -> Dict[str, Any]:
        data = json.dumps({"worker_id": self.worker_id, **(body or {})}).encode()
        req = urllib.request.Request(f"{PLATFORM}{path}", data=data, method=method, headers={"Content-Type": "application/json", "X-Internal-Secret": self.secret})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"{path}: HTTP {exc.code} {exc.read().decode('utf-8', 'replace')[:200]}") from exc


def run_drift_scan(api: Platform, job: Dict[str, Any]) -> None:
    """A drift scan: the runner re-checks the published dataset against the code as it is now, and the worker hands the report to the platform,
    which turns it into review items. Nothing is run against a model and no case is changed."""
    job_id, config = job["id"], job["config"]
    base = f"/internal/eval/jobs/{job_id}"
    try:
        api.call("POST", f"{base}/events", {"events": [{"kind": "log", "message": "preparing the dataset version for the scan", "data": {}}]})
        name = envctl.prepare_bundle(config["dataset"], config["version"])
        if name is None:
            raise RuntimeError("the dataset version could not be exported from the lake")
        # The scan reads the application code, which the isolated runner deliberately does not have. It runs in a throwaway container with no network,
        # the repository mounted read-only, and only the scan's own output folder writable.
        with tempfile.TemporaryDirectory(prefix="drift-scan-") as tmp:
            copy = subprocess.run(["docker", "cp", f"eval-runner:/work/runs/bundles/{name}", f"{tmp}/bundle"], capture_output=True, text=True)
            if copy.returncode:
                raise RuntimeError("the dataset bundle could not be copied out of the runner")
            os.makedirs(f"{tmp}/out", exist_ok=True)
            os.chmod(f"{tmp}/out", 0o777)
            done = subprocess.run(["docker", "run", "--rm", "--network", "none", "--user", f"{os.getuid()}:{os.getgid()}", "-v", f"{envctl.ROOT}:/work:ro", "-v", f"{tmp}/bundle:/bundle:ro", "-v", f"{tmp}/out:/out",
                                   "-w", "/work", "-e", "PYTHONPATH=/work", "-e", "DISABLE_PGVECTOR=true", SCAN_IMAGE, "python", "-m", "evals.tools.drift_scan", "--bundle", "/bundle", "--out", "/out"],
                                  capture_output=True, text=True, timeout=900)
            found = list(Path(f"{tmp}/out").glob("*/scan.json"))
            if done.returncode or not found:
                raise RuntimeError(("the scan did not complete: " + (done.stderr or done.stdout)[-300:]).strip())
            report = json.loads(found[0].read_text(encoding="utf-8"))
        out = api.call("POST", "/internal/eval/drift/ingest", {"report": report, "job_id": job_id}, timeout=120)
        api.call("POST", f"{base}/events", {"events": [{"kind": "log", "message": "scan stored", "data": out}]})
        api.call("POST", f"{base}/finish", {"state": "succeeded"})
        print(f"worker: drift scan {job_id} succeeded {out}", flush=True)
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as exc:
        api.call("POST", f"{base}/finish", {"state": "failed", "error": str(exc)[:500]})
        print(f"worker: drift scan {job_id} failed: {exc}", file=sys.stderr, flush=True)


def run_job(api: Platform, job: Dict[str, Any], stop: threading.Event) -> None:
    if (job.get("config") or {}).get("kind") == "drift_scan":
        return run_drift_scan(api, job)
    job_id, config = job["id"], job["config"]
    base = f"/internal/eval/jobs/{job_id}"
    events: "queue.Queue[Dict[str, Any]]" = queue.Queue()
    tail: List[str] = []
    folder: Dict[str, Optional[str]] = {"results": None, "group": None, "benchmark": None}
    is_benchmark = str(config.get("kind", "suite")).startswith("benchmark_")

    def post(extra: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        batch = list(extra or [])
        while True:
            try:
                batch.append(events.get_nowait())
            except queue.Empty:
                break
        return api.call("POST", f"{base}/events", {"events": batch[:500]}) if batch else api.call("POST", f"{base}/heartbeat")

    def log(message: str, **data: Any) -> None:
        events.put({"kind": "log", "message": message, "data": data})

    try:
        args = args_from_config(config, job_id)
        is_benchmark = str(config.get("kind", "suite")).startswith("benchmark_")
        module = "evals.tools.benchmark" if is_benchmark else "evals.tools.variants" if config.get("vary") else "evals.tools.eval_runner"
        if config.get("vary"):
            if not TOKEN.match(config["vary"]):
                raise ConfigError("vary is not a plain token")
            args += ["--vary", config["vary"]]
        log("preparing the dataset version: exported from the lake, checksums re-verified")
        post()
        name = envctl.prepare_bundle(config["dataset"], config["version"])
        if name is None:
            api.call("POST", f"{base}/finish", {"state": "failed", "error": "the dataset version could not be exported from the lake"})
            return
        cmd = [*envctl.COMPOSE, "exec", "-T", "eval-runner", "python", "-m", module, "--bundle", f"/work/runs/bundles/{name}", *args]
        proc = subprocess.Popen(cmd, cwd=envctl.ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    except (ConfigError, RuntimeError, OSError) as exc:
        api.call("POST", f"{base}/finish", {"state": "failed", "error": str(exc)[:500]})
        return

    def reader() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.rstrip("\n")
            if line.startswith("@event "):
                try:
                    e = json.loads(line[7:])
                    events.put({"kind": e.get("kind", "log"), "message": e.get("message"), "data": e.get("data") or {}})
                except json.JSONDecodeError:
                    pass
                continue
            tail.append(line)
            del tail[:-60]
            m = re.match(r"results: (\S+)", line)
            if m:
                folder["results"] = m.group(1)
            m = re.match(r"benchmark: (\S+)", line)
            if m:
                folder["benchmark"] = m.group(1)
            m = re.match(r"group: (\S+)", line)
            if m:
                folder["group"] = m.group(1)
    thread = threading.Thread(target=reader, daemon=True)
    thread.start()

    cancelled = False
    last_beat = 0.0
    while proc.poll() is None:
        time.sleep(1.0)
        try:
            answer = post()
            last_beat = time.time()
        except RuntimeError as exc:
            print(f"worker: {exc}", file=sys.stderr)
            answer = {}
        if (answer.get("cancel_requested") or stop.is_set()) and not cancelled:
            cancelled = True
            sent = subprocess.run(["docker", "exec", "eval-runner", "python", "-m", "evals.tools.signal_run", "evals.tools.benchmark", "evals.tools.variants", "evals.tools.eval_runner"],
                                  capture_output=True, text=True)     # the comparison driver first, so it starts no further variant
            if sent.returncode:
                log("the runner could not be signalled (it may have just finished)")
            log("cancel passed to the runner: it finishes the case in flight, then stops")
    thread.join(timeout=10)
    code = proc.returncode
    try:
        post()
    except RuntimeError:
        pass

    run_id = Path(folder["results"]).name if folder["results"] else None
    error = None
    if is_benchmark and code == 3:
        state, error = "failed", ("the benchmark is invalid, so it was not stored: " + " | ".join(tail[-6:]))[:500]
    elif code == 4 or run_id is None and not cancelled:
        state, error = "failed", ("the runner refused to start or produced no run: " + " | ".join(tail[-4:]))[:500]
    elif cancelled:
        state = "cancelled"
    else:
        state = "succeeded"
    if run_id and state != "failed":
        events.put({"kind": "log", "message": "ingesting the run into the platform", "data": {}})
        post()
        envctl.ingest_after(code, True, group=bool(config.get("vary")) or is_benchmark, benchmark=is_benchmark)
    api.call("POST", f"{base}/finish", {"state": state, "run_id": run_id, "error": error})
    print(f"worker: job {job_id} {state}" + (f" (run {run_id})" if run_id else ""), flush=True)


def main(argv: List[str]) -> int:
    once = "--once" in argv
    poll = 5.0
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    api = Platform(read_secret(), f"{socket.gethostname()}-{uuid.uuid4().hex[:6]}")
    print(f"worker {api.worker_id} polling {PLATFORM}", flush=True)
    last_schedule = 0.0
    while not stop.is_set():
        try:
            job = api.call("POST", "/internal/eval/jobs/claim").get("job")
        except (RuntimeError, urllib.error.URLError, OSError) as exc:
            print(f"worker: cannot reach the platform: {exc}", file=sys.stderr)
            job = None
        if job:
            run_job(api, job, stop)
            if once:
                return 0
        elif once:
            print("worker: no queued job")
            return 0
        else:
            if time.time() - last_schedule > 3600:                 # the nightly drift scan: the platform queues one if none ran within a day
                last_schedule = time.time()
                try:
                    api.call("POST", "/internal/eval/drift/schedule")
                except (RuntimeError, urllib.error.URLError, OSError) as exc:
                    print(f"worker: drift schedule: {exc}", file=sys.stderr)
            stop.wait(poll)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
