"""Reproducible metadata/scenario coverage export; does not fabricate backend validation.

Run in chat-agent: python -m skills.demo_validation
Use scripts/inventory_insurance_capabilities.py at repository root for source inventory.
"""
from __future__ import annotations
import csv
import json
from pathlib import Path

from .loader import metadata
from .registry import capabilities, schema

ROLES = ("SuperAdmin", "Admin", "Agent", "Underwriter", "Medical Underwriter", "Financial Underwriter",
         "ClaimsManager", "ClaimsAdjuster", "CustomerService", "Viewer", "Finance", "CustomBroker")


def scenarios():
    from permission import is_role_allowed
    for role in ROLES:
        for cap in capabilities().values():
            yield {"id": f"{role}:{cap.id}", "role": role, "capability": cap.id,
                   "request": f"Please {cap.id.replace('_', ' ')}.",
                   "allowed": is_role_allowed(cap.id, role),
                   "validation": "authorization_and_schema; owning-service execution requires separate evidence"}


def export(output: Path | None = None):
    from permission import is_role_allowed
    output = output or Path(__file__).parent / "reports"
    output.mkdir(exist_ok=True, parents=True)
    caps, skills = capabilities(), metadata()
    import inspect
    from tool_executor import _HANDLERS
    def source(cap):
        handler = _HANDLERS.get(cap.id)
        if handler is None:
            return {"module": "graph/journey", "verification": "existing graph routing"}
        handler = inspect.unwrap(handler)
        return {"module": handler.__module__, "line": inspect.getsourcelines(handler)[1],
                "verification": "implemented handler; execution evidence tracked separately"}
    data = [{**c.metadata(), "handler_source": source(c), "schema": c.tool.args_schema.model_json_schema(),
             "roles": [role for role in ROLES if is_role_allowed(c.id, role)]} for c in caps.values()]
    (output / "capabilities.json").write_text(json.dumps(data, indent=2) + "\n")
    (output / "demo-scenarios.json").write_text(json.dumps(list(scenarios()), indent=2) + "\n")
    with (output / "role-skill-tool-coverage.csv").open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["role", "skill", "capability", "allowed", "execution_path", "live_verification"])
        for role in ROLES:
            for skill in skills:
                for name in skill.capabilities:
                    writer.writerow([role, skill.id, name, str(is_role_allowed(name, role)).lower(), caps[name].execution, "not_asserted_by_inventory"])
    lines = ["# Capability coverage", "", "Generated from declarations, handlers, skills and the existing permission function.",
             "Registration and schema validation do not establish successful owning-service execution.", "",
             f"{len(caps)} capabilities, {len(skills)} skills, {len(ROLES)} role scenarios (CustomBroker exercises the existing unknown-role fallback).", "",
             "| Skill | Registered tools | " + " | ".join(ROLES) + " |",
             "|---|---:|" + "---:|" * len(ROLES)]
    for skill in skills:
        counts = [sum(is_role_allowed(c, role) for c in skill.capabilities) for role in ROLES]
        lines.append(f"| {skill.id} | {len(skill.capabilities)} | " + " | ".join(map(str, counts)) + " |")
    lines += ["", "Counts show discoverable permissions, not permission to complete every step of a workflow.",
              "The CSV includes both allowed and denied role/skill/tool combinations. Backend record ownership, tenant isolation, delegation and lifecycle checks still apply.", "", "## Explicit limitations", ""]
    for skill in skills:
        lines.extend(f"- {skill.id}: {item}" for item in skill.unsupported)
    lines += ["- Universal exactly-once mutation execution is not guaranteed. Existing owning-service idempotency and duplicate checks remain authoritative; unknown outcomes require verification.",
              "- Natural language examples are regression inputs. Deterministic mock-provider tests do not establish real-provider completion rates.",
              "- Backend routes without a confirmed adapter are inventoried separately; no arbitrary endpoint dispatcher is available."]
    (output / "coverage.md").write_text("\n".join(lines) + "\n")
    print(f"Exported {len(caps)} capabilities, {len(skills)} skills and {len(list(scenarios()))} role/capability scenarios")


if __name__ == "__main__":
    export()
