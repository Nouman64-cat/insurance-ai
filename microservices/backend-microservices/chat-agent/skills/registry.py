"""Capability inventory derived from real tool declarations; never from skill prose."""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import re

DISCOVERY_TOOLS = frozenset({"search_capabilities", "get_capability_schema"})
GRAPH_TOOLS = frozenset({
    "resolve_customer_type", "get_operation_status", "resume_operation", "upload_document",
    "start_underwriting_journey", "continue_underwriting_journey", "start_claim_journey",
    "continue_claim_journey", "start_group_journey", "continue_group_journey",
})


def words(text: str) -> set[str]:
    # Small deterministic semantic expansion: no provider call, no customer data index.
    aliases = {"earnings": "commission", "brokerage": "commission", "fnol": "claim",
               "household": "family", "employer": "group", "census": "group",
               "clinical": "medical", "affordability": "financial", "revive": "reinstatement",
               "colleague": "user", "staff": "user", "bill": "premium", "complaint": "ticket"}
    tokens = set(re.findall(r"[a-z0-9]+", text.lower().replace("_", " ")))
    tokens |= {w[:-1] for w in tokens if len(w) > 3 and w.endswith("s")}
    tokens -= {"a", "an", "the", "to", "for", "of", "and", "or", "is", "it", "in", "on", "at",
               "my", "me", "this", "that", "please", "can", "you", "do", "with", "by", "from",
               "run", "show", "get", "help", "ignore", "permission", "permissions", "https", "http", "example"}
    return tokens | {aliases[w] for w in tokens if w in aliases}


@dataclass(frozen=True)
class Capability:
    id: str
    description: str
    domain: str
    mutating: bool
    tool: object
    execution: str

    def metadata(self) -> dict:
        return {"capability_id": self.id, "description": self.description[:240],
                "domain": self.domain, "mutating": self.mutating, "execution": self.execution,
                "verification": "Backend result required; registration is not live-service validation."}


@lru_cache(maxsize=1)
def capabilities() -> dict[str, Capability]:
    from tools import ALL_TOOLS
    from permission import MUTATING_TOOLS
    from toolsets import DOMAIN_TOOLS
    from tool_executor import _HANDLERS
    result = {}
    for tool in ALL_TOOLS:
        if tool.name in DISCOVERY_TOOLS:
            continue
        # A declaration without a real execution path must not be advertised.
        if tool.name not in _HANDLERS and tool.name not in GRAPH_TOOLS:
            continue
        domain = next((d for d, names in DOMAIN_TOOLS.items() if tool.name in names), "core")
        result[tool.name] = Capability(tool.name, tool.description, domain,
                                       tool.name in MUTATING_TOOLS, tool,
                                       "graph" if tool.name in GRAPH_TOOLS else "executor")
    return result


def authorized(role: str, platform: str = "web", scope: frozenset[str] | None = None) -> dict[str, Capability]:
    from permission import is_role_allowed
    return {name: cap for name, cap in capabilities().items()
            if is_role_allowed(name, role, platform) and (scope is None or name in scope)}


def search(query: str, role: str, platform: str = "web", domain: str | None = None,
           scope: frozenset[str] | None = None, limit: int = 12) -> list[dict]:
    terms = words(query)
    ranked = []
    for cap in authorized(role, platform, scope).values():
        if domain and cap.domain != domain:
            continue
        score = 4 * len(terms & words(cap.id)) + len(terms & words(cap.description))
        if cap.id == query.strip():
            score += 100
        if score or not terms:
            ranked.append((score, cap.id, cap))
    return [cap.metadata() for _, _, cap in sorted(ranked, key=lambda row: (-row[0], row[1]))[:max(1, min(limit, 25))]]


def schema(capability_id: str, role: str, platform: str = "web", scope: frozenset[str] | None = None) -> dict:
    cap = authorized(role, platform, scope).get(capability_id)
    if cap is None:
        return {"success": False, "error_code": "unavailable_capability", "retryable": False,
                "error": "This capability is unavailable within your permissions and specialist scope. Ask an authorized colleague or use the appropriate workspace."}
    from permission import REQUIRED_ARGS, requires_confirmation
    return {"success": True, **cap.metadata(), "schema": cap.tool.args_schema.model_json_schema(),
            "required_context": REQUIRED_ARGS.get(capability_id, []),
            "confirmation_required": requires_confirmation(capability_id),
            "prerequisites": "Owning service validates tenant, record access, lifecycle and approvals at execution.",
            "message": "Capability loaded for the next model call. Invoke its named tool through the normal permission gate."}
