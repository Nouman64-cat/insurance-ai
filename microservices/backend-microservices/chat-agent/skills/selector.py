"""Bounded deterministic intent retrieval, with context carry-over for short replies."""
from .loader import metadata
from .registry import authorized, words


def select(text: str, role: str, platform: str = "web", previous=(), scope=None, limit: int = 3, specialist=None) -> list[str]:
    permitted = authorized(role, platform, scope)
    terms = words(text)
    ranked = []
    isolated = {"finance": {"finance-payments", "finance-reconciliation", "failure-recovery"},"medical_underwriting": {"medical-underwriting", "underwriting-decisions"},
                "financial_underwriting": {"financial-underwriting", "underwriting-decisions"},
                "final_underwriting": {"final-underwriting", "pre-underwriting", "document-intelligence", "underwriting-decisions"},
                "claims": {"claim-settlement-approval", "claims-management", "claim-financial-underwriting", "policy-exit-processing", "claims-authority", "failure-recovery"},
                "commission": {"commissions", "failure-recovery"},
                "group": {"corporate-insurance", "failure-recovery"},
                "servicing": {"policy-servicing", "premium-management", "premium-operations", "renewal-processing",
                              "reinstatement-processing", "policy-exit-processing", "failure-recovery"},
                "underwriting": {"individual-insurance", "pre-underwriting", "final-underwriting", "policy-issuance", "document-intelligence",
                                 "underwriting-decisions", "reinsurance-management", "failure-recovery"}}
    for skill in metadata():
        if specialist in isolated and skill.id not in isolated[specialist]:
            continue
        if not set(skill.capabilities) & permitted.keys():
            continue
        score = 3 * sum(len(intent_terms) for intent in skill.intents
                        if (intent_terms := words(intent)) and intent_terms <= terms) + len(terms & words(skill.purpose))
        if len(terms) <= 3 and skill.id in previous:
            score += 4
        if score >= 3:
            ranked.append((score, skill.id))
    return [sid for _, sid in sorted(ranked, key=lambda row: (-row[0], row[1]))[:limit]]


def binding_names(state: dict, limit: int = 24) -> frozenset[str]:
    """Resolve relevant skills to authorized tools; explicitly loaded tools take priority."""
    from langchain_core.messages import HumanMessage
    role, platform = state.get("user_role") or "", state.get("platform") or "web"
    permitted = authorized(role, platform)
    selected = set(state.get("selected_skills") or [])
    skill_tools = set().union(*(set(s.capabilities) for s in metadata() if s.id in selected)) if selected else set()
    latest = next((m for m in reversed(state.get("messages") or []) if isinstance(m, HumanMessage)), None)
    from .registry import search
    matches = search(str(latest.content) if latest else "", role, platform, scope=frozenset(skill_tools), limit=12)
    loaded = [name for name in reversed(state.get("active_capabilities") or []) if name in permitted]
    return frozenset(list(dict.fromkeys([*loaded, *(m["capability_id"] for m in matches)]))[:limit])
