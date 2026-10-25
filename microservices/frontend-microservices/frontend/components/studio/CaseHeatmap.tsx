"use client";

import { tx } from "@/lib/i18n/tx";
import type { Breakdown } from "@/lib/evalBenchmarks";

/** Cases down the side, models across: each cell is the share of its executions that passed, from green (all) to red (none); grey means none of them produced a verdict (blocked, skipped, error). A row that
 *  is red in every column is probably a bad case or a real defect; one red in a single column points at that model. Click a cell to read an execution's trace. */
export default function CaseHeatmap({ breakdown, hidden, onOpen }: { breakdown: Breakdown; hidden: Set<string>; onOpen: (resultId: string) => void }) {
  const models = breakdown.models.filter((m) => !hidden.has(m));
  if (breakdown.cases.length === 0 || models.length === 0) return null;
  const shade = (rate: number | null, ran: number) => (ran === 0 || rate === null ? "#e2e8f0" : `hsl(${Math.round(rate * 125)} 62% ${rate === 1 ? 62 : 58}%)`);
  const sorted = [...breakdown.cases].sort((a, b) => {
    const worst = (c: Breakdown["cases"][number]) => Math.min(1, ...models.map((m) => c.models[m]?.pass_rate ?? 1));
    return worst(a) - worst(b) || a.case.localeCompare(b.case);
  });
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900" data-testid="heatmap">
      <h3 className="text-sm font-bold text-slate-900 dark:text-slate-50">{tx("Case × model heatmap")}</h3>
      <p className="text-[11px] text-slate-500">{tx("Weakest cases first. Green passed, red failed, grey produced no verdict. Click a cell to read the trace.")}</p>
      <div className="mt-2 overflow-x-auto">
        <table className="text-[10px]" role="grid"><thead><tr><th className="pr-3 text-left font-semibold text-slate-400">{tx("Case")}</th>{models.map((m) => <th key={m} className="px-1 text-center font-semibold text-slate-500" title={m}>{m.split("/").pop()}</th>)}</tr></thead>
          <tbody>{sorted.map((c) => (
            <tr key={c.case}>
              <td className="whitespace-nowrap py-0.5 pr-3 font-semibold text-slate-700 dark:text-slate-200" title={c.stage}>{c.case}</td>
              {models.map((m) => {
                const cell = c.models[m];
                if (!cell) return <td key={m} className="px-0.5"><div className="h-6 w-14 rounded bg-slate-50 dark:bg-slate-800" title={tx("not run")} /></td>;
                const ran = cell.passed + cell.failed;
                return (
                  <td key={m} className="px-0.5"><button type="button" disabled={cell.result_ids.length === 0} onClick={() => onOpen(cell.result_ids[0])} data-cell={`${c.case}|${m}`} data-rate={cell.pass_rate ?? ""}
                    className="h-6 w-14 rounded text-[10px] font-bold text-slate-900/80 hover:ring-2 hover:ring-sky-400 focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-40" style={{ background: shade(cell.pass_rate, ran) }}
                    title={`${c.case} · ${m}: ${cell.passed}/${ran} passed${cell.other ? `, ${cell.other} without a verdict` : ""}${cell.critical ? `, ${cell.critical} critical` : ""}`}>{ran ? `${cell.passed}/${ran}` : "–"}</button></td>
                );
              })}
            </tr>))}</tbody></table>
      </div>
    </section>
  );
}
