"use client";

import { useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { pct } from "@/lib/evalBenchmarks";
import { getRunDetail, getRunReport, type RunDetail } from "@/lib/evalStudio";

const fmt = (v: number | string | null) => (v === null ? "—" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : v);

/** One run in a card: how well it did with the range that evidence allows, the cases that flip between repetitions, and whether it passed its quality gate. Pure: all of it is in `run`. */
export function RunSummaryBody({ run, report, onReport }: { run: RunDetail; report?: string | null; onReport?: () => void }) {
  const rel = run.reliability;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900" data-testid="run-summary" aria-label={`${tx("Run")} ${run.run_id}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-mono text-xs font-bold text-slate-900 dark:text-slate-50">{run.run_id}</h3>
        <span className="text-[11px] text-slate-500">{run.model ?? tx("no model")} · {run.dataset} {run.version} · ×{run.repetitions}{run.synthetic ? ` · ${tx("scripted")}` : ""}</span>
        {run.gate && <span className={`ml-auto rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${run.gate.passed ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`} data-testid="gate-verdict">{tx("Quality gate")}: {run.gate.passed ? tx("passed") : tx("failed")}</span>}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] sm:grid-cols-4">
        <div><dt className="text-slate-400">{tx("Pass rate")}</dt><dd className="text-lg font-bold text-slate-900 dark:text-slate-50" data-testid="run-pass-rate">{pct(rel?.pass_rate ?? run.pass_rate, 1)}</dd>{rel && rel.ci_low !== null && rel.ci_high !== null && <dd className="text-slate-500">95% {pct(rel.ci_low)}–{pct(rel.ci_high)}</dd>}</div>
        <div><dt className="text-slate-400">{tx("Ran")}</dt><dd className="font-semibold text-slate-800 dark:text-slate-100">{run.passed} {tx("passed")}, {run.failed} {tx("failed")}</dd><dd className="text-slate-500">{rel ? `${rel.ran} ${tx("of")} ${run.executions} ${tx("gave a verdict")}` : ""}</dd></div>
        <div><dt className="text-slate-400">{tx("Repeated cases")}</dt><dd className="font-semibold text-slate-800 dark:text-slate-100">{rel ? rel.repeated_cases : "—"}</dd><dd className="text-slate-500">{rel && rel.repeated_cases === 0 ? tx("every case ran once, so reliability cannot be judged") : ""}</dd></div>
        <div><dt className="text-slate-400">{tx("Flaky / always wrong")}</dt><dd className="font-semibold text-slate-800 dark:text-slate-100" data-testid="run-flaky">{rel ? `${rel.flaky_cases.length} / ${rel.consistently_wrong_cases?.length ?? 0}` : "—"}</dd><dd className="truncate text-slate-500" title={rel?.flaky_cases.join(", ")}>{rel?.flaky_cases.slice(0, 4).join(", ")}</dd></div>
      </dl>
      {run.gate && (
        <ul className="mt-3 space-y-0.5 text-[11px]" data-testid="gate-checks">{run.gate.checks.map((c) => (
          <li key={c.name} className="flex gap-2"><span className={`inline-block w-10 font-bold ${c.ok ? "text-emerald-600" : "text-red-600"}`}>{c.ok ? tx("met") : tx("missed")}</span>
            <span className="text-slate-700 dark:text-slate-200">{c.name.replace(/_/g, " ")}: {fmt(c.value)} <span className="text-slate-400">({tx("required")} {fmt(c.threshold)})</span>{c.detail ? <span className="text-slate-400"> · {c.detail}</span> : null}</span></li>))}
        </ul>
      )}
      {!run.gate && <p className="mt-3 text-[10px] text-slate-400">{tx("No quality gate was applied to this run.")}</p>}
      {run.stop_reason && <p className="mt-2 text-[11px] text-amber-700">{tx("The run stopped early")}: {run.stop_reason}</p>}
      {onReport && <div className="mt-3"><button type="button" onClick={onReport} className="text-[11px] font-semibold text-sky-700 underline dark:text-sky-300">{report ? tx("Hide the report") : tx("Read the run's report")}</button></div>}
      {report && <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-slate-50 p-3 text-[10px] leading-snug text-slate-700 dark:bg-slate-800 dark:text-slate-200" data-testid="run-report">{report}</pre>}
    </section>
  );
}

export default function RunSummary({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setRun(null); setReport(null); setError(null); getRunDetail(runId).then(setRun).catch((e) => setError(e instanceof Error ? e.message : "Could not load the run.")); }, [runId]);
  if (error) return <p className="text-xs text-red-600">{error}</p>;
  if (!run) return <p className="text-xs text-slate-400">{tx("Loading…")}</p>;
  return <RunSummaryBody run={run} report={report} onReport={() => (report ? setReport(null) : getRunReport(runId).then(setReport).catch(() => setReport(tx("The report could not be read."))))} />;
}
