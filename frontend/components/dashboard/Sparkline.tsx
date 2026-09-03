"use client";

import React, { useState } from "react";
import { smoothPathFromPoints, areaPathFromPoints } from "@/lib/chartPaths";

export interface SparklinePoint {
  label: string;
  value: number;
}

interface SparklineProps {
  data: SparklinePoint[];
  color?: string; // hex
  gradientId: string; // must be unique per instance on the page
  height?: number;
  valueFormatter?: (v: number) => string;
}

const WIDTH = 300;
const PAD_X = 4;

export function Sparkline({ data, color = "#2563eb", gradientId, height = 56, valueFormatter }: SparklineProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (data.length === 0) {
    return <div className="h-14 flex items-center justify-center text-[10px] text-slate-400 italic">No trend data yet.</div>;
  }

  const max = Math.max(...data.map((d) => d.value), 1);
  const chartW = WIDTH - PAD_X * 2;
  const getX = (idx: number) => PAD_X + (data.length === 1 ? chartW / 2 : (idx / (data.length - 1)) * chartW);
  const getY = (val: number) => height - 4 - (val / max) * (height - 8);

  const pts = data.map((d, idx) => ({ x: getX(idx), y: getY(d.value) }));
  const linePath = smoothPathFromPoints(pts);
  const areaPath = areaPathFromPoints(pts, height);

  const fmt = valueFormatter ?? ((v: number) => `${v}`);

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full" style={{ height }} onMouseLeave={() => setHoverIdx(null)}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
        <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p, idx) => (
          <circle
            key={idx}
            cx={p.x}
            cy={p.y}
            r={hoverIdx === idx ? 3.5 : 0}
            fill={color}
            stroke="#fff"
            strokeWidth={1.5}
            className="transition-all"
          />
        ))}
        {data.map((_, idx) => (
          <rect
            key={idx}
            x={getX(idx) - chartW / data.length / 2}
            y={0}
            width={chartW / data.length}
            height={height}
            fill="transparent"
            onMouseEnter={() => setHoverIdx(idx)}
          />
        ))}
      </svg>

      {hoverIdx !== null && (
        <div
          className="absolute -top-1 bg-slate-900/95 text-white text-[10px] px-2 py-1 rounded-md shadow-lg pointer-events-none whitespace-nowrap z-10"
          style={{ left: `${(getX(hoverIdx) / WIDTH) * 100}%`, transform: "translate(-50%, -100%)" }}
        >
          <span className="text-slate-300">{data[hoverIdx].label}: </span>
          <span className="font-bold">{fmt(data[hoverIdx].value)}</span>
        </div>
      )}
    </div>
  );
}
