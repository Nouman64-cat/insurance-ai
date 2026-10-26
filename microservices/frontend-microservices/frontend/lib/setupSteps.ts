// The steps of setting up a run, worked out from the form itself: which are done, which one is open, which have a problem, and what to say about each in a few words.
// The order is the order of a person's thinking: who is being compared, on which questions, asked how, judged by whom, then check and go.
import type { BenchmarkForm } from "@/lib/evalBenchmarks";

export type StepId = "models" | "questions" | "method" | "judge" | "review";
export type StepState = "done" | "current" | "todo" | "problem";
export const ORDER: StepId[] = ["models", "questions", "method", "judge", "review"];
export interface SetupStep { id: StepId; n: number; label: string; question: string; help: string; state: StepState; current: boolean; summary: string; optional: boolean }

export const COPY: Record<StepId, { label: string; question: string; help: string; optional: boolean }> = {
  models: { label: "Models", question: "Which models do you want to compare?", help: "Pick at least two. Real models spend money; scripted ones are free and only check that the machinery works.", optional: false },
  questions: { label: "Questions", question: "Which questions should they answer?", help: "A test set is a published, frozen list of insurance cases, each with the outcome it should produce. Run all of it, or only some stages.", optional: false },
  method: { label: "Method", question: "How should they be asked?", help: "Through the real agent, with its tools, or as a bare model. Repeat each case a few times to tell steady from lucky.", optional: false },
  judge: { label: "Judge", question: "Who should judge the quality of the answers?", help: "Optional. A judge model reads each answer and scores things rules cannot check, such as correctness and safety. Without one, only the rule-based checks run.", optional: true },
  review: { label: "Review and start", question: "Ready? Check the run and start it.", help: "This is what will run and what it can cost. A real run asks you to confirm before it spends anything.", optional: false },
};

/** Which step a validation message belongs to, so a problem is shown where it can be fixed. */
export function problemStep(problem: string): StepId {
  const p = problem.toLowerCase();
  if (/two models|at least two|judge is also|metrics without|choose a judge|judge/.test(p)) return /two models|at least two/.test(p) ? "models" : "judge";
  if (/dataset|published|version/.test(p)) return "questions";
  if (/repetition|temperature/.test(p)) return "method";
  return "review";
}

export const modelsOk = (f: BenchmarkForm) => f.models.length >= 2;
export const questionsOk = (f: BenchmarkForm) => !!f.dataset && !!f.version;
/** Whether the person may move on from a step: only the two steps that cannot be skipped block. */
export function canAdvance(step: StepId, f: BenchmarkForm): boolean { return step === "models" ? modelsOk(f) : step === "questions" ? questionsOk(f) : true; }
export const nextOf = (s: StepId): StepId => ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(s) + 1)];
export const prevOf = (s: StepId): StepId => ORDER[Math.max(0, ORDER.indexOf(s) - 1)];

const short = (m: string) => m.split("/")[1] ?? m;
export function setupSteps(f: BenchmarkForm, ctx: { current: StepId; visited: ReadonlySet<StepId>; problems: string[]; ready: boolean }): SetupStep[] {
  const bad = new Set(ctx.problems.map(problemStep));
  const summary: Record<StepId, string> = {
    models: modelsOk(f) ? f.models.map(short).join(", ") : f.models.length === 1 ? `${short(f.models[0])} · pick one more` : "none yet · pick at least two",
    questions: questionsOk(f) ? `${f.dataset} ${f.version} · ${f.stages.length === 0 ? "all stages" : `${f.stages.length} stage${f.stages.length === 1 ? "" : "s"}`}` : "choose a test set",
    method: `${f.mode === "direct" ? "Direct (bare model)" : "Agent"} · ${f.repetitions}× each`,
    judge: f.judge ? short(f.judge) : "no judge · rule checks only",
    review: ctx.ready ? "ready to start" : "check and start",
  };
  return ORDER.map((id, i) => {
    const done = id === "models" ? modelsOk(f) : id === "questions" ? questionsOk(f) : id === "review" ? ctx.ready : ctx.visited.has(id);
    const state: StepState = bad.has(id) && (id !== "review" || ctx.visited.has("review")) ? "problem" : ctx.current === id ? "current" : done ? "done" : "todo";
    return { id, n: i + 1, ...COPY[id], state, current: ctx.current === id, summary: summary[id] };
  });
}
