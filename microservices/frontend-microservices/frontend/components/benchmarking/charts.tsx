"use client";

import { useMemo, useState, type ReactNode } from "react";

// Small SVG charts for the LLM Benchmarking page (the portal has no chart library). Each takes plain numbers, draws the axes itself,
// shows a tooltip on hover, and lets the reader switch a model off by clicking it in the legend. A value that is null is "not measured":
// it is drawn as a gap with a dash, never as zero.

export interface Series { key: string; label: string; color: string }

const AXIS = "#94a3b8";
const GRID = "#e2e8f0";
const TEXT = "#475569";

export function Legend({ series, hidden, onToggle }: { series: Series[]; hidden: Set<string>; onToggle: (key: string) => void }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]" role="group" aria-label="Models shown">
      {series.map((s) => {
        const off = hidden.has(s.key);
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onToggle(s.key)}
            aria-pressed={!off}
            title={off ? "Show this model" : "Hide this model"}
            className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 border ${off ? "border-slate-200 text-slate-400" : "border-slate-200 text-slate-700 bg-white"}`}
          >
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: off ? "#cbd5e1" : s.color }} />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

export function useHidden() {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setHidden((h) => {
      const n = new Set(h);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  return { hidden, toggle };
}

function Frame({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 min-w-0 max-w-full">
      <h3 className="text-sm font-bold text-slate-900">{title}</h3>
      {subtitle && <p className="text-[11px] text-slate-500 mt-0.5">{subtitle}</p>}
      <div className="mt-3">{children}</div>
      {footer && <div className="mt-2">{footer}</div>}
    </section>
  );
}

// ── Grouped bars: one group per category (a workflow stage, a metric), one bar per model ───────────────────────────────

export function GroupedBars({
  title, subtitle, groups, series, value, format, max, hidden, height = 220, footer,
}: {
  title: string; subtitle?: string; groups: { key: string; label: string }[]; series: Series[]; value: (group: string, series: string) => number | null | undefined;
  format: (v: number) => string; max?: number; hidden: Set<string>; height?: number; footer?: ReactNode;
}) {
  const [tip, setTip] = useState<string | null>(null);
  const shown = series.filter((s) => !hidden.has(s.key));
  const top = useMemo(() => {
    if (max !== undefined) return max;
    const all = groups.flatMap((g) => shown.map((s) => value(g.key, s.key) ?? 0));
    const m = Math.max(0, ...all);
    return m === 0 ? 1 : m * 1.1;
  }, [groups, shown, value, max]);
  const rotate = groups.length > 6;
  const left = 44, bottom = rotate ? 84 : 46, w = Math.max(360, groups.length * (shown.length * 16 + 22) + left + 8), h = rotate ? height + 40 : height;
  const plotH = h - bottom - 8;
  const slot = (w - left - 8) / Math.max(groups.length, 1);
  const bar = Math.min(26, (slot - 10) / Math.max(shown.length, 1));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <Frame title={title} subtitle={subtitle} footer={footer}>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title} className="block" style={{ width: "100%", minWidth: Math.round(w * 0.8), maxWidth: Math.round(w * 1.6) }}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={w - 8} y1={8 + plotH * (1 - t)} y2={8 + plotH * (1 - t)} stroke={GRID} />
              <text x={left - 6} y={12 + plotH * (1 - t)} textAnchor="end" fontSize="9" fill={TEXT}>{format(top * t)}</text>
            </g>
          ))}
          <line x1={left} x2={left} y1={8} y2={8 + plotH} stroke={AXIS} />
          {groups.map((g, gi) => {
            const x0 = left + gi * slot + (slot - bar * shown.length) / 2;
            return (
              <g key={g.key}>
                {shown.map((s, si) => {
                  const v = value(g.key, s.key);
                  const x = x0 + si * bar;
                  const id = `${g.key}|${s.key}`;
                  if (v === null || v === undefined) {
                    return <text key={s.key} x={x + bar / 2} y={8 + plotH - 3} textAnchor="middle" fontSize="9" fill={AXIS}>–</text>;
                  }
                  const bh = Math.max(1, (Math.min(v, top) / top) * plotH);
                  return (
                    <rect
                      key={s.key} x={x} y={8 + plotH - bh} width={bar - 2} height={bh} rx="2" fill={s.color} opacity={tip && tip !== id ? 0.45 : 1}
                      onMouseEnter={() => setTip(id)} onMouseLeave={() => setTip(null)}
                    >
                      <title>{`${s.label} · ${g.label}: ${format(v)}`}</title>
                    </rect>
                  );
                })}
                <text x={left + gi * slot + slot / 2} y={h - bottom + 14} textAnchor={rotate ? "end" : "middle"} fontSize="9" fill={TEXT}
                  transform={rotate ? `rotate(-35 ${left + gi * slot + slot / 2} ${h - bottom + 14})` : undefined}>
                  {g.label.length > 22 ? `${g.label.slice(0, 21)}…` : g.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {tip && (() => {
        const [gk, sk] = tip.split("|");
        const g = groups.find((x) => x.key === gk), s = series.find((x) => x.key === sk);
        const v = g && s ? value(g.key, s.key) : null;
        return g && s && v !== null && v !== undefined ? <p className="mt-1 text-[11px] text-slate-600">{s.label} · {g.label}: <b>{format(v)}</b></p> : null;
      })()}
    </Frame>
  );
}

// ── Interval plot: a value with its range, one row per model (pass rate with its 95% interval) ────────────────────────

export interface IntervalRow { key: string; label: string; color: string; value: number | null; low: number | null; high: number | null; note?: string }

export function IntervalPlot({ title, subtitle, rows, hidden, footer }: { title: string; subtitle?: string; rows: IntervalRow[]; hidden: Set<string>; footer?: ReactNode }) {
  const shown = rows.filter((r) => !hidden.has(r.key));
  const left = 150, w = 520, rowH = 30, h = shown.length * rowH + 30;
  const x = (v: number) => left + v * (w - left - 20);
  return (
    <Frame title={title} subtitle={subtitle} footer={footer}>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title} className="block" style={{ width: "100%", minWidth: Math.round(w * 0.8), maxWidth: Math.round(w * 1.6) }}>
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={4} y2={h - 22} stroke={GRID} />
              <text x={x(t)} y={h - 8} textAnchor="middle" fontSize="9" fill={TEXT}>{Math.round(t * 100)}%</text>
            </g>
          ))}
          {shown.map((r, i) => {
            const y = 18 + i * rowH;
            return (
              <g key={r.key}>
                <text x={left - 8} y={y + 3} textAnchor="end" fontSize="10" fill={TEXT}>{r.label.length > 24 ? `${r.label.slice(0, 23)}…` : r.label}</text>
                {r.value === null ? (
                  <text x={x(0)} y={y + 3} fontSize="10" fill={AXIS}>{r.note ?? "not measured"}</text>
                ) : (
                  <>
                    {r.low !== null && r.high !== null && <line x1={x(r.low)} x2={x(r.high)} y1={y} y2={y} stroke={r.color} strokeWidth="3" opacity="0.35" strokeLinecap="round" />}
                    <circle cx={x(r.value)} cy={y} r="5" fill={r.color}>
                      <title>{`${r.label}: ${(r.value * 100).toFixed(1)}%${r.low !== null && r.high !== null ? ` (95% interval ${(r.low * 100).toFixed(0)}–${(r.high * 100).toFixed(0)}%)` : ""}`}</title>
                    </circle>
                    <text x={x(r.value) + 9} y={y + 3} fontSize="10" fill={TEXT}>{(r.value * 100).toFixed(1)}%</text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </Frame>
  );
}

// ── Trend: a value over time, one line per model ──────────────────────────────────────────────────────────────────────

export interface TrendPoint { at: string; series: string; value: number; label?: string }

export function Trend({ title, subtitle, points, series, hidden, format, max, footer }: {
  title: string; subtitle?: string; points: TrendPoint[]; series: Series[]; hidden: Set<string>; format: (v: number) => string; max?: number; footer?: ReactNode;
}) {
  const [tip, setTip] = useState<TrendPoint | null>(null);
  const shown = points.filter((p) => !hidden.has(p.series));
  const times = shown.map((p) => new Date(p.at).getTime());
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const top = max ?? (Math.max(0, ...shown.map((p) => p.value)) * 1.1 || 1);
  const left = 48, w = 560, h = 210, bottom = 30;
  const plotH = h - bottom - 8;
  const x = (t: number) => (t1 === t0 ? left + (w - left - 16) / 2 : left + ((t - t0) / (t1 - t0)) * (w - left - 16));
  const y = (v: number) => 8 + plotH * (1 - Math.min(v, top) / top);
  if (shown.length === 0) return <Frame title={title} subtitle={subtitle}><p className="text-xs text-slate-400 py-6 text-center">No measured results to draw yet.</p></Frame>;
  return (
    <Frame title={title} subtitle={subtitle} footer={footer}>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title} className="block" style={{ width: "100%", minWidth: Math.round(w * 0.8), maxWidth: Math.round(w * 1.6) }}>
          {[0, 0.5, 1].map((t) => (
            <g key={t}>
              <line x1={left} x2={w - 8} y1={y(top * t)} y2={y(top * t)} stroke={GRID} />
              <text x={left - 6} y={y(top * t) + 3} textAnchor="end" fontSize="9" fill={TEXT}>{format(top * t)}</text>
            </g>
          ))}
          {series.filter((s) => !hidden.has(s.key)).map((s) => {
            const mine = shown.filter((p) => p.series === s.key).sort((a, b) => +new Date(a.at) - +new Date(b.at));
            return (
              <g key={s.key}>
                {mine.length > 1 && <polyline fill="none" stroke={s.color} strokeWidth="2" points={mine.map((p) => `${x(+new Date(p.at))},${y(p.value)}`).join(" ")} />}
                {mine.map((p, i) => (
                  <circle key={i} cx={x(+new Date(p.at))} cy={y(p.value)} r="4" fill={s.color} onMouseEnter={() => setTip(p)} onMouseLeave={() => setTip(null)}>
                    <title>{`${s.label} · ${new Date(p.at).toLocaleString()}: ${format(p.value)}`}</title>
                  </circle>
                ))}
              </g>
            );
          })}
          <text x={left} y={h - 8} fontSize="9" fill={TEXT}>{new Date(t0).toLocaleDateString()}</text>
          <text x={w - 8} y={h - 8} fontSize="9" fill={TEXT} textAnchor="end">{new Date(t1).toLocaleDateString()}</text>
        </svg>
      </div>
      {tip && <p className="mt-1 text-[11px] text-slate-600">{series.find((s) => s.key === tip.series)?.label} · {new Date(tip.at).toLocaleString()}: <b>{format(tip.value)}</b>{tip.label ? ` · ${tip.label}` : ""}</p>}
    </Frame>
  );
}
