"""Frontend-to-backend integration test of the Drift Monitor page.

    python evals/frontend/run_drift_integration.py

Loads three findings into the platform as a scan (through the worker's ingest endpoint, as a real scan would arrive), mints a Super Admin token,
compiles and runs frontend/tests/drift.integration.ts in the frontend container against the live gateway, then loads an empty scan for the same
dataset so nothing is left open. Review items can never be deleted by design, so the decided ones stay, under the dataset name `itest-drift`.
"""
from __future__ import annotations

import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRONTEND, TENANT = "insurance-frontend", "insurance-tenant-service"
OUT = "node_modules/.bm-test"

LOAD = '''
import asyncio, sys, database
from sqlmodel import select
from routers.auth import create_access_token
from services import eval_drift
from shared.models.core import Role, User
TAG, ACTION = sys.argv[1], sys.argv[2]
def report(n, findings, proposals):
    return {"scan_id": f"scan-{TAG}-{n}", "dataset": {"dataset": "itest-drift", "version": "1.0.0", "verified": True}, "counts": {}, "summary": {}, "coverage": {}, "findings": findings, "proposals": proposals}
async def main():
    async with database._session_factory() as s:
        if ACTION == "load":
            r = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
            u = (await s.exec(select(User).where(User.role_id == r.id, User.is_deleted == False))).first()
            f = [{"key": f"{TAG}-r", "kind": "rule_changed", "severity": "high", "summary": f"itest {TAG}: a rule changed", "affected_cases": ["IND-X-1"], "detail": {}},
                 {"key": f"{TAG}-u", "kind": "unconfirmed", "severity": "medium", "summary": f"itest {TAG}: an unconfirmed answer", "affected_cases": ["IND-X-2"], "detail": {}}]
            p = [{"key": f"{TAG}-p", "stage": "kyc", "scenario_type": "negative", "rationale": f"itest {TAG}: a suggested case", "provenance": {"kind": "coverage"}}]
            await eval_drift.ingest_scan(s, report(1, f, p)); await s.commit()
            print(create_access_token({"sub": str(u.id)}))
        else:
            await eval_drift.ingest_scan(s, report(2, [], [])); await s.commit(); print("cleared")
asyncio.run(main())
'''


def py(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", "exec", "-i", TENANT, "python", "-", *args], input=LOAD, text=True, capture_output=True)


def main() -> int:
    tag = uuid.uuid4().hex[:6]
    made = py(tag, "load")
    token = (made.stdout.strip().splitlines() or [""])[-1]
    if made.returncode or token.count(".") != 2:
        print("could not load the test findings:", made.stderr[-500:])
        return 2
    try:
        built = subprocess.run(["docker", "exec", FRONTEND, "sh", "-c", f"cd /app && rm -rf {OUT} && npx tsc -p tests/tsconfig.json"], text=True, capture_output=True)
        if built.returncode:
            print("the test does not compile:\n", built.stdout[-1500:])
            return 2
        subprocess.run(["docker", "exec", "-i", FRONTEND, "sh", "-c", "cat > /app/node_modules/.bm-alias.js"], text=True, input=(ROOT / "evals/frontend/run_benchmarking_integration.py").read_text().split('ALIAS = """')[1].split('"""')[0])
        run = subprocess.run(["docker", "exec", "-e", f"DRIFT_TOKEN={token}", "-e", f"DRIFT_TAG={tag}", "-e", "NEXT_PUBLIC_API_URL=http://api-gateway:8000", "-e", f"BM_OUT=/app/{OUT}", FRONTEND,
                              "node", "-r", "/app/node_modules/.bm-alias.js", f"/app/{OUT}/tests/drift.integration.js"], text=True)
        return run.returncode
    finally:
        print(py(tag, "clear").stdout.strip())


if __name__ == "__main__":
    sys.exit(main())
