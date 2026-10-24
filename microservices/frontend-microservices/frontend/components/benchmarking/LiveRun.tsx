"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { tx } from "@/lib/i18n/tx";
import { cancelJob, getJob, modelColor, ms, pct, rerunJob, runsOfJob, streamJob, usd, type Job, type JobEvent } from "@/lib/evalBenchmarks";

const TERMINAL = ["succeeded", "failed", "cancelled", "lost"];
const btnPrimary = "px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-all";
const btnGhost = "px-3 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 disabled:opacity-40 transition-all";
const btnDanger = "px-3 py-2 text-xs font-semibold text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-40 transition-all";

interface ModelProgress { model: string; done: number; planned: number | null; passed: number; failed: number; other: number; critical: number; latency: number[]; spent: number; inTok: number; outTok: number }
interface Answer { key: string; model: string; case_id: string; status: string; reply: string | null; latency: number | null; stage: string | null; at: string }

export default function LiveRun({ job: initial, onJob, onOpenResults }: { job: Job; onJob: (job: Job) => void; onOpenResults: (benchmarkId: string) => void }) {
  const [job, setJob] = useState<Job>(initial);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [progress, setProgress] = useState<Record<string, ModelProgress>>({});
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [benchmarkId, setBenchmarkId] = useState<string | null>(null);
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
    setEvents([]); setProgress({}); setAnswers([]); setBenchmarkId(null); setJob(initial);
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
          const runs = await runsOfJob(initial.id);
          const group = runs.find((r) => r.group_id)?.group_id ?? null;
          if (!stop) setBenchmarkId(group);
          return;
        }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : "Could not read the job.");
      }
      if (!stop) setTimeout(tick, 3000);
    };
    tick();
    return () => { stop = true; };
  }, [initial.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const stateStyle = job.state === "succeeded" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : job.state === "running" ? "bg-blue-50 text-blue-700 border-blue-200"
    : job.state === "queued" ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-red-50 text-red-600 border-red-200";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${stateStyle}`} data-testid="job-state">{job.state}{job.cancel_requested && running ? ` · ${tx("cancelling")}` : ""}</span>
        <div className="min-w-0 mr-auto text-xs text-slate-600">
          <b>{String(job.config.dataset)}</b> {String(job.config.version)} · {job.config.kind === "benchmark_direct" ? tx("direct") : tx("agent")} · {allLabels.join(" vs ")} · ×{String(job.config.repeat)}
          <span className="block text-[10px] text-slate-400">{tx("job")} {job.id}</span>
        </div>
        <div className="text-xs text-slate-600 text-right">
          <div>{tx("spent")} <b data-testid="spent">{usd(spent)}</b>{upper !== null && <> {tx("of an estimated")} {usd(upper)}</>}{budget !== null && <> · {tx("budget")} ${budget}</>}</div>
        </div>
        {running && <button type="button" className={btnDanger} disabled={busy || job.cancel_requested} onClick={() => setConfirmCancel(true)}>{job.cancel_requested ? tx("Cancelling…") : tx("Cancel")}</button>}
        {!running && <button type="button" className={btnGhost} disabled={busy} onClick={doRerun}>{tx("Rerun")}</button>}
        {!running && benchmarkId && <button type="button" className={btnPrimary} onClick={() => onOpenResults(benchmarkId)}>{tx("Open results")}</button>}
      </div>

      {error && <div className="text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600">{error}</div>}
      {job.error && <div className="text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600">{job.error}</div>}
      {streamNote && running && <div className="text-[11px] text-amber-600">{tx("Live stream interrupted, retrying:")} {streamNote}</div>}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {allLabels.map((label) => {
          const m = progress[label];
          const color = modelColor(label, allLabels);
          const total = m?.planned ?? null;
          const done = m?.done ?? 0;
          const ran = (m?.passed ?? 0) + (m?.failed ?? 0);
          const sorted = [...(m?.latency ?? [])].sort((a, b) => a - b);
          const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
          return (
            <section key={label} className="rounded-xl border border-slate-200 bg-white p-4" aria-label={label}>
              <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} /><h3 className="text-sm font-bold text-slate-900">{label}</h3></div>
              <div className="mt-2 h-2 rounded bg-slate-100 overflow-hidden"><div className="h-full" style={{ width: `${total ? Math.min(100, (done / total) * 100) : done > 0 ? 8 : 0}%`, background: color }} /></div>
              <p className="mt-1 text-[11px] text-slate-500">{done}{total ? ` / ${total}` : ""} {tx("executions")}{!m && running ? ` · ${tx("waiting")}` : ""}</p>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                <div><dt className="text-slate-400">{tx("accuracy")}</dt><dd className="font-bold text-slate-800">{ran ? pct((m?.passed ?? 0) / ran) : "—"}</dd></div>
                <div><dt className="text-slate-400">p50 / p95</dt><dd className="font-bold text-slate-800">{ms(q(50))} / {ms(q(95))}</dd></div>
                <div><dt className="text-slate-400">{tx("cost")}</dt><dd className="font-bold text-slate-800">{usd(m?.spent ?? 0)}</dd></div>
                <div><dt className="text-slate-400">{tx("failed")}</dt><dd className="font-bold text-slate-800">{m?.failed ?? 0}</dd></div>
                <div><dt className="text-slate-400">{tx("critical")}</dt><dd className={`font-bold ${m?.critical ? "text-red-600" : "text-slate-800"}`}>{m?.critical ?? 0}</dd></div>
                <div><dt className="text-slate-400">{tx("tokens")}</dt><dd className="font-bold text-slate-800">{Math.round(((m?.inTok ?? 0) + (m?.outTok ?? 0)) / 1000)}k</dd></div>
              </dl>
            </section>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-bold text-slate-900">{tx("Model responses as they arrive")}</h3>
          {answers.length === 0 ? <p className="mt-3 text-xs text-slate-400">{tx("Nothing yet.")}</p> : (
            <ul className="mt-2 space-y-2 max-h-[420px] overflow-y-auto" data-testid="answers">
              {answers.map((a) => (
                <li key={a.key} className="text-xs border border-slate-100 rounded-lg p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="h-2 w-2 rounded-sm" style={{ background: modelColor(a.model, allLabels) }} />
                    <b className="text-slate-800">{a.case_id}</b><span className="text-slate-400">{a.model}</span>
                    <span className={`px-1.5 rounded text-[10px] font-semibold ${a.status === "passed" ? "bg-emerald-50 text-emerald-700" : a.status === "failed" ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-500"}`}>{a.status}</span>
                    {a.latency !== null && <span className="text-slate-400">{ms(a.latency)}</span>}
                  </div>
                  {a.reply && <p className="mt-1 text-slate-600 whitespace-pre-wrap break-words">{a.reply}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-bold text-slate-900">{tx("Events")}</h3>
          <ol className="mt-2 space-y-0.5 max-h-[420px] overflow-y-auto font-mono text-[11px] text-slate-600" data-testid="events">
            {[...events].reverse().filter((e) => e.kind !== "progress").map((e) => <li key={e.seq}><span className="text-slate-400">{e.at.slice(11, 19)}</span> {e.kind} · {e.message}</li>)}
          </ol>
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
