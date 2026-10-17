"use client";

import React, { useState } from "react";

export interface MiniBarChartItem {
  key: string;
  label: string;
  value: number;
  color: string; // tailwind bg-* class
  formattedValue?: string;
  sublabel?: string;
}

interface MiniBarChartProps {
  items: MiniBarChartItem[];
  /** Overrides the shared scale max; defaults to the largest item value. */
  maxValue?: number;
}

/**
 * A coordinated horizontal bar chart — every bar shares one scale, unlike
 * independent progress-bar rows each scaled to their own percentage.
 */
export function MiniBarChart({ items, maxValue }: MiniBarChartProps) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const max = maxValue ?? Math.max(...items.map((i) => i.value), 1);

  return (
    <div className="space-y-2.5">
      {items.map((item) => {
        const widthPct = Math.min((item.value / (max || 1)) * 100, 100);
        const isHovered = hoveredKey === item.key;

        return (
          <div
            key={item.key}
            className={`space-y-1 rounded-lg -mx-1 px-1 py-0.5 transition-colors ${isHovered ? "bg-slate-50" : ""}`}
            onMouseEnter={() => setHoveredKey(item.key)}
            onMouseLeave={() => setHoveredKey(null)}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="text-xs text-slate-600 truncate">{item.label}</span>
                {item.sublabel && <span className="block text-[10px] text-slate-400 truncate">{item.sublabel}</span>}
              </div>
              <span className="text-xs font-bold text-slate-700 shrink-0 ml-2 font-mono tabular-nums">
                {item.formattedValue ?? item.value}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-slate-100/80 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${item.color} ${isHovered ? "opacity-100" : "opacity-90"}`}
                style={{ width: `${widthPct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
