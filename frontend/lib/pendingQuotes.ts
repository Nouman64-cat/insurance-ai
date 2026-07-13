// Cross-page hand-off: the Applicants page registers an applicant here right
// after creation, and ClientLayout's global poller watches for the
// background quote worker (Kafka) to generate their PremiumQuote rows, then
// shows a toast — regardless of which page the user has navigated to since.

export const PENDING_QUOTES_STORAGE_KEY = "insurance_ai_pending_quotes";
export const PENDING_QUOTES_EVENT = "insurance_ai_new_pending_quote";

export interface PendingQuoteWatch {
  id: string;
  name: string;
}

export function registerPendingQuote(id: string, name: string): void {
  if (typeof window === "undefined") return;
  let existing: PendingQuoteWatch[] = [];
  try {
    existing = JSON.parse(localStorage.getItem(PENDING_QUOTES_STORAGE_KEY) || "[]");
  } catch {
    existing = [];
  }
  localStorage.setItem(PENDING_QUOTES_STORAGE_KEY, JSON.stringify([...existing, { id, name }]));
  window.dispatchEvent(new Event(PENDING_QUOTES_EVENT));
}
