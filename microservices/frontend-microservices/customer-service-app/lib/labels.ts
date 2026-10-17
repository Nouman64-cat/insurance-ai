import type { Tone } from "@/components/satellite/ui";
import type { Category, Me, Status, Ticket } from "./api";

export const STATUS_LABEL: Record<Status, string> = {
  OPEN: "Open", IN_PROGRESS: "In progress", WAITING_CUSTOMER: "Waiting on customer", RESOLVED: "Resolved", CLOSED: "Closed", CANCELLED: "Cancelled",
};
export const STATUS_TONE: Record<Status, Tone> = {
  OPEN: "blue", IN_PROGRESS: "indigo", WAITING_CUSTOMER: "amber", RESOLVED: "emerald", CLOSED: "slate", CANCELLED: "slate",
};
export const CATEGORY_LABEL: Record<Category, string> = {
  GENERAL: "General enquiry", POLICY_SERVICING: "Policy servicing", BILLING: "Billing", CLAIM_ENQUIRY: "Claim enquiry", COMPLAINT: "Complaint", DOCUMENTS: "Documents",
};
export const CATEGORY_HINT: Record<Category, string> = {
  GENERAL: "Anything that doesn't fit the other categories.",
  POLICY_SERVICING: "Address changes, nominee updates, duplicate documents, surrender or maturity questions.",
  BILLING: "Premium payments, receipts, refunds and installment questions.",
  CLAIM_ENQUIRY: "Progress or documents for a claim. Claim decisions stay in Claims.",
  COMPLAINT: "Dissatisfaction with the service, an agent or a decision.",
  DOCUMENTS: "Missing, wrong or requested documents.",
};

/** The transitions the service allows (services/customer-service), and what each is called as an action. */
export const TRANSITIONS: Record<Status, Status[]> = {
  OPEN: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["WAITING_CUSTOMER", "RESOLVED", "CANCELLED"],
  WAITING_CUSTOMER: ["IN_PROGRESS", "RESOLVED", "CANCELLED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: ["IN_PROGRESS"],
  CANCELLED: [],
};
export const ACTION_LABEL: Record<Status, string> = {
  OPEN: "Reopen", IN_PROGRESS: "Start working", WAITING_CUSTOMER: "Wait for customer", RESOLVED: "Mark resolved", CLOSED: "Close ticket", CANCELLED: "Cancel ticket",
};

export const CLOSED_STATUSES: Status[] = ["RESOLVED", "CLOSED", "CANCELLED"];

/** Status changes are stored as "OPEN -> IN_PROGRESS: reason". */
export function parseStatusEvent(body: string): { from?: Status; to?: Status; reason: string } {
  const m = body.match(/^([A-Z_]+) -> ([A-Z_]+): ([\s\S]*)$/);
  return m ? { from: m[1] as Status, to: m[2] as Status, reason: m[3] } : { reason: body };
}

/** What each status means, in plain words. */
export const STATUS_HELP: Record<Status, string> = {
  OPEN: "New. Nobody has started on it yet.",
  IN_PROGRESS: "Someone is working on it.",
  WAITING_CUSTOMER: "We asked the customer something and are waiting for the answer.",
  RESOLVED: "Solved. It stays open a little in case the customer replies, then it is closed.",
  CLOSED: "Finished. Nothing more to do (it can be reopened).",
  CANCELLED: "Not needed any more.",
};

/** One line under each ticket in the list: what the person looking at it should do next. */
export function nextHint(t: Ticket, me: Me | null): string {
  if (!me || t.status === "CLOSED" || t.status === "CANCELLED") return "";
  if (!me.staff) {
    return ({ OPEN: "Received. Service staff will pick it up.", IN_PROGRESS: "Staff are working on it.", WAITING_CUSTOMER: "They need an answer from you. Open it and reply.",
      RESOLVED: "Solved. Open it to read the outcome.", CLOSED: "", CANCELLED: "" } as Record<Status, string>)[t.status];
  }
  const mine = t.assignee_id === me.id || (!!t.assignee_name && t.assignee_name === (me.full_name || me.email));
  if (!t.assignee_name) return "Nobody has this yet. Open it and press “Take this ticket”.";
  if (!mine) return `${t.assignee_name} is handling this.`;
  return ({ OPEN: "You have it. Press “Start working” when you begin.", IN_PROGRESS: "Reply to the customer, then mark it resolved.", WAITING_CUSTOMER: "Waiting for the customer. Nothing to do until they reply.",
    RESOLVED: "Close it once the customer is happy.", CLOSED: "", CANCELLED: "" } as Record<Status, string>)[t.status];
}

export const CATEGORY_ICON: Record<Category, string> = { GENERAL: "💬", POLICY_SERVICING: "📄", BILLING: "💳", CLAIM_ENQUIRY: "🩺", COMPLAINT: "⚠️", DOCUMENTS: "📎" };

/** The path a ticket normally takes, for the progress strip. "Waiting on customer" is a pause on the way, not a step. */
export const STEPS: { status: Status; label: string }[] = [
  { status: "OPEN", label: "New" }, { status: "IN_PROGRESS", label: "Being worked on" }, { status: "RESOLVED", label: "Solved" }, { status: "CLOSED", label: "Closed" },
];
export const stepIndex = (s: Status): number => (s === "WAITING_CUSTOMER" ? 1 : s === "CANCELLED" ? -1 : STEPS.findIndex((x) => x.status === s));

export type SlaState = "met" | "breached" | "due_soon" | "on_track" | "none";
/** SLA is the answer deadline, separate from the ticket's status and from who is assigned. */
export function slaState(t: Ticket): SlaState {
  if (!t.due_at) return "none";
  if (CLOSED_STATUSES.includes(t.status)) return "met";
  const left = new Date(t.due_at).getTime() - Date.now();
  return t.overdue || left < 0 ? "breached" : left < 24 * 3_600_000 ? "due_soon" : "on_track";
}
export const SLA_LABEL: Record<SlaState, string> = { met: "Closed", breached: "Breached", due_soon: "Due soon", on_track: "On track", none: "—" };
export const SLA_TONE: Record<SlaState, Tone> = { met: "slate", breached: "red", due_soon: "amber", on_track: "emerald", none: "slate" };
export const shortId = (id: string) => `TKT-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
export const isOpenStatus = (s: Status) => !CLOSED_STATUSES.includes(s);
