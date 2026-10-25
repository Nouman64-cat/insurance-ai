"""Frontend-to-backend integration test of the Templates tab.

    python evals/frontend/run_templates_integration.py

Creates a throwaway illustration template (published version 1), mints a Super Admin token, compiles and runs frontend/tests/templates.integration.ts
in the frontend container against the live gateway, then retires the throwaway template (retired templates are hidden from the Templates tab). A
published template version can never be deleted, so the test must work on a template of its own and never on the real ones.
"""
from __future__ import annotations

import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRONTEND, TENANT = "insurance-frontend", "insurance-tenant-service"
OUT = "node_modules/.bm-test"

CREATE = '''
import asyncio, sys, database
from datetime import datetime
from sqlmodel import select
from routers.auth import create_access_token
from shared import doc_templates as dt
from shared.models.core import Role, User
from shared.models.templates import DocumentTemplate, DocumentTemplateVersion
KEY, ACTION = sys.argv[1], sys.argv[2]
async def main():
    async with database._session_factory() as s:
        r = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
        u = (await s.exec(select(User).where(User.role_id == r.id, User.is_deleted == False))).first()
        if ACTION == "create":
            content = dt.seed_lead_acquisition()
            t = DocumentTemplate(template_key=KEY, kind="lead", group_key=None, title="Lead form: Integration test")
            s.add(t); await s.flush()
            s.add(DocumentTemplateVersion(template_id=t.id, version=1, state="published", content=content, content_sha256=dt.content_hash(content),
                                          change_note="throwaway template for the integration test", created_by=u.id, published_by=u.id, published_at=datetime.utcnow()))
            await s.commit()
            print(create_access_token({"sub": str(u.id)}))
        else:
            t = (await s.exec(select(DocumentTemplate).where(DocumentTemplate.template_key == KEY))).first()
            t.status = "retired"; s.add(t); await s.commit(); print("retired")
asyncio.run(main())
'''


def py(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", "exec", "-i", TENANT, "python", "-", *args], input=CREATE, text=True, capture_output=True)


def main() -> int:
    key = f"lead_itest_{uuid.uuid4().hex[:6]}"
    made = py(key, "create")
    token = (made.stdout.strip().splitlines() or [""])[-1]
    if made.returncode or token.count(".") != 2:
        print("could not create the test template:", made.stderr[-500:])
        return 2
    try:
        built = subprocess.run(["docker", "exec", FRONTEND, "sh", "-c", f"cd /app && rm -rf {OUT} && npx tsc -p tests/tsconfig.json"], text=True, capture_output=True)
        if built.returncode:
            print("the test does not compile:\n", built.stdout[-1500:])
            return 2
        subprocess.run(["docker", "exec", "-i", FRONTEND, "sh", "-c", "cat > /app/node_modules/.bm-alias.js"], text=True, input=(ROOT / "evals/frontend/run_benchmarking_integration.py").read_text().split('ALIAS = """')[1].split('"""')[0])
        run = subprocess.run(["docker", "exec", "-e", f"TPL_TOKEN={token}", "-e", f"TPL_KEY={key}", "-e", "NEXT_PUBLIC_API_URL=http://api-gateway:8000", "-e", f"BM_OUT=/app/{OUT}", FRONTEND,
                              "node", "-r", "/app/node_modules/.bm-alias.js", f"/app/{OUT}/tests/templates.integration.js"], text=True)
        return run.returncode
    finally:
        print(py(key, "retire").stdout.strip())


if __name__ == "__main__":
    sys.exit(main())
