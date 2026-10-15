"""Shared, model-free coordinator for bounded domain specialists."""
import re
from langchain_core.messages import HumanMessage

from commission_specialist import select_specialist as select_commission_specialist, _EXPLICIT as COMMISSION_INTENT
from group_specialist import select_group_specialist, _EXPLICIT as GROUP_WORDS
from servicing_specialist import select_servicing_specialist, _EXPLICIT as SERVICING_WORDS
from underwriting_specialist import select_underwriting_specialist, _EXPLICIT as UNDERWRITING_WORDS
from claims_specialist import select_claims_specialist, _EXPLICIT as CLAIM_WORDS, _COMMISSION as COMMISSION_WORDS


def coordinator_node(state):
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
    selected = None if mixed else (select_servicing_specialist(state) or select_claims_specialist(state) or select_commission_specialist(state) or select_underwriting_specialist(state))
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
        {'agent': selected or 'general', 'reason': f'{selected.title()} domain handoff' if selected else 'Main assistant handoff'} if changed else None}


def route_coordinator(state):
    return {'commission':'commission_agent','claims':'claims_agent','underwriting':'underwriting_agent','servicing':'servicing_agent','group':'group_agent'}.get(state.get('active_specialist'), 'general_agent')
