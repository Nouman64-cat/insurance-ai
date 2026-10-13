import type { Tone } from "@/components/satellite/ui";
import type { Category, Status } from "./api";

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
