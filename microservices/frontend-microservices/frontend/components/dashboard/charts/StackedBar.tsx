"use client";

export interface StackedBarSegment {
  key: string;
  label: string;
  value: number;
  color: string; // tailwind bg-* class
}

interface StackedBarProps {
  segments: StackedBarSegment[];
  formatValue?: (v: number) => string;
}

/**
 * A single 100%-wide bar split into colored segments, with a legend below —
 * one compact visual for a mix/composition instead of N independent rows
 * that all repeat the same "value / total" arithmetic.
 */
export function StackedBar({ segments, formatValue }: StackedBarProps) {
  const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;
  const fmt = formatValue ?? ((v: number) => `${v.toFixed(0)}%`);

  return (
    <div className="space-y-2.5">
      <div className="flex h-3 w-full rounded-full overflow-hidden bg-slate-100/80">
        {segments.map((seg) => {
          const pct = (seg.value / total) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={seg.key}
              className={`h-full ${seg.color} transition-all duration-500 first:rounded-l-full last:rounded-r-full`}
              style={{ width: `${pct}%` }}
              title={`${seg.label}: ${fmt(seg.value)}`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((seg) => (
          <div key={seg.key} className="flex items-center gap-1.5 text-[10px]">
            <span className={`w-2 h-2 rounded-full shrink-0 ${seg.color}`} />
            <span className="text-slate-500">{seg.label}</span>
            <span className="font-bold text-slate-700 font-mono tabular-nums">{fmt(seg.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
