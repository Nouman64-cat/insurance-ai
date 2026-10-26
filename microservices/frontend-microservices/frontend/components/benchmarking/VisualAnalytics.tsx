"use client";

import { tx } from "@/lib/i18n/tx";
import { modelColor, ms, pct, tokens, usd, type Breakdown, type HistoryPoint, type ModelResult } from "@/lib/evalBenchmarks";
import CaseHeatmap from "@/components/studio/CaseHeatmap";
import { GroupedBars, IntervalPlot, Legend, Trend, type Series } from "./charts";

export const VA_TABS = [
  { id: "perf", label: "Performance and cost", hint: "Accuracy with its interval, latency, tokens and cost" },
  { id: "quality", label: "Quality and reliability", hint: "Judged scores, repeat consistency and accuracy by workflow stage" },
  { id: "cases", label: "Case heatmap", hint: "Which cases each model passes, weakest first" },
  { id: "history", label: "History", hint: "How each model did across every benchmark" },
] as const;
export type VaTab = (typeof VA_TABS)[number]["id"];
const NOT_RUN: Record<string, string> = { blocked_missing_credentials: "not run: no API key for this provider", no_results: "no execution produced a verdict", blocked: "blocked" };

/** Every chart of a benchmark: the default view of the results (the comparison table is the other). Four tabs; only the open one is drawn. */
export default function VisualAnalytics({ tab, onTab, onClose, models, labels, hidden, onToggle, breakdown, history, onOpenTrace }: {
  tab: VaTab; onTab: (t: VaTab) => void; onClose?: () => void; models: Record<string, ModelResult>; labels: string[]; hidden: Set<string>; onToggle: (key: string) => void;
  breakdown: Breakdown | null; history: HistoryPoint[]; onOpenTrace: (resultId: string) => void;
}) {
  const series: Series[] = labels.map((l) => ({ key: l, label: l, color: modelColor(l, labels) }));
  const measured = labels.filter((l) => models[l].status === "measured");
  const val = (l: string, f: (m: ModelResult) => number | null | undefined): number | null => (models[l]?.status === "measured" ? f(models[l]) ?? null : null);
  const histLabels = Array.from(new Set(history.map((p) => p.model)));
  const histSeries: Series[] = histLabels.map((l) => ({ key: l, label: l, color: modelColor(l, histLabels) }));
  return (
    <section id="visual-analytics" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900" aria-label={tx("Visual analytics")} data-testid="visual-analytics">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="mr-auto text-sm font-bold text-slate-900 dark:text-slate-50">{tx("Visual analytics")}</h3>
        <div className="flex flex-wrap gap-1" role="group" aria-label={tx("Charts")}>
          {VA_TABS.map((t) => <button key={t.id} type="button" aria-pressed={tab === t.id} title={tx(t.hint)} onClick={() => onTab(t.id)} data-va={t.id}
            className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${tab === t.id ? "border-blue-500 bg-blue-600 text-white" : "border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300"}`}>{tx(t.label)}</button>)}
        </div>
        {onClose && <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300">{tx("Close")}</button>}
      </div>
      {tab !== "history" && tab !== "cases" && <Legend series={series} hidden={hidden} onToggle={onToggle} />}

      {tab === "perf" && (
        <div className="grid min-w-0 gap-4 xl:grid-cols-2 [&>*]:min-w-0">
          <IntervalPlot title={tx("Accuracy with its 95% interval")} subtitle={tx("Wider ranges mean less evidence. Overlapping ranges do not show one model is better.")} hidden={hidden}
            rows={labels.map((l) => ({ key: l, label: l, color: modelColor(l, labels), value: val(l, (m) => m.pass_rate), low: val(l, (m) => m.ci_low), high: val(l, (m) => m.ci_high), note: NOT_RUN[models[l].status] ?? models[l].status }))} />
          <GroupedBars title={tx("Latency")} subtitle={tx("Median and 95th percentile per model.")} hidden={hidden} series={series}
            groups={[{ key: "p50", label: "p50" }, { key: "p95", label: "p95" }]} value={(g, s) => val(s, (m) => (g === "p50" ? m.latency_ms?.p50 : m.latency_ms?.p95))} format={(v) => ms(v)} />
          <GroupedBars title={tx("Token usage")} subtitle={tx("Total across the benchmark.")} hidden={hidden} series={series}
            groups={[{ key: "in", label: tx("input") }, { key: "out", label: tx("output") }]} value={(g, s) => val(s, (m) => (g === "in" ? m.tokens?.input : m.tokens?.output))} format={(v) => tokens(v)} />
          <GroupedBars title={tx("Cost")} subtitle={tx("What the model's own calls cost, what the judge cost, and the cost per passed case.")} hidden={hidden} series={series}
            groups={[{ key: "inf", label: tx("inference") }, { key: "judge", label: tx("judge") }, { key: "pp", label: tx("per pass") }]}
            value={(g, s) => val(s, (m) => (g === "inf" ? m.cost?.candidate_usd : g === "judge" ? m.cost?.judge_usd : m.cost?.per_passed_usd))} format={(v) => usd(v)} />
        </div>
      )}

      {tab === "quality" && (
        <div className="grid min-w-0 gap-4 xl:grid-cols-2 [&>*]:min-w-0">
          <GroupedBars title={tx("Quality scored by the judge")} subtitle={tx("Mean score per metric (0 to 1).")} hidden={hidden} series={series} max={1}
            groups={Array.from(new Set(measured.flatMap((l) => Object.keys(models[l].quality ?? {})))).map((k) => ({ key: k, label: k.replace("_", " ") }))}
            value={(g, s) => val(s, (m) => m.quality?.[g]?.mean)} format={(v) => v.toFixed(2)} />
          <GroupedBars title={tx("Reliability")} subtitle={tx("Same verdict on every repeat, and the share of runs with a critical failure.")} hidden={hidden} series={series} max={1}
            groups={[{ key: "cons", label: tx("consistency") }, { key: "crit", label: tx("critical failure rate") }]}
            value={(g, s) => val(s, (m) => (g === "cons" ? m.consistency : m.critical_failure_rate))} format={(v) => pct(v)} />
          {breakdown && breakdown.stages.length > 0 && (
            <div className="xl:col-span-2">
              <GroupedBars title={tx("Accuracy by workflow stage")} subtitle={tx("Pass rate of the executions that ran, per stage and model (the case filters apply).")} hidden={hidden} max={1}
                series={series.filter((s) => breakdown.models.includes(s.key))} groups={breakdown.stages.map((s) => ({ key: s.stage, label: s.stage }))}
                value={(g, s) => breakdown.stages.find((x) => x.stage === g)?.models[s]?.pass_rate} format={(v) => pct(v)} />
            </div>
          )}
        </div>
      )}

      {tab === "cases" && (breakdown ? <CaseHeatmap breakdown={breakdown} hidden={hidden} onOpen={onOpenTrace} /> : <p className="py-8 text-center text-xs text-slate-400">{tx("Loading…")}</p>)}

      {tab === "history" && (history.length === 0 ? <p className="py-8 text-center text-xs text-slate-400">{tx("No earlier benchmarks to compare with yet.")}</p> : (
        <div className="grid min-w-0 gap-4 xl:grid-cols-2 [&>*]:min-w-0">
          <Trend title={tx("History: accuracy per benchmark")} subtitle={tx("Every benchmark each model took part in. Scripted models are included only if you have run them.")} series={histSeries} hidden={hidden} max={1} format={(v) => pct(v)}
            points={history.filter((p) => p.status === "measured" && p.pass_rate !== undefined).map((p) => ({ at: p.at, series: p.model, value: p.pass_rate as number, label: p.benchmark_id }))} />
          <Trend title={tx("History: total cost per benchmark")} series={histSeries} hidden={hidden} format={(v) => usd(v)}
            points={history.filter((p) => p.status === "measured" && typeof p.total_usd === "number").map((p) => ({ at: p.at, series: p.model, value: p.total_usd as number, label: p.benchmark_id }))} />
        </div>
      ))}
    </section>
  );
}
