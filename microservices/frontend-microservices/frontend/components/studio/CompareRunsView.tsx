"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { ms, pct } from "@/lib/evalBenchmarks";
import { show } from "@/lib/evalCosts";
import { compareRuns, listRuns, studioHref, type CaseChange, type RunComparison, type RunListItem } from "@/lib/evalStudio";
import { useQueryState } from "@/lib/useQueryState";

const sel = "w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs";
export const runLabel = (r: RunListItem) => `${r.started_at ? new Date(r.started_at).toLocaleDateString() : ""} · ${r.model ?? "no model"} · ${r.dataset} ${r.version} · ${r.pass_rate === null ? "—" : `${Math.round(r.pass_rate * 100)}%`} · ${r.executions}${r.synthetic ? " · scripted" : ""}`;
const sign = (v: number | null, unit: (x: number) => string) => (v === null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${unit(Math.abs(v))}`);

function Totals({ title, r, t }: { title: string; r: RunComparison["a_run"]; t: RunComparison["a"] }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{title}</p>
      <p className="truncate font-mono text-[11px] text-slate-700 dark:text-slate-200" title={r.run_id}>{r.run_id}</p>
      <p className="text-[11px] text-slate-500">{r.model ?? tx("no model")} · {r.dataset} {r.version}</p>
      <p className="mt-1 text-lg font-bold text-slate-900 dark:text-slate-50">{pct(t.pass_rate, 1)} <span className="text-xs font-normal text-slate-500">{t.passed}/{t.ran}</span></p>
      <p className="text-[11px] text-slate-500">{t.cost_usd === null ? tx("cost unknown") : show(t.cost_usd)}{t.unknown_cost_executions ? ` + ${t.unknown_cost_executions} ${tx("unpriced")}` : ""} · P50 {ms(t.latency_p50_ms)}</p>
    </div>
  );
}

function Changes({ id, title, tone, items, a, b }: { id: string; title: string; tone: string; items: CaseChange[]; a: string; b: string }) {
  if (!items.length) return null;
  return (
    <section data-testid={`cmp-${id}`}>
      <h4 className={`text-xs font-bold ${tone}`}>{title} <span className="font-normal text-slate-400">({items.length})</span></h4>
      <ul className="mt-1 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-xs dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-900">{items.map((x) => (
        <li key={x.case} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
          <b className="text-slate-800 dark:text-slate-100">{x.case}</b>
          <span className="text-slate-500">{x.a.replace("_", " ")}{x.a_pass_fraction !== null && x.a_pass_fraction < 1 && x.a === "failed" ? ` (${Math.round(x.a_pass_fraction * 100)}% of repeats passed)` : ""} → {x.b.replace("_", " ")}{x.b_pass_fraction !== null && x.b_pass_fraction < 1 && x.b === "failed" ? ` (${Math.round(x.b_pass_fraction * 100)}%)` : ""}</span>
          <span className="ml-auto flex gap-2 text-[11px]">
            <Link className="text-sky-700 hover:underline dark:text-sky-300" href={studioHref({ mode: "investigate", sub: "executions", extra: { ir: a, ic: x.case } })}>{tx("in A")}</Link>
            <Link className="text-sky-700 hover:underline dark:text-sky-300" href={studioHref({ mode: "investigate", sub: "executions", extra: { ir: b, ic: x.case } })}>{tx("in B")}</Link>
          </span>
        </li>))}
      </ul>
    </section>
  );
}

/** Every stored run, newest first: open one to read its summary and executions, or start a comparison from it. Pure: the runs are given. */
export function RunList({ runs, onCompare }: { runs: RunListItem[]; onCompare: (runId: string) => void }) {
  if (!runs.length) return <p className="py-8 text-center text-xs text-slate-400">{tx("No run is stored yet.")}</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900" data-testid="run-list">
      <table className="w-full text-xs">
        <thead><tr className="border-b border-slate-100 text-left text-slate-400 dark:border-slate-800"><th className="px-3 py-2 font-semibold">{tx("Run")}</th><th className="font-semibold">{tx("Model")}</th><th className="font-semibold">{tx("Dataset")}</th>
          <th className="text-right font-semibold">{tx("Pass rate")}</th><th className="text-right font-semibold">{tx("Executions")}</th><th className="text-right font-semibold">{tx("Cost")}</th><th className="pr-3" /></tr></thead>
        <tbody>{runs.map((r) => (
          <tr key={r.run_id} className="border-t border-slate-100 dark:border-slate-800" data-run={r.run_id}>
            <td className="px-3 py-1.5"><Link className="font-mono text-[11px] font-semibold text-sky-700 hover:underline dark:text-sky-300" href={studioHref({ mode: "investigate", sub: "executions", extra: { ir: r.run_id } })}>{r.run_id}</Link>
              <span className="block text-[10px] text-slate-400">{r.started_at ? new Date(r.started_at).toLocaleString() : ""} · ×{r.repetitions}</span></td>
            <td className="text-slate-600 dark:text-slate-300">{r.model ?? "—"}{r.synthetic ? <span className="text-[10px] text-slate-400"> · {tx("scripted")}</span> : null}</td>
            <td className="text-slate-500">{r.dataset} {r.version}</td>
            <td className="text-right text-slate-700 dark:text-slate-200">{pct(r.pass_rate, 1)} <span className="text-slate-400">({r.passed}/{r.passed + r.failed})</span></td>
            <td className="text-right text-slate-500">{r.executions}</td>
            <td className="text-right text-slate-500">{show(r.known_cost_usd)}</td>
            <td className="pr-3 text-right"><button type="button" onClick={() => onCompare(r.run_id)} className="text-[11px] font-semibold text-sky-700 underline dark:text-sky-300">{tx("Compare")}</button></td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

/** The comparison, drawn. Pure: everything is in `c`. A is the baseline; B the later run. */
export function CompareBody({ c }: { c: RunComparison }) {
  const d = c.delta;
  return (
    <div className="space-y-3" data-testid="compare-body">
      <div className="grid gap-3 sm:grid-cols-2"><Totals title={tx("A · baseline")} r={c.a_run} t={c.a} /><Totals title={tx("B · compared")} r={c.b_run} t={c.b} /></div>
      <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200" data-testid="cmp-delta">
        {tx("B against A")}: {tx("pass rate")} <b>{sign(d.pass_rate === null ? null : d.pass_rate * 100, (x) => `${x.toFixed(1)} ${tx("points")}`)}</b> · {tx("cost")} <b>{sign(d.cost_usd, (x) => show(x))}</b> · {tx("P50 latency")} <b>{sign(d.latency_p50_ms, (x) => ms(x))}</b> · {tx("P95")} <b>{sign(d.latency_p95_ms, (x) => ms(x))}</b>
      </p>
      <p className="text-[11px] text-slate-500">{c.cases_compared} {tx("cases ran in both")}: {c.newly_failing.length} {tx("newly failing")}, {c.newly_passing.length} {tx("newly passing")}, {c.changed.length} {tx("other changes")}, {c.unchanged} {tx("unchanged")}.</p>
      {c.notes.map((n) => <p key={n} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800" data-testid="cmp-note">{n}</p>)}
      <Changes id="failing" title={tx("Newly failing: passed in A, fails in B")} tone="text-red-700" items={c.newly_failing} a={c.a_run.run_id} b={c.b_run.run_id} />
      <Changes id="passing" title={tx("Newly passing: failed in A, passes in B")} tone="text-emerald-700" items={c.newly_passing} a={c.a_run.run_id} b={c.b_run.run_id} />
      <Changes id="changed" title={tx("Other changes: a verdict gained or lost")} tone="text-amber-700" items={c.changed} a={c.a_run.run_id} b={c.b_run.run_id} />
      {(c.only_in_a.length > 0 || c.only_in_b.length > 0) && <p className="text-[11px] text-slate-500" data-testid="cmp-only">{tx("Only in A")}: {c.only_in_a.join(", ") || "—"} · {tx("only in B")}: {c.only_in_b.join(", ") || "—"}</p>}
      {c.newly_failing.length + c.newly_passing.length + c.changed.length === 0 && <p className="text-xs text-slate-500">{tx("No case changed its outcome between the two runs.")}</p>}
    </div>
  );
}

export default function CompareRunsView() {
  const [a, setA] = useQueryState("ca");
  const [b, setB] = useQueryState("cb");
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [c, setC] = useState<RunComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { listRuns().then(setRuns).catch((e) => setError(e instanceof Error ? e.message : "Could not list the runs.")); }, []);
  useEffect(() => {
    setC(null);
    if (!a || !b || a === b) return;
    setError(null);
    compareRuns(a, b).then(setC).catch((e) => setError(e?.response?.data?.detail ?? (e instanceof Error ? e.message : "Could not compare the runs.")));
  }, [a, b]);
  const options = (runs ?? []).filter((r) => !r.synthetic);
  return (
    <div className="space-y-3" data-testid="compare-runs">
      <p className="text-xs text-slate-600 dark:text-slate-300">{tx("Pick a baseline run (A) and a later one (B). Cases are compared by outcome across their repetitions. Scripted runs are left out.")}</p>
      <div className="grid items-end gap-2 sm:grid-cols-[1fr_auto_1fr]">
        <label className="text-[10px] text-slate-500">{tx("A · baseline")}<select className={sel} value={a} onChange={(e) => setA(e.target.value)}><option value="">{tx("choose a run")}</option>{options.map((r) => <option key={r.run_id} value={r.run_id}>{runLabel(r)}</option>)}</select></label>
        <button type="button" onClick={() => { const x = a; setA(b); setB(x); }} disabled={!a && !b} aria-label={tx("Swap A and B")} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300">⇄</button>
        <label className="text-[10px] text-slate-500">{tx("B · compared")}<select className={sel} value={b} onChange={(e) => setB(e.target.value)}><option value="">{tx("choose a run")}</option>{options.map((r) => <option key={r.run_id} value={r.run_id}>{runLabel(r)}</option>)}</select></label>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {a && b && a === b && <p className="text-xs text-amber-700">{tx("Choose two different runs.")}</p>}
      {(!a || !b) && !error && <p className="py-4 text-center text-xs text-slate-400">{runs && options.length < 2 ? tx("Fewer than two real-model runs are stored, so there is nothing to compare yet.") : tx("Choose two runs to compare, or start from a run below.")}</p>}
      {a && b && a !== b && !c && !error && <p className="py-10 text-center text-xs text-slate-400">{tx("Comparing…")}</p>}
      {c && <CompareBody c={c} />}
      {runs && <section className="space-y-1.5"><h3 className="text-xs font-bold text-slate-900 dark:text-slate-50">{tx("Stored runs")} <span className="font-normal text-slate-400">({runs.length})</span></h3>
        <RunList runs={runs} onCompare={(id) => { if (!a || (a && b)) { setA(id); setB(""); } else setB(id); }} /></section>}
    </div>
  );
}
