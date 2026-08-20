import type { ReactNode } from "react";

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  accent?: "slate" | "emerald" | "amber" | "blue" | "red" | "purple" | "violet" | "orange";
  trend?: { value: string; direction: "up" | "down" | "neutral" };
  icon?: ReactNode;
  size?: "default" | "compact";
}

const ACCENT_GRADIENT: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  slate:   "from-slate-500/5 to-slate-400/5",
  emerald: "from-blue-500/10 to-blue-400/5",
  amber:   "from-amber-500/10 to-orange-400/5",
  blue:    "from-blue-600/10 to-blue-400/5",
  red:     "from-rose-500/10 to-red-400/5",
  purple:  "from-blue-500/10 to-fuchsia-400/5",
  violet:  "from-blue-500/10 to-blue-400/5",
  orange:  "from-orange-500/10 to-amber-400/5",
};

const ACCENT_TEXT: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  slate:   "text-slate-700",
  emerald: "text-blue-800",
  amber:   "text-amber-800",
  blue:    "text-blue-800",
  red:     "text-red-800",
  purple:  "text-blue-800",
  violet:  "text-blue-800",
  orange:  "text-orange-800",
};

const ACCENT_ICON_BG: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  slate:   "bg-white text-slate-600 shadow-slate-200/50",
  emerald: "bg-white text-blue-600 shadow-blue-200/50",
  amber:   "bg-white text-amber-600 shadow-amber-200/50",
  blue:    "bg-white text-blue-600 shadow-blue-200/50",
  red:     "bg-white text-rose-600 shadow-rose-200/50",
  purple:  "bg-white text-blue-600 shadow-blue-200/50",
  violet:  "bg-white text-blue-600 shadow-blue-200/50",
  orange:  "bg-white text-orange-600 shadow-orange-200/50",
};

const TREND_COLOR = {
  up:      "text-blue-600 bg-blue-50",
  down:    "text-rose-600 bg-rose-50",
  neutral: "text-slate-600 bg-slate-50",
};

const TREND_ARROW = { up: "↗", down: "↘", neutral: "→" };

export function MetricCard({ title, value, subtitle, accent = "slate", trend, icon, size = "default" }: MetricCardProps) {
  const isCompact = size === "compact";
  return (
    <div className={`group relative bg-white ${isCompact ? 'rounded-xl' : 'rounded-2xl'} border border-slate-200/70 shadow-[0_4px_20px_rgb(0,0,0,0.03)] overflow-hidden transition-all duration-300 hover:shadow-[0_8px_30px_rgb(0,0,0,0.08)] hover:-translate-y-0.5`}>
      {/* Decorative gradient overlay */}
      <div className={`absolute inset-0 bg-gradient-to-br ${ACCENT_GRADIENT[accent]} opacity-100 pointer-events-none`} />
      
      {/* Glossy top highlight */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/80 to-transparent" />
      
      <div className={`relative ${isCompact ? 'px-3 py-2.5' : 'p-5'}`}>
        <div className="flex items-start justify-between gap-2">
          <p className={`${isCompact ? 'text-[9px]' : 'text-[11px]'} font-bold uppercase tracking-widest text-slate-500/80 truncate`} title={title}>
            {title}
          </p>
          {icon && (
            <span className={`${isCompact ? 'w-6 h-6 rounded-md [&>svg]:w-3.5 [&>svg]:h-3.5' : 'w-10 h-10 rounded-xl'} flex items-center justify-center shrink-0 transition-transform duration-500 group-hover:scale-110 group-hover:rotate-3 shadow-sm ${ACCENT_ICON_BG[accent]}`}>
              {icon}
            </span>
          )}
        </div>
        <div className={isCompact ? 'mt-0.5' : 'mt-3'}>
          <p className={`${isCompact ? 'text-xl' : 'text-[32px]'} leading-tight font-black tracking-tight ${ACCENT_TEXT[accent]} truncate`} title={String(value)}>
            {value}
          </p>
        </div>
        <div className={`${isCompact ? 'mt-1.5' : 'mt-3'} flex items-center gap-1.5`}>
          {trend && (
            <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[9px] font-bold ${TREND_COLOR[trend.direction]} shrink-0`}>
              <span className="text-[10px] leading-none">{TREND_ARROW[trend.direction]}</span> <span className="truncate">{trend.value}</span>
            </span>
          )}
          {subtitle && (
            <span className="text-[10px] font-medium text-slate-500 truncate">{subtitle}</span>
          )}
        </div>
      </div>
    </div>
  );
}
