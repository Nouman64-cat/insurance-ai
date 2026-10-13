import Link from "next/link";
import { tx } from "@/lib/i18n/tx";
import { appHref } from "@/lib/appLinks";

// Where a lead is on its way to a policy, readable at a glance in a list.
//
// Five stages, drawn as five segments that fill left to right:
//   1 New lead  ->  2 Proposal  ->  3 Under review  ->  4 Underwriting  ->  5 Policy
// The word beside the bar says exactly where it stands; colour only says whether it is moving
// (blue), needs someone (amber), is done (green) or has stopped (red / grey).

export const LEAD_STAGES = ["New lead", "Proposal", "Review", "Underwriting", "Policy"] as const;

type Tone = "blue" | "amber" | "green" | "red" | "slate";

export interface LeadStageInfo {
  /** Where the page for this stage is, and what to call the link. None for a new lead (the lead is the page) and a closed one. */
  href?: string;
  linkLabel?: string;
  /** Segments filled, 0 to 5. */
  step: number;
  label: string;
  note: string;
  tone: Tone;
}

interface LeadLike {
  status: string;
  /** The most advanced proposal (quote) the lead has. */
  proposalStatus?: string | null;
  /** The most advanced underwriting case the lead has. */
  caseStatus?: string | null;
}

const CASE_NOTE: Record<string, string> = {
  New: "Case opened",
  InProgress: "Checks under way",
  "Pending Documents": "Waiting on documents",
  "Under Review": "Underwriter review",
};

export function leadStage(lead: LeadLike): LeadStageInfo {
  // A draft is a proposal; once submitted it is an application.
  const proposal = { href: "/proposal", linkLabel: "Open Proposal" };
  const application = { href: "/proposal", linkLabel: "Open Application" };
  const underwriting = { href: "/underwriting?tab=pre-underwriting", linkLabel: "Open Underwriting" };
  const issuance = { href: "/policy-issuance", linkLabel: "Open Issuance" };

  if (lead.status === "NOT_INTERESTED") return { step: 0, label: "Not interested", note: "Closed", tone: "slate" };
  if (lead.status === "POLICYHOLDER" || lead.proposalStatus === "Active")
    return { step: 5, label: "Policy active", note: "Cover is live", tone: "green", href: "/admin/policyholders", linkLabel: "View policy" };
  if (lead.proposalStatus === "Issued" || lead.proposalStatus === "PendingPayment")
    return { step: 5, label: "Policy issued", note: "Awaiting first premium", tone: "green", ...issuance };

  // An underwriting case is open (or decided): that is the furthest point
  if (lead.caseStatus === "Approved") return { step: 4, label: "Approved", note: "Ready to issue", tone: "green", ...issuance };
  if (lead.caseStatus === "Rejected") return { step: 4, label: "Declined in underwriting", note: "Stopped", tone: "red", ...underwriting };
  if (lead.caseStatus && lead.caseStatus !== "Closed")
    return { step: 4, label: "In underwriting", note: CASE_NOTE[lead.caseStatus] ?? "Case open", tone: "blue", ...underwriting };

  switch (lead.proposalStatus) {
    case "Approved":
    case "AcceptedWithLoadings": return { step: 4, label: "Approved", note: "Ready to issue", tone: "green", ...issuance };
    case "Declined": return { step: 2, label: "Rejected", note: "Stopped before underwriting", tone: "red", ...application };
    case "InformationRequested": return { step: 2, label: "Info requested", note: "Waiting on details", tone: "amber", ...application };
    case "UnderReview": return { step: 3, label: "Application under review", note: "Before underwriting", tone: "blue", ...application };
    case "Proposed": return { step: 2, label: "Application submitted", note: "Awaiting review", tone: "blue", ...application };
    case "Quoted": return { step: 2, label: "Proposal draft", note: "Not submitted yet", tone: "blue", ...proposal };
  }
  if (lead.status === "PROSPECT" || lead.status === "UNDERWRITING_READY")
    return { step: 2, label: "In proposal", note: "Being prepared", tone: "blue", ...proposal };
  return { step: 1, label: "New lead", note: "Not started", tone: "amber" };
}

const FILL: Record<Tone, string> = {
  blue: "bg-blue-500",
  amber: "bg-amber-400",
  green: "bg-emerald-500",
  red: "bg-rose-500",
  slate: "bg-slate-300",
};
const TEXT: Record<Tone, string> = {
  blue: "text-blue-700",
  amber: "text-amber-700",
  green: "text-emerald-700",
  red: "text-rose-700",
  slate: "text-slate-500",
};

export default function LeadProgress({ lead }: { lead: LeadLike }) {
  const s = leadStage(lead);
  return (
    <div className="min-w-[10.5rem]" title={tx("{0} · stage {1} of 5: {2}", { 0: s.label, 1: Math.max(s.step, 1), 2: LEAD_STAGES[Math.max(s.step, 1) - 1] })}>
      <div className="flex items-center gap-1" role="img" aria-label={tx("{0}, stage {1} of 5", { 0: s.label, 1: s.step })}>
        {LEAD_STAGES.map((stage, i) => (
          <span
            key={stage}
            className={`h-1.5 flex-1 rounded-full ${i < s.step ? FILL[s.tone] : "bg-slate-200"}`}
          />
        ))}
      </div>
      <p className={`mt-1.5 text-xs font-semibold leading-none ${TEXT[s.tone]}`}>{tx(s.label)}</p>
      <div className="mt-1 flex items-center justify-between gap-3">
        <p className="text-[11px] leading-none text-slate-400">{tx(s.note)}</p>
        {s.href && (
          <Link
            href={appHref(s.href)}
            // the row itself opens the lead's details; this link goes to the page for its current step instead
            onClick={(e) => e.stopPropagation()}
            className="whitespace-nowrap text-[11px] font-semibold leading-none text-blue-600 hover:text-blue-800 hover:underline"
          >
            {s.linkLabel} →
          </Link>
        )}
      </div>
    </div>
  );
}
