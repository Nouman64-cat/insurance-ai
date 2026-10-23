"""The evaluation runner. Run inside eval-runner (envctl.py wraps it):

    python evals/environment/envctl.py run --dataset individual-single-turn --version 1.0.6                 # published Gold version from MinIO
    python evals/environment/envctl.py run --dataset ... --version ... --case IND-SEC-007 IND-CUST-001      # single cases
    python evals/environment/envctl.py run --dataset ... --version ... --category security-rbac              # a module
    python evals/environment/envctl.py run --dataset ... --version ... --model mock/mock-oracle --judge mock/mock-judge --repeat 3
    python evals/environment/envctl.py run --dataset ... --version ... --model mock/mock-oracle --skills off --prompt-version concise-v1
    python evals/environment/envctl.py run --from-source                                                     # repository files (dev only: not verified)

Inside the container: python -m evals.tools.eval_runner --bundle <dir> [selection] [what is tested] [how] [limits]
  selection      --suite technical|business  --case ID...  --category C...  --operation OP...
  what is tested --model provider/model (chat cases need one; mock/mock-oracle|mock-lazy|mock-reckless are SYNTHETIC stand-ins)
                 --skills on|off  --prompt-version V  --judge provider/model  --allow-same-judge
  how            --repeat N|auto  --concurrency N  --timeout S  --chat-timeout S  --retries N  --reset per-case|per-writer
  limits         --budget-usd X  --max-latency-ms N  --max-tokens N  --max-cost-usd X  --stop-on-critical  --gate  --strict

What it does, in order
  1. the bundle (an export of an immutable Gold version, made by `eval_lake_cli.py bundle`, which reads MinIO and re-checks every
     checksum) is verified AGAIN here against its manifest: the snapshot, every case, every fixture, the dataset fingerprint (L1);
  2. the cases are selected and each is classified: runnable, blocked (a prerequisite is missing), or skipped (not run on purpose);
  3. per repetition, every runnable case starts from a freshly reset and re-seeded database and runs against the real application.
     Pure-function cases run concurrently; cases that use the stack run one at a time, because they share one database. A chat
     case drives a real conversation with the chat agent (shared/evaluation/chat_executor.py);
  4. each execution is judged in six layers (shared/evaluation/layers.py): inputs, output quality (the judge, DeepEval), agent
     trajectory, workflow and state, security and business rules, performance and cost. A failed critical assertion fails the case
     whatever the scores say;
  5. every execution is appended to <run>/results.jsonl as it finishes, with its full assertion results and (for chat) its transcript
     in <run>/artifacts/, and a progress event goes to <run>/events.jsonl and to stdout (`@event {...}`), which is what the live
     monitor streams. Reliability statistics, the quality gate, a summary and the console report are written at the end.
SIGINT/SIGTERM finish the case in flight, stop, write what exists and report the run as cancelled.

An infrastructure error (timeout, connection, the agent erroring before it answered) is retried up to --retries times; a verdict
(passed or failed) is never retried: a case that fails then passes would be hiding a flaky answer, which is what repetitions measure.

Exit status: 0 clean; 1 a case failed or the gate failed; 2 infrastructure errors; 3 (--strict) something was blocked or nothing ran.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
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

from shared.evaluation import judge as judge_lib
from shared.evaluation import layers as layers_lib
from shared.evaluation import stats
from shared.evaluation.assertions import evaluate_case
from shared.evaluation.chat_executor import ChatExecutionError, ChatRuntime, ChatTarget, execute_chat_case, resolve_case, wrong_models
from shared.evaluation.operations import OPERATIONS, MissingCredentials, OperationError, RunContext, execute
from shared.evaluation.runs import seal_folder
from shared.evaluation.run_report import (Bundle, BundleError, CaseResult, classify, cost_from_usage, exit_code, is_chat, load_bundle, needs_model,
                                          operation_of, render_report, select_cases, summarise, verification_of)
from shared.evaluation.safety import EvaluationGuardError, assert_evaluation_process, assert_provider_policy
from shared.evaluation.usage import UsageMeter

sys.path.insert(0, str(Path(__file__).resolve().parent))
import calibrate_judge  # noqa: E402
import casekit  # noqa: E402
import http_runner  # noqa: E402
from http_runner import API, GATEWAY, OCR, OUTPUT, Environment  # noqa: E402

WRITERS = http_runner.WRITERS
CHAT_URL = os.environ.get("EVAL_CHAT_URL", "http://eval-chat-agent:8006")
MOCK_URL = os.environ.get("EVAL_MOCK_LLM_URL")
JUDGE_URL = os.environ.get("EVAL_JUDGE_URL")
MODEL_CASE_ESTIMATE_USD = float(os.environ.get("EVAL_COST_ESTIMATE_PER_MODEL_CASE", "0.01"))   # held back before a model-backed case starts
CHAT_TURN_ESTIMATE_USD = float(os.environ.get("EVAL_COST_ESTIMATE_PER_CHAT_TURN", "0.01"))
JUDGE_CRITERION_ESTIMATE_USD = float(os.environ.get("EVAL_COST_ESTIMATE_PER_JUDGE_CRITERION", "0.002"))


def bundle_from_source() -> Bundle:
    """The repository's authoring files as a bundle. NOT verified against a published version: for development only."""
    cases = [casekit.normalise(raw)[0] for _, raw in casekit.sources()]
    files = {p.name: p.read_bytes() for p in casekit.FIXTURES.iterdir() if p.is_file() and p.name != "manifest.json"}
    return Bundle(path=casekit.FIXTURES.parent, manifest={"dataset": {"slug": "repository-sources"}, "version": "working", "files": []},
                  cases=cases, fixtures=files, verified=False)


def provider_of(model: Optional[str]) -> Optional[str]:
    return model.split("/", 1)[0].lower() if model and "/" in model else None


class Runner:
    def __init__(self, bundle: Bundle, args: argparse.Namespace) -> None:
        self.bundle, self.args = bundle, args
        # A random suffix: two runs started in the same second must never share (and mix) a results folder.
        self.run_id = f"{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:6]}"
        self.out = OUTPUT / self.run_id
        (self.out / "artifacts").mkdir(parents=True, exist_ok=False)
        self.cancel = asyncio.Event()
        self.stop_reason: Optional[str] = None
        self.results: List[CaseResult] = []
        self.spent_usd = 0.0
        self.providers = assert_provider_policy()                      # allowed AND keyed; may be empty
        self.json_fixtures = {k: json.loads(v) for k, v in bundle.fixtures.items() if k.endswith(".json")}
        self.registered = {name: op.mode for name, op in OPERATIONS.items()}
        self.env: Optional[Environment] = None
        self.client: Optional[httpx.AsyncClient] = None
        self.meter: Optional[UsageMeter] = None
        self.tokens: Dict[str, str] = {}
        self.target: Optional[ChatTarget] = None
        if args.model:
            self.target = ChatTarget(model=args.model, skills=None if args.skills == "default" else args.skills == "on", prompt_version=args.prompt_version)
        self.limits = {"max_latency_ms": args.max_latency_ms, "max_tokens": args.max_tokens, "max_cost_usd": args.max_cost_usd}
        self.events = (self.out / "events.jsonl").open("a", encoding="utf-8")
        self._seq = 0
        self.print_events = False                      # the command line turns this on: the job worker reads these lines from stdout

    # ── events: what the live monitor shows ─────────────────────────────────────────────────────────────────────────

    def event(self, kind: str, message: str = "", **data: Any) -> None:
        self._seq += 1
        line = {"seq": self._seq, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "kind": kind, "message": message, "data": data}
        text = json.dumps(line, default=str)
        self.events.write(text + "\n")
        self.events.flush()
        if self.print_events:
            print("@event " + text, flush=True)

    def progress(self) -> Dict[str, Any]:
        by: Dict[str, int] = {}
        for r in self.results:
            by[r.status] = by.get(r.status, 0) + 1
        return {"executions": len(self.results), "by_status": by, "spent_usd": round(self.spent_usd, 6)}

    @property
    def chat_state(self) -> str:
        """Whether chat cases can run: a model was chosen, and it is either scripted or its provider has a key."""
        if self.target is None:
            return "unavailable"
        if self.target.synthetic:
            return "ready" if MOCK_URL else "unavailable"
        return "ready" if self.target.provider in self.providers else "missing_credentials"

    def classify(self, case: dict) -> Optional[Dict[str, str]]:
        return classify(case, registered=self.registered, files=self.bundle.fixtures, providers_ready=bool(self.providers), chat=self.chat_state)

    # ── one execution ───────────────────────────────────────────────────────────────────────────────────────────────

    def _make(self, case: dict, repetition: int, status: str, reason: Optional[str] = None, **extra: Any) -> CaseResult:
        return CaseResult(case_id=case["case_id"], category=case.get("category"), operation=operation_of(case) or ("chat" if is_chat(case) else None),
                          verification=verification_of(case), status=status, reason=reason, repetition=repetition, severity=case.get("severity"),
                          synthetic_model=bool(self.target and self.target.synthetic and is_chat(case)), **extra)

    def _record(self, result: CaseResult) -> CaseResult:
        self.results.append(result)
        with (self.out / "results.jsonl").open("a", encoding="utf-8") as f:           # appended now, not at the end: a cancel or a crash loses nothing
            f.write(json.dumps(result.as_dict(), default=str) + "\n")
        self.event("case", f"{result.case_id} r{result.repetition}: {result.status}" + (f" ({result.reason})" if result.reason else ""),
                   case_id=result.case_id, repetition=result.repetition, status=result.status, reason=result.reason, latency_ms=result.latency_ms,
                   cost_usd=result.cost_usd, critical_failed=result.critical_failed, attempts=result.attempts)
        self.event("progress", **self.progress())
        reason = stats.should_stop_on_critical([r.as_dict() for r in self.results], enabled=self.args.stop_on_critical)
        if reason and not self.cancel.is_set():
            self.stop_reason = reason
            self.event("log", f"stopping: {reason}")
            self.cancel.set()
        return result

    async def _login(self, user_ref: str) -> str:
        if user_ref not in self.tokens:
            r = await self.client.post(f"{API}/auth/token", data={"username": f"{user_ref}@eval.invalid", "password": os.environ["EVAL_USER_PASSWORD"]})
            if r.status_code != 200:
                raise OperationError(f"could not log in as {user_ref}: {r.status_code}")
            self.tokens[user_ref] = r.json()["access_token"]
        return self.tokens[user_ref]

    def _artifact(self, case: dict, repetition: int, observation: dict, outcome: Any, verdict: Optional[dict] = None, layers: Optional[dict] = None,
                  metrics: Optional[list] = None) -> str:
        name = re.sub(r"[^A-Za-z0-9._-]", "_", f"{case['case_id']}-r{repetition}.json")
        slim = {k: v for k, v in observation.items() if k != "transcript"}        # the transcript has its own file
        (self.out / "artifacts" / name).write_text(json.dumps({"case_id": case["case_id"], "repetition": repetition, "observation": slim,
                                                               "assertions": outcome.as_dict() if outcome else None, "layers": layers, "verdict": verdict,
                                                               "metric_scores": metrics}, default=str, indent=1), encoding="utf-8")
        return f"artifacts/{name}"

    def _trace_artifact(self, case: dict, repetition: int, observation: dict) -> Optional[str]:
        transcript = observation.get("transcript")
        if not transcript:
            return None
        name = re.sub(r"[^A-Za-z0-9._-]", "_", f"{case['case_id']}-r{repetition}.trace.json")
        (self.out / "artifacts" / name).write_text(json.dumps({"case_id": case["case_id"], "repetition": repetition, **transcript}, default=str, indent=1), encoding="utf-8")
        return f"artifacts/{name}"

    def repetitions(self, case: dict) -> int:
        if self.args.repeat != "auto":
            return int(self.args.repeat)
        chat_or_model = is_chat(case) or needs_model(case, self.bundle.fixtures)
        return stats.repetitions_for(stats.case_class_of(case, model_backed=chat_or_model), kind=self.args.kind)

    async def execute_one(self, case: dict, repetition: int) -> CaseResult:
        """One execution with retries on infrastructure errors only. The verdict of a case that ran is final."""
        pre = self.classify(case)
        if pre:
            return self._record(self._make(case, repetition, pre["status"], pre["reason"]))
        problems = layers_lib.check_inputs(case, self.bundle.fixtures)                     # L1, before anything runs
        if problems:
            return self._record(self._make(case, repetition, "blocked", "invalid_input", error="; ".join(problems)[:500]))
        self.event("log", f"{case['case_id']} r{repetition}: starting")
        attempt = 0
        while True:
            attempt += 1
            result = await self._execute_once(case, repetition)
            if result.status == "infrastructure_error" and attempt <= self.args.retries and not self.cancel.is_set():
                self.event("log", f"{case['case_id']} r{repetition}: infrastructure error ({result.reason}); retrying ({attempt}/{self.args.retries})")
                await asyncio.sleep(min(2.0 * attempt, 10.0))
                continue
            result.attempts = attempt
            return self._record(result)

    async def _execute_once(self, case: dict, repetition: int) -> CaseResult:
        chat = is_chat(case)
        uses_model = chat or needs_model(case, self.bundle.fixtures)
        budget = self.args.budget_usd
        if uses_model:
            turns = max(1, len([m for m in (case.get("input") or {}).get("messages", []) if m.get("role") == "user"]))
            estimate = 0.0 if (chat and self.target and self.target.synthetic) else (CHAT_TURN_ESTIMATE_USD * turns if chat else MODEL_CASE_ESTIMATE_USD)
            estimate += JUDGE_CRITERION_ESTIMATE_USD * len(case.get("semantic_criteria", [])) if (chat and self.args.judge and not self.args.judge.startswith("mock/")) else 0.0
            if not stats.can_afford(self.spent_usd, estimate, budget):
                return self._make(case, repetition, "blocked", "budget_exceeded")
        op = operation_of(case)
        mode = "chat" if chat else self.registered[op]
        started = time.monotonic()
        observation: Dict[str, Any] = {}
        resolved = case
        try:
            async def work() -> Dict[str, Any]:
                nonlocal resolved
                if mode == "function":
                    return await execute(case, RunContext(fixtures=self.json_fixtures, execution_id=f"{self.run_id}/r{repetition}/{case['case_id']}"))
                if chat or self.args.reset == "per-case" or (self.args.reset == "per-writer" and op in WRITERS):
                    await self.env.fresh()
                if chat:
                    resolved = resolve_case(case, self.env.ids)
                    rt = ChatRuntime(client=self.client, chat_url=CHAT_URL, mock_url=MOCK_URL, api_url=API, env=self.env, login=self._login, target=self.target,
                                     meter=self.meter, timeout=float(self.args.chat_timeout))
                    return await execute_chat_case(resolved, rt, execution_id=f"{self.run_id}/r{repetition}/{case['case_id']}")
                actor = case["input"].get("actor") or {}
                token = await self._login(actor["user_ref"])
                tenant = self.env.ids["tenant"].get(actor.get("tenant_ref") or "")
                headers = {"Authorization": f"Bearer {token}", **({"X-Tenant-Id": tenant} if tenant else {})}
                ctx = RunContext(http=self.client, base_url=API, gateway_url=GATEWAY, ocr_url=OCR, tenant_id=tenant, headers=headers,
                                 tenant_ids=self.env.ids["tenant"], ids={"policies": self.env.ids.get("policy", {}), "quotes": self.env.ids.get("quote", {})},
                                 files=self.bundle.fixtures, usage_meter=self.meter if uses_model or op == "ocr.extract_customer" else None,
                                 execution_id=f"{self.run_id}/r{repetition}/{case['case_id']}")
                return await execute(case, ctx)
            limit = float(self.args.chat_timeout if chat else self.args.timeout)
            observation = await asyncio.wait_for(work(), timeout=limit)
        except MissingCredentials as exc:
            return self._make(case, repetition, "blocked", "blocked_missing_credentials", error=str(exc))
        except asyncio.TimeoutError:
            return self._make(case, repetition, "infrastructure_error", "timeout", error=f"no answer within {limit}s", latency_ms=int((time.monotonic() - started) * 1000))
        except (ChatExecutionError, OperationError, httpx.HTTPError, OSError) as exc:
            return self._make(case, repetition, "infrastructure_error", type(exc).__name__, error=str(exc), latency_ms=int((time.monotonic() - started) * 1000))
        latency = int((time.monotonic() - started) * 1000)

        # A conversation that ended in an error before the agent said or did anything says nothing about the agent: the provider, the
        # network or the stack broke. Judging it would be a verdict on nothing.
        if chat and observation.get("agent_error") and not observation["trace"]["executed_tools"] and not observation["response"]["text"]:
            return self._make(case, repetition, "infrastructure_error", "agent_error", error=str(observation["agent_error"])[:300], latency_ms=latency,
                              trace_artifact=self._trace_artifact(case, repetition, observation))

        if chat and self.target:
            wrong = wrong_models(self.target.model, ((observation.get("usage") or {}).get("by_model")) or {})
            if wrong:
                return self._make(case, repetition, "infrastructure_error", "wrong_model_answered", latency_ms=latency, usage=observation.get("usage"),
                                  error=f"the run asked for {self.target.model} but the token ledger shows {', '.join(wrong)}",
                                  trace_artifact=self._trace_artifact(case, repetition, observation))
        outcome = evaluate_case(resolved, observation)
        assertion_dicts = [r.as_dict() for r in outcome.results]
        usage = observation.get("usage")
        cost, known = cost_from_usage(usage, uses_model)
        if cost:
            self.spent_usd += cost

        metrics: List[Dict[str, Any]] = []
        judge_cost: Optional[float] = None
        wants_judge = chat and bool(resolved.get("semantic_criteria")) and any(l.get("layer") == "L2" and l.get("enabled", True) for l in (resolved.get("evaluation") or {}).get("layers", []))
        if wants_judge and self.args.judge:
            scored = await judge_lib.score_case(self.client, url=JUDGE_URL, judge_model=self.args.judge, case=resolved, observation=observation)
            metrics, judge_cost = scored["metrics"], scored["cost_usd"]
            if judge_cost:
                self.spent_usd += judge_cost
        elif wants_judge:
            metrics = []                                                                   # no judge chosen: the layer reports not_scored

        tokens = {"total_tokens": (usage.get("input_tokens") or 0) + (usage.get("output_tokens") or 0)} if usage and usage.get("status") == "attributed" else {}
        measured = {"latency_ms": latency, "cost_usd": cost if known else None, **tokens, "ttft_ms": observation.get("ttft_ms")}
        layers = layers_lib.score_layers(resolved, assertion_dicts, inputs_ok=True, metrics=metrics, judge_expected=wants_judge,
                                         measured=measured, limits=self.limits)
        verdict = layers_lib.combine(resolved, layers, assertion_dicts)
        counts: Dict[str, int] = {}
        for r in outcome.results:
            counts[r.status] = counts.get(r.status, 0) + 1
        trace = observation.get("trace") or {}
        trace_summary = {"executed_tools": trace.get("executed_tools"), "proposed_tools": trace.get("proposed_tools"), "specialist": (observation.get("routing") or {}).get("specialist"),
                         "skills": (observation.get("routing") or {}).get("skills"), "interrupt": (trace.get("interrupt") or {}).get("kind")} if chat else {}
        by_model = (usage or {}).get("by_model") or {}
        model_id = self.target.model if chat and self.target else (next(iter(by_model)) if len(by_model) == 1 else None)
        return self._make(
            case, repetition, "passed" if verdict["passed"] else "failed", reason=verdict["reason"] if not verdict["passed"] else None, latency_ms=latency,
            score=verdict["score"] if verdict["score"] is not None else round(outcome.score, 4), failed_assertions=[r for r in assertion_dicts if r["status"] != "passed"],
            assertion_counts=counts, usage=usage, cost_usd=cost, cost_known=known, artifact=self._artifact(case, repetition, observation, outcome, verdict, layers, metrics),
            model_id=model_id, input_tokens=(usage or {}).get("input_tokens"), output_tokens=(usage or {}).get("output_tokens"), cached_tokens=(usage or {}).get("cached_tokens"),
            llm_calls=(usage or {}).get("calls") if usage and usage.get("status") == "attributed" else trace.get("llm_calls"), ttft_ms=observation.get("ttft_ms"),
            turns=len(trace.get("turn") or []) if chat else None, critical_failed=verdict["critical_failed"], layer_scores=layers, verdict=verdict,
            trace_summary=trace_summary, trace_artifact=self._trace_artifact(case, repetition, observation), metric_scores=metrics, judge_cost_usd=judge_cost)

    # ── the run ─────────────────────────────────────────────────────────────────────────────────────────────────────

    async def run_repetition(self, cases: List[dict], repetition: int) -> None:
        cases = [c for c in cases if self.repetitions(c) >= repetition]
        function_cases = [c for c in cases if not is_chat(c) and self.registered.get(operation_of(c)) == "function" and self.classify(c) is None]
        rest = [c for c in cases if c not in function_cases]
        # Function cases share the process environment (ENV_VAR): run each strict/demo group on its own, concurrently inside it.
        groups: Dict[str, List[dict]] = {}
        for c in function_cases:
            groups.setdefault((c.get("metadata") or {}).get("env_mode") == "demo" and "demo" or "strict", []).append(c)
        gate = asyncio.Semaphore(max(1, self.args.concurrency))

        async def bounded(case: dict) -> None:
            async with gate:
                if not self.cancel.is_set():
                    await self.execute_one(case, repetition)
        for group in groups.values():
            await asyncio.gather(*(bounded(c) for c in group))
        for case in rest:                                              # the stack: one database, so one case at a time
            if self.cancel.is_set():
                break
            await self.execute_one(case, repetition)

    def stack_needed(self, cases: List[dict]) -> bool:
        return any((is_chat(c) or self.registered.get(operation_of(c)) == "http") and not self.classify(c) for c in cases)

    async def run(self, cases: List[dict]) -> None:
        if self.stack_needed(cases):
            fixtures_dir = self.bundle.path / "fixtures" if (self.bundle.path / "fixtures").is_dir() else casekit.FIXTURES
            self.env = Environment(fixtures_dir)
            self.client = httpx.AsyncClient(timeout=httpx.Timeout(float(max(self.args.timeout, self.args.chat_timeout))))
            self.meter = UsageMeter(self.env.ledger)
        elif self.args.judge:
            self.client = httpx.AsyncClient(timeout=httpx.Timeout(float(self.args.timeout)))
        try:
            total = max((self.repetitions(c) for c in cases), default=1)
            for repetition in range(1, total + 1):
                if self.cancel.is_set():
                    break
                self.event("state", f"repetition {repetition} of {total}", state="running", repetition=repetition, repetitions=total)
                await self.run_repetition(cases, repetition)
            if self.env:
                await self.env.fresh()                                 # leave the environment clean for whoever uses it next
        finally:
            if self.client:
                await self.client.aclose()
            if self.env:
                await self.env.close()


def parse(argv: List[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="eval_runner", description=__doc__.split("\n")[0])
    p.add_argument("--bundle", type=Path, help="an exported Gold version (checksums are verified)")
    p.add_argument("--from-source", action="store_true", help="the repository's authoring files instead (not verified; development only)")
    p.add_argument("--suite", choices=("technical", "business"), default="technical")
    p.add_argument("--case", nargs="*", default=[], dest="cases")
    p.add_argument("--category", nargs="*", default=[], dest="categories")
    p.add_argument("--operation", nargs="*", default=[], dest="operations")
    p.add_argument("--model", help="the model under test for chat cases, provider/model (mock/mock-oracle, mock/mock-lazy, mock/mock-reckless, openai/gpt-4o-mini...)")
    p.add_argument("--skills", choices=("on", "off", "default"), default="default", help="the chat agent's progressive skills for this run")
    p.add_argument("--prompt-version", help="a prompt variant (evals/prompts/<version>.json); omitted: the agent's own prompts")
    p.add_argument("--judge", help="the judge model for semantic criteria, provider/model (mock/mock-judge, openai/gpt-4o-mini...)")
    p.add_argument("--calibrate", action="store_true", help="first check the judge on answers of known quality (evals/calibration) and record the result with the run")
    p.add_argument("--allow-same-judge", action="store_true", help="let the judge be the model under test (not independent evidence)")
    p.add_argument("--repeat", default="1", help="repetitions per case: a number, or `auto` (deterministic 1, chat and model-backed 3, benchmark 5)")
    p.add_argument("--kind", choices=("suite", "benchmark_agent", "benchmark_direct"), default="suite")
    p.add_argument("--group-id", help="runs compared together (a benchmark, a skills on/off pair)")
    p.add_argument("--job-id", help="the job this run belongs to")
    p.add_argument("--concurrency", type=int, default=4, help="parallel pure-function cases (stack cases always run one at a time)")
    p.add_argument("--timeout", type=float, default=120.0, help="seconds allowed for one non-chat case")
    p.add_argument("--chat-timeout", type=float, default=300.0, help="seconds allowed for one whole conversation")
    p.add_argument("--retries", type=int, default=1, help="extra attempts after an infrastructure error (never after a verdict)")
    p.add_argument("--reset", choices=("per-case", "per-writer"), default="per-case")
    p.add_argument("--budget-usd", type=float, default=float(os.environ.get("EVAL_BUDGET_USD", "1.00")))
    p.add_argument("--max-latency-ms", type=int, help="L6: fail an execution slower than this")
    p.add_argument("--max-tokens", type=int, help="L6: fail an execution that used more tokens than this")
    p.add_argument("--max-cost-usd", type=float, help="L6: fail an execution that cost more than this")
    p.add_argument("--stop-on-critical", action="store_true", help="stop the run at the first critical failure")
    p.add_argument("--gate", action="store_true", help="apply the quality gate (stricter for critical cases); a failed gate exits 1")
    p.add_argument("--gate-min-pass-rate", type=float, default=stats.DEFAULT_GATE["min_pass_rate"])
    p.add_argument("--gate-min-repetitions", type=int, default=stats.DEFAULT_GATE["min_repetitions"])
    p.add_argument("--strict", action="store_true", help="exit 3 when something selected was blocked or nothing ran")
    a = p.parse_args(argv)
    if bool(a.bundle) == a.from_source:
        p.error("give exactly one of --bundle or --from-source")
    if a.repeat != "auto" and (not a.repeat.isdigit() or int(a.repeat) < 1):
        p.error("--repeat must be a positive number or `auto`")
    if a.concurrency < 1 or a.timeout <= 0 or a.chat_timeout <= 0 or a.retries < 0:
        p.error("--concurrency, --timeout and --chat-timeout must be positive and --retries not negative")
    if a.calibrate and not a.judge:
        p.error("--calibrate needs --judge")
    if a.model and (a.model.count("/") != 1 or not all(a.model.split("/"))):
        p.error("--model must be provider/model, for example mock/mock-oracle or openai/gpt-4o-mini")
    return a


PROMPTS = Path(os.environ.get("EVAL_PROMPTS", "/work/evals/prompts"))


def prompt_pin(version: Optional[str]) -> Optional[str]:
    """The checksum of the prompt variant a run uses, so two runs of "concise-v1" can be told apart if the file changes. A version that
    does not exist is refused before anything runs."""
    if not version:
        return None
    path = PROMPTS / f"{version}.json"
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,60}", version) or not path.is_file():
        raise ValueError(f"no prompt version {version!r} (expected {path})")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def config_of(args: argparse.Namespace, runner: Runner) -> Dict[str, Any]:
    t = runner.target
    return {"kind": args.kind, "group_id": args.group_id, "job_id": args.job_id, "provider": t.provider if t else None, "model_id": t.model if t else None,
            "skills_enabled": None if not t else t.skills, "prompt_version": args.prompt_version, "prompt_sha256": getattr(args, "prompt_sha256", None), "judge_model": args.judge,
            "synthetic_model": bool(t and t.synthetic), "retries": args.retries, "limits": runner.limits, "repeat": args.repeat, "stop_on_critical": args.stop_on_critical,
            "gate": ({"min_pass_rate": args.gate_min_pass_rate, "min_repetitions": args.gate_min_repetitions} if args.gate else None),
            "concurrency": args.concurrency, "timeout_s": args.timeout, "chat_timeout_s": args.chat_timeout, "allow_same_judge": args.allow_same_judge}


async def main(argv: List[str]) -> int:
    args = parse(argv)
    try:
        assert_evaluation_process()
        judge_lib.check_governance(args.judge, args.model, allow_same=args.allow_same_judge)
        args.prompt_sha256 = prompt_pin(args.prompt_version)
        bundle = bundle_from_source() if args.from_source else load_bundle(args.bundle)
        selected, left = select_cases(bundle.cases, suite=args.suite, case_ids=args.cases, categories=args.categories, operations=args.operations)
    except (BundleError, EvaluationGuardError, ValueError, judge_lib.JudgeGovernanceError) as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 4
    runner = Runner(bundle, args)
    runner.print_events = True
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: (runner.event("log", "cancel requested: finishing the case in flight"), runner.cancel.set()))
    started = time.strftime("%Y-%m-%dT%H:%M:%S")
    runner.event("state", "run started", state="started", run_id=runner.run_id, selected=len(selected), dataset=bundle.identity)
    try:
        await runner.run(selected)
    except EvaluationGuardError as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 4
    summary = summarise(runner.results, selected=len(selected), left_out=left)
    calibration = None
    if args.calibrate:
        async with httpx.AsyncClient() as cal_client:
            calibration = await calibrate_judge.calibrate(cal_client, url=JUDGE_URL, judge_model=args.judge)
        runner.spent_usd += calibration["cost_usd"] or 0.0
        calibration.pop("rows", None)
    cancelled = runner.cancel.is_set()
    rows = [r.as_dict() for r in runner.results]
    reliability = stats.run_reliability(rows)
    gate = stats.evaluate_gate(rows, {"min_pass_rate": args.gate_min_pass_rate, "min_repetitions": args.gate_min_repetitions}) if args.gate else None
    summary.update({"run_id": runner.run_id, "cancelled": cancelled, "stop_reason": runner.stop_reason, "suite": args.suite,
                    "repeat": max((r.repetition for r in runner.results), default=1), "dataset": bundle.identity, "started_at": started,
                    "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "budget_usd": args.budget_usd, "providers_ready": sorted(runner.providers),
                    "config": config_of(args, runner), "reliability": {k: v for k, v in reliability.items() if k != "per_case"},
                    "per_case": reliability["per_case"], "gate": gate, "spent_usd": round(runner.spent_usd, 6),
                    "synthetic_model": bool(runner.target and runner.target.synthetic), "judge_calibration": calibration,
                    "unscored_l2": sorted({r.case_id for r in runner.results if (r.verdict or {}).get("unscored_layers")})})
    report = render_report(summary, runner.results, identity=bundle.identity, suite=args.suite, run_id=runner.run_id, budget_usd=args.budget_usd,
                           cancelled=cancelled, repeat=summary["repeat"])
    report += _extras(summary, runner)
    (runner.out / "summary.json").write_text(json.dumps(summary, indent=1, default=str), encoding="utf-8")
    (runner.out / "report.txt").write_text(report + "\n", encoding="utf-8")
    runner.event("state", "run finished", state="cancelled" if cancelled else "finished", **runner.progress())
    runner.events.close()
    seal_folder(runner.out)                                # the last act: pin every file, so the platform can tell if the folder changes later
    print(report)
    print(f"results: {runner.out}")
    code = exit_code(summary, strict=args.strict)
    return 1 if (gate and not gate["passed"] and not code) else code


def _extras(summary: Dict[str, Any], runner: Runner) -> str:
    """What the base report does not say: the model under test, the judge, the layers, reliability and the gate."""
    cfg, out = summary["config"], []
    w = out.append
    if cfg.get("model_id") or cfg.get("judge_model"):
        w("")
        w(f"  model under test  {cfg.get('model_id') or '-'}" + ("   *** SYNTHETIC scripted model: a check of the harness, NOT a quality result ***" if cfg.get("synthetic_model") else "")
          + (f"   skills {'on' if cfg['skills_enabled'] else 'off'}" if cfg.get("skills_enabled") is not None else "")
          + (f"   prompt {cfg['prompt_version']}" if cfg.get("prompt_version") else ""))
        w(f"  judge             {cfg.get('judge_model') or 'none (output quality is not scored)'}")
    cal = summary.get("judge_calibration")
    if cal:
        w(f"  judge calibration {cal['status'].upper().replace('_', ' ')}" + (f": agreed with known answers {cal['agreed']} of {cal['scored']} ({cal['agreement'] * 100:.0f}%)" if cal["agreement"] is not None else "")
          + (f"   wrong way round: {', '.join(cal['disagreements'])}" if cal["disagreements"] else "")
          + ("   *** judged scores in this run are NOT trustworthy ***" if cal["status"] != "trusted" else ""))
    layer_rows: Dict[str, Dict[str, int]] = {}
    for r in runner.results:
        for layer, v in (r.layer_scores or {}).items():
            if v.get("applicable"):
                layer_rows.setdefault(layer, {})[v["status"]] = layer_rows.setdefault(layer, {}).get(v["status"], 0) + 1
    if layer_rows:
        w("  layers (executions per outcome)")
        for layer in layers_lib.LAYERS:
            if layer in layer_rows:
                w(f"    {layer} {layers_lib.LAYER_NAMES[layer]:28} " + "  ".join(f"{k} {v}" for k, v in sorted(layer_rows[layer].items())))
    if summary.get("unscored_l2"):
        w(f"  NOT FULLY JUDGED: {len(summary['unscored_l2'])} case(s) have criteria nobody scored (no judge): " + ", ".join(summary["unscored_l2"][:8]))
    rel = summary["reliability"]
    if summary["repeat"] > 1 and rel.get("pass_rate") is not None:
        w(f"  reliability       pass rate {rel['pass_rate'] * 100:.1f}% (95% interval {rel['ci_low'] * 100:.0f}-{rel['ci_high'] * 100:.0f}%)   flaky: {', '.join(rel['flaky_cases']) or 'none'}"
          f"   consistently wrong: {', '.join(rel['consistently_wrong_cases']) or 'none'}")
    if summary.get("stop_reason"):
        w(f"  STOPPED EARLY     {summary['stop_reason']}")
    if summary.get("gate"):
        g = summary["gate"]
        w(f"  quality gate      {'PASSED' if g['passed'] else 'FAILED'}")
        for c in g["checks"]:
            w(f"    {'ok  ' if c['ok'] else 'FAIL'} {c['name']}: {c['value']} (required {c['threshold']}) {c['detail']}")
    return "\n".join(out)


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
