"""Frontend-to-backend integration test of the Evaluation Studio.

    python evals/frontend/run_studio_integration.py

Compiles frontend/tests/studio.integration.ts in the frontend container and runs it twice:

  writes   against the ISOLATED evaluation stack, in a world it builds there (backend tenant-service/studio_seed.py): the map, the search, the change impact end to end with its approval
           decisions, the executions. What it writes (review decisions, runs) can never be deleted, so it is written where nothing real lives. A throwaway container with the same code and
           node_modules (`--volumes-from`, read-only) joins only the isolated network.
  reads    against the working stack, changing nothing: the same views drawn from the real datasets, rules, runs, traces and costs.
"""
from __future__ import annotations

import json
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
import asyncio, json
from sqlmodel import select
import database
from routers.auth import create_access_token
from shared.models.core import Role, User
from studio_seed import seed
async def main():
    async with database._session_factory() as s:
        sa = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
        admin = (await s.exec(select(User).where(User.role_id == sa.id, User.is_deleted == False))).first()
        w = await seed(s)
        await s.commit()
        print(json.dumps({**w, "token": create_access_token({"sub": str(admin.id)})}))
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


def exec_py(container: str, code: str) -> str:
    done = subprocess.run(["docker", "exec", "-i", "-w", "/app", container, "python", "-B", "-W", "ignore", "-"], input=code, text=True, capture_output=True)
    if done.returncode:
        print(f"could not run in {container}:", done.stderr[-600:])
        sys.exit(2)
    return done.stdout.strip().splitlines()[-1]


def main() -> int:
    built = subprocess.run(["docker", "exec", FRONTEND, "sh", "-c", f"cd /app && rm -rf {OUT} && npx tsc -p tests/tsconfig.json"], text=True, capture_output=True)
    if built.returncode:
        print("the test does not compile:\n", built.stdout[-2500:])
        return 2
    alias = (ROOT / "evals/frontend/run_benchmarking_integration.py").read_text().split('ALIAS = """')[1].split('"""')[0]
    alias = alias.replace("original.call(this, request, ...rest);", "original.call(this, request === 'next/link' ? '/app/node_modules/.bm-next-link.js' : request, ...rest);", 1)
    for name, content in ((".bm-alias.js", alias), (".bm-next-link.js", STUB_LINK)):
        subprocess.run(["docker", "exec", "-i", FRONTEND, "sh", "-c", f"cat > /app/node_modules/{name}"], text=True, input=content)
    node = ["node", "-r", "/app/node_modules/.bm-alias.js", f"/app/{OUT}/tests/studio.integration.js"]
    code = 0
    print("== writes: the isolated evaluation stack ==")
    w = json.loads(exec_py(EVAL_TENANT, SEED))
    env = ["-e", f"STUDIO_TOKEN={w['token']}", "-e", f"STUDIO_SLUG={w['slug']}", "-e", f"STUDIO_KEY={w['key']}", "-e", f"STUDIO_TAG={w['tag']}", "-e", f"STUDIO_DRIFT={','.join(w['drift_ids'])}", "-e", "STUDIO_SUITE=writes",
           "-e", "NEXT_PUBLIC_API_URL=http://eval-api-gateway:8000", "-e", f"BM_OUT=/app/{OUT}"]
    code |= subprocess.run(["docker", "run", "--rm", "--network", EVAL_NETWORK, "--volumes-from", f"{FRONTEND}:ro", "-w", "/app", *env, "insurance-ai-frontend:latest", *node], text=True).returncode
    print("\n== reads: the working stack (nothing is changed) ==")
    token = exec_py(TENANT, TOKEN)
    code |= subprocess.run(["docker", "exec", "-w", "/app", "-e", f"STUDIO_TOKEN={token}", "-e", "STUDIO_SUITE=reads", "-e", "NEXT_PUBLIC_API_URL=http://api-gateway:8000", "-e", f"BM_OUT=/app/{OUT}", FRONTEND, *node], text=True).returncode
    return 1 if code else 0


if __name__ == "__main__":
    sys.exit(main())
