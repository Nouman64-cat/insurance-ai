"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { tx } from "@/lib/i18n/tx";
import TraceTimeline from "@/components/studio/TraceTimeline";
import { getResult, ms, tokens, usd, type ResultDetail } from "@/lib/evalBenchmarks";

interface TraceMessage { id?: string; type: string; content?: string; tool_calls?: { name: string; args?: unknown }[]; name?: string; result?: unknown }
interface TraceTurn { index: number; message: string; reply?: string }

const STATUS_STYLE: Record<string, string> = {
  passed: "bg-emerald-50 text-emerald-700 border-emerald-200", failed: "bg-red-50 text-red-600 border-red-200",
  error: "bg-red-50 text-red-600 border-red-200", scored: "bg-slate-50 text-slate-600 border-slate-200",
};

function Json({ value }: { value: unknown }) {
  return <pre className="mt-1 text-[10px] bg-slate-50 border border-slate-100 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(value, null, 1)}</pre>;
}

export default function TraceDrawer({ resultId, onClose }: { resultId: string; onClose: () => void }) {
  const [r, setR] = useState<ResultDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setR(null);
    setError(null);
    getResult(resultId).then(setR).catch((e) => setError(e instanceof Error ? e.message : "Could not load this execution."));
  }, [resultId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trace = (r?.trace ?? null) as { thread_id?: string; turns?: TraceTurn[]; messages?: TraceMessage[] } | null;

  // Drawn straight into <body>, above the portal's own fixed bars, so no parent's layout, clipping or stacking can hide it.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[300] flex justify-end bg-slate-900/40" onClick={onClose} data-testid="trace-drawer">
      <aside role="dialog" aria-modal="true" aria-label={tx("Execution trace")} className="h-full w-full max-w-2xl overflow-y-auto bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-3">
          <h2 className="text-sm font-bold text-slate-900">{r ? `${r.case} · ${r.model ?? ""} · r${r.repetition}` : tx("Execution trace")}</h2>
          <button type="button" onClick={onClose} aria-label={tx("Close")} className="text-slate-400 hover:text-slate-700 text-lg leading-none">×</button>
        </div>
        <div className="p-5 space-y-5">
          {error && <div className="text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600">{error}</div>}
          {!r && !error && <p className="text-xs text-slate-400">{tx("Loading…")}</p>}
          {r && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className={`px-2 py-0.5 rounded border font-bold ${STATUS_STYLE[r.status] ?? STATUS_STYLE.scored}`}>{r.status}</span>
                {r.critical_failed && <span className="px-2 py-0.5 rounded border font-bold bg-red-600 text-white border-red-600">{tx("critical failure")}</span>}
                {r.reason && <span className="text-slate-500">{r.reason}</span>}
                <span className="text-slate-400">·</span>
                <span>{ms(r.latency_ms)}</span><span>{tokens(r.input_tokens)} {tx("in")} / {tokens(r.output_tokens)} {tx("out")}</span>
                <span>{tx("inference")} {usd(r.cost_usd)}</span><span>{tx("judge")} {usd(r.judge_cost_usd)}</span>
              </div>
              {Object.keys(r.layers ?? {}).length > 0 && (
                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  {Object.entries(r.layers).map(([layer, st]) => <span key={layer} className={`px-1.5 py-0.5 rounded border ${STATUS_STYLE[st ?? ""] ?? STATUS_STYLE.scored}`}>{layer} {st}</span>)}
                </div>
              )}

              <section>
                <h3 className="text-xs font-bold text-slate-900">{tx("The model's answer")}</h3>
                <p className="mt-1 text-sm text-slate-700 whitespace-pre-wrap break-words bg-slate-50 border border-slate-100 rounded-lg p-3" data-testid="response-text">{r.response_text ?? tx("No answer was recorded (the execution did not reach the model).")}</p>
              </section>

              <section>
                <h3 className="text-xs font-bold text-slate-900">{tx("Expected versus actual")} <span className="font-normal text-slate-400">({r.assertion_results.length} {tx("checks")})</span></h3>
                <table className="mt-1 w-full text-[11px]">
                  <tbody>
                    {r.assertion_results.map((a) => (
                      <tr key={a.id} className="border-t border-slate-100 align-top">
                        <td className="py-1.5 pr-2 whitespace-nowrap"><span className={`px-1.5 py-0.5 rounded border font-semibold ${STATUS_STYLE[a.status] ?? STATUS_STYLE.scored}`}>{a.status}</span></td>
                        <td className="py-1.5 text-slate-700">
                          <b>{a.id}</b> {a.kind} <span className="text-slate-400">{a.target}</span> <span className="text-[10px] uppercase text-slate-400">{a.severity}</span>
                          {a.status !== "passed" && (<>
                            {a.message && <p className="text-red-600">{a.message}</p>}
                            <details><summary className="cursor-pointer text-slate-400">{tx("expected / actual")}</summary><Json value={{ expected: a.expected, actual: a.actual }} /></details>
                          </>)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              {r.judge_scores.length > 0 && (
                <section>
                  <h3 className="text-xs font-bold text-slate-900">{tx("Judge scores")}</h3>
                  <ul className="mt-1 space-y-2">
                    {r.judge_scores.map((m, i) => (
                      <li key={i} className="text-[11px] border border-slate-100 rounded-lg p-2">
                        <div className="flex flex-wrap gap-2 items-center">
                          <b className="text-slate-800">{m.metric.replace("_", " ")}</b>
                          <span className={`px-1.5 rounded border font-semibold ${m.passed ? STATUS_STYLE.passed : m.passed === false ? STATUS_STYLE.failed : STATUS_STYLE.scored}`}>{m.score === null ? m.status : `${m.score.toFixed(2)} / ${m.threshold?.toFixed(2) ?? "—"}`}</span>
                          <span className="text-slate-400">{m.judge_model}</span>
                        </div>
                        {m.reason && <p className="mt-1 text-slate-600">{m.reason}</p>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <TraceTimeline r={r} />

              {trace && (
                <section>
                  <h3 className="text-xs font-bold text-slate-900">{tx("Trace")} {trace.thread_id && <span className="font-normal text-slate-400">{trace.thread_id}</span>}</h3>
                  {trace.turns && trace.turns.length > 0 && (
                    <ol className="mt-1 space-y-2">
                      {trace.turns.map((t) => (
                        <li key={t.index} className="text-[11px]">
                          <p className="bg-blue-50 border border-blue-100 rounded-lg px-2 py-1 text-blue-900"><b>{tx("User")} {t.index}:</b> {t.message}</p>
                          {t.reply && <p className="mt-1 bg-slate-50 border border-slate-100 rounded-lg px-2 py-1 text-slate-700 whitespace-pre-wrap"><b>{tx("Agent")}:</b> {t.reply}</p>}
                        </li>
                      ))}
                    </ol>
                  )}
                  {trace.messages && trace.messages.length > 0 && (
                    <details className="mt-2" open={!trace.turns?.length}>
                      <summary className="cursor-pointer text-[11px] text-slate-500">{trace.messages.length} {tx("messages and tool calls")}</summary>
                      <ol className="mt-1 space-y-1">
                        {trace.messages.map((m, i) => (
                          <li key={m.id ?? i} className="text-[11px] border-l-2 border-slate-200 pl-2">
                            <span className="font-semibold text-slate-500">{m.type}{m.name ? ` · ${m.name}` : ""}</span>
                            {m.content ? <p className="text-slate-700 whitespace-pre-wrap break-words">{m.content}</p> : null}
                            {m.tool_calls?.map((tc, j) => <div key={j}><b className="text-blue-700">→ {tc.name}</b><Json value={tc.args} /></div>)}
                            {m.result !== undefined && m.result !== null && <details><summary className="cursor-pointer text-slate-400">{tx("result")}</summary><Json value={m.result} /></details>}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
