import type { QuickAction } from "@/lib/agent/types";

/**
 * The business journey of the customer/case the automation chat is working on,
 * drawn as a node graph: onboarding → proposal → underwriting case → the 7
 * parallel underwriting requirements (fan-out / fan-in) → risk → decision →
 * issuance → active. Each node shows whether it's done, in progress, waiting on
 * someone else, or a possible next step — next steps are clickable and run the
 * same prompt/action the chat's own buttons would.
 *
 * Unlike ProcessGraph (the agent's internal steps for ONE turn), this reflects
 * persisted case state, re-read after every turn and on live case events.
 * Rendered full-page by JourneyMap (the chat header's map toggle).
 */

// done → completed; current / next / available / waiting / failed → active
// (something is happening or can be done now); todo → inactive (not reached).
export type JourneyState = "done" | "current" | "waiting" | "next" | "available" | "todo" | "failed";

export interface JourneyNode {
  id: string;
  label: string;
  sub?: string;
  state: JourneyState;
  action?: QuickAction;
}

export interface Journey {
  title: string;
  subtitle?: string;
  before: JourneyNode[]; // linear stages before the requirements fan-out
  gates: JourneyNode[]; // parallel requirements (empty before a case exists)
  after: JourneyNode[]; // linear stages after the fan-in
}

// ── Building the journey from what the chat knows ──────────────────────────

export type ProposalState = "draft" | "submitted" | "review" | "info" | "rejected";

export type JourneyContext =
  | { kind: "case"; caseId: string }
  | { kind: "proposal"; state: ProposalState; name?: string; actions: QuickAction[] }
  | { kind: "customer"; name?: string };

const submit = (label: string, payload: string): QuickAction => ({ label, actionType: "submit", payload });

const PROPOSAL_LABEL: Record<ProposalState, string> = {
  draft: "Draft",
  submitted: "Submitted",
  review: "Under review",
  info: "Information requested",
  rejected: "Rejected",
};

const UPCOMING_AFTER: JourneyNode[] = [
  { id: "risk", label: "AI risk assessment", state: "todo" },
  { id: "decision", label: "Underwriting decision", state: "todo" },
  { id: "issuance", label: "Policy issued", state: "todo" },
  { id: "active", label: "Payment · cover active", state: "todo" },
];

// The 7 requirements, shown inactive until an underwriting case exists, so the
// whole map is visible from the very first step.
const UPCOMING_GATES: JourneyNode[] = [
  { id: "documents", label: "Mandatory documents", state: "todo" },
  { id: "e_application", label: "Customer e-application", state: "todo" },
  { id: "acr", label: "Agent confidential report", state: "todo" },
  { id: "compliance", label: "PEP & sanctions screening", state: "todo" },
  { id: "ipp", label: "Initial premium payment", state: "todo" },
  { id: "insurance_history", label: "Insurance history", state: "todo" },
  { id: "medical_exam", label: "Medical exam / NML grid", state: "todo" },
];

export function journeyFromChat(ctx: JourneyContext): Journey {
  if (ctx.kind === "customer") {
    return {
      title: ctx.name || "New customer",
      before: [
        { id: "customer", label: "Customer onboarded", state: "done" },
        { id: "proposal", label: "Proposal", sub: "Not created yet", state: "next" },
        { id: "case", label: "Sent to underwriting", state: "todo" },
      ],
      gates: UPCOMING_GATES,
      after: UPCOMING_AFTER,
    };
  }
  if (ctx.kind === "proposal") {
    const primary = ctx.actions[0];
    const rejected = ctx.state === "rejected";
    return {
      title: ctx.name || "Proposal",
      subtitle: `Proposal · ${PROPOSAL_LABEL[ctx.state]}`,
      before: [
        { id: "customer", label: "Customer onboarded", state: "done" },
        {
          id: "proposal",
          label: "Proposal",
          sub: PROPOSAL_LABEL[ctx.state],
          state: rejected ? "failed" : "current",
          action: ctx.state !== "review" && primary ? primary : undefined,
        },
        {
          id: "case",
          label: "Sent to underwriting",
          state: ctx.state === "review" ? "next" : "todo",
          action: ctx.state === "review" ? ctx.actions.find((a) => a.label === "Send to Underwriting") : undefined,
        },
      ],
      gates: rejected ? [] : UPCOMING_GATES,
      after: rejected ? [] : UPCOMING_AFTER,
    };
  }
  throw new Error("case journeys are built by journeyFromCase");
}

// Shape of GET /tenants/{tid}/cases/{cid}/detail that this reads.
export interface CaseDetail {
  case: { caseld: string; caseNumber: string; caseStatus: string };
  customer?: { name?: string } | null;
  policy?: { status?: string } | null;
  document_checklist?: { missing?: string[] };
  pre_underwriting_status: {
    e_application: string;
    acr: string;
    compliance: string;
    ipp: string;
    insurance_history: string;
    medical_exam: string;
    is_ready: boolean;
  };
  latest_assessment?: { ai_decision?: string } | null;
}

export function journeyFromCase(d: CaseDetail): Journey {
  const cn = d.case.caseNumber;
  const pu = d.pre_underwriting_status;
  const missing = d.document_checklist?.missing ?? [];
  const policyStatus = d.policy?.status ?? "";
  const caseStatus = d.case.caseStatus;

  const gate = (
    id: string,
    label: string,
    status: string,
    doneWhen: string[],
    failWhen: string[],
    action: QuickAction,
    opts: { waitingWhen?: string[]; actionWhen?: Record<string, QuickAction> } = {},
  ): JourneyNode => {
    if (doneWhen.includes(status)) return { id, label, sub: status, state: "done" };
    if (failWhen.includes(status)) return { id, label, sub: status, state: "failed", action };
    if (opts.waitingWhen?.includes(status)) return { id, label, sub: status, state: "waiting" };
    return { id, label, sub: status, state: "available", action: opts.actionWhen?.[status] ?? action };
  };

  const gates: JourneyNode[] = [
    missing.length === 0
      ? { id: "documents", label: "Mandatory documents", sub: "Complete", state: "done" }
      : {
          id: "documents",
          label: "Mandatory documents",
          sub: `Missing: ${missing.join(", ")}`,
          state: "available",
          action: { label: "Upload documents", actionType: "uw_requirements", payload: JSON.stringify({ caseId: d.case.caseld, caseNo: cn }) },
        },
    gate("e_application", "Customer e-application", pu.e_application, ["Verified"], ["Expired"],
      submit("Send e-application link", `Generate e-application link for case ${cn}`),
      {
        waitingWhen: ["Sent", "InProgress"],
        actionWhen: { Submitted: submit("Verify e-application", `Verify e-application for case ${cn} action verify`) },
      }),
    gate("acr", "Agent confidential report", pu.acr, ["Submitted"], [],
      submit("Submit ACR", `Submit agent confidential report for case ${cn}`)),
    gate("compliance", "PEP & sanctions screening", pu.compliance, ["Passed"], ["Failed", "Flagged"],
      submit("Run compliance screening", `Run compliance screening for case ${cn}`)),
    gate("ipp", "Initial premium payment", pu.ipp, ["Realized"], ["Failed"],
      submit("Process initial premium", `Process initial premium payment for case ${cn}`),
      { waitingWhen: ["Initiated"] }),
    gate("insurance_history", "Insurance history", pu.insurance_history, ["Clear"], ["Flagged", "Failed"],
      submit("Run history check", `Run insurance history check for case ${cn}`)),
    gate("medical_exam", "Medical exam / NML grid", pu.medical_exam, ["NotRequired", "Completed", "Waived"], ["Expired"],
      submit("Assess medical exam", `Assess medical examination for case ${cn}`),
      { waitingWhen: ["Invited", "Scheduled"] }),
  ];

  // An e-application the customer has just submitted is the most urgent thing
  // on the board — it's blocked on us, not them.
  for (const g of gates) {
    if (g.id === "e_application" && g.sub === "Submitted") g.state = "next";
  }
  // The first actionable requirement is the recommended next step.
  if (!gates.some((g) => g.state === "next")) {
    const first = gates.find((g) => g.state === "available");
    if (first) first.state = "next";
  }

  const decided = ["Approved", "AcceptedWithLoadings", "Declined", "PendingPayment", "Issued", "Active"].includes(policyStatus)
    || ["Approved", "Rejected", "Closed"].includes(caseStatus);
  const declined = policyStatus === "Declined" || caseStatus === "Rejected";
  const issued = ["PendingPayment", "Issued", "Active"].includes(policyStatus);
  const active = policyStatus === "Active";
  const assessed = !!d.latest_assessment;

  const after: JourneyNode[] = [
    assessed
      ? { id: "risk", label: "AI risk assessment", sub: d.latest_assessment?.ai_decision, state: "done" }
      : pu.is_ready
        ? { id: "risk", label: "AI risk assessment", state: "next", action: submit("Run risk assessment", `Run risk assessment for case ${cn}`) }
        : { id: "risk", label: "AI risk assessment", sub: "After all requirements", state: "todo" },
    decided
      ? { id: "decision", label: "Underwriting decision", sub: declined ? "Declined" : "Approved", state: declined ? "failed" : "done" }
      : assessed
        ? { id: "decision", label: "Underwriting decision", state: "next", action: submit("Approve case", `Approve case ${cn} based on the risk assessment results`) }
        : { id: "decision", label: "Underwriting decision", state: "todo" },
  ];
  if (!declined) {
    after.push(
      issued
        ? { id: "issuance", label: "Policy issued", sub: policyStatus, state: "done" }
        : decided
          ? { id: "issuance", label: "Policy issued", state: "next", action: submit("Issue policy", `Issue policy for case ${cn}`) }
          : { id: "issuance", label: "Policy issued", state: "todo" },
      active
        ? { id: "active", label: "Payment · cover active", sub: "Active", state: "done" }
        : issued
          ? { id: "active", label: "Payment · cover active", sub: "Awaiting payment", state: "next", action: submit("Confirm payment", `Confirm payment for case ${cn}`) }
          : { id: "active", label: "Payment · cover active", state: "todo" },
    );
  }

  const ready = gates.filter((g) => g.state === "done").length;
  return {
    title: d.customer?.name || cn,
    subtitle: `${cn} · ${ready}/${gates.length} requirements`,
    before: [
      { id: "customer", label: "Customer onboarded", state: "done" },
      { id: "proposal", label: "Proposal", sub: "Accepted for underwriting", state: "done" },
      { id: "case", label: "Underwriting case", sub: cn, state: "done" },
    ],
    gates,
    after,
  };
}
