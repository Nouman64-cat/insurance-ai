"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { tx } from "@/lib/i18n/tx";
import RunHeader from "./RunHeader";
import RunStepper from "./RunStepper";
import { visibleEvents } from "@/lib/runView";
import { cancelJob, getJob, modelColor, ms, pct, rerunJob, runsOfJob, streamJob, usd, type Job, type JobEvent } from "@/lib/evalBenchmarks";

const TERMINAL = ["succeeded", "failed", "cancelled", "lost"];
const btnPrimary = "px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-all";
const btnGhost = "px-3 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 disabled:opacity-40 transition-all";
const btnDanger = "px-3 py-2 text-xs font-semibold text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-40 transition-all";

interface ModelProgress { model: string; done: number; planned: number | null; passed: number; failed: number; other: number; critical: number; latency: number[]; spent: number; inTok: number; outTok: number }
interface Answer { key: string; model: string; case_id: string; status: string; reply: string | null; latency: number | null; stage: string | null; at: string }

export default function LiveRun({ job: initial, onJob, onOpenResults, onOpenMap }: { job: Job; onJob: (job: Job) => void; onOpenResults: (benchmarkId: string) => void; onOpenMap?: () => void }) {
  const [job, setJob] = useState<Job>(initial);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [progress, setProgress] = useState<Record<string, ModelProgress>>({});
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [benchmarkId, setBenchmarkId] = useState<string | null>(null);
  const [resultsChecked, setResultsChecked] = useState(false);
  const [recheck, setRecheck] = useState(0);
  const [showDetail, setShowDetail] = useState(false);
  const [streamNote, setStreamNote] = useState<string | null>(null);
  const seen = useRef<Set<number>>(new Set());
  const running = !TERMINAL.includes(job.state);

  const absorb = useCallback((e: JobEvent) => {
    if (seen.current.has(e.seq)) return;
    seen.current.add(e.seq);
    setEvents((list) => [...list.slice(-199), e]);
    const d = e.data as Record<string, unknown>;
    const model = typeof d.model === "string" ? d.model : null;
    if (e.kind === "case" && model) {
      setProgress((p) => {
        const cur = p[model] ?? { model, done: 0, planned: null, passed: 0, failed: 0, other: 0, critical: 0, latency: [], spent: 0, inTok: 0, outTok: 0 };
        const status = String(d.status);
        return {
          ...p,
          [model]: {
            ...cur, done: cur.done + 1, passed: cur.passed + (status === "passed" ? 1 : 0), failed: cur.failed + (status === "failed" ? 1 : 0),
            other: cur.other + (status === "passed" || status === "failed" ? 0 : 1), critical: cur.critical + (d.critical_failed ? 1 : 0),
            latency: typeof d.latency_ms === "number" ? [...cur.latency, d.latency_ms] : cur.latency, spent: cur.spent + (typeof d.cost_usd === "number" ? d.cost_usd : 0),
            inTok: cur.inTok + (typeof d.input_tokens === "number" ? d.input_tokens : 0), outTok: cur.outTok + (typeof d.output_tokens === "number" ? d.output_tokens : 0),
          },
        };
      });
      if (typeof d.reply === "string" || String(d.status) !== "skipped") {
        setAnswers((a) => [{ key: `${e.seq}`, model, case_id: String(d.case_id), status: String(d.status), reply: typeof d.reply === "string" ? d.reply : null,
          latency: typeof d.latency_ms === "number" ? d.latency_ms : null, stage: typeof d.stage === "string" ? d.stage : null, at: e.at }, ...a].slice(0, 30));
      }
    }
    if (e.kind === "progress" && model && typeof d.planned === "number") {
      setProgress((p) => (p[model] ? { ...p, [model]: { ...p[model], planned: d.planned as number } } : p));
    }
  }, []);

  // Follow the job: the event stream for detail, a slow poll for the state (and as the fallback if the stream is blocked).
  useEffect(() => {
    const ctl = new AbortController();
    seen.current = new Set();
    setEvents([]); setProgress({}); setAnswers([]); setBenchmarkId(null); setResultsChecked(false); setJob(initial);
    streamJob(initial.id, { onEvent: absorb, onEnd: () => undefined, onError: (m) => setStreamNote(m) }, ctl.signal).catch(() => undefined);
    return () => ctl.abort();
  }, [initial.id, absorb]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const fresh = await getJob(initial.id);
        if (stop) return;
        setJob(fresh);
        onJob(fresh);
        if (TERMINAL.includes(fresh.state)) {
          // look for the stored results; a finished job gets a few tries (the platform may still be committing them), a failed or cancelled one a single look
          for (let tries = 0; tries < (fresh.state === "succeeded" ? 6 : 1) && !stop; tries++) {
            const runs = await runsOfJob(initial.id);
            const group = runs.find((r) => r.group_id)?.group_id ?? null;
            if (group) { setBenchmarkId(group); break; }
            if (tries < 5 && fresh.state === "succeeded") await new Promise((r) => setTimeout(r, 2000));
          }
          if (!stop) setResultsChecked(true);
          return;
        }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : "Could not read the job.");
      }
      if (!stop) setTimeout(tick, 3000);
    };
    tick();
    return () => { stop = true; };
  }, [initial.id, recheck]); // eslint-disable-line react-hooks/exhaustive-deps

  const models = useMemo(() => Object.values(progress), [progress]);
  const allLabels = useMemo(() => (job.config.models as string[] | undefined) ?? [], [job.config.models]);
  const spent = models.reduce((s, m) => s + m.spent, 0);
  const upper = job.estimate.cost?.usd.total ?? null;
  const budget = (job.config.budget_usd as number | undefined) ?? null;

  async function doCancel() {
    setBusy(true);
    try {
      const j = await cancelJob(job.id);
      setJob(j);
      onJob(j);
      setConfirmCancel(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel.");
    } finally {
      setBusy(false);
    }
  }

  async function doRerun() {
    setBusy(true);
    try {
      onJob(await rerunJob(job.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rerun.");
    } finally {
      setBusy(false);
    }
  }

  const mode = job.config.kind === "benchmark_direct" ? "direct" : "agent";
  const lines = visibleEvents(events, showDetail);

  return (
    <div className="space-y-5" data-testid="live-run">
      <RunHeader state={job.state} cancelRequested={job.cancel_requested} dataset={String(job.config.dataset)} version={String(job.config.version)} mode={mode} repeat={String(job.config.repeat)} models={allLabels} jobId={job.id}
        spent={spent} estimate={upper} budget={budget} running={running} busy={busy} canOpenResults={!running && !!benchmarkId} onCancel={() => setConfirmCancel(true)} onRerun={doRerun}
        onOpenResults={() => benchmarkId && onOpenResults(benchmarkId)} onOpenMap={onOpenMap} />

      <RunStepper state={job.state} events={events} benchmarkId={benchmarkId} resultsChecked={resultsChecked} error={job.error ?? null} cancelRequested={job.cancel_requested}
        onCheckAgain={() => { setResultsChecked(false); setRecheck((n) => n + 1); }} />

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{error}</div>}
      {job.error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 break-words" role="alert">{job.error}</div>}
      {streamNote && running && <div className="text-[11px] text-amber-700">{tx("Live stream interrupted, retrying:")} {streamNote}</div>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="model-cards">
        {allLabels.map((label) => {
          const m = progress[label];
          const color = modelColor(label, allLabels);
          const total = m?.planned ?? null;
          const done = m?.done ?? 0;
          const ran = (m?.passed ?? 0) + (m?.failed ?? 0);
          const sorted = [...(m?.latency ?? [])].sort((a, b) => a - b);
          const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
          return (
            <section key={label} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900" aria-label={label}>
              <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} aria-hidden /><h3 className="min-w-0 truncate text-sm font-extrabold text-slate-900 dark:text-slate-50" title={label}>{label}</h3></div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="progressbar" aria-label={`${label} ${tx("progress")}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={total ? Math.round(Math.min(100, (done / total) * 100)) : 0}><div className="h-full rounded-full transition-all" style={{ width: `${total ? Math.min(100, (done / total) * 100) : done > 0 ? 8 : 0}%`, background: color }} /></div>
              <p className="mt-1.5 text-[11px] font-semibold text-slate-500">{done}{total ? ` / ${total}` : ""} {tx("executions")}{!m && running ? ` · ${tx("waiting")}` : ""}</p>
              <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2.5 text-[11px]">
                {([
                  [tx("accuracy"), ran ? pct((m?.passed ?? 0) / ran) : "—", ""], [`p50 / p95`, `${ms(q(50))} / ${ms(q(95))}`, ""], [tx("cost"), usd(m?.spent ?? 0), ""],
                  [tx("failed"), String(m?.failed ?? 0), ""], [tx("critical"), String(m?.critical ?? 0), m?.critical ? "text-red-600" : ""], [tx("tokens"), `${Math.round(((m?.inTok ?? 0) + (m?.outTok ?? 0)) / 1000)}k`, ""],
                ] as const).map(([k, v, c]) => <div key={k} className="min-w-0"><dt className="text-slate-400">{k}</dt><dd className={`truncate font-extrabold ${c || "text-slate-800 dark:text-slate-100"}`}>{v}</dd></div>)}
              </dl>
            </section>
          );
        })}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900" aria-label={tx("Model responses as they arrive")}>
          <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <h3 className="text-sm font-extrabold text-slate-900 dark:text-slate-50">{tx("Model responses as they arrive")}</h3>
            <span className="text-[11px] text-slate-400">{answers.length > 0 ? `${tx("latest")} ${answers.length}` : ""}</span>
          </header>
          {answers.length === 0 ? <p className="px-4 py-8 text-center text-xs text-slate-400">{running ? tx("Waiting for the first answer…") : tx("Nothing yet.")}</p> : (
            <ul className="max-h-[32rem] space-y-2 overflow-y-auto p-3" data-testid="answers">
              {answers.map((a) => (
                <li key={a.key} className="rounded-lg border border-slate-100 p-3 text-xs dark:border-slate-800">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="h-2 w-2 rounded-sm" style={{ background: modelColor(a.model, allLabels) }} aria-hidden />
                    <b className="text-slate-900 dark:text-slate-100">{a.case_id}</b><span className="truncate text-slate-500">{a.model}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${a.status === "passed" ? "bg-emerald-50 text-emerald-700" : a.status === "failed" ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-600"}`}>{a.status.replace("_", " ")}</span>
                    {a.latency !== null && <span className="ml-auto text-slate-400">{ms(a.latency)}</span>}
                  </div>
                  {a.reply && <p dir="auto" className="mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-start leading-relaxed text-slate-700 dark:bg-slate-800/60 dark:text-slate-200">{a.reply}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900" aria-label={tx("Events")}>
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <h3 className="text-sm font-extrabold text-slate-900 dark:text-slate-50">{tx("Events")}</h3>
            <label className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300"><input type="checkbox" checked={showDetail} onChange={(e) => setShowDetail(e.target.checked)} data-testid="events-detail" />{tx("Show every step")}</label>
          </header>
          {lines.length === 0 ? <p className="px-4 py-8 text-center text-xs text-slate-400">{tx("No events yet.")}</p> : (
            <ol className="max-h-[32rem] overflow-y-auto p-3 font-mono text-[11px]" data-testid="events">
              {lines.map((l) => (
                <li key={l.seq} className="grid grid-cols-[4.2rem_3.2rem_minmax(0,1fr)] gap-2 border-b border-slate-50 py-1 last:border-0 dark:border-slate-800">
                  <span className="text-slate-400">{l.time}</span><span className="text-slate-400">{l.kind}</span>
                  <span className={`break-words ${l.tone === "good" ? "text-emerald-700 dark:text-emerald-300" : l.tone === "bad" ? "font-semibold text-red-700 dark:text-red-300" : l.tone === "info" ? "font-semibold text-slate-800 dark:text-slate-100" : "text-slate-500"}`}>{l.text}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {confirmCancel && (
        <ConfirmDialog title={tx("Cancel this benchmark?")} confirmLabel={tx("Cancel the benchmark")} cancelLabel={tx("Keep running")} busy={busy} onConfirm={doCancel} onCancel={() => setConfirmCancel(false)}>
          <p className="text-sm text-slate-600">{tx("The case in flight finishes, then the run stops. What has run so far is kept and counted; nothing is discarded.")}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
