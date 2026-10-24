"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import {
  PROVIDER_NAME, downloadExport, getBenchmark, getBreakdown, getHistory, listBenchmarks, modelColor, ms, pct, providerOf, tokens, usd,
  type BenchmarkDetail, type BenchmarkListItem, type Breakdown, type HistoryPoint, type ModelResult,
} from "@/lib/evalBenchmarks";
import { GroupedBars, IntervalPlot, Legend, Trend, useHidden, type Series } from "./charts";
import TraceDrawer from "./TraceDrawer";

const btnGhost = "px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 disabled:opacity-40 transition-all";
const chip = (on: boolean) => `px-2 py-1 rounded-md text-[11px] border ${on ? "bg-blue-50 border-blue-300 text-blue-700" : "bg-white border-slate-200 text-slate-600"}`;
const STATUSES = ["passed", "failed", "blocked", "skipped", "infrastructure_error"];
const NOT_RUN: Record<string, string> = {
  blocked_missing_credentials: "not run: no API key for this provider", no_results: "no execution produced a verdict", blocked: "blocked",
};

function Card({ r, color, rank }: { r: ModelResult; color: string; rank: number | null }) {
  const measured = r.status === "measured";
  const lat = r.latency_ms;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 min-w-0" aria-label={r.label}>
      <div className="flex items-center gap-2">
        <span className="h-3 w-3 rounded-sm" style={{ background: color }} />
        <h3 className="text-sm font-bold text-slate-900">{r.label}</h3>
        {rank !== null && <span className="ml-auto text-[10px] font-semibold text-slate-400">{tx("observed rank")} {rank}</span>}
      </div>
      <p className="text-[10px] text-slate-400">{PROVIDER_NAME[providerOf(r.label)] ?? providerOf(r.label)}{r.synthetic ? ` · ${tx("scripted")}` : ""}</p>
      {!measured ? (
        <p className="mt-3 text-xs rounded-lg px-3 py-2 border bg-amber-50 border-amber-200 text-amber-700">{tx(NOT_RUN[r.status] ?? r.status)}{r.note ? ` — ${r.note}` : ""}</p>
      ) : (
        <>
          <div className="mt-2 flex items-end gap-2">
            <span className="text-2xl font-bold text-slate-900" data-testid={`pass-${r.label}`}>{pct(r.pass_rate, 1)}</span>
            <span className="text-[11px] text-slate-500 pb-1">{tx("accuracy")} · 95% {pct(r.ci_low)}–{pct(r.ci_high)}</span>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
            <div><dt className="text-slate-400">{tx("reliability (same verdict each repeat)")}</dt><dd className="font-semibold text-slate-800">{r.consistency === null || r.consistency === undefined ? <span className="font-normal text-slate-400" title={tx("Reliability is measured by repeating each case. This benchmark ran each case once.")}>{tx("needs 2+ repetitions")}</span> : pct(r.consistency)}{(r.flaky_cases?.length ?? 0) > 0 ? ` · ${r.flaky_cases!.length} ${tx("flaky")}` : ""}</dd></div>
            <div><dt className="text-slate-400">{tx("critical failures")}</dt><dd className={`font-semibold ${r.critical_failures ? "text-red-600" : "text-slate-800"}`}>{r.critical_failures ?? 0}</dd></div>
            <div><dt className="text-slate-400">{tx("latency p50 / p95")}</dt><dd className="font-semibold text-slate-800">{ms(lat?.p50)} / {ms(lat?.p95)}</dd></div>
            <div><dt className="text-slate-400">{tx("tokens in / out")}</dt><dd className="font-semibold text-slate-800">{tokens(r.tokens?.input)} / {tokens(r.tokens?.output)}</dd></div>
            <div><dt className="text-slate-400">{tx("inference cost")}</dt><dd className="font-semibold text-slate-800">{usd(r.cost?.candidate_usd)}</dd></div>
            <div><dt className="text-slate-400">{tx("judge cost")}</dt><dd className="font-semibold text-slate-800">{usd(r.cost?.judge_usd)}</dd></div>
            <div><dt className="text-slate-400">{tx("cost per passed case")}</dt><dd className="font-semibold text-slate-800">{usd(r.cost?.per_passed_usd)}</dd></div>
            <div><dt className="text-slate-400">{tx("errors / timeouts")}</dt><dd className="font-semibold text-slate-800">{pct(r.error_rate, 1)}</dd></div>
          </dl>
        </>
      )}
    </section>
  );
}

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
  const models = bench?.summary.models ?? {};
  const measured = labels.filter((l) => models[l].status === "measured");
  const rank = (l: string) => { const i = (bench?.summary.order ?? []).indexOf(l); return i >= 0 ? i + 1 : null; };
  const val = (l: string, f: (m: ModelResult) => number | null | undefined): number | null => (models[l]?.status === "measured" ? f(models[l]) ?? null : null);

  const histSeries: Series[] = useMemo(() => {
    const ls = Array.from(new Set(history.map((p) => p.model)));
    return ls.map((l) => ({ key: l, label: l, color: modelColor(l, ls) }));
  }, [history]);

  async function doExport(format: "csv" | "json") {
    if (!id) return;
    setExporting(true);
    try { await downloadExport("benchmark", id, format); } catch (e) { setError(e instanceof Error ? e.message : "Export failed."); } finally { setExporting(false); }
  }

  const toggleIn = (set: string[], setter: (v: string[]) => void, v: string) => setter(set.includes(v) ? set.filter((x) => x !== v) : [...set, v]);

  return (
    <div className="space-y-4 min-w-0 max-w-full">
      {error && <div className="text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600">{error}</div>}
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <label htmlFor="bm-pick" className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{tx("Benchmark")}</label>
        <select id="bm-pick" className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white w-full sm:w-auto sm:max-w-[min(100%,52rem)] truncate" value={id ?? ""} onChange={(e) => setId(e.target.value || null)}>
          {list.length === 0 && <option value="">{tx("No benchmarks yet")}</option>}
          {list.map((b) => (
            <option key={b.benchmark_id} value={b.benchmark_id}>
              {new Date(b.created_at).toLocaleString()} · {b.mode} · {b.models.map((m) => m.label.split("/")[1]).join(" vs ")} ×{b.repetitions}{b.synthetic ? " · scripted" : ""}
            </option>
          ))}
        </select>
        {id && <>
          <button type="button" className={btnGhost} disabled={exporting} onClick={() => doExport("csv")}>{tx("Export CSV")}</button>
          <button type="button" className={btnGhost} disabled={exporting} onClick={() => doExport("json")}>{tx("Export JSON")}</button>
        </>}
      </div>

      {!id && <p className="py-16 text-center text-sm text-slate-400">{tx("No benchmark has been run yet. Start one on the New benchmark tab.")}</p>}
      {id && !bench && !error && <p className="py-16 text-center text-xs text-slate-400">{tx("Loading…")}</p>}

      {bench && (
        <>
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600 space-y-1 min-w-0 break-words">
            <div><b className="text-slate-900">{bench.dataset}</b> {bench.dataset_version} · {bench.mode === "direct" ? tx("direct (bare model)") : tx("agent (real agent with tools)")} · ×{bench.repetitions} {tx("repetitions")} · {tx("judge")} {bench.judge_model ?? tx("none")}
              {bench.summary.judge?.calibration && <> ({tx("calibration")}: <b>{bench.summary.judge.calibration.status.replace("_", " ")}</b>{bench.summary.judge.calibration.agreement !== null ? ` ${pct(bench.summary.judge.calibration.agreement)}` : ""})</>}
            </div>
            {bench.synthetic && <div className="rounded-lg px-3 py-2 border bg-amber-50 border-amber-200 text-amber-700">{tx("SYNTHETIC: at least one model is a scripted stand-in. This checks the machinery; it does not rank models.")}</div>}
            {!bench.summary.valid && <div className="rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600">{tx("INVALID BENCHMARK")}: {bench.summary.problems.join("; ")}</div>}
            {bench.summary.leader && <div className="text-emerald-700 font-semibold">{bench.summary.leader} {tx("is shown to be better than every other model on this evidence.")}</div>}
            {bench.summary.notes.filter((n) => !n.startsWith("SYNTHETIC") && !n.startsWith("INVALID")).map((n) => <div key={n} className="text-slate-500">{n}</div>)}
          </div>

          <Legend series={series} hidden={hidden} onToggle={toggle} />

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 min-w-0">
            {labels.filter((l) => !hidden.has(l)).map((l) => <Card key={l} r={models[l]} color={modelColor(l, labels)} rank={rank(l)} />)}
          </div>

          <div className="grid gap-4 xl:grid-cols-2 min-w-0 [&>*]:min-w-0">
            <IntervalPlot title={tx("Accuracy with its 95% interval")} subtitle={tx("Wider ranges mean less evidence. Overlapping ranges do not show one model is better.")} hidden={hidden}
              rows={labels.map((l) => ({ key: l, label: l, color: modelColor(l, labels), value: val(l, (m) => m.pass_rate), low: val(l, (m) => m.ci_low), high: val(l, (m) => m.ci_high), note: NOT_RUN[models[l].status] ?? models[l].status }))} />
            <GroupedBars title={tx("Latency")} subtitle={tx("Median and 95th percentile per model.")} hidden={hidden} series={series}
              groups={[{ key: "p50", label: "p50" }, { key: "p95", label: "p95" }]} value={(g, s) => val(s, (m) => (g === "p50" ? m.latency_ms?.p50 : m.latency_ms?.p95))} format={(v) => ms(v)} />
            <GroupedBars title={tx("Token usage")} subtitle={tx("Total across the benchmark.")} hidden={hidden} series={series}
              groups={[{ key: "in", label: tx("input") }, { key: "out", label: tx("output") }]} value={(g, s) => val(s, (m) => (g === "in" ? m.tokens?.input : m.tokens?.output))} format={(v) => tokens(v)} />
            <GroupedBars title={tx("Cost")} subtitle={tx("What the model's own calls cost, what the judge cost, and the cost per passed case.")} hidden={hidden} series={series}
              groups={[{ key: "inf", label: tx("inference") }, { key: "judge", label: tx("judge") }, { key: "pp", label: tx("per pass") }]}
              value={(g, s) => val(s, (m) => (g === "inf" ? m.cost?.candidate_usd : g === "judge" ? m.cost?.judge_usd : m.cost?.per_passed_usd))} format={(v) => usd(v)} />
            <GroupedBars title={tx("Quality scored by the judge")} subtitle={tx("Mean score per metric (0 to 1).")} hidden={hidden} series={series} max={1}
              groups={Array.from(new Set(measured.flatMap((l) => Object.keys(models[l].quality ?? {})))).map((k) => ({ key: k, label: k.replace("_", " ") }))}
              value={(g, s) => val(s, (m) => m.quality?.[g]?.mean)} format={(v) => v.toFixed(2)} />
            <GroupedBars title={tx("Reliability")} subtitle={tx("Same verdict on every repeat, and the share of runs with a critical failure.")} hidden={hidden} series={series} max={1}
              groups={[{ key: "cons", label: tx("consistency") }, { key: "crit", label: tx("critical failure rate") }]}
              value={(g, s) => val(s, (m) => (g === "cons" ? m.consistency : m.critical_failure_rate))} format={(v) => pct(v)} />
          </div>

          <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3" aria-label={tx("Filters")}>
            <h3 className="text-sm font-bold text-slate-900">{tx("Filter results")}</h3>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-[11px]">
              <div><span className="text-slate-400 mr-1">{tx("model")}</span>{(breakdown?.facets.model ?? labels).map((m) => <button key={m} type="button" aria-pressed={fModels.includes(m)} className={`${chip(fModels.includes(m))} mr-1`} onClick={() => toggleIn(fModels, setFModels, m)}>{m}</button>)}</div>
              <div><span className="text-slate-400 mr-1">{tx("workflow stage")}</span>{(breakdown?.facets.stage ?? []).map((m) => <button key={m} type="button" aria-pressed={fStages.includes(m)} className={`${chip(fStages.includes(m))} mr-1 mb-1`} onClick={() => toggleIn(fStages, setFStages, m)}>{m}</button>)}</div>
              <div><span className="text-slate-400 mr-1">{tx("status")}</span>{STATUSES.filter((s) => (breakdown?.facets.status ?? STATUSES).includes(s)).map((m) => <button key={m} type="button" aria-pressed={fStatus.includes(m)} className={`${chip(fStatus.includes(m))} mr-1`} onClick={() => toggleIn(fStatus, setFStatus, m)}>{m.replace("_", " ")}</button>)}</div>
              <div><label className="text-slate-400 mr-1" htmlFor="bm-case">{tx("test case")}</label><input id="bm-case" value={fCase} onChange={(e) => setFCase(e.target.value)} placeholder="IND-LEAD" className="border border-slate-200 rounded-md px-2 py-1 text-[11px]" /></div>
              {(fModels.length > 0 || fStages.length > 0 || fStatus.length > 0 || fCase) && <button type="button" className="text-blue-600 underline" onClick={() => { setFModels([]); setFStages([]); setFStatus([]); setFCase(""); }}>{tx("clear filters")}</button>}
            </div>
          </section>

          {breakdown && breakdown.stages.length > 0 && (
            <GroupedBars title={tx("Accuracy by workflow stage")} subtitle={tx("Pass rate of the executions that ran, per stage and model (the filters above apply).")} hidden={hidden} max={1}
              series={series.filter((s) => breakdown.models.includes(s.key))} groups={breakdown.stages.map((s) => ({ key: s.stage, label: s.stage }))}
              value={(g, s) => breakdown.stages.find((x) => x.stage === g)?.models[s]?.pass_rate} format={(v) => pct(v)} />
          )}

          {breakdown && (
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="text-sm font-bold text-slate-900">{tx("Test cases by model")} <span className="font-normal text-slate-400">({breakdown.cases.length})</span></h3>
              <p className="text-[11px] text-slate-500">{tx("Each cell is passes out of runs. Click a repetition to read the model's answer, the checks, the judge's reasons and the trace.")}</p>
              {breakdown.cases.length === 0 ? <p className="py-8 text-center text-xs text-slate-400">{tx("No execution matches these filters.")}</p> : (
                <div className="mt-2 overflow-x-auto">
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
          )}

          {bench.summary.comparisons.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="text-sm font-bold text-slate-900">{tx("Is one model really better?")}</h3>
              <ul className="mt-1 text-[11px] text-slate-600 space-y-0.5">
                {bench.summary.comparisons.map((c) => <li key={`${c.a}|${c.b}`}><b>{c.a}</b> vs <b>{c.b}</b>: {c.verdict.replace(/_/g, " ")}{c.note ? ` — ${c.note}` : ""}</li>)}
              </ul>
            </section>
          )}
        </>
      )}

      {history.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Trend title={tx("History: accuracy per benchmark")} subtitle={tx("Every benchmark each model took part in. Scripted models are included only if you have run them.")} series={histSeries} hidden={hidden} max={1} format={(v) => pct(v)}
            points={history.filter((p) => p.status === "measured" && p.pass_rate !== undefined).map((p) => ({ at: p.at, series: p.model, value: p.pass_rate as number, label: p.benchmark_id }))} />
          <Trend title={tx("History: total cost per benchmark")} series={histSeries} hidden={hidden} format={(v) => usd(v)}
            points={history.filter((p) => p.status === "measured" && typeof p.total_usd === "number").map((p) => ({ at: p.at, series: p.model, value: p.total_usd as number, label: p.benchmark_id }))} />
        </div>
      )}

      {trace && <TraceDrawer resultId={trace} onClose={() => setTrace(null)} />}
    </div>
  );
}
