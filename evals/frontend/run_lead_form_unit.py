"""Runs frontend/tests/leadTemplate.unit.ts: what the Add Customer form draws from the Lead acquisition template and what it saves."""
import subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_templates_integration as t

def main() -> int:
    key = f"lead_unit_{__import__('uuid').uuid4().hex[:6]}"
    made = t.py(key, "create")
    token = (made.stdout.strip().splitlines() or [""])[-1]
    try:
        built = subprocess.run(["docker", "exec", t.FRONTEND, "sh", "-c", f"cd /app && rm -rf {t.OUT} && npx tsc -p tests/tsconfig.json"], text=True, capture_output=True)
        if built.returncode:
            print(built.stdout[-1500:]); return 2
        alias = (t.ROOT / "evals/frontend/run_benchmarking_integration.py").read_text().split('ALIAS = """')[1].split('"""')[0]
        subprocess.run(["docker", "exec", "-i", t.FRONTEND, "sh", "-c", "cat > /app/node_modules/.bm-alias.js"], text=True, input=alias)
        return subprocess.run(["docker", "exec", "-e", f"TPL_TOKEN={token}", "-e", "NEXT_PUBLIC_API_URL=http://api-gateway:8000", "-e", f"BM_OUT=/app/{t.OUT}", t.FRONTEND,
                               "node", "-r", "/app/node_modules/.bm-alias.js", f"/app/{t.OUT}/tests/leadTemplate.unit.js"], text=True).returncode
    finally:
        t.py(key, "retire")

if __name__ == "__main__":
    sys.exit(main())
