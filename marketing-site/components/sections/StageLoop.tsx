"use client";

import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";

// A small, self-running card for inner-page heroes: one case moving through four stages.
const stages: { label: string; icon: IconName; line: string }[] = [
  { label: "Lead", icon: "users", line: "A new application arrives from the agent app, the portal or the copilot." },
  { label: "AI analysis", icon: "spark", line: "Medical, financial and fraud risk are scored in parallel, as advice." },
  { label: "Rules", icon: "shield", line: "A deterministic rule chain turns the scores into a verdict." },
  { label: "Decision", icon: "file", line: "The outcome and the reasons behind it are recorded and replayable." },
];

export function StageLoop({ className = "" }: Readonly<{ className?: string }>) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setStep((s) => (s + 1) % stages.length), 2200);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className={`rounded-2xl bg-card/90 p-5 shadow-surface ring-1 ring-line ${className}`} role="img" aria-label="A case moving from lead to decision, demo">
      <div aria-hidden="true">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold uppercase tracking-wider text-muted">A case, start to finish</span>
          <span className="rounded-full bg-chip px-2.5 py-1 text-[0.6875rem] font-medium text-body">Demo data</span>
        </div>

        <ol className="mt-5 flex items-center">
          {stages.map((s, i) => (
            <li key={s.label} className="flex flex-1 items-center last:flex-none">
              <span
                className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors duration-500 ${
                  step >= i ? "bg-brand text-white" : "bg-chip text-muted"
                } ${step === i ? "shadow-glow" : ""}`}
              >
                <Icon name={step > i ? "check" : s.icon} className="h-4 w-4" />
                {step === i && <span className="node-ping absolute inset-0 rounded-full bg-brand/40" />}
              </span>
              {i < stages.length - 1 && (
                <span className="relative mx-2 h-0.5 flex-1 bg-chip">
                  <span
                    className="absolute inset-0 origin-left bg-brand transition-transform duration-700 ease-out"
                    style={{ transform: `scaleX(${step > i ? 1 : 0})` }}
                  />
                </span>
              )}
            </li>
          ))}
        </ol>

        <div key={step} className="sc-in mt-5 min-h-[3.5rem]" style={{ "--d": 0 } as React.CSSProperties}>
          <p className="text-sm font-semibold text-ink">{stages[step].label}</p>
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-body">{stages[step].line}</p>
        </div>
      </div>
    </div>
  );
}
