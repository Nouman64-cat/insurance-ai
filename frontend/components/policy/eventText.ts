// Plain-language rendering of policy lifecycle events: they are stored with
// machine names (proposal_status_change, PolicyIssued), joined-up statuses
// (UnderReview) and user ids.
import type { PolicyEvent } from "@/app/services/policies";
import { tx } from "@/lib/i18n/tx";

/** "UnderReview" / "under_review" / "PENDING_PAYMENT" → "Under review". */
export function humanize(raw: string | null | undefined): string {
  if (!raw) return "";
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const EVENT_TITLES: Record<string, string> = {
  case_opened: "Application opened",
  case_linked_retroactively: "Application linked to this policy",
  PolicyQuoted: "Quotation prepared",
  UnderwritingApproved: "Underwriting approved",
  PolicyIssued: "Policy issued",
  PaymentConfirmed: "Payment confirmed",
  PaymentFailed: "Payment failed",
  PremiumCollected: "Premium collected",
  PremiumPaymentFailed: "Premium payment failed",
  PremiumWaived: "Premium waived",
  PremiumReminderSent: "Premium reminder sent",
  PolicyGracePeriod: "Policy entered its grace period",
  PolicyLapsed: "Policy lapsed",
  PolicyRevived: "Policy revived",
  PolicyReinstated: "Policy reinstated",
  PolicyRenewed: "Policy renewed",
  PolicyCancelled: "Policy cancelled",
  PolicyEndorsed: "Policy endorsed",
  PolicyNotTakenUp: "Policy not taken up",
  PolicyTerminatedByClaim: "Policy ended by a claim",
  PolicyholderIdAssigned: "Policyholder ID assigned",
  WelcomeKitGenerated: "Welcome kit generated",
  WelcomeSent: "Welcome pack sent",
  ReinsurerReferred: "Referred to reinsurer",
  ReinsurerReferralWithdrawn: "Reinsurance referral withdrawn",
  ReinsurerAcceptedStandardTerms: "Reinsurer accepted on standard terms",
  ReinsurerTermsImposed: "Reinsurer terms applied",
  ReinsurerPostponed: "Reinsurer postponed the risk",
  ReinsurerDeclined: "Reinsurer declined the risk",
  RequirementsDetermined: "Underwriting requirements determined",
  VerificationCompleted: "Verification completed",
  PlanChanged: "Plan changed",
  PaymentPlanRestructured: "Payment plan restructured",
};

export function eventTitle(evt: PolicyEvent): string {
  const to = humanize(evt.to_status);
  if (evt.event_type === "proposal_status_change" && to) return tx("Proposal moved to {0}", { 0: to.toLowerCase() });
  if (evt.event_type === "case_decision") {
    const t = (evt.to_status ?? "").toLowerCase();
    if (t.startsWith("approv")) return tx("Application approved");
    if (t.startsWith("reject") || t.startsWith("declin")) return tx("Application declined");
    return to ? tx("Underwriting decision: {0}", { 0: to.toLowerCase() }) : tx("Underwriting decision recorded");
  }
  return tx(EVENT_TITLES[evt.event_type] ?? humanize(evt.event_type));
}

const SYSTEM_ACTORS: Record<string, string> = {
  system: "the system",
  scheduler: "a scheduled job",
  gateway: "the payment gateway",
  operations: "operations",
};

export function eventActor(evt: PolicyEvent): string {
  if (evt.actor_name) return evt.actor_name;
  const key = (evt.actor || "").toLowerCase();
  if (SYSTEM_ACTORS[key]) return tx(SYSTEM_ACTORS[key]);
  return /^[0-9a-f-]{36}$/i.test(evt.actor) ? tx("a team member") : evt.actor;
}

/** "Today at 12:09 PM", "Yesterday at 11:55 PM", "13 Oct 2026 at 11:55 PM". */
export function friendlyTime(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000);
  if (diff === 0) return tx("Today at {0}", { 0: time });
  if (diff === 1) return tx("Yesterday at {0}", { 0: time });
  return tx("{0} at {1}", { 0: d.toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" }), 1: time });
}
