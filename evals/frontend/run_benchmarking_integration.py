"""Frontend-to-backend integration test of the LLM Benchmarking page.

    python evals/frontend/run_benchmarking_integration.py

What it does, in order:
  1. mints a Super Admin token inside the platform tenant-service (the same signer the gateway verifies),
  2. starts the evaluation job worker (`envctl.py worker`) for the length of the test, so jobs the page starts really run,
  3. compiles frontend/tests/benchmarking.integration.ts in the frontend container and runs it with node. That file drives the page's own
     API module (lib/evalBenchmarks.ts) against the live gateway: form validation, cost preview, start, live stream, cancel, rerun,
     results, filters, exports, trace, and the refusal of an unauthenticated caller,
  4. stops the worker.

It runs scripted models only (no spend). It needs the platform stack, the evaluation stack (`envctl.py up`) and the frontend container.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = "insurance-frontend"
TENANT = "insurance-tenant-service"
GATEWAY_FROM_FRONTEND = "http://api-gateway:8000"
OUT = "node_modules/.bm-test"

ALIAS = """
const Module = require('module'), path = require('path');
const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@/')) request = path.join(process.env.BM_OUT, request.slice(2));
  return original.call(this, request, ...rest);
};
"""

MINT = (
    "import asyncio, database\n"
    "from sqlmodel import select\n"
    "from routers.auth import create_access_token\n"
    "from shared.models.core import Role, User\n"
    "async def main():\n"
    "    async with database._session_factory() as s:\n"
    "        r = (await s.exec(select(Role).where(Role.name == 'SuperAdmin'))).first()\n"
    "        u = (await s.exec(select(User).where(User.role_id == r.id, User.is_deleted == False))).first()\n"
    "        print(create_access_token({'sub': str(u.id)}))\n"
    "asyncio.run(main())\n"
)


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, text=True, capture_output=True, **kw)


def main() -> int:
    minted = run(["docker", "exec", "-i", TENANT, "python", "-"], input=MINT)
    token = (minted.stdout.strip().splitlines() or [""])[-1]
    if minted.returncode or token.count(".") != 2:
        print("could not mint a Super Admin token:", minted.stderr[-400:])
        return 2
    compiled = run(["docker", "exec", FRONTEND, "sh", "-c", f"cd /app && rm -rf {OUT} && npx tsc -p tests/tsconfig.json"])
    if compiled.returncode:
        print("the test does not compile:\n", compiled.stdout[-1500:], compiled.stderr[-500:])
        return 2
    run(["docker", "exec", "-i", FRONTEND, "sh", "-c", "cat > /app/node_modules/.bm-alias.js"], input=ALIAS)

    worker = subprocess.Popen([sys.executable, str(ROOT / "evals/environment/envctl.py"), "worker"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=ROOT,
                              start_new_session=True)
    time.sleep(3)
    try:
        test = subprocess.run(
            ["docker", "exec", "-e", f"BM_TOKEN={token}", "-e", f"NEXT_PUBLIC_API_URL={GATEWAY_FROM_FRONTEND}", "-e", f"BM_OUT=/app/{OUT}", FRONTEND,
             "node", "-r", "/app/node_modules/.bm-alias.js", f"/app/{OUT}/tests/benchmarking.integration.js"], text=True, cwd=ROOT)
        return test.returncode
    finally:
        os.killpg(worker.pid, signal.SIGTERM)
        try:
            worker.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(worker.pid, signal.SIGKILL)


if __name__ == "__main__":
    sys.exit(main())
