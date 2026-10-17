"use client";

export interface WaterfallStep {
  key: string;
  label: string;
  value: number;
  /** "total" bars span from zero; "decrease"/"increase" float from the running baseline. */
  kind: "total" | "decrease" | "increase";
}

interface WaterfallChartProps {
  steps: WaterfallStep[];
  formatValue?: (v: number) => string;
  height?: number;
}

const KIND_COLOR: Record<WaterfallStep["kind"], string> = {
  total: "bg-blue-600",
  decrease: "bg-rose-500",
  increase: "bg-emerald-500",
};

/**
 * A bridge chart: totals anchor from zero, decreases/increases float from
 * the running cumulative baseline with a connector to the next bar — shows
 * how a starting figure is whittled down to a final one, instead of a list
 * of unrelated numbers.
 */
export function WaterfallChart({ steps, formatValue, height = 150 }: WaterfallChartProps) {
  const fmt = formatValue ?? ((v: number) => String(v));

  let running = 0;
  const bars = steps.map((step) => {
    let top: number;
    let bottom: number;
    if (step.kind === "total") {
      bottom = 0;
      top = step.value;
      running = step.value;
    } else if (step.kind === "decrease") {
      top = running;
      bottom = running - step.value;
      running = bottom;
    } else {
      bottom = running;
      top = running + step.value;
      running = top;
    }
    return { ...step, top, bottom };
  });

  const maxVal = Math.max(...bars.map((b) => Math.max(b.top, b.bottom)), 1);

  return (
    <div>
      <div className="flex items-end gap-1" style={{ height }}>
        {bars.map((bar, i) => {
          const topPct = (bar.top / maxVal) * 100;
          const bottomPct = (bar.bottom / maxVal) * 100;
          const heightPct = Math.max(topPct - bottomPct, 1.5);
          const next = bars[i + 1];

          return (
            <div key={bar.key} className="relative flex-1 h-full">
              {/* Connector to next bar's baseline */}
              {next && (
                <div
                  className="absolute right-0 border-t border-dashed border-slate-300"
                  style={{ bottom: `${topPct}%`, width: "calc(50% + 0.25rem)" }}
                />
              )}
              <span
                className="absolute w-full text-center text-[10px] font-bold text-slate-700 font-mono whitespace-nowrap"
                style={{ bottom: `calc(${Math.max(topPct, bottomPct)}% + 4px)` }}
              >
                {fmt(bar.value)}
              </span>
              <div
                className={`absolute w-full rounded-sm ${KIND_COLOR[bar.kind]} transition-all duration-300`}
                style={{ bottom: `${bottomPct}%`, height: `${heightPct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex gap-1 mt-1.5">
        {bars.map((bar) => (
          <span key={bar.key} className="flex-1 text-center text-[10px] font-semibold text-slate-500 truncate" title={bar.label}>
            {bar.label}
          </span>
        ))}
      </div>
    </div>
  );
}
