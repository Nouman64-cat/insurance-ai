"use client";

import {
  ISSUANCE_STAGES,
  stageStates,
  normStatus,
  TERMINAL,
  isTerminal,
  type StageState,
} from "./lifecycle";

interface LifecycleStepperProps {
  status: string;
  /** compact = smaller dots for use inside table rows / tight spaces. */
  compact?: boolean;
}

const DOT: Record<StageState, string> = {
  done: "bg-emerald-500 border-emerald-500 text-white",
  current: "bg-white border-emerald-500 text-emerald-600 ring-4 ring-emerald-100",
  upcoming: "bg-white border-slate-300 text-slate-300",
};

const CONNECTOR: Record<StageState, string> = {
  done: "bg-emerald-500",
  current: "bg-slate-200",
  upcoming: "bg-slate-200",
};

/**
 * Horizontal stepper visualising where a policy sits in the issuance journey.
 * Renders a distinct terminal banner for Lapsed / Cancelled / Declined so those
 * off-ramp states never look like a stalled step.
 */
export function LifecycleStepper({ status, compact = false }: Readonly<LifecycleStepperProps>) {
  if (isTerminal(status)) {
    const t = TERMINAL[normStatus(status)];
    return (
      <div
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
          t.tone === "red"
            ? "bg-red-50 border-red-200 text-red-700"
            : "bg-amber-50 border-amber-200 text-amber-700"
        }`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        <span className="text-xs font-semibold">
          Journey ended — policy {t.label.toLowerCase()}.
        </span>
      </div>
    );
  }

  const states = stageStates(status);
  const dotSize = compact ? "w-4 h-4 text-[9px]" : "w-7 h-7 text-xs";

  return (
    <div className="flex items-start w-full">
      {ISSUANCE_STAGES.map((stage, i) => {
        const state = states[i];
        const isLast = i === ISSUANCE_STAGES.length - 1;
        return (
          <div key={stage.key} className="flex-1 flex flex-col items-center relative">
            {/* connector to next node */}
            {!isLast && (
              <div
                className={`absolute left-1/2 w-full h-0.5 ${CONNECTOR[states[i + 1] === "done" || state === "done" ? "done" : "upcoming"]}`}
                style={{ top: compact ? 7 : 13 }}
              />
            )}
            <div
              className={`relative z-10 rounded-full border-2 flex items-center justify-center font-bold ${dotSize} ${DOT[state]}`}
            >
              {state === "done" ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={compact ? "w-2.5 h-2.5" : "w-3.5 h-3.5"}>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                i + 1
              )}
            </div>
            {!compact && (
              <div className="mt-2 text-center px-1">
                <p
                  className={`text-[11px] font-semibold leading-tight ${
                    state === "upcoming" ? "text-slate-400" : "text-slate-700"
                  }`}
                >
                  {stage.label}
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
