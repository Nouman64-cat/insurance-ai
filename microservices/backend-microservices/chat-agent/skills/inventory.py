"""Live, secret-free inventory derived from the deployed registries and scopes."""
import os


def build(roles: list[str]) -> dict:
    from tools import ALL_TOOLS
    from permission import is_role_allowed, MUTATING_TOOLS
    from .loader import metadata
    from .registry import capabilities, GRAPH_TOOLS, DISCOVERY_TOOLS
    from commission_specialist import COMMISSION_TOOLS
    from claims_specialist import CLAIMS_TOOLS
    from finance_specialist import FINANCE_TOOLS
    from underwriting_specialist import UNDERWRITING_TOOLS
    from servicing_specialist import SERVICING_TOOLS
    from group_specialist import GROUP_TOOLS
    from track_specialists import SCOPES
    from . import enabled

    skills = metadata()
    caps = capabilities()
    scopes = [
        ("finance", "Finance specialist", "finance_agent", FINANCE_TOOLS, "FINANCE_SPECIALIST_ENABLED"),
        ("commission", "Commission specialist", "commission_agent", COMMISSION_TOOLS, "COMMISSION_SPECIALIST_ENABLED"),
        ("claims", "Claims specialist", "claims_agent", CLAIMS_TOOLS, "CLAIMS_SPECIALIST_ENABLED"),
        ("underwriting", "Underwriting specialist", "underwriting_agent", UNDERWRITING_TOOLS, "UNDERWRITING_SPECIALIST_ENABLED"),
        ("servicing", "Policy servicing specialist", "servicing_agent", SERVICING_TOOLS, "SERVICING_SPECIALIST_ENABLED"),
        ("group", "Corporate insurance specialist", "group_agent", GROUP_TOOLS, "GROUP_SPECIALIST_ENABLED"),
        ("medical_underwriting", "Medical underwriting specialist", "medical_underwriting_agent", SCOPES["medical_underwriting"], "TRACK_SPECIALISTS_ENABLED"),
        ("financial_underwriting", "Financial underwriting specialist", "financial_underwriting_agent", SCOPES["financial_underwriting"], "TRACK_SPECIALISTS_ENABLED"),
        ("final_underwriting", "Final underwriting specialist", "final_underwriting_agent", SCOPES["final_underwriting"], "TRACK_SPECIALISTS_ENABLED"),
    ]
    def permissions(names):
        return sorted(role for role in roles if any(is_role_allowed(n, role) for n in names))
    subagents = [{"id": sid, "name": title, "node": node,
                  "enabled": os.getenv(flag, "true").lower() not in {"false", "0", "off"},
                  "tools": sorted(names), "roles": ["Finance"] if sid == "finance" else permissions(names)}
                 for sid, title, node, names, flag in scopes]
    tools = []
    for tool in ALL_TOOLS:
        cap = caps.get(tool.name)
        tools.append({"id": tool.name, "name": tool.name.replace("_", " ").capitalize(),
                      "description": tool.description, "domain": cap.domain if cap else "discovery",
                      "mutating": tool.name in MUTATING_TOOLS,
                      "available": tool.name not in DISCOVERY_TOOLS or enabled(),
                      "execution": "graph" if tool.name in GRAPH_TOOLS else "executor",
                      "roles": permissions([tool.name]),
                      "subagents": [sub["id"] for sub in subagents if tool.name in sub["tools"]],
                      "skills": [s.id for s in skills if tool.name in s.capabilities],
                      "schema": tool.args_schema.model_json_schema()})
    return {"skill_agent_enabled": enabled(), "roles": sorted(roles),
            "agents": [{"id": "coordinator", "name": "Insurance AI coordinator", "node": "agent",
                        "description": "Routes requests to the general assistant or a specialist, preserving role and conversation context.",
                        "tools": [], "subagents": [s[0] for s in scopes]},
                       {"id": "general", "name": "General assistant", "node": "general_agent",
                        "description": "Plans authorized cross-domain work with domain packs and on-demand capabilities.",
                        "tools": sorted(t.name for t in ALL_TOOLS), "subagents": []}],
            "subagents": subagents, "tools": sorted(tools, key=lambda t: t["id"]),
            "skills": [{"id": s.id, "name": s.id.replace("-", " ").title(), "purpose": s.purpose,
                        "intents": s.intents, "roles": permissions(s.capabilities), "tools": s.capabilities,
                        "prerequisites": s.prerequisites, "business_rules": s.business_rules,
                        "approvals": s.approvals, "verification": s.verification,
                        "unsupported": s.unsupported, "steps": [step.model_dump() for step in s.steps]}
                       for s in skills],
            "journeys": ["Individual underwriting", "Claims", "Corporate insurance"],
            "limits": {"max_bound_tools": 128, "max_loaded_capabilities": 24, "max_selected_skills": 3},
            "note": "Tool lists show registered scope. Every execution still requires current role, platform, tenant, record and backend approval checks. Registration does not establish live-service validation."}
