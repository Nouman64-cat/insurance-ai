"""Frontend-to-backend integration test of the Evaluation Costs dashboard.

    python evals/frontend/run_costs_integration.py

Compiles frontend/tests/costs.integration.ts in the frontend container and runs it twice:

  writes   against the ISOLATED evaluation stack. Spending limits, provider bills and exchange rates can never be edited or deleted, so the whole flow with its refusals
           (limits with reasons, bills, overlaps, corrections, rates, the confirmed / estimated split) is made where nothing real lives. A throwaway container with the same
           code and node_modules (`--volumes-from`, read-only) joins only the isolated network; it has no route to the application stack or the internet.
  reads    against the working stack, changing nothing: the cost preview with the budget, and the real runs' overview, comparison and usage records.

Both render the dashboard's own views with what the real API returned and check what a person would read.
"""
from __future__ import annotations

import json
import random
import string
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRONTEND, EVAL_TENANT, TENANT = "insurance-frontend", "eval-tenant-service", "insurance-tenant-service"
EVAL_NETWORK = "insurance-ai-eval_eval-internal"
OUT = "node_modules/.bm-test"

STUB_LINK = """const React = require('react');
function Link(props) { const { href, children, ...rest } = props; return React.createElement('a', { href: String(href), ...rest }, children); }
module.exports = Link; module.exports.default = Link; module.exports.__esModule = true;
"""

SEED = '''
import asyncio, json, random, uuid
from datetime import datetime
from sqlmodel import select
import database
from routers.auth import create_access_token
from shared.models.core import Role, User
from shared.models.evaluation import EvalCostLine, EvalRun
from test_eval_analytics import make_run

async def main():
    async with database._session_factory() as s:
        sa = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
        admin = (await s.exec(select(User).where(User.role_id == sa.id, User.is_deleted == False))).first()
        used = {d.year for d in (await s.exec(select(EvalRun.started_at))).all() if d} | {d.year for d in (await s.exec(select(EvalCostLine.incurred_at))).all()}
        year = random.choice([y for y in range(1960, 2000) if y not in used])
        ds = f"t-costui-{uuid.uuid4().hex[:6]}"
        bench = f"bench-{ds}"
        a = await make_run(s, model="openai/gpt-4.1", dataset=ds, passed=36, failed=4, at=datetime(year, 5, 10, 9), group=bench, lines=[("agent_llm", 0.80, None), ("judge", 0.20, "openai/gpt-4o")])
        await make_run(s, model="openai/gpt-4o-mini", dataset=ds, passed=45, failed=5, at=datetime(year, 5, 10, 9, 4), group=bench, lines=[("agent_llm", 0.30, None), ("judge", 0.20, "openai/gpt-4o")])
        await s.commit()
        print(json.dumps({"token": create_access_token({"sub": str(admin.id)}), "year": year, "dataset": ds, "bench": bench, "run_a": a}))
asyncio.run(main())
'''

TOKEN = '''
import asyncio
from sqlmodel import select
import database
from routers.auth import create_access_token
from shared.models.core import Role, User
async def main():
    async with database._session_factory() as s:
        sa = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
        admin = (await s.exec(select(User).where(User.role_id == sa.id, User.is_deleted == False))).first()
        print(create_access_token({"sub": str(admin.id)}))
asyncio.run(main())
'''


def run(*cmd: str, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(list(cmd), text=True, capture_output=True, **kw)


def exec_py(container: str, code: str) -> str:
    done = subprocess.run(["docker", "exec", "-i", "-w", "/app", container, "python", "-B", "-W", "ignore", "-"], input=code, text=True, capture_output=True)
    if done.returncode:
        print(f"could not run in {container}:", done.stderr[-600:])
        sys.exit(2)
    return done.stdout.strip().splitlines()[-1]


def main() -> int:
    built = run("docker", "exec", FRONTEND, "sh", "-c", f"cd /app && rm -rf {OUT} && npx tsc -p tests/tsconfig.json")
    if built.returncode:
        print("the test does not compile:\n", built.stdout[-2500:])
        return 2
    alias = (ROOT / "evals/frontend/run_benchmarking_integration.py").read_text().split('ALIAS = """')[1].split('"""')[0]
    alias = alias.replace("original.call(this, request, ...rest);", "original.call(this, request === 'next/link' ? '/app/node_modules/.bm-next-link.js' : request, ...rest);", 1)
    for name, content in ((".bm-alias.js", alias), (".bm-next-link.js", STUB_LINK)):
        run("docker", "exec", "-i", FRONTEND, "sh", "-c", f"cat > /app/node_modules/{name}") if False else subprocess.run(["docker", "exec", "-i", FRONTEND, "sh", "-c", f"cat > /app/node_modules/{name}"], text=True, input=content)
    node = ["node", "-r", "/app/node_modules/.bm-alias.js", f"/app/{OUT}/tests/costs.integration.js"]
    code = 0

    print("== writes: the isolated evaluation stack ==")
    seeded = json.loads(exec_py(EVAL_TENANT, SEED))
    env = ["-e", f"COSTS_TOKEN={seeded['token']}", "-e", f"COSTS_YEAR={seeded['year']}", "-e", f"COSTS_DATASET={seeded['dataset']}", "-e", f"COSTS_BENCH={seeded['bench']}", "-e", f"COSTS_CCY=X{random.choice(string.ascii_uppercase)}{random.choice(string.ascii_uppercase)}", "-e", f"COSTS_RUN_A={seeded['run_a']}",
           "-e", "COSTS_SUITE=writes", "-e", "NEXT_PUBLIC_API_URL=http://eval-api-gateway:8000", "-e", f"BM_OUT=/app/{OUT}"]
    code |= subprocess.run(["docker", "run", "--rm", "--network", EVAL_NETWORK, "--volumes-from", f"{FRONTEND}:ro", "-w", "/app", *env, "insurance-ai-frontend:latest", *node], text=True).returncode

    print("\n== reads: the working stack (nothing is changed) ==")
    token = exec_py(TENANT, TOKEN)
    code |= subprocess.run(["docker", "exec", "-w", "/app", "-e", f"COSTS_TOKEN={token}", "-e", "COSTS_SUITE=reads", "-e", "NEXT_PUBLIC_API_URL=http://api-gateway:8000", "-e", f"BM_OUT=/app/{OUT}", FRONTEND, *node], text=True).returncode
    return 1 if code else 0


if __name__ == "__main__":
    sys.exit(main())
