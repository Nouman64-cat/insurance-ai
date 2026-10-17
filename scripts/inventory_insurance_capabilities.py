#!/usr/bin/env python3
"""Static evidence inventory across backend and client applications.

No credentials, environment files or user records are read. Dynamic paths are
marked as expressions; route-to-adapter matching is deliberately not guessed.
Generate the runtime capability export first: docker compose exec -T chat-agent
python -m skills.demo_validation
"""
from __future__ import annotations
import ast
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "microservices/backend-microservices/chat-agent/skills/reports"
METHODS = {"get", "post", "put", "patch", "delete", "websocket"}


def route_inventory():
    result = []
    for path in sorted((ROOT / "microservices/backend-microservices").rglob("*.py")):
        if any(part in {".venv", "__pycache__", "node_modules"} for part in path.parts) or path.name.startswith("test"):
            continue
        try:
            tree = ast.parse(path.read_text())
        except (SyntaxError, UnicodeError):
            continue
        prefixes = {}
        for node in tree.body:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                if ast.unparse(node.value.func).endswith("APIRouter"):
                    prefix = next((kw.value for kw in node.value.keywords if kw.arg == "prefix"), None)
                    for target in node.targets:
                        if isinstance(target, ast.Name):
                            prefixes[target.id] = ast.literal_eval(prefix) if isinstance(prefix, ast.Constant) else ""
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for dec in node.decorator_list:
                if not isinstance(dec, ast.Call) or not isinstance(dec.func, ast.Attribute) or dec.func.attr not in METHODS or not dec.args:
                    continue
                arg = dec.args[0]
                route = arg.value if isinstance(arg, ast.Constant) else ast.unparse(arg)
                receiver = ast.unparse(dec.func.value)
                result.append({"service": path.relative_to(ROOT / "microservices/backend-microservices").parts[0],
                               "method": dec.func.attr.upper(), "router_path": prefixes.get(receiver, "") + str(route),
                               "handler": node.name, "source": str(path.relative_to(ROOT)), "line": node.lineno,
                               "validation": "source_verified; live_execution_not_asserted", "chat_adapter": "requires_contract_mapping"})
    return result


def main():
    OUTPUT.mkdir(exist_ok=True, parents=True)
    routes = route_inventory()
    (OUTPUT / "backend-routes.json").write_text(json.dumps(routes, indent=2) + "\n")
    clients = []
    for surface in [ROOT / "microservices/frontend-microservices", ROOT / "mobile-apps"]:
        for manifest in sorted(surface.glob("*/package.json")):
            package = json.loads(manifest.read_text())
            clients.append({"surface": str(manifest.parent.relative_to(ROOT)), "package": package.get("name"),
                            "scripts": sorted(package.get("scripts", {})),
                            "integration": "Existing SSE/tool results and navigation protocol retained; no client API changes required."})
    (OUTPUT / "client-surfaces.json").write_text(json.dumps(clients, indent=2) + "\n")
    # Read canonical seeded roles using AST rather than importing the service and its database.
    seed = ROOT / "microservices/backend-microservices/tenant-service/role_seed.py"
    roles = next(ast.literal_eval(n.value) for n in ast.parse(seed.read_text()).body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "SEED_ROLES" for t in n.targets))
    summary = {"backend_routes": len(routes), "services": sorted({r["service"] for r in routes}), "seed_roles": roles,
               "additional_chat_roles": ["Medical Underwriter", "Financial Underwriter", "CustomerService"],
               "clients": clients, "methodology": "Route declarations and handlers are implementation evidence; no README or UI was treated as an executable capability.",
               "known_gaps": ["Some internal/backend routes are deliberately not exposed to chat.", "Tenant deletion, role deletion, API-key editing and unsupported lifecycle operations require the owning UI.", "Every route-to-adapter contract has not been live-validated; unmatched routes are not automatically exposed."]}
    (OUTPUT / "system-inventory.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Inventoried {len(routes)} backend routes in {len(summary['services'])} services and {len(clients)} client applications")


if __name__ == "__main__":
    main()
