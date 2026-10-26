"use client";

import Link from "next/link";
import { tx } from "@/lib/i18n/tx";
import { PROVIDER_NAME, modelColor, pct, providerOf, usd } from "@/lib/evalBenchmarks";
import { judgeView, type JudgeView, type Tone } from "@/lib/judgeView";
import { studioHref } from "@/lib/evalStudio";

const TONE: Record<Tone, string> = {
  good: "border-emerald-300 bg-emerald-50 text-emerald-800", warn: "border-amber-300 bg-amber-50 text-amber-800", bad: "border-red-300 bg-red-50 text-red-700", unknown: "border-slate-300 bg-slate-100 text-slate-600",
};
const GLYPH: Record<Tone, string> = { good: "✓", warn: "!", bad: "✕", unknown: "?" };
const scoreTone = (v: number) => (v >= 0.8 ? "bg-emerald-500" : v >= 0.6 ? "bg-amber-400" : "bg-red-500");

/** The judge's part of a benchmark, drawn from a view-model so every state can be checked on its own. */
export function JudgeBody({ v, labels, allLabels, runs }: { v: JudgeView; labels: string[]; allLabels: string[]; runs: { run_id: string; model: string }[] }) {
  const show = v.models.filter((m) => labels.includes(m.label));
  return (
    <section className="w-full rounded-xl border border-slate-300 bg-white shadow-sm dark:border-slate-600 dark:bg-slate-900" aria-label={tx("Judge results")} data-testid="judge-panel" data-state={v.state}>
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <h3 className="mr-auto text-base font-extrabold text-slate-900 dark:text-slate-50">{tx("Judge results")}</h3>
        {v.judge && <span className="text-xs text-slate-500">{tx("Judge")}: <b className="font-extrabold text-slate-900 dark:text-slate-50" data-testid="judge-name">{v.judge}</b> <span className="text-slate-400">({v.scriptedJudge ? tx("scripted stand-in") : PROVIDER_NAME[providerOf(v.judge)] ?? providerOf(v.judge)})</span></span>}
        {v.calibration && (
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${TONE[v.calibration.tone]}`} title={tx(v.calibration.detail)} data-testid="judge-calibration" data-tone={v.calibration.tone}>
            <span aria-hidden>{GLYPH[v.calibration.tone]}</span>{tx(v.calibration.title)}{v.calibration.agreement !== null ? ` · ${pct(v.calibration.agreement)} ${tx("agreement")}` : ""}
          </span>
        )}
      </header>

      <div className="space-y-3 px-4 py-4">
        {v.state === "none" && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300" role="note" data-testid="judge-none">
            <b className="text-slate-800 dark:text-slate-100">{tx("No judge was used in this benchmark.")}</b>
            <p className="mt-1">{tx("Only the rule-based checks were applied: which tools were called, what changed in the data, and exact text. Qualities that need a judge, such as correctness, relevance and safety of the wording, were not measured. Choose a judge when you set up a run to measure them.")}</p>
          </div>
        )}

        {v.verdict && (
          <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${v.verdict.kind === "winner" ? "border-emerald-300 bg-emerald-50 text-emerald-900" : v.verdict.kind === "tie" ? "border-slate-300 bg-slate-50 text-slate-800" : "border-amber-300 bg-amber-50 text-amber-900"}`} role="status" data-testid="judge-verdict" data-kind={v.verdict.kind}>
            <span className="mt-0.5 text-base font-extrabold" aria-hidden>{v.verdict.kind === "winner" ? "★" : v.verdict.kind === "tie" ? "=" : "!"}</span>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">{tx("Who won on the judge's scores?")}</p>
              <p className="text-sm font-extrabold">{tx(v.verdict.title)}</p>
              <p className="mt-0.5 text-xs leading-relaxed">{tx(v.verdict.detail)}</p>
            </div>
          </div>
        )}

        {v.notes.map((n) => <p key={n} className={`rounded-lg border px-3 py-2 text-xs ${v.state === "unscored" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-600"}`} role={v.state === "unscored" ? "alert" : "note"}>{tx(n)}</p>)}

        {v.state === "scored" && (
          <>
            <div className="overflow-x-auto" role="region" aria-label={tx("Judge scores by metric")} tabIndex={0}>
              <table className="w-full border-collapse text-[13px]" data-testid="judge-table">
                <caption className="sr-only">{tx("The judge's mean score from 0 to 1 for each metric and model, with how many answers it scored. A check marks the best of the real models.")}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="w-44 border border-slate-300 bg-slate-100 px-3 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300">{tx("Metric")}</th>
                    {show.map((m) => (
                      <th key={m.label} scope="col" className={`min-w-[8rem] border border-slate-300 bg-slate-100 px-3 py-2.5 text-center dark:border-slate-600 dark:bg-slate-800 ${m.synthetic ? "opacity-60" : ""}`} data-model={m.label}>
                        <span className="flex items-center justify-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: modelColor(m.label, allLabels) }} aria-hidden /><b className="text-sm font-extrabold text-slate-900 dark:text-slate-50">{m.label.split("/")[1] ?? m.label}</b></span>
                        <span className="block text-[10px] font-semibold text-slate-500">{m.synthetic ? tx("scripted stand-in") : PROVIDER_NAME[providerOf(m.label)] ?? providerOf(m.label)}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {v.rows.map((r) => (
                    <tr key={r.metric} data-metric={r.metric}>
                      <th scope="row" className="border border-slate-300 bg-white px-3 py-2.5 text-left font-bold capitalize text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100">{r.label}</th>
                      {show.map((m) => {
                        const c = r.cells[m.label];
                        return (
                          <td key={m.label} data-best={c.best ? "true" : undefined} className={`border border-slate-300 px-3 py-2.5 text-center align-middle dark:border-slate-600 ${c.best ? "bg-emerald-50 dark:bg-emerald-950/25" : ""} ${m.synthetic ? "opacity-60" : ""}`}>
                            {c.mean === null ? <span className="font-semibold text-slate-400" title={tx("The judge did not score this model on this metric")}>{tx("not scored")}</span> : (
                              <>
                                <span className={`${c.best ? "font-extrabold text-emerald-800 dark:text-emerald-200" : "font-bold text-slate-900 dark:text-slate-100"}`}>{c.mean.toFixed(2)}</span>
                                {c.best && <><span className="ml-1 text-[11px] font-bold text-emerald-600" aria-hidden>✓</span><span className="sr-only">best</span></>}
                                <span className="mx-auto mt-1 block h-1.5 w-full max-w-[7rem] overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" aria-hidden><span className={`block h-full rounded-full ${scoreTone(c.mean)}`} style={{ width: `${Math.round(c.mean * 100)}%` }} /></span>
                                <span className="mt-0.5 block text-[10px] font-semibold text-slate-500">{c.met} {tx("of")} {c.n} {tx("met the threshold")}</span>
                              </>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr className="bg-slate-50 dark:bg-slate-800/50" data-metric="__average">
                    <th scope="row" className="border border-slate-300 px-3 py-2.5 text-left font-extrabold text-slate-900 dark:border-slate-600 dark:text-slate-50">{tx("Average of the metrics")}</th>
                    {show.map((m) => <td key={m.label} className={`border border-slate-300 px-3 py-2.5 text-center font-extrabold text-slate-900 dark:border-slate-600 dark:text-slate-50 ${m.synthetic ? "opacity-60" : ""}`}>{m.overall === null ? <span className="font-semibold text-slate-400">—</span> : m.overall.toFixed(2)}</td>)}
                  </tr>
                  <tr data-metric="__cost">
                    <th scope="row" className="border border-slate-300 px-3 py-2.5 text-left font-bold text-slate-800 dark:border-slate-600 dark:text-slate-100">{tx("Cost of judging")}</th>
                    {show.map((m) => <td key={m.label} className={`border border-slate-300 px-3 py-2.5 text-center font-bold text-slate-900 dark:border-slate-600 dark:text-slate-100 ${m.synthetic ? "opacity-60" : ""}`}>{usd(m.costUsd)}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-500">
              <span>{tx("Scores run from 0 (fails the criterion) to 1 (meets it fully). A ✓ marks the best of the real models; scripted models never count.")}</span>
              {v.totalCostUsd !== null && <span className="font-semibold">{tx("Judging cost")} {usd(v.totalCostUsd)} {tx("in total")}</span>}
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/50">
              <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200">{tx("Read the judge's reasons")}</p>
              <p className="text-[11px] text-slate-500">{tx("Each judged answer has the judge's written reason. Open the answers the judge failed:")}</p>
              <ul className="mt-1.5 flex flex-wrap gap-2">
                {show.filter((m) => m.scored).map((m) => {
                  const run = runs.find((r) => r.model === m.label);
                  return run ? <li key={m.label}><Link className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:border-sky-400 dark:border-slate-600 dark:bg-slate-900 dark:text-sky-300" href={studioHref({ mode: "investigate", extra: { ir: run.run_id, fl: "L2", isyn: "1" } })} data-testid="judge-reasons-link">{m.label.split("/")[1] ?? m.label}</Link></li> : null;
                })}
              </ul>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export default function JudgePanel({ bench, labels, allLabels }: { bench: Parameters<typeof judgeView>[0] & { runs: { run_id: string; model: string }[] }; labels: string[]; allLabels: string[] }) {
  return <JudgeBody v={judgeView(bench)} labels={labels} allLabels={allLabels} runs={bench.runs ?? []} />;
}
