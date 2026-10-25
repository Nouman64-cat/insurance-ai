"use client";

import { useEffect, useMemo, useState } from "react";
import Results from "@/components/benchmarking/Results";
import TraceDrawer from "@/components/benchmarking/TraceDrawer";
import ModelsPanel from "@/components/costs/ModelsPanel";
import { tx } from "@/lib/i18n/tx";
import { ms } from "@/lib/evalBenchmarks";
import { formatter, money } from "@/lib/evalCosts";
import { listExecutions, type ResultRow, type ResultsPage } from "@/lib/evalStudio";
import { useQueryState } from "@/lib/useQueryState";

const STATUSES = ["passed", "failed", "blocked", "skipped", "infrastructure_error"] as const;
const TONE: Record<string, string> = { passed: "bg-emerald-50 text-emerald-700 border-emerald-200", failed: "bg-red-50 text-red-700 border-red-200", blocked: "bg-amber-50 text-amber-700 border-amber-200",
  skipped: "bg-slate-50 text-slate-500 border-slate-200", infrastructure_error: "bg-violet-50 text-violet-700 border-violet-200" };
const PAGE = 40;
const sel = "rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs";

/** Executions across every run as a filterable list: status chips that show how many there are of each, then the model, the dataset and the case. Click a row for the trace, the checks and the judge's reasons. */
export function ExecutionsView({ page, status, onStatus, model, onModel, dataset, onDataset, text, onText, synthetic, onSynthetic, offset, onOffset, onOpen }: {
  page: ResultsPage; status: string; onStatus: (s: string) => void; model: string; onModel: (s: string) => void; dataset: string; onDataset: (s: string) => void; text: string; onText: (s: string) => void;
  synthetic: boolean; onSynthetic: (b: boolean) => void; offset: number; onOffset: (n: number) => void; onOpen: (r: ResultRow) => void;
}) {
  const total = Object.values(page.by_status).reduce((a, b) => a + b, 0);
  return (
    <div className="space-y-3" data-testid="executions">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={tx("Filter by outcome")}>
        <button type="button" aria-pressed={!status} onClick={() => onStatus("")} className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${!status ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300"}`}>{tx("All")} {total}</button>
        {STATUSES.map((s) => <button key={s} type="button" aria-pressed={status === s} onClick={() => onStatus(status === s ? "" : s)} data-status={s}
          className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${status === s ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300"}`}>{s.replace("_", " ")} {page.by_status[s] ?? 0}</button>)}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[10px] text-slate-500">{tx("Model")}<select className={`${sel} block`} value={model} onChange={(e) => onModel(e.target.value)}><option value="">{tx("any")}</option>{page.models.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
        <label className="text-[10px] text-slate-500">{tx("Dataset")}<select className={`${sel} block`} value={dataset} onChange={(e) => onDataset(e.target.value)}><option value="">{tx("any")}</option>{page.datasets.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
        <label className="text-[10px] text-slate-500">{tx("Case")}<input className={`${sel} block w-40`} value={text} onChange={(e) => onText(e.target.value)} placeholder="IND-AGT" /></label>
        <label className="flex items-center gap-1.5 pb-1.5 text-[11px] text-slate-600 dark:text-slate-300"><input type="checkbox" checked={synthetic} onChange={(e) => onSynthetic(e.target.checked)} />{tx("include scripted models")}</label>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        <table className="w-full text-xs" data-testid="executions-table">
          <thead><tr className="border-b border-slate-100 text-left text-slate-400 dark:border-slate-800"><th className="px-3 py-2 font-semibold">{tx("Case")}</th><th className="font-semibold">{tx("Outcome")}</th><th className="font-semibold">{tx("Model")}</th><th className="font-semibold">{tx("Agent")}</th><th className="text-right font-semibold">{tx("Latency")}</th><th className="text-right font-semibold">{tx("Cost")}</th><th className="pr-3 text-right font-semibold">{tx("When")}</th></tr></thead>
          <tbody>
            {page.results.length === 0 && <tr><td colSpan={7} className="py-12 text-center text-slate-400">{tx("No execution matches.")}</td></tr>}
            {page.results.map((r) => (
              <tr key={r.result_id} className="cursor-pointer border-t border-slate-100 align-top hover:bg-sky-50/50 dark:border-slate-800 dark:hover:bg-slate-800/60" onClick={() => onOpen(r)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen(r)} data-testid="execution-row">
                <td className="px-3 py-2 font-semibold text-slate-800 dark:text-slate-100">{r.case}{r.repetition > 1 ? <span className="font-normal text-slate-400"> r{r.repetition}</span> : null}<span className="block text-[10px] font-normal text-slate-400">{r.dataset} {r.version}{r.stage ? ` · ${r.stage}` : ""}</span></td>
                <td><span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${TONE[r.status] ?? TONE.skipped}`}>{r.status.replace("_", " ")}</span>{r.critical_failed ? <span className="ml-1 rounded bg-red-600 px-1 text-[9px] font-bold text-white">critical</span> : null}{r.reason ? <span className="block max-w-[14rem] truncate text-[10px] text-slate-400" title={r.reason}>{r.reason}</span> : null}</td>
                <td className="text-slate-600 dark:text-slate-300">{r.model ?? "—"}{r.synthetic ? <span className="text-[10px] text-slate-400"> · {tx("scripted")}</span> : null}</td>
                <td className="text-slate-500">{r.specialist ?? "—"}{r.tools.length ? <span className="block max-w-[10rem] truncate text-[10px] text-slate-400" title={r.tools.join(", ")}>{r.tools.join(", ")}</span> : null}</td>
                <td className="text-right text-slate-600 dark:text-slate-300">{ms(r.latency_ms)}</td>
                <td className="text-right text-slate-600 dark:text-slate-300">{r.cost_usd === null ? (r.status === "skipped" || r.status === "blocked" ? "—" : tx("unknown")) : money(r.cost_usd)}</td>
                <td className="pr-3 text-right text-[10px] text-slate-400">{r.at ? new Date(r.at).toLocaleString() : ""}</td>
              </tr>))}
          </tbody>
        </table>
      </div>
      {page.total > PAGE && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <button type="button" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - PAGE))} className="rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700">{tx("Previous")}</button>
          <span>{offset + 1}–{Math.min(offset + PAGE, page.total)} {tx("of")} {page.total.toLocaleString()}</span>
          <button type="button" disabled={offset + PAGE >= page.total} onClick={() => onOffset(offset + PAGE)} className="rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700">{tx("Next")}</button>
        </div>
      )}
    </div>
  );
}

function Executions({ onTrace }: { onTrace: (id: string) => void }) {
  const [status, setStatus] = useQueryState("st");
  const [model, setModel] = useQueryState("im");
  const [dataset, setDataset] = useQueryState("dsf");
  const [text, setText] = useQueryState("ic", "", { replace: true });
  const [synth, setSynth] = useQueryState("isyn");
  const [runId, setRunId] = useQueryState("ir");
  const [offset, setOffset] = useQueryState("ioff", "0", { replace: true });
  const [page, setPage] = useState<ResultsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const off = Number(offset) || 0;
  useEffect(() => {
    const t = setTimeout(() => { listExecutions({ status, model, dataset, case: text, run_id: runId, include_synthetic: synth === "1" || !!runId, limit: PAGE, offset: off }).then((p) => { setPage(p); setError(null); }).catch((e) => setError(e instanceof Error ? e.message : "Could not load the executions.")); }, text ? 300 : 0);
    return () => clearTimeout(t);
  }, [status, model, dataset, text, synth, runId, off]);
  if (error) return <p className="text-xs text-red-600">{error}</p>;
  if (!page) return <p className="py-12 text-center text-xs text-slate-400">{tx("Loading…")}</p>;
  return <>{runId && <p className="mb-2 text-xs text-slate-600 dark:text-slate-300">{tx("Only the executions of run")} <b className="font-mono">{runId}</b> <button type="button" className="ml-2 text-sky-600 underline" onClick={() => setRunId("")}>{tx("show all")}</button></p>}<ExecutionsView page={page} status={status} onStatus={(s) => { setStatus(s); setOffset("0"); }} model={model} onModel={(s) => { setModel(s); setOffset("0"); }} dataset={dataset} onDataset={(s) => { setDataset(s); setOffset("0"); }}
    text={text} onText={(s) => { setText(s); setOffset("0"); }} synthetic={synth === "1"} onSynthetic={(b) => { setSynth(b ? "1" : ""); setOffset("0"); }} offset={off} onOffset={(n) => setOffset(String(n))} onOpen={(r) => onTrace(r.result_id)} /></>;
}

const SUBS = [{ id: "executions", label: "Executions" }, { id: "benchmarks", label: "Benchmarks" }, { id: "compare", label: "Models & cost" }] as const;

export default function InvestigateView() {
  const [subParam, setSub] = useQueryState("sub", "");
  const [stFilter] = useQueryState("st");
  const sub = (SUBS.some((s) => s.id === subParam) ? subParam : stFilter ? "executions" : "executions") as (typeof SUBS)[number]["id"];
  const [bench, setBench] = useQueryState("bench");
  const [trace, setTrace] = useState<string | null>(null);
  const fmt = useMemo(() => formatter("USD", null), []);
  return (
    <div className="space-y-3" data-testid="investigate-view">
      <div className="flex gap-1" role="group" aria-label={tx("What to investigate")}>
        {SUBS.map((s) => <button key={s.id} type="button" aria-pressed={sub === s.id} onClick={() => setSub(s.id)} className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold ${sub === s.id ? "border-blue-500 bg-blue-600 text-white" : "border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"}`}>{tx(s.label)}</button>)}
      </div>
      {sub === "executions" && <Executions onTrace={setTrace} />}
      {sub === "benchmarks" && <Results initialId={bench || null} onOpened={(id) => id !== bench && setBench(id)} />}
      {sub === "compare" && <ModelsPanel fmt={fmt} refreshKey={0} />}
      {trace && <TraceDrawer resultId={trace} onClose={() => setTrace(null)} />}
    </div>
  );
}
