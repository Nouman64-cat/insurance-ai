// Small, pure helpers for the Watch page: how a job's state is shown (always as a word, with an icon, never colour alone), how much of the estimate and the budget a run has used, and which events are worth reading.
export type StateTone = "good" | "active" | "wait" | "bad" | "stopped";
export interface StateInfo { label: string; tone: StateTone; icon: string; hint: string }

const STATES: Record<string, StateInfo> = {
  queued: { label: "Queued", tone: "wait", icon: "◷", hint: "Waiting for the job worker to start it." },
  running: { label: "Running", tone: "active", icon: "●", hint: "The models are answering the cases." },
  succeeded: { label: "Succeeded", tone: "good", icon: "✓", hint: "The evaluation ran to the end." },
  failed: { label: "Failed", tone: "bad", icon: "✕", hint: "The run stopped with an error." },
  cancelled: { label: "Cancelled", tone: "stopped", icon: "■", hint: "Stopped on request; what had run is kept." },
  lost: { label: "Lost", tone: "bad", icon: "!", hint: "The worker stopped reporting; the run may be incomplete." },
};
export function stateInfo(state: string, cancelRequested = false): StateInfo {
  const base = STATES[state] ?? { label: state, tone: "stopped" as StateTone, icon: "?", hint: "" };
  return state === "running" && cancelRequested ? { ...base, label: "Cancelling", hint: "The case in flight finishes, then the run stops." } : base;
}

export interface Meter { spent: number; estimate: number | null; budget: number | null; pctOfEstimate: number | null; pctOfBudget: number | null; overEstimate: boolean; nearBudget: boolean }
/** How much of the estimate and the budget has been spent. A bar never goes past full, but `overEstimate` says when the run cost more than expected. */
export function spendMeter(spent: number, estimate: number | null, budget: number | null): Meter {
  const pc = (a: number, b: number | null) => (b !== null && b > 0 ? Math.min(100, (a / b) * 100) : null);
  return { spent, estimate, budget, pctOfEstimate: pc(spent, estimate), pctOfBudget: pc(spent, budget), overEstimate: estimate !== null && spent > estimate, nearBudget: budget !== null && budget > 0 && spent / budget >= 0.8 };
}

export interface EventLike { seq: number; at: string; kind: string; message: string | null }
export type EventTone = "good" | "bad" | "info" | "dim";
export interface EventLine { seq: number; time: string; kind: string; text: string; tone: EventTone; detail: boolean }
/** An event as one readable line. "detail" lines are the repetitive ones (a case starting): they are hidden unless asked for. */
export function eventLine(e: EventLike): EventLine {
  const text = e.message ?? "";
  const detail = e.kind === "log" && /: starting$/.test(text);
  const tone: EventTone = e.kind === "case" ? (/: passed/.test(text) ? "good" : /: (failed|infrastructure_error|blocked)/.test(text) ? "bad" : "dim") : e.kind === "state" ? "info" : "dim";
  return { seq: e.seq, time: e.at.slice(11, 19), kind: e.kind, text, tone, detail };
}
export function visibleEvents(events: EventLike[], showDetail: boolean): EventLine[] {
  return [...events].reverse().filter((e) => e.kind !== "progress").map(eventLine).filter((l) => showDetail || !l.detail);
}
