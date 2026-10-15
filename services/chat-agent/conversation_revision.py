"""Explicit conversational revisions never count as consent to a pending action."""
import re

class ReviseConversation(Exception):
    def __init__(self,message): self.message=message

def revision_message(answer):
    if isinstance(answer,dict) and answer.get('kind')=='revise':
        message=answer.get('message')
        if isinstance(message,str) and 0<len(message.strip())<=4000:return message.strip()
    return None

# Every everyday way of backing out of a question — "no no", "wait", "wrong one",
# "go back", "I meant…", Roman Urdu "galat" / "wapas" — so the user never needs a
# special button to change an earlier answer. Kept identical to
# automation-chat/lib/agent/revision.ts. A false positive only means the text goes
# to the agent as a fresh message instead of being taken as the literal answer.
REVISION_PATTERN = re.compile(
    r"\b(?:go(?:ing)? back|take me back|step back|back to (?:the )?(?:previous|last|earlier|start)|change direction|start over|start again|switch|instead|actually|change (?:the |my |this )?(?:plan|insurance|customer|type)|(?:want|need|prefer) (?:a |the )?family|no,? no|no,? wait|scratch that|never ?mind|cancel (?:that|this|it)|undo|wrong (?:one|choice|option|policy|customer|claim|person|plan|answer|selection)|(?:that'?s|that is|it'?s|this is) (?:wrong|not (?:right|correct|it|what i (?:want|meant)))|not (?:this|that) one|previous (?:step|question|choice|option|answer|screen)|(?:my )?mistake|mistakenly|i meant|change (?:it|that|this|my (?:mind|answer|choice|selection))|changed my mind|(?:want|like|need) to change|let me change|(?:pick|choose|select) (?:a )?different|another (?:one|policy|customer|option|plan)|nahi?n?,? nahi?n?|nhi,? nhi|galat|ghalat|wapas|wapis|pichl[ae]|ruko|badal(?: do| dein|na|ni))\b|^\s*(?:wait|hold on|hang on|oops|whoops)\b|واپس|تبدیل|غلط|رکو|نہیں،? نہیں|فیملی.*چاہ|خاندانی.*چاہ",
    re.I,
)

def is_revision_text(answer):
    if not isinstance(answer,str):return False
    return bool(REVISION_PATTERN.search(answer))

def select_plan(answer,options):
    if not isinstance(answer,str) or not answer.strip():return None
    needle=answer.strip().casefold()
    exact=[p for p in options if p.casefold()==needle]
    if len(exact)==1:return exact[0]
    matches=[p for p in options if needle in p.casefold() or p.casefold() in needle]
    return matches[0] if len(matches)==1 else None
