import type { CSSProperties } from "react";
import { Icon } from "@/components/ui/Icon";

// A compact "live decision" card for the top-right of the hero. Three demo cases take turns
// (one every 4 s, CSS only): each shows who it is for, the verdict the rules reached, and the
// three scores the AI contributed. It fills the space beside the first headline line.
const cases = [
  { kind: "Individual", who: "Term Life · PKR 5,000,000", verdict: "Auto Approve", scores: [38, 22, 6] },
  { kind: "Family", who: "Khan family · 5 members", verdict: "Approve with Loading", scores: [52, 30, 9] },
  { kind: "Corporate", who: "Crescent Textiles · 248 members", verdict: "Approved, 6 referred", scores: [34, 41, 4] },
];
const labels = ["Medical", "Financial", "Fraud"];

export function HeroDecisionFeed({ className = "" }: Readonly<{ className?: string }>) {
  return (
    <div className={`rounded-2xl bg-card/90 p-4 shadow-surface ring-1 ring-line ${className}`} role="img" aria-label="Live decision feed, demo data">
      <div aria-hidden="true">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-2 font-semibold uppercase tracking-wider text-muted">
            <span className="relative flex h-2 w-2">
              <span className="node-ping absolute inset-0 rounded-full bg-emerald-500/50" />
              <span className="relative h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            Live decisions
          </span>
          <span className="text-[0.6875rem] text-faint">AI scores · rules decide · demo data</span>
        </div>

        <div className="relative mt-3 h-[3.5rem]">
          {cases.map((c, k) => (
            <div key={c.kind} className="feed-item absolute inset-0 flex items-center justify-between gap-5" style={{ "--k": k } as CSSProperties}>
              <div className="min-w-0">
                <p className="truncate text-xs text-muted">
                  <span className="font-semibold uppercase tracking-wider text-brand">{c.kind}</span> · {c.who}
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-lg font-semibold tracking-tight text-ink">
                  <Icon name="check" className="h-[1.125rem] w-[1.125rem] shrink-0 text-emerald-600" />
                  <span className="truncate">{c.verdict}</span>
                </p>
              </div>
              <ul className="grid w-[46%] shrink-0 grid-cols-3 gap-3">
                {c.scores.map((s, i) => (
                  <li key={labels[i]}>
                    <div className="flex items-baseline justify-between text-[0.6875rem] text-muted">
                      <span>{labels[i]}</span>
                      <span className="font-semibold tabular-nums text-ink">{i === 2 ? `${s}%` : s}</span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-chip">
                      <div className="feed-bar h-full rounded-full bg-brand" style={{ width: `${Math.max(s, 4)}%`, "--k": k } as CSSProperties} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
