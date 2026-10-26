"use client";

import { tx } from "@/lib/i18n/tx";
import { runSteps, type StepInput, type StepState } from "@/lib/runSteps";

const DOT: Record<StepState, string> = {
  done: "bg-emerald-500 text-white border-emerald-500", current: "bg-blue-600 text-white border-blue-600 animate-pulse motion-reduce:animate-none",
  waiting: "bg-white text-slate-400 border-slate-300 dark:bg-slate-900 dark:border-slate-600", problem: "bg-red-600 text-white border-red-600",
};
const WORD: Record<StepState, string> = { done: "done", current: "in progress", waiting: "not yet", problem: "problem" };
const GLYPH: Record<StepState, (n: number) => string> = { done: () => "✓", current: (n) => String(n), waiting: (n) => String(n), problem: () => "!" };

/** The four stages of a run with what each one is doing now. The state is written as well as coloured, and the current step carries aria-current. */
export default function RunStepper(props: StepInput & { onCheckAgain?: () => void }) {
  const steps = runSteps(props);
  const problem = steps.find((s) => s.state === "problem");
  const current = steps.find((s) => s.state === "current");
  const note = problem ?? current;
  return (
    <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900" aria-label={tx("Run progress")} data-testid="run-steps">
      <ol className="flex flex-wrap items-start gap-x-2 gap-y-2">
        {steps.map((s, i) => (
          <li key={s.id} className="flex min-w-0 items-center gap-2" aria-current={s.state === "current" ? "step" : undefined} data-step={s.id} data-state={s.state}>
            <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${DOT[s.state]}`} aria-hidden>{GLYPH[s.state](i + 1)}</span>
            <span className="text-xs">
              <b className={s.state === "waiting" ? "text-slate-400" : "text-slate-800 dark:text-slate-100"}>{tx(s.label)}</b>
              <span className="ml-1 text-[10px] text-slate-400">{tx(WORD[s.state])}</span>
            </span>
            {i < steps.length - 1 && <span className="mx-1 hidden h-px w-6 bg-slate-200 sm:block dark:bg-slate-700" aria-hidden />}
          </li>
        ))}
      </ol>
      {note?.note && (
        <p className={`mt-2 text-[11px] ${problem ? "text-red-700 dark:text-red-300" : "text-slate-500"}`} role={problem ? "alert" : "status"} data-testid="run-steps-note">
          {tx(note.note)}
          {problem?.id === "results" && props.onCheckAgain && <button type="button" onClick={props.onCheckAgain} className="ml-2 rounded-md border border-slate-300 px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:border-sky-400 dark:border-slate-600 dark:text-slate-200" data-testid="check-again">{tx("Check again")}</button>}
        </p>
      )}
    </section>
  );
}
