"use client";

import { useMemo, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { PROVIDER_NAME, modelColor, providerOf, type ModelResult } from "@/lib/evalBenchmarks";
import { buildTable, highlights, onlyDifferences, tableToCsv, type Group } from "@/lib/benchmarkTable";

const DIR_WORD = { higher: "higher is better", lower: "lower is better", none: "for information" } as const;
const MUTED = new Set(["—", "unknown", "not run", "not scored", "needs 2+ repeats"]);

/** The table itself, apart from its controls, so it can be drawn and checked on its own. `showAll` adds the detail rows to the key ones. */
export function ComparisonGrid({ groups, labels, allLabels, showAll, models }: { groups: Group[]; labels: string[]; allLabels: string[]; showAll: boolean; models: Record<string, ModelResult> }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-300 bg-white shadow-sm dark:border-slate-600 dark:bg-slate-900" role="region" aria-label={tx("Model comparison table")} tabIndex={0}>
      <table className="w-full min-w-[40rem] table-fixed border-collapse text-[13px]" data-testid="comparison-table">
        <caption className="sr-only">{tx("The measured quantities of each model in this benchmark. In each row the best value among the real models is marked with a check.")}</caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-10 w-56 min-w-[10rem] border border-slate-300 bg-slate-100 px-3 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300">{tx("Metric")}</th>
            {labels.map((l) => (
              <th key={l} scope="col" className={`min-w-[8rem] border border-slate-300 bg-slate-100 px-3 py-3 text-center align-bottom dark:border-slate-600 dark:bg-slate-800 ${models[l]?.synthetic ? "opacity-60" : ""}`} data-model={l}>
                <span className="flex items-center justify-center gap-1.5"><span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: modelColor(l, allLabels) }} aria-hidden /><b className="truncate text-sm font-extrabold text-slate-900 dark:text-slate-50" title={l}>{l.split("/")[1] ?? l}</b></span>
                <span className="block text-[10px] font-semibold text-slate-500">{models[l]?.synthetic ? tx("scripted stand-in") : PROVIDER_NAME[providerOf(l)] ?? providerOf(l)}</span>
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((g) => {
          const rows = showAll ? g.rows : g.rows.filter((r) => r.key);
          if (rows.length === 0) return null;
          return (
            <tbody key={g.id} data-group={g.id}>
              <tr><th scope="rowgroup" colSpan={labels.length + 1} className="sticky left-0 border border-slate-300 bg-blue-50/70 px-3 py-2 text-left text-[11px] font-extrabold uppercase tracking-wider text-blue-900 dark:border-slate-600 dark:bg-slate-800 dark:text-sky-200">{tx(g.title)}</th></tr>
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40" data-row={r.id}>
                  <th scope="row" className="sticky left-0 z-10 border border-slate-300 bg-white px-3 py-2.5 text-left align-middle font-bold text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100">
                    {tx(r.label)}
                    <span className="ml-1 cursor-help text-[10px] font-normal text-slate-400" title={`${tx(r.hint)} (${tx(DIR_WORD[r.direction])})`} aria-label={`${tx(r.hint)} (${tx(DIR_WORD[r.direction])})`} role="img">ⓘ</span>
                  </th>
                  {labels.map((l) => {
                    const c = r.cells[l];
                    const scripted = !!models[l]?.synthetic;
                    return (
                      <td key={l} data-best={c.best ? "true" : undefined} data-scripted={scripted ? "true" : undefined} className={`border border-slate-300 px-3 py-2.5 text-center align-middle dark:border-slate-600 ${c.best ? "bg-emerald-50 dark:bg-emerald-950/25" : ""} ${scripted ? "opacity-60" : ""}`} title={c.note}>
                        <span className={MUTED.has(c.text) ? "font-semibold text-slate-400" : c.best ? "font-extrabold text-emerald-800 dark:text-emerald-200" : "font-bold text-slate-900 dark:text-slate-100"}>{c.text}</span>
                        {c.best && <span className="ml-1 text-[11px] font-bold text-emerald-600" aria-hidden>✓</span>}
                        {c.best && <span className="sr-only">best</span>}
                        {c.note && <span className="block text-[10px] font-normal text-amber-700 dark:text-amber-300">{tx(c.note)}</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

export default function ComparisonTable({ models, labels, allLabels, benchmarkId }: { models: Record<string, ModelResult>; labels: string[]; allLabels: string[]; benchmarkId: string; synthetic?: boolean }) {
  const [diffOnly, setDiffOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const full = useMemo(() => buildTable(models, labels), [models, labels]);
  const groups = diffOnly ? onlyDifferences(full) : full;
  const wins = useMemo(() => highlights(full), [full]);
  const total = full.reduce((n, g) => n + g.rows.length, 0), key = full.reduce((n, g) => n + g.rows.filter((r) => r.key).length, 0);
  const realMeasured = labels.filter((l) => models[l]?.status === "measured" && !models[l]?.synthetic).length;
  function download() {
    try {
      const blob = new Blob([tableToCsv(full, labels)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `benchmark-${benchmarkId}-comparison.csv`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      setNote(null);
    } catch { setNote(tx("Could not create the file.")); }
  }
  if (labels.length === 0) return null;
  const visibleRows = groups.reduce((n, g) => n + (showAll ? g.rows.length : g.rows.filter((r) => r.key).length), 0);
  return (
    <section className="w-full space-y-4" aria-label={tx("Model comparison")} data-testid="comparison">
      {/* the answer first: who wins what */}
      {wins.length > 0 ? (
        <ul className="flex flex-wrap gap-3" aria-label={tx("Highlights")} data-testid="highlights">
          {wins.map((w) => (
            <li key={w.id} className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950/20">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: modelColor(w.model, allLabels) }} aria-hidden />
              <span className="text-[11px] text-slate-500">{tx(w.title)}</span>
              <b className="text-xs font-extrabold text-slate-900 dark:text-slate-50">{w.model.split("/")[1] ?? w.model}</b>
              <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">{w.text}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-[11px] text-slate-500" role="note">{realMeasured < 2 ? tx("Fewer than two real models were measured, so no one is named best.") : tx("No model is clearly ahead on accuracy, speed or cost per correct answer.")}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <h3 className="mr-auto text-base font-extrabold text-slate-900 dark:text-slate-50">{tx("Model comparison")}</h3>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300"><input type="checkbox" checked={diffOnly} onChange={(e) => setDiffOnly(e.target.checked)} data-testid="diff-only" />{tx("Only what differs")}</label>
        <button type="button" onClick={download} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-sky-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">{tx("Download CSV")}</button>
      </div>
      {note && <p className="text-[11px] text-red-600" role="alert">{note}</p>}

      {visibleRows === 0 ? <p className="py-6 text-center text-xs text-slate-400">{tx("The models do not differ on anything measured.")}</p>
        : <ComparisonGrid groups={groups} labels={labels} allLabels={allLabels} showAll={showAll} models={models} />}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll} data-testid="show-all" className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:border-blue-300 dark:border-slate-700 dark:bg-slate-900 dark:text-sky-300">
          {showAll ? tx("Show fewer metrics") : `${tx("Show all metrics")} (${total})`}
        </button>
        <p className="text-[10px] text-slate-400">{showAll ? "" : `${tx("Showing the")} ${key} ${tx("key measures.")} `}{tx("A ✓ marks the best of the real models; scripted models are muted and never count. A dash means not measured, never zero.")}</p>
      </div>
    </section>
  );
}
