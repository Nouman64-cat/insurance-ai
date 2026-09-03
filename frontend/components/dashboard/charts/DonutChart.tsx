"use client";

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  colorHex: string;
}

interface DonutChartProps {
  segments: DonutSegment[];
  size?: number;
  strokeW?: number;
  centerLabel?: string;
  centerValue?: string;
  formatValue?: (v: number) => string;
}

/**
 * A sparse-category donut (intended for <=5 segments per the portal's data
 * viz guidelines) — used for splits like claim type mix where a stacked bar
 * would be too dense to read at a glance.
 */
export function DonutChart({ segments, size = 108, strokeW = 16, centerLabel, centerValue, formatValue }: DonutChartProps) {
  const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;
  const r = (size - strokeW) / 2;
  const circ = 2 * Math.PI * r;
  const fmt = formatValue ?? ((v: number) => `${Math.round((v / total) * 100)}%`);

  let offset = 0;
  const arcs = segments
    .filter((seg) => seg.value > 0)
    .map((seg) => {
      const frac = seg.value / total;
      const dash = frac * circ;
      const arc = { ...seg, dash, gap: circ - dash, offset };
      offset += dash;
      return arc;
    });

  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)", display: "block" }}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={strokeW} />
          {arcs.map((arc) => (
            <circle
              key={arc.key}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={arc.colorHex}
              strokeWidth={strokeW}
              strokeDasharray={`${arc.dash} ${arc.gap}`}
              strokeDashoffset={-arc.offset}
            />
          ))}
        </svg>
        {(centerLabel || centerValue) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none text-center">
            {centerValue && <span className="text-base font-extrabold text-slate-900 leading-none">{centerValue}</span>}
            {centerLabel && <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mt-1">{centerLabel}</span>}
          </div>
        )}
      </div>
      <div className="space-y-1.5 min-w-0">
        {segments.map((seg) => (
          <div key={seg.key} className="flex items-center gap-1.5 text-[11px]">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: seg.colorHex }} />
            <span className="text-slate-500 truncate">{seg.label}</span>
            <span className="font-bold text-slate-800 font-mono shrink-0">{fmt(seg.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
