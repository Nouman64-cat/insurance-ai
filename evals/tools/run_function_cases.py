"""Runs the golden cases whose operation is a pure function of the service code (premiums, underwriting rules, ...) through
the operation registry and the assertion engine. No database, no network, no model: it shows whether the code still gives the
answers the dataset pins.

    python evals/tools/run_function_cases.py                      # every registered function-mode operation
    python evals/tools/run_function_cases.py underwriting.decide  # just these operations
    docker compose exec tenant-service python /app/evals/tools/run_function_cases.py   # with the service's own dependencies

Exit status: 0 every case passed; 1 at least one failed; 2 none failed but some could not run (a claims case needs the service's
packages, so on a bare host run it inside the container). A case that could not run is never counted as a pass.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import casekit  # noqa: E402
from shared.evaluation.assertions import evaluate_case  # noqa: E402
from shared.evaluation.operations import OPERATIONS, OperationError, RunContext, execute  # noqa: E402

TENANT_SERVICE = casekit.REPO / "microservices" / "backend-microservices" / "tenant-service"
if str(TENANT_SERVICE) not in sys.path:
    sys.path.insert(0, str(TENANT_SERVICE))        # the limit book lives in tenant-service's `services` package


def fixtures_for(case: dict) -> dict:
    """The tenant world: every JSON fixture of the dataset (plans, policies, personas, the tenant itself). A case's own
    `fixture_refs` say what it is about; an operation may still need the plan catalog the policies point at."""
    return {path.name: casekit.read_json(path) for path in sorted(casekit.FIXTURES.glob("*.json")) if path.name != "manifest.json"}


async def run(names=None) -> int:
    chosen = set(names or [n for n, op in OPERATIONS.items() if op.mode == "function"])
    failures = unrunnable = total = 0
    for _, raw in sorted(casekit.sources(), key=lambda s: s[1]["case_id"]):
        case, _ = casekit.normalise(raw)
        op = (case["input"].get("payload") or {}).get("operation")
        if op not in chosen or op not in OPERATIONS:
            continue
        total += 1
        try:
            outcome = evaluate_case(case, await execute(case, RunContext(fixtures=fixtures_for(case))))
        except OperationError as exc:
            unrunnable += 1
            print(f"COULD NOT RUN  {case['case_id']} {op}: {exc}")
            continue
        if outcome.passed:
            print(f"passed {case['case_id']} {op}")
        else:
            failures += 1
            print(f"FAILED {case['case_id']} {op}")
            for r in outcome.results:
                if not r.passed:
                    print(f"         {r.status} {r.target}: expected {json.dumps(r.expected)}, actual {json.dumps(r.actual, default=str)[:160]}")
    passed = total - failures - unrunnable
    print(f"{'FAILED' if failures else 'PASS' if not unrunnable else 'INCOMPLETE'}: {passed} passed, {failures} failed, "
          f"{unrunnable} could not run, of {total} function-mode cases")
    return 1 if failures else 2 if unrunnable else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run(sys.argv[1:] or None)))
