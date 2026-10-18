/** Project the claim's recorded lifecycle even when an older workflow has stale earlier stages. */
export function claimStepIndex(status: string, stages: {state: string; key?: string}[] | null, steps: string[], currentName: string): number {
  if (status === "Closed") return steps.length;
  if (!stages) return ["Approved", "Partial Approval"].includes(status) ? steps.indexOf("Settled") : steps.indexOf(currentName);
  const settlement = stages.findIndex(s => s.key === "settlement");
  const floor = ["Approved", "Partial Approval", "Settled"].includes(status) ? (settlement >= 0 ? settlement : stages.length === 7 ? 5 : 0) : 0;
  const current = stages.findIndex((s, i) => i >= floor && !["complete", "skipped"].includes(s.state));
  return current < 0 ? steps.length : current;
}
