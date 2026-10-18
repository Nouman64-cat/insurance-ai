/** Closed is terminal even when an older workflow snapshot still contains open stages. */
export function claimStepIndex(status: string, stages: {state: string}[] | null, steps: string[], currentName: string): number {
  if (status === "Closed") return steps.length;
  if (!stages) return steps.indexOf(currentName);
  const current = stages.findIndex(s => !["complete", "skipped"].includes(s.state));
  return current < 0 ? steps.length : current;
}
