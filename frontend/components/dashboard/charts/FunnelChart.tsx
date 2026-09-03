"use client";

export interface FunnelStage {
  key: string;
  label: string;
  value: number;
  color: string; // tailwind bg-* class
}

interface FunnelChartProps {
  stages: FunnelStage[];
  formatValue?: (v: number) => string;
}

/**
 * Ordered stage bars that narrow left-to-right, with the conversion rate
 * between consecutive stages called out — a real funnel technique instead of
 * independent per-stage percentage bars.
 */
export function FunnelChart({ stages, formatValue }: FunnelChartProps) {
  const base = stages[0]?.value || 1;
  const fmt = formatValue ?? ((v: number) => String(v));

  return (
    <div className="space-y-2">
      {stages.map((stage, i) => {
        const widthPct = Math.max((stage.value / base) * 100, stage.value > 0 ? 8 : 0);
        const prev = stages[i - 1];
        const conversionPct = prev && prev.value > 0 ? (stage.value / prev.value) * 100 : null;

        return (
          <div key={stage.key}>
            {conversionPct !== null && (
              <div className="flex items-center justify-center py-0.5">
                <span className="text-[9px] font-bold text-slate-400 tracking-wide">
                  ↓ {conversionPct.toFixed(0)}%
                </span>
              </div>
            )}
            <div className="flex items-center gap-3">
              <span className="w-28 shrink-0 text-xs text-slate-600 truncate">{stage.label}</span>
              <div className="flex-1 h-6 rounded-md bg-slate-100/80 overflow-hidden">
                <div
                  className={`h-full rounded-md ${stage.color} flex items-center justify-end px-2 transition-all duration-500`}
                  style={{ width: `${widthPct}%` }}
                >
                  <span className="text-[10px] font-bold text-white font-mono tabular-nums whitespace-nowrap">{fmt(stage.value)}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
