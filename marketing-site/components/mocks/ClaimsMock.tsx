import { Icon } from "@/components/ui/Icon";

type Stage = { label: string; state: "done" | "current" | "todo" };

const stages: Stage[] = [
  { label: "First notice of loss", state: "done" },
  { label: "Triage", state: "done" },
  { label: "Document audit", state: "done" },
  { label: "Fraud & contestability", state: "done" },
  { label: "Adjudication", state: "current" },
  { label: "Disbursement", state: "todo" },
  { label: "Closure", state: "todo" },
];

export function ClaimsMock() {
  return (
    <div className="card mx-auto w-full max-w-[34rem] overflow-hidden shadow-float" role="img" aria-label="Example claim journey">
      <div className="flex items-start justify-between border-b border-line px-5 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-faint">Claim</p>
          <p className="mt-1 text-sm font-semibold text-ink">CLM-2026-0142</p>
          <p className="text-xs text-muted">Death benefit · Sum assured PKR 5,000,000</p>
        </div>
        <span className="rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-500/30">
          Manager review
        </span>
      </div>

      <ol className="px-5 py-4">
        {stages.map((s, i) => (
          <li key={s.label} className="flex items-center gap-3 py-1.5">
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white ${
                s.state === "done" ? "bg-emerald-600" : s.state === "current" ? "bg-brand" : "bg-line"
              }`}
            >
              {s.state === "done" ? (
                <Icon name="check" className="h-3 w-3" />
              ) : (
                <span className="text-[10px] font-semibold">{s.state === "current" ? i + 1 : ""}</span>
              )}
            </span>
            <span className={`text-sm ${s.state === "todo" ? "text-faint" : "text-ink"}`}>{s.label}</span>
          </li>
        ))}
      </ol>

      <div className="border-t border-line bg-alt px-5 py-3 text-xs text-body">
        Amount is above the manager-review threshold, so payout waits for sign-off.
      </div>
    </div>
  );
}
