import { Fragment, type CSSProperties } from "react";
import { Icon } from "@/components/ui/Icon";
import { LogoMark } from "@/components/layout/LogoMark";

// The product, drawn as an interface: one underwriting case moving through four stages.
//   0 Lead  ->  1 AI analysis  ->  2 Rules  ->  3 Decision
// `stage` is the only input. Every element is always laid out and only fades/slides in with
// opacity and transform, so the surface never changes size and the transitions stay on the GPU.
// All values are demo data.

export const SURFACE_STAGES = ["Lead", "AI analysis", "Rules", "Decision"] as const;

const status = ["New lead", "AI analysing", "Rules running", "Approved with loading"];

const risks = [
  { label: "Medical risk", shown: "38 / 100", pct: 38 },
  { label: "Financial risk", shown: "22 / 100", pct: 22 },
  { label: "Fraud probability", shown: "6%", pct: 6 },
];

const rules = [
  "Age within product limits",
  "Sum assured within financial cap",
  "Fraud probability below 15%",
  "Medical loading band applied",
  "Evidence requirements satisfied",
];

const audit = [
  { at: "10:02", text: "Lead created by agent", from: 0 },
  { at: "10:03", text: "Medical and financial evidence received", from: 1 },
  { at: "10:04", text: "Risk scored by AI, advisory only", from: 1 },
  { at: "10:04", text: "Rule chain v12 evaluated", from: 2 },
  { at: "10:05", text: "Decision recorded: Approve with Loading", from: 3 },
];

const reveal = (on: boolean) =>
  `transition duration-500 ease-out ${on ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"}`;
const delay = (on: boolean, i: number): CSSProperties => ({ transitionDelay: on ? `${i * 110}ms` : "0ms" });

function PanelHead({ title, tag, tone }: Readonly<{ title: string; tag: string; tone: "ai" | "rules" | "audit" }>) {
  const tones = {
    ai: "bg-brand/10 text-brand",
    rules: "bg-ink text-white",
    audit: "bg-chip text-muted",
  } as const;
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
      <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold ${tones[tone]}`}>{tag}</span>
    </div>
  );
}

export function ProductSurface({ stage, className = "" }: Readonly<{ stage: number; className?: string }>) {
  const s = Math.max(0, Math.min(3, stage));

  return (
    <div
      className={`overflow-hidden rounded-2xl bg-card shadow-surface ring-1 ring-line ${className}`}
      role="img"
      aria-label="Insurance AI underwriting workbench showing a case moving from lead, through AI analysis and rule evaluation, to a recorded decision. Demo data."
    >
      <div aria-hidden="true">
        {/* Window bar */}
        <div className="flex items-center justify-between gap-3 bg-alt px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <LogoMark className="h-6 w-6 rounded-md" />
            <span className="truncate text-sm font-semibold text-ink">Underwriting workbench</span>
            <span className="hidden text-xs text-faint sm:inline">/ CASE-2026-A3F9C1</span>
          </div>
          <span className="whitespace-nowrap rounded-full bg-chip px-2.5 py-1 text-[0.6875rem] font-medium text-body">Demo data</span>
        </div>

        {/* Stage track */}
        <ol className="flex items-center gap-2 px-4 pt-4 sm:px-5">
          {SURFACE_STAGES.map((label, i) => {
            const done = s > i;
            const current = s === i;
            return (
              <Fragment key={label}>
                <li className="flex items-center gap-2">
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-semibold transition-colors duration-500 ${
                      done || current ? "bg-brand text-white" : "bg-chip text-muted"
                    } ${current ? "shadow-glow" : ""}`}
                  >
                    {done ? <Icon name="check" className="h-3.5 w-3.5" /> : i + 1}
                  </span>
                  <span
                    className={`text-[0.8125rem] font-medium transition-colors duration-500 ${
                      current ? "text-ink" : done ? "text-body" : "text-faint"
                    } ${current ? "" : "hidden sm:inline"}`}
                  >
                    {label}
                  </span>
                </li>
                {i < SURFACE_STAGES.length - 1 && (
                  <span className="relative h-0.5 min-w-3 flex-1 bg-chip">
                    <span
                      className="absolute inset-0 origin-left bg-brand transition-transform duration-700 ease-out"
                      style={{ transform: `scaleX(${s > i ? 1 : 0})` }}
                    />
                  </span>
                )}
              </Fragment>
            );
          })}
        </ol>

        {/* Three panels: what AI says, what the rules do, what is recorded */}
        <div className="grid gap-3 p-3 sm:p-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.95fr)]">
          {/* AI analysis */}
          <section className="min-w-0 rounded-xl bg-alt p-4">
            <PanelHead title="Risk analysis" tag="AI advises" tone="ai" />
            <div className="mt-4 flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white">AK</span>
              <div className="min-w-0 flex-1">
                <p className="whitespace-nowrap text-sm font-semibold text-ink">Ahmed Khan, 34</p>
                <p className="truncate text-xs text-muted">Term Life · 20 years · PKR 5,000,000</p>
              </div>
            </div>
            <span
              className={`mt-3 inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold transition-colors duration-500 ${
                s === 3 ? "bg-emerald-50 text-emerald-700" : "bg-chip text-brand"
              }`}
            >
              {status[s]}
            </span>

            <ul className="mt-5 space-y-4">
              {risks.map((r, i) => (
                <li key={r.label}>
                  <div className="flex items-baseline justify-between text-[0.8125rem]">
                    <span className="text-body">{r.label}</span>
                    <span className={`font-semibold tabular-nums text-ink ${reveal(s >= 1)}`} style={delay(s >= 1, i)}>
                      {r.shown}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-chip">
                    <div
                      className="h-full origin-left rounded-full bg-brand transition-transform duration-1000 ease-out"
                      style={{
                        width: `${Math.max(r.pct, 3)}%`,
                        transform: `scaleX(${s >= 1 ? 1 : 0})`,
                        transitionDelay: s >= 1 ? `${200 + i * 160}ms` : "0ms",
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>

            <div className={`mt-5 flex items-start gap-2.5 rounded-lg bg-card p-3 ${reveal(s >= 1)}`} style={delay(s >= 1, 4)}>
              <Icon name="spark" className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
              <p className="text-xs leading-relaxed text-body">
                <span className="font-semibold text-ink">AI insight.</span> Elevated BMI noted in the medical report. This is
                advice for the rules, not a decision.
              </p>
            </div>
          </section>

          {/* Rules */}
          <section className="min-w-0 rounded-xl bg-alt p-4">
            <PanelHead title="Rules" tag="Deterministic" tone="rules" />
            <ul className="mt-4 space-y-3">
              {rules.map((r, i) => {
                const on = s >= 2;
                return (
                  <li key={r} className="flex items-center gap-3">
                    <span className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-chip">
                      <span
                        className={`absolute inset-0 flex items-center justify-center rounded-full bg-emerald-500 text-white transition duration-500 ${
                          on ? "scale-100 opacity-100" : "scale-50 opacity-0"
                        }`}
                        style={{ transitionDelay: on ? `${i * 260}ms` : "0ms" }}
                      >
                        <Icon name="check" className="h-3 w-3" />
                      </span>
                    </span>
                    <span
                      className={`text-[0.8125rem] transition-colors duration-500 ${on ? "text-ink" : "text-muted"}`}
                      style={{ transitionDelay: on ? `${i * 260}ms` : "0ms" }}
                    >
                      {r}
                    </span>
                  </li>
                );
              })}
            </ul>

            <div className={`mt-5 rounded-lg bg-card p-3 ${reveal(s >= 3)}`} style={delay(s >= 3, 0)}>
              <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted">Outcome</p>
              <p className="mt-1 text-sm font-semibold text-ink">Approve with Loading</p>
              <p className="text-xs text-body">+25% extra contribution, medical band 2</p>
            </div>
          </section>

          {/* Audit trail */}
          <section className="min-w-0 rounded-xl bg-alt p-4">
            <PanelHead title="Audit trail" tag="Recorded" tone="audit" />
            <ol className="relative mt-4 space-y-3.5 pl-6">
              <span className="absolute bottom-1 left-[0.4375rem] top-1 w-px bg-line-strong" aria-hidden="true" />
              {audit.map((a, i) => {
                const on = s >= a.from;
                return (
                  <li key={a.text} className={`relative ${reveal(on)}`} style={delay(on, i)}>
                    <span className="absolute -left-6 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-card ring-2 ring-brand" />
                    <p className="text-[0.8125rem] leading-snug text-ink">{a.text}</p>
                    <p className="text-[0.6875rem] tabular-nums text-faint">{a.at}</p>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>

        {/* Decision bar: waiting, then recorded */}
        <div className="relative mx-3 mb-3 h-12 sm:mx-4 sm:mb-4">
          <div className="absolute inset-0 flex items-center gap-2 rounded-xl bg-chip px-4 text-[0.8125rem] text-muted">
            <Icon name="clock" className="h-4 w-4" />
            Decision pending
          </div>
          <div
            className={`absolute inset-0 flex items-center justify-between gap-3 rounded-xl bg-ink px-4 text-[0.8125rem] text-white transition duration-500 ${
              s >= 3 ? "opacity-100" : "opacity-0"
            }`}
          >
            <span className="flex min-w-0 items-center gap-2 font-semibold">
              <Icon name="check" className="h-4 w-4 shrink-0 text-emerald-400" />
              <span className="truncate">Approve with Loading · +25%</span>
            </span>
            <span className="hidden whitespace-nowrap text-blue-200 sm:inline">Recorded 10:05 · replayable step by step</span>
          </div>
        </div>
      </div>
    </div>
  );
}
