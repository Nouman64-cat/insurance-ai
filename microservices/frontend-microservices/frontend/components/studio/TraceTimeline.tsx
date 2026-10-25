"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { ms, usd, type ResultDetail } from "@/lib/evalBenchmarks";
import { traceSteps, type TraceStep } from "@/lib/evalStudio";

const LANE: Record<TraceStep["lane"], { label: string; dot: string; bar: string }> = {
  user: { label: "User", dot: "bg-blue-500", bar: "border-blue-300 bg-blue-50 dark:bg-blue-950/40 dark:border-blue-800" },
  agent: { label: "Agent", dot: "bg-slate-500", bar: "border-slate-300 bg-slate-50 dark:bg-slate-800 dark:border-slate-600" },
  tool: { label: "Tool call", dot: "bg-amber-500", bar: "border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800" },
  result: { label: "Tool result", dot: "bg-emerald-500", bar: "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-800" },
  usage: { label: "Model usage", dot: "bg-cyan-500", bar: "border-cyan-300 bg-cyan-50 dark:bg-cyan-950/40 dark:border-cyan-800" },
};

/** A stored trace as a timeline you can play: the steps in the order they happened, which lane each belongs to, the whole turn's latency where the trace has it, and what the model used. Play steps
 *  through them; the buttons step by hand (the only way when the person asks for reduced motion). Per-step timings are not recorded, and the panel says so. */
export default function TraceTimeline({ r }: { r: ResultDetail }) {
  const steps = useMemo(() => traceSteps(r), [r]);
  const [at, setAt] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const ref = useRef<HTMLOListElement | null>(null);
  const reduced = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setAt((i) => { if (i + 1 >= steps.length) { setPlaying(false); return i; } return i + 1; }), 900 / speed);
    return () => clearInterval(t);
  }, [playing, speed, steps.length]);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[data-current="true"]')?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" }); }, [at, reduced]);
  const timed = steps.filter((s) => typeof s.ms === "number");
  const totalMs = timed.reduce((a, s) => a + (s.ms as number), 0);
  if (steps.length <= 1) return <p className="text-[11px] text-slate-400" data-testid="timeline-empty">{tx("No trace was stored for this execution (a function-level check has none).")}</p>;
  return (
    <section data-testid="trace-timeline" aria-label={tx("Execution timeline")}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-bold text-slate-900 dark:text-slate-50">{tx("Replay")}</h3>
        <button type="button" onClick={() => { if (at >= steps.length - 1) setAt(-1); setPlaying((p) => !p); }} className="rounded-lg bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white" data-testid="tl-play">{playing ? tx("Pause") : tx("Play")}</button>
        <button type="button" onClick={() => { setPlaying(false); setAt((i) => Math.max(-1, i - 1)); }} className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] dark:border-slate-600" aria-label={tx("Previous step")}>‹</button>
        <button type="button" onClick={() => { setPlaying(false); setAt((i) => Math.min(steps.length - 1, i + 1)); }} className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] dark:border-slate-600" aria-label={tx("Next step")} data-testid="tl-next">›</button>
        <label className="text-[10px] text-slate-500">{tx("speed")} <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="rounded border border-slate-200 bg-white px-1 py-0.5 dark:border-slate-600 dark:bg-slate-800"><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></select></label>
        <span className="ml-auto text-[10px] text-slate-400">{Math.max(at + 1, 0)} / {steps.length}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">{(Object.keys(LANE) as TraceStep["lane"][]).filter((l) => steps.some((s) => s.lane === l)).map((l) => <span key={l} className="inline-flex items-center gap-1"><span className={`inline-block h-2 w-2 rounded-full ${LANE[l].dot}`} />{tx(LANE[l].label)}</span>)}</div>
      {totalMs > 0 && (
        <div className="mt-2" aria-label={tx("Where the time went")}>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">{timed.map((s) => <div key={s.index} className={`${LANE[s.lane].dot} ${at >= s.index ? "opacity-100" : "opacity-40"}`} style={{ width: `${((s.ms as number) / totalMs) * 100}%` }} title={`${s.title}: ${ms(s.ms)}`} />)}</div>
          <p className="mt-0.5 text-[10px] text-slate-400">{tx("Agent turns")}: {timed.map((s) => ms(s.ms)).join(" · ")} · {tx("whole execution")} {ms(r.latency_ms)}</p>
        </div>
      )}
      <ol ref={ref} className="mt-3 space-y-1.5 max-h-80 overflow-y-auto pr-1">
        {steps.map((s) => {
          const current = at === s.index, seen = at >= s.index;
          return (
            <li key={s.index} data-current={current} className={`rounded-lg border px-2.5 py-1.5 text-[11px] transition-opacity ${LANE[s.lane].bar} ${seen || at === -1 ? "opacity-100" : "opacity-40"} ${current ? "ring-2 ring-sky-400" : ""}`}>
              <button type="button" className="flex w-full items-center gap-1.5 text-left" onClick={() => { setPlaying(false); setAt(s.index); }} aria-label={`${tx("Go to step")} ${s.index + 1}`}>
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${LANE[s.lane].dot}`} /><b className="text-slate-800 dark:text-slate-100">{s.title}</b>{typeof s.ms === "number" && <span className="ml-auto text-slate-400">{ms(s.ms)}</span>}
              </button>
              {s.text && <p className="mt-1 whitespace-pre-wrap break-words text-slate-700 dark:text-slate-200">{s.text}</p>}
              {s.detail !== undefined && s.detail !== null && (current || at === -1) && <pre className="mt-1 max-h-40 overflow-auto rounded bg-white/70 p-1.5 text-[10px] dark:bg-slate-900/60">{JSON.stringify(s.detail, null, 1)}</pre>}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-[10px] text-slate-400">{tx("Per-tool timings are not recorded: only each agent turn's latency (when the trace has it) and the execution's totals are.")} {r.input_tokens !== null ? `${tx("Cost")}: ${usd(r.cost_usd)} + ${tx("judge")} ${usd(r.judge_cost_usd)}.` : ""}</p>
    </section>
  );
}
