interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  accent?: "slate" | "emerald" | "amber" | "blue" | "red";
  trend?: { value: string; direction: "up" | "down" | "neutral" };
}

const ACCENT_BAR: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  slate:   "bg-slate-400",
  emerald: "bg-emerald-500",
  amber:   "bg-amber-400",
  blue:    "bg-blue-600",
  red:     "bg-red-500",
};

const ACCENT_TEXT: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  slate:   "text-slate-600",
  emerald: "text-emerald-700",
  amber:   "text-amber-700",
  blue:    "text-blue-700",
  red:     "text-red-700",
};

const TREND_COLOR = {
  up:      "text-emerald-600",
  down:    "text-red-500",
  neutral: "text-slate-500",
};

const TREND_ARROW = { up: "↑", down: "↓", neutral: "→" };

export function MetricCard({ title, value, subtitle, accent = "slate", trend }: MetricCardProps) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-card overflow-hidden">
      <div className={`h-1 ${ACCENT_BAR[accent]}`} />
      <div className="p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
          {title}
        </p>
        <p className={`mt-2 text-4xl font-extrabold tracking-tight ${ACCENT_TEXT[accent]}`}>
          {value}
        </p>
        <div className="mt-2 flex items-center gap-2">
          {trend && (
            <span className={`text-xs font-semibold ${TREND_COLOR[trend.direction]}`}>
              {TREND_ARROW[trend.direction]} {trend.value}
            </span>
          )}
          {subtitle && (
            <span className="text-xs text-slate-500">{subtitle}</span>
          )}
        </div>
      </div>
    </div>
  );
}
