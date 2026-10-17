// Single source of truth for the policy lifecycle as it maps to a real insurer's
// (Adamjee-style) workflow. Every stepper, badge, and process rail reads from here
// so the UI never disagrees with itself about "where is this policy?".

/** Normalise any backend status string to UPPER, alpha-only (e.g. "Pending Payment" -> "PENDINGPAYMENT"). */
export function normStatus(status?: string | null): string {
  return (status || "").toUpperCase().replace(/[^A-Z]/g, "");
}

export interface LifecycleStage {
  key: string;
  label: string;
  /** Short description of what happens in this stage at a real insurer. */
  blurb: string;
  /** Backend statuses (normalised) that mean "the policy is currently AT this stage". */
  statuses: string[];
}

// The canonical happy-path issuance journey, in order. Terminal off-ramps
// (Lapsed / Cancelled / Declined) are handled separately — they are not steps.
export const ISSUANCE_STAGES: LifecycleStage[] = [
  {
    key: "approved",
    label: "Underwriting Approved",
    blurb: "Risk assessed and accepted. Terms (and any loadings) are locked; the proposal is ready to bind.",
    statuses: ["PROPOSED", "UNDERREVIEW", "INFORMATIONREQUESTED"],
  },
  {
    key: "drafted",
    label: "Policy Drafted",
    blurb: "Policy number generated and the legal contract snapshot (v1.0) is created. Awaiting the first premium.",
    statuses: ["APPROVED", "ACCEPTEDWITHLOADINGS", "COUNTEROFFER"],
  },
  {
    key: "collected",
    label: "Premium Collected",
    blurb: "First premium received and realised through the payment gateway. Coverage can now be bound.",
    statuses: ["PENDINGPAYMENT", "ISSUED"],
  },
  {
    key: "active",
    label: "Submitted for Approval",
    blurb: "Coverage is live. The policyholder is onboarded; billing, servicing and renewals begin.",
    statuses: ["ACTIVE", "GRACEPERIOD"],
  },
];

export type StageState = "done" | "current" | "upcoming";

/** Terminal (off-ramp) states that end the journey rather than advancing it. */
export const TERMINAL: Record<string, { label: string; tone: "red" | "amber" }> = {
  LAPSED: { label: "Lapsed", tone: "red" },
  CANCELLED: { label: "Cancelled", tone: "red" },
  DECLINED: { label: "Declined", tone: "red" },
  NOTTAKENUP: { label: "Not Taken Up", tone: "red" },
};

/**
 * Given a policy status, return the index of the stage it currently occupies
 * within ISSUANCE_STAGES. ACTIVE completes the whole journey (index = last).
 * Returns -1 for pre-approval or terminal states.
 */
export function currentStageIndex(status?: string | null): number {
  const s = normStatus(status);
  if (s === "ACTIVE" || s === "GRACEPERIOD") return ISSUANCE_STAGES.length - 1;
  const idx = ISSUANCE_STAGES.findIndex((st) => st.statuses.includes(s));
  return idx;
}

/** Per-stage state (done / current / upcoming) for rendering a stepper. */
export function stageStates(status?: string | null): StageState[] {
  const s = normStatus(status);
  const current = currentStageIndex(status);
  const active = s === "ACTIVE"; // fully complete — every step is "done"
  return ISSUANCE_STAGES.map((_, i) => {
    if (active) return "done";
    if (current === -1) return "upcoming";
    if (i < current) return "done";
    if (i === current) return "current";
    return "upcoming";
  });
}

export function isTerminal(status?: string | null): boolean {
  return normStatus(status) in TERMINAL;
}
