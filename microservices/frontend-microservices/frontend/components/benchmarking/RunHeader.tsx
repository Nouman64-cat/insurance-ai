"use client";

import { useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { modelColor, usd } from "@/lib/evalBenchmarks";
import { spendMeter, stateInfo, type StateTone } from "@/lib/runView";

const BADGE: Record<StateTone, string> = {
  good: "border-emerald-300 bg-emerald-50 text-emerald-800", active: "border-blue-300 bg-blue-50 text-blue-800", wait: "border-amber-300 bg-amber-50 text-amber-800",
  bad: "border-red-300 bg-red-50 text-red-700", stopped: "border-slate-300 bg-slate-100 text-slate-700",
};
const BAR: Record<StateTone, string> = { good: "bg-emerald-500", active: "bg-blue-500", wait: "bg-amber-400", bad: "bg-red-500", stopped: "bg-slate-400" };
const chip = "inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300";
const btn = "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-sky-400 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200";

/** The top of the Watch page: what is running and how it stands, with the actions that make sense for its state. Drawn from plain values, so it can be checked on its own. */
export default function RunHeader({ state, cancelRequested, dataset, version, mode, repeat, models, jobId, spent, estimate, budget, running, busy, canOpenResults, onCancel, onRerun, onOpenResults, onOpenMap }: {
  state: string; cancelRequested: boolean; dataset: string; version: string; mode: "direct" | "agent"; repeat: string; models: string[]; jobId: string;
  spent: number; estimate: number | null; budget: number | null; running: boolean; busy: boolean; canOpenResults: boolean;
  onCancel: () => void; onRerun: () => void; onOpenResults: () => void; onOpenMap?: () => void;
}) {
  const info = stateInfo(state, cancelRequested);
  const m = spendMeter(spent, estimate, budget);
  const [copied, setCopied] = useState(false);
  const copy = () => { try { navigator.clipboard.writeText(jobId).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined); } catch { /* the id stays visible to copy by hand */ } };
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 dark:border-slate-700 dark:bg-slate-900" aria-label={tx("Run status")} data-testid="run-header">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
        <div className="min-w-0 flex-1 basis-[22rem]">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-extrabold ${BADGE[info.tone]}`} title={tx(info.hint)} data-testid="job-state" data-tone={info.tone}>
              <span className={info.tone === "active" ? "animate-pulse motion-reduce:animate-none" : ""} aria-hidden>{info.icon}</span>{tx(info.label)}
            </span>
            <h2 className="min-w-0 break-words text-base font-extrabold text-slate-900 dark:text-slate-50">{dataset} <span className="font-semibold text-slate-500">{version}</span></h2>
            <span className={chip}>{mode === "direct" ? tx("Direct") : tx("Agent")}</span>
            <span className={chip}>×{repeat} {tx("repetitions")}</span>
          </div>
          <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={tx("Models in this run")}>
            {models.map((l) => <li key={l} className={`${chip} gap-1.5`}><span className="h-2 w-2 rounded-sm" style={{ background: modelColor(l, models) }} aria-hidden />{l}</li>)}
          </ul>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            <span>{tx("Job")}</span><code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 break-all dark:bg-slate-800 dark:text-slate-300">{jobId}</code>
            <button type="button" onClick={copy} className="font-semibold text-blue-700 hover:underline dark:text-sky-300">{copied ? tx("Copied") : tx("Copy")}</button>
          </p>
        </div>

        <div className="w-full shrink-0 sm:w-72" data-testid="spend-meter">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="font-semibold text-slate-500">{tx("Spent")}</span>
            <span><b className="text-base font-extrabold text-slate-900 dark:text-slate-50" data-testid="spent">{usd(spent)}</b>{estimate !== null && <span className="text-slate-500"> {tx("of an estimated")} {usd(estimate)}</span>}</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" role="progressbar" aria-label={tx("Share of the estimate spent")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(m.pctOfEstimate ?? 0)}>
            <div className={`h-full rounded-full transition-all ${m.nearBudget || m.overEstimate ? "bg-amber-500" : BAR[info.tone]}`} style={{ width: `${m.pctOfEstimate ?? (spent > 0 ? 8 : 0)}%` }} />
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">
            {budget !== null ? <>{tx("Budget")} <b>{usd(budget)}</b>{m.nearBudget ? <span className="ml-1 font-semibold text-amber-700"> · {tx("close to the limit")}</span> : null}</> : tx("No budget set for this run")}
            {m.overEstimate ? <span className="ml-1 font-semibold text-amber-700"> · {tx("above the estimate")}</span> : null}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:ml-auto" role="group" aria-label={tx("Run actions")}>
          {canOpenResults && <button type="button" onClick={onOpenResults} data-testid="open-results" className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-bold text-white hover:bg-blue-700">{tx("Open results")}</button>}
          {onOpenMap && <button type="button" onClick={onOpenMap} className={btn} data-testid="open-map">{tx("Ecosystem map")}</button>}
          {!running && <button type="button" onClick={onRerun} disabled={busy} className={btn} data-testid="rerun">{tx("Rerun")}</button>}
          {running && <button type="button" onClick={onCancel} disabled={busy || cancelRequested} className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40" data-testid="cancel">{cancelRequested ? tx("Cancelling…") : tx("Cancel")}</button>}
        </div>
      </div>
    </section>
  );
}
