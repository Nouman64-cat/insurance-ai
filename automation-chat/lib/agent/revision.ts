/** Revisions never act as consent or as a default plan selection.
 *
 * Every everyday way of backing out of a question — "no no", "wait", "wrong one",
 * "go back", "I meant…", Roman Urdu "galat" / "wapas" — so the user never needs a
 * special button to change an earlier answer. Kept identical to
 * services/chat-agent/conversation_revision.py.
 */
const REVISION_PATTERN =
  /\b(?:go(?:ing)? back|take me back|step back|back to (?:the )?(?:previous|last|earlier|start)|change direction|start over|start again|switch|instead|actually|change (?:the |my |this )?(?:plan|insurance|customer|type)|(?:want|need|prefer) (?:a |the )?family|no,? no|no,? wait|scratch that|never ?mind|cancel (?:that|this|it)|undo|wrong (?:one|choice|option|policy|customer|claim|person|plan|answer|selection)|(?:that'?s|that is|it'?s|this is) (?:wrong|not (?:right|correct|it|what i (?:want|meant)))|not (?:this|that) one|previous (?:step|question|choice|option|answer|screen)|(?:my )?mistake|mistakenly|i meant|change (?:it|that|this|my (?:mind|answer|choice|selection))|changed my mind|(?:want|like|need) to change|let me change|(?:pick|choose|select) (?:a )?different|another (?:one|policy|customer|option|plan)|nahi?n?,? nahi?n?|nhi,? nhi|galat|ghalat|wapas|wapis|pichl[ae]|ruko|badal(?: do| dein|na|ni))\b|^\s*(?:wait|hold on|hang on|oops|whoops)\b|واپس|تبدیل|غلط|رکو|نہیں،? نہیں|فیملی.*چاہ|خاندانی.*چاہ/i;

export function isRevisionText(value: string): boolean {
  return REVISION_PATTERN.test(value);
}
export function revision(value: string) { return {kind: "revise", message: value.trim()}; }
