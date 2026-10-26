"use client";

import { tx } from "@/lib/i18n/tx";
import type { SetupStep, StepId, StepState } from "@/lib/setupSteps";

const DOT: Record<StepState, string> = {
  done: "border-emerald-500 bg-emerald-500 text-white", current: "border-blue-600 bg-blue-600 text-white ring-4 ring-blue-100 dark:ring-blue-950",
  todo: "border-slate-300 bg-white text-slate-500 dark:border-slate-600 dark:bg-slate-900", problem: "border-red-500 bg-red-500 text-white",
};
const WORD: Record<StepState, string> = { done: "done", current: "in progress", todo: "not yet", problem: "needs attention" };

/** The pipeline across the top: every step of setting up a run, where you are, what is done and what needs attention. Each step can be opened directly. */
export default function SetupSteps({ steps, onGo }: { steps: SetupStep[]; onGo: (id: StepId) => void }) {
  return (
    <nav aria-label={tx("Steps to set up a run")} data-testid="setup-steps">
      <ol className="grid grid-cols-5 gap-1 rounded-xl border border-slate-200 bg-white p-2 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        {steps.map((s, i) => (
          <li key={s.id} className="min-w-0" aria-current={s.current ? "step" : undefined} data-step={s.id} data-state={s.state}>
            <button type="button" onClick={() => onGo(s.id)} className={`relative flex w-full flex-col items-center gap-1 rounded-lg px-1.5 py-2 text-center transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:hover:bg-slate-800 ${s.current ? "bg-blue-50/60 dark:bg-blue-950/30" : ""}`}>
              <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-extrabold ${DOT[s.state]}`} aria-hidden>{s.state === "done" ? "✓" : s.state === "problem" ? "!" : s.n}</span>
              <span className={`block w-full truncate text-xs font-extrabold ${s.state === "todo" ? "text-slate-500" : "text-slate-900 dark:text-slate-50"}`}>{tx(s.label)}{s.optional ? <span className="font-normal text-slate-400"> ({tx("optional")})</span> : null}</span>
              <span className="hidden w-full truncate text-[10px] text-slate-500 sm:block" title={s.summary}>{tx(s.summary)}</span>
              <span className="sr-only">{s.current ? `${tx("current step")}, ` : ""}{tx(WORD[s.state])}: {tx(s.summary)}</span>
              {i < steps.length - 1 && <span className="pointer-events-none absolute -right-1 top-6 hidden h-0.5 w-2 bg-slate-300 sm:block dark:bg-slate-600" aria-hidden />}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
