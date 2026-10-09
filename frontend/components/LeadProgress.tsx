// Where a lead is on its way to a policy, readable at a glance in a list.
//
// Five stages, drawn as five segments that fill left to right:
//   1 New lead  ->  2 Proposal  ->  3 Under review  ->  4 Underwriting  ->  5 Policy
// The word beside the bar says exactly where it stands; colour only says whether it is moving
// (blue), needs someone (amber), is done (green) or has stopped (red / grey).

export const LEAD_STAGES = ["New lead", "Proposal", "Review", "Underwriting", "Policy"] as const;

type Tone = "blue" | "amber" | "green" | "red" | "slate";

export interface LeadStageInfo {
  /** Segments filled, 0 to 5. */
  step: number;
  label: string;
  note: string;
  tone: Tone;
}

interface LeadLike {
  status: string;
  proposalStatus?: string | null;
}

export function leadStage(lead: LeadLike): LeadStageInfo {
  if (lead.status === "NOT_INTERESTED") return { step: 0, label: "Not interested", note: "Closed", tone: "slate" };
  if (lead.status === "POLICYHOLDER") return { step: 5, label: "Policyholder", note: "Cover is live", tone: "green" };
  if (lead.status === "UNDERWRITING_READY") return { step: 4, label: "In underwriting", note: "Risk assessment", tone: "blue" };

  switch (lead.proposalStatus) {
    case "Declined": return { step: 2, label: "Proposal rejected", note: "Stopped at proposal", tone: "red" };
    case "InformationRequested": return { step: 2, label: "Info requested", note: "Waiting on details", tone: "amber" };
    case "UnderReview": return { step: 3, label: "Under review", note: "With the admin team", tone: "blue" };
    case "Proposed": return { step: 2, label: "Proposal submitted", note: "Awaiting review", tone: "blue" };
    case "Quoted": return { step: 2, label: "Proposal draft", note: "Not submitted yet", tone: "blue" };
  }
  if (lead.status === "PROSPECT") return { step: 2, label: "In proposal", note: "Being prepared", tone: "blue" };
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
    <div className="min-w-[10.5rem]" title={`${s.label} · stage ${Math.max(s.step, 1)} of 5: ${LEAD_STAGES[Math.max(s.step, 1) - 1]}`}>
      <div className="flex items-center gap-1" role="img" aria-label={`${s.label}, stage ${s.step} of 5`}>
        {LEAD_STAGES.map((stage, i) => (
          <span
            key={stage}
            className={`h-1.5 flex-1 rounded-full ${i < s.step ? FILL[s.tone] : "bg-slate-200"}`}
          />
        ))}
      </div>
      <p className={`mt-1.5 text-xs font-semibold leading-none ${TEXT[s.tone]}`}>{s.label}</p>
      <p className="mt-1 text-[11px] leading-none text-slate-400">{s.note}</p>
    </div>
  );
}
