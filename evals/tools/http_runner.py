"""Runs golden cases through the operation registry against the isolated evaluation stack. Run inside eval-runner:

    python -m evals.tools.http_runner                       # every registered case that needs the stack (http mode)
    python -m evals.tools.http_runner IND-ISS-001 IND-CUST-001
    python -m evals.tools.http_runner --bundle /work/runs/bundles/individual-single-turn-1.0.5   # cases exported from the lake
    python -m evals.tools.http_runner --repeat 3             # three independent repetitions, each from a freshly reset database

For each case: log in as the acting user (a real login, with the real role), build the context from the ids the seeder wrote,
perform the operation against the real service, and check the assertions. A case that writes data starts from a freshly reset
and re-seeded database, so no case sees another's changes. Results go to /work/runs/<run id>/results.jsonl, outside the
database, so a reset never loses them. This is the small core step 5 grows into the full runner.

A case the stack cannot perform (an environment problem) is reported as COULD NOT RUN, never as a pass or a fail of the system.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from sqlalchemy import text
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.evaluation import environment as env_lib
from shared.evaluation import seeding
from shared.evaluation.assertions import evaluate_case
from shared.evaluation.operations import OPERATIONS, OperationError, RunContext, execute
from shared.evaluation.safety import EvaluationGuardError, assert_evaluation_process
from shared.evaluation.usage import UsageMeter

# casekit lives next to this file; inside the runner container the repo is mounted at /work
sys.path.insert(0, str(Path(__file__).resolve().parent))
import casekit  # noqa: E402

ROOT = Path(os.environ.get("EVAL_WORK_DIR", "/work"))
FIXTURES = Path(os.environ.get("EVAL_FIXTURES", ROOT / "evals/datasets/individual-insurance/fixtures"))
EXTRAS = Path(os.environ.get("EVAL_EXTRAS", ROOT / "evals/environment/world-extras.json"))
OUTPUT = Path(os.environ.get("EVAL_OUTPUT", ROOT / "runs"))
API, GATEWAY, OCR = (os.environ.get(k, d) for k, d in (("EVAL_API_URL", "http://eval-tenant-service:8001"),
                                                       ("EVAL_GATEWAY_URL", "http://eval-api-gateway:8000"),
                                                       ("EVAL_OCR_URL", "http://eval-ocr-engine:8004")))
# Operations that change data: the case starts from a clean database. The others only read, so they share one seeded state.
WRITERS = {"customers.create", "quotes.update_status", "policies.issue", "ipp.initiate", "ipp.confirm", "ocr.extract_customer"}


class Environment:
    """The seeded database and what the runner needs to talk to it."""

    def __init__(self, fixtures: Path = FIXTURES) -> None:
        assert_evaluation_process()
        self.engine = env_lib.evaluation_engine()
        self.fixtures = fixtures
        self.world = seeding.load_world(fixtures, EXTRAS)
        self.ids: Dict[str, Dict[str, str]] = {}
        self._password = os.environ["EVAL_USER_PASSWORD"]
        self._hash: Optional[str] = None

    async def fresh(self) -> None:
        """Reset to the provisioned baseline, then seed the fixtures. Always from the baseline, never on top of earlier changes."""
        async with self.engine.begin() as conn:
            await env_lib.reset(conn)
        if self._hash is None:
            from passlib.context import CryptContext
            self._hash = CryptContext(schemes=["bcrypt"], deprecated="auto").hash(self._password)
        async with AsyncSession(self.engine, expire_on_commit=False) as session:
            report = await seeding.seed(session, self.world, password_hash=self._hash)
            await session.commit()
        self.ids = report.ids

    async def ledger(self) -> List[Dict[str, Any]]:
        async with self.engine.connect() as conn:
            rows = await conn.execute(text("select id, service_name, model_name, input_tokens, output_tokens, cached_tokens, thread_id, tenant_id from token_usage"))
            return [dict(r._mapping) for r in rows]

    async def close(self) -> None:
        await self.engine.dispose()


async def login(client: httpx.AsyncClient, user_ref: str) -> str:
    r = await client.post(f"{API}/auth/token", data={"username": f"{user_ref}@eval.invalid", "password": os.environ["EVAL_USER_PASSWORD"]})
    if r.status_code != 200:
        raise OperationError(f"could not log in as {user_ref}: {r.status_code} {r.text[:120]}")
    return r.json()["access_token"]


def select_cases(wanted: List[str], bundle: Optional[Path]) -> List[dict]:
    if bundle:
        cases = [json.loads(line) for line in (bundle / "cases.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    else:
        cases = [casekit.normalise(raw)[0] for _, raw in casekit.sources()]
    out = []
    for c in sorted(cases, key=lambda c: c["case_id"]):
        op = (c["input"].get("payload") or {}).get("operation")
        if op not in OPERATIONS or OPERATIONS[op].mode != "http":
            continue
        if wanted and c["case_id"] not in wanted:
            continue
        out.append(c)
    return out


async def run_case(env: Environment, client: httpx.AsyncClient, case: dict, files: Dict[str, bytes], meter: UsageMeter, run_id: str) -> dict:
    op = case["input"]["payload"]["operation"]
    actor = case["input"].get("actor") or {}
    started = time.monotonic()
    try:
        token = await login(client, actor["user_ref"])
        tenant = env.ids["tenant"].get(actor.get("tenant_ref") or "")
        headers = {"Authorization": f"Bearer {token}", **({"X-Tenant-Id": tenant} if tenant else {})}
        ctx = RunContext(http=client, base_url=API, gateway_url=GATEWAY, ocr_url=OCR, tenant_id=tenant, headers=headers,
                         tenant_ids=env.ids["tenant"], ids={"policies": env.ids.get("policy", {}), "quotes": env.ids.get("quote", {})},
                         files=files, usage_meter=meter, execution_id=f"{run_id}/{case['case_id']}")
        observation = await execute(case, ctx)
        outcome = evaluate_case(case, observation)
        status = "passed" if outcome.passed else "failed"
        detail = outcome.as_dict()
    except (OperationError, EvaluationGuardError) as exc:
        status, detail, observation = "could_not_run", {"error": str(exc)}, {}
    return {"case_id": case["case_id"], "operation": op, "status": status, "seconds": round(time.monotonic() - started, 2),
            "assertions": detail, "usage": (observation or {}).get("usage")}


async def main(argv: List[str]) -> int:
    bundle = Path(argv[argv.index("--bundle") + 1]) if "--bundle" in argv else None
    repeat = int(argv[argv.index("--repeat") + 1]) if "--repeat" in argv else 1
    wanted = [a for i, a in enumerate(argv) if not a.startswith("--") and (i == 0 or argv[i - 1] not in ("--bundle", "--repeat"))]
    cases = select_cases(wanted, bundle)
    run_id = time.strftime("%Y%m%dT%H%M%S")
    # A bundle (exported from the lake) brings its own fixtures; without one the repository's dataset fixtures are used.
    fixtures = bundle / "fixtures" if bundle else FIXTURES
    files = {p.name: p.read_bytes() for p in fixtures.iterdir() if p.is_file() and p.suffix in (".png", ".jpg", ".jpeg", ".pdf", ".txt")}
    env = Environment(fixtures)
    results: List[dict] = []
    try:
        meter = UsageMeter(env.ledger)
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
            for repetition in range(1, repeat + 1):
                await env.fresh()                                  # every repetition starts from the baseline, whatever the last one did
                if repeat > 1:
                    print(f"--- repetition {repetition} of {repeat}")
                for case in cases:
                    op = case["input"]["payload"]["operation"]
                    if op in WRITERS:
                        await env.fresh()
                    result = await run_case(env, client, case, files, meter, f"{run_id}/r{repetition}")
                    result["repetition"] = repetition
                    results.append(result)
                    print(f"{result['status'].upper():13} {result['case_id']:13} {op:34} {result['seconds']:>5}s")
                    if result["status"] == "failed":
                        for a in result["assertions"]["results"]:
                            if not a["status"] == "passed":
                                print(f"                 {a['status']}: {a['target']} expected {json.dumps(a['expected'])[:60]} got {json.dumps(a['actual'], default=str)[:80]}")
                    elif result["status"] == "could_not_run":
                        print(f"                 {result['assertions']['error']}")
    finally:
        await env.close()
    out = OUTPUT / run_id
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.jsonl").write_text("\n".join(json.dumps(r, default=str) for r in results) + "\n", encoding="utf-8")
    tally = {s: sum(1 for r in results if r["status"] == s) for s in ("passed", "failed", "could_not_run")}
    print(f"\n{len(results)} cases: {tally['passed']} passed, {tally['failed']} failed, {tally['could_not_run']} could not run  ->  {out}")
    return 1 if tally["failed"] else 2 if tally["could_not_run"] else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
