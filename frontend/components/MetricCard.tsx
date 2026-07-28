import type { ReactNode } from "react";

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  accent?: "slate" | "emerald" | "amber" | "blue" | "red" | "purple" | "violet" | "orange";
  trend?: { value: string; direction: "up" | "down" | "neutral" };
  icon?: ReactNode;
}

const ACCENT_GRADIENT: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  slate:   "from-slate-500/5 to-slate-400/5",
  emerald: "from-emerald-500/10 to-teal-400/5",
  amber:   "from-amber-500/10 to-orange-400/5",
  blue:    "from-blue-600/10 to-indigo-400/5",
  red:     "from-rose-500/10 to-red-400/5",
  purple:  "from-purple-500/10 to-fuchsia-400/5",
  violet:  "from-violet-500/10 to-purple-400/5",
  orange:  "from-orange-500/10 to-amber-400/5",
};

const ACCENT_TEXT: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  slate:   "text-slate-700",
  emerald: "text-emerald-800",
  amber:   "text-amber-800",
  blue:    "text-blue-800",
  red:     "text-red-800",
  purple:  "text-purple-800",
  violet:  "text-violet-800",
  orange:  "text-orange-800",
};

const ACCENT_ICON_BG: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  slate:   "bg-white text-slate-600 shadow-slate-200/50",
  emerald: "bg-white text-emerald-600 shadow-emerald-200/50",
  amber:   "bg-white text-amber-600 shadow-amber-200/50",
  blue:    "bg-white text-blue-600 shadow-blue-200/50",
  red:     "bg-white text-rose-600 shadow-rose-200/50",
  purple:  "bg-white text-purple-600 shadow-purple-200/50",
  violet:  "bg-white text-violet-600 shadow-violet-200/50",
  orange:  "bg-white text-orange-600 shadow-orange-200/50",
};

const TREND_COLOR = {
  up:      "text-emerald-600 bg-emerald-50",
  down:    "text-rose-600 bg-rose-50",
  neutral: "text-slate-600 bg-slate-50",
};

const TREND_ARROW = { up: "↗", down: "↘", neutral: "→" };

export function MetricCard({ title, value, subtitle, accent = "slate", trend, icon }: MetricCardProps) {
  return (
    <div className={`group relative bg-white rounded-2xl border border-slate-200/70 shadow-[0_4px_20px_rgb(0,0,0,0.03)] overflow-hidden transition-all duration-300 hover:shadow-[0_8px_30px_rgb(0,0,0,0.08)] hover:-translate-y-0.5`}>
      {/* Decorative gradient overlay */}
      <div className={`absolute inset-0 bg-gradient-to-br ${ACCENT_GRADIENT[accent]} opacity-100 pointer-events-none`} />
      
      {/* Glossy top highlight */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/80 to-transparent" />
      
      <div className="relative p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500/80">
            {title}
          </p>
          {icon && (
            <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-transform duration-500 group-hover:scale-110 group-hover:rotate-3 shadow-sm ${ACCENT_ICON_BG[accent]}`}>
              {icon}
            </span>
          )}
        </div>
        <div className="mt-3">
          <p className={`text-[32px] leading-tight font-black tracking-tight ${ACCENT_TEXT[accent]}`}>
            {value}
          </p>
        </div>
        <div className="mt-3 flex items-center gap-2.5">
          {trend && (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold ${TREND_COLOR[trend.direction]}`}>
              <span className="text-sm leading-none">{TREND_ARROW[trend.direction]}</span> {trend.value}
            </span>
          )}
          {subtitle && (
            <span className="text-[11px] font-medium text-slate-500 truncate">{subtitle}</span>
          )}
        </div>
      </div>
    </div>
  );
}
