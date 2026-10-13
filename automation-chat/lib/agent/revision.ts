/** Revisions never act as consent or as a default plan selection. */
export function isRevisionText(value: string): boolean {
  return /\b(?:go back|change direction|start over|switch|instead|actually|change (?:the |my |this )?(?:plan|insurance|customer|type)|(?:want|need|prefer) (?:a |the )?family)\b|واپس|تبدیل|فیملی.*چاہ|خاندانی.*چاہ/i.test(value);
}
export function revision(value: string) { return {kind: "revise", message: value.trim()}; }
