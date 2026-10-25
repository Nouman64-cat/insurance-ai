"""Builds the route-level security matrix: for every route of the tenant service, its current authentication, whether the gateway forwards it, and WHO CALLS IT (searched across every front end and service in the repository).

    python evals/security/route_matrix.py routes.json probe.json > route-matrix.csv

Callers are found by searching the source for the route's path (parameters match any `${...}` / `{...}` / literal). It is a heuristic that finds likely callers; it can miss a call built from pieces and can match a similarly named path, so
a caller list is evidence to be checked, never a proof that nobody else calls the route. Groups: frontend:<app>, service:<name>, test, none."""
import csv
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKIP_DIRS = {"node_modules", ".next", ".git", "__pycache__", "runs", "dist", "build", ".venv", "venv"}
EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".py"}


def group_of(path: Path) -> str:
    parts = path.relative_to(ROOT).parts
    if "tests" in parts or path.name.startswith("test_") or ".test." in path.name or "/evals/" in str(path):
        return "test"
    if parts[0] == "microservices" and parts[1] == "frontend-microservices":
        return f"frontend:{parts[2]}"
    if parts[0] == "microservices" and parts[1] == "backend-microservices":
        return f"service:{parts[2]}"
    return parts[0]


def load_sources():
    out = []
    for dirpath, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            p = Path(dirpath) / f
            if p.suffix in EXT:
                try:
                    out.append((group_of(p), str(p.relative_to(ROOT)), p.read_text(encoding="utf-8", errors="ignore")))
                except OSError:
                    pass
    return out


def pattern(path: str):
    p = re.sub(r"^/tenants/\{[^}]+\}", "", path)
    segs = [s for s in p.split("/") if s]
    if not segs:
        return None
    parts = []
    for s in segs:
        parts.append(r"(?:\$\{[^}]*\}|\{[^}]*\}|[A-Za-z0-9_\-:.%]+)" if s.startswith("{") else re.escape(s))
    return re.compile("/" + "/".join(parts) + r"(?![A-Za-z0-9_\-/])")


def main():
    routes = json.load(open(sys.argv[1]))
    probe = json.load(open(sys.argv[2]))
    src = load_sources()
    w = csv.writer(sys.stdout)
    w.writerow(["method", "route", "router", "current_auth", "anon_direct", "anon_via_gateway", "callers", "caller_files_sample"])
    for r in routes:
        key = f"{r['method']} {r['path']}"
        pr = probe.get(key)
        rx = pattern(r["path"])
        groups, files = {}, []
        if rx is not None and not r["path"].startswith("/internal"):
            for g, rel, text in src:
                if rel.endswith(Path(r["module"].replace(".", "/") + ".py").name) and g == "service:tenant-service":
                    continue
                if rx.search(text):
                    groups[g] = groups.get(g, 0) + 1
                    if len(files) < 3 and g != "test":
                        files.append(rel)
        auth = ",".join(d for d in r["deps"] if d not in ("get_session",) and not d.startswith("<")) or ("bearer-token-only" if any(d.startswith("<fastapi.security.oauth2") for d in r["deps"]) else "NONE")
        anon = pr["direct"][0] if pr else ""
        gw = pr["gateway"][0] if pr else ""
        w.writerow([r["method"], r["path"], r["module"].split(".")[-1], auth, anon, gw, ";".join(f"{g}({n})" for g, n in sorted(groups.items())) or "none found", " | ".join(files)])


main()
