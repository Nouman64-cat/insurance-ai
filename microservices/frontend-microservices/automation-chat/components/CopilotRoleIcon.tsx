/** Shared role icon used by the portal launcher and embedded/full chat. Display only. */
const VISUALS: Record<string, { icon: string; color: string; path: string }> = {
  "Finance Copilot": { icon: "finance", color: "bg-emerald-50 text-emerald-700", path: "M3 10h18M12 3l9 5H3l9-5ZM5 10v8m5-8v8m4-8v8m5-8v8M3 21h18" },
  "Medical Underwriting Copilot": { icon: "medical", color: "bg-rose-50 text-rose-600", path: "M7 3H5v5a5 5 0 0 0 10 0V3h-2M10 13v3a5 5 0 0 0 10 0v-2M18 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0" },
  "Financial Underwriting Copilot": { icon: "financial-underwriting", color: "bg-violet-50 text-violet-600", path: "M4 3v18h17M8 16v-4m5 4V8m5 8V5" },
  "Claims Copilot": { icon: "claims", color: "bg-blue-50 text-blue-600", path: "M9 4H5v17h14V4h-4M9 2h6v4H9V2ZM8 13l3 3 5-6" },
  "Underwriting Copilot": { icon: "underwriting", color: "bg-indigo-50 text-indigo-600", path: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3ZM8 12l3 3 5-6" },
};
const DEFAULT = { icon: "assistant", color: "bg-blue-50 text-blue-600", path: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" };


export default function CopilotRoleIcon({ name, className = "h-8 w-8" }: { name: string; className?: string }) {
  const visual = VISUALS[name] ?? DEFAULT;
  return <span data-copilot-icon={visual.icon} className={`inline-flex shrink-0 items-center justify-center rounded-full ${visual.color} ${className}`}>
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d={visual.path}/></svg>
  </span>;
}
