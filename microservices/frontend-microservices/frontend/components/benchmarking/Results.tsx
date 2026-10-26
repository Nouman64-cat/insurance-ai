"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import {
  downloadExport, getBenchmark, getBreakdown, getHistory, listBenchmarks, modelColor, ms, pct, usd,
  type BenchmarkDetail, type BenchmarkListItem, type Breakdown, type HistoryPoint,
} from "@/lib/evalBenchmarks";
import { useQueryState } from "@/lib/useQueryState";
import { Legend, useHidden, type Series } from "./charts";
import BenchmarkCost from "./CostCard";
import ComparisonTable from "./ComparisonTable";
import JudgePanel from "./JudgePanel";
import TraceDrawer from "./TraceDrawer";
import VisualAnalytics, { VA_TABS, type VaTab } from "./VisualAnalytics";

const btnGhost = "px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 disabled:opacity-40 transition-all";
const chip = (on: boolean) => `px-2 py-1 rounded-md text-[11px] border ${on ? "bg-blue-50 border-blue-300 text-blue-700" : "bg-white border-slate-200 text-slate-600"}`;
const STATUSES = ["passed", "failed", "blocked", "skipped", "infrastructure_error"];

export default function Results({ initialId, onOpened }: { initialId: string | null; onOpened?: (id: string) => void }) {
  const [list, setList] = useState<BenchmarkListItem[]>([]);
  const [id, setId] = useState<string | null>(initialId);
  const [bench, setBench] = useState<BenchmarkDetail | null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [fModels, setFModels] = useState<string[]>([]);
  const [fStages, setFStages] = useState<string[]>([]);
  const [fStatus, setFStatus] = useState<string[]>([]);
  const [fCase, setFCase] = useState("");
  const [trace, setTrace] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const { hidden, toggle } = useHidden();
  // The page opens on the charts; the comparison table is one click away. Both choices live in the address, so a link opens the same view.
  const [vw, setVw] = useQueryState("vw");
  const view: "visual" | "table" = vw === "table" ? "table" : "visual";
  const [vaParam, setVa] = useQueryState("va", "perf");
  const tab = (VA_TABS.some((t) => t.id === vaParam) ? vaParam : "perf") as VaTab;

  useEffect(() => {
    listBenchmarks().then((l) => { setList(l); setId((cur) => cur ?? l[0]?.benchmark_id ?? null); }).catch((e) => setError(e instanceof Error ? e.message : "Could not list benchmarks."));
    getHistory().then(setHistory).catch(() => undefined);
  }, [initialId]);
  useEffect(() => { if (initialId) setId(initialId); }, [initialId]);

  useEffect(() => {
    if (!id) return;
    setBench(null); setBreakdown(null); setError(null);
    setFModels([]); setFStages([]); setFStatus([]); setFCase("");
    getBenchmark(id).then(setBench).catch((e) => setError(e instanceof Error ? e.message : "Could not load the benchmark."));
    onOpened?.(id);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadBreakdown = useCallback(() => {
    if (!id) return;
    getBreakdown(id, { model: fModels, stage: fStages, status: fStatus, case: fCase.trim() || undefined }).then(setBreakdown).catch((e) => setError(e instanceof Error ? e.message : "Could not load the breakdown."));
  }, [id, fModels, fStages, fStatus, fCase]);
  useEffect(() => {
    const t = setTimeout(loadBreakdown, fCase ? 300 : 0);
    return () => clearTimeout(t);
  }, [loadBreakdown, fCase]);

  const labels = useMemo(() => Object.keys(bench?.summary.models ?? {}), [bench]);
  const series: Series[] = useMemo(() => labels.map((l) => ({ key: l, label: l, color: modelColor(l, labels) })), [labels]);
  const shown = useMemo(() => labels.filter((l) => !hidden.has(l)), [labels, hidden]);
  const models = bench?.summary.models ?? {};


  async function doExport(format: "csv" | "json") {
    if (!id) return;
    setExporting(true);
    try { await downloadExport("benchmark", id, format); } catch (e) { setError(e instanceof Error ? e.message : "Export failed."); } finally { setExporting(false); }
  }

  const toggleIn = (set: string[], setter: (v: string[]) => void, v: string) => setter(set.includes(v) ? set.filter((x) => x !== v) : [...set, v]);

  const filtersOn = fModels.length > 0 || fStages.length > 0 || fStatus.length > 0 || !!fCase;

  return (
    <div className="w-full min-w-0 space-y-6" data-testid="benchmark-results">
      {error && <div className="text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600" role="alert">{error}</div>}

      {/* the one toolbar: which benchmark, the charts, the exports */}
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <label htmlFor="bm-pick" className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{tx("Benchmark")}</label>
        <select id="bm-pick" className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white w-full sm:w-auto sm:max-w-[min(100%,48rem)] truncate" value={id ?? ""} onChange={(e) => setId(e.target.value || null)}>
          {list.length === 0 && <option value="">{tx("No benchmarks yet")}</option>}
          {list.map((b) => (
            <option key={b.benchmark_id} value={b.benchmark_id}>
              {new Date(b.created_at).toLocaleString()} · {b.mode} · {b.models.map((m) => m.label.split("/")[1]).join(" vs ")} ×{b.repetitions}{b.synthetic ? " · scripted" : ""}
            </option>
          ))}
        </select>
        {id && bench && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5" role="group" aria-label={tx("View")} data-testid="view-switch">
              {([["visual", "Visual analytics"], ["table", "Comparison table"]] as const).map(([v, label]) => (
                <button key={v} type="button" aria-pressed={view === v} data-testid={`view-${v}`} onClick={() => setVw(v === "visual" ? "" : "table")}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${view === v ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}>{tx(label)}</button>
              ))}
            </div>
            <button type="button" className={btnGhost} disabled={exporting} onClick={() => doExport("csv")}>{tx("Export CSV")}</button>
            <button type="button" className={btnGhost} disabled={exporting} onClick={() => doExport("json")}>{tx("Export JSON")}</button>
          </div>
        )}
      </div>

      {!id && <p className="py-16 text-center text-sm text-slate-400">{tx("No benchmark has been run yet. Start one on the New benchmark tab.")}</p>}
      {id && !bench && !error && <p className="py-16 text-center text-xs text-slate-400">{tx("Loading…")}</p>}

      {bench && (
        <>
          {/* what was run, and anything the reader must know before trusting it */}
          <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 space-y-2" aria-label={tx("About this benchmark")}>
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
              {[
                [tx("Dataset"), `${bench.dataset} ${bench.dataset_version}`],
                [tx("Mode"), bench.mode === "direct" ? tx("direct (bare model)") : tx("agent (real agent with tools)")],
                [tx("Repetitions"), `×${bench.repetitions}`],
                [tx("Judge"), `${bench.judge_model ?? tx("none")}${bench.summary.judge?.calibration ? ` (${tx("calibration")}: ${bench.summary.judge.calibration.status.replace("_", " ")}${bench.summary.judge.calibration.agreement !== null ? ` ${pct(bench.summary.judge.calibration.agreement)}` : ""})` : ""}`],
                [tx("Run"), new Date(bench.created_at).toLocaleString()],
              ].map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-[10px] uppercase tracking-wide text-slate-400">{k}</dt><dd className="font-semibold text-slate-800 break-words">{v}</dd></div>)}
            </dl>
            {bench.synthetic && <div className="rounded-lg px-3 py-2 border bg-amber-50 border-amber-200 text-xs text-amber-800" role="note">{tx("SYNTHETIC: at least one model is a scripted stand-in. This checks the machinery; it does not rank models.")}</div>}
            {!bench.summary.valid && <div className="rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-xs text-red-600" role="alert">{tx("INVALID BENCHMARK")}: {bench.summary.problems.join("; ")}</div>}
            {bench.summary.leader && <div className="rounded-lg px-3 py-2 border bg-emerald-50 border-emerald-200 text-xs font-semibold text-emerald-800">{bench.summary.leader} {tx("is shown to be better than every other model on this evidence.")}</div>}
            {bench.summary.notes.filter((n) => !n.startsWith("SYNTHETIC") && !n.startsWith("INVALID")).map((n) => <p key={n} className="text-[11px] text-slate-500">{n}</p>)}
          </section>

          {/* what the judge said: always visible, whichever view is open */}
          <JudgePanel bench={bench} labels={shown} allLabels={labels} />

          {/* the default view: the shape of the results as charts */}
          {view === "visual" && <VisualAnalytics tab={tab} onTab={(t) => setVa(t)} models={bench.summary.models} labels={labels} hidden={hidden} onToggle={toggle} breakdown={breakdown} history={history} onOpenTrace={setTrace} />}

          {/* the other view: every measure of every model, side by side */}
          {view === "table" && (
            <>
              {labels.length > 1 && <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500"><span className="font-semibold uppercase tracking-wide text-[10px] text-slate-400">{tx("Models shown")}</span><Legend series={series} hidden={hidden} onToggle={toggle} /></div>}
              <ComparisonTable models={bench.summary.models} labels={shown} allLabels={labels} benchmarkId={bench.benchmark_id} synthetic={bench.synthetic} />
            </>
          )}

          {bench.summary.comparisons.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4" aria-label={tx("Is one model really better?")}>
              <h3 className="text-sm font-bold text-slate-900">{tx("Is one model really better?")}</h3>
              <p className="text-[11px] text-slate-500">{tx("A higher accuracy is not enough: this says whether the difference is bigger than chance on this many executions.")}</p>
              <ul className="mt-2 text-xs text-slate-700 space-y-1">
                {bench.summary.comparisons.map((c) => <li key={`${c.a}|${c.b}`}><b>{c.a}</b> vs <b>{c.b}</b>: {c.verdict.replace(/_/g, " ")}{c.note ? ` — ${c.note}` : ""}</li>)}
              </ul>
            </section>
          )}

          {!bench.synthetic && (
            <details className="rounded-xl border border-slate-200 bg-white" data-testid="cost-details">
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-bold text-slate-900">{tx("Cost details")} <span className="text-[11px] font-normal text-slate-500">{tx("what this benchmark spent in total, by component, from the recorded cost lines")}</span></summary>
              <div className="px-4 pb-4"><BenchmarkCost benchmarkId={bench.benchmark_id} /></div>
            </details>
          )}

          {/* the cases behind the numbers */}
          <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3" aria-label={tx("Test cases by model")}>
            <div>
              <h3 className="text-sm font-bold text-slate-900">{tx("Test cases by model")} {breakdown && <span className="font-normal text-slate-400">({breakdown.cases.length})</span>}</h3>
              <p className="text-[11px] text-slate-500">{tx("Each cell is passes out of runs. Click a repetition to read the model's answer, the checks, the judge's reasons and the trace.")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px]" role="group" aria-label={tx("Filters")}>
              <div><span className="text-slate-400 mr-1">{tx("model")}</span>{(breakdown?.facets.model ?? labels).map((m) => <button key={m} type="button" aria-pressed={fModels.includes(m)} className={`${chip(fModels.includes(m))} mr-1`} onClick={() => toggleIn(fModels, setFModels, m)}>{m}</button>)}</div>
              <div><span className="text-slate-400 mr-1">{tx("workflow stage")}</span>{(breakdown?.facets.stage ?? []).map((m) => <button key={m} type="button" aria-pressed={fStages.includes(m)} className={`${chip(fStages.includes(m))} mr-1 mb-1`} onClick={() => toggleIn(fStages, setFStages, m)}>{m}</button>)}</div>
              <div><span className="text-slate-400 mr-1">{tx("status")}</span>{STATUSES.filter((s) => (breakdown?.facets.status ?? STATUSES).includes(s)).map((m) => <button key={m} type="button" aria-pressed={fStatus.includes(m)} className={`${chip(fStatus.includes(m))} mr-1`} onClick={() => toggleIn(fStatus, setFStatus, m)}>{m.replace("_", " ")}</button>)}</div>
              <div><label className="text-slate-400 mr-1" htmlFor="bm-case">{tx("test case")}</label><input id="bm-case" value={fCase} onChange={(e) => setFCase(e.target.value)} placeholder="IND-LEAD" className="border border-slate-200 rounded-md px-2 py-1 text-[11px]" /></div>
              {filtersOn && <button type="button" className="text-blue-600 underline" onClick={() => { setFModels([]); setFStages([]); setFStatus([]); setFCase(""); }}>{tx("clear filters")}</button>}
            </div>
            {!breakdown ? <p className="py-6 text-center text-xs text-slate-400">{tx("Loading…")}</p> : breakdown.cases.length === 0 ? <p className="py-8 text-center text-xs text-slate-400">{tx("No execution matches these filters.")}</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]" data-testid="case-grid">
                  <thead><tr className="text-left text-slate-400"><th className="py-1 pr-3 font-semibold">{tx("Case")}</th><th className="pr-3 font-semibold">{tx("Stage")}</th>{breakdown.models.filter((m) => !hidden.has(m)).map((m) => <th key={m} className="pr-3 font-semibold">{m.split("/")[1]}</th>)}</tr></thead>
                  <tbody>
                    {breakdown.cases.map((c) => (
                      <tr key={c.case} className="border-t border-slate-100">
                        <td className="py-1.5 pr-3 font-semibold text-slate-800 whitespace-nowrap">{c.case}</td>
                        <td className="pr-3 text-slate-500 whitespace-nowrap">{c.stage}</td>
                        {breakdown.models.filter((m) => !hidden.has(m)).map((m) => {
                          const cell = c.models[m];
                          if (!cell) return <td key={m} className="pr-3 text-slate-300">—</td>;
                          const ran = cell.passed + cell.failed;
                          const tone = cell.critical ? "bg-red-100 text-red-700 border-red-200" : ran === 0 ? "bg-slate-100 text-slate-500 border-slate-200" : cell.failed === 0 ? "bg-emerald-50 text-emerald-700 border-emerald-200" : cell.passed === 0 ? "bg-red-50 text-red-600 border-red-200" : "bg-amber-50 text-amber-700 border-amber-200";
                          return (
                            <td key={m} className="pr-3 py-1">
                              <button type="button" disabled={cell.result_ids.length === 0} onClick={() => setTrace(cell.result_ids[0])} aria-label={`${c.case} ${m}: open the first run`}
                                className={`inline-block px-1.5 py-0.5 rounded border font-semibold cursor-pointer hover:ring-2 hover:ring-blue-200 ${tone}`} title={`p50 ${ms(cell.p50_ms)} · ${usd(cell.cost_known ? cell.cost_usd : null)}${cell.critical ? " · critical" : ""} · ${tx("click to open the trace")}`}>{ran === 0 ? "n/a" : `${cell.passed}/${ran}`}</button>
                              <span className="ml-1">{cell.result_ids.map((rid, i) => <button key={rid} type="button" onClick={() => setTrace(rid)} className="text-blue-700 underline underline-offset-2 cursor-pointer px-1 py-0.5 rounded hover:bg-blue-50 mr-0.5" aria-label={`${c.case} ${m} r${i + 1}`}>r{i + 1}</button>)}</span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {trace && <TraceDrawer resultId={trace} onClose={() => setTrace(null)} />}
    </div>
  );
}
