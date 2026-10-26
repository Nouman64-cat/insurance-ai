// The four stages of a run, worked out from what the platform really recorded (the job's state and its event log), never guessed:
//   1 Queued           the request is waiting for the job worker to pick it up
//   2 Running          the models are answering the cases
//   3 Storing results  the finished runs are being saved on the platform (database and storage)
//   4 Results ready    the benchmark is stored and can be opened
// A step that did not happen says why (a worker that is not running, a failed or cancelled run, results that were never stored) and what to do.
export type StepState = "done" | "current" | "waiting" | "problem";
export interface RunStep { id: "queued" | "running" | "storing" | "results"; label: string; state: StepState; note: string | null }
export interface StepInput { state: string; events: { kind: string; message: string | null }[]; benchmarkId: string | null; resultsChecked: boolean; error: string | null; cancelRequested?: boolean }

export const TERMINAL_STATES = ["succeeded", "failed", "cancelled", "lost"];
export const STORING_MESSAGE = "ingesting the run into the platform";
export const WORKER_COMMAND = "python3 evals/environment/envctl.py worker";
export const RETRY_COMMAND = "python3 evals/environment/envctl.py ingest-group";

export function runSteps(i: StepInput): RunStep[] {
  const terminal = TERMINAL_STATES.includes(i.state);
  const ran = i.events.some((e) => e.kind === "case" || e.kind === "progress");                // at least one execution was reported
  const storing = i.events.some((e) => e.message === STORING_MESSAGE);
  const stopped = i.state === "failed" || i.state === "cancelled" || i.state === "lost";
  const s: RunStep[] = [
    { id: "queued", label: "Queued", state: "waiting", note: null },
    { id: "running", label: "Running", state: "waiting", note: null },
    { id: "storing", label: "Storing results", state: "waiting", note: null },
    { id: "results", label: "Results ready", state: "waiting", note: null },
  ];
  // 1: queued
  if (i.state === "queued") { s[0].state = "current"; s[0].note = `Waiting for the job worker to pick this up. If it stays here, the worker is not running: start it with ${WORKER_COMMAND}`; return s; }
  s[0].state = "done";
  // 2: running
  if (i.state === "running" && !storing) { s[1].state = "current"; s[1].note = i.cancelRequested ? "Cancelling: the case in flight finishes first." : null; return s; }
  if (stopped && !ran && !storing) { s[1].state = "problem"; s[1].note = i.state === "cancelled" ? "Cancelled before any case ran." : i.error ?? `The run ${i.state} before any case ran.`; return s; }
  s[1].state = "done";
  if (stopped && ran && !storing) { s[1].state = "problem"; s[1].note = i.state === "cancelled" ? "Cancelled part way: what had finished is kept." : i.error ?? `The run ${i.state} part way.`; }
  // 3: storing
  if (!terminal && storing) { s[2].state = "current"; s[2].note = "Saving the finished runs and the comparison."; return s; }
  if (!terminal) return s;
  if (i.state === "failed" && storing && !i.benchmarkId) { s[2].state = "problem"; s[2].note = i.error ?? "The results could not be stored."; return s; }
  s[2].state = storing || i.benchmarkId ? "done" : "waiting";
  // 4: results
  if (i.benchmarkId) { s[3].state = "done"; s[3].note = "The benchmark is stored: open it to compare the models."; return s; }
  if (i.state === "succeeded") {
    if (!i.resultsChecked) { s[3].state = "current"; s[3].note = "Looking for the stored results…"; }
    else { s[3].state = "problem"; s[3].note = `The job finished but no stored benchmark was found, so its results may not have been saved. Check again, or run ${RETRY_COMMAND}`; }
  } else if (stopped) { s[3].state = "waiting"; s[3].note = "No complete results: the run did not finish."; }
  return s;
}
