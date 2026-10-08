import { Icon } from "@/components/ui/Icon";

const scores = [
  { label: "Medical risk", value: "38 / 100", pct: 38 },
  { label: "Financial risk", value: "22 / 100", pct: 22 },
  { label: "Fraud probability", value: "6%", pct: 6 },
];

const trail = [
  { label: "Requirements satisfied", done: true },
  { label: "Scored in parallel", done: true },
  { label: "Rule chain evaluated", done: true },
];

export function UnderwritingMock() {
  return (
    <div className="card mx-auto w-full max-w-[34rem] overflow-hidden shadow-float" role="img" aria-label="Example underwriting decision">
      <div className="flex items-start justify-between border-b border-line px-5 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-faint">Underwriting case</p>
          <p className="mt-1 text-sm font-semibold text-ink">CASE-2026-A3F9C1</p>
          <p className="text-xs text-muted">Ahmed Khan · Term Life 20 · PKR 5,000,000</p>
        </div>
        <span className="shrink-0 whitespace-nowrap rounded-full bg-chip px-2.5 py-1 text-xs font-medium text-body">Demo data</span>
      </div>

      <div className="space-y-4 px-5 py-4">
        {scores.map((s, i) => (
          <div key={s.label} style={{ "--i": i } as React.CSSProperties}>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-body">{s.label}</span>
              <span className="font-semibold tabular-nums text-ink">{s.value}</span>
            </div>
            <div className="mt-1.5 h-1.5 rounded-full bg-chip">
              <div className="bar-grow h-1.5 rounded-full bg-brand" style={{ width: `${s.pct}%` }} />
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-line bg-alt px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted">Verdict</p>
            <p className="text-sm font-semibold text-ink">Approve with Loading</p>
          </div>
          <span className="rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-500/30">
            +25% loading
          </span>
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {trail.map((t) => (
            <li key={t.label} className="flex items-center gap-1.5 text-xs text-muted">
              <Icon name="check" className="h-3.5 w-3.5 text-emerald-600" />
              {t.label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
