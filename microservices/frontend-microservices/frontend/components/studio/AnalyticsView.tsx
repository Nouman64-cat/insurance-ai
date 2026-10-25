"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { tx } from "@/lib/i18n/tx";
import { ms } from "@/lib/evalBenchmarks";
import { getCostOverview, show, type CostOverview } from "@/lib/evalCosts";
import { LAYER_IDS, getAnalytics, studioHref, type Analytics } from "@/lib/evalStudio";
import { useQueryState } from "@/lib/useQueryState";

const STATUS_ORDER = ["passed", "failed", "blocked", "skipped", "infrastructure_error"] as const;
const STATUS_COLOR: Record<string, string> = { passed: "#10b981", failed: "#ef4444", blocked: "#f59e0b", skipped: "#94a3b8", infrastructure_error: "#8b5cf6" };
const WINDOWS = [7, 30, 90, 365] as const;
const sel = "rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs";
const pc = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
const rate = (x: number | null | undefined) => (x === null || x === undefined ? "#e2e8f0" : `hsl(${Math.round(x * 125)} 62% ${x === 1 ? 62 : 58}%)`);

/** Where a click goes: the executions behind the figure, with the same window, model and scripted choice, so the number and the rows can be compared. */
export function drill(a: Pick<Analytics, "window_days" | "include_synthetic" | "dataset">, extra: Record<string, string>) {
  return studioHref({ mode: "investigate", sub: "executions", extra: { idays: String(a.window_days), ...(a.include_synthetic ? { isyn: "1" } : {}), ...(a.dataset ? { dsf: a.dataset } : {}), ...extra } });
}

function Card({ title, sub, children, id }: { title: string; sub?: string; children: ReactNode; id: string }) {
  return (
    <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900" data-testid={`an-${id}`} aria-label={title}>
      <h3 className="text-sm font-bold text-slate-900 dark:text-slate-50">{title}</h3>
      {sub && <p className="text-[11px] text-slate-500">{sub}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}
const Empty = ({ text }: { text: string }) => <p className="py-6 text-center text-xs text-slate-400">{text}</p>;

function Outcomes({ a }: { a: Analytics }) {
  const models = Object.keys(a.outcomes.by_model);
  if (!models.length) return <Empty text={tx("No execution in this window.")} />;
  return (
    <div className="space-y-2">
      {models.map((m) => {
        const by = a.outcomes.by_model[m], total = Object.values(by).reduce((x, y) => x + y, 0) || 1;
        return (
          <div key={m}>
            <div className="flex justify-between text-[11px]"><span className="font-semibold text-slate-700 dark:text-slate-200">{m}</span><span className="text-slate-400">{total} {tx("executions")}</span></div>
            <div className="mt-0.5 flex h-5 overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800" role="group" aria-label={m}>
              {STATUS_ORDER.filter((s) => by[s]).map((s) => (
                <Link key={s} href={drill(a, { im: m, st: s })} data-status={s} style={{ width: `${(by[s] / total) * 100}%`, background: STATUS_COLOR[s] }} title={`${s.replace("_", " ")}: ${by[s]} (${pc(by[s] / total)})`}
                  className="block min-w-[3px] hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500" aria-label={`${m} ${s.replace("_", " ")} ${by[s]}`} />
              ))}
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-[10px] text-slate-500">{STATUS_ORDER.map((s) => <span key={s} className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: STATUS_COLOR[s] }} />{s.replace("_", " ")} {a.outcomes.by_status[s] ?? 0}</span>)}</div>
      <p className="text-[10px] text-slate-400">{tx("Pass rate counts only executions that produced a verdict (passed or failed).")} {tx("Overall")}: <b>{pc(a.outcomes.pass_rate)}</b>{a.outcomes.critical_failures ? ` · ${a.outcomes.critical_failures} ${tx("critical failures")}` : ""}</p>
    </div>
  );
}

function Coverage({ a }: { a: Analytics }) {
  const rows = Object.entries(a.coverage);
  if (!rows.length) return <Empty text={tx("No dataset ran in this window.")} />;
  return (
    <ul className="space-y-2">{rows.map(([ds, c]) => (
      <li key={ds}>
        <div className="flex justify-between text-[11px]"><span className="font-semibold text-slate-700 dark:text-slate-200">{ds}</span><span className="text-slate-500">{c.cases_run}{c.cases_total !== null ? ` / ${c.cases_total}` : ""} {tx("cases run")}{c.share !== null ? ` · ${pc(c.share)}` : ""}</span></div>
        <div className="mt-0.5 h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-blue-500" style={{ width: `${(c.share ?? 0) * 100}%` }} /></div>
      </li>))}
    </ul>
  );
}

function Layers({ a }: { a: Analytics }) {
  const models = Object.entries(a.layers.by_model).filter(([, ls]) => LAYER_IDS.some((l) => (ls[l]?.applicable ?? 0) > 0));
  if (!models.length) return <Empty text={tx("No layer was scored in this window.")} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]" data-testid="an-layer-table">
        <thead><tr className="text-left text-slate-400"><th className="py-1 pr-3 font-semibold">{tx("Model")}</th>{LAYER_IDS.map((l) => <th key={l} className="px-1 text-center font-semibold" title={a.layers.names[l]}>{l}</th>)}</tr></thead>
        <tbody>{models.map(([m, ls]) => (
          <tr key={m} className="border-t border-slate-100 dark:border-slate-800">
            <td className="whitespace-nowrap py-1 pr-3 font-semibold text-slate-700 dark:text-slate-200">{m}</td>
            {LAYER_IDS.map((l) => {
              const c = ls[l];
              if (!c || c.applicable === 0) return <td key={l} className="px-0.5"><div className="h-7 w-14 rounded bg-slate-50 dark:bg-slate-800" title={tx("did not apply")} /></td>;
              const scored = c.pass_rate !== null;
              const cell = <span className="flex h-7 w-14 flex-col items-center justify-center rounded text-[10px] font-bold leading-tight text-slate-900/80" style={{ background: rate(c.pass_rate) }}>{scored ? pc(c.pass_rate) : "n/a"}<span className="text-[8px] font-normal">{c.applicable}</span></span>;
              return <td key={l} className="px-0.5">{c.failed > 0 ? <Link href={drill(a, { im: m, fl: l })} aria-label={`${m} ${l}: ${c.failed} failed`} title={`${a.layers.names[l]}: ${c.passed}/${c.passed + c.failed} passed, ${c.applicable} applied`} className="block hover:ring-2 hover:ring-sky-400 rounded">{cell}</Link> : <span title={`${a.layers.names[l]}: ${c.applicable} applied`}>{cell}</span>}</td>;
            })}
          </tr>))}</tbody>
      </table>
      <p className="mt-2 text-[10px] text-slate-400">{LAYER_IDS.map((l) => `${l} ${a.layers.names[l]}`).join(" · ")}. {tx("The small number is how many executions the layer applied to. Grey: it did not apply. n/a: applied but is a measurement (cost, latency), not a pass or fail.")}</p>
    </div>
  );
}

function AccuracyList({ a, kind }: { a: Analytics; kind: "specialists" | "tools" }) {
  const rows = Object.entries(a.routing[kind]).sort((x, y) => y[1].executions - x[1].executions);
  if (!rows.length) return <Empty text={tx("None recorded in this window.")} />;
  return (
    <table className="w-full text-[11px]" data-testid={`an-${kind}`}>
      <thead><tr className="text-left text-slate-400"><th className="py-1 font-semibold">{kind === "tools" ? tx("Tool") : tx("Specialist")}</th><th className="text-right font-semibold">{tx("Used")}</th><th className="text-right font-semibold">{tx("Trajectory checked")}</th><th className="text-right font-semibold">{tx("Correct")}</th></tr></thead>
      <tbody>{rows.map(([k, c]) => (
        <tr key={k} className="border-t border-slate-100 dark:border-slate-800">
          <td className="py-1"><Link className="font-semibold text-sky-700 hover:underline dark:text-sky-300" href={drill(a, kind === "tools" ? { tl: k } : { sp: k })}>{k}</Link></td>
          <td className="text-right text-slate-600 dark:text-slate-300">{c.executions}</td><td className="text-right text-slate-500">{c.l3_applied}</td>
          <td className="text-right font-semibold" style={{ color: c.accuracy === null ? undefined : c.accuracy >= 0.9 ? "#047857" : c.accuracy >= 0.7 ? "#b45309" : "#b91c1c" }}>{c.accuracy === null ? "—" : pc(c.accuracy)}</td>
        </tr>))}</tbody>
    </table>
  );
}

function Latency({ a }: { a: Analytics }) {
  const rows = Object.entries(a.latency).filter(([, l]) => l.n > 0);
  if (!rows.length) return <Empty text={tx("No latency was recorded.")} />;
  const top = Math.max(...rows.map(([, l]) => l.p95 ?? l.p50 ?? 0), 1);
  return (
    <ul className="space-y-2.5" data-testid="an-latency-list">{rows.map(([m, l]) => (
      <li key={m}>
        <div className="flex justify-between text-[11px]"><span className="font-semibold text-slate-700 dark:text-slate-200">{m}</span><span className="text-slate-500">{tx("avg")} {ms(l.mean)} · P50 {ms(l.p50)} · P95 {ms(l.p95)} · n={l.n}</span></div>
        <div className="relative mt-1 h-3 rounded-full bg-slate-100 dark:bg-slate-800"><div className="absolute inset-y-0 left-0 rounded-full bg-sky-200 dark:bg-sky-900" style={{ width: `${((l.p95 ?? 0) / top) * 100}%` }} /><div className="absolute inset-y-0 left-0 rounded-full bg-sky-500" style={{ width: `${((l.p50 ?? 0) / top) * 100}%` }} /></div>
      </li>))}
      <li className="text-[10px] text-slate-400">{tx("Dark bar: median. Light bar: 95th percentile (1 in 20 executions is slower).")}</li>
    </ul>
  );
}

function Reliability({ a }: { a: Analytics }) {
  const rows = Object.entries(a.reliability).filter(([, r]) => r.repeated_cases > 0);
  if (!rows.length) return <Empty text={tx("Reliability needs cases repeated at least twice; none were in this window.")} />;
  return (
    <table className="w-full text-[11px]" data-testid="an-reliability">
      <thead><tr className="text-left text-slate-400"><th className="py-1 font-semibold">{tx("Model")}</th><th className="text-right font-semibold">{tx("Repeated cases")}</th><th className="text-right font-semibold">{tx("Same verdict")}</th><th className="text-right font-semibold">{tx("Flaky")}</th><th className="text-right font-semibold">{tx("Always wrong")}</th></tr></thead>
      <tbody>{rows.map(([m, r]) => (
        <tr key={m} className="border-t border-slate-100 dark:border-slate-800"><td className="py-1 font-semibold text-slate-700 dark:text-slate-200">{m}</td><td className="text-right">{r.repeated_cases}</td><td className="text-right">{pc(r.decision_consistency)}</td>
          <td className="text-right" title={r.flaky_cases.join(", ")}>{r.flaky_cases.length}</td><td className="text-right">{r.consistently_wrong}</td></tr>))}</tbody>
    </table>
  );
}

function Drift({ a }: { a: Analytics }) {
  const weeks = a.drift.weeks;
  const top = Math.max(1, ...weeks.map((w) => w.total));
  if (!a.drift.total) return <Empty text={tx("No review item was opened in the last 12 weeks.")} />;
  return (
    <div>
      <div className="flex h-24 items-end gap-1" role="img" aria-label={tx("Review items opened per week")}>{weeks.map((w) => (
        <div key={w.start} className="flex min-w-0 flex-1 flex-col items-center justify-end" title={`${w.start}: ${w.total} (${Object.entries(w.by_kind).map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(", ") || "none"})`}>
          <span className="text-[9px] text-slate-400">{w.total || ""}</span>
          <div className="w-full rounded-t bg-amber-400" style={{ height: `${(w.total / top) * 100}%`, minHeight: w.total ? 3 : 0 }} />
        </div>))}</div>
      <div className="mt-1 flex justify-between text-[9px] text-slate-400"><span>{weeks[0]?.start}</span><span>{weeks[weeks.length - 1]?.start}</span></div>
      <p className="mt-1 text-[10px] text-slate-500">{a.drift.total} {tx("items in 12 weeks")}: {a.drift.kinds.map((k) => k.replace("_", " ")).join(", ")}. <Link className="text-sky-600 underline" href={studioHref({ tool: "drift" })}>{tx("Open the review queue")}</Link></p>
    </div>
  );
}

function Spend({ cost }: { cost: CostOverview | null }) {
  if (!cost) return <Empty text={tx("Loading…")} />;
  const c = cost.month.certainty;
  return (
    <div data-testid="an-spend-body">
      <p className="text-2xl font-bold text-slate-900 dark:text-slate-50">{show(cost.month.total_usd)} <span className="text-xs font-normal text-slate-500">{tx("this month")}</span></p>
      <p className="text-[11px] text-slate-500">{tx("Confirmed by a provider bill")} <b>{show(c.confirmed_usd)}</b> · {tx("estimated from tokens")} <b>{show(c.estimated_usd)}</b>{c.unknown_lines ? ` · ${c.unknown_lines} ${tx("lines could not be priced")}` : ""}</p>
      <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-semibold">
        <Link className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-700 hover:border-sky-400 dark:border-slate-600 dark:text-slate-200" href={studioHref({ tool: "costs" })}>{tx("Open costs & budgets")}</Link>
        <Link className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-700 hover:border-sky-400 dark:border-slate-600 dark:text-slate-200" href={studioHref({ mode: "investigate", sub: "compare" })}>{tx("Cost per success and accuracy against cost")}</Link>
      </div>
    </div>
  );
}

/** The figures, laid out. Pure: everything it shows is in `a`, so it can be rendered and checked without a browser. */
export function AnalyticsBody({ a, cost }: { a: Analytics; cost: CostOverview | null }) {
  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-2 [&>*]:min-w-0" data-testid="analytics-body">
      <Card id="outcomes" title={tx("Outcomes per model")} sub={tx("Click a segment to read those executions.")}><Outcomes a={a} /></Card>
      <Card id="coverage" title={tx("Coverage")} sub={tx("How many of the dataset's cases ran at least once in this window.")}><Coverage a={a} /></Card>
      <Card id="layers" title={tx("Evaluation layers")} sub={tx("Pass rate of each DeepEval layer, per model. Click a cell to read what failed.")}><Layers a={a} /></Card>
      <Card id="latency" title={tx("Latency")} sub={tx("Average, median (P50) and slow-end (P95) time to answer.")}><Latency a={a} /></Card>
      <Card id="routing" title={tx("Routing accuracy")} sub={tx("Share of trajectory-checked executions (L3) that went to the right specialist.")}><AccuracyList a={a} kind="specialists" /></Card>
      <Card id="tools" title={tx("Tool accuracy")} sub={tx("Share of trajectory-checked executions that called the right tools, by tool used.")}><AccuracyList a={a} kind="tools" /></Card>
      <Card id="reliability" title={tx("Repetition consistency")} sub={tx("Does the same case get the same verdict every time?")}><Reliability a={a} /></Card>
      <Card id="drift" title={tx("Drift and regressions")} sub={tx("Review items opened per week: rule, plan or template changes, proposals, coverage gaps.")}><Drift a={a} /></Card>
      <div className="xl:col-span-2"><Card id="spend" title={tx("Spend")} sub={tx("Money is recorded once, in USD, and shown in your chosen currency.")}><Spend cost={cost} /></Card></div>
    </div>
  );
}

/** The Investigate "Analytics" view: choose a window, a dataset and a model, then read where the system is strong and where it is not. */
export default function AnalyticsView() {
  const [days, setDays] = useQueryState("ad", "90");
  const [dataset, setDataset] = useQueryState("ads");
  const [model, setModel] = useQueryState("am");
  const [synth, setSynth] = useQueryState("asyn");
  const [a, setA] = useState<Analytics | null>(null);
  const [cost, setCost] = useState<CostOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getCostOverview().then(setCost).catch(() => undefined); }, []);
  useEffect(() => {
    setError(null);
    getAnalytics({ days: Number(days) || 90, dataset: dataset || undefined, model: model || undefined, include_synthetic: synth === "1" }).then(setA).catch((e) => setError(e instanceof Error ? e.message : "Could not load the analytics."));
  }, [days, dataset, model, synth]);
  return (
    <div className="space-y-3" data-testid="analytics-view">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex gap-1" role="group" aria-label={tx("Time window")}>{WINDOWS.map((d) => (
          <button key={d} type="button" aria-pressed={Number(days) === d} onClick={() => setDays(String(d))} className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${Number(days) === d ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300"}`}>{d === 365 ? tx("1 year") : `${d} ${tx("days")}`}</button>))}</div>
        <label className="text-[10px] text-slate-500">{tx("Dataset")}<select className={`${sel} block`} value={dataset} onChange={(e) => setDataset(e.target.value)}><option value="">{tx("all")}</option>{(a?.datasets ?? []).map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
        <label className="text-[10px] text-slate-500">{tx("Model")}<select className={`${sel} block`} value={model} onChange={(e) => setModel(e.target.value)}><option value="">{tx("all")}</option>{(a?.models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
        <label className="flex items-center gap-1.5 pb-1.5 text-[11px] text-slate-600 dark:text-slate-300"><input type="checkbox" checked={synth === "1"} onChange={(e) => setSynth(e.target.checked ? "1" : "")} />{tx("include scripted models")}</label>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!a && !error && <p className="py-12 text-center text-xs text-slate-400">{tx("Loading…")}</p>}
      {a && <p className="text-[11px] text-slate-500" data-testid="an-basis">{a.outcomes.total} {tx("executions in the last")} {a.window_days} {tx("days")}. {tx(a.note)}</p>}
      {a && <AnalyticsBody a={a} cost={cost} />}
    </div>
  );
}
