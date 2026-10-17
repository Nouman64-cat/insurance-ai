/** How a raw requirement status (e-application, questionnaire, exam, history, documents) reads to an underwriter. */
export type RequirementState = "done" | "progress" | "attention" | "blocked" | "todo";

const STATES: Record<string, RequirementState> = {
  Submitted: "done", Verified: "done", Clear: "done", Completed: "done", NotRequired: "done", Waived: "done", Received: "done",
  Sent: "progress", InProgress: "progress", Invited: "progress", Scheduled: "progress", Required: "progress",
  Flagged: "attention", Expired: "attention", Outstanding: "attention",
  Failed: "blocked",
};
const LABELS: Record<string, string> = {
  NotSent: "Not sent", NotStarted: "Not started", NotAssessed: "Not assessed", NotRequired: "Not required",
  InProgress: "In progress", Clear: "Cleared",
};

export const requirementState = (status: string): RequirementState => STATES[status] ?? "todo";
/** "NotSent" → "Not sent"; known words keep their own spelling. */
export const statusLabel = (status: string) => LABELS[status] ?? status.replace(/([a-z])([A-Z])/g, "$1 $2");

export const STATE_TONE: Record<RequirementState, { pill: string; dot: string; icon: string }> = {
  done: { pill: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500", icon: "bg-emerald-500 text-white" },
  progress: { pill: "bg-blue-50 text-blue-700 ring-blue-200", dot: "bg-blue-500", icon: "bg-blue-50 text-blue-600 ring-1 ring-blue-200" },
  attention: { pill: "bg-amber-50 text-amber-800 ring-amber-200", dot: "bg-amber-500", icon: "bg-amber-50 text-amber-600 ring-1 ring-amber-200" },
  blocked: { pill: "bg-rose-50 text-rose-700 ring-rose-200", dot: "bg-rose-500", icon: "bg-rose-500 text-white" },
  todo: { pill: "bg-slate-100 text-slate-600 ring-slate-200", dot: "bg-slate-300", icon: "bg-white text-slate-400 ring-1 ring-slate-200" },
};
