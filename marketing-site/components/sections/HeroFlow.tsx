"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { lifecycle } from "@/content/home";

const STEP_MS = 2400;
const LAST = lifecycle.length - 1;

// A policy travelling through the seven lifecycle stages. One state change every 2.4 s drives
// everything: the blue track fills (scaleX), the next stage lights up (opacity) and its caption
// fades in. Only transform and opacity animate, so it stays on the GPU like the rest of the hero.
export function HeroFlow() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setStep((s) => (s === LAST ? 0 : s + 1)), STEP_MS);
    return () => window.clearInterval(id);
  }, []);

  const stage = lifecycle[step];

  return (
    <div
      className="intro-left mt-10 max-w-[40rem] rounded-2xl bg-card/80 p-5 shadow-card sm:p-6 2xl:mt-14 2xl:max-w-[46rem]"
      style={{ "--i": 4 } as React.CSSProperties}
      role="group"
      aria-label="A policy moving through the lifecycle (demo)"
    >
      <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted">
        <span>A policy&rsquo;s journey</span>
        <span className="tabular-nums text-accent">
          0{step + 1} / 0{lifecycle.length}
        </span>
      </div>

      <div className="relative mt-6">
        {/* Track: pale base, blue fill that grows to the current stage */}
        <div className="absolute left-5 right-5 top-5 h-0.5 -translate-y-1/2 bg-chip" aria-hidden="true" />
        <div
          className={`absolute left-5 right-5 top-5 h-0.5 origin-left -translate-y-1/2 bg-brand ${
            step === 0 ? "" : "transition-transform ease-linear"
          }`}
          style={{ transform: `translateY(-50%) scaleX(${step / LAST})`, transitionDuration: `${STEP_MS}ms` }}
          aria-hidden="true"
        />

        <ol className="relative flex justify-between">
          {lifecycle.map((s, i) => {
            const reached = step >= i;
            const current = step === i;
            return (
              <li key={s.title} className="relative h-10 w-10">
                <span
                  className={`absolute inset-0 flex items-center justify-center rounded-full bg-chip text-muted transition-transform duration-500 ${
                    current ? "scale-110" : ""
                  }`}
                >
                  <span className="h-[18px] w-[18px]">
                    <Icon name={s.icon} className="h-full w-full" />
                  </span>
                </span>
                <span
                  className={`absolute inset-0 flex items-center justify-center rounded-full bg-brand text-white shadow-glow transition-[opacity,transform] duration-500 ${
                    reached ? "opacity-100" : "opacity-0"
                  } ${current ? "scale-110" : ""}`}
                >
                  <span className="h-[18px] w-[18px]">
                    <Icon name={s.icon} className="h-full w-full" />
                  </span>
                </span>
                {current && <span className="node-ping absolute inset-0 rounded-full bg-brand/40" aria-hidden="true" />}
                <span
                  className={`absolute left-1/2 top-full mt-2 hidden -translate-x-1/2 whitespace-nowrap text-xs font-medium transition-colors duration-500 sm:block ${
                    reached ? "text-ink" : "text-faint"
                  }`}
                >
                  {s.title}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="mt-4 min-h-[4.25rem] sm:mt-10" aria-live="off">
        <p key={step} className="flow-caption text-sm leading-relaxed text-body">
          <span className="font-semibold text-ink">{stage.title}. </span>
          {stage.body}
        </p>
      </div>
    </div>
  );
}
