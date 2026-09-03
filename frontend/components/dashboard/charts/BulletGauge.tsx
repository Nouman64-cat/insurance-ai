"use client";

interface BulletGaugeProps {
  label: string;
  value: number;
  target: number;
  max?: number;
  formatValue?: (v: number) => string;
  color?: string; // tailwind bg-* class for the value bar
  sublabel?: string;
}

/**
 * Horizontal target-vs-actual bullet chart: a filled bar for the actual
 * value against a track, with a tick marking the target — replaces a bare
 * "X%" stat tile with a real actual-vs-SLA visual.
 */
export function BulletGauge({ label, value, target, max, formatValue, color = "bg-blue-600", sublabel }: BulletGaugeProps) {
  const scaleMax = max ?? Math.max(target, value) * 1.25;
  const valuePct = Math.min(Math.max((value / scaleMax) * 100, 0), 100);
  const targetPct = Math.min(Math.max((target / scaleMax) * 100, 0), 100);
  const fmt = formatValue ?? ((v: number) => String(v));
  const met = value >= target;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-slate-600 truncate">{label}</span>
        <span className={`text-xs font-bold font-mono tabular-nums shrink-0 ml-2 ${met ? "text-emerald-700" : "text-amber-700"}`}>
          {fmt(value)} <span className="text-slate-400 font-medium">/ {fmt(target)}</span>
        </span>
      </div>
      <div className="relative h-2.5 rounded-full bg-slate-100/80 overflow-visible">
        <div
          className={`h-full rounded-full ${met ? "bg-emerald-500" : color} transition-all duration-500`}
          style={{ width: `${valuePct}%` }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-0.5 h-4 bg-slate-700 rounded-full"
          style={{ left: `${targetPct}%` }}
          title={`Target: ${fmt(target)}`}
        />
      </div>
      {sublabel && <p className="text-[10px] text-slate-400">{sublabel}</p>}
    </div>
  );
}
