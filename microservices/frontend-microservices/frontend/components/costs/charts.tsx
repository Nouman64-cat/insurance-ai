"use client";

import { useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { COMPONENT_COLOR, COMPONENT_LABEL, type ModelGroup } from "@/lib/evalCosts";

// Two small SVG charts for the Evaluation Costs page (the portal has no chart library). Both draw their own axes, say what a gap means, and never draw an unknown as zero.

const AXIS = "#94a3b8", GRID = "#e2e8f0", TEXT = "#475569";

export interface BarPoint { start: string; total: number; by_group: Record<string, number> }

/** Money per day, stacked by what it paid for. */
export function StackedBars({ title, points, groups, format, height = 200 }: { title: string; points: BarPoint[]; groups: string[]; format: (v: number) => string; height?: number }) {
  const [tip, setTip] = useState<string | null>(null);
  const top = Math.max(0, ...points.map((p) => p.total));
  if (points.length === 0 || top === 0) return <p className="text-xs text-slate-400 py-8 text-center" data-testid="chart-empty">{tx("No spending was recorded in this window.")}</p>;
  const left = 54, bottom = 26, w = Math.max(420, points.length * 16 + left + 10), plotH = height - bottom - 8;
  const slot = (w - left - 8) / points.length, bar = Math.max(3, Math.min(22, slot - 3));
  const scale = top * 1.08;
  const order = [...groups].sort((a, b) => (a === "judge" ? 1 : 0) - (b === "judge" ? 1 : 0));
  return (
    <div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${w} ${height}`} role="img" aria-label={title} className="block" style={{ width: "100%", minWidth: Math.min(w, 520) }}>
          {[0, 0.5, 1].map((t) => (
            <g key={t}>
              <line x1={left} x2={w - 8} y1={8 + plotH * (1 - t)} y2={8 + plotH * (1 - t)} stroke={GRID} />
              <text x={left - 6} y={12 + plotH * (1 - t)} textAnchor="end" fontSize="9" fill={TEXT}>{format(scale * t)}</text>
            </g>
          ))}
          <line x1={left} x2={left} y1={8} y2={8 + plotH} stroke={AXIS} />
          {points.map((p, i) => {
            let y = 8 + plotH;
            const x = left + i * slot + (slot - bar) / 2;
            return (
              <g key={p.start} onMouseEnter={() => setTip(p.start)} onMouseLeave={() => setTip(null)}>
                {order.map((g) => {
                  const v = p.by_group[g] ?? 0;
                  if (v <= 0) return null;
                  const h = Math.max(1, (v / scale) * plotH);
                  y -= h;
                  return <rect key={g} x={x} y={y} width={bar} height={h} fill={COMPONENT_COLOR[g] ?? "#64748b"} opacity={tip && tip !== p.start ? 0.5 : 1}><title>{`${p.start} · ${tx(COMPONENT_LABEL[g] ?? g)}: ${format(v)}`}</title></rect>;
                })}
                {(i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 6) === 0) && <text x={x + bar / 2} y={height - 8} textAnchor="middle" fontSize="9" fill={TEXT}>{p.start.slice(5)}</text>}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {groups.map((g) => <span key={g} className="inline-flex items-center gap-1.5 text-slate-600"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COMPONENT_COLOR[g] ?? "#64748b" }} />{tx(COMPONENT_LABEL[g] ?? g)}</span>)}
      </div>
      {tip && (() => { const p = points.find((x) => x.start === tip); return p ? <p className="mt-1 text-[11px] text-slate-600">{p.start}: <b>{format(p.total)}</b></p> : null; })()}
    </div>
  );
}

/** Quality against cost: each configuration is a dot at its cost per passed test (left is cheaper) and its pass rate (up is better), with its 95% interval as a bar. Dots on the
 *  frontier (nothing is both better and cheaper) are blue; the rest are grey. A configuration whose cost is unknown cannot be placed and is listed under the chart. */
export function QualityCostScatter({ models, format }: { models: ModelGroup[]; format: (v: number) => string }) {
  const placed = models.filter((m) => m.pass_rate !== null && m.per_passed_usd !== null);
  const unplaced = models.filter((m) => !placed.includes(m));
  if (placed.length === 0) return <p className="text-xs text-slate-400 py-6 text-center" data-testid="scatter-empty">{tx("No configuration has both a pass rate and a known cost per passed test yet.")}</p>;
  const left = 52, bottom = 34, w = 560, h = 240, plotW = w - left - 24, plotH = h - bottom - 12;
  const maxX = Math.max(...placed.map((m) => m.per_passed_usd as number)) * 1.2 || 1;
  const x = (v: number) => left + (v / maxX) * plotW, y = (v: number) => 10 + plotH * (1 - v);
  return (
    <div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={tx("Pass rate against cost per passed test")} className="block" style={{ width: "100%", minWidth: 420 }}>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line x1={left} x2={w - 24} y1={y(t)} y2={y(t)} stroke={GRID} />
              <text x={left - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fill={TEXT}>{Math.round(t * 100)}%</text>
            </g>
          ))}
          {[0, 0.5, 1].map((t) => <text key={t} x={x(maxX * t)} y={h - 16} textAnchor="middle" fontSize="9" fill={TEXT}>{format(maxX * t)}</text>)}
          <text x={left + plotW / 2} y={h - 3} textAnchor="middle" fontSize="9" fill={AXIS}>{tx("cost per passed test (all-in)")} →</text>
          {placed.map((m) => {
            const color = m.on_frontier ? "#2563eb" : "#94a3b8";
            const cx = x(m.per_passed_usd as number), cy = y(m.pass_rate as number);
            return (
              <g key={m.label}>
                {m.ci_low !== null && m.ci_high !== null && <line x1={cx} x2={cx} y1={y(m.ci_low)} y2={y(m.ci_high)} stroke={color} strokeWidth="3" opacity="0.35" strokeLinecap="round" />}
                <circle cx={cx} cy={cy} r="6" fill={color} data-frontier={m.on_frontier ? "true" : "false"}>
                  <title>{`${m.label}: ${((m.pass_rate as number) * 100).toFixed(1)}% passed at ${format(m.per_passed_usd as number)} per passed test${m.on_frontier ? " (on the frontier)" : ` (beaten by ${m.dominated_by.join(", ")})`}`}</title>
                </circle>
                <text x={Math.min(cx + 9, w - 90)} y={cy - 8} fontSize="10" fill={TEXT}>{m.label.length > 26 ? `${m.label.slice(0, 25)}…` : m.label}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="text-[11px] text-slate-500 mt-1">{tx("Up is better, left is cheaper. Blue dots are on the frontier: nothing else is both better and cheaper. The bar is the 95% interval of the pass rate.")}</p>
      {unplaced.length > 0 && <p className="text-[11px] text-slate-400 mt-1">{tx("Not drawn (cost or pass rate unknown)")}: {unplaced.map((m) => m.label).join(", ")}</p>}
    </div>
  );
}
