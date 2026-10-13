"""Explicit conversational revisions never count as consent to a pending action."""
import re

class ReviseConversation(Exception):
    def __init__(self,message): self.message=message

def revision_message(answer):
    if isinstance(answer,dict) and answer.get('kind')=='revise':
        message=answer.get('message')
        if isinstance(message,str) and 0<len(message.strip())<=4000:return message.strip()
    return None

def is_revision_text(answer):
    if not isinstance(answer,str):return False
    return bool(re.search(r'\b(?:go back|change direction|start over|switch|instead|actually|change (?:the |my |this )?(?:plan|insurance|customer|type)|(?:want|need|prefer) (?:a |the )?family)\b|واپس|تبدیل|فیملی.*چاہ|خاندانی.*چاہ',answer,re.I))

def select_plan(answer,options):
    if not isinstance(answer,str) or not answer.strip():return None
    needle=answer.strip().casefold()
    exact=[p for p in options if p.casefold()==needle]
    if len(exact)==1:return exact[0]
    matches=[p for p in options if needle in p.casefold() or p.casefold() in needle]
    return matches[0] if len(matches)==1 else None
