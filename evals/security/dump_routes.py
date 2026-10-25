"""Dumps every route of the tenant service with the authentication it currently has, as JSON on stdout.

    docker exec eval-tenant-service python -B -W ignore evals_security_dump_routes.py > routes.json

An entry: method, path, module (the router file), function, deps (names of the dependencies resolved for the route, router-level ones included) and the endpoint's source line."""
import inspect
import json
import sys

import main

rows = []
for r in main.app.routes:
    p = getattr(r, "path", None)
    if not p or not hasattr(r, "dependant"):
        continue
    deps = []

    def walk(d):
        for sub in d.dependencies:
            deps.append(getattr(sub.call, "__name__", str(sub.call)))
            walk(sub)
    walk(r.dependant)
    try:
        line = inspect.getsourcelines(r.endpoint)[1]
    except Exception:
        line = 0
    for m in sorted(r.methods or []):
        if m in ("GET", "POST", "PUT", "PATCH", "DELETE"):
            rows.append({"method": m, "path": p, "module": getattr(r.endpoint, "__module__", "?"), "function": r.endpoint.__name__, "deps": sorted(set(deps)), "line": line})
json.dump(rows, sys.stdout)
