"use client";

import React from "react";
import type { ProcessStep } from "@/lib/agent/types";

/**
 * Live state-graph of the agent's current turn, rendered as a vertical
 * linked list of nodes. Each node animates in when its step starts
 * ("active": pulsing dot + shimmering label), then settles to a green check
 * ("done") or red cross ("error"); the connector line to the next node fills
 * in as work progresses — a train moving station to station.
 */

function NodeIcon({ status }: { status: ProcessStep["status"] }) {
  if (status === "done") {
    return (
      <span className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center shrink-0 animate-in zoom-in duration-300">
        <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="w-5 h-5 rounded-full bg-rose-500 flex items-center justify-center shrink-0 animate-in zoom-in duration-300">
        <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" className="w-3 h-3">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </span>
    );
  }
  // active — pulsing core with a radiating ping ring
  return (
    <span className="relative w-5 h-5 flex items-center justify-center shrink-0">
      <span className="absolute inset-0 rounded-full bg-blue-400 opacity-60 animate-ping" />
      <span className="relative w-3 h-3 rounded-full bg-gradient-to-br from-blue-500 to-fuchsia-500" />
    </span>
  );
}

export function ProcessGraph({ steps, compact = false }: { steps: ProcessStep[]; compact?: boolean }) {
  if (steps.length === 0) return null;

  return (
    <div
      className={`rounded-xl border border-blue-100 bg-white/80 backdrop-blur-sm shadow-sm ${compact ? "px-3 py-2" : "px-3.5 py-3"}`}
      aria-live="polite"
    >
      <p className="text-[9px] font-extrabold uppercase tracking-widest text-blue-400 mb-1.5 flex items-center gap-1.5">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
          <circle cx="5" cy="6" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="18" r="2" />
          <path d="M7 7l3 3M14 13l3 3" strokeLinecap="round" />
        </svg>
        Process
      </p>
      <ol className="relative">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1;
          return (
            <li key={step.id} className="flex gap-2.5 animate-in fade-in slide-in-from-left-2 duration-300">
              {/* Node + connector column */}
              <div className="flex flex-col items-center">
                <NodeIcon status={step.status} />
                {!isLast && (
                  <span
                    className={`w-0.5 flex-1 min-h-[10px] my-0.5 rounded-full transition-colors duration-500 ${
                      step.status === "done"
                        ? "bg-blue-300"
                        : step.status === "error"
                        ? "bg-rose-200"
                        : "bg-blue-200 animate-pulse"
                    }`}
                  />
                )}
              </div>
              {/* Label */}
              <div className={`pb-2 ${isLast ? "pb-0" : ""} min-w-0`}>
                <p
                  className={`text-[12px] leading-5 font-semibold truncate ${
                    step.status === "active"
                      ? "text-blue-700 animate-pulse"
                      : step.status === "error"
                      ? "text-rose-600"
                      : "text-slate-600"
                  }`}
                >
                  {step.label}
                  {step.status === "active" && <span className="text-blue-400">…</span>}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
