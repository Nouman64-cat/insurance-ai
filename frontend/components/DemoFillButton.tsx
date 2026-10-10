"use client";

import { IS_DEMO } from "@/lib/envMode";

/**
 * Fills the surrounding form with realistic random values (lib/demoData.ts).
 * Renders nothing unless ENV_VAR=demo, so it never ships to staging/prod UIs.
 */
export default function DemoFillButton({ onFill, className = "" }: { onFill: () => void; className?: string }) {
  if (!IS_DEMO) return null;
  return (
    <button
      type="button"
      onClick={onFill}
      title="Fill this form with random demo values"
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold text-violet-700 bg-violet-50 border border-dashed border-violet-300 rounded-lg hover:bg-violet-100 transition-colors ${className}`}
    >
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="w-3.5 h-3.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
      </svg>
      Fill demo data
    </button>
  );
}
