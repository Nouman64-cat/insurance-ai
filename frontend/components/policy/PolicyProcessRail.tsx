"use client";

import { useState } from "react";
import type { PolicyListItem } from "@/app/services/policies";
import { ISSUANCE_STAGES, normStatus } from "./lifecycle";

interface RailProps {
  policies: PolicyListItem[];
}

// Context steps that bracket the issuance journey — shown greyed as "before"
// and "after" so the operator sees the full Adamjee-style lifecycle at a glance.
const BEFORE = { label: "Underwriting", blurb: "Risk scored & priced" };
const AFTER = { label: "Servicing & Renewal", blurb: "Billing, endorsements, renewals" };

/**
 * A horizontal "process rail" that teaches the end-to-end policy workflow and
 * shows how many live policies sit at each issuance stage. Collapsible so it
 * educates on first view without permanently occupying vertical space.
 */
export function PolicyProcessRail({ policies }: Readonly<RailProps>) {
  const [open, setOpen] = useState(true);

  const counts = ISSUANCE_STAGES.map(
    (st) => policies.filter((p) => st.statuses.includes(normStatus(p.status))).length,
  );

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-emerald-600">
            <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
          </svg>
          <span className="text-sm font-semibold text-slate-700">How policy issuance works</span>
        </div>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`w-4 h-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="px-5 pb-5 pt-1 overflow-x-auto">
          <div className="flex items-stretch gap-2 min-w-[720px]">
            {/* before */}
            <PhaseNode label={BEFORE.label} blurb={BEFORE.blurb} muted />
            <Arrow />
            {/* issuance stages */}
            {ISSUANCE_STAGES.map((st, i) => (
              <div key={st.key} className="flex items-stretch gap-2">
                <div className="flex-1 min-w-[130px] rounded-lg border border-emerald-100 bg-emerald-50/50 px-3 py-2.5">
                  <div className="flex items-center justify-between">
                    <span className="w-5 h-5 rounded-full bg-emerald-600 text-white text-[10px] font-bold flex items-center justify-center">
                      {i + 1}
                    </span>
                    {counts[i] > 0 && (
                      <span className="text-[10px] font-bold text-emerald-700 bg-white border border-emerald-200 rounded-full px-2 py-0.5">
                        {counts[i]}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] font-semibold text-slate-800 mt-1.5 leading-tight">{st.label}</p>
                  <p className="text-[10px] text-slate-500 mt-0.5 leading-snug">{st.blurb}</p>
                </div>
                {i < ISSUANCE_STAGES.length - 1 && <Arrow />}
              </div>
            ))}
            <Arrow />
            {/* after */}
            <PhaseNode label={AFTER.label} blurb={AFTER.blurb} muted />
          </div>
        </div>
      )}
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex items-center text-slate-300">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
        <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
      </svg>
    </div>
  );
}

function PhaseNode({ label, blurb, muted }: Readonly<{ label: string; blurb: string; muted?: boolean }>) {
  return (
    <div
      className={`flex-1 min-w-[120px] rounded-lg border px-3 py-2.5 ${
        muted ? "border-slate-200 bg-slate-50" : "border-emerald-100 bg-emerald-50/50"
      }`}
    >
      <p className="text-[11px] font-semibold text-slate-600 leading-tight">{label}</p>
      <p className="text-[10px] text-slate-400 mt-0.5 leading-snug">{blurb}</p>
    </div>
  );
}
