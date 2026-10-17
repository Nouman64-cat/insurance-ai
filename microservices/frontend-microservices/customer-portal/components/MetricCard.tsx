"use client";
import type { ReactNode } from "react";

// Same card as the staff app's MetricCard (frontend/components/MetricCard.tsx): gradient wash, uppercase label, large value.
type Accent = "slate" | "blue" | "emerald" | "amber" | "red" | "sky";

const GRADIENT: Record<Accent, string> = {
  slate: "from-slate-500/5 to-slate-400/5", blue: "from-blue-600/10 to-blue-400/5", emerald: "from-emerald-500/10 to-emerald-400/5",
  amber: "from-amber-500/10 to-orange-400/5", red: "from-rose-500/10 to-red-400/5", sky: "from-sky-500/10 to-sky-400/5",
};
const TEXT: Record<Accent, string> = { slate: "text-slate-800", blue: "text-blue-800", emerald: "text-emerald-800", amber: "text-amber-800", red: "text-red-800", sky: "text-sky-800" };
const ICON: Record<Accent, string> = {
  slate: "text-slate-600", blue: "text-blue-600", emerald: "text-emerald-600", amber: "text-amber-600", red: "text-rose-600", sky: "text-sky-600",
};

export function MetricCard({ title, value, subtitle, accent = "slate", icon, loading = false, unavailable = false }: {
  title: string; value: ReactNode; subtitle?: ReactNode; accent?: Accent; icon?: ReactNode; loading?: boolean; unavailable?: boolean;
}) {
  return (
    <div className="group relative min-w-0 bg-white rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgb(0,0,0,0.03)] overflow-hidden transition-all duration-300 hover:shadow-[0_8px_30px_rgb(0,0,0,0.08)] hover:-translate-y-0.5">
      <div className={`absolute inset-0 bg-gradient-to-br ${GRADIENT[accent]} pointer-events-none`} />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/80 to-transparent" />
      <div className="relative px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500/80 truncate" title={title}>{title}</p>
          {icon && <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-white shadow-sm ${ICON[accent]}`} aria-hidden="true">{icon}</span>}
        </div>
        <div className="mt-1.5 min-h-[32px]">
          {loading ? <div className="h-7 w-28 rounded-md bg-slate-200/70 animate-pulse" />
            : unavailable ? <p className="text-2xl leading-tight font-black text-slate-300">—</p>
            : <p className={`text-2xl leading-tight font-black tracking-tight ${TEXT[accent]} truncate`}>{value}</p>}
        </div>
        {subtitle && <p className="mt-1.5 text-[11px] font-medium text-slate-500 truncate">{subtitle}</p>}
      </div>
    </div>
  );
}
