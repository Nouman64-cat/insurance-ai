"""Shared, model-free coordinator for bounded domain specialists."""
import re
from langchain_core.messages import HumanMessage

from commission_specialist import select_specialist as select_commission_specialist, _EXPLICIT as COMMISSION_INTENT
from group_specialist import select_group_specialist, _EXPLICIT as GROUP_WORDS
from servicing_specialist import select_servicing_specialist, _EXPLICIT as SERVICING_WORDS
from underwriting_specialist import select_underwriting_specialist, _EXPLICIT as UNDERWRITING_WORDS
from claims_specialist import select_claims_specialist, _EXPLICIT as CLAIM_WORDS, _COMMISSION as COMMISSION_WORDS
from track_specialists import select_final_underwriting, select_track_specialist

# Roles whose whole job is one domain: every message goes to that domain's specialist, whatever it asks about —
# keyword routing would hand an off-topic question ("can you do customer acquisition?") to the broad planner,
# whose prompt describes onboarding the role can't do.
PINNED_SPECIALIST = {"ClaimsManager": "claims", "Finance": "finance"}

# Managing staff accounts ("add a Medical Underwriter", "deactivate Ali's account", "make Sana an Admin") is the main
# assistant's job: only it carries the user tools. Without this, "underwriter" or "claims" in the request would hand
# it to a specialist that can only open the Users page.
_USER_ADMIN = re.compile(
    r"\b(?:add|create|invite|onboard|register|remove|delete|deactivate|reactivate|activate|disable|enable|suspend|"
    r"promote|demote)\b[^.?!]*\b(?:users?|accounts?|staff|team\s*members?|underwriters?|adjusters?|admins?|viewers?|"
    r"brokers?|claims\s*managers?)\b"
    r"|\b(?:change|update|set|switch)\b[^.?!]*\broles?\b|\bmake\b[^.?!]*\b(?:an?\s+)?(?:admin|viewer|underwriter|adjuster)\b",
    re.I,
)
ADMIN_ROLES = ("Admin", "SuperAdmin")


def _specialist_selection(state):
    if state.get('user_role') == 'Agent':
        return {'active_specialist': None, 'specialist_handoff': None}

    # A Medical or Financial Underwriter's role is one track: their own subagent handles every message,
    # and a Claims Manager's every message goes to the claims specialist.
    track = select_track_specialist(state) or PINNED_SPECIALIST.get(state.get('user_role') or '')
    if track:
        changed = track != state.get('active_specialist')
        return {'active_specialist': track, 'specialist_handoff':
            {'agent': track, 'reason': f"{track.replace('_', ' ').title()} handoff"} if changed else None}
    messages = state.get('messages') or []
    last = messages[-1] if messages else None
    content = last.content if isinstance(last, HumanMessage) else ''
    text = content if isinstance(content,str) else ' '.join(b.get('text','') for b in content if isinstance(b,dict) and b.get('type') == 'text')
    # Explicitly mixed claims/commission requests stay with the broad planner.
    # A naked "payout" is ambiguous; the previous specialist owns that follow-up.
    mixed = bool(CLAIM_WORDS.search(text) and COMMISSION_WORDS.search(text)) or bool(UNDERWRITING_WORDS.search(text) and COMMISSION_INTENT.search(text))
    # A claim referral to underwriting remains a claims action. Other combined
    # claim/issuance requests already fall back through the claims selector.
    claim_referral = bool(re.search(r'\b(?:refer|resolve|get|show|review)\b.*\bclaim\b.*\bunderwriting\b', text, re.I)) and not re.search(r'\band\b', text, re.I)
    mixed = mixed or bool(UNDERWRITING_WORDS.search(text) and CLAIM_WORDS.search(text) and not claim_referral)
    mixed = mixed or bool(SERVICING_WORDS.search(text) and (CLAIM_WORDS.search(text) or COMMISSION_INTENT.search(text) or UNDERWRITING_WORDS.search(text)))
    if (state.get('user_role') or '') in ADMIN_ROLES and _USER_ADMIN.search(text):
        changed = state.get('active_specialist') is not None
        return {'active_specialist': None, 'specialist_handoff': {'agent': 'general', 'reason': 'Main assistant handoff'} if changed else None}
    selected = None if mixed else (select_servicing_specialist(state) or select_claims_specialist(state) or select_commission_specialist(state)
                                   or select_final_underwriting(state) or select_underwriting_specialist(state))
    # A disabled servicing rollout must fall back to the broad planner rather
    # than leave a premium-schedule request with the previous underwriting scope.
    if selected == 'underwriting' and SERVICING_WORDS.search(text):
        selected = None
    # Group renewals, claims and issuance are one bounded employer workflow.
    # Mixed group/individual or commission requests keep the broad planner.
    group_selected = select_group_specialist(state)
    if GROUP_WORDS.search(text):
        selected = group_selected
    elif group_selected and not (CLAIM_WORDS.search(text) and 'dashboard' in text.lower()) and not COMMISSION_INTENT.search(text):
        selected = group_selected
    changed = selected != state.get('active_specialist')
    return {'active_specialist': selected, 'specialist_handoff':
        {'agent': selected or 'general', 'reason': f"{selected.replace('_', ' ').title()} domain handoff" if selected else 'Main assistant handoff'} if changed else None}


def route_coordinator(state):
    return {'finance':'finance_agent','commission':'commission_agent','claims':'claims_agent','underwriting':'underwriting_agent','servicing':'servicing_agent','group':'group_agent',
            'medical_underwriting':'medical_underwriting_agent','financial_underwriting':'financial_underwriting_agent',
            'final_underwriting':'final_underwriting_agent'}.get(state.get('active_specialist'), 'general_agent')


def coordinator_node(state):
    if state.get('user_role') == 'Agent':
        return {'active_specialist': None, 'specialist_handoff': None,
                'selected_skills': ['lead-customer-acquisition']}
    result = _specialist_selection(state)
    from skills import enabled
    if not enabled():
        return result
    from skills.selector import select
    latest = next((m for m in reversed(state.get("messages") or []) if isinstance(m, HumanMessage)), None)
    content = latest.content if latest else ""
    text = content if isinstance(content, str) else " ".join(b.get("text", "") for b in content if isinstance(b, dict))
    selected = select(text, state.get("user_role") or "", state.get("platform") or "web", state.get("selected_skills") or (), specialist=result.get("active_specialist"))
    import logging
    logging.getLogger(__name__).info("skill_selection skills=%s specialist=%s", selected, result.get("active_specialist") or "general")
    return {**result, "selected_skills": selected}
