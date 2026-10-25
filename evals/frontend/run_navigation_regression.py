"""Navigation regression test of the AI Evaluation Center.

    python evals/frontend/run_navigation_regression.py

Compiles frontend/tests/navigation.regression.ts in the frontend container and runs it there against the container's own dev server: old routes
redirect with their query string, the tabs are served, the sidebar has no redundant entries, every feature is still mounted, state lives in the
address. No backend data is needed or changed.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRONTEND, OUT = "insurance-frontend", "node_modules/.bm-test"


def main() -> int:
    built = subprocess.run(["docker", "exec", FRONTEND, "sh", "-c", f"cd /app && rm -rf {OUT} && npx tsc -p tests/tsconfig.json"], text=True, capture_output=True)
    if built.returncode:
        print("the test does not compile:\n", built.stdout[-1500:])
        return 2
    alias = (ROOT / "evals/frontend/run_benchmarking_integration.py").read_text().split('ALIAS = """')[1].split('"""')[0]
    subprocess.run(["docker", "exec", "-i", FRONTEND, "sh", "-c", "cat > /app/node_modules/.bm-alias.js"], text=True, input=alias)
    return subprocess.run(["docker", "exec", "-w", "/app", "-e", f"BM_OUT=/app/{OUT}", FRONTEND, "node", "-r", "/app/node_modules/.bm-alias.js", f"/app/{OUT}/tests/navigation.regression.js"], text=True).returncode


if __name__ == "__main__":
    sys.exit(main())
