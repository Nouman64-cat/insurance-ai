"use client";

interface NarrativeHeaderProps {
  text: string;
}

/** One auto-generated sentence summarizing the biggest movers vs. the prior
 *  period. Re-mounts (via the caller's `key`) to replay its entrance on refresh. */
export function NarrativeHeader({ text }: NarrativeHeaderProps) {
  return (
    <div className="animate-narrative-in flex items-start gap-2.5 bg-gradient-to-r from-blue-50/70 via-white to-white border border-blue-100/70 rounded-xl px-4 py-2.5">
      <span className="mt-0.5 w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center shrink-0 shadow-sm">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      </span>
      <p className="text-[12.5px] leading-snug text-slate-700">
        <span className="font-bold text-slate-900">Portfolio snapshot — </span>
        {text}
      </p>
    </div>
  );
}
