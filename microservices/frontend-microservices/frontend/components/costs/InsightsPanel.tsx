"use client";

import { useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { getAnomalies, getRecommendations, type Anomalies, type Recommendations } from "@/lib/evalCosts";
import { useQueryState } from "@/lib/useQueryState";
import { Advice } from "./ModelsPanel";
import { Badge, Notice, SEVERITY_TONE, card, day } from "./ui";

type Fmt = (usd: number | null | undefined) => string;
const KIND_LABEL: Record<string, string> = { run_cost: "A run cost far more than usual", daily_spike: "A day cost far more than usual", token_outlier: "An execution used far more tokens", waste: "Calls that bought no verdict", unpriced: "Usage that could not be priced" };

export function InsightsView({ anomalies, advice, fmt }: { anomalies: Anomalies; advice: Recommendations; fmt: Fmt }) {
  return (
    <div className="space-y-4" data-testid="insights-view">
      <section className={card}>
        <h2 className="text-sm font-bold text-slate-900">{tx("Unusual spending")}</h2>
        <p className="text-[11px] text-slate-500">{day(anomalies.window.from)} – {day(anomalies.window.to)} · {tx("checked")} {anomalies.checked.runs} {tx("runs")}, {anomalies.checked.days} {tx("days")}, {anomalies.checked.executions} {tx("executions")}</p>
        {anomalies.anomalies.length === 0 ? <p className="mt-3 text-xs text-slate-500" data-testid="no-anomalies">{tx("Nothing unusual was found. Each rule compares with EARLIER data only, so a quiet result with little history means little, not everything is fine.")}</p> : (
          <ul className="mt-3 space-y-2" data-testid="anomaly-list">
            {anomalies.anomalies.map((a, i) => (
              <li key={`${a.kind}-${i}`} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2"><Badge tone={SEVERITY_TONE[a.severity]}>{a.severity}</Badge><span className="text-xs font-semibold text-slate-800">{tx(KIND_LABEL[a.kind] ?? a.kind)}</span><span className="text-[10px] text-slate-400">{day(a.at)}</span></div>
                <p className="text-[11px] text-slate-600 mt-1">{a.message}</p>
                {a.excess_usd ? <p className="text-[10px] text-slate-400 mt-0.5">{tx("About")} {fmt(a.excess_usd)} {tx("more than usual")}</p> : null}
              </li>
            ))}
          </ul>
        )}
        <details className="mt-3 text-[11px] text-slate-500"><summary className="cursor-pointer font-semibold">{tx("How each finding is decided")}</summary>
          <ul className="mt-1 list-disc pl-4 space-y-0.5">{Object.entries(anomalies.rules).map(([k, v]) => <li key={k}><b>{tx(KIND_LABEL[k] ?? k)}</b>: {v}</li>)}</ul></details>
      </section>
      <section className={card}>
        <h2 className="text-sm font-bold text-slate-900 mb-2">{tx("Advice")}</h2>
        <Advice items={advice.recommendations} fmt={fmt} />
        <p className="text-[10px] text-slate-400 mt-3">{advice.principle}</p>
      </section>
    </div>
  );
}

export default function InsightsPanel({ fmt, refreshKey }: { fmt: Fmt; refreshKey: number }) {
  const [days, setDays] = useQueryState("days", "90", { replace: true });
  const [a, setA] = useState<Anomalies | null>(null);
  const [r, setR] = useState<Recommendations | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const n = Number(days) || 90, to = new Date(), from = new Date(Date.now() - n * 86400000);
    const f = from.toISOString().slice(0, 10), t = to.toISOString().slice(0, 10);
    setA(null);
    Promise.all([getAnomalies(f, t), getRecommendations(f, t)]).then(([x, y]) => { setA(x); setR(y); setError(null); }).catch((e) => setError(e instanceof Error ? e.message : "Could not load the findings."));
  }, [days, refreshKey]);
  return (
    <div className="space-y-3">
      <label className="text-xs text-slate-600">{tx("Window")}{" "}
        <select className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-white" value={days} onChange={(e) => setDays(e.target.value)} aria-label={tx("window")}>
          {[["30", "last 30 days"], ["90", "last 90 days"], ["365", "last year"]].map(([v, l]) => <option key={v} value={v}>{tx(l)}</option>)}
        </select>
      </label>
      {error && <Notice>{error}</Notice>}
      {!a || !r ? (error ? null : <p className="py-16 text-center text-xs text-slate-400">{tx("Loading…")}</p>) : <InsightsView anomalies={a} advice={r} fmt={fmt} />}
    </div>
  );
}
